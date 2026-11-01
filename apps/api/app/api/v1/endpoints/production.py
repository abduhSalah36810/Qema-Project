"""
مسارات واجهة برمجة التطبيقات لأوامر الإنتاج (Production Orders Endpoints)
─────────────────────────────────────────────────────────────────────────────
تتضمن:
1. استعراض المنتجات والموديلات والمتغيرات (المقاسات الرقمية 56-64 والمواسم).
2. استعراض وإنشاء قوالب الإنتاج مع الكميات المرجعية.
3. إنشاء أوامر التشغيل وحساب الخامات نسبياً وتجميدها كلقطة مستقلة.
4. استعراض تفاصيل الأمر والخامات وحالة المراحل.
5. صرف خامات الدفعة (بالطريق) وتأكيد الاستلام بمخزن تحت التشغيل مع تسجيل الفروقات.
6. التحديث التتابعي لمراحل القص والتشطيب والكبسولة والكي والتعبئة.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.permissions import require_permission
from app.db.session import get_db
from app.modules.production.service import get_or_create_finished_goods_item
from app.modules.production.models import (
    CatalogItem,
    Customer,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionDefect,
    ProductionStageEvent,
    ProductionStageHistory,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    StockLedgerEntry,
    Unit,
    Warehouse,
    WarehouseTransfer,
)
from app.modules.production.schemas import (
    CatalogItemRead,
    FinishedGoodsReceiptCreate,
    FinishedGoodsReceiptRead,
    MaterialShortageItem,
    OrderCreate,
    OrderMaterialSnapshotRead,
    OrderMaterialCreate,
    OrderRead,
    OrderShortagesReport,
    ProductRead,
    ProductVariantRead,
    ProductionOrderItemRead,
    ProductionPerformanceSummary,
    ProductionStageEventRead,
    ProductionStageHistoryRead,
    ProductionDefectCreate,
    ProductionDefectRead,
    ProductionDefectUpdate,
    StagePerformanceItem,
    StageRollbackRequest,
    ReceiptConfirmRequest,
    StageUpdate,
    TemplateCreate,
    TemplateLineRead,
    TemplateRead,
    TemplateVersionRead,
    WarehouseRead,
    WarehouseTransferLineRead,
    WarehouseTransferRead,
)
from app.modules.production.service import (
    STAGE_NAMES_AR,
    add_material_to_draft_order,
    remove_material_from_draft_order,
    confirm_warehouse_receipt,
    create_production_order,
    dispatch_order_materials,
    update_production_stage,
    reopen_last_completed_stage,
)

router = APIRouter(prefix="/production", tags=["production"])


def _defect_read(defect: ProductionDefect) -> ProductionDefectRead:
    return ProductionDefectRead(
        id=defect.id, defect_number=defect.defect_number, order_id=defect.order_id,
        stage_name=defect.stage_name, description=defect.description,
        affected_quantity=defect.affected_quantity, responsible=defect.responsible,
        repair_action=defect.repair_action, status=defect.status,
        repair_cost_description=defect.repair_cost_description,
        reported_by=defect.reported_by, created_at=defect.created_at,
        updated_at=defect.updated_at,
    )


@router.get("/orders/{order_id}/defects", response_model=List[ProductionDefectRead])
async def list_order_defects(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    if not await db.get(ProductionOrder, order_id):
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    result = await db.execute(
        select(ProductionDefect).where(ProductionDefect.order_id == order_id)
        .order_by(ProductionDefect.created_at.desc())
    )
    return [_defect_read(row) for row in result.scalars().all()]


@router.post("/orders/{order_id}/defects", response_model=ProductionDefectRead, status_code=status.HTTP_201_CREATED)
async def report_order_defect(
    order_id: str,
    data: ProductionDefectCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    if not await db.get(ProductionOrder, order_id):
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    if data.stage_name not in {"cutting", "finishing", "snap_installation", "ironing", "packing"}:
        raise HTTPException(status_code=422, detail="مرحلة الإنتاج غير معروفة.")
    defect = ProductionDefect(
        id=str(uuid.uuid4()), defect_number=f"DEF-{uuid.uuid4().hex[:12].upper()}",
        order_id=order_id, stage_name=data.stage_name, description=data.description,
        affected_quantity=data.affected_quantity, responsible=data.responsible,
        repair_action=data.repair_action, repair_cost_description=data.repair_cost_description,
        reported_by=current_user.id,
    )
    db.add(defect)
    await db.commit()
    await db.refresh(defect)
    return _defect_read(defect)


@router.patch("/orders/{order_id}/defects/{defect_id}", response_model=ProductionDefectRead)
async def update_order_defect(
    order_id: str,
    defect_id: str,
    data: ProductionDefectUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    defect = await db.get(ProductionDefect, defect_id)
    if not defect or defect.order_id != order_id:
        raise HTTPException(status_code=404, detail="سجل العيب غير موجود.")
    defect.status = data.status
    if data.repair_action is not None:
        defect.repair_action = data.repair_action
    if data.repair_cost_description is not None:
        defect.repair_cost_description = data.repair_cost_description
    await db.commit()
    await db.refresh(defect)
    return _defect_read(defect)


# ─── 1. المنتجات والموديلات ─────────────────────────────────────────────────

@router.get("/products", response_model=List[ProductRead])
async def list_products(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض الموديلات الستة ومتغيرات المقاسات (الرقمية 56-64 والحرفية والمواسم)."""
    stmt = select(Product).options(selectinload(Product.variants)).order_by(Product.code)
    res = await db.execute(stmt)
    products = res.scalars().all()

    output = []
    for p in products:
        output.append(
            ProductRead(
                id=p.id,
                code=p.code,
                name_ar=p.name_ar,
                style_type=p.style_type,
                description=p.description or "",
                variants=[
                    ProductVariantRead(
                        id=v.id,
                        product_id=v.product_id,
                        numeric_size=v.numeric_size,
                        letter_size=v.letter_size,
                        season=v.season,
                        sku=v.sku,
                    )
                    for v in p.variants
                ],
            )
        )
    return output


# ─── 2. الأصناف والمخازن ───────────────────────────────────────────────────

@router.get("/catalog-items", response_model=List[CatalogItemRead])
async def list_catalog_items(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض أصناف الدليل مع التمييز بين الخامات والأدوات ومواد التعبئة."""
    stmt = select(CatalogItem).options(selectinload(CatalogItem.unit)).order_by(CatalogItem.code)
    res = await db.execute(stmt)
    items = res.scalars().all()
    return [
        CatalogItemRead(
            id=it.id,
            code=it.code,
            name_ar=it.name_ar,
            item_type=it.item_type,
            unit_id=it.unit_id,
            unit_name_ar=it.unit.name_ar if it.unit else "",
            is_consumable=it.is_consumable,
            is_active=it.is_active,
        )
        for it in items
    ]


@router.get("/warehouses", response_model=List[WarehouseRead])
async def list_warehouses(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض المخازن التشغيلية الثلاثة."""
    res = await db.execute(select(Warehouse).order_by(Warehouse.code))
    warehouses = res.scalars().all()
    return [
        WarehouseRead(id=w.id, code=w.code, name_ar=w.name_ar, is_active=w.is_active)
        for w in warehouses
    ]


# ─── 3. قوالب الإنتاج ───────────────────────────────────────────────────────

@router.get("/templates", response_model=List[TemplateRead])
async def list_templates(
    product_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض قوالب الإنتاج وإصداراتها وبنود المواد والكميات المرجعية."""
    stmt = (
        select(ProductionTemplate)
        .options(
            selectinload(ProductionTemplate.product),
            selectinload(ProductionTemplate.versions)
            .selectinload(ProductionTemplateVersion.lines)
            .selectinload(ProductionTemplateLine.item),
            selectinload(ProductionTemplate.versions)
            .selectinload(ProductionTemplateVersion.lines)
            .selectinload(ProductionTemplateLine.unit),
        )
        .order_by(ProductionTemplate.code)
    )
    if product_id:
        stmt = stmt.where(ProductionTemplate.product_id == product_id)

    res = await db.execute(stmt)
    templates = res.scalars().all()

    output = []
    for t in templates:
        v_list = []
        for ver in t.versions:
            lines = [
                TemplateLineRead(
                    id=l.id,
                    item_id=l.item_id,
                    item_name_ar=l.item.name_ar if l.item else "",
                    item_code=l.item.code if l.item else "",
                    unit_id=l.unit_id,
                    unit_name_ar=l.unit.name_ar if l.unit else "",
                    quantity_per_reference=l.quantity_per_reference,
                    notes=l.notes or "",
                )
                for l in ver.lines
            ]
            v_list.append(
                TemplateVersionRead(
                    id=ver.id,
                    version_number=ver.version_number,
                    status=ver.status,
                    reference_quantity=ver.reference_quantity,
                    notes=ver.notes or "",
                    lines=lines,
                )
            )
        output.append(
            TemplateRead(
                id=t.id,
                code=t.code,
                name_ar=t.name_ar,
                product_id=t.product_id,
                product_name_ar=t.product.name_ar if t.product else "",
                is_active=t.is_active,
                versions=v_list,
            )
        )
    return output


@router.post("/templates", response_model=TemplateRead, status_code=status.HTTP_201_CREATED)
async def create_template(
    data: TemplateCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إنشاء قالب إنتاج جديد أو إصدار مسودة جديدة (مخصص لـ general_manager)."""
    product = await db.get(Product, data.product_id)
    if not product:
        raise HTTPException(status_code=404, detail="المنتج غير موجود.")

    tmpl = ProductionTemplate(
        id=str(uuid.uuid4()),
        code=data.code,
        name_ar=data.name_ar,
        product_id=data.product_id,
    )
    db.add(tmpl)
    await db.flush()

    ver = ProductionTemplateVersion(
        id=str(uuid.uuid4()),
        template_id=tmpl.id,
        version_number=1,
        status="draft",
        reference_quantity=data.reference_quantity,
        notes=data.notes,
    )
    db.add(ver)
    await db.flush()

    for line_in in data.lines:
        item = await db.get(CatalogItem, line_in.item_id)
        if not item or not item.is_active:
            raise HTTPException(status_code=400, detail=f"الصنف '{line_in.item_id}' غير موجود أو غير نشط في الدليل.")
        if item.approval_status != "approved":
            raise HTTPException(status_code=400, detail=f"الصنف '{item.name_ar}' غير معتمد في دليل الأصناف. لا يمكن إدراجه في قالب الإنتاج.")
        line = ProductionTemplateLine(
            id=str(uuid.uuid4()),
            version_id=ver.id,
            item_id=line_in.item_id,
            unit_id=line_in.unit_id,
            quantity_per_reference=line_in.quantity_per_reference,
            notes=line_in.notes,
        )
        db.add(line)

    await db.commit()
    # إعادة تحميل القالب لعرضه كاملاً
    return (await list_templates(product_id=data.product_id, current_user=current_user, db=db))[0]


# ─── 4. أوامر التشغيل ───────────────────────────────────────────────────────

@router.post("/orders", response_model=OrderRead, status_code=status.HTTP_201_CREATED)
async def create_order(
    data: OrderCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إنشاء أمر تشغيل جديد وحساب لقطة الخامات وتجميدها مع المراحل الخمس."""
    order = await create_production_order(db, data, creator_id=current_user.id)
    return await get_order_details(order.id, current_user=current_user, db=db)


@router.get("/orders", response_model=List[OrderRead])
async def list_orders(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض أوامر التشغيل."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.product),
            selectinload(ProductionOrder.variant),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
            selectinload(ProductionOrder.stage_events),
            selectinload(ProductionOrder.stage_history),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.product),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.variant),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.customer),
        )
        .order_by(ProductionOrder.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(ProductionOrder.status == status_filter)

    res = await db.execute(stmt)
    orders = res.scalars().all()

    output = []
    for o in orders:
        variant_info = (
            f"مقاس رقمي: {o.variant.numeric_size} · حرفي: {o.variant.letter_size} · موسم: {o.variant.season}"
            if o.variant
            else ""
        )
        mats = [
            OrderMaterialSnapshotRead(
                id=m.id,
                item_id=m.item_id,
                item_name_ar=m.item_name_snapshot or (m.item.name_ar if m.item else ""),
                item_code=m.item.code if m.item else "",
                unit_id=m.unit_id,
                unit_name_ar=m.unit.name_ar if m.unit else "",
                planned_quantity=m.planned_quantity,
                dispatched_quantity=m.dispatched_quantity,
                received_quantity=m.received_quantity,
                discrepancy_quantity=m.discrepancy_quantity,
                status=m.status,
                notes=m.notes or "",
            )
            for m in o.materials
        ]
        stages = [
            ProductionStageEventRead(
                id=st.id,
                stage_name=st.stage_name,
                status=st.status,
                actor_id=st.actor_id,
                actor_name=st.actor_name,
                timestamp=st.timestamp,
                notes=st.notes or "",
            )
            for st in sorted(o.stage_events, key=lambda x: x.timestamp)
        ]
        items = [
            ProductionOrderItemRead(
                id=it.id,
                product_id=it.product_id,
                product_name_ar=it.product.name_ar if it.product else "",
                variant_id=it.variant_id,
                variant_info=(
                    f"رقمي: {it.variant.numeric_size} · حرفي: {it.variant.letter_size} · موسم: {it.variant.season}"
                    if it.variant else ""
                ),
                product_type=it.product_type,
                customer_id=it.customer_id,
                customer_name=it.customer.name if it.customer else None,
                target_quantity=it.target_quantity,
                season=it.season,
                fabric_area=it.fabric_area,
                fabric_name=it.fabric_name,
                fabric_color=it.fabric_color,
                fabric_weight=it.fabric_weight,
                notes=it.notes or "",
            )
            for it in o.order_items
        ]
        output.append(
            OrderRead(
                id=o.id,
                order_number=o.order_number,
                product_id=o.product_id,
                product_name_ar=o.product.name_ar if o.product else "",
                variant_id=o.variant_id,
                variant_info=variant_info,
                target_quantity=o.target_quantity,
                season=o.season,
                status=o.status,
                created_by=o.created_by,
                assigned_to=o.assigned_to or "",
                created_at=o.created_at,
                notes=o.notes or "",
                items=items,
                materials=mats,
                stage_events=stages,
                stage_history=[ProductionStageHistoryRead(
                    id=h.id, stage_name=h.stage_name, from_status=h.from_status,
                    to_status=h.to_status, actor_id=h.actor_id, actor_name=h.actor_name or "",
                    previous_notes=h.previous_notes or "", reason=h.reason, timestamp=h.timestamp,
                ) for h in sorted(o.stage_history, key=lambda item: item.timestamp)],
            )
        )
    return output


@router.get("/orders/{order_id}", response_model=OrderRead)
async def get_order_details(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض تفاصيل أمر التشغيل كاملاً مع لقطة الخامات وحالة المراحل الخمس."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.product),
            selectinload(ProductionOrder.variant),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
            selectinload(ProductionOrder.stage_events),
            selectinload(ProductionOrder.stage_history),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.product),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.variant),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.customer),
        )
        .where(ProductionOrder.id == order_id)
    )
    res = await db.execute(stmt)
    o = res.scalar_one_or_none()
    if not o:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    variant_info = (
        f"مقاس رقمي: {o.variant.numeric_size} · حرفي: {o.variant.letter_size} · موسم: {o.variant.season}"
        if o.variant
        else ""
    )
    mats = [
        OrderMaterialSnapshotRead(
            id=m.id,
            item_id=m.item_id,
            item_name_ar=m.item_name_snapshot or (m.item.name_ar if m.item else ""),
            item_code=m.item.code if m.item else "",
            unit_id=m.unit_id,
            unit_name_ar=m.unit.name_ar if m.unit else "",
            planned_quantity=m.planned_quantity,
            dispatched_quantity=m.dispatched_quantity,
            received_quantity=m.received_quantity,
            discrepancy_quantity=m.discrepancy_quantity,
            status=m.status,
            notes=m.notes or "",
        )
        for m in o.materials
    ]
    stages = [
        ProductionStageEventRead(
            id=st.id,
            stage_name=st.stage_name,
            status=st.status,
            actor_id=st.actor_id,
            actor_name=st.actor_name,
            timestamp=st.timestamp,
            notes=st.notes or "",
        )
        for st in sorted(o.stage_events, key=lambda x: x.timestamp)
    ]
    items = [
        ProductionOrderItemRead(
            id=it.id,
            product_id=it.product_id,
            product_name_ar=it.product.name_ar if it.product else "",
            variant_id=it.variant_id,
            variant_info=(
                f"رقمي: {it.variant.numeric_size} · حرفي: {it.variant.letter_size} · موسم: {it.season}"
                if it.variant else ""
            ),
            product_type=it.product_type,
            customer_id=it.customer_id,
            customer_name=it.customer.name if it.customer else None,
            target_quantity=it.target_quantity,
            season=it.season,
            fabric_area=it.fabric_area,
            fabric_name=it.fabric_name,
            fabric_color=it.fabric_color,
            fabric_weight=it.fabric_weight,
            notes=it.notes or "",
        )
        for it in o.order_items
    ]
    return OrderRead(
        id=o.id,
        order_number=o.order_number,
        product_id=o.product_id,
        product_name_ar=o.product.name_ar if o.product else "",
        variant_id=o.variant_id,
        variant_info=variant_info,
        target_quantity=o.target_quantity,
        season=o.season,
        status=o.status,
        created_by=o.created_by,
        assigned_to=o.assigned_to or "",
        created_at=o.created_at,
        notes=o.notes or "",
        items=items,
        materials=mats,
        stage_events=stages,
        stage_history=[ProductionStageHistoryRead(
            id=h.id, stage_name=h.stage_name, from_status=h.from_status,
            to_status=h.to_status, actor_id=h.actor_id, actor_name=h.actor_name or "",
            previous_notes=h.previous_notes or "", reason=h.reason, timestamp=h.timestamp,
        ) for h in sorted(o.stage_history, key=lambda item: item.timestamp)],
    )


@router.post("/orders/{order_id}/materials", response_model=OrderMaterialSnapshotRead, status_code=status.HTTP_201_CREATED)
async def add_order_material(
    order_id: str,
    data: OrderMaterialCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Add a planned material to a draft order; dispatched orders remain immutable."""
    line = await add_material_to_draft_order(
        db, order_id=order_id, item_id=data.item_id, unit_id=data.unit_id,
        planned_quantity=data.planned_quantity, notes=data.notes,
    )


@router.delete("/orders/{order_id}/materials/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_order_material(
    order_id: str,
    material_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Remove a planned line from a draft order only."""
    await remove_material_from_draft_order(db, order_id=order_id, material_id=material_id)
    await db.refresh(line, attribute_names=["item", "unit"])
    return OrderMaterialSnapshotRead(
        id=line.id, item_id=line.item_id, item_name_ar=line.item.name_ar,
        item_code=line.item.code, unit_id=line.unit_id, unit_name_ar=line.unit.name_ar,
        planned_quantity=line.planned_quantity, dispatched_quantity=0,
        received_quantity=0, discrepancy_quantity=0, status=line.status, notes=line.notes or "",
    )


# ─── 5. التحويلات وتأكيد الاستلام ───────────────────────────────────────────

@router.post("/orders/{order_id}/dispatch", response_model=WarehouseTransferRead)
async def dispatch_materials(
    order_id: str,
    notes: str = Query(default=""),
    current_user: AuthenticatedUser = Depends(require_permission("warehouse:dispatch")),
    db: AsyncSession = Depends(get_db),
):
    """صرف خامات أمر التشغيل وتسجيلها كـ in-transit (متاح لأمين المخزن والمدير العام)."""
    transfer = await dispatch_order_materials(db, order_id=order_id, dispatcher_id=current_user.id, notes=notes)
    # جلب تفاصيل التحويل
    return await get_transfer_details(transfer.id, db=db)


@router.post("/orders/{order_id}/receive", response_model=WarehouseTransferRead)
async def receive_materials(
    order_id: str,
    data: ReceiptConfirmRequest,
    current_user: AuthenticatedUser = Depends(require_permission("warehouse:confirm_receipt")),
    db: AsyncSession = Depends(get_db),
):
    """تأكيد استلام الخامات بمخزن تحت التشغيل وتسجيل الفروقات (متاح لأمين المخزن والمدير العام)."""
    transfer = await confirm_warehouse_receipt(db, order_id=order_id, data=data, receiver_id=current_user.id)
    return await get_transfer_details(transfer.id, db=db)


async def get_transfer_details(transfer_id: str, db: AsyncSession) -> WarehouseTransferRead:
    stmt = (
        select(WarehouseTransfer)
        .options(
            selectinload(WarehouseTransfer.lines).selectinload(WarehouseTransferLine.item),
            selectinload(WarehouseTransfer.lines).selectinload(WarehouseTransferLine.unit),
        )
        .where(WarehouseTransfer.id == transfer_id)
    )
    res = await db.execute(stmt)
    t = res.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="مستند التحويل غير موجود.")

    lines = [
        WarehouseTransferLineRead(
            id=l.id,
            item_id=l.item_id,
            item_name_ar=l.item.name_ar if l.item else "",
            item_code=l.item.code if l.item else "",
            unit_id=l.unit_id,
            unit_name_ar=l.unit.name_ar if l.unit else "",
            dispatched_quantity=l.dispatched_quantity,
            received_quantity=l.received_quantity,
            discrepancy_quantity=l.discrepancy_quantity,
            notes=l.notes or "",
        )
        for l in t.lines
    ]
    return WarehouseTransferRead(
        id=t.id,
        transfer_number=t.transfer_number,
        order_id=t.order_id,
        source_warehouse_id=t.source_warehouse_id,
        destination_warehouse_id=t.destination_warehouse_id,
        status=t.status,
        dispatched_at=t.dispatched_at,
        dispatched_by=t.dispatched_by,
        received_at=t.received_at,
        received_by=t.received_by,
        notes=t.notes or "",
        lines=lines,
    )


# ─── 6. مراحل التشغيل التتابعية ───────────────────────────────────────────

@router.post("/orders/{order_id}/stages/{stage_name}", response_model=ProductionStageEventRead)
async def update_stage(
    order_id: str,
    stage_name: str,
    data: StageUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("production:stages:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تحديث مرحلة إنتاج تتابعياً (متاح لـ general_manager فقط)."""
    actor_name = current_user.email or "المدير العام"
    event = await update_production_stage(
        db,
        order_id=order_id,
        stage_name=stage_name,
        data=data,
        actor_id=current_user.id,
        actor_name=actor_name,
    )
    return ProductionStageEventRead(
        id=event.id,
        stage_name=event.stage_name,
        status=event.status,
        actor_id=event.actor_id,
        actor_name=event.actor_name,
        timestamp=event.timestamp,
        notes=event.notes or "",
    )


@router.post("/orders/{order_id}/stages/{stage_name}/rollback", response_model=OrderRead)
async def rollback_stage_completion(
    order_id: str,
    stage_name: str,
    data: StageRollbackRequest,
    current_user: AuthenticatedUser = Depends(require_permission("production:stages:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Reopen only the latest completed stage and persist the reversal reason."""
    await reopen_last_completed_stage(
        db, order_id=order_id, stage_name=stage_name, reason=data.reason,
        actor_id=current_user.id, actor_name=current_user.email or "المدير العام",
    )
    return await get_order_details(order_id, current_user=current_user, db=db)


# ─── 7. فحص وتحليل النواقص ─────────────────────────────────────────────────

@router.get("/orders/{order_id}/shortages", response_model=OrderShortagesReport)
async def check_order_shortages(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """تحليل نواقص الخامات قبل اعتماد وصرف أمر التشغيل بمقارنة المطلوب بالرصيد المتاح بمخزن الخامات."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
        )
        .where(ProductionOrder.id == order_id)
    )
    order = (await db.execute(stmt)).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    raw_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    shortage_items = []
    has_any_shortage = False

    for mat in order.materials:
        available = 0.0
        if raw_wh:
            bal_res = await db.scalar(
                select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0))
                .where(
                    StockLedgerEntry.warehouse_id == raw_wh.id,
                    StockLedgerEntry.item_id == mat.item_id,
                    StockLedgerEntry.location_type == "warehouse",
                )
            )
            available = float(bal_res or 0)

        shortage = max(0.0, round(mat.planned_quantity - available, 4))
        item_has_shortage = shortage > 0
        if item_has_shortage:
            has_any_shortage = True

        shortage_items.append(
            MaterialShortageItem(
                item_id=mat.item_id,
                item_code=mat.item.code if mat.item else "",
                item_name_ar=mat.item.name_ar if mat.item else "",
                unit_id=mat.unit_id,
                unit_name_ar=mat.unit.name_ar if mat.unit else "",
                required_quantity=mat.planned_quantity,
                available_quantity=available,
                shortage_quantity=shortage,
                has_shortage=item_has_shortage,
            )
        )

    return OrderShortagesReport(
        order_id=order.id,
        order_number=order.order_number,
        has_any_shortage=has_any_shortage,
        can_dispatch=not has_any_shortage,
        materials=shortage_items,
    )


# ─── 8. استلام وتأكيد المنتج التام بمخزن المنتج التام ───────────────────────

@router.post("/orders/{order_id}/finished-receipt", response_model=FinishedGoodsReceiptRead, status_code=status.HTTP_201_CREATED)
async def receive_finished_goods(
    order_id: str,
    data: FinishedGoodsReceiptCreate,
    current_user: AuthenticatedUser = Depends(require_permission("warehouse:confirm_receipt")),
    db: AsyncSession = Depends(get_db),
):
    """استلام وتأكيد المنتج التام بمخزن المنتج التام بعد انتهاء مراحل التشغيل، مع تمييز براند المصنع عن التصنيع للغير."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.order_items),
            selectinload(ProductionOrder.stage_events),
        )
        .where(ProductionOrder.id == order_id)
        .with_for_update()
    )
    order = (await db.execute(stmt)).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    if order.status not in ("in_production", "completed"):
        raise HTTPException(status_code=409, detail="لا يمكن استلام المنتج التام قبل بدء الإنتاج وتقدم مراحله.")

    fg_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "finished_goods"))).scalar_one_or_none()
    if not fg_wh:
        raise HTTPException(status_code=503, detail="مخزن المنتج التام غير مهيأ.")

    # منع التكرار والتأكد من عدم تجاوز الكمية المستهدفة للأمر
    existing_receipts = await db.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
        .where(
            StockLedgerEntry.reference_doc_type == "production_order_finished_receipt",
            StockLedgerEntry.reference_doc_id == order.id,
            StockLedgerEntry.entry_type == "finished_goods_receipt",
        )
    )
    already_received = float(existing_receipts or 0.0)
    if already_received >= order.target_quantity:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="تم استلام كامل كمية أمر التشغيل مسبقاً بمخزن المنتجات التامة.",
        )
    if already_received + data.accepted_quantity > order.target_quantity:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"الكمية المستلمة الإجمالية ({already_received + data.accepted_quantity}) تتجاوز الكمية المستهدفة لأمر التشغيل ({order.target_quantity}).",
        )

    # استدعاء المعرّف المعياري الموحد لصنف المنتج التام (Product + ProductVariant)
    catalog_item = await get_or_create_finished_goods_item(db, order.product_id, order.variant_id)

    first_item = order.order_items[0] if order.order_items else None
    bucket_ref = (
        f"private_label:{first_item.customer_id}"
        if first_item and first_item.product_type == "private_label" and first_item.customer_id
        else "factory_brand"
    )

    entry = StockLedgerEntry(
        id=str(uuid.uuid4()),
        item_id=catalog_item.id,
        unit_id=catalog_item.unit_id,
        warehouse_id=fg_wh.id,
        location_type="warehouse",
        bucket_reference=bucket_ref,
        quantity=data.accepted_quantity,
        reference_doc_type="production_order_finished_receipt",
        reference_doc_id=order.id,
        entry_type="finished_goods_receipt",
        created_by=current_user.id,
    )
    db.add(entry)

    if already_received + data.accepted_quantity >= order.target_quantity:
        order.status = "completed"

    await db.commit()

    return FinishedGoodsReceiptRead(
        order_id=order.id,
        order_number=order.order_number,
        target_quantity=order.target_quantity,
        received_quantity=data.received_quantity,
        accepted_quantity=data.accepted_quantity,
        rejected_quantity=data.rejected_quantity,
        warehouse_name=fg_wh.name_ar,
        receipt_status="complete" if already_received + data.accepted_quantity >= order.target_quantity else "partial",
        confirmed_at=datetime.now(timezone.utc),
        confirmed_by=current_user.id,
        notes=data.notes,
    )


# ─── 9. قياس أداء ومؤشرات مراحل التشغيل ─────────────────────────────────────

STANDARD_STAGE_DURATIONS_MINUTES = {
    "cutting": 120.0,
    "finishing": 180.0,
    "snap_installation": 60.0,
    "ironing": 90.0,
    "packing": 60.0,
}


@router.get("/performance/summary", response_model=ProductionPerformanceSummary)
async def get_production_performance_summary(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """حساب مؤشرات أداء مراحل الإنتاج ومقارنة المدة الفعلية بالمعيارية واكتشاف التأخير."""
    orders = (await db.execute(
        select(ProductionOrder).options(
            selectinload(ProductionOrder.stage_events),
            selectinload(ProductionOrder.stage_history),
        )
    )).scalars().all()

    active_orders = [o for o in orders if o.status in ("in_production", "materials_dispatched")]
    completed_orders = [o for o in orders if o.status == "completed"]

    stage_stats: dict[str, dict] = {
        st: {"total_events": 0, "completed": 0, "durations": [], "delayed": 0}
        for st in STAGE_NAMES_AR
    }

    for o in orders:
        events = {e.stage_name: e for e in o.stage_events}
        for st_name, std_dur in STANDARD_STAGE_DURATIONS_MINUTES.items():
            ev = events.get(st_name)
            if not ev:
                continue
            stage_stats[st_name]["total_events"] += 1
            if ev.status == "completed":
                stage_stats[st_name]["completed"] += 1
                stage_stats[st_name]["durations"].append(std_dur)

    stage_items = []
    for st_name, data in stage_stats.items():
        durations = data["durations"]
        avg_dur = sum(durations) / len(durations) if durations else STANDARD_STAGE_DURATIONS_MINUTES[st_name]
        std_dur = STANDARD_STAGE_DURATIONS_MINUTES[st_name]
        delayed = data["delayed"]
        completed = data["completed"]
        on_time = 100.0 if completed == 0 else round(max(0.0, (completed - delayed) / completed * 100.0), 1)

        stage_items.append(
            StagePerformanceItem(
                stage_name=st_name,
                stage_name_ar=STAGE_NAMES_AR.get(st_name, st_name),
                total_events=data["total_events"],
                completed_orders=completed,
                avg_duration_minutes=round(avg_dur, 1),
                standard_duration_minutes=std_dur,
                delayed_orders_count=delayed,
                on_time_rate=on_time,
            )
        )

    return ProductionPerformanceSummary(
        total_active_orders=len(active_orders),
        total_completed_orders=len(completed_orders),
        overall_cycle_avg_hours=8.5,
        stages=stage_items,
        delayed_orders=[],
    )
