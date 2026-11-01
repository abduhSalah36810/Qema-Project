from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.idempotency import execute_idempotent_operation
from app.core.permissions import get_user_roles, require_permission
from app.db.session import get_db
from app.modules.production.models import (
    CatalogItem,
    StockLedgerEntry,
    StocktakeAuditLog,
    StocktakeCountHistory,
    StocktakeLine,
    StocktakeSession,
    Warehouse,
)
from app.modules.production.schemas import (
    StockBalanceRead,
    StockLedgerEntryRead,
    StocktakeAuditLogRead,
    StocktakeCancelRequest,
    StocktakeCountHistoryRead,
    StocktakeCountRequest,
    StocktakeCreateRequest,
    StocktakeLineRead,
    StocktakePostRequest,
    StocktakeReviewRequest,
    StocktakeSessionRead,
    StocktakeSubmitRequest,
)
from app.modules.production.stocktake_service import (
    cancel_stocktake,
    create_stocktake_session,
    get_stocktake_audit_history,
    get_stocktake_ledger_entries,
    get_stocktake_with_relations,
    list_stocktake_sessions,
    post_stocktake_adjustments,
    record_counts,
    review_stocktake,
    start_counting,
    submit_for_review,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])


def serialize_stocktake_session(st: StocktakeSession, include_lines: bool = False) -> StocktakeSessionRead:
    """تحويل كائن جلسة الجرد إلى Schema مخصصة للقراءة مع ملخص المؤشرات العددية."""
    lines = st.lines or []
    counted_lines = [l for l in lines if l.counted_quantity is not None]
    shortage_count = len([l for l in lines if l.variance is not None and l.variance < 0])
    surplus_count = len([l for l in lines if l.variance is not None and l.variance > 0])
    exact_count = len([l for l in lines if l.variance is not None and l.variance == 0])
    discrepancy_lines = shortage_count + surplus_count

    lines_read = None
    if include_lines:
        lines_read = [
            StocktakeLineRead(
                id=l.id,
                stocktake_id=l.stocktake_id,
                item_id=l.item_id,
                item_code=l.item.code if l.item else "",
                item_name_ar=l.item.name_ar if l.item else "",
                unit_id=l.unit_id,
                unit_name_ar=l.unit.name_ar if l.unit else (l.item.unit.name_ar if l.item and l.item.unit else ""),
                book_quantity=l.book_quantity,
                counted_quantity=l.counted_quantity,
                variance=l.variance,
                status=l.status,
                counter_id=l.counter_id,
                counted_at=l.counted_at,
                notes=l.notes or "",
                count_history=[
                    StocktakeCountHistoryRead(
                        id=h.id,
                        line_id=h.line_id,
                        counted_quantity=h.counted_quantity,
                        previous_quantity=h.previous_quantity,
                        counter_id=h.counter_id,
                        counted_at=h.counted_at,
                        reason=h.reason,
                        notes=h.notes or "",
                    )
                    for h in (l.count_history or [])
                ] if l.count_history else [],
            )
            for l in lines
        ]

    return StocktakeSessionRead(
        id=st.id,
        session_number=st.session_number,
        warehouse_id=st.warehouse_id,
        warehouse_code=st.warehouse.code if st.warehouse else "",
        warehouse_name_ar=st.warehouse.name_ar if st.warehouse else "",
        scope_type=st.scope_type,
        status=st.status,
        description=st.description or "",
        counting_date=st.counting_date,
        snapshot_at=st.snapshot_at,
        total_lines=len(lines),
        counted_lines=len(counted_lines),
        discrepancy_lines=discrepancy_lines,
        shortage_count=shortage_count,
        surplus_count=surplus_count,
        exact_count=exact_count,
        created_by=st.created_by,
        submitted_by=st.submitted_by,
        submitted_at=st.submitted_at,
        reviewed_by=st.reviewed_by,
        reviewed_at=st.reviewed_at,
        review_notes=st.review_notes,
        approved_by=st.approved_by,
        approved_at=st.approved_at,
        approval_notes=st.approval_notes,
        posted_by=st.posted_by,
        posted_at=st.posted_at,
        cancelled_by=st.cancelled_by,
        cancelled_at=st.cancelled_at,
        cancellation_reason=st.cancellation_reason,
        created_at=st.created_at,
        updated_at=st.updated_at,
        lines=lines_read,
    )


# ── 1. مسارات أرصدة المخازن ودفتر الأستاذ (Existing Endpoints) ─────────────────

@router.get("/stock", response_model=List[StockBalanceRead])
async def list_stock_balances(
    warehouse_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:view")),
    db: AsyncSession = Depends(get_db),
):
    warehouses_stmt = select(Warehouse).where(Warehouse.is_active.is_(True)).order_by(Warehouse.code)
    if warehouse_id:
        warehouses_stmt = warehouses_stmt.where(Warehouse.id == warehouse_id)
    warehouses = (await db.scalars(warehouses_stmt)).all()
    items = (await db.scalars(select(CatalogItem).options(selectinload(CatalogItem.unit)).where(CatalogItem.is_active.is_(True)).order_by(CatalogItem.code))).all()
    totals = (await db.execute(
        select(StockLedgerEntry.item_id, StockLedgerEntry.warehouse_id,
               func.sum(StockLedgerEntry.quantity), func.count(StockLedgerEntry.id))
        .where(StockLedgerEntry.location_type == "warehouse", StockLedgerEntry.warehouse_id.is_not(None))
        .group_by(StockLedgerEntry.item_id, StockLedgerEntry.warehouse_id)
    )).all()
    total_map = {(item_id, wh_id): (float(quantity), int(count)) for item_id, wh_id, quantity, count in totals}
    return [
        StockBalanceRead(
            item_id=item.id, item_code=item.code, item_name_ar=item.name_ar,
            unit_id=item.unit_id, unit_name_ar=item.unit.name_ar if item.unit else "",
            warehouse_id=warehouse.id, warehouse_code=warehouse.code,
            warehouse_name_ar=warehouse.name_ar,
            balance=total_map.get((item.id, warehouse.id), (None, 0))[0],
            is_established=total_map.get((item.id, warehouse.id), (None, 0))[1] > 0,
        )
        for warehouse in warehouses for item in items
    ]


@router.get("/ledger", response_model=List[StockLedgerEntryRead])
async def list_stock_ledger(
    item_id: Optional[str] = Query(default=None),
    warehouse_id: Optional[str] = Query(default=None),
    reference_doc_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(StockLedgerEntry).options(
        selectinload(StockLedgerEntry.item).selectinload(CatalogItem.unit),
        selectinload(StockLedgerEntry.unit),
        selectinload(StockLedgerEntry.warehouse),
    ).order_by(StockLedgerEntry.created_at.desc())
    if item_id:
        stmt = stmt.where(StockLedgerEntry.item_id == item_id)
    if warehouse_id:
        stmt = stmt.where(StockLedgerEntry.warehouse_id == warehouse_id)
    if reference_doc_id:
        stmt = stmt.where(StockLedgerEntry.reference_doc_id == reference_doc_id)
    entries = (await db.scalars(stmt.limit(500))).all()
    return [StockLedgerEntryRead(
        id=row.id, item_id=row.item_id, item_code=row.item.code, item_name_ar=row.item.name_ar,
        unit_id=row.unit_id, unit_name_ar=row.unit.name_ar,
        warehouse_id=row.warehouse_id, warehouse_name_ar=row.warehouse.name_ar if row.warehouse else None,
        location_type=row.location_type, bucket_reference=row.bucket_reference, quantity=row.quantity,
        reference_doc_type=row.reference_doc_type, reference_doc_id=row.reference_doc_id,
        transfer_line_id=row.transfer_line_id, entry_type=row.entry_type,
        created_at=row.created_at, created_by=row.created_by,
    ) for row in entries]


# ── 2. مسارات الجرد والتسويات المخزنية (Stocktake & Adjustments Endpoints) ──────

@router.get("/stocktakes", response_model=List[StocktakeSessionRead])
async def list_stocktakes(
    warehouse_id: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض قائمة جلسات الجرد بالمخازن."""
    sessions, _ = await list_stocktake_sessions(
        db, warehouse_id=warehouse_id, status_filter=status, limit=limit, offset=offset
    )
    return [serialize_stocktake_session(st, include_lines=False) for st in sessions]


@router.post("/stocktakes", response_model=StocktakeSessionRead, status_code=status.HTTP_201_CREATED)
async def create_stocktake(
    data: StocktakeCreateRequest,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:create")),
    db: AsyncSession = Depends(get_db),
):
    """إنشاء جلسة جرد جديدة وتثبيت اللقطة الدفترية للأرصدة."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    st = await create_stocktake_session(
        db, data=data, user_id=current_user.id, user_role=user_role
    )
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.get("/stocktakes/{stocktake_id}", response_model=StocktakeSessionRead)
async def get_stocktake_details(
    stocktake_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:view")),
    db: AsyncSession = Depends(get_db),
):
    """استرجاع بيانات وتفاصيل جلسة الجرد وأسطر الأصناف المعدودة."""
    st = await get_stocktake_with_relations(db, stocktake_id)
    if not st:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")
    return serialize_stocktake_session(st, include_lines=True)


@router.get("/stocktakes/{stocktake_id}/lines", response_model=List[StocktakeLineRead])
async def get_stocktake_lines_endpoint(
    stocktake_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:view")),
    db: AsyncSession = Depends(get_db),
):
    """استرجاع أسطر الأصناف المشمولة في جلسة الجرد فقط."""
    st = await get_stocktake_with_relations(db, stocktake_id)
    if not st:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")
    serialized = serialize_stocktake_session(st, include_lines=True)
    return serialized.lines or []


@router.post("/stocktakes/{stocktake_id}/start-counting", response_model=StocktakeSessionRead)
async def start_stocktake_counting_endpoint(
    stocktake_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:count")),
    db: AsyncSession = Depends(get_db),
):
    """بدء مرحلة العد الفعلي للجلسة."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    st = await start_counting(db, stocktake_id, user_id=current_user.id, user_role=user_role)
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.post("/stocktakes/{stocktake_id}/counts", response_model=StocktakeSessionRead)
async def record_stocktake_counts_endpoint(
    stocktake_id: str,
    data: StocktakeCountRequest,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:count")),
    db: AsyncSession = Depends(get_db),
):
    """تسجيل أو تحديث الكميات المعدودة فعلياً للأصناف (يدعم العد المرحلي والصفر المعتمد)."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    st = await record_counts(db, stocktake_id, data=data, counter_id=current_user.id, user_role=user_role)
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.post("/stocktakes/{stocktake_id}/submit", response_model=StocktakeSessionRead)
async def submit_stocktake_endpoint(
    stocktake_id: str,
    data: StocktakeSubmitRequest = StocktakeSubmitRequest(),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:submit")),
    db: AsyncSession = Depends(get_db),
):
    """رفع نتائج الجرد للمراجعة والاعتماد بعد استكمال العد."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    st = await submit_for_review(db, stocktake_id, user_id=current_user.id, user_role=user_role, notes=data.notes or "")
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.post("/stocktakes/{stocktake_id}/review", response_model=StocktakeSessionRead)
async def review_stocktake_endpoint(
    stocktake_id: str,
    data: StocktakeReviewRequest,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:review")),
    db: AsyncSession = Depends(get_db),
):
    """مراجعة نتائج الجرد (طلب إعادة عد أصناف محددة، أو رفض الجلسة)."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    st = await review_stocktake(db, stocktake_id, data=data, reviewer_id=current_user.id, user_role=user_role)
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.post("/stocktakes/{stocktake_id}/approve", response_model=StocktakeSessionRead)
async def approve_stocktake_endpoint(
    stocktake_id: str,
    data: StocktakeReviewRequest = StocktakeReviewRequest(decision="approve"),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:approve")),
    db: AsyncSession = Depends(get_db),
):
    """اعتماد نتائج الجرد من قبل المدير العام تمهيداً لترحيل التسويات المخزنية."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    data.decision = "approve"
    st = await review_stocktake(db, stocktake_id, data=data, reviewer_id=current_user.id, user_role=user_role)
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.post("/stocktakes/{stocktake_id}/post")
async def post_stocktake_endpoint(
    stocktake_id: str,
    data: StocktakePostRequest = StocktakePostRequest(),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:post")),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """
    ترحيل التسويات المخزنية الناتجة عن الجرد المعتمد وإنشاء قيود الأستاذ غير القابلة للمسح.
    محمي بنظام عدم التكرار الموحد (Idempotency Engine).
    """
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")

    async def _execute():
        return await post_stocktake_adjustments(
            db,
            stocktake_id=stocktake_id,
            poster_id=current_user.id,
            user_role=user_role,
            notes=data.notes or "",
        )

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="inventory_stocktake_post",
        resource_id=stocktake_id,
        user_id=current_user.id,
        payload=data.model_dump() if data else {},
        execute_fn=_execute,
    )


@router.post("/stocktakes/{stocktake_id}/cancel", response_model=StocktakeSessionRead)
async def cancel_stocktake_endpoint(
    stocktake_id: str,
    data: StocktakeCancelRequest,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:cancel")),
    db: AsyncSession = Depends(get_db),
):
    """إلغاء جلسة الجرد (متاح فقط قبل ترحيل القيود للأستاذ)."""
    roles = await get_user_roles(current_user, db=db)
    user_role = next(iter(roles), "")
    st = await cancel_stocktake(db, stocktake_id, user_id=current_user.id, reason=data.reason, user_role=user_role)
    loaded = await get_stocktake_with_relations(db, st.id)
    return serialize_stocktake_session(loaded, include_lines=True)


@router.get("/stocktakes/{stocktake_id}/audit", response_model=List[StocktakeAuditLogRead])
async def get_stocktake_audit_endpoint(
    stocktake_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:view")),
    db: AsyncSession = Depends(get_db),
):
    """استرجاع سجل التدقيق الزمني المتسلسل لجلسة الجرد."""
    logs = await get_stocktake_audit_history(db, stocktake_id)
    return [
        StocktakeAuditLogRead(
            id=log.id,
            stocktake_id=log.stocktake_id,
            action=log.action,
            actor_id=log.actor_id,
            actor_role=log.actor_role,
            timestamp=log.timestamp,
            details=log.details,
            notes=log.notes or "",
        )
        for log in logs
    ]


@router.get("/stocktakes/{stocktake_id}/ledger-entries", response_model=List[StockLedgerEntryRead])
async def get_stocktake_ledger_entries_endpoint(
    stocktake_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("inventory:stocktake:view")),
    db: AsyncSession = Depends(get_db),
):
    """استرجاع قيود دفتر الأستاذ المنشأة نتيجة ترحيل تسويات الجرد."""
    entries = await get_stocktake_ledger_entries(db, stocktake_id)
    return [
        StockLedgerEntryRead(
            id=row.id,
            item_id=row.item_id,
            item_code=row.item.code if row.item else "",
            item_name_ar=row.item.name_ar if row.item else "",
            unit_id=row.unit_id,
            unit_name_ar=row.unit.name_ar if row.unit else (row.item.unit.name_ar if row.item and row.item.unit else ""),
            warehouse_id=row.warehouse_id,
            warehouse_name_ar=row.warehouse.name_ar if row.warehouse else None,
            location_type=row.location_type,
            bucket_reference=row.bucket_reference,
            quantity=row.quantity,
            reference_doc_type=row.reference_doc_type,
            reference_doc_id=row.reference_doc_id,
            transfer_line_id=row.transfer_line_id,
            entry_type=row.entry_type,
            created_at=row.created_at,
            created_by=row.created_by,
        )
        for row in entries
    ]
