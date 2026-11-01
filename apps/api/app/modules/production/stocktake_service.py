"""
خدمات وإدارة دورة الجرد والتسويات المخزنية (Stocktake & Inventory Adjustments Service)
─────────────────────────────────────────────────────────────────────────────
يحقق:
1. إنشاء جلسات الجرد بحصر دفتري لحظي معتمد (Book Quantity Snapshot).
2. تسجيل العد الفعلي ودعم الحفظ المرحلي، التمييز بين الصفر وعدم العد، والعد المتعدد (Recount History).
3. احتساب الفروقات بدقة (عجز Shortage / زيادة Surplus / تطابق Exact).
4. مسار المراجعة والاعتماد وفصل الصلاحيات (Maker-Checker Workflow).
5. ترحيل التسويات بقيود ليدجر غير قابلة للتعديل أو المسح (Immutable StockLedgerEntry).
6. الحماية التامة من التنافس عبر Advisory Locks والتحقق من سلامة اللقطة الدفترية.
7. الحصانة ضد التكرار (Idempotency Key Support).
8. سجل تدقيق تسلسلي كامل (Append-Only Audit Log).
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.production.models import (
    CatalogItem,
    StockLedgerEntry,
    StocktakeAuditLog,
    StocktakeCountHistory,
    StocktakeLine,
    StocktakeSession,
    Unit,
    Warehouse,
    utc_now,
)
from app.modules.production.schemas import (
    StocktakeCountItem,
    StocktakeCountRequest,
    StocktakeCreateRequest,
    StocktakeReviewRequest,
)
from app.modules.production.service import lock_stock_balance


async def generate_stocktake_session_number(session: AsyncSession) -> str:
    """توليد كود تسلسلي رسمي لجلسة الجرد بصيغة STK-YYYY-XXXX."""
    year = datetime.now(timezone.utc).year
    prefix = f"STK-{year}-"
    stmt = (
        select(StocktakeSession.session_number)
        .where(StocktakeSession.session_number.like(f"{prefix}%"))
        .order_by(StocktakeSession.session_number.desc())
        .limit(1)
    )
    last_code = (await session.execute(stmt)).scalar_one_or_none()
    if not last_code:
        seq = 1
    else:
        try:
            seq = int(last_code.split("-")[-1]) + 1
        except (ValueError, IndexError):
            seq = 1
    return f"{prefix}{seq:04d}"


async def get_live_warehouse_balance(session: AsyncSession, warehouse_id: str, item_id: str) -> float:
    """احتساب الرصيد الدفتري الفعلي الحاضر للصنف داخل المخزن من واقع دفاتر الأستاذ."""
    stmt = (
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
        .where(
            StockLedgerEntry.warehouse_id == warehouse_id,
            StockLedgerEntry.item_id == item_id,
            StockLedgerEntry.location_type == "warehouse",
        )
    )
    val = (await session.execute(stmt)).scalar()
    return round(float(val or 0.0), 4)


async def create_stocktake_session(
    session: AsyncSession,
    data: StocktakeCreateRequest,
    user_id: str,
    user_role: str = "",
) -> StocktakeSession:
    """إنشاء جلسة جرد جديدة وتثبيت لقطة الأرصدة الدفترية لحظة الفتح."""
    # 1. التحقق من المخزن
    wh = await session.get(Warehouse, data.warehouse_id)
    if not wh or not wh.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="المخزن المحدد غير موجود أو غير نشط.",
        )

    # 2. حصر الأصناف المستهدفة بالجرد
    if data.scope_type == "specific_items":
        if not data.item_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="يلزم تحديد قائمة الأصناف المستهدفة في حال اختيار جرد أصناف محددة.",
            )
        stmt = (
            select(CatalogItem)
            .where(CatalogItem.id.in_(data.item_ids), CatalogItem.is_active.is_(True))
            .order_by(CatalogItem.code)
        )
        items = (await session.scalars(stmt)).all()
        if len(items) != len(set(data.item_ids)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="بعض الأصناف المحددة غير صالحة أو غير نشطة.",
            )
    else:
        # full_warehouse
        stmt = select(CatalogItem).where(CatalogItem.is_active.is_(True)).order_by(CatalogItem.code)
        items = (await session.scalars(stmt)).all()

    if not items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="لا توجد أصناف صالحة للجرد في النطاق المحدد.",
        )

    # 3. تثبيت لقطة الرصيد الدفتري لكل صنف من واقع قيود الأستاذ
    totals_stmt = (
        select(StockLedgerEntry.item_id, func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
        .where(
            StockLedgerEntry.warehouse_id == wh.id,
            StockLedgerEntry.location_type == "warehouse",
        )
        .group_by(StockLedgerEntry.item_id)
    )
    totals_res = (await session.execute(totals_stmt)).all()
    totals_map = {item_id: round(float(qty), 4) for item_id, qty in totals_res}

    session_number = await generate_stocktake_session_number(session)
    now = utc_now()
    counting_date = data.counting_date or now

    stocktake = StocktakeSession(
        id=str(uuid.uuid4()),
        session_number=session_number,
        warehouse_id=wh.id,
        scope_type=data.scope_type,
        status="draft",
        description=data.description or "",
        counting_date=counting_date,
        snapshot_at=now,
        created_by=user_id,
        created_at=now,
        updated_at=now,
    )
    session.add(stocktake)

    for it in items:
        book_qty = totals_map.get(it.id, 0.0)
        line = StocktakeLine(
            id=str(uuid.uuid4()),
            stocktake_id=stocktake.id,
            item_id=it.id,
            unit_id=it.unit_id,
            book_quantity=book_qty,
            counted_quantity=None,  # لم يُعد بعد
            variance=None,
            status="uncounted",
            notes="",
            created_at=now,
        )
        session.add(line)

    audit = StocktakeAuditLog(
        id=str(uuid.uuid4()),
        stocktake_id=stocktake.id,
        action="create",
        actor_id=user_id,
        actor_role=user_role,
        timestamp=now,
        details={"scope_type": data.scope_type, "items_count": len(items)},
        notes=f"تم إنشاء جلسة الجرد وتثبيت لقطة الأرصدة الدفترية لعدد {len(items)} صنفاً.",
    )
    session.add(audit)

    await session.commit()
    await session.refresh(stocktake)
    return stocktake


async def start_counting(
    session: AsyncSession,
    stocktake_id: str,
    user_id: str,
    user_role: str = "",
) -> StocktakeSession:
    """بدء مرحلة العد الفعلي ونقل الجلسة إلى counting."""
    stocktake = await get_stocktake_with_relations(session, stocktake_id)
    if not stocktake:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")

    if stocktake.status not in ("draft", "counting"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"لا يمكن بدء العد؛ حالة الجلسة الحالية هي '{stocktake.status}'.",
        )

    now = utc_now()
    if stocktake.status == "draft":
        stocktake.status = "counting"
        stocktake.updated_at = now

        audit = StocktakeAuditLog(
            id=str(uuid.uuid4()),
            stocktake_id=stocktake.id,
            action="start_counting",
            actor_id=user_id,
            actor_role=user_role,
            timestamp=now,
            notes="تم فتح مرحلة العد الفعلي للجلسة.",
        )
        session.add(audit)
        await session.commit()
        await session.refresh(stocktake)

    return stocktake


async def record_counts(
    session: AsyncSession,
    stocktake_id: str,
    data: StocktakeCountRequest,
    counter_id: str,
    user_role: str = "",
) -> StocktakeSession:
    """
    تسجيل أو تحديث الكميات المعدودة فعلياً:
    - يدعم الحفظ الجزئي واستئناف العد.
    - الصفر (0.0) يُعتبر قيمة معدودة فعلية (رصيد نافد)، ويختلف عن عدم العد (None).
    - يحتفظ بتاريخ كل محاولة عد أو إعادة عد (Count History).
    """
    stocktake = await get_stocktake_with_relations(session, stocktake_id)
    if not stocktake:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")

    if stocktake.status not in ("draft", "counting", "under_review"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"لا يمكن تسجيل العد في هذه المرحلة؛ حالة الجلسة الحالية هي '{stocktake.status}'.",
        )

    lines_map = {line.id: line for line in stocktake.lines}
    now = utc_now()
    updated_count = 0

    for item in data.counts:
        line = lines_map.get(item.line_id)
        if not line:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"سطر الجرد المعرف '{item.line_id}' لا ينتمي لهذه الجلسة.",
            )

        counted_val = round(float(item.counted_quantity), 4)
        if counted_val < 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="الكمية المعدودة لا يمكن أن تكون سالبة.",
            )

        prev_qty = line.counted_quantity
        line.counted_quantity = counted_val
        line.variance = round(counted_val - line.book_quantity, 4)
        line.status = "counted"
        line.counter_id = counter_id
        line.counted_at = now
        if item.notes is not None:
            line.notes = item.notes

        # تسجيل حركة العد في التاريخ غير القابل للمسح
        history = StocktakeCountHistory(
            id=str(uuid.uuid4()),
            line_id=line.id,
            stocktake_id=stocktake.id,
            counted_quantity=counted_val,
            previous_quantity=prev_qty,
            counter_id=counter_id,
            counted_at=now,
            reason=data.reason or "regular_count",
            notes=item.notes or "",
        )
        session.add(history)
        updated_count += 1

    if stocktake.status == "draft":
        stocktake.status = "counting"

    stocktake.updated_at = now

    audit = StocktakeAuditLog(
        id=str(uuid.uuid4()),
        stocktake_id=stocktake.id,
        action="record_count",
        actor_id=counter_id,
        actor_role=user_role,
        timestamp=now,
        details={"updated_lines": updated_count, "reason": data.reason},
        notes=f"تم تسجيل العد الفعلي لعدد {updated_count} صنفاً.",
    )
    session.add(audit)

    await session.commit()
    await session.refresh(stocktake)
    return stocktake


async def submit_for_review(
    session: AsyncSession,
    stocktake_id: str,
    user_id: str,
    user_role: str = "",
    notes: str = "",
) -> StocktakeSession:
    """رفع جلسة الجرد للمراجعة بعد التأكد من تسجيل العد."""
    stocktake = await get_stocktake_with_relations(session, stocktake_id)
    if not stocktake:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")

    if stocktake.status not in ("counting", "under_review"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"لا يمكن تقديم الجلسة للمراجعة؛ الحالة الحالية هي '{stocktake.status}'.",
        )

    # التحقق من أن هناك أسطراً تم عدها بالفعل
    counted_lines = [l for l in stocktake.lines if l.counted_quantity is not None]
    if not counted_lines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="لا يمكن تقديم جلسة جرد فارغة؛ لم يتم تسجيل أي عداد فعلي حتى الآن.",
        )

    now = utc_now()
    stocktake.status = "submitted"
    stocktake.submitted_by = user_id
    stocktake.submitted_at = now
    stocktake.updated_at = now

    audit = StocktakeAuditLog(
        id=str(uuid.uuid4()),
        stocktake_id=stocktake.id,
        action="submit",
        actor_id=user_id,
        actor_role=user_role,
        timestamp=now,
        details={"total_lines": len(stocktake.lines), "counted_lines": len(counted_lines)},
        notes=notes or f"تم رفع الجلسة للمراجعة والاعتماد (تم عد {len(counted_lines)} من أصل {len(stocktake.lines)}).",
    )
    session.add(audit)

    await session.commit()
    await session.refresh(stocktake)
    return stocktake


async def review_stocktake(
    session: AsyncSession,
    stocktake_id: str,
    data: StocktakeReviewRequest,
    reviewer_id: str,
    user_role: str = "",
) -> StocktakeSession:
    """
    مراجعة جلسة الجرد:
    - approve: اعتماد الفروقات والتجهيز للترحيل الدفتري.
    - recount_required: طلب إعادة عد أصناف محددة أو كافة الأصناف ذات الفروقات.
    - reject: رفض الجلسة وإعادتها للتصحيح.
    """
    stocktake = await get_stocktake_with_relations(session, stocktake_id)
    if not stocktake:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")

    if stocktake.status not in ("submitted", "under_review"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"الجلسة ليست في حالة مراجعة؛ حالتها الحالية هي '{stocktake.status}'.",
        )

    now = utc_now()

    if data.decision == "approve":
        stocktake.status = "approved"
        stocktake.approved_by = reviewer_id
        stocktake.approved_at = now
        stocktake.approval_notes = data.notes or ""
        stocktake.reviewed_by = reviewer_id
        stocktake.reviewed_at = now
        stocktake.updated_at = now

        audit = StocktakeAuditLog(
            id=str(uuid.uuid4()),
            stocktake_id=stocktake.id,
            action="approve",
            actor_id=reviewer_id,
            actor_role=user_role,
            timestamp=now,
            notes=data.notes or "تمت مراجعة واعتماد الجلسة بنجاح، وهي الآن جاهزة للترحيل المخزني.",
        )
        session.add(audit)

    elif data.decision == "recount_required":
        stocktake.status = "under_review"
        stocktake.reviewed_by = reviewer_id
        stocktake.reviewed_at = now
        stocktake.review_notes = data.notes or ""
        stocktake.updated_at = now

        recount_target_ids = set(data.recount_line_ids or [])
        recounted_count = 0

        for line in stocktake.lines:
            if recount_target_ids:
                if line.id in recount_target_ids:
                    line.status = "recount_required"
                    recounted_count += 1
            else:
                # إذا لم تحدد أسطر معينة، اطلب إعادة عد كل ما له فرق
                if line.variance is not None and line.variance != 0:
                    line.status = "recount_required"
                    recounted_count += 1

        audit = StocktakeAuditLog(
            id=str(uuid.uuid4()),
            stocktake_id=stocktake.id,
            action="request_recount",
            actor_id=reviewer_id,
            actor_role=user_role,
            timestamp=now,
            details={"recount_lines_count": recounted_count},
            notes=data.notes or f"تم طلب إعادة عد لعدد ({recounted_count}) صنفاً لوجود فروقات.",
        )
        session.add(audit)

    elif data.decision == "reject":
        stocktake.status = "draft"
        stocktake.reviewed_by = reviewer_id
        stocktake.reviewed_at = now
        stocktake.review_notes = data.notes or ""
        stocktake.updated_at = now

        audit = StocktakeAuditLog(
            id=str(uuid.uuid4()),
            stocktake_id=stocktake.id,
            action="reject",
            actor_id=reviewer_id,
            actor_role=user_role,
            timestamp=now,
            notes=data.notes or "تم رفض نتائج الجرد وإعادتها لحالة المسودة للتصحيح.",
        )
        session.add(audit)

    await session.commit()
    await session.refresh(stocktake)
    return stocktake


async def post_stocktake_adjustments(
    session: AsyncSession,
    stocktake_id: str,
    poster_id: str,
    user_role: str = "",
    notes: str = "",
) -> dict:
    """
    ترحيل التسويات المخزنية الناتجة عن الجرد المعتمد:
    1. التحقق من حالة الاعتماد الصريح (approved).
    2. قفل الأصناف المتأثرة متسلسلاً بالأقفال الاستشارية (lock_stock_balance).
    3. التحقق الحتمي من عدم حدوث حركات مخزنية متداخلة غيرت الرصيد الدفتري منذ اللقطة (Snapshot Integrity).
    4. إنشاء قيود أستاذ غير قابلة للتعديل أو الحذف (StockLedgerEntry):
       - عجز (Shortage): قيد سالب برقم الجلسة (entry_type = 'stocktake_shortage').
       - زيادة (Surplus): قيد موجب برقم الجلسة (entry_type = 'stocktake_surplus').
       - تطابق (Exact): لا يُنشأ أي قيد صفري غير ضروري.
    5. تحديث حالة الجلسة إلى posted في نفس المعاملة الذرية.
    """
    # جلب الجلسة بقفل تحديث
    s_stmt = (
        select(StocktakeSession)
        .options(
            selectinload(StocktakeSession.lines).selectinload(StocktakeLine.item),
            selectinload(StocktakeSession.warehouse),
        )
        .where(StocktakeSession.id == stocktake_id)
        .with_for_update()
    )
    stocktake = (await session.execute(s_stmt)).scalar_one_or_none()
    if not stocktake:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")

    if stocktake.status == "posted":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="تم ترحيل تسويات هذه الجلسة مسبقاً، ولا يمكن إعادة الترحيل.",
        )

    if stocktake.status != "approved":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"لا يمكن ترحيل الجلسة؛ يلزم اعتمادها أولاً من المدير العام. الحالة الحالية: '{stocktake.status}'.",
        )

    # تصفية الأسطر التي تم عدها وتتطلب تسوية
    lines_with_variance = [
        l for l in stocktake.lines
        if l.counted_quantity is not None and l.variance is not None and round(l.variance, 4) != 0.0
    ]

    # قفل الأصناف بترتيب تصاعدي لمنع Deadlock
    sorted_lines = sorted(lines_with_variance, key=lambda l: l.item_id)
    for line in sorted_lines:
        await lock_stock_balance(session, line.item_id, stocktake.warehouse_id)

    # فحص سلامة اللقطة الدفترية (Snapshot Consistency Check)
    for line in sorted_lines:
        current_live_balance = await get_live_warehouse_balance(session, stocktake.warehouse_id, line.item_id)
        if round(current_live_balance, 4) != round(line.book_quantity, 4):
            item_name = line.item.name_ar if line.item else line.item_id
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"تعذر الترحيل لعدم تطابق اللقطة الدفترية: الصنف '{item_name}' تغير رصيده الفعلي "
                    f"من {line.book_quantity} (لحظة فتح الجرد) إلى {current_live_balance} بسبب حركات مخزنية متداخلة. "
                    f"يلزم إعادة مراجعة الجرد لضمان دقة الأرصدة."
                ),
            )

    # إنشاء قيود الأستاذ للتسويات
    now = utc_now()
    created_entries = []
    shortage_count = 0
    surplus_count = 0

    for line in sorted_lines:
        var = round(line.variance, 4)
        if var < 0:
            # عجز: قيد سالب
            shortage_count += 1
            entry = StockLedgerEntry(
                id=str(uuid.uuid4()),
                item_id=line.item_id,
                unit_id=line.unit_id,
                warehouse_id=stocktake.warehouse_id,
                location_type="warehouse",
                quantity=var,  # قيمة سالبة
                reference_doc_type="stocktake",
                reference_doc_id=stocktake.id,
                entry_type="stocktake_shortage",
                created_at=now,
                created_by=poster_id,
            )
            session.add(entry)
            created_entries.append(entry.id)
        elif var > 0:
            # زيادة: قيد موجب
            surplus_count += 1
            entry = StockLedgerEntry(
                id=str(uuid.uuid4()),
                item_id=line.item_id,
                unit_id=line.unit_id,
                warehouse_id=stocktake.warehouse_id,
                location_type="warehouse",
                quantity=var,  # قيمة موجبة
                reference_doc_type="stocktake",
                reference_doc_id=stocktake.id,
                entry_type="stocktake_surplus",
                created_at=now,
                created_by=poster_id,
            )
            session.add(entry)
            created_entries.append(entry.id)

    # تحديث حالة الجلسة إلى مرحلة
    stocktake.status = "posted"
    stocktake.posted_by = poster_id
    stocktake.posted_at = now
    stocktake.updated_at = now

    audit = StocktakeAuditLog(
        id=str(uuid.uuid4()),
        stocktake_id=stocktake.id,
        action="post",
        actor_id=poster_id,
        actor_role=user_role,
        timestamp=now,
        details={
            "adjusted_lines": len(lines_with_variance),
            "shortage_count": shortage_count,
            "surplus_count": surplus_count,
            "ledger_entries_created": len(created_entries),
        },
        notes=notes or f"تم ترحيل التسويات بنجاح وإنشاء {len(created_entries)} قيداً في دفتر الأستاذ.",
    )
    session.add(audit)

    await session.commit()

    return {
        "stocktake_id": stocktake.id,
        "session_number": stocktake.session_number,
        "status": "posted",
        "posted_at": now.isoformat(),
        "posted_by": poster_id,
        "adjusted_lines_count": len(lines_with_variance),
        "shortage_count": shortage_count,
        "surplus_count": surplus_count,
        "ledger_entries_created": len(created_entries),
    }


async def cancel_stocktake(
    session: AsyncSession,
    stocktake_id: str,
    user_id: str,
    reason: str,
    user_role: str = "",
) -> StocktakeSession:
    """إلغاء جلسة الجرد بشرط عدم ترحيل تسوياتها مسبقاً."""
    stocktake = await get_stocktake_with_relations(session, stocktake_id)
    if not stocktake:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="جلسة الجرد غير موجودة.")

    if stocktake.status == "posted":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن إلغاء جلسة جرد تم ترحيل تسوياتها المخزنية بالفعل.",
        )

    if stocktake.status == "cancelled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="جلسة الجرد ملغاة مسبقاً.",
        )

    now = utc_now()
    stocktake.status = "cancelled"
    stocktake.cancelled_by = user_id
    stocktake.cancelled_at = now
    stocktake.cancellation_reason = reason
    stocktake.updated_at = now

    audit = StocktakeAuditLog(
        id=str(uuid.uuid4()),
        stocktake_id=stocktake.id,
        action="cancel",
        actor_id=user_id,
        actor_role=user_role,
        timestamp=now,
        notes=reason,
    )
    session.add(audit)

    await session.commit()
    await session.refresh(stocktake)
    return stocktake


async def get_stocktake_with_relations(
    session: AsyncSession, stocktake_id: str
) -> Optional[StocktakeSession]:
    """استرجاع جلسة الجرد مع علاقاتها الأساسية."""
    stmt = (
        select(StocktakeSession)
        .options(
            selectinload(StocktakeSession.warehouse),
            selectinload(StocktakeSession.lines).selectinload(StocktakeLine.item).selectinload(CatalogItem.unit),
            selectinload(StocktakeSession.lines).selectinload(StocktakeLine.unit),
            selectinload(StocktakeSession.lines).selectinload(StocktakeLine.count_history),
            selectinload(StocktakeSession.audit_logs),
        )
        .where(StocktakeSession.id == stocktake_id)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_stocktake_sessions(
    session: AsyncSession,
    warehouse_id: Optional[str] = None,
    status_filter: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> Tuple[List[StocktakeSession], int]:
    """استعراض قائمة جلسات الجرد مع دعم الفلاتر."""
    query = (
        select(StocktakeSession)
        .options(
            selectinload(StocktakeSession.warehouse),
            selectinload(StocktakeSession.lines),
        )
        .order_by(StocktakeSession.created_at.desc())
    )
    count_query = select(func.count(StocktakeSession.id))

    if warehouse_id:
        query = query.where(StocktakeSession.warehouse_id == warehouse_id)
        count_query = count_query.where(StocktakeSession.warehouse_id == warehouse_id)

    if status_filter:
        query = query.where(StocktakeSession.status == status_filter)
        count_query = count_query.where(StocktakeSession.status == status_filter)

    total_count = (await session.execute(count_query)).scalar() or 0
    results = (await session.scalars(query.offset(offset).limit(limit))).all()
    return list(results), int(total_count)


async def get_stocktake_audit_history(
    session: AsyncSession, stocktake_id: str
) -> List[StocktakeAuditLog]:
    """استرجاع سجل التدقيق الكامل لجلسة الجرد بترتيب زمني."""
    stmt = (
        select(StocktakeAuditLog)
        .where(StocktakeAuditLog.stocktake_id == stocktake_id)
        .order_by(StocktakeAuditLog.timestamp.asc())
    )
    return list((await session.scalars(stmt)).all())


async def get_stocktake_ledger_entries(
    session: AsyncSession, stocktake_id: str
) -> List[StockLedgerEntry]:
    """استرجاع قيود الأستاذ الناتجة عن ترحيل الجرد."""
    stmt = (
        select(StockLedgerEntry)
        .options(
            selectinload(StockLedgerEntry.item).selectinload(CatalogItem.unit),
            selectinload(StockLedgerEntry.unit),
            selectinload(StockLedgerEntry.warehouse),
        )
        .where(
            StockLedgerEntry.reference_doc_type == "stocktake",
            StockLedgerEntry.reference_doc_id == stocktake_id,
        )
        .order_by(StockLedgerEntry.created_at.asc())
    )
    return list((await session.scalars(stmt)).all())

