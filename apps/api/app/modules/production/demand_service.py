"""
خدمات تجميع طلبات العملاء وتخطيط الاحتياجات (Demand Aggregation & Planning Service - Phase 4)
─────────────────────────────────────────────────────────────────────────────
تتضمن:
1. استعلام مجمع الطلبات غير المخططة القابلة للتجميع (Demand Pool).
2. معاينة تجميع طلبات متعددة لنفس الموديل والمقاس، وحساب نسب العملاء وصافي احتياج الخامات والرصيد المتاح.
3. إنشاء أمر تشغيل مجمع يربط كافة سطور الطلبات بسجلات التخصيص (ProductionOrderDemand).
4. استعلام تفاصيل تخصيصات أمر التشغيل ومتابعة نسبة الإنجاز لكل عميل.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.customers.models import Customer, CustomerOrder, CustomerOrderLine
from app.modules.production.bom import active_bom_version, variant_label
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderItemMaterial,
    ProductionOrderDemand,
    ProductionOrderMaterial,
    ProductionTemplate,
    ProductionTemplateVersion,
    Unit,
    Warehouse,
    utc_now,
)
from app.modules.production.schemas import (
    DemandAllocationItem,
    DemandCustomerShareItem,
    DemandMaterialRequirementItem,
    DemandMaterialsPreviewResponse,
    DemandPoolItemRead,
    OrderAggregateCreate,
    ProductionOrderDemandRead,
    OrderCreate,
    ProductionOrderItemCreate,
)
from app.modules.production.service import (
    create_production_order,
)
from app.modules.production.stock import stock_balance


async def _get_planned_quantities(
    session: AsyncSession,
    line_ids: Optional[List[str]] = None,
) -> dict[str, float]:
    """حساب إجمالي الكميات المخططة في أوامر تشغيل غير ملغاة لكل سطر طلب عميل مباشرة من قاعدة البيانات."""
    # 1. أوامر التشغيل المجمعة / الحديثة عبر ProductionOrderDemand
    demands_stmt = (
        select(
            ProductionOrderDemand.customer_order_line_id,
            func.coalesce(func.sum(ProductionOrderDemand.allocated_quantity), 0.0),
        )
        .join(ProductionOrder, ProductionOrderDemand.production_order_id == ProductionOrder.id)
        .where(ProductionOrder.status != "cancelled")
    )
    if line_ids:
        demands_stmt = demands_stmt.where(ProductionOrderDemand.customer_order_line_id.in_(line_ids))
    demands_stmt = demands_stmt.group_by(ProductionOrderDemand.customer_order_line_id)
    demands_rows = (await session.execute(demands_stmt)).all()
    result = {row[0]: float(row[1]) for row in demands_rows}

    # 2. أوامر التشغيل الفردية القديمة عبر customer_order_line_id المباشر
    legacy_stmt = (
        select(
            ProductionOrder.customer_order_line_id,
            func.coalesce(func.sum(ProductionOrder.target_quantity), 0.0),
        )
        .where(
            ProductionOrder.customer_order_line_id.is_not(None),
            ProductionOrder.status != "cancelled",
        )
    )
    if line_ids:
        legacy_stmt = legacy_stmt.where(ProductionOrder.customer_order_line_id.in_(line_ids))
    legacy_stmt = legacy_stmt.group_by(ProductionOrder.customer_order_line_id)
    legacy_rows = (await session.execute(legacy_stmt)).all()

    for line_id, legacy_qty in legacy_rows:
        result[line_id] = round(result.get(line_id, 0.0) + float(legacy_qty), 4)

    return result


async def get_demand_pool(
    session: AsyncSession,
    *,
    product_id: Optional[str] = None,
    variant_id: Optional[str] = None,
    customer_id: Optional[str] = None,
) -> List[DemandPoolItemRead]:
    """
    استعراض بنود طلبات العملاء المفتوحة التي تملك كميات متبقية غير مخططة في أوامر تشغيل.
    تُجمع بحسب الموديل والمقاس للمفاضلة والتجميع في أوامر إنتاج موحدة.
    """
    stmt = (
        select(CustomerOrderLine)
        .join(CustomerOrder, CustomerOrderLine.order_id == CustomerOrder.id)
        .join(Customer, CustomerOrder.customer_id == Customer.id)
        .join(Product, CustomerOrderLine.product_id == Product.id)
        .join(ProductVariant, CustomerOrderLine.variant_id == ProductVariant.id)
        .options(
            selectinload(CustomerOrderLine.order).selectinload(CustomerOrder.customer),
            selectinload(CustomerOrderLine.product),
            selectinload(CustomerOrderLine.variant),
        )
        .where(
            CustomerOrder.status.in_(["open", "partially_delivered"]),
            CustomerOrder.is_opening.is_(False),
        )
        .order_by(CustomerOrder.order_date.asc(), CustomerOrder.order_number.asc())
    )

    if product_id:
        stmt = stmt.where(CustomerOrderLine.product_id == product_id)
    if variant_id:
        stmt = stmt.where(CustomerOrderLine.variant_id == variant_id)
    if customer_id:
        stmt = stmt.where(CustomerOrder.customer_id == customer_id)

    lines = (await session.execute(stmt)).scalars().all()
    planned_map = await _get_planned_quantities(session, line_ids=[l.id for l in lines] if lines else None)

    pool_items: List[DemandPoolItemRead] = []
    for line in lines:
        ordered_qty = float(line.quantity)
        planned_qty = planned_map.get(line.id, 0.0)
        unplanned_qty = max(0.0, round(ordered_qty - planned_qty, 4))

        if unplanned_qty <= 0.0001:
            continue  # تم تخطيط كامل كمية هذا البند

        v = line.variant
        variant_lbl = variant_label(v) if v else ""

        pool_items.append(
            DemandPoolItemRead(
                customer_order_line_id=line.id,
                customer_order_id=line.order.id,
                customer_order_number=line.order.order_number,
                customer_id=line.order.customer.id,
                customer_name=line.order.customer.name,
                product_id=line.product_id,
                product_name=line.product.name_ar,
                variant_id=line.variant_id,
                numeric_size=v.numeric_size if v else None,
                letter_size=v.letter_size if v else None,
                season=v.season if v else "summer",
                variant_label=variant_lbl,
                ordered_quantity=ordered_qty,
                planned_quantity=planned_qty,
                unplanned_quantity=unplanned_qty,
                order_date=line.order.order_date,
                expected_delivery_at=line.order.expected_delivery_at,
            )
        )

    return pool_items


async def preview_demand_aggregation(
    session: AsyncSession,
    allocations: List[DemandAllocationItem],
) -> DemandMaterialsPreviewResponse:
    """
    معاينة تجميع مجموعة من بنود طلبات العملاء:
    - التحقق من تطابق الموديل والمقاس لكافة البنود.
    - التحقق من عدم تجاوز الكمية المتبقية لكل بند.
    - احتساب الحصص والنسب المئوية لكل عميل.
    - احتساب صافي احتياج الخامات ومقارنته بالرصيد المتاح بالمخزن الرئيسي.
    """
    if not allocations:
        raise HTTPException(status_code=422, detail="يجب تحديد بند طلب عميل واحد على الأقل.")

    line_ids = [item.customer_order_line_id for item in allocations]
    stmt = (
        select(CustomerOrderLine)
        .options(
            selectinload(CustomerOrderLine.order).selectinload(CustomerOrder.customer),
            selectinload(CustomerOrderLine.product),
            selectinload(CustomerOrderLine.variant),
            selectinload(CustomerOrderLine.demands).selectinload(ProductionOrderDemand.production_order),
            selectinload(CustomerOrderLine.production_orders),
        )
        .where(CustomerOrderLine.id.in_(line_ids))
    )
    lines = (await session.execute(stmt)).scalars().all()
    lines_by_id = {line.id: line for line in lines}

    if len(lines_by_id) != len(allocations):
        raise HTTPException(status_code=404, detail="أحد بنود الطلبات المحددة غير موجود.")

    # التحقق من تطابق الموديل والمقاس لجميع البنود المجمعة
    product_ids = {line.product_id for line in lines}
    variant_ids = {line.variant_id for line in lines}
    if len(product_ids) > 1 or len(variant_ids) > 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="تجميع الطلبات يتطلب تطابق الموديل والمقاس لكافة بنود الطلبات المختارة في أمر تشغيل موحد.",
        )

    first_line = lines[0]
    product = first_line.product
    variant = first_line.variant

    total_target_quantity = 0.0
    customer_shares: List[DemandCustomerShareItem] = []
    planned_map = await _get_planned_quantities(session, line_ids=line_ids)

    # التحقق من الكميات وحساب الحصص
    for alloc in allocations:
        line = lines_by_id[alloc.customer_order_line_id]
        ordered_qty = float(line.quantity)
        planned = planned_map.get(line.id, 0.0)
        unplanned = max(0.0, round(ordered_qty - planned, 4))

        if alloc.allocated_quantity > unplanned + 1e-4:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"الكمية المخصصة ({alloc.allocated_quantity:g}) للطلب {line.order.order_number} تتجاوز الكمية المتبقية غير المخططة ({unplanned:g}).",
            )

        total_target_quantity += alloc.allocated_quantity

    total_target_quantity = round(total_target_quantity, 4)
    if total_target_quantity <= 0:
        raise HTTPException(status_code=422, detail="إجمالي كمية أمر التشغيل المجمع يجب أن تكون أكبر من الصفر.")

    for alloc in allocations:
        line = lines_by_id[alloc.customer_order_line_id]
        pct = round((alloc.allocated_quantity / total_target_quantity) * 100, 2)
        customer_shares.append(
            DemandCustomerShareItem(
                customer_id=line.order.customer.id,
                customer_name=line.order.customer.name,
                customer_order_id=line.order.id,
                customer_order_number=line.order.order_number,
                customer_order_line_id=line.id,
                allocated_quantity=alloc.allocated_quantity,
                percentage=pct,
            )
        )

    # استرجاع BOM النشط للمقاس
    bom_version = await active_bom_version(session, variant.id)
    if not bom_version or not bom_version.lines:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"قائمة مستلزمات التصنيع (BOM) غير معرّفة أو غير نشطة لمقاس ({variant_label(variant)}).",
        )

    # احتساب صافي احتياج الخامات ومقارنتها بالرصيد المتاح بمخزن الخامات الرئيسي
    raw_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    if not raw_wh:
        raise HTTPException(status_code=503, detail="مخزن الخامات الرئيسي غير مهيأ.")

    materials: List[DemandMaterialRequirementItem] = []
    all_available = True
    ref_qty = float(bom_version.reference_quantity or 100.0)

    for bom_line in bom_version.lines:
        item = bom_line.item
        unit = bom_line.unit
        qty_per_piece = float(bom_line.quantity_per_reference) / ref_qty
        required = round(total_target_quantity * qty_per_piece, 4)

        # الرصيد المتاح العام للمصنع بمخزن الخامات
        available = await stock_balance(session, item.id, raw_wh.id, bucket_reference=None)
        shortage = max(0.0, round(required - available, 4))
        is_sufficient = available >= required
        if not is_sufficient:
            all_available = False

        materials.append(
            DemandMaterialRequirementItem(
                item_id=item.id,
                item_code=item.code,
                item_name_ar=item.name_ar,
                unit_id=unit.id,
                unit_name_ar=unit.name_ar,
                quantity_per_piece=round(qty_per_piece, 6),
                required_quantity=required,
                available_quantity=available,
                shortage_quantity=shortage,
                is_sufficient=is_sufficient,
            )
        )

    return DemandMaterialsPreviewResponse(
        product_id=product.id,
        product_name=product.name_ar,
        variant_id=variant.id,
        variant_label=variant_label(variant),
        total_target_quantity=total_target_quantity,
        template_version_id=bom_version.id,
        customer_shares=customer_shares,
        materials=materials,
        all_materials_available=all_available,
    )


async def create_aggregated_production_order(
    session: AsyncSession,
    data: OrderAggregateCreate,
    creator_id: str,
) -> ProductionOrder:
    """
    إنشاء أمر تشغيل موحد مجمع من عدة طلبات عملاء متوافقة (Phase 4):
    - قفل سطور الطلبات لمنع التسابق.
    - التحقق من توافق الموديل والمقاس.
    - إنشاء أمر التشغيل بالكمية الإجمالية وحساب الخامات مجمعة.
    - حفظ سجلات التخصيص (ProductionOrderDemand) لكل عميل.
    """
    if not data.items:
        raise HTTPException(status_code=422, detail="يجب تحديد بند طلب عميل واحد على الأقل.")

    line_ids = [item.customer_order_line_id for item in data.items]
    stmt = (
        select(CustomerOrderLine)
        .options(
            selectinload(CustomerOrderLine.order).selectinload(CustomerOrder.customer),
            selectinload(CustomerOrderLine.product),
            selectinload(CustomerOrderLine.variant),
            selectinload(CustomerOrderLine.demands).selectinload(ProductionOrderDemand.production_order),
            selectinload(CustomerOrderLine.production_orders),
        )
        .where(CustomerOrderLine.id.in_(line_ids))
        .with_for_update()
    )
    lines = (await session.execute(stmt)).scalars().all()
    lines_by_id = {line.id: line for line in lines}

    if len(lines_by_id) != len(data.items):
        raise HTTPException(status_code=404, detail="أحد بنود الطلبات المحددة غير موجود.")

    # التحقق من تطابق الموديل والمقاس
    product_ids = {line.product_id for line in lines}
    variant_ids = {line.variant_id for line in lines}
    if len(product_ids) > 1 or len(variant_ids) > 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="تجميع الطلبات يتطلب تطابق الموديل والمقاس لكافة بنود الطلبات المختارة.",
        )

    first_line = lines[0]
    product = first_line.product
    variant = first_line.variant

    total_target_quantity = 0.0
    planned_map = await _get_planned_quantities(session, line_ids=line_ids)
    for item in data.items:
        line = lines_by_id[item.customer_order_line_id]
        ordered_qty = float(line.quantity)
        planned = planned_map.get(line.id, 0.0)
        unplanned = max(0.0, round(ordered_qty - planned, 4))

        if item.allocated_quantity > unplanned + 1e-4:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"الكمية المخصصة ({item.allocated_quantity:g}) للطلب {line.order.order_number} تتجاوز الكمية المتبقية غير المخططة ({unplanned:g}).",
            )
        total_target_quantity += item.allocated_quantity

    total_target_quantity = round(total_target_quantity, 4)
    if total_target_quantity <= 0:
        raise HTTPException(status_code=422, detail="إجمالي كمية أمر التشغيل المجمع يجب أن تكون أكبر من الصفر.")

    # استرجاع BOM النشط إن لم يحدد قالب صريح
    template_version_id = data.template_version_id
    if not template_version_id:
        bom_version = await active_bom_version(session, variant.id)
        if not bom_version:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"قائمة مستلزمات التصنيع (BOM) غير معرّفة لمقاس ({variant_label(variant)}).",
            )
        template_version_id = bom_version.id

    season = data.season or variant.season or "summer"

    # إنشاء أمر التشغيل الأساسي بالكمية المجمعة
    order_create_payload = OrderCreate(
        items=[
            ProductionOrderItemCreate(
                product_id=product.id,
                variant_id=variant.id,
                target_quantity=total_target_quantity,
                season=season,
                template_version_id=template_version_id,
                product_type="factory_brand",
                customer_id=None,
                notes=data.notes or "أمر تشغيل مجمع لطلبات عملاء متعددة",
            )
        ],
        assigned_to=data.assigned_to or "",
        notes=data.notes or f"أمر تشغيل مجمع ({len(data.items)} طلبات عملاء)",
    )

    order = await create_production_order(
        session,
        order_create_payload,
        creator_id=creator_id,
        customer_order_line_id=None,  # متعدد الطلبات عبر demands
    )

    # إنشاء سطور التخصيص لكل عميل
    for item in data.items:
        line = lines_by_id[item.customer_order_line_id]
        demand = ProductionOrderDemand(
            id=str(uuid.uuid4()),
            production_order_id=order.id,
            customer_order_line_id=line.id,
            customer_order_id=line.order.id,
            customer_id=line.order.customer.id,
            product_id=product.id,
            variant_id=variant.id,
            allocated_quantity=item.allocated_quantity,
            fulfilled_quantity=0.0,
            notes=data.notes or "",
            created_by=creator_id,
            created_at=utc_now(),
        )
        session.add(demand)

    await session.commit()
    await session.refresh(order)
    return order


async def get_order_demands(
    session: AsyncSession,
    order_id: str,
) -> List[ProductionOrderDemandRead]:
    """استعراض تفاصيل تخصيصات طلبات العملاء لأمر التشغيل."""
    stmt = (
        select(ProductionOrderDemand)
        .options(
            selectinload(ProductionOrderDemand.customer),
            selectinload(ProductionOrderDemand.customer_order),
        )
        .where(ProductionOrderDemand.production_order_id == order_id)
        .order_by(ProductionOrderDemand.created_at.asc())
    )
    demands = (await session.execute(stmt)).scalars().all()

    reads: List[ProductionOrderDemandRead] = []
    for d in demands:
        rem = max(0.0, round(d.allocated_quantity - d.fulfilled_quantity, 4))
        pct = round((d.fulfilled_quantity / d.allocated_quantity) * 100, 2) if d.allocated_quantity > 0 else 0.0
        reads.append(
            ProductionOrderDemandRead(
                id=d.id,
                production_order_id=d.production_order_id,
                customer_order_line_id=d.customer_order_line_id,
                customer_order_id=d.customer_order_id,
                customer_order_number=d.customer_order.order_number if d.customer_order else "",
                customer_id=d.customer_id,
                customer_name=d.customer.name if d.customer else "",
                product_id=d.product_id,
                variant_id=d.variant_id,
                allocated_quantity=d.allocated_quantity,
                fulfilled_quantity=d.fulfilled_quantity,
                remaining_quantity=rem,
                fulfillment_pct=pct,
                notes=d.notes,
                created_at=d.created_at,
            )
        )
    return reads
