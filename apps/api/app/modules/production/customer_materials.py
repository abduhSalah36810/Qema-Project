"""خدمات خامات العملاء وتتبع الاستهلاك والتكاليف لأوامر التصنيع للغير (Phase 6).

MFG-DEC-01: نمطا التصنيع (داخلي وخارجي للغير).
MFG-DEC-02: سندات استلام خامات العملاء وتتبع أرصدتها وإرجاعها بأمانة وفصلها عن أصول المصنع.
MFG-DEC-03: التمييز بين الخامات الموردة من العميل والمستلزمات من المصنع والمعالجة التجارية.
MFG-DEC-04: احتساب تكلفة العمالة (بالقطعة أو بالزمن/الساعات).
MFG-DEC-05: نسبة الهالك المعتمدة (1.5%) وحساب كمية وقيمة انحراف الهالك الزائد دون غرامة تلقائية.
MFG-DEC-06: التوزيع الاختياري للتكاليف الصناعية غير المباشرة وتقرير الربحية المقارن.
"""
import uuid
from decimal import Decimal
from datetime import datetime, date, timezone
from typing import Optional, List, Tuple
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from fastapi import HTTPException

from app.modules.production.models import (
    ProductionOrder,
    ProductionOrderMaterial,
    CustomerMaterialReceipt,
    CustomerMaterialReceiptLine,
    CustomerMaterialReturn,
    CatalogItem,
    Unit,
    Warehouse,
    StockLedgerEntry,
    Product,
    ProductVariant,
    ProductionOrderDemand,
)
from app.modules.production.stock import stock_balance, customer_deposit_bucket
from app.modules.production.service import lock_stock_balance
from app.modules.customers.models import Customer
from app.modules.production.schemas import (
    CustomerMaterialReceiptCreate,
    CustomerMaterialReturnCreate,
    OrderMaterialConsumptionLogRequest,
    OrderCostCalculationRequest,
    CustomerMaterialBalanceItem,
    JobCostSheetRead,
    JobCostSheetMaterialLine,
    JobCostSheetLaborDetail,
    JobCostSheetOverheadDetail,
    JobCostSheetWasteAnalysis,
    ManufacturingProfitabilityReportRead,
    ManufacturingProfitabilityItem,
    WASTE_SETTLEMENT_STATUS_AR,
)

ORDER_STATUS_AR = {
    "draft": "مسودة جديدة",
    "materials_dispatched": "خامات بالطريق",
    "in_production": "قيد الإنتاج",
    "manufacturing_completed": "اكتمل التصنيع الميداني",
    "receipt_completed": "تم استلام المنتج التام",
    "completed": "مكتملة التجهيز",
    "closed": "مغلق ومسوى نهائياً",
    "cancelled": "ملغي",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _generate_doc_number(prefix: str) -> str:
    now = _utc_now()
    return f"{prefix}-{now.year}-{now.strftime('%m%d')}-{uuid.uuid4().hex[:6].upper()}"


# ═════════════════════════════════════════════════════════════════════════════
# 1. سندات استلام خامات العملاء (Customer Material Receipts - MFG-DEC-02)
# ═════════════════════════════════════════════════════════════════════════════

async def create_customer_material_receipt(
    db: AsyncSession,
    data: CustomerMaterialReceiptCreate,
    received_by: str,
) -> CustomerMaterialReceipt:
    """تسجيل سند استلام خامات عميل أمانة في المخزن دون إدراجها كأصل أو مشتريات للمصنع."""
    customer = await db.get(Customer, data.customer_id)
    if not customer or customer.status != "active":
        raise HTTPException(status_code=404, detail="العميل غير موجود أو موقوف.")

    raw_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    if not raw_wh:
        raise HTTPException(status_code=503, detail="بيانات المخازن التشغيلية غير مكتملة.")

    receipt = CustomerMaterialReceipt(
        id=str(uuid.uuid4()),
        receipt_number=_generate_doc_number("CMR"),
        customer_id=customer.id,
        received_date=data.received_date or _utc_now(),
        received_by=received_by,
        status="received",
        notes=data.notes.strip(),
        created_at=_utc_now(),
    )
    db.add(receipt)

    for line_data in data.lines:
        item = await db.get(CatalogItem, line_data.item_id)
        if not item or not item.is_active:
            raise HTTPException(status_code=422, detail=f"الصنف {line_data.item_id} غير موجود أو موقوف في الدليل.")
        unit = await db.get(Unit, line_data.unit_id)
        if not unit:
            raise HTTPException(status_code=422, detail=f"وحدة القياس {line_data.unit_id} غير موجودة.")

        # إذا حُدد أمر تشغيل للسطر نتحقق من صحته
        if line_data.order_id:
            order = await db.get(ProductionOrder, line_data.order_id)
            if not order:
                raise HTTPException(status_code=404, detail="أمر التشغيل المرتبط غير موجود.")

        receipt_line = CustomerMaterialReceiptLine(
            id=str(uuid.uuid4()),
            receipt_id=receipt.id,
            item_id=item.id,
            unit_id=unit.id,
            quantity_received=line_data.quantity_received,
            quantity_consumed=Decimal("0.000"),
            quantity_wasted=Decimal("0.000"),
            quantity_returned=Decimal("0.000"),
            order_id=line_data.order_id,
            unit_cost_estimate=line_data.unit_cost_estimate or Decimal("0.0000"),
            notes=line_data.notes.strip(),
        )
        db.add(receipt_line)

        # قيد حركة مخزنية في مخزن الخامات بحاوية أمانة العميل (MFG-DEC-02)
        # تكلفة مالية صفرية لعدم إدراجها ضمن أصول المصنع الدفترية
        db.add(
            StockLedgerEntry(
                id=str(uuid.uuid4()),
                item_id=item.id,
                unit_id=unit.id,
                warehouse_id=raw_wh.id,
                location_type="warehouse",
                bucket_reference=customer_deposit_bucket(customer.id),
                quantity=float(line_data.quantity_received),
                unit_cost=Decimal("0.0000"),
                total_cost=Decimal("0.00"),
                entry_type="customer_deposit",
                reference_doc_type="customer_material_receipt",
                reference_doc_id=receipt.id,
                created_by=received_by,
            )
        )

    await db.commit()
    await db.refresh(receipt)
    return receipt


async def list_customer_material_receipts(
    db: AsyncSession,
    customer_id: Optional[str] = None,
) -> List[CustomerMaterialReceipt]:
    """استعراض سندات استلام خامات العملاء مع بنودها وأرصدتها."""
    stmt = (
        select(CustomerMaterialReceipt)
        .options(
            selectinload(CustomerMaterialReceipt.customer),
            selectinload(CustomerMaterialReceipt.lines).selectinload(CustomerMaterialReceiptLine.item),
            selectinload(CustomerMaterialReceipt.lines).selectinload(CustomerMaterialReceiptLine.unit),
        )
        .order_by(CustomerMaterialReceipt.created_at.desc())
    )
    if customer_id:
        stmt = stmt.where(CustomerMaterialReceipt.customer_id == customer_id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_customer_material_balances(
    db: AsyncSession,
    customer_id: Optional[str] = None,
) -> List[CustomerMaterialBalanceItem]:
    """تقرير أرصدة خامات العملاء المتاحة والمستهلكة والمرتجعة (MFF-DEC-02)."""
    stmt = (
        select(CustomerMaterialReceiptLine)
        .join(CustomerMaterialReceipt, CustomerMaterialReceipt.id == CustomerMaterialReceiptLine.receipt_id)
        .join(Customer, Customer.id == CustomerMaterialReceipt.customer_id)
        .join(CatalogItem, CatalogItem.id == CustomerMaterialReceiptLine.item_id)
        .join(Unit, Unit.id == CustomerMaterialReceiptLine.unit_id)
        .options(
            selectinload(CustomerMaterialReceiptLine.receipt).selectinload(CustomerMaterialReceipt.customer),
            selectinload(CustomerMaterialReceiptLine.item),
            selectinload(CustomerMaterialReceiptLine.unit),
        )
    )
    if customer_id:
        stmt = stmt.where(CustomerMaterialReceipt.customer_id == customer_id)

    result = await db.execute(stmt)
    lines = result.scalars().all()

    # تجميع حسب العميل والصنف
    grouped: dict[Tuple[str, str], dict] = {}
    for l in lines:
        c_id = l.receipt.customer_id
        c_name = l.receipt.customer.name
        it_id = l.item_id
        key = (c_id, it_id)
        if key not in grouped:
            grouped[key] = {
                "customer_id": c_id,
                "customer_name": c_name,
                "item_id": it_id,
                "item_code": l.item.code if l.item else "",
                "item_name_ar": l.item.name_ar if l.item else "",
                "unit_name": l.unit.name_ar if l.unit else "",
                "total_received": Decimal("0.000"),
                "total_consumed": Decimal("0.000"),
                "total_wasted": Decimal("0.000"),
                "total_returned": Decimal("0.000"),
                "active_receipt_lines_count": 0,
            }
        grouped[key]["total_received"] += l.quantity_received
        grouped[key]["total_consumed"] += l.quantity_consumed
        grouped[key]["total_wasted"] += l.quantity_wasted
        grouped[key]["total_returned"] += l.quantity_returned
        if l.quantity_remaining > Decimal("0.000"):
            grouped[key]["active_receipt_lines_count"] += 1

    balances: List[CustomerMaterialBalanceItem] = []
    for g in grouped.values():
        current_bal = g["total_received"] - (g["total_consumed"] + g["total_wasted"] + g["total_returned"])
        balances.append(
            CustomerMaterialBalanceItem(
                customer_id=g["customer_id"],
                customer_name=g["customer_name"],
                item_id=g["item_id"],
                item_code=g["item_code"],
                item_name_ar=g["item_name_ar"],
                unit_name=g["unit_name"],
                total_received=g["total_received"],
                total_consumed=g["total_consumed"],
                total_wasted=g["total_wasted"],
                total_returned=g["total_returned"],
                current_balance=current_bal,
                active_receipt_lines_count=g["active_receipt_lines_count"],
            )
        )
    return balances


async def create_customer_material_return(
    db: AsyncSession,
    data: CustomerMaterialReturnCreate,
    returned_by: str,
) -> CustomerMaterialReturn:
    """تسجيل سند إرجاع خامات متبقية للعميل وتحديث الرصيد المتبقي (MFG-DEC-02)."""
    line = await db.get(CustomerMaterialReceiptLine, data.receipt_line_id)
    if not line:
        raise HTTPException(status_code=404, detail="سطر استلام الخامة غير موجود.")

    # تحميل السند الأصلي للتأكد من هوية العميل
    receipt = await db.get(CustomerMaterialReceipt, line.receipt_id)
    if not receipt or receipt.customer_id != data.customer_id:
        raise HTTPException(status_code=400, detail="سطر الاستلام لا يخص هذا العميل.")

    remaining = line.quantity_remaining
    if data.quantity > remaining:
        raise HTTPException(
            status_code=422,
            detail=f"الكمية المراد إرجاعها ({data.quantity}) تتجاوز الرصيد المتبقي بسطر الاستلام ({remaining}).",
        )

    raw_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    if not raw_wh:
        raise HTTPException(status_code=503, detail="بيانات المخازن التشغيلية غير مكتملة.")

    # قفل رصيد الصنف بمخزن الخامات لمنع التضارب
    await lock_stock_balance(db, line.item_id, raw_wh.id)

    # التحقق من الرصيد المتوفر فعلياً في مخزن الخامات بحاوية أمانة العميل
    avail_wh = await stock_balance(
        db,
        item_id=line.item_id,
        warehouse_id=raw_wh.id,
        bucket_reference=customer_deposit_bucket(data.customer_id),
    )
    if float(data.quantity) > avail_wh + 1e-9:
        raise HTTPException(
            status_code=409,
            detail=f"الكمية المراد إرجاعها ({data.quantity:g}) تتجاوز الرصيد الفعلي المتوفر بمخزن الخامات ({avail_wh:g}). قد تكون هناك كميات مسحوبة للتشغيل لم تُرد بعد.",
        )

    ret = CustomerMaterialReturn(
        id=str(uuid.uuid4()),
        return_number=_generate_doc_number("CRET"),
        customer_id=data.customer_id,
        receipt_line_id=line.id,
        quantity=data.quantity,
        returned_date=_utc_now(),
        returned_by=returned_by,
        notes=data.notes.strip(),
        created_at=_utc_now(),
    )
    db.add(ret)

    # قيد حركة مخزنية سالبة في مخزن الخامات بحاوية أمانة العميل (MFG-DEC-02)
    db.add(
        StockLedgerEntry(
            id=str(uuid.uuid4()),
            item_id=line.item_id,
            unit_id=line.unit_id,
            warehouse_id=raw_wh.id,
            location_type="warehouse",
            bucket_reference=customer_deposit_bucket(data.customer_id),
            quantity=-float(data.quantity),
            unit_cost=Decimal("0.0000"),
            total_cost=Decimal("0.00"),
            entry_type="customer_return",
            reference_doc_type="customer_material_return",
            reference_doc_id=ret.id,
            created_by=returned_by,
        )
    )

    # تحديث كمية المرتجع بسطر الاستلام
    line.quantity_returned = (line.quantity_returned or Decimal("0.000")) + data.quantity

    # تحديث حالة السند عند تصفير الرصيد
    if line.quantity_remaining <= Decimal("0.000"):
        receipt.status = "returned" if line.quantity_consumed == Decimal("0.000") else "fully_consumed"

    await db.commit()
    await db.refresh(ret)
    return ret


# ═════════════════════════════════════════════════════════════════════════════
# 2. تسجيل الاستهلاك الفعلي وانحراف الهالك (MFG-DEC-05)
# ═════════════════════════════════════════════════════════════════════════════

async def log_order_material_consumption(
    db: AsyncSession,
    order_id: str,
    data: OrderMaterialConsumptionLogRequest,
    actor_id: str,
) -> ProductionOrder:
    """
    تسجيل الاستهلاك الفعلي والهالك والمرتجع لخامات أمر التشغيل.
    - يتحقق من سقف الهالك المعتمد (1.5% لخامات التصنيع للغير).
    - يحسب الكمية الزائدة عن المسموح وقيمتها التقديرية بدقة.
    - لا يولد قيود مطالبات مالية تلقائية طبقاً لقرار المالك (توثيق للمراجعة).
    """
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
        )
        .where(ProductionOrder.id == order_id)
    )
    res = await db.execute(stmt)
    order = res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    mat_by_id = {m.id: m for m in order.materials}

    for item_data in data.items:
        m = mat_by_id.get(item_data.material_line_id)
        if not m:
            raise HTTPException(status_code=404, detail=f"بند خامة غير موجود في الأمر: {item_data.material_line_id}")

        m.actual_consumed_quantity = (m.actual_consumed_quantity or Decimal("0.000")) + item_data.consumed_quantity
        m.actual_waste_quantity = (m.actual_waste_quantity or Decimal("0.000")) + item_data.waste_quantity
        m.actual_returned_quantity = (m.actual_returned_quantity or Decimal("0.000")) + item_data.returned_quantity

        # إذا كانت الخامة ملك العميل، نخصم من سطر استلام العميل المقابل
        if m.supplied_by == "customer" and order.customer_id:
            # البحث عن سطر استلام خامة عميل نشط يطابق الصنف
            c_line_stmt = (
                select(CustomerMaterialReceiptLine)
                .join(CustomerMaterialReceipt, CustomerMaterialReceipt.id == CustomerMaterialReceiptLine.receipt_id)
                .where(
                    CustomerMaterialReceipt.customer_id == order.customer_id,
                    CustomerMaterialReceiptLine.item_id == m.item_id,
                )
            )
            c_lines = (await db.execute(c_line_stmt)).scalars().all()
            qty_to_consume = item_data.consumed_quantity
            qty_to_waste = item_data.waste_quantity
            qty_to_return = item_data.returned_quantity
            for cl in c_lines:
                avail = cl.quantity_remaining
                if avail > Decimal("0.000") and (qty_to_consume > 0 or qty_to_waste > 0 or qty_to_return > 0):
                    take_c = min(avail, qty_to_consume)
                    cl.quantity_consumed += take_c
                    qty_to_consume -= take_c

                    avail_w = cl.quantity_remaining
                    take_w = min(avail_w, qty_to_waste)
                    cl.quantity_wasted += take_w
                    qty_to_waste -= take_w

                    avail_r = cl.quantity_remaining
                    take_r = min(avail_r, qty_to_return)
                    cl.quantity_returned += take_r
                    qty_to_return -= take_r

    # احتساب إحصاءات وانحراف الهالك على مستوى الأمر (MFG-DEC-05)
    total_consumed = sum(m.actual_consumed_quantity for m in order.materials)
    total_waste = sum(m.actual_waste_quantity for m in order.materials)

    allowed_pct = order.allowed_waste_pct or Decimal("1.50")
    allowed_waste_qty = (total_consumed * (allowed_pct / Decimal("100"))).quantize(Decimal("0.001"))

    if total_consumed > Decimal("0.000"):
        order.actual_waste_pct = ((total_waste / total_consumed) * Decimal("100")).quantize(Decimal("0.01"))
    else:
        order.actual_waste_pct = Decimal("0.00")

    if total_waste > allowed_waste_qty:
        excess_qty = (total_waste - allowed_waste_qty).quantize(Decimal("0.001"))
        order.excess_waste_qty = excess_qty
        # تقدير تكلفة الهالك الزائد: متوسط تكلفة الخامة
        avg_unit_cost = Decimal("0.0000")
        priced_mats = [m for m in order.materials if (m.unit_cost or Decimal("0")) > 0]
        if priced_mats:
            avg_unit_cost = sum(m.unit_cost for m in priced_mats) / Decimal(len(priced_mats))
        order.excess_waste_cost = (excess_qty * avg_unit_cost).quantize(Decimal("0.01"))
    else:
        order.excess_waste_qty = Decimal("0.000")
        order.excess_waste_cost = Decimal("0.00")

    await db.commit()
    await db.refresh(order)
    return order


# ═════════════════════════════════════════════════════════════════════════════
# 3. احتساب تكلفة العمالة وتوزيع التكاليف غير المباشرة (MFG-DEC-04 & 06)
# ═════════════════════════════════════════════════════════════════════════════

async def calculate_order_costs(
    db: AsyncSession,
    order_id: str,
    params: OrderCostCalculationRequest,
    actor_id: str = "system",
) -> ProductionOrder:
    """
    احتساب تكلفة العمالة المباشرة وتوزيع المصروفات غير المباشرة وتحديث تكلفة الأمر.
    - MFG-DEC-04: دعم طريقتي الأجور (بالقطعة أو بالساعة).
    - MFG-DEC-06: توزيع اختياري للتكاليف الإدارية والتشغيلية دون إنشاء قيود محاسبية مكررة.
    """
    stmt = (
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id)
    )
    res = await db.execute(stmt)
    order = res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    # تحديث إعدادات التكلفة إذا أُرسلت في الطلب
    if params.labor_costing_method:
        order.labor_costing_method = params.labor_costing_method
    if params.labor_rate is not None:
        order.labor_rate = params.labor_rate
    if params.labor_hours is not None:
        order.labor_hours = params.labor_hours
    if params.overhead_allocation_basis is not None:
        order.overhead_allocation_basis = params.overhead_allocation_basis
    if params.allocated_overhead_rate is not None:
        order.allocated_overhead_rate = params.allocated_overhead_rate
    if params.agreed_service_price is not None:
        order.agreed_service_price = params.agreed_service_price

    order.cost_calculated_at = _utc_now()
    order.cost_calculated_by = actor_id

    target_q = Decimal(str(order.target_quantity or 0))

    # 1. احتساب تكلفة العمالة المباشرة (MFG-DEC-04)
    if order.labor_costing_method == "piece_based":
        order.actual_labor_cost = (target_q * (order.labor_rate or Decimal("0.00"))).quantize(Decimal("0.01"))
    elif order.labor_costing_method == "time_based":
        order.actual_labor_cost = ((order.labor_hours or Decimal("0.00")) * (order.labor_rate or Decimal("0.00"))).quantize(Decimal("0.01"))

    # 2. احتساب التكاليف غير المباشرة الموزعة (MFG-DEC-06)
    if order.overhead_allocation_basis == "produced_pieces":
        order.actual_overhead_cost = (target_q * (order.allocated_overhead_rate or Decimal("0.00"))).quantize(Decimal("0.01"))
    elif order.overhead_allocation_basis == "labor_hours":
        order.actual_overhead_cost = ((order.labor_hours or Decimal("0.00")) * (order.allocated_overhead_rate or Decimal("0.00"))).quantize(Decimal("0.01"))
    else:
        order.actual_overhead_cost = Decimal("0.00")

    # 3. تكلفة الخامات:
    # في التصنيع للغير (external): خامات العميل لا تدخل في تكلفة المصنع الدفترية؛ فقط المستلزمات الموردة من المصنع.
    if order.manufacturing_type == "external":
        factory_mats_cost = sum(
            (m.total_cost or Decimal("0.00") for m in order.materials if getattr(m, "supplied_by", "factory") == "factory"),
            Decimal("0.00"),
        )
        order.actual_material_cost = factory_mats_cost.quantize(Decimal("0.01"))
    # (في التصنيع الداخلي تبقى actual_material_cost كما سُجلت من أذون الصرف)

    # 4. إجمالي التكلفة وتكلفة القطعة
    order.total_actual_cost = (
        (order.actual_material_cost or Decimal("0.00"))
        + (order.actual_labor_cost or Decimal("0.00"))
        + (order.actual_overhead_cost or Decimal("0.00"))
    ).quantize(Decimal("0.01"))

    if target_q > Decimal("0.00"):
        order.unit_manufacturing_cost = (order.total_actual_cost / target_q).quantize(Decimal("0.0001"))

    await db.commit()
    await db.refresh(order)
    return order


# ═════════════════════════════════════════════════════════════════════════════
# 4. بطاقة تكلفة أمر التشغيل والربحية وتسوية الهالك (Job Cost Sheet - T6)
# ═════════════════════════════════════════════════════════════════════════════

async def get_job_cost_sheet(
    db: AsyncSession,
    order_id: str,
    can_view_prices: bool = True,
) -> JobCostSheetRead:
    """
    استخراج بطاقة تكلفة تفصيلية موثقة لأمر التشغيل (Job Cost Sheet):
    - فصل كامل بين خامات المصنع وخامات العميل المعزولة (تكلفة صفرية دفترياً).
    - تفاصيل أجور العمالة وتوزيع التكاليف الصناعية غير المباشرة.
    - تحليل الهالك مقارنة بسقف 1.5% المعتمد وحالة التسوية.
    - احتساب الإيراد المتوقع وهامش المساهمة / الربح الإجمالي.
    - حجب الأسعار والقيم المالية للأدوار غير المخولة (أمين المخزن).
    """
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.product),
            selectinload(ProductionOrder.variant),
            selectinload(ProductionOrder.customer),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
            selectinload(ProductionOrder.demands).selectinload(ProductionOrderDemand.customer_order_line),
            selectinload(ProductionOrder.customer_order_line),
        )
        .where(ProductionOrder.id == order_id)
    )
    res = await db.execute(stmt)
    order = res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    # جلب تقديرات تكلفة خامات العميل من أسطر الاستلام إن وُجدت
    cust_est_costs: dict[str, Decimal] = {}
    if order.customer_id:
        c_lines_stmt = (
            select(CustomerMaterialReceiptLine)
            .join(CustomerMaterialReceipt, CustomerMaterialReceipt.id == CustomerMaterialReceiptLine.receipt_id)
            .where(CustomerMaterialReceipt.customer_id == order.customer_id)
        )
        for cl in (await db.execute(c_lines_stmt)).scalars().all():
            if cl.item_id not in cust_est_costs or (cl.unit_cost_estimate or Decimal("0")) > cust_est_costs[cl.item_id]:
                cust_est_costs[cl.item_id] = cl.unit_cost_estimate or Decimal("0.0000")

    factory_materials: List[JobCostSheetMaterialLine] = []
    customer_materials: List[JobCostSheetMaterialLine] = []

    cust_consumed_total = 0.0
    cust_wasted_total = 0.0
    cust_returned_total = 0.0

    for m in order.materials:
        is_customer = (getattr(m, "supplied_by", "factory") == "customer")
        item_code = m.item.code if m.item else ""
        item_name = m.item.name_ar if m.item else (m.item_name_snapshot or "")
        unit_name = m.unit.name_ar if m.unit else ""

        c_consumed = float(m.actual_consumed_quantity or 0.0)
        c_waste = float(m.actual_waste_quantity or 0.0)
        c_returned = float(m.actual_returned_quantity or 0.0)

        if is_customer:
            cust_consumed_total += c_consumed
            cust_wasted_total += c_waste
            cust_returned_total += c_returned
            est_cost = cust_est_costs.get(m.item_id, Decimal("0.0000")) if can_view_prices else Decimal("0.0000")
            customer_materials.append(
                JobCostSheetMaterialLine(
                    item_id=m.item_id,
                    item_code=item_code,
                    item_name_ar=item_name,
                    unit_name_ar=unit_name,
                    ownership="customer",
                    commercial_treatment=getattr(m, "commercial_treatment", "included_in_service_fee") or "included_in_service_fee",
                    planned_quantity=float(m.planned_quantity or 0.0),
                    dispatched_quantity=float(m.dispatched_quantity or 0.0),
                    received_quantity=float(m.received_quantity or 0.0),
                    actual_consumed_quantity=c_consumed,
                    actual_waste_quantity=c_waste,
                    actual_returned_quantity=c_returned,
                    unit_cost=Decimal("0.0000"),
                    total_cost=Decimal("0.00"),
                    unit_cost_estimate=est_cost,
                )
            )
        else:
            u_cost = (m.unit_cost or Decimal("0.0000")) if can_view_prices else Decimal("0.0000")
            t_cost = (m.total_cost or Decimal("0.00")) if can_view_prices else Decimal("0.00")
            factory_materials.append(
                JobCostSheetMaterialLine(
                    item_id=m.item_id,
                    item_code=item_code,
                    item_name_ar=item_name,
                    unit_name_ar=unit_name,
                    ownership="factory",
                    commercial_treatment=getattr(m, "commercial_treatment", "included_in_service_fee") or "included_in_service_fee",
                    planned_quantity=float(m.planned_quantity or 0.0),
                    dispatched_quantity=float(m.dispatched_quantity or 0.0),
                    received_quantity=float(m.received_quantity or 0.0),
                    actual_consumed_quantity=c_consumed,
                    actual_waste_quantity=c_waste,
                    actual_returned_quantity=c_returned,
                    unit_cost=u_cost,
                    total_cost=t_cost,
                    unit_cost_estimate=Decimal("0.0000"),
                )
            )

    # 2. تفاصيل أجور العمالة
    l_method = getattr(order, "labor_costing_method", "piece_based") or "piece_based"
    l_method_label = "بالقطعة المنتجة" if l_method == "piece_based" else "بساعات العمل الفعلية"
    l_rate = (order.labor_rate or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    l_basis = float(order.target_quantity or 0.0) if l_method == "piece_based" else float(order.labor_hours or 0.0)
    l_cost = (order.actual_labor_cost or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    labor_detail = JobCostSheetLaborDetail(
        method=l_method,
        method_label_ar=l_method_label,
        rate=l_rate,
        quantity_basis=l_basis,
        total_cost=l_cost,
    )

    # 3. التكاليف غير المباشرة
    oh_basis = order.overhead_allocation_basis
    oh_basis_label = "حسب القطع المنتجة" if oh_basis == "produced_pieces" else ("حسب ساعات العمل" if oh_basis == "labor_hours" else "بدون تحميل")
    oh_rate = (order.allocated_overhead_rate or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    oh_q = float(order.target_quantity or 0.0) if oh_basis == "produced_pieces" else (float(order.labor_hours or 0.0) if oh_basis == "labor_hours" else 0.0)
    oh_cost = (order.actual_overhead_cost or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    overhead_detail = JobCostSheetOverheadDetail(
        basis=oh_basis,
        basis_label_ar=oh_basis_label,
        rate=oh_rate,
        base_quantity=oh_q,
        total_cost=oh_cost,
    )

    # 4. تحليل الهالك
    allowed_pct = order.allowed_waste_pct or Decimal("1.50")
    total_c = sum((Decimal(str(m.actual_consumed_quantity or 0)) for m in order.materials), Decimal("0.000"))
    total_w = sum((Decimal(str(m.actual_waste_quantity or 0)) for m in order.materials), Decimal("0.000"))
    allowed_w_qty = (total_c * (allowed_pct / Decimal("100"))).quantize(Decimal("0.001"))
    act_w_pct = ((total_w / total_c) * Decimal("100")).quantize(Decimal("0.01")) if total_c > Decimal("0.000") else Decimal("0.00")
    ex_qty = order.excess_waste_qty or Decimal("0.000")
    ex_cost = (order.excess_waste_cost or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    settlement_st = order.excess_waste_settlement_status or "pending_review"
    waste_analysis = JobCostSheetWasteAnalysis(
        allowed_waste_pct=allowed_pct,
        allowed_waste_qty=allowed_w_qty,
        actual_waste_qty=total_w.quantize(Decimal("0.001")),
        actual_waste_pct=act_w_pct,
        excess_waste_qty=ex_qty,
        excess_waste_cost=ex_cost,
        is_excess=ex_qty > Decimal("0.000"),
        settlement_status=settlement_st,
        settlement_status_ar=WASTE_SETTLEMENT_STATUS_AR.get(settlement_st, settlement_st),
    )

    # 5. مجاميع التكلفة
    fac_mat_cost = (order.actual_material_cost or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    tot_fac_cost = (order.total_actual_cost or Decimal("0.00")) if can_view_prices else Decimal("0.00")
    unit_fac_cost = (order.unit_manufacturing_cost or Decimal("0.0000")) if can_view_prices else Decimal("0.0000")

    # 6. الإيرادات والربحية
    target_q_dec = Decimal(str(order.target_quantity or 0))
    service_price = order.agreed_service_price or Decimal("0.00")
    if service_price == Decimal("0.00") and order.customer_order_line and order.customer_order_line.unit_price:
        service_price = Decimal(str(order.customer_order_line.unit_price))
    if service_price == Decimal("0.00") and order.demands:
        for d in order.demands:
            if d.customer_order_line and d.customer_order_line.unit_price:
                service_price = Decimal(str(d.customer_order_line.unit_price))
                break

    exp_rev = (target_q_dec * service_price).quantize(Decimal("0.01")) if can_view_prices else Decimal("0.00")
    gross_margin = (exp_rev - tot_fac_cost).quantize(Decimal("0.01")) if can_view_prices and exp_rev > Decimal("0.00") else Decimal("0.00")
    gross_margin_pct = ((gross_margin / exp_rev) * Decimal("100")).quantize(Decimal("0.01")) if can_view_prices and exp_rev > Decimal("0.00") else Decimal("0.00")

    mfg_type = getattr(order, "manufacturing_type", "internal") or "internal"
    mfg_type_label = "تصنيع داخلي" if mfg_type == "internal" else "تشغيل للغير (CMT)"
    status_label = ORDER_STATUS_AR.get(order.status, order.status)

    return JobCostSheetRead(
        order_id=order.id,
        order_number=order.order_number,
        manufacturing_type=mfg_type,
        manufacturing_type_label_ar=mfg_type_label,
        status=order.status,
        status_label_ar=status_label,
        customer_id=order.customer_id,
        customer_name=order.customer.name if order.customer else None,
        product_name_ar=order.product.name_ar if order.product else "",
        product_code=order.product.code if order.product else "",
        target_quantity=float(order.target_quantity or 0.0),
        completed_quantity=float(order.target_quantity or 0.0) if order.status in ("completed", "closed", "receipt_completed") else 0.0,
        factory_materials_cost=fac_mat_cost,
        direct_labor_cost=l_cost,
        allocated_overhead_cost=oh_cost,
        total_factory_manufacturing_cost=tot_fac_cost,
        unit_factory_cost=unit_fac_cost,
        agreed_service_price=service_price if can_view_prices else Decimal("0.00"),
        expected_revenue=exp_rev,
        gross_margin_amount=gross_margin,
        gross_margin_pct=gross_margin_pct,
        customer_materials_count=len(customer_materials),
        customer_materials_total_consumed=cust_consumed_total,
        customer_materials_total_wasted=cust_wasted_total,
        customer_materials_total_returned=cust_returned_total,
        factory_materials=factory_materials,
        customer_materials=customer_materials,
        labor_detail=labor_detail,
        overhead_detail=overhead_detail,
        waste_analysis=waste_analysis,
        calculated_at=order.cost_calculated_at,
        calculated_by=order.cost_calculated_by,
    )


async def update_waste_settlement(
    db: AsyncSession,
    order_id: str,
    decision: str,
    notes: str,
    actor_id: str,
) -> ProductionOrder:
    """تسجيل قرار مراجعة وتسوية الهالك الزائد لأمر التشغيل دون فرض غرامات تلقائية."""
    order = await db.get(ProductionOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    if decision not in ("approved_by_factory", "claimed_from_customer", "waived"):
        raise HTTPException(status_code=422, detail="قرار تسوية الهالك غير صالح.")

    order.excess_waste_settlement_status = decision
    if notes:
        order.notes = f"{order.notes or ''}\n[تسوية الهالك {decision} بواسطة {actor_id}]: {notes}".strip()

    await db.commit()
    await db.refresh(order)
    return order


async def get_manufacturing_profitability_report(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    manufacturing_type: Optional[str] = None,
    customer_id: Optional[str] = None,
) -> ManufacturingProfitabilityReportRead:
    """تقرير مقارنة ربحية التصنيع الداخلي والتشغيل للغير (CMT) وتكلفة الخدمة."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.product),
            selectinload(ProductionOrder.customer),
            selectinload(ProductionOrder.materials),
            selectinload(ProductionOrder.demands).selectinload(ProductionOrderDemand.customer_order_line),
            selectinload(ProductionOrder.customer_order_line),
        )
        .where(ProductionOrder.status != "cancelled")
    )
    if date_from:
        stmt = stmt.where(func.date(ProductionOrder.created_at) >= date_from)
    if date_to:
        stmt = stmt.where(func.date(ProductionOrder.created_at) <= date_to)
    if manufacturing_type:
        stmt = stmt.where(ProductionOrder.manufacturing_type == manufacturing_type)
    if customer_id:
        stmt = stmt.where(ProductionOrder.customer_id == customer_id)

    stmt = stmt.order_by(ProductionOrder.created_at.desc())
    orders = (await db.execute(stmt)).scalars().all()

    items: List[ManufacturingProfitabilityItem] = []
    tot_fac_cost = Decimal("0.00")
    tot_rev = Decimal("0.00")
    tot_profit = Decimal("0.00")

    int_cost = Decimal("0.00")
    int_rev = Decimal("0.00")
    int_count = 0

    ext_cost = Decimal("0.00")
    ext_rev = Decimal("0.00")
    ext_count = 0

    for o in orders:
        m_type = getattr(o, "manufacturing_type", "internal") or "internal"
        t_qty = Decimal(str(o.target_quantity or 0))

        price = o.agreed_service_price or Decimal("0.00")
        if price == Decimal("0.00") and o.customer_order_line and o.customer_order_line.unit_price:
            price = Decimal(str(o.customer_order_line.unit_price))
        if price == Decimal("0.00") and o.demands:
            for d in o.demands:
                if d.customer_order_line and d.customer_order_line.unit_price:
                    price = Decimal(str(d.customer_order_line.unit_price))
                    break

        rev = (t_qty * price).quantize(Decimal("0.01"))
        cost = (o.total_actual_cost or Decimal("0.00")).quantize(Decimal("0.01"))
        profit = (rev - cost).quantize(Decimal("0.01")) if rev > Decimal("0.00") else -cost
        margin = ((profit / rev) * Decimal("100")).quantize(Decimal("0.01")) if rev > Decimal("0.00") else Decimal("0.00")

        if m_type == "internal":
            int_count += 1
            int_cost += cost
            int_rev += rev
        else:
            ext_count += 1
            ext_cost += cost
            ext_rev += rev

        tot_fac_cost += cost
        tot_rev += rev
        tot_profit += profit

        items.append(
            ManufacturingProfitabilityItem(
                order_id=o.id,
                order_number=o.order_number,
                manufacturing_type=m_type,
                customer_name=o.customer.name if o.customer else None,
                product_name=o.product.name_ar if o.product else "",
                target_quantity=float(o.target_quantity or 0.0),
                status=o.status,
                status_label_ar=ORDER_STATUS_AR.get(o.status, o.status),
                factory_material_cost=o.actual_material_cost or Decimal("0.00"),
                labor_cost=o.actual_labor_cost or Decimal("0.00"),
                overhead_cost=o.actual_overhead_cost or Decimal("0.00"),
                total_cost=cost,
                unit_cost=o.unit_manufacturing_cost or Decimal("0.0000"),
                revenue=rev,
                gross_profit=profit,
                margin_pct=margin,
                waste_pct=o.actual_waste_pct or Decimal("0.00"),
                excess_waste_qty=o.excess_waste_qty or Decimal("0.000"),
            )
        )

    int_profit = int_rev - int_cost
    int_margin = ((int_profit / int_rev) * Decimal("100")).quantize(Decimal("0.01")) if int_rev > Decimal("0.00") else Decimal("0.00")

    ext_profit = ext_rev - ext_cost
    ext_margin = ((ext_profit / ext_rev) * Decimal("100")).quantize(Decimal("0.01")) if ext_rev > Decimal("0.00") else Decimal("0.00")

    overall_margin = ((tot_profit / tot_rev) * Decimal("100")).quantize(Decimal("0.01")) if tot_rev > Decimal("0.00") else Decimal("0.00")

    return ManufacturingProfitabilityReportRead(
        total_orders_count=len(orders),
        internal_orders_count=int_count,
        external_orders_count=ext_count,
        total_factory_cost=tot_fac_cost,
        total_revenue=tot_rev,
        total_gross_profit=tot_profit,
        overall_margin_pct=overall_margin,
        internal_summary={
            "orders_count": int_count,
            "total_cost": int_cost,
            "total_revenue": int_rev,
            "gross_profit": int_profit,
            "margin_pct": int_margin,
        },
        external_summary={
            "orders_count": ext_count,
            "total_service_cost": ext_cost,
            "total_service_revenue": ext_rev,
            "gross_profit": ext_profit,
            "margin_pct": ext_margin,
        },
        orders=items,
    )

