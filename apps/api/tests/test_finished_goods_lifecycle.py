"""
اختبارات دورة حياة المنتجات التامة والمرتجعات (Finished Goods Lifecycle & Returns Tests)
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. التكويد المعياري الموحد لصنف المنتج التام (Canonical Finished Goods Identity):
   FG-VAR-{variant_id} وربط الموديل بالمتغير ومطابقة الانتماء.
2. استلام الإنتاج التام (Production Completion Stock Receipt):
   إضافة قيد موجب في دفتر أستاذ المخزون StockLedgerEntry بمخزن التام ومنع التجاوز.
3. حظر الرصيد السالب بشكل صارم (Strict No-Negative-Stock):
   فحص الرصيد الفعلي المتاح قبل التسليم ورفض أي تسليم يتجاوز الرصيد (HTTP 409).
4. دورة مرتجعات العملاء المستقلة (Customer Delivery Returns):
   إنشاء مستند مرتجع مع قيد عكسي موجب، وحجز البضاعة في bucket فحص المرتجع،
   ومنع تجاوز الكميات المسلمة، وتفعيل مفتاح منع التكرار (Idempotency Key).
5. عزل بضاعة المرتجع عن البيع المباشر (Returned Stock Segregation):
   التأكد من أن البضاعة المرتجعة تحت الفحص لا تدخل ضمن رصيد التسليمات الجديدة.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.core.auth import AuthenticatedUser
from app.modules.customers.models import (
    Customer,
    CustomerDelivery,
    CustomerDeliveryLine,
    CustomerDeliveryReturn,
    CustomerDeliveryReturnLine,
    CustomerOrder,
    CustomerOrderLine,
)
from app.modules.customers.schemas import (
    CustomerDeliveryCreate,
    CustomerDeliveryLineCreate,
    CustomerDeliveryReturnCreate,
    CustomerDeliveryReturnLineCreate,
)
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.schemas import FinishedGoodsReceiptCreate
from app.modules.production.service import get_or_create_finished_goods_item
from app.api.v1.endpoints.production import receive_finished_goods
from app.api.v1.endpoints.customers import (
    record_customer_delivery,
    record_customer_delivery_return,
)


@pytest.fixture
def mock_user():
    return AuthenticatedUser(
        id="usr-test-officer",
        email="officer@qemma.com",
        claims={"sub": "usr-test-officer", "role": "warehouse_manager"},
    )


@pytest.fixture
def base_entities():
    product = Product(id="prod-100", code="PRD-GEL-01", name_ar="جلابية رجالي فاخرة")
    variant = ProductVariant(
        id="var-200",
        product_id="prod-100",
        numeric_size=58,
        letter_size=None,
        season="summer",
    )
    unit = Unit(id="unit-piece-1", code="piece", name_ar="قطعة")
    fg_warehouse = Warehouse(
        id="wh-fg-1",
        code="finished_goods",
        name_ar="مخزن المنتجات التامة",
        is_active=True,
    )
    return product, variant, unit, fg_warehouse


# ─── 1. اختبارات التكويد المعياري الموحد (Canonical Identity Resolver) ───────

@pytest.mark.asyncio
async def test_canonical_resolver_creates_fg_var_item(base_entities):
    """التحقق من إنشاء صنف منتج تام بالمعيار المعتمد FG-VAR-{variant_id} وتسمية عربية دقيقة."""
    product, variant, unit, _ = base_entities
    session = AsyncMock()

    async def mock_get(model, pk):
        if model is ProductVariant and pk == "var-200":
            return variant
        if model is Product and pk == "prod-100":
            return product
        return None

    session.get.side_effect = mock_get

    # البحث عن الصنف القائم يرجع None
    exec_result_item = MagicMock()
    exec_result_item.scalar_one_or_none.return_value = None

    # البحث عن وحدة القياس يرجع unit
    exec_result_unit = MagicMock()
    exec_result_unit.scalar_one_or_none.return_value = unit

    session.execute.side_effect = [exec_result_item, exec_result_unit]
    session.add = MagicMock()
    session.flush = AsyncMock()

    item = await get_or_create_finished_goods_item(session, "prod-100", "var-200")

    assert isinstance(item, CatalogItem)
    assert item.code == "FG-VAR-var-200"
    assert item.item_type == "finished_garment"
    assert item.name_ar == "منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)"
    assert item.unit_id == "unit-piece-1"
    session.add.assert_called_once()
    session.flush.assert_awaited_once()


@pytest.mark.asyncio
async def test_canonical_resolver_returns_existing_item_without_duplicates(base_entities):
    """التحقق من إعادة استخدام الصنف القائم بنفس الكود دون إضافة سجلات مكررة."""
    product, variant, unit, _ = base_entities
    existing = CatalogItem(
        id="item-existing-1",
        code="FG-VAR-var-200",
        name_ar="منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)",
        item_type="finished_garment",
        unit_id="unit-piece-1",
    )
    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [variant, product]

    exec_result = MagicMock()
    exec_result.scalar_one_or_none.return_value = existing
    session.execute.return_value = exec_result
    session.add = MagicMock()

    item = await get_or_create_finished_goods_item(session, "prod-100", "var-200")

    assert item.id == "item-existing-1"
    assert item.code == "FG-VAR-var-200"
    session.add.assert_not_called()


@pytest.mark.asyncio
async def test_canonical_resolver_rejects_variant_belonging_to_another_product(base_entities):
    """رفض ربط متغير بموديل مختلف بحالة 400 Bad Request."""
    product, variant, _, _ = base_entities
    foreign_variant = ProductVariant(
        id="var-other",
        product_id="prod-foreign",
        numeric_size=54,
        season="winter",
    )
    session = AsyncMock()
    session.get.return_value = foreign_variant

    with pytest.raises(HTTPException) as exc_info:
        await get_or_create_finished_goods_item(session, "prod-100", "var-other")

    assert exc_info.value.status_code == 400
    assert "لا ينتمي إلى هذا الموديل" in exc_info.value.detail


@pytest.mark.asyncio
async def test_canonical_resolver_rejects_nonexistent_entities():
    """التحقق من رفع 404 عند عدم وجود المتغير أو الموديل."""
    session = AsyncMock()
    session.get.return_value = None

    with pytest.raises(HTTPException) as exc_info:
        await get_or_create_finished_goods_item(session, "prod-missing", "var-missing")
    assert exc_info.value.status_code == 404


# ─── 2. اختبارات استلام الإنتاج التام (Production Completion) ─────────────────

@pytest.mark.asyncio
async def test_production_completion_posts_stock_ledger_entry(base_entities, mock_user):
    """استلام المنتجات التامة بعد انتهاء الإنتاج يُنشئ قيد StockLedgerEntry موجب بكود FG-VAR."""
    product, variant, unit, fg_wh = base_entities
    catalog_item = CatalogItem(
        id="fg-item-1",
        code="FG-VAR-var-200",
        name_ar="منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)",
        item_type="finished_garment",
        unit_id=unit.id,
    )
    order = ProductionOrder(
        id="order-p1",
        order_number="PO-2026-001",
        product_id="prod-100",
        variant_id="var-200",
        target_quantity=50.0,
        status="in_production",
        order_items=[],
        stage_events=[],
    )

    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [variant, product]

    # order select
    exec_order = MagicMock()
    exec_order.scalar_one_or_none.return_value = order
    # warehouse select
    exec_wh = MagicMock()
    exec_wh.scalar_one_or_none.return_value = fg_wh
    # existing item query inside resolver
    exec_item = MagicMock()
    exec_item.scalar_one_or_none.return_value = catalog_item

    session.execute.side_effect = [exec_order, exec_wh, exec_item]
    session.scalar.return_value = 0.0  # already received
    session.add = MagicMock()
    session.commit = AsyncMock()

    data = FinishedGoodsReceiptCreate(
        received_quantity=50.0,
        accepted_quantity=50.0,
        notes="استلام تام من خط الكي والتعبئة",
    )
    response = await receive_finished_goods("order-p1", data, mock_user, session)

    assert response.order_id == "order-p1"
    assert response.received_quantity == 50.0
    assert response.receipt_status == "complete"
    assert order.status == "receipt_completed"

    # التحقق من القيد الدفتري المضاف
    added_entry = None
    for call_arg in session.add.call_args_list:
        obj = call_arg[0][0]
        if isinstance(obj, StockLedgerEntry):
            added_entry = obj
            break

    assert added_entry is not None
    assert added_entry.item_id == "fg-item-1"
    assert added_entry.warehouse_id == fg_wh.id
    assert added_entry.quantity == 50.0
    assert added_entry.entry_type == "finished_goods_receipt"
    assert added_entry.reference_doc_type == "production_order_finished_receipt"
    assert added_entry.reference_doc_id == "order-p1"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_production_completion_rejects_exceeding_target_quantity(base_entities, mock_user):
    """رفض استلام كمية تتجاوز الكمية المستهدفة لأمر التشغيل (HTTP 409 Conflict)."""
    _, _, _, fg_wh = base_entities
    order = ProductionOrder(
        id="order-p1",
        order_number="PO-2026-001",
        product_id="prod-100",
        variant_id="var-200",
        target_quantity=50.0,
        status="in_production",
    )

    session = AsyncMock()
    exec_order = MagicMock()
    exec_order.scalar_one_or_none.return_value = order
    exec_wh = MagicMock()
    exec_wh.scalar_one_or_none.return_value = fg_wh

    session.execute.side_effect = [exec_order, exec_wh]
    session.scalar.return_value = 40.0  # مستلم سابقاً 40 من 50

    data = FinishedGoodsReceiptCreate(received_quantity=15.0, accepted_quantity=15.0)  # المجموع 55 يتجاوز 50
    with pytest.raises(HTTPException) as exc_info:
        await receive_finished_goods("order-p1", data, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "تتجاوز الكمية المستهدفة" in exc_info.value.detail


@pytest.mark.asyncio
async def test_production_completion_rejects_duplicate_when_fully_received(base_entities, mock_user):
    """رفض أي استلام إضافي إذا كان الأمر قد استلم بالكامل مسبقاً (HTTP 409 Conflict)."""
    _, _, _, fg_wh = base_entities
    order = ProductionOrder(
        id="order-p1",
        order_number="PO-2026-001",
        product_id="prod-100",
        variant_id="var-200",
        target_quantity=50.0,
        status="completed",
    )

    session = AsyncMock()
    exec_order = MagicMock()
    exec_order.scalar_one_or_none.return_value = order
    exec_wh = MagicMock()
    exec_wh.scalar_one_or_none.return_value = fg_wh

    session.execute.side_effect = [exec_order, exec_wh]
    session.scalar.return_value = 50.0  # مستلم بالكامل

    data = FinishedGoodsReceiptCreate(received_quantity=5.0, accepted_quantity=5.0)
    with pytest.raises(HTTPException) as exc_info:
        await receive_finished_goods("order-p1", data, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "تم استلام كامل كمية أمر التشغيل مسبقاً" in exc_info.value.detail


# ─── 3. اختبارات حظر الرصيد السالب والتسليم (Strict No-Negative-Stock) ─────────

@pytest.mark.asyncio
async def test_customer_delivery_records_deduction_when_stock_available(base_entities, mock_user):
    """تسليم العميل يخصم الرصيد بقيد سالب في StockLedgerEntry عند كفاية الرصيد الفعلي."""
    product, variant, unit, fg_wh = base_entities
    catalog_item = CatalogItem(
        id="fg-item-1",
        code="FG-VAR-var-200",
        name_ar="منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)",
        item_type="finished_garment",
        unit_id=unit.id,
    )
    order_line = CustomerOrderLine(
        id="oline-1",
        product_id="prod-100",
        variant_id="var-200",
        product=product,
        variant=variant,
        quantity=Decimal("10"),
    )
    order = CustomerOrder(
        id="corder-1",
        customer_id="cust-1",
        order_number="CO-2026-001",
        order_type="factory_product",
        status="open",
        lines=[order_line],
    )

    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [variant, product]

    # _load_order result
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    # delivered_so_far query
    exec_delivered_res = MagicMock()
    exec_delivered_res.all.return_value = []
    # item query inside resolver
    exec_item_res = MagicMock()
    exec_item_res.scalar_one_or_none.return_value = catalog_item

    session.execute.side_effect = [exec_load_order, exec_delivered_res, exec_item_res]
    # scalar side_effects: fg_wh, catalog_item row lock, available_stock (25.0 pieces)
    session.scalar.side_effect = [fg_wh, catalog_item.id, 25.0]
    session.add = MagicMock()
    session.commit = AsyncMock()

    data = CustomerDeliveryCreate(
        received_by="مندوب المستلم",
        notes="تسليم دفعة أولى",
        lines=[CustomerDeliveryLineCreate(order_line_id="oline-1", quantity=Decimal("10"))],
    )

    response = await record_customer_delivery("cust-1", "corder-1", data, mock_user, session)

    assert response.received_by == "مندوب المستلم"
    assert len(response.lines) == 1
    assert response.lines[0].quantity == 10.0

    # التحقق من قيد الخصم السالب
    stock_deduction_entry = None
    for call_arg in session.add.call_args_list:
        obj = call_arg[0][0]
        if isinstance(obj, StockLedgerEntry):
            stock_deduction_entry = obj
            break

    assert stock_deduction_entry is not None
    assert stock_deduction_entry.item_id == "fg-item-1"
    assert stock_deduction_entry.quantity == -10.0
    assert stock_deduction_entry.entry_type == "customer_delivery_dispatch"
    assert stock_deduction_entry.bucket_reference == "factory_brand"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_customer_delivery_strict_no_negative_stock_blocks_insufficient(base_entities, mock_user):
    """حظر الرصيد السالب بشكل صارم: رفض التسليم مع 409 Conflict عند نقص الرصيد الفعلي."""
    product, variant, unit, fg_wh = base_entities
    catalog_item = CatalogItem(
        id="fg-item-1",
        code="FG-VAR-var-200",
        name_ar="منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)",
        item_type="finished_garment",
        unit_id=unit.id,
    )
    order_line = CustomerOrderLine(
        id="oline-1",
        product_id="prod-100",
        variant_id="var-200",
        product=product,
        variant=variant,
        quantity=Decimal("20"),
    )
    order = CustomerOrder(
        id="corder-1",
        customer_id="cust-1",
        order_number="CO-2026-001",
        order_type="factory_product",
        status="open",
        lines=[order_line],
    )

    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [variant, product]

    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    exec_delivered_res = MagicMock()
    exec_delivered_res.all.return_value = []
    exec_item_res = MagicMock()
    exec_item_res.scalar_one_or_none.return_value = catalog_item

    session.execute.side_effect = [exec_load_order, exec_delivered_res, exec_item_res]
    # scalar: fg_wh, catalog_item row lock, available_stock (فقط 5 قطع متاحة بينما المطلوب 20)
    session.scalar.side_effect = [fg_wh, catalog_item.id, 5.0]

    data = CustomerDeliveryCreate(
        received_by="المستلم",
        lines=[CustomerDeliveryLineCreate(order_line_id="oline-1", quantity=Decimal("20"))],
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery("cust-1", "corder-1", data, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "لا يكفي لتسليم الكمية المطلوبة" in exc_info.value.detail
    session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_customer_delivery_rejects_exceeding_order_quantity(base_entities, mock_user):
    """رفض تسليم كمية تتجاوز الكمية المتبقية في بنود الطلب (HTTP 409 Conflict)."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(
        id="oline-1",
        product_id="prod-100",
        variant_id="var-200",
        quantity=Decimal("10"),
    )
    order = CustomerOrder(
        id="corder-1",
        customer_id="cust-1",
        lines=[order_line],
    )

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    exec_delivered = MagicMock()
    exec_delivered.all.return_value = [("oline-1", Decimal("8"))]  # تم تسليم 8 مسبقاً، المتبقي 2 فقط

    session.execute.side_effect = [exec_load_order, exec_delivered]

    data = CustomerDeliveryCreate(
        received_by="المستلم",
        lines=[CustomerDeliveryLineCreate(order_line_id="oline-1", quantity=Decimal("5"))],  # مطلوب 5 > 2
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery("cust-1", "corder-1", data, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "تتجاوز الكمية المتبقية في الطلب" in exc_info.value.detail


# ─── 4. اختبارات دورة مرتجعات التسليم (Customer Delivery Returns) ────────────

@pytest.mark.asyncio
async def test_customer_delivery_return_creates_segregated_stock_entry(base_entities, mock_user):
    """تسجيل المرتجع يُنشئ قيداً موجباً بالدفتر مع عزله في bucket فحص المرتجع."""
    product, variant, unit, fg_wh = base_entities
    catalog_item = CatalogItem(
        id="fg-item-1",
        code="FG-VAR-var-200",
        name_ar="منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)",
        item_type="finished_garment",
        unit_id=unit.id,
    )
    order_line = CustomerOrderLine(
        id="oline-1",
        product_id="prod-100",
        variant_id="var-200",
        product=product,
        variant=variant,
        quantity=Decimal("10"),
    )
    del_line = CustomerDeliveryLine(
        id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("10"),
    )
    delivery = CustomerDelivery(
        id="del-1",
        order_id="corder-1",
        delivery_number="DL-2026-001",
        lines=[del_line],
        returns=[],
    )
    order = CustomerOrder(
        id="corder-1",
        customer_id="cust-1",
        order_number="CO-2026-001",
        status="delivered",
        lines=[order_line],
    )

    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [variant, product]

    # _load_order
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    # prior_returns
    exec_prior_returns = MagicMock()
    exec_prior_returns.all.return_value = []
    # resolver catalog_item
    exec_item = MagicMock()
    exec_item.scalar_one_or_none.return_value = catalog_item
    # all_deliveries_res
    exec_deliv_res = MagicMock()
    exec_deliv_res.all.return_value = [("oline-1", Decimal("10"))]
    # all_returns_res
    exec_ret_res = MagicMock()
    exec_ret_res.all.return_value = []

    session.execute.side_effect = [
        exec_load_order,
        exec_prior_returns,
        exec_item,
        exec_deliv_res,
        exec_ret_res,
    ]
    # scalar: delivery, idempotency_check (None), fg_wh
    session.scalar.side_effect = [delivery, None, fg_wh]
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()

    return_req = CustomerDeliveryReturnCreate(
        reason="عيب في التطريز",
        received_by="أمين مخزن الاستلام",
        idempotency_key="idemp-ret-001",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-1", quantity=Decimal("4"), notes="4 قطع معيبة")],
    )

    response = await record_customer_delivery_return("cust-1", "corder-1", "del-1", return_req, mock_user, session)

    assert response.delivery_id == "del-1"
    assert response.reason == "عيب في التطريز"
    assert len(response.lines) == 1
    assert response.lines[0].quantity == 4.0
    assert order.status == "partially_delivered"

    # التحقق من إضافة قيد الدفتر العكسي المعزول
    stock_return_entry = None
    for call_arg in session.add.call_args_list:
        obj = call_arg[0][0]
        if isinstance(obj, StockLedgerEntry):
            stock_return_entry = obj
            break

    assert stock_return_entry is not None
    assert stock_return_entry.item_id == "fg-item-1"
    assert stock_return_entry.quantity == 4.0  # قيد موجب
    assert stock_return_entry.entry_type == "customer_delivery_return"
    assert stock_return_entry.bucket_reference == "return_pending_inspection:cust-1"
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_customer_delivery_return_rejects_exceeding_delivered_quantity(base_entities, mock_user):
    """رفض تجاوز مجموع الكميات المرتجعة للكمية المسلمة فعلياً في سند التسليم (HTTP 409)."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(
        id="oline-1",
        product_id="prod-100",
        variant_id="var-200",
        product=product,
        variant=variant,
        quantity=Decimal("10"),
    )
    del_line = CustomerDeliveryLine(
        id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("10"),  # تم تسليم 10 فقط
    )
    delivery = CustomerDelivery(
        id="del-1",
        order_id="corder-1",
        lines=[del_line],
        returns=[],
    )
    order = CustomerOrder(id="corder-1", customer_id="cust-1", lines=[order_line])

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    exec_prior_returns = MagicMock()
    exec_prior_returns.all.return_value = [("dline-1", Decimal("7"))]  # أرجع 7 سابقاً، المتبقي 3 فقط

    session.execute.side_effect = [exec_load_order, exec_prior_returns]
    session.scalar.return_value = delivery

    return_req = CustomerDeliveryReturnCreate(
        reason="طلب زائد",
        received_by="أمين المخزن",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-1", quantity=Decimal("5"))],  # مطلوب 5 > 3
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery_return("cust-1", "corder-1", "del-1", return_req, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "تتجاوز الكمية المسلمة فعلياً" in exc_info.value.detail


@pytest.mark.asyncio
async def test_customer_delivery_return_idempotency_prevents_duplicate_entries(base_entities, mock_user):
    """التحقق من أن تكرار الطلب بنفس idempotency_key يرجع السند القائم دون إضافة قيود جديدة."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(
        id="oline-1",
        product_id="prod-100",
        variant_id="var-200",
        product=product,
        variant=variant,
    )
    del_line = CustomerDeliveryLine(
        id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("10"),
    )
    delivery = CustomerDelivery(
        id="del-1",
        order_id="corder-1",
        lines=[del_line],
    )
    order = CustomerOrder(id="corder-1", customer_id="cust-1", lines=[order_line])

    ret_line = CustomerDeliveryReturnLine(
        id="rline-1",
        delivery_line_id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("3"),
        notes="",
    )
    existing_return = CustomerDeliveryReturn(
        id="ret-existing-1",
        return_number="RET-2026-EXISTING",
        delivery_id="del-1",
        order_id="corder-1",
        customer_id="cust-1",
        returned_at=datetime.now(timezone.utc),
        reason="مرتجع مكرر",
        received_by="أمين المخزن",
        disposition="pending_inspection",
        idempotency_key="idemp-key-repeat",
        lines=[ret_line],
    )

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_load_order

    # delivery scalar then existing_return scalar
    session.scalar.side_effect = [delivery, existing_return]
    session.add = MagicMock()
    session.commit = AsyncMock()

    return_req = CustomerDeliveryReturnCreate(
        reason="مرتجع مكرر",
        received_by="أمين المخزن",
        idempotency_key="idemp-key-repeat",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-1", quantity=Decimal("3"))],
    )

    response = await record_customer_delivery_return("cust-1", "corder-1", "del-1", return_req, mock_user, session)

    assert response.id == "ret-existing-1"
    assert response.return_number == "RET-2026-EXISTING"
    session.add.assert_not_called()
    session.commit.assert_not_awaited()


# ─── 5. اختبار عزل بضاعة المرتجع عن رصيد التسليمات الجديدة ────────────────────

@pytest.mark.asyncio
async def test_returned_stock_in_inspection_bucket_not_counted_for_new_deliveries(base_entities, mock_user):
    """
    التأكد المعماري: البضاعة المرتجعة تحت الفحص (return_pending_inspection)
    لا تدخل ضمن رصيد التسليمات الجديدة، وإذا لم يتوفر رصيد معتمد في factory_brand يتم رفض التسليم.
    """
    product, variant, unit, fg_wh = base_entities
    catalog_item = CatalogItem(
        id="fg-item-1",
        code="FG-VAR-var-200",
        name_ar="منتج تام - جلابية رجالي فاخرة (مقاس 58 - صيفي)",
        item_type="finished_garment",
        unit_id=unit.id,
    )
    order_line = CustomerOrderLine(
        id="oline-2",
        product_id="prod-100",
        variant_id="var-200",
        product=product,
        variant=variant,
        quantity=Decimal("5"),
    )
    order = CustomerOrder(
        id="corder-2",
        customer_id="cust-2",
        order_number="CO-2026-002",
        order_type="factory_product",
        status="open",
        lines=[order_line],
    )

    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [variant, product]

    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    exec_delivered_res = MagicMock()
    exec_delivered_res.all.return_value = []
    exec_item_res = MagicMock()
    exec_item_res.scalar_one_or_none.return_value = catalog_item

    session.execute.side_effect = [exec_load_order, exec_delivered_res, exec_item_res]

    # استعلام رصيد المخزن المتاح لـ factory_brand هو 0.0
    # (مع أن هناك 10 قطع في الدفتر لكنها في bucket_reference='return_pending_inspection:cust-1')
    session.scalar.side_effect = [fg_wh, catalog_item.id, 0.0]

    delivery_req = CustomerDeliveryCreate(
        received_by="عميل جديد",
        lines=[CustomerDeliveryLineCreate(order_line_id="oline-2", quantity=Decimal("5"))],
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery("cust-2", "corder-2", delivery_req, mock_user, session)

    assert exc_info.value.status_code == 409
    # لا يمكن تسليم البضاعة المرتجعة غير المفحوصة
    assert "لا يكفي لتسليم الكمية المطلوبة" in exc_info.value.detail


@pytest.mark.asyncio
async def test_customer_delivery_return_rejects_idempotency_key_on_different_delivery(base_entities, mock_user):
    """التحقق من رفض إعادة استخدام مفتاح عدم التكرار لسند تسليم آخر بحالة 409 Conflict."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(id="oline-1", product_id="prod-100", variant_id="var-200")
    del_line = CustomerDeliveryLine(id="dline-1", order_line_id="oline-1", quantity=Decimal("10"))
    delivery = CustomerDelivery(id="del-target", order_id="corder-1", lines=[del_line])
    order = CustomerOrder(id="corder-1", customer_id="cust-1", lines=[order_line])

    # سند مرتجع موجود مسبقاً بنفس المفتاح لكن لسند تسليم مختلف 'del-foreign'
    existing_return = CustomerDeliveryReturn(
        id="ret-foreign-1",
        return_number="RET-FOREIGN",
        delivery_id="del-foreign",
        order_id="corder-other",
        customer_id="cust-1",
        idempotency_key="idemp-shared-key",
        lines=[],
    )

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_load_order
    session.scalar.side_effect = [delivery, existing_return]

    return_req = CustomerDeliveryReturnCreate(
        reason="طلب مكرر",
        received_by="أمين المخزن",
        idempotency_key="idemp-shared-key",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-1", quantity=Decimal("2"))],
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery_return("cust-1", "corder-1", "del-target", return_req, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "مستخدم مسبقاً مع سند تسليم آخر" in exc_info.value.detail


@pytest.mark.asyncio
async def test_customer_delivery_return_rejects_idempotency_key_with_different_quantity(base_entities, mock_user):
    """الحالة 2: نفس المفتاح + نفس التسليم + كميات مختلفة -> HTTP 409 Conflict."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(id="oline-1", product_id="prod-100", variant_id="var-200", product=product, variant=variant)
    del_line = CustomerDeliveryLine(id="dline-1", order_line_id="oline-1", order_line=order_line, quantity=Decimal("10"))
    delivery = CustomerDelivery(id="del-1", order_id="corder-1", lines=[del_line])
    order = CustomerOrder(id="corder-1", customer_id="cust-1", lines=[order_line])

    ret_line = CustomerDeliveryReturnLine(
        id="rline-1",
        delivery_line_id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("3"),
        notes="",
    )
    existing_return = CustomerDeliveryReturn(
        id="ret-existing-1",
        return_number="RET-2026-EXISTING",
        delivery_id="del-1",
        order_id="corder-1",
        customer_id="cust-1",
        returned_at=datetime.now(timezone.utc),
        reason="مرتجع مكرر",
        received_by="أمين المخزن",
        disposition="pending_inspection",
        idempotency_key="idemp-key-diff-qty",
        lines=[ret_line],
    )

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_load_order
    session.scalar.side_effect = [delivery, existing_return]

    # طلب بنفس المفتاح ونفس التسليم لكن بكمية 5 بدلاً من 3
    return_req = CustomerDeliveryReturnCreate(
        reason="مرتجع مكرر",
        received_by="أمين المخزن",
        idempotency_key="idemp-key-diff-qty",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-1", quantity=Decimal("5"))],
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery_return("cust-1", "corder-1", "del-1", return_req, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "بكميات مرتجع مختلفة" in exc_info.value.detail


@pytest.mark.asyncio
async def test_customer_delivery_return_rejects_idempotency_key_with_different_reason(base_entities, mock_user):
    """الحالة 3أ: نفس المفتاح + نفس التسليم + تفاصيل مختلفة (reason) -> HTTP 409 Conflict."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(id="oline-1", product_id="prod-100", variant_id="var-200", product=product, variant=variant)
    del_line = CustomerDeliveryLine(id="dline-1", order_line_id="oline-1", order_line=order_line, quantity=Decimal("10"))
    delivery = CustomerDelivery(id="del-1", order_id="corder-1", lines=[del_line])
    order = CustomerOrder(id="corder-1", customer_id="cust-1", lines=[order_line])

    ret_line = CustomerDeliveryReturnLine(
        id="rline-1",
        delivery_line_id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("3"),
        notes="",
    )
    existing_return = CustomerDeliveryReturn(
        id="ret-existing-1",
        return_number="RET-2026-EXISTING",
        delivery_id="del-1",
        order_id="corder-1",
        customer_id="cust-1",
        returned_at=datetime.now(timezone.utc),
        reason="سبب أصلي أول",
        received_by="أمين المخزن",
        disposition="pending_inspection",
        idempotency_key="idemp-key-diff-reason",
        lines=[ret_line],
    )

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_load_order
    session.scalar.side_effect = [delivery, existing_return]

    # طلب بنفس المفتاح لكن بسبب مختلف
    return_req = CustomerDeliveryReturnCreate(
        reason="سبب مختلف تماماً",
        received_by="أمين المخزن",
        idempotency_key="idemp-key-diff-reason",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-1", quantity=Decimal("3"))],
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery_return("cust-1", "corder-1", "del-1", return_req, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "تفاصيل سبب مرتجع مختلفة" in exc_info.value.detail


@pytest.mark.asyncio
async def test_customer_delivery_return_rejects_idempotency_key_with_different_lines(base_entities, mock_user):
    """الحالة 3ب: نفس المفتاح + نفس التسليم + بنود تسليم مختلفة -> HTTP 409 Conflict."""
    product, variant, _, _ = base_entities
    order_line = CustomerOrderLine(id="oline-1", product_id="prod-100", variant_id="var-200", product=product, variant=variant)
    del_line_1 = CustomerDeliveryLine(id="dline-1", order_line_id="oline-1", order_line=order_line, quantity=Decimal("10"))
    del_line_2 = CustomerDeliveryLine(id="dline-2", order_line_id="oline-1", order_line=order_line, quantity=Decimal("5"))
    delivery = CustomerDelivery(id="del-1", order_id="corder-1", lines=[del_line_1, del_line_2])
    order = CustomerOrder(id="corder-1", customer_id="cust-1", lines=[order_line])

    ret_line = CustomerDeliveryReturnLine(
        id="rline-1",
        delivery_line_id="dline-1",
        order_line_id="oline-1",
        order_line=order_line,
        quantity=Decimal("2"),
        notes="",
    )
    existing_return = CustomerDeliveryReturn(
        id="ret-existing-1",
        return_number="RET-2026-EXISTING",
        delivery_id="del-1",
        order_id="corder-1",
        customer_id="cust-1",
        returned_at=datetime.now(timezone.utc),
        reason="مرتجع مكرر",
        received_by="أمين المخزن",
        disposition="pending_inspection",
        idempotency_key="idemp-key-diff-lines",
        lines=[ret_line],
    )

    session = AsyncMock()
    exec_load_order = MagicMock()
    exec_load_order.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_load_order
    session.scalar.side_effect = [delivery, existing_return]

    # طلب بنفس المفتاح لكن يرجع بند dline-2 بدلاً من dline-1
    return_req = CustomerDeliveryReturnCreate(
        reason="مرتجع مكرر",
        received_by="أمين المخزن",
        idempotency_key="idemp-key-diff-lines",
        lines=[CustomerDeliveryReturnLineCreate(delivery_line_id="dline-2", quantity=Decimal("2"))],
    )

    with pytest.raises(HTTPException) as exc_info:
        await record_customer_delivery_return("cust-1", "corder-1", "del-1", return_req, mock_user, session)

    assert exc_info.value.status_code == 409
    assert "بنود تسليم مختلفة" in exc_info.value.detail

