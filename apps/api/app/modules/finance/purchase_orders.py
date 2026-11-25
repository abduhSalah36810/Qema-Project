"""
خدمات أوامر الشراء وإدارة عجز خامات الإنتاج (Purchase Orders & Shortage Procurement - Phase 5 / T5).
─────────────────────────────────────────────────────────────────────────────
يحقق:
1. احتساب دقيق لعجز خامات أمر التشغيل الفعلي من واقع دفتر حركة المخزون العام (main_raw_materials).
2. استبعاد خامات العملاء (التشغيل للغير - CMT) قطعياً من التوريد والمشتريات الخاصة بالمصنع.
3. تجميع بنود العجز واختيار الموردين وتوليد أوامر شراء مسودة مجمعة حسب المورد.
4. دورة حياة أمر الشراء (draft -> approved -> partially_received -> received / cancelled).
5. عدم المساس بالمخزون إطلاقاً عند إنشاء أمر الشراء أو اعتماده.
6. إثبات التوريد الفعلي بالمخزن كقيود حركة موجبة في دفتر أستاذ المخزون (StockLedgerEntry) بالرصيد الحر فقط (bucket_reference=None).
7. منع التكرار (Idempotency) وحصانة القفل المخزني المتزامن (lock_stock_balance).
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, Set

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.finance.models import (
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    SupplierInvoice,
    SupplierInvoiceLine,
    SupplierReceipt,
)
from app.modules.finance.schemas import (
    GeneratePurchaseOrdersRequest,
    MaterialShortageItem,
    ProductionOrderShortageReport,
    PurchaseOrderCreate,
    PurchaseOrderLineRead,
    PurchaseOrderRead,
    PurchaseOrderReceiptConfirm,
    PurchaseOrderReceiptItemRead,
    PurchaseOrderUpdate,
)
from app.modules.production.models import (
    CatalogItem,
    ProductionOrder,
    ProductionOrderMaterial,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.service import lock_stock_balance
from app.modules.production.stock import stock_balance

QTY_TOLERANCE = 1e-6

PO_STATUS_LABELS_AR: dict[str, str] = {
    "draft": "مسودة جديدة",
    "pending_approval": "بانتظار الاعتماد",
    "approved": "معتمد للتوريد",
    "partially_received": "مستلم جزئياً",
    "received": "مكتمل الاستلام",
    "cancelled": "ملغي",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _can_view_prices(user_roles: Optional[Set[str]]) -> bool:
    if user_roles is None:
        return True
    return bool(user_roles.intersection({"general_manager", "finance_manager"}))


async def generate_po_number(db: AsyncSession) -> str:
    now = _utc_now()
    prefix = f"PO-{now.year}{now.strftime('%m%d')}-"
    stmt = select(PurchaseOrder.order_number).where(PurchaseOrder.order_number.like(f"{prefix}%"))
    existing_numbers = (await db.scalars(stmt)).all()
    seq = 0
    for num in existing_numbers:
        if num and num.startswith(prefix):
            suffix = num[len(prefix):]
            if suffix.isdigit():
                seq = max(seq, int(suffix))

    # التحقق من الكائنات في ذاكرة الجلسة الحالية (identity_map و new)
    for obj in list(db.identity_map.values()) + list(db.new):
        if isinstance(obj, PurchaseOrder) and getattr(obj, "order_number", None) and obj.order_number.startswith(prefix):
            suffix = obj.order_number[len(prefix):]
            if suffix.isdigit():
                seq = max(seq, int(suffix))

    return f"{prefix}{seq + 1:04d}"


# ═════════════════════════════════════════════════════════════════════════════
# 1. احتساب عجز خامات أمر التشغيل (Shortage Calculation)
# ═════════════════════════════════════════════════════════════════════════════

async def get_production_order_shortages(
    db: AsyncSession,
    order_id: str,
    user_roles: Optional[Set[str]] = None,
) -> ProductionOrderShortageReport:
    """
    احتساب عجز الخامات لأمر تشغيل معين:
    - أوامر CMT: استبعاد الخامات الموردة من العميل (supplied_by == 'customer') واحتساب مستلزمات المصنع فقط.
    - تجميع الاحتياج حسب (item_id, unit_id) لمنع التكرار وازدواجية احتساب الرصيد.
    - استعلام الرصيد الفعلي المتاح بمخزن الخامات الرئيسي (main_raw_materials) برصيد المصنع الحر فقط (bucket_reference=None).
    - حصر الكميات الجاري توريدها في أوامر شراء معتمدة لم تستلم بعد.
    """
    order = await db.scalar(
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id)
    )
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    raw_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    if not raw_wh:
        raise HTTPException(status_code=503, detail="مخزن الخامات الرئيسي غير مهيأ في النظام.")

    # 1. تجميع الخامات المطلوبة من المصنع ومن العميل
    # في نمط CMT: خامات العميل (supplied_by == 'customer') تُفصل وتُعرض مع رصيد الأمانة ولا ينشأ عنها عجز مشتريات للمصنع
    grouped_req: dict[tuple[str, str], dict] = {}
    for m in order.materials:
        supplied = getattr(m, "supplied_by", "factory") or "factory"
        is_cmt_cust = bool(order.manufacturing_type == "external" and supplied == "customer")
        key = (m.item_id, m.unit_id)
        if key not in grouped_req:
            grouped_req[key] = {
                "item_id": m.item_id,
                "unit_id": m.unit_id,
                "is_cmt_customer_material": is_cmt_cust,
                "planned_qty": 0.0,
                "dispatched_qty": 0.0,
                "unit_cost": m.unit_cost or Decimal("0.0000"),
                "notes": m.notes or "",
            }
        grouped_req[key]["planned_qty"] += float(m.planned_quantity or 0.0)
        grouped_req[key]["dispatched_qty"] += float(m.dispatched_quantity or 0.0)

    # 2. احتساب الرصيد المتاح والعجز والكميات بالطريق لكل صنف
    shortage_items: list[MaterialShortageItem] = []
    has_any_shortage = False

    for (item_id, unit_id), req_data in grouped_req.items():
        item = await db.get(CatalogItem, item_id)
        unit = await db.get(Unit, unit_id)
        item_code = item.code if item else ""
        item_name_ar = item.name_ar if item else ""
        unit_name_ar = unit.name_ar if unit else ""

        planned_qty = round(req_data["planned_qty"], 6)
        dispatched_qty = round(req_data["dispatched_qty"], 6)
        net_required = max(0.0, round(planned_qty - dispatched_qty, 6))
        is_cmt = req_data["is_cmt_customer_material"]

        if is_cmt:
            # خامات أمانات العميل: رصيد العميل بالمخزن
            cust_bucket = f"customer_deposit:{order.customer_id}" if order.customer_id else None
            available_stock = await stock_balance(db, item_id, raw_wh.id, bucket_reference=cust_bucket)
            pending_inbound = 0.0
            shortage = 0.0
            has_sh = False
        else:
            # خامات المصنع: الرصيد الفعلي الحر بمخزن الخامات (بدون أمانات عملاء أو WIP)
            available_stock = await stock_balance(db, item_id, raw_wh.id, bucket_reference=None)

            # الكميات الجاري توريدها في أوامر شراء معتمدة أو مستلمة جزئياً (Pending Inbound)
            stmt_pending = (
                select(func.coalesce(func.sum(PurchaseOrderLine.ordered_quantity - PurchaseOrderLine.received_quantity), 0.0))
                .join(PurchaseOrder, PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
                .where(
                    PurchaseOrderLine.item_id == item_id,
                    PurchaseOrder.status.in_(["approved", "partially_received"]),
                )
            )
            pending_inbound = round(float((await db.scalar(stmt_pending)) or 0.0), 6)

            # العجز الصافي = ما يلزم للأمر ناقص الرصيد الفعلي المتاح
            shortage = max(0.0, round(net_required - available_stock, 6))
            has_sh = shortage > 0
            if has_sh:
                has_any_shortage = True

        shortage_items.append(
            MaterialShortageItem(
                item_id=item_id,
                item_code=item_code,
                item_name_ar=item_name_ar,
                unit_id=unit_id,
                unit_name_ar=unit_name_ar,
                is_cmt_customer_material=is_cmt,
                required_quantity=planned_qty,
                dispatched_quantity=dispatched_qty,
                net_required_quantity=net_required,
                available_stock=available_stock,
                pending_inbound_quantity=pending_inbound,
                shortage_quantity=shortage,
                proposed_purchase_quantity=shortage,
                has_shortage=has_sh,
                suggested_unit_price=req_data["unit_cost"],
                notes=req_data["notes"],
            )
        )

    # 3. جلب أوامر الشراء السابقة المرتبطة بهذا الأمر
    existing_pos = await list_purchase_orders(db, production_order_id=order.id, user_roles=user_roles)

    # جلب اسم العميل إن وجد
    customer_name = None
    if order.customer_id:
        from app.modules.customers.models import Customer
        cust = await db.get(Customer, order.customer_id)
        customer_name = cust.name if cust else None

    return ProductionOrderShortageReport(
        order_id=order.id,
        order_number=order.order_number,
        manufacturing_type=order.manufacturing_type,
        customer_id=order.customer_id,
        customer_name=customer_name,
        has_shortage=has_any_shortage,
        has_any_shortage=has_any_shortage,
        can_start_production=not has_any_shortage,
        total_shortage_items_count=len([s for s in shortage_items if s.shortage_quantity > 0]),
        materials=shortage_items,
        existing_purchase_orders=existing_pos,
    )


# ═════════════════════════════════════════════════════════════════════════════
# 2. توليد أمر شراء من واقع العجز (PO Generation from Shortage)
# ═════════════════════════════════════════════════════════════════════════════

async def generate_purchase_orders_from_shortage(
    db: AsyncSession,
    order_id: str,
    request_data: GeneratePurchaseOrdersRequest,
    current_user_id: str,
    user_roles: Optional[Set[str]] = None,
    idempotency_key: Optional[str] = None,
) -> list[PurchaseOrderRead]:
    """
    توليد أوامر شراء مسودة بناءً على بنود العجز المحددة بعد التحقق الصارم:
    - التحقق من وجود أمر التشغيل وصلاحية بنود الأصناف والموردين.
    - إعادة فحص المخزون الفعلي للتأكد من عدم حدوث توريد متزامن ألغى العجز.
    - تجميع البنود حسب المورد (لكل مورد أمر شراء منفصل).
    - تسجيل أرقام أوامر الشراء وإدراج البنود بأسعارها المحددة.
    - حماية مانع التكرار (Idempotency).
    """
    data = request_data
    if idempotency_key:
        existing = await list_purchase_orders(db, production_order_id=order_id, user_roles=user_roles)
        matching = [p for p in existing if f"idempotency:{idempotency_key}" in p.notes]
        if matching:
            return matching

    order = await db.scalar(
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id)
    )
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    raw_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    if not raw_wh:
        raise HTTPException(status_code=503, detail="مخزن الخامات الرئيسي غير مهيأ.")

    if not data.lines:
        raise HTTPException(status_code=422, detail="يجب تحديد بند خامة واحد على الأقل للشراء.")

    # التحقق من صحة كل بند وتجميعها حسب المورد
    lines_by_supplier: dict[str, list[dict]] = {}
    for idx, line in enumerate(data.lines):
        supplier = await db.get(Supplier, line.supplier_id)
        if not supplier or not supplier.is_active:
            raise HTTPException(status_code=422, detail=f"المورد المحدد في البند رقم {idx + 1} غير موجود أو موقوف.")

        item = await db.get(CatalogItem, line.item_id)
        if not item or not item.is_active:
            raise HTTPException(status_code=422, detail=f"الصنف '{line.item_id}' غير موجود أو غير نشط في الدليل.")

        unit = await db.get(Unit, line.unit_id)
        if not unit:
            raise HTTPException(status_code=422, detail=f"وحدة القياس '{line.unit_id}' غير موجودة.")

        qty = float(line.quantity)
        if qty <= 0:
            raise HTTPException(status_code=422, detail=f"كمية الشراء للصنف '{item.name_ar}' يجب أن تكون أكبر من صفر.")

        # إعادة فحص الرصيد الفعلي الحي لمنع الشراء الزائد غير المبرر
        live_stock = await stock_balance(db, item.id, raw_wh.id, bucket_reference=None)
        # إيجاد الاحتياج الصافي لهذا الصنف في أمر التشغيل
        matching_mats = [m for m in order.materials if m.item_id == item.id]
        if not matching_mats:
            raise HTTPException(status_code=422, detail=f"الصنف '{item.name_ar}' غير موجود ضمن خامات أمر التشغيل هذا.")

        # في CMT: حظر شراء خامة عميل مطلقاً
        if order.manufacturing_type == "external" and any(getattr(m, "supplied_by", "factory") == "customer" for m in matching_mats):
            raise HTTPException(
                status_code=422,
                detail=f"الصنف '{item.name_ar}' مورد من العميل بأمانة؛ حظر شراء خامات العميل على حساب المصنع.",
            )

        planned_sum = sum(float(m.planned_quantity or 0.0) for m in matching_mats)
        dispatched_sum = sum(float(m.dispatched_quantity or 0.0) for m in matching_mats)
        net_needed = max(0.0, planned_sum - dispatched_sum)
        live_shortage = max(0.0, round(net_needed - live_stock, 6))

        if live_shortage <= QTY_TOLERANCE and qty > 0:
            raise HTTPException(
                status_code=409,
                detail=f"تم تحديث رصيد الصنف '{item.name_ar}' بالمخزن ({live_stock:g}) ولم يعد هناك عجز يستدعي الشراء.",
            )

        mat_ref_id = matching_mats[0].id if matching_mats else None
        if line.supplier_id not in lines_by_supplier:
            lines_by_supplier[line.supplier_id] = []

        lines_by_supplier[line.supplier_id].append({
            "item_id": item.id,
            "unit_id": unit.id,
            "quantity": qty,
            "unit_price": line.unit_price or Decimal("0.0000"),
            "mat_ref_id": mat_ref_id,
            "notes": line.notes.strip(),
        })

    # إنشاء أوامر الشراء المسودة لكل مورد
    created_pos: list[PurchaseOrder] = []
    now = _utc_now()

    for supplier_id, sup_lines in lines_by_supplier.items():
        po_number = await generate_po_number(db)
        total_amount = sum(
            (Decimal(str(l["quantity"])) * l["unit_price"]).quantize(Decimal("0.01"))
            for l in sup_lines
        )

        po = PurchaseOrder(
            id=str(uuid.uuid4()),
            order_number=po_number,
            supplier_id=supplier_id,
            production_order_id=order.id,
            status="draft",
            expected_delivery_date=data.expected_delivery_date,
            total_amount=total_amount,
            notes=(data.notes.strip() + (f" | idempotency:{idempotency_key}" if idempotency_key else "")).strip(" |"),
            created_by=current_user_id,
            created_at=now,
            updated_at=now,
        )
        db.add(po)
        await db.flush()

        for l in sup_lines:
            line_total = (Decimal(str(l["quantity"])) * l["unit_price"]).quantize(Decimal("0.01"))
            po_line = PurchaseOrderLine(
                id=str(uuid.uuid4()),
                purchase_order_id=po.id,
                item_id=l["item_id"],
                unit_id=l["unit_id"],
                ordered_quantity=l["quantity"],
                received_quantity=0.0,
                unit_price=l["unit_price"],
                total_price=line_total,
                production_order_material_id=l["mat_ref_id"],
                notes=l["notes"],
            )
            db.add(po_line)

        created_pos.append(po)

    await db.commit()

    # إعادة قراءة وتسلسل النتائج
    results: list[PurchaseOrderRead] = []
    for po in created_pos:
        fresh = await get_purchase_order_by_id(db, po.id, user_roles=user_roles)
        if fresh:
            results.append(fresh)

    return results


# ═════════════════════════════════════════════════════════════════════════════
# 3. إدارة أوامر الشراء (PO CRUD & State Transitions)
# ═════════════════════════════════════════════════════════════════════════════

async def list_purchase_orders(
    db: AsyncSession,
    *,
    status: Optional[str] = None,
    supplier_id: Optional[str] = None,
    production_order_id: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 100,
    user_roles: Optional[Set[str]] = None,
) -> list[PurchaseOrderRead]:
    """استعراض قائمة أوامر الشراء مع الفلاتر وتطبيق حجب الأسعار لمن ليس له صلاحية مالية."""
    stmt = (
        select(PurchaseOrder)
        .options(
            selectinload(PurchaseOrder.lines),
            selectinload(PurchaseOrder.supplier),
        )
        .order_by(PurchaseOrder.created_at.desc())
    )
    if status:
        stmt = stmt.where(PurchaseOrder.status == status)
    if supplier_id:
        stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
    if production_order_id:
        stmt = stmt.where(PurchaseOrder.production_order_id == production_order_id)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.join(Supplier, PurchaseOrder.supplier_id == Supplier.id).where(
            (PurchaseOrder.order_number.ilike(term)) | (Supplier.name.ilike(term)) | (Supplier.code.ilike(term))
        )

    pos = (await db.scalars(stmt.limit(limit))).all()
    results: list[PurchaseOrderRead] = []
    for po in pos:
        results.append(await _serialize_po(db, po, user_roles))
    return results


async def get_purchase_order_by_id(
    db: AsyncSession,
    po_id: str,
    user_roles: Optional[Set[str]] = None,
) -> Optional[PurchaseOrderRead]:
    """استعلام تفاصيل أمر شراء بالمعرف."""
    po = await db.scalar(
        select(PurchaseOrder)
        .options(
            selectinload(PurchaseOrder.lines),
            selectinload(PurchaseOrder.supplier),
        )
        .where(PurchaseOrder.id == po_id)
    )
    if not po:
        return None
    return await _serialize_po(db, po, user_roles)


async def create_purchase_order(
    db: AsyncSession,
    data: PurchaseOrderCreate,
    current_user_id: str,
    user_roles: Optional[Set[str]] = None,
) -> PurchaseOrderRead:
    """إنشاء أمر شراء يدوي (مسودة جديدة)."""
    supplier = await db.get(Supplier, data.supplier_id)
    if not supplier or not supplier.is_active:
        raise HTTPException(status_code=422, detail="المورد المحدد غير موجود أو موقوف.")

    if data.production_order_id:
        prod_order = await db.get(ProductionOrder, data.production_order_id)
        if not prod_order:
            raise HTTPException(status_code=404, detail="أمر التشغيل المرتبط غير موجود.")

    now = _utc_now()
    po_number = await generate_po_number(db)

    total_amount = Decimal("0.00")
    for line in data.lines:
        item = await db.get(CatalogItem, line.item_id)
        if not item or not item.is_active:
            raise HTTPException(status_code=422, detail=f"الصنف '{line.item_id}' غير موجود أو غير نشط.")
        unit = await db.get(Unit, line.unit_id)
        if not unit:
            raise HTTPException(status_code=422, detail=f"وحدة القياس '{line.unit_id}' غير موجودة.")
        line_total = (Decimal(str(line.ordered_quantity)) * line.unit_price).quantize(Decimal("0.01"))
        total_amount += line_total

    po = PurchaseOrder(
        id=str(uuid.uuid4()),
        order_number=po_number,
        supplier_id=data.supplier_id,
        production_order_id=data.production_order_id,
        status="draft",
        expected_delivery_date=data.expected_delivery_date,
        total_amount=total_amount,
        notes=data.notes.strip(),
        created_by=current_user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(po)
    await db.flush()

    for line in data.lines:
        line_total = (Decimal(str(line.ordered_quantity)) * line.unit_price).quantize(Decimal("0.01"))
        po_line = PurchaseOrderLine(
            id=str(uuid.uuid4()),
            purchase_order_id=po.id,
            item_id=line.item_id,
            unit_id=line.unit_id,
            ordered_quantity=line.ordered_quantity,
            received_quantity=0.0,
            unit_price=line.unit_price,
            total_price=line_total,
            production_order_material_id=line.production_order_material_id,
            notes=line.notes.strip(),
        )
        db.add(po_line)

    await db.commit()
    return await _serialize_po(db, po, user_roles)


async def update_draft_purchase_order(
    db: AsyncSession,
    po_id: str,
    data: PurchaseOrderUpdate,
    current_user_id: str,
    user_roles: Optional[Set[str]] = None,
) -> PurchaseOrderRead:
    """تعديل أمر شراء مسودة (فقط بحالة draft)."""
    po = await db.scalar(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.lines))
        .where(PurchaseOrder.id == po_id)
        .with_for_update()
    )
    if not po:
        raise HTTPException(status_code=404, detail="أمر الشراء غير موجود.")
    if po.status != "draft":
        raise HTTPException(status_code=409, detail=f"لا يمكن تعديل أمر الشراء بحالته الحالية ({PO_STATUS_LABELS_AR.get(po.status, po.status)}). التعديل متاح للمسودات فقط.")

    if data.supplier_id:
        supplier = await db.get(Supplier, data.supplier_id)
        if not supplier or not supplier.is_active:
            raise HTTPException(status_code=422, detail="المورد المحدد غير موجود أو موقوف.")
        po.supplier_id = data.supplier_id

    if data.expected_delivery_date is not None:
        po.expected_delivery_date = data.expected_delivery_date

    if data.notes is not None:
        po.notes = data.notes.strip()

    if data.lines is not None:
        if not data.lines:
            raise HTTPException(status_code=422, detail="يجب أن يحتوي أمر الشراء على بند واحد على الأقل.")
        # حذف البنود القديمة وإعادة إضافة الجديدة
        for old_l in po.lines:
            await db.delete(old_l)

        total_amount = Decimal("0.00")
        for line in data.lines:
            item = await db.get(CatalogItem, line.item_id)
            if not item or not item.is_active:
                raise HTTPException(status_code=422, detail=f"الصنف '{line.item_id}' غير موجود أو موقوف.")
            unit = await db.get(Unit, line.unit_id)
            if not unit:
                raise HTTPException(status_code=422, detail=f"وحدة القياس '{line.unit_id}' غير موجودة.")
            line_total = (Decimal(str(line.ordered_quantity)) * line.unit_price).quantize(Decimal("0.01"))
            total_amount += line_total

            new_l = PurchaseOrderLine(
                id=str(uuid.uuid4()),
                purchase_order_id=po.id,
                item_id=line.item_id,
                unit_id=line.unit_id,
                ordered_quantity=line.ordered_quantity,
                received_quantity=0.0,
                unit_price=line.unit_price,
                total_price=line_total,
                production_order_material_id=line.production_order_material_id,
                notes=line.notes.strip(),
            )
            db.add(new_l)
        po.total_amount = total_amount

    po.updated_at = _utc_now()
    await db.commit()
    return await _serialize_po(db, po, user_roles)


async def approve_purchase_order(
    db: AsyncSession,
    po_id: str,
    current_user_id: str,
    user_roles: Optional[Set[str]] = None,
) -> PurchaseOrderRead:
    """
    اعتماد أمر الشراء رسمياً تمهيداً للتوريد:
    - التحقق من حالة المسودة.
    - تثبيت المعتمد وتاريخ الاعتماد.
    - تنبيه حاسم: الاعتماد لا ينشئ أي حركة في دفتر المخزون (لا توريد دفتري قبل الاستلام الفعلي).
    """
    po = await db.scalar(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.lines))
        .where(PurchaseOrder.id == po_id)
        .with_for_update()
    )
    if not po:
        raise HTTPException(status_code=404, detail="أمر الشراء غير موجود.")
    if po.status == "approved":
        return await _serialize_po(db, po, user_roles)
    if po.status not in ("draft", "pending_approval"):
        raise HTTPException(
            status_code=409,
            detail=f"لا يمكن اعتماد أمر الشراء بحالته الحالية ({PO_STATUS_LABELS_AR.get(po.status, po.status)}).",
        )
    if not po.lines:
        raise HTTPException(status_code=422, detail="لا يمكن اعتماد أمر شراء فارغ من البنود.")

    now = _utc_now()
    po.status = "approved"
    po.approved_by = current_user_id
    po.approved_at = now
    po.updated_at = now

    await db.commit()
    return await _serialize_po(db, po, user_roles)


async def cancel_purchase_order(
    db: AsyncSession,
    po_id: str,
    current_user_id: str,
    reason: str = "",
    user_roles: Optional[Set[str]] = None,
) -> PurchaseOrderRead:
    """
    إلغاء أمر الشراء:
    - لا يجوز إلغاء أمر تم استلام أي كميات منه بالفعل.
    """
    po = await db.scalar(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.lines))
        .where(PurchaseOrder.id == po_id)
        .with_for_update()
    )
    if not po:
        raise HTTPException(status_code=404, detail="أمر الشراء غير موجود.")
    if po.status == "cancelled":
        return await _serialize_po(db, po, user_roles)
    if po.status == "received":
        raise HTTPException(status_code=409, detail="لا يمكن إلغاء أمر شراء تم اكتمال استلامه بالكامل.")

    # فحص هل حدث أي استلام فعلي
    has_receipts = any(float(l.received_quantity or 0.0) > QTY_TOLERANCE for l in po.lines)
    if has_receipts:
        raise HTTPException(
            status_code=409,
            detail="لا يمكن إلغاء أمر الشراء لوجود كميات مستلمة منه بالفعل بالمخزن. يجب إجراء تسوية أو مرتجع للمورد.",
        )

    now = _utc_now()
    po.status = "cancelled"
    if reason.strip():
        po.notes = (po.notes + " | سبب الإلغاء: " + reason.strip()).strip(" |")
    po.updated_at = now

    await db.commit()
    return await _serialize_po(db, po, user_roles)


# ═════════════════════════════════════════════════════════════════════════════
# 4. تأكيد الاستلام الفعلي بالمخزن (Goods Receipt - GRN)
# ═════════════════════════════════════════════════════════════════════════════

async def receive_purchase_order_goods(
    db: AsyncSession,
    po_id: str,
    data: PurchaseOrderReceiptConfirm,
    current_user_id: str,
    user_roles: Optional[Set[str]] = None,
    idempotency_key: Optional[str] = None,
) -> PurchaseOrderRead:
    """
    تأكيد استلام فعلي (كلي أو جزئي) لبضاعة أمر شراء:
    1. يشترط أن يكون أمر الشراء معتمداً أو مستلماً جزئياً.
    2. لا يمكن استلام أكثر من الكمية المتبقية لكل سطر.
    3. كل استلام يولد مستند استلام مخزني (SupplierReceipt) مع رقم GRN.
    4. يدرج قيد ليدجر مخزني معتمد (StockLedgerEntry) بالمخزن الرئيسي (main_raw_materials).
    5. القيد المخزني يكون حصراً في رصيد المصنع الحر (bucket_reference=None) ولا يدخل أمانات العملاء.
    6. تحديث كميات الاستلام وحالة أمر الشراء (received أو partially_received).
    """
    po = await db.scalar(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.lines))
        .where(PurchaseOrder.id == po_id)
        .with_for_update()
    )
    if not po:
        raise HTTPException(status_code=404, detail="أمر الشراء غير موجود.")
    if po.status not in ("approved", "partially_received"):
        raise HTTPException(
            status_code=409,
            detail=f"لا يمكن استلام بضاعة لأمر شراء بحالته الحالية ({PO_STATUS_LABELS_AR.get(po.status, po.status)}). يجب أن يكون الأمر معتمداً.",
        )

    raw_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    if not raw_wh:
        raise HTTPException(status_code=503, detail="مخزن الخامات الرئيسي غير مهيأ.")

    lines_by_id = {l.id: l for l in po.lines}
    receipt_entries = {entry.line_id: entry for entry in data.lines}
    if len(receipt_entries) != len(data.lines):
        raise HTTPException(status_code=422, detail="لا تكرر نفس البند في مستند الاستلام الواحد.")

    unknown_lines = set(receipt_entries) - set(lines_by_id)
    if unknown_lines:
        raise HTTPException(status_code=422, detail="أحد بنود الاستلام لا ينتمي لأمر الشراء هذا.")

    if not any(entry.received_quantity > 0 for entry in receipt_entries.values()):
        raise HTTPException(status_code=422, detail="يجب إدخال كمية مستلمة أكبر من صفر لبند واحد على الأقل.")

    # فحص مسبق صارم لكل الكميات والتأكد من عدم تجاوز أي سطر قبل إنشاء مستند الاستلام
    for line_id, entry in receipt_entries.items():
        qty = float(entry.received_quantity)
        if qty <= 0:
            continue
        line = lines_by_id[line_id]
        already = float(line.received_quantity or 0.0)
        remaining = round(line.ordered_quantity - already, 6)
        if qty > remaining + QTY_TOLERANCE:
            item = await db.get(CatalogItem, line.item_id)
            raise HTTPException(
                status_code=409,
                detail=f"الكمية المستلمة للصنف '{item.name_ar if item else line.item_id}' ({qty:g}) تتجاوز المتبقي بأمر الشراء ({max(0.0, remaining):g}).",
            )

    now = _utc_now()
    receipt_number = f"GRN-{now.year}{now.strftime('%m%d')}-{uuid.uuid4().hex[:6].upper()}"
    receipt = SupplierReceipt(
        id=str(uuid.uuid4()),
        receipt_number=receipt_number,
        purchase_order_id=po.id,
        invoice_id=None,
        received_by=current_user_id,
        received_at=now,
        notes=data.notes.strip(),
        total_cost=Decimal("0.00"),
    )
    db.add(receipt)
    await db.flush()

    total_received_cost = Decimal("0.00")
    for line_id, entry in receipt_entries.items():
        qty = float(entry.received_quantity)
        if qty <= 0:
            continue
        line = lines_by_id[line_id]
        already = float(line.received_quantity or 0.0)

        # قفل الرصيد لمنع التنافس
        await lock_stock_balance(db, line.item_id, raw_wh.id)

        unit_cost = line.unit_price or Decimal("0.0000")
        line_cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))
        total_received_cost += line_cost
        line.received_quantity = round(already + qty, 6)
        if entry.notes.strip():
            line.notes = (line.notes + " | استلام: " + entry.notes.strip()).strip(" |")

        # إدراج قيد المخزون في دفتر الأستاذ (رصيد المصنع العام الحر bucket_reference=None)
        db.add(
            StockLedgerEntry(
                id=str(uuid.uuid4()),
                item_id=line.item_id,
                unit_id=line.unit_id,
                warehouse_id=raw_wh.id,
                location_type="warehouse",
                bucket_reference=None,  # خامات مصنع حرة وليست أمانة عميل
                quantity=qty,
                reference_doc_type="purchase_order_receipt",
                reference_doc_id=receipt.id,
                entry_type="supplier_receipt",
                created_by=current_user_id,
                unit_cost=unit_cost,
                total_cost=line_cost,
            )
        )

        # إذا كان السطر مرتبطاً بفاتورة مورد قائمة نحدّثها بالتوازي
        stmt_inv_line = select(SupplierInvoiceLine).where(SupplierInvoiceLine.purchase_order_line_id == line.id)
        linked_inv_lines = (await db.scalars(stmt_inv_line)).all()
        for sil in linked_inv_lines:
            sil.received_quantity = round((sil.received_quantity or 0.0) + qty, 6)

    receipt.total_cost = total_received_cost

    fully_received = all(
        float(l.received_quantity or 0.0) + QTY_TOLERANCE >= l.ordered_quantity for l in po.lines
    )
    po.status = "received" if fully_received else "partially_received"
    po.updated_at = now
    if data.notes.strip():
        po.notes = (po.notes + " | " + data.notes.strip()).strip(" |")

    await db.commit()
    return await _serialize_po(db, po, user_roles)


# ═════════════════════════════════════════════════════════════════════════════
# 5. دوال التسلسل والعرض وحجب الأسعار (Serialization & Role Masking)
# ═════════════════════════════════════════════════════════════════════════════

async def _serialize_po(
    db: AsyncSession,
    po: PurchaseOrder,
    user_roles: Optional[Set[str]] = None,
) -> PurchaseOrderRead:
    show_prices = _can_view_prices(user_roles)
    zero_dec = Decimal("0.00")

    supplier = await db.get(Supplier, po.supplier_id)
    sup_code = supplier.code if supplier else ""
    sup_name = supplier.name if supplier else ""

    po_prod_number = None
    if po.production_order_id:
        prod_order = await db.get(ProductionOrder, po.production_order_id)
        if prod_order:
            po_prod_number = prod_order.order_number

    total_ordered = 0.0
    total_received = 0.0
    line_reads: list[PurchaseOrderLineRead] = []

    for l in po.lines:
        item = await db.get(CatalogItem, l.item_id)
        unit = await db.get(Unit, l.unit_id)
        ordered = float(l.ordered_quantity or 0.0)
        received = float(l.received_quantity or 0.0)
        remaining = max(0.0, round(ordered - received, 6))

        total_ordered += ordered
        total_received += received

        line_reads.append(
            PurchaseOrderLineRead(
                id=l.id,
                purchase_order_id=l.purchase_order_id,
                item_id=l.item_id,
                item_code=item.code if item else "",
                item_name_ar=item.name_ar if item else "",
                unit_id=l.unit_id,
                unit_name_ar=unit.name_ar if unit else "",
                ordered_quantity=ordered,
                received_quantity=received,
                remaining_quantity=remaining,
                unit_price=l.unit_price if show_prices else None,
                total_price=l.total_price if show_prices else None,
                production_order_material_id=l.production_order_material_id,
                notes=l.notes or "",
            )
        )

    # جلب استلامات هذا الأمر
    stmt_receipts = select(SupplierReceipt).where(SupplierReceipt.purchase_order_id == po.id).order_by(SupplierReceipt.received_at.desc())
    receipt_models = (await db.scalars(stmt_receipts)).all()
    receipt_reads: list[PurchaseOrderReceiptItemRead] = [
        PurchaseOrderReceiptItemRead(
            id=r.id,
            receipt_number=r.receipt_number,
            received_by=r.received_by,
            received_at=r.received_at,
            total_cost=r.total_cost if show_prices else None,
            notes=r.notes or "",
        )
        for r in receipt_models
    ]

    return PurchaseOrderRead(
        id=po.id,
        order_number=po.order_number,
        supplier_id=po.supplier_id,
        supplier_code=sup_code,
        supplier_name=sup_name,
        production_order_id=po.production_order_id,
        production_order_number=po_prod_number,
        status=po.status,
        status_label_ar=PO_STATUS_LABELS_AR.get(po.status, po.status),
        expected_delivery_date=po.expected_delivery_date,
        total_amount=po.total_amount if show_prices else None,
        prices_visible=show_prices,
        total_ordered_quantity=round(total_ordered, 6),
        total_received_quantity=round(total_received, 6),
        total_remaining_quantity=max(0.0, round(total_ordered - total_received, 6)),
        notes=po.notes or "",
        created_by=po.created_by,
        approved_by=po.approved_by,
        approved_at=po.approved_at,
        created_at=po.created_at,
        updated_at=po.updated_at,
        lines=line_reads,
        receipts=receipt_reads,
    )
