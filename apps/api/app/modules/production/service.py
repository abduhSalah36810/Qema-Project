"""
منطق أعمال وتشغيل أوامر الإنتاج المؤقتة (Production Domain Service)
─────────────────────────────────────────────────────────────────────────────
يطبق القواعد المؤقتة المعتمدة لاجتماع المصنع:
1. التناسب الحسابي لكميات المواد اعتماداً على الكمية المرجعية للقالب.
2. تجميد لقطة الخامات المستقلة (Material Snapshot) لحماية الأمر من تعديل القالب.
3. التتابع المرحلي الإلزامي للمراحل الخمس (القص -> التشطيب -> الكبسولة -> الكي -> التعبئة).
4. دورة التحويل المخزني: الصرف (بالطريق) ثم تأكيد أمين المخزن للاستلام مع تسجيل الفروقات.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple
from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.production.models import (
    CatalogItem,
    Customer,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionStageHistory,
    ProductionStageEvent,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
    StockLedgerEntry,
    utc_now,
)
from app.modules.production.schemas import (
    OrderCreate,
    ProductionOrderItemCreate,
    ReceiptConfirmRequest,
    StageUpdate,
    TemplateCreate,
)
from app.modules.finance.ledger_service import post_journal_entry, get_weighted_average_cost


ORDER_STAGES_SEQUENCE = [
    "cutting",
    "finishing",
    "snap_installation",
    "ironing",
    "packing",
]

STAGE_NAMES_AR = {
    "cutting": "القص على الباترون",
    "finishing": "التشطيب",
    "snap_installation": "تركيب الكبسولة",
    "ironing": "الكي",
    "packing": "التعبئة والتغليف",
}


async def calculate_proportional_materials(
    session: AsyncSession,
    template_version_id: str,
    target_quantity: float,
) -> List[Dict]:
    """
    احتساب كميات الخامات النسبية للكمية المستهدفة استناداً إلى الكمية المرجعية للقالب.
    planned_quantity = (target_quantity / reference_quantity) * quantity_per_reference
    """
    stmt = (
        select(ProductionTemplateVersion)
        .options(selectinload(ProductionTemplateVersion.lines).selectinload(ProductionTemplateLine.unit))
        .where(ProductionTemplateVersion.id == template_version_id)
    )
    result = await session.execute(stmt)
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="إصدار قالب الإنتاج المطلوب غير موجود.",
        )

    if version.reference_quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="الكمية المرجعية للقالب غير صالحة.",
        )

    ratio = target_quantity / version.reference_quantity
    snapshot_lines = []

    for line in version.lines:
        planned_qty = round(line.quantity_per_reference * ratio, 4)
        unit = line.__dict__.get("unit")
        snapshot_lines.append({
            "item_id": line.item_id,
            "unit_id": line.unit_id,
            "planned_quantity": planned_qty,
            "notes": line.notes or "",
            "quantity_per_piece": (Decimal(str(line.quantity_per_reference)) / Decimal(str(version.reference_quantity))).quantize(Decimal("0.0001")),
            "unit_name": getattr(unit, "name_ar", "") or "",
        })

    return snapshot_lines


async def create_production_order(
    session: AsyncSession,
    data: OrderCreate,
    creator_id: str,
    customer_order_line_id: Optional[str] = None,
) -> ProductionOrder:
    """
    إنشاء أمر تشغيل جديد وحفظ لقطة خامات مجمدة والمراحل التتابعية الخمس.
    """
    requested_items = data.items or [ProductionOrderItemCreate(
        product_id=data.product_id or "", variant_id=data.variant_id or "",
        target_quantity=data.target_quantity or 0, season=data.season or "",
        template_version_id=data.template_version_id,
    )]
    from app.modules.production.bom import active_bom_version, variant_label

    item_details: list[tuple[ProductionOrderItemCreate, Product, ProductVariant, Customer | None]] = []
    missing_bom: list[str] = []
    for input_item in requested_items:
        product = await session.get(Product, input_item.product_id)
        if not product:
            raise HTTPException(status_code=404, detail=f"المنتج غير موجود: {input_item.product_id}.")
        variant = await session.get(ProductVariant, input_item.variant_id)
        if not variant or variant.product_id != product.id:
            raise HTTPException(status_code=400, detail="متغير المقاس والموسم لا يتبع المنتج المحدد.")
        if getattr(product, "is_active", True) is False:
            raise HTTPException(status_code=422, detail=f"الموديل «{product.name_ar}» موقوف؛ أعد تفعيله من «الموديلات والمقاسات» قبل إنشاء أمر له.")
        if getattr(variant, "is_active", True) is False:
            raise HTTPException(status_code=422, detail=f"{variant_label(variant)} للموديل «{product.name_ar}» موقوف؛ أعد تفعيله أو اختر مقاساً آخر.")
        customer = None
        if input_item.product_type == "private_label":
            customer = await session.get(Customer, input_item.customer_id)
            if not customer or customer.status != "active":
                raise HTTPException(status_code=404, detail="عميل التصنيع للغير غير موجود أو غير نشط.")
        if not input_item.template_version_id:
            # المستلزمات من BOM المقاس النشط تلقائياً
            bom_version = await active_bom_version(session, variant.id)
            if isinstance(bom_version, ProductionTemplateVersion) and bom_version.lines:
                input_item.template_version_id = bom_version.id
            elif not data.custom_materials:
                missing_bom.append(f"{product.name_ar} ({variant_label(variant)})")
        if input_item.template_version_id:
            version = await session.get(ProductionTemplateVersion, input_item.template_version_id)
            if not version:
                raise HTTPException(status_code=404, detail="إصدار قالب الإنتاج غير موجود.")
            template = await session.get(ProductionTemplate, version.template_id)
            if not template or template.product_id != product.id:
                raise HTTPException(status_code=422, detail="قالب الخامات لا يتبع الموديل المحدد.")
        item_details.append((input_item, product, variant, customer))

    if missing_bom:
        raise HTTPException(
            status_code=422,
            detail="لا يمكن إنشاء أمر التشغيل: مستلزمات التصنيع غير معرّفة لـ " + "، ".join(missing_bom)
            + ". عرّفها من «الموديلات والمقاسات» أولاً.",
        )

    first_input, first_product, first_variant, _ = item_details[0]
    total_target = sum(input_item.target_quantity for input_item, _, _, _ in item_details)
    order_season = first_input.season if all(entry[0].season == first_input.season for entry in item_details) else "mixed"

    # توليد رقم أمر فريد
    now_year = datetime.now(timezone.utc).year
    count_res = await session.execute(select(ProductionOrder.id))
    order_count = len(count_res.scalars().all()) + 1
    # لاحقة عشوائية قصيرة تمنع تصادم الأرقام عند الإنشاء المتزامن (القيد فريد في القاعدة)
    order_number = f"PO-{now_year}-{order_count:04d}-{uuid.uuid4().hex[:4].upper()}"

    order = ProductionOrder(
        id=str(uuid.uuid4()),
        order_number=order_number,
        product_id=first_product.id,
        variant_id=first_variant.id,
        template_version_id=first_input.template_version_id if len(item_details) == 1 else None,
        customer_order_line_id=customer_order_line_id,
        target_quantity=total_target,
        season=order_season,
        status="draft",
        created_by=creator_id,
        assigned_to=data.assigned_to,
        notes=data.notes,
        created_at=utc_now(),
    )
    session.add(order)

    order_item_ids: list[str] = []
    for input_item, product, variant, customer in item_details:
        order_item_ids.append(str(uuid.uuid4()))
        session.add(ProductionOrderItem(
            id=order_item_ids[-1], order_id=order.id, product_id=product.id, variant_id=variant.id,
            product_type=input_item.product_type, customer_id=customer.id if customer else None,
            template_version_id=input_item.template_version_id,
            target_quantity=input_item.target_quantity, season=input_item.season,
            fabric_area=input_item.fabric_area.strip(), fabric_name=input_item.fabric_name.strip(),
            fabric_color=input_item.fabric_color.strip(), fabric_weight=input_item.fabric_weight.strip(),
            notes=input_item.notes.strip(),
        ))

    # 1. إعداد لقطة الخامات (Snapshot) + نسخة ثابتة من مستلزمات كل سطر
    from app.modules.production.models import ProductionOrderItemMaterial

    material_totals: dict[str, dict] = {}
    for (input_item, _, _, _), order_item_id in zip(item_details, order_item_ids):
        if not input_item.template_version_id:
            continue
        calc_lines = await calculate_proportional_materials(
            session, input_item.template_version_id, input_item.target_quantity
        )
        for line in calc_lines:
            catalog_item = await session.get(CatalogItem, line["item_id"])
            if not catalog_item or not catalog_item.is_active or catalog_item.unit_id != line["unit_id"]:
                raise HTTPException(
                    status_code=422,
                    detail=f"الصنف «{catalog_item.name_ar if catalog_item else line['item_id']}» في مستلزمات التصنيع موقوف أو تغيّرت وحدته في دليل الأصناف. حدّث مستلزمات المقاس.",
                )
            # نسخة ثابتة من مستلزمات هذا السطر داخل الأمر (لا تتأثر بتعديل BOM لاحقاً)
            session.add(ProductionOrderItemMaterial(
                id=str(uuid.uuid4()), order_item_id=order_item_id, template_version_id=input_item.template_version_id,
                item_id=line["item_id"], unit_id=line["unit_id"],
                item_name_snapshot=(catalog_item.name_ar or "")[:128],
                unit_name_snapshot=(line.get("unit_name") or "")[:64],
                quantity_per_piece=line["quantity_per_piece"],
                total_quantity=Decimal(str(line["planned_quantity"])).quantize(Decimal("0.0001")),
            ))
            current = material_totals.get(line["item_id"])
            if current and current["unit_id"] != line["unit_id"]:
                raise HTTPException(status_code=422, detail="وحدات الصنف تختلف بين قوالب بنود أمر التشغيل.")
            if not current:
                material_totals[line["item_id"]] = {**line, "notes": line["notes"], "name_ar": catalog_item.name_ar if catalog_item else ""}
            else:
                current["planned_quantity"] = round(current["planned_quantity"] + line["planned_quantity"], 4)
                if line["notes"]:
                    current["notes"] = (current["notes"] + " | " + line["notes"]).strip(" |")

    included_item_ids = set(material_totals)
    if data.custom_materials:
        for mat in data.custom_materials:
            if mat.item_id in included_item_ids:
                raise HTTPException(status_code=400, detail="لا يمكن إضافة صنف مكرر من خامات القالب أو الأمر.")
            catalog_item = await session.get(CatalogItem, mat.item_id)
            if not catalog_item or not catalog_item.is_active:
                raise HTTPException(status_code=404, detail="أحد أصناف الخامات غير موجود أو موقوف.")
            if catalog_item.unit_id != mat.unit_id:
                raise HTTPException(status_code=400, detail="وحدة القياس لا تطابق وحدة أحد أصناف الخامات.")
            included_item_ids.add(mat.item_id)
            material_totals[mat.item_id] = {
                "item_id": mat.item_id, "unit_id": mat.unit_id,
                "planned_quantity": mat.planned_quantity, "notes": mat.notes,
                "name_ar": catalog_item.name_ar if catalog_item else "",
            }

    for line in material_totals.values():
        name_ar = line.get("name_ar")
        if not name_ar:
            mat_item = await session.get(CatalogItem, line["item_id"])
            name_ar = mat_item.name_ar if mat_item else ""
        session.add(ProductionOrderMaterial(
            id=str(uuid.uuid4()), order_id=order.id, item_id=line["item_id"],
            unit_id=line["unit_id"], planned_quantity=line["planned_quantity"],
            dispatched_quantity=0.0, received_quantity=0.0, discrepancy_quantity=0.0,
            status="pending", notes=line["notes"],
            item_name_snapshot=name_ar,
        ))

    # 2. إنشاء أحداث المراحل الخمس في حالة not_started
    for stage_name in ORDER_STAGES_SEQUENCE:
        stage_event = ProductionStageEvent(
            id=str(uuid.uuid4()),
            order_id=order.id,
            stage_name=stage_name,
            status="not_started",
            actor_id=creator_id,
            actor_name="النظام",
            timestamp=utc_now(),
            notes=f"مرحلة {STAGE_NAMES_AR.get(stage_name, stage_name)} بانتظار البدء.",
        )
        session.add(stage_event)

    await session.commit()
    await session.refresh(order)
    return order


async def add_material_to_draft_order(
    session: AsyncSession,
    order_id: str,
    item_id: str,
    unit_id: str,
    planned_quantity: float,
    notes: str = "",
) -> ProductionOrderMaterial:
    """Add a planned material line only while an order is still a draft."""
    order = await session.get(ProductionOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    if order.status != "draft":
        raise HTTPException(status_code=409, detail="لا يمكن تعديل خامات الأمر بعد بدء الصرف.")
    item = await session.get(CatalogItem, item_id)
    if not item or not item.is_active:
        raise HTTPException(status_code=404, detail="الصنف غير موجود أو موقوف.")
    if item.approval_status != "approved":
        raise HTTPException(status_code=400, detail=f"الصنف '{item.name_ar}' غير معتمد في دليل الأصناف. لا يمكن إدراجه ضمن خامات أمر التشغيل.")
    if item.unit_id != unit_id:
        raise HTTPException(status_code=400, detail="وحدة القياس لا تطابق وحدة الصنف.")
    existing = await session.execute(
        select(ProductionOrderMaterial.id).where(
            ProductionOrderMaterial.order_id == order_id,
            ProductionOrderMaterial.item_id == item_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="الصنف موجود بالفعل ضمن خامات الأمر.")
    if planned_quantity <= 0:
        raise HTTPException(status_code=400, detail="الكمية يجب أن تكون أكبر من صفر.")

    line = ProductionOrderMaterial(
        id=str(uuid.uuid4()), order_id=order_id, item_id=item_id, unit_id=unit_id,
        planned_quantity=planned_quantity, dispatched_quantity=0, received_quantity=0,
        discrepancy_quantity=0, status="pending", notes=notes,
        item_name_snapshot=item.name_ar,
    )
    session.add(line)
    await session.commit()
    await session.refresh(line)
    return line


async def remove_material_from_draft_order(
    session: AsyncSession, order_id: str, material_id: str
) -> None:
    """Remove a planned material only before dispatch; never rewrite a movement."""
    order = await session.get(ProductionOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    if order.status != "draft":
        raise HTTPException(status_code=409, detail="لا يمكن حذف خامة بعد بدء الصرف.")
    from app.modules.production.models import ProductionOrderItem, ProductionOrderItemMaterial

    line = await session.get(ProductionOrderMaterial, material_id)
    if not line or line.order_id != order_id:
        raise HTTPException(status_code=404, detail="خامة الأمر غير موجودة.")
    # خامات مستلزمات التصنيع المحفوظة في الأمر لا تُحذف (لا اختلاف غير موثق بين المطلوب والمصروف)
    from_bom = await session.scalar(
        select(ProductionOrderItemMaterial.id)
        .join(ProductionOrderItem, ProductionOrderItem.id == ProductionOrderItemMaterial.order_item_id)
        .where(ProductionOrderItem.order_id == order.id, ProductionOrderItemMaterial.item_id == line.item_id)
    )
    if isinstance(from_bom, str):
        raise HTTPException(
            status_code=409,
            detail="هذه الخامة من مستلزمات التصنيع المحفوظة في الأمر ولا تُحذف منه. لتغيير المستلزمات عدّل BOM المقاس وأنشئ أمراً جديداً.",
        )
    await session.delete(line)
    await session.commit()


async def lock_stock_balance(session: AsyncSession, item_id: str, warehouse_id: str) -> None:
    """
    قفل موحد على مستوى (Item + Warehouse) لحماية رصيد المخزون من التنافس والتزامن.
    يستخدم PostgreSQL Transaction-scoped Advisory Lock لضمان تسلسل العمليات
    التي تقرأ أو تعدل رصيد صنف معين في مخزن معين، دون قفل المخزن بأكمله أو الأصناف الأخرى.
    """
    bind = session.bind
    dialect_name = bind.dialect.name if bind else "postgresql"
    if dialect_name == "postgresql":
        lock_key = f"stock_balance:{item_id}:{warehouse_id}"
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
            {"lock_key": lock_key},
        )


async def dispatch_order_materials(
    session: AsyncSession,
    order_id: str,
    dispatcher_id: str,
    notes: str = "",
    commit: bool = True,
) -> WarehouseTransfer:
    """
    صرف خامات أمر التشغيل من مخزن الخامات الرئيسي:
    - قفل أرصدة الأصناف تصاعدياً بحسب item_id لحظر التنافس والرصيد السالب.
    - تسجيل المواد كـ "بالطريق" (in_transit).
    - تحديث حالة أمر التشغيل إلى materials_dispatched.
    """
    stmt = (
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id)
        .with_for_update()
    )
    res = await session.execute(stmt)
    order = res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    if order.status not in ("draft", "pending"):
        raise HTTPException(status_code=400, detail="تم صرف خامات هذا الأمر مسبقاً.")

    # جلب المخزن الرئيسي ومخزن تحت التشغيل
    raw_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    wip_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "work_in_progress"))).scalar_one_or_none()

    if not raw_wh or not wip_wh:
        raise HTTPException(status_code=500, detail="بيانات المخازن التشغيلية غير مكتملة.")

    # قفل الأرصدة المستهدفة تصاعدياً بحسب item_id لتجنب التعارض ومنع الديدلوك
    sorted_materials = sorted(order.materials, key=lambda m: m.item_id)
    for mat in sorted_materials:
        await lock_stock_balance(session, mat.item_id, raw_wh.id)

    shortages = []
    for mat in sorted_materials:
        available = await session.scalar(
            select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0)).where(
                StockLedgerEntry.item_id == mat.item_id,
                StockLedgerEntry.warehouse_id == raw_wh.id,
                StockLedgerEntry.location_type == "warehouse",
            )
        )
        if float(available or 0.0) + 1e-9 < mat.planned_quantity:
            item = await session.get(CatalogItem, mat.item_id)
            shortages.append(
                f"{item.name_ar if item else mat.item_id}: المتاح {float(available or 0):g} والمطلوب {mat.planned_quantity:g}"
            )
    if shortages:
        raise HTTPException(
            status_code=409,
            detail="لا يمكن صرف الخامات لعدم كفاية الرصيد: " + "؛ ".join(shortages),
        )

    now_year = datetime.now(timezone.utc).year
    transfer_number = f"TR-{now_year}-{uuid.uuid4().hex[:6].upper()}"

    transfer = WarehouseTransfer(
        id=str(uuid.uuid4()),
        transfer_number=transfer_number,
        order_id=order.id,
        source_warehouse_id=raw_wh.id,
        destination_warehouse_id=wip_wh.id,
        status="in_transit",
        dispatched_at=utc_now(),
        dispatched_by=dispatcher_id,
        notes=notes,
    )
    session.add(transfer)

    lines = []
    for mat in order.materials:
        mat.dispatched_quantity = mat.planned_quantity
        mat.status = "dispatched"
        # احتساب متوسط التكلفة المرجح للخامة وتجميد التكلفة بالأمر
        mat_wac = await get_weighted_average_cost(session, mat.item_id, raw_wh.id)
        mat.unit_cost = mat_wac
        mat.total_cost = (Decimal(str(mat.planned_quantity)) * mat_wac).quantize(Decimal("0.01"))
        line = WarehouseTransferLine(
            id=str(uuid.uuid4()),
            transfer_id=transfer.id,
            item_id=mat.item_id,
            unit_id=mat.unit_id,
            dispatched_quantity=mat.planned_quantity,
            received_quantity=0.0,
            discrepancy_quantity=0.0,
            notes=mat.notes or "",
        )
        session.add(line)
        lines.append((line, mat))

    # تثبيت سند التحويل وسطور التحويل أولاً لضمان وجود المفتاح الأجنبي لـ transfer_line_id
    await session.flush()

    for line, mat in lines:
        session.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=mat.item_id, unit_id=mat.unit_id,
            warehouse_id=raw_wh.id, location_type="warehouse", quantity=-mat.planned_quantity,
            reference_doc_type="warehouse_transfer", reference_doc_id=transfer.id,
            transfer_line_id=line.id, entry_type="dispatch_source", created_by=dispatcher_id,
            unit_cost=mat.unit_cost, total_cost=-mat.total_cost,
        ))
        session.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=mat.item_id, unit_id=mat.unit_id,
            warehouse_id=None, location_type="in_transit", bucket_reference=transfer.id,
            quantity=mat.planned_quantity, reference_doc_type="warehouse_transfer",
            reference_doc_id=transfer.id, transfer_line_id=line.id,
            entry_type="dispatch_transit", created_by=dispatcher_id,
            unit_cost=mat.unit_cost, total_cost=mat.total_cost,
        ))

    order.status = "materials_dispatched"
    if commit:
        await session.commit()
        await session.refresh(transfer)
    else:
        await session.flush()
        await session.refresh(transfer)
    return transfer


async def confirm_warehouse_receipt(
    session: AsyncSession,
    order_id: str,
    data: ReceiptConfirmRequest,
    receiver_id: str,
    commit: bool = True,
) -> WarehouseTransfer:
    """
    تأكيد استلام المواد في مخزن تحت التشغيل من قبل أمين المخزن:
    - تسجيل الكميات المقبولة فعلياً.
    - تسجيل الفروقات إن وجدت دون مسح الأثر.
    - تحديث حالة أمر التشغيل إلى in_production.
    """
    # اتجاه التحويل صراحة: صرف من مخزن الخامات إلى مخزن تحت التشغيل فقط.
    # مستندات مرتجعات الورشة (تحت التشغيل ← الخامات) تحمل رقم الأمر نفسه ولا يجوز اختيارها هنا.
    raw_wh_id = select(Warehouse.id).where(Warehouse.code == "main_raw_materials").scalar_subquery()
    wip_wh_id = select(Warehouse.id).where(Warehouse.code == "work_in_progress").scalar_subquery()
    transfer_stmt = (
        select(WarehouseTransfer)
        .options(selectinload(WarehouseTransfer.lines))
        .where(
            WarehouseTransfer.order_id == order_id,
            WarehouseTransfer.source_warehouse_id == raw_wh_id,
            WarehouseTransfer.destination_warehouse_id == wip_wh_id,
        )
        .order_by(WarehouseTransfer.dispatched_at.desc())
        .with_for_update()
    )
    t_res = await session.execute(transfer_stmt)
    transfer = t_res.scalar_one_or_none()
    if not transfer:
        raise HTTPException(status_code=404, detail="لا يوجد مستند تحويل خامات لهذا الأمر.")

    if transfer.status == "received_confirmed":
        raise HTTPException(status_code=400, detail="تم تأكيد استلام هذا التحويل مسبقاً.")

    # فصل المسؤوليات: من صرف الخامات لا يؤكد استلامها بالورشة بنفسه، مهما كانت صلاحياته
    if transfer.dispatched_by and transfer.dispatched_by == receiver_id:
        raise HTTPException(
            status_code=409,
            detail="لا يجوز لمن صرف الخامات أن يؤكد استلامها بنفسه. يؤكد الاستلام مسؤول الإنتاج أو مستخدم آخر مخوّل.",
        )

    order_stmt = (
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id)
    )
    o_res = await session.execute(order_stmt)
    order = o_res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    # قفل الأصناف بمخزن الوجهة لضمان التزامن
    sorted_lines = sorted(transfer.lines, key=lambda l: l.item_id)
    for line in sorted_lines:
        await lock_stock_balance(session, line.item_id, transfer.destination_warehouse_id)

    if order.status != "materials_dispatched":
        raise HTTPException(status_code=409, detail="لا يمكن تأكيد استلام الخامات إلا لأمر صُرفت خاماته ولم يُستلم بعد.")

    transfer_item_ids = {line.item_id for line in transfer.lines}
    unknown_items = [entry.item_id for entry in data.received_lines if entry.item_id not in transfer_item_ids]
    if unknown_items:
        raise HTTPException(status_code=422, detail="أحد أصناف الاستلام ليس ضمن مستند صرف الخامات لهذا الأمر.")
    received_map = {item.item_id: item.received_quantity for item in data.received_lines}
    notes_map = {item.item_id: item.notes for item in data.received_lines}
    materials_by_item = {mat.item_id: mat for mat in order.materials}

    received_cost = Decimal("0.00")
    transit_loss_cost = Decimal("0.00")
    dispatched_cost = Decimal("0.00")
    wip_bucket = f"order:{order.id}"

    for line in transfer.lines:
        rec_qty = round(float(received_map.get(line.item_id, line.dispatched_quantity)), 6)
        if rec_qty < 0 or rec_qty > line.dispatched_quantity + 1e-9:
            raise HTTPException(
                status_code=409,
                detail=f"الكمية المستلمة ({rec_qty:g}) يجب أن تكون بين صفر والكمية المصروفة ({line.dispatched_quantity:g}). الزيادة تُصرف بمستند صرف مستقل.",
            )
        disc_qty = round(rec_qty - line.dispatched_quantity, 6)
        mat = materials_by_item.get(line.item_id)
        unit_cost = Decimal(str(mat.unit_cost if mat and mat.unit_cost is not None else 0))
        rec_cost = (Decimal(str(rec_qty)) * unit_cost).quantize(Decimal("0.01"))
        disp_cost = (Decimal(str(line.dispatched_quantity)) * unit_cost).quantize(Decimal("0.01"))
        received_cost += rec_cost
        dispatched_cost += disp_cost
        transit_loss_cost += disp_cost - rec_cost

        line.received_quantity = rec_qty
        line.discrepancy_quantity = disc_qty
        session.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
            warehouse_id=None, location_type="in_transit", bucket_reference=transfer.id,
            quantity=-line.dispatched_quantity, reference_doc_type="warehouse_transfer",
            reference_doc_id=transfer.id, transfer_line_id=line.id,
            entry_type="receipt_transit", created_by=receiver_id,
            unit_cost=unit_cost, total_cost=-disp_cost,
        ))
        if rec_qty > 0:
            session.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
                warehouse_id=transfer.destination_warehouse_id, location_type="warehouse",
                bucket_reference=wip_bucket,
                quantity=rec_qty, reference_doc_type="warehouse_transfer",
                reference_doc_id=transfer.id, transfer_line_id=line.id,
                entry_type="receipt_warehouse", created_by=receiver_id,
                unit_cost=unit_cost, total_cost=rec_cost,
            ))
        if disc_qty != 0:
            session.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
                warehouse_id=None, location_type="discrepancy", bucket_reference=transfer.id,
                quantity=-disc_qty, reference_doc_type="warehouse_transfer",
                reference_doc_id=transfer.id, transfer_line_id=line.id,
                entry_type="receipt_discrepancy", created_by=receiver_id,
                unit_cost=unit_cost, total_cost=(disp_cost - rec_cost),
            ))
        if notes_map.get(line.item_id):
            line.notes = f"{line.notes} | {notes_map[line.item_id]}".strip(" |")

        if mat:
            mat.received_quantity = rec_qty
            mat.discrepancy_quantity = disc_qty
            mat.status = "received_with_discrepancy" if disc_qty != 0 else "received_complete"

    transfer.status = "received_confirmed"
    transfer.received_at = utc_now()
    transfer.received_by = receiver_id
    if data.notes:
        transfer.notes = f"{transfer.notes} | استلام: {data.notes}".strip(" |")

    # تكلفة الخامات المستلمة فعلياً بالورشة هي تكلفة الأمر (الفاقد في النقل لا يُحمل على المنتج)
    order.actual_material_cost = (order.actual_material_cost or Decimal("0.00")) + received_cost
    labor = order.actual_labor_cost or Decimal("0.00")
    overhead = order.actual_overhead_cost or Decimal("0.00")
    order.total_actual_cost = order.actual_material_cost + labor + overhead
    order.wip_balance = (order.wip_balance or Decimal("0.00")) + received_cost
    target_q = Decimal(str(order.target_quantity or 0))
    if target_q > Decimal("0.00"):
        order.unit_manufacturing_cost = (order.total_actual_cost / target_q).quantize(Decimal("0.0001"))

    # قيد تحويل الخامات للورشة (في نفس المعاملة): Dr 1220 بالمستلم + Dr 5200 بفاقد النقل / Cr 1210 بالمصروف
    if dispatched_cost > Decimal("0.00"):
        journal_lines = []
        if received_cost > Decimal("0.00"):
            journal_lines.append({"account_code": "1220", "debit": received_cost, "credit": 0, "description": f"خامات مستلمة بالورشة لأمر {order.order_number}"})
        if transit_loss_cost > Decimal("0.00"):
            journal_lines.append({"account_code": "5200", "debit": transit_loss_cost, "credit": 0, "description": f"عجز خامات أثناء النقل لأمر {order.order_number}"})
        journal_lines.append({"account_code": "1210", "debit": 0, "credit": dispatched_cost, "description": "صرف خامات من مخزن الخامات"})
        await post_journal_entry(
            session,
            source_doc_type="production_wip_issue",
            source_doc_id=transfer.id,
            description=f"تحميل تكلفة خامات على أمر التشغيل {order.order_number} بمخزن تحت التشغيل",
            lines=journal_lines,
            user_id=receiver_id,
        )

    order.status = "in_production"
    if commit:
        await session.commit()
        await session.refresh(transfer)
    else:
        await session.flush()
        await session.refresh(transfer)
    return transfer


async def update_production_stage(
    session: AsyncSession,
    order_id: str,
    stage_name: str,
    data: StageUpdate,
    actor_id: str,
    actor_name: str = "",
) -> ProductionStageEvent:
    """
    تحديث حالة إحدى مراحل الإنتاج الخمس مع فرض التتابع التسلسلي:
    (cutting -> finishing -> snap_installation -> ironing -> packing)
    """
    if stage_name not in ORDER_STAGES_SEQUENCE:
        raise HTTPException(
            status_code=400,
            detail=f"اسم المرحلة غير معتمد. المراحل المعتمدة: {', '.join(ORDER_STAGES_SEQUENCE)}",
        )

    order_stmt = (
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.stage_events))
        .where(ProductionOrder.id == order_id)
    )
    o_res = await session.execute(order_stmt)
    order = o_res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    if order.status != "in_production":
        raise HTTPException(
            status_code=409,
            detail="لا يمكن تحديث مراحل الإنتاج إلا بعد صرف الخامات وتأكيد استلامها بالورشة (حالة الأمر: قيد الإنتاج).",
        )

    # ترتيب المراحل والتحقق من التتابع
    stage_index = ORDER_STAGES_SEQUENCE.index(stage_name)
    events_by_stage = {ev.stage_name: ev for ev in order.stage_events}

    # إذا أراد وضعها in_progress أو completed، يجب أن تكون المرحلة السابقة completed
    if data.status in ("in_progress", "completed") and stage_index > 0:
        prev_stage = ORDER_STAGES_SEQUENCE[stage_index - 1]
        prev_event = events_by_stage.get(prev_stage)
        if not prev_event or prev_event.status != "completed":
            prev_name_ar = STAGE_NAMES_AR.get(prev_stage, prev_stage)
            raise HTTPException(
                status_code=400,
                detail=f"لا يمكن بدء أو إكمال مرحلة ({STAGE_NAMES_AR.get(stage_name)}) قبل إكمال المرحلة السابقة ({prev_name_ar}).",
            )

    target_event = events_by_stage.get(stage_name)
    previous_status = target_event.status if target_event else "not_started"
    if data.status not in ("in_progress", "completed"):
        raise HTTPException(status_code=400, detail="تغيير حالة المرحلة يتم عبر إجراءاتها المخصصة فقط.")
    allowed_next = {"not_started": "in_progress", "in_progress": "completed"}
    if allowed_next.get(previous_status) != data.status:
        stage_ar = STAGE_NAMES_AR.get(stage_name, stage_name)
        if previous_status == "not_started" and data.status == "completed":
            detail = f"ابدأ مرحلة ({stage_ar}) أولاً قبل تسجيل إكمالها."
        elif previous_status == data.status:
            detail = f"مرحلة ({stage_ar}) مسجلة بهذه الحالة بالفعل؛ حدّث الصفحة لرؤية آخر وضع."
        elif previous_status == "completed":
            detail = f"مرحلة ({stage_ar}) مكتملة بالفعل. للتصحيح استخدم التراجع عن المرحلة مع ذكر السبب."
        else:
            detail = "حالة المرحلة تغيرت؛ حدّث الصفحة قبل تنفيذ الإجراء."
        raise HTTPException(status_code=409, detail=detail)
    if not target_event:
        target_event = ProductionStageEvent(
            id=str(uuid.uuid4()),
            order_id=order.id,
            stage_name=stage_name,
            status=data.status,
            actor_id=actor_id,
            actor_name=actor_name,
            timestamp=utc_now(),
            notes=data.notes,
        )
        session.add(target_event)
    else:
        target_event.status = data.status
        target_event.actor_id = actor_id
        target_event.actor_name = actor_name or target_event.actor_name
        target_event.timestamp = utc_now()
        if data.notes:
            target_event.notes = data.notes

    if previous_status != data.status:
        session.add(ProductionStageHistory(
            id=str(uuid.uuid4()), order_id=order.id, stage_name=stage_name,
            from_status=previous_status, to_status=data.status, actor_id=actor_id,
            actor_name=actor_name or "", previous_notes=target_event.notes if target_event else "",
            reason=data.notes.strip() or "تحديث حالة المرحلة",
            timestamp=utc_now(),
        ))

    # إذا اكتملت مرحلة التعبئة والتغليف (المرحلة الأخيرة)، ينتهي التصنيع الميداني بانتظار استلام المنتج التام
    if stage_name == "packing" and data.status == "completed":
        order.status = "manufacturing_completed"

    await session.commit()
    await session.refresh(target_event)
    return target_event


async def reopen_last_completed_stage(
    session: AsyncSession,
    order_id: str,
    stage_name: str,
    reason: str,
    actor_id: str,
    actor_name: str = "",
) -> ProductionStageEvent:
    """Reopen only the latest completed stage while every later stage is untouched."""
    clean_reason = reason.strip()
    if len(clean_reason) < 3:
        raise HTTPException(status_code=422, detail="سبب التراجع مطلوب (٣ أحرف على الأقل).")
    if stage_name not in ORDER_STAGES_SEQUENCE:
        raise HTTPException(status_code=400, detail="اسم المرحلة غير معتمد.")

    result = await session.execute(
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.stage_events))
        .where(ProductionOrder.id == order_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    if order.status not in ("in_production", "manufacturing_completed"):
        raise HTTPException(status_code=409, detail="لا يمكن التراجع عن مراحل أمر تم استلام منتجه التام بالكامل أو إغلاقه.")

    event_by_stage = {event.stage_name: event for event in order.stage_events}
    event = event_by_stage.get(stage_name)
    if not event or event.status != "completed":
        raise HTTPException(status_code=409, detail="يمكن التراجع عن مرحلة مكتملة فقط.")

    index = ORDER_STAGES_SEQUENCE.index(stage_name)
    later_events = [event_by_stage.get(name) for name in ORDER_STAGES_SEQUENCE[index + 1:]]
    if any(later and later.status != "not_started" for later in later_events):
        raise HTTPException(status_code=409, detail="لا يمكن التراجع لأن مرحلة لاحقة بدأت أو اكتملت.")

    now = utc_now()
    session.add(ProductionStageHistory(
        id=str(uuid.uuid4()), order_id=order.id, stage_name=stage_name,
        from_status="completed", to_status="in_progress", actor_id=actor_id,
        actor_name=actor_name or "", previous_notes=event.notes or "",
        reason=clean_reason, timestamp=now,
    ))
    event.status = "in_progress"
    event.actor_id = actor_id
    event.actor_name = actor_name or event.actor_name
    event.timestamp = now
    event.notes = clean_reason
    if stage_name == "packing":
        order.status = "in_production"
    await session.commit()
    await session.refresh(event)
    return event


async def seed_provisional_data_if_empty(session: AsyncSession) -> None:
    """
    تهيئة البيانات التشغيلية المؤقتة لأغراض العرض واجتماع الغد إذا كانت قاعدة البيانات فارغة:
    - المخازن الثلاثة.
    - وحدات القياس.
    - أصناف الخامات والمستلزمات والأدوات القابلة لإعادة الاستخدام.
    - الموديلات الستة والمتغيرات بالأبعاد الرقمية والحرفية والمواسم.
    - قوالب إنتاج تجريبية مع كميات مرجعية.
    """
    from app.modules.identity.models import Role

    # 1. تهيئة الأدوار المؤقتة
    roles_data = [
        ("general_manager", "المدير العام", "إدارة شاملة لأوامر الإنتاج والمراحل والأسعار والعملاء"),
        ("warehouse_manager", "أمين المخزن", "إدارة المخزون وصرف الخامات وتأكيد استلام المواد"),
        ("production_manager", "مدير الإنتاج", "إدارة أوامر ومراحل التشغيل الميدانية واستلام خامات WIP وإثبات الاستهلاك"),
        ("finance_manager", "المدير المالي", "إدارة المصروفات وسجلات الرواتب والدفعات المالية"),
    ]
    for r_name, r_ar, r_desc in roles_data:
        existing = await session.execute(select(Role).where(Role.name == r_name))
        if not existing.scalar_one_or_none():
            session.add(Role(id=str(uuid.uuid4()), name=r_name, display_name_ar=r_ar, description=r_desc))

    # 2. تهيئة المخازن
    warehouses_data = [
        ("main_raw_materials", "مخزن الخامات الرئيسي"),
        ("work_in_progress", "مخزن تحت التشغيل ودفعات الإنتاج"),
        ("finished_goods", "مخزن المنتج التام"),
    ]
    for w_code, w_name in warehouses_data:
        existing_w = await session.execute(select(Warehouse).where(Warehouse.code == w_code))
        if not existing_w.scalar_one_or_none():
            session.add(Warehouse(id=str(uuid.uuid4()), code=w_code, name_ar=w_name))

    # 3. تهيئة الوحدات
    units_data = [
        ("meter", "متر"),
        ("piece", "قطعة"),
        ("roll", "بكرة"),
        ("kg", "كجم"),
        ("dozen", "دزينة"),
    ]
    units_map = {}
    for u_code, u_name in units_data:
        u_res = await session.execute(select(Unit).where(Unit.code == u_code))
        unit_obj = u_res.scalar_one_or_none()
        if not unit_obj:
            unit_obj = Unit(id=str(uuid.uuid4()), code=u_code, name_ar=u_name)
            session.add(unit_obj)
        units_map[u_code] = unit_obj

    await session.flush()

    # 4. تهيئة أصناف الدليل مع التمييز الواضح
    items_data = [
        ("FAB-COTTON-01", "قماش قطني أبيض فاخر", "fabric", "meter", True),
        ("FAB-LINEN-02", "قماش كتان رملي بيج", "fabric", "meter", True),
        ("ACC-BUTTON-01", "أزرار عاجية كلاسيكية", "accessory", "piece", True),
        ("ACC-SNAP-01", "كبسولات معدنية فضية", "accessory", "piece", True),
        ("ACC-THREAD-01", "بكرة خيط أبيض متين", "accessory", "roll", True),
        ("TOOL-PATTERN-58", "باترون كفتة مقاس 58 (أداة)", "reusable_tool", "piece", False),  # أداة غير مستهلكة
        ("MAINT-OIL-01", "زيت ماكينات خياطة نقي", "maintenance_supply", "piece", True),
        ("PKG-BOX-01", "كرتونة تغليف جلابية فردية", "packaging", "piece", True),
    ]
    items_map = {}
    for code, name, itype, ucode, is_cons in items_data:
        it_res = await session.execute(select(CatalogItem).where(CatalogItem.code == code))
        item_obj = it_res.scalar_one_or_none()
        if not item_obj:
            item_obj = CatalogItem(
                id=str(uuid.uuid4()),
                code=code,
                name_ar=name,
                item_type=itype,
                unit_id=units_map[ucode].id,
                is_consumable=is_cons,
            )
            session.add(item_obj)
        items_map[code] = item_obj

    await session.flush()

    # 5. تهيئة الموديلات الستة والمتغيرات
    styles_data = [
        ("PRD-GLB-01", "جلابية نصف لياقة مع كفتة", "half_collar_cuff", "موديل نصف لياقة كلاسيك مع كفتة أكمام مطرزة"),
        ("PRD-GLB-02", "جلابية نصف لياقة بالطو", "half_collar_balto", "موديل نصف لياقة نمط بالطو رسمي"),
        ("PRD-GLB-03", "جلابية لياقة كاملة مع كفتة", "full_collar_cuff", "موديل لياقة مقفولة كاملة مع كفتة رسمية"),
        ("PRD-GLB-04", "جلابية لياقة كاملة بالطو", "full_collar_balto", "موديل لياقة كاملة نمط بالطو شتوي"),
        ("PRD-GLB-05", "جلابية نص كم", "short_sleeve_galabeya", "موديل صيفي خفيف مريح نصف كم"),
        ("PRD-SHR-01", "شروال قطني كلاسيكي", "sharwal", "شروال قطن مريح متناسق"),
    ]

    numeric_sizes = [56, 58, 60, 62, 64]
    letter_sizes = ["S", "M", "L", "XL", "2XL"]
    seasons = ["summer", "autumn", "winter"]

    first_product = None

    for p_code, p_name, p_style, p_desc in styles_data:
        p_res = await session.execute(select(Product).where(Product.code == p_code))
        prod_obj = p_res.scalar_one_or_none()
        if not prod_obj:
            prod_obj = Product(id=str(uuid.uuid4()), code=p_code, name_ar=p_name, style_type=p_style, description=p_desc)
            session.add(prod_obj)
            await session.flush()

            # إنشاء المتغيرات للمنتج
            for i, num_size in enumerate(numeric_sizes):
                let_size = letter_sizes[i % len(letter_sizes)]
                for season in seasons:
                    sku = f"{p_code}-{num_size}-{let_size}-{season[:3].upper()}"
                    variant = ProductVariant(
                        id=str(uuid.uuid4()),
                        product_id=prod_obj.id,
                        numeric_size=num_size,
                        letter_size=let_size,
                        season=season,
                        sku=sku,
                    )
                    session.add(variant)

        if first_product is None:
            first_product = prod_obj

    await session.flush()

    # 6. تهيئة قالب إنتاج قياسي مع كمية مرجعية
    if first_product:
        t_res = await session.execute(select(ProductionTemplate).where(ProductionTemplate.code == "TMP-GLB-58"))
        tmpl = t_res.scalar_one_or_none()
        if not tmpl:
            tmpl = ProductionTemplate(
                id=str(uuid.uuid4()),
                code="TMP-GLB-58",
                name_ar="قالب جلابية كفتة مقاس 58 المرجعي",
                product_id=first_product.id,
            )
            session.add(tmpl)
            await session.flush()

            tmpl_ver = ProductionTemplateVersion(
                id=str(uuid.uuid4()),
                template_id=tmpl.id,
                version_number=1,
                status="approved",
                reference_quantity=100.0,
                notes="قالب مرجعي معتمد لـ 100 جلابية",
            )
            session.add(tmpl_ver)
            await session.flush()

            # بنود القالب:
            # لـ 100 جلابية: 280 متر قماش، 600 زرار، 200 كبسولة، 5 بكرات خيط، 1 باترون (أداة)، 100 كرتونة
            lines_spec = [
                ("FAB-COTTON-01", 280.0, "meter", "2.8 متر للقطعة الواحدة"),
                ("ACC-BUTTON-01", 600.0, "piece", "6 أزرار لكل جلابية"),
                ("ACC-SNAP-01", 200.0, "piece", "كبسولتان للكفتة"),
                ("ACC-THREAD-01", 5.0, "roll", "بكرات خياطة وتشطيب"),
                ("TOOL-PATTERN-58", 1.0, "piece", "باترون التشغيل (أداة يعاد استخدامها)"),
                ("PKG-BOX-01", 100.0, "piece", "كرتونة تغليف لكل قطعة"),
            ]
            for it_code, qty, u_code, line_notes in lines_spec:
                if it_code in items_map:
                    session.add(
                        ProductionTemplateLine(
                            id=str(uuid.uuid4()),
                            version_id=tmpl_ver.id,
                            item_id=items_map[it_code].id,
                            unit_id=units_map[u_code].id,
                            quantity_per_reference=qty,
                            notes=line_notes,
                        )
                    )

    await session.commit()


SEASON_NAMES_AR = {
    "summer": "صيفي",
    "winter": "شتوي",
    "autumn": "خريفي",
    "spring": "ربيعي",
}


async def get_or_create_finished_goods_item(
    db: AsyncSession,
    product_id: str,
    variant_id: str,
) -> CatalogItem:
    """
    Centralized canonical finished goods item resolver:
    Resolves or creates the canonical CatalogItem for Product + ProductVariant.
    Canonical code: FG-VAR-{variant_id}
    Description: منتج تام - {model_name} (مقاس {size} - {season})
    """
    variant = await db.get(ProductVariant, variant_id)
    if not variant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="متغير المنتج المطلوب غير موجود في النظام.",
        )
    if variant.product_id != product_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="متغير المنتج المحدد لا ينتمي إلى هذا الموديل.",
        )

    product = await db.get(Product, product_id)
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="موديل المنتج المطلوب غير موجود في النظام.",
        )

    canonical_code = f"FG-VAR-{variant_id}"

    # Query existing CatalogItem
    stmt = (
        select(CatalogItem)
        .where(
            CatalogItem.item_type == "finished_garment",
            CatalogItem.code == canonical_code,
        )
    )
    existing_item = (await db.execute(stmt)).scalar_one_or_none()
    if existing_item:
        return existing_item

    # Resolve Unit for finished goods (piece/unit)
    piece_unit = (await db.execute(select(Unit).where(Unit.code.in_(("piece", "unit"))))).scalar_one_or_none()
    if not piece_unit:
        piece_unit = (await db.execute(select(Unit))).scalars().first()
    if not piece_unit:
        piece_unit = Unit(id=str(uuid.uuid4()), code="piece", name_ar="قطعة")
        db.add(piece_unit)
        await db.flush()

    season_ar = SEASON_NAMES_AR.get(variant.season.lower(), variant.season)
    size_label = str(variant.numeric_size) if variant.numeric_size else variant.letter_size
    item_name_ar = f"منتج تام - {product.name_ar} (مقاس {size_label} - {season_ar})"

    new_item = CatalogItem(
        id=str(uuid.uuid4()),
        code=canonical_code,
        name_ar=item_name_ar,
        item_type="finished_garment",
        unit_id=piece_unit.id,
        is_consumable=False,
        is_active=True,
        classification_status="not_applicable",
        category_id=None,
        attributes={},
        reorder_level=Decimal("0"),
        approval_status="approved",
        approved_at=datetime.now(timezone.utc),
        approved_by="system_production_auto",
    )
    db.add(new_item)
    await db.flush()
    return new_item


