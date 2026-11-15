from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_sold_items_computes_net_ratio_and_returns():
    """سجل الأصناف المباعة يطبق نسبة صافي الخصم على الطلب ويخصم المرتجعات بدقة."""
    from app.api.v1.endpoints.customers import list_sold_items

    product = SimpleNamespace(id="prod-1", code="MOD-101", name_ar="جلابية القمة")
    variant = SimpleNamespace(id="var-1", numeric_size=58, letter_size=None, season="winter")
    customer = SimpleNamespace(id="cust-1", code="C-01", name="شركة النور")

    order_line = SimpleNamespace(
        id="ol-1",
        product_id="prod-1",
        variant_id="var-1",
        product=product,
        variant=variant,
        quantity=Decimal("10"),
        unit_price=Decimal("200.00"),
    )
    delivery_line = SimpleNamespace(
        id="dl-1",
        order_line_id="ol-1",
        order_line=order_line,
        quantity=Decimal("8"),
    )
    delivery = SimpleNamespace(
        id="del-1",
        delivery_number="DEL-001",
        delivered_at=datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc),
        lines=[delivery_line],
    )
    ret_line = SimpleNamespace(
        id="rl-1",
        delivery_line_id="dl-1",
        order_line_id="ol-1",
        quantity=Decimal("2"),
    )
    ret = SimpleNamespace(id="ret-1", lines=[ret_line])

    # gross = 10 * 200 = 2000; discount = 200 -> net_ratio = 0.9
    order = SimpleNamespace(
        id="ord-1",
        order_number="SO-001",
        order_type="ready_goods",
        status="partially_delivered",
        customer_id="cust-1",
        customer=customer,
        discount_amount=Decimal("200.00"),
        lines=[order_line],
        deliveries=[delivery],
        returns=[ret],
        payments=[],
    )

    scalars_mock = MagicMock()
    scalars_mock.all = MagicMock(return_value=[order])
    exec_res = MagicMock()
    exec_res.scalars = MagicMock(return_value=scalars_mock)

    db = AsyncMock()
    db.execute = AsyncMock(return_value=exec_res)
    user = MagicMock()

    resp = await list_sold_items(current_user=user, db=db)

    assert resp.summary.lines_count == 1
    assert resp.summary.distinct_products_count == 1
    assert resp.summary.total_delivered_quantity == 8.0
    assert resp.summary.total_returned_quantity == 2.0
    assert resp.summary.total_net_sold_quantity == 6.0
    # delivered_value = 8 * 200 * 0.9 = 1440.0; returned_value = 2 * 200 * 0.9 = 360.0; net = 1080.0
    assert resp.summary.total_delivered_value == 1440.0
    assert resp.summary.total_returned_value == 360.0
    assert resp.summary.total_net_sold_value == 1080.0

    row = resp.items[0]
    assert row.product_name == "جلابية القمة"
    assert row.variant_info == "58 · winter"
    assert row.unit_price == 200.0
    assert row.net_unit_price == 180.0
    assert row.net_sold_value == 1080.0

