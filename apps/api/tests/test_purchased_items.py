from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_purchased_items_shows_prices_for_finance_manager():
    """يعيد سجل الأصناف المشتراة تفاصيل التكلفة وصافي السعر للمدير المالي أو العام."""
    from app.api.v1.endpoints.finance import list_purchased_items

    line = SimpleNamespace(
        id="line-1",
        invoice_id="inv-1",
        item_id="item-1",
        unit_id="unit-1",
        invoiced_quantity=100.0,
        received_quantity=60.0,
        unit_price=Decimal("50.0000"),
        discount_amount=Decimal("200.00"),
        notes="دفعة أولى",
    )
    invoice = SimpleNamespace(
        id="inv-1",
        internal_number="SINV-0001",
        invoice_number="SUP-88",
        invoice_date=datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc),
        status="partially_received",
    )
    supplier = SimpleNamespace(id="sup-1", code="SUP01", name="شركة النسيج الحديثة")
    item = SimpleNamespace(id="item-1", code="FAB-01", name_ar="قماش قطن", item_type="fabric", category_id="cat-1")
    unit = SimpleNamespace(id="unit-1", name_ar="متر")
    category = SimpleNamespace(id="cat-1", name_ar="أقمشة")

    exec_res = MagicMock()
    exec_res.all = MagicMock(return_value=[(line, invoice, supplier, item, unit, category)])
    db = AsyncMock()
    db.execute = AsyncMock(return_value=exec_res)

    user = MagicMock()
    user.id = "fm-1"

    with patch("app.api.v1.endpoints.finance.get_user_roles", AsyncMock(return_value={"finance_manager"})):
        resp = await list_purchased_items(current_user=user, db=db)

    assert resp.summary.prices_visible is True
    assert resp.summary.lines_count == 1
    assert resp.summary.distinct_items_count == 1
    assert resp.summary.total_invoiced_quantity == 100.0
    assert resp.summary.total_received_quantity == 60.0
    assert resp.summary.total_amount == Decimal("4800.00")

    row = resp.items[0]
    assert row.item_name_ar == "قماش قطن"
    assert row.category_name_ar == "أقمشة"
    assert row.remaining_quantity == 40.0
    assert row.unit_price == Decimal("50.0000")
    assert row.discount_amount == Decimal("200.00")
    assert row.line_total == Decimal("4800.00")
    assert row.net_unit_cost == Decimal("48.0000")


@pytest.mark.asyncio
async def test_purchased_items_masks_prices_for_warehouse_manager():
    """يخفي الأسعار والإجماليات المالية عن أمين المخزن في سجل الأصناف المشتراة."""
    from app.api.v1.endpoints.finance import list_purchased_items

    line = SimpleNamespace(
        id="line-2",
        invoice_id="inv-2",
        item_id="item-2",
        unit_id="unit-2",
        invoiced_quantity=50.0,
        received_quantity=50.0,
        unit_price=Decimal("30.0000"),
        discount_amount=Decimal("0.00"),
        notes="",
    )
    invoice = SimpleNamespace(
        id="inv-2",
        internal_number="SINV-0002",
        invoice_number="SUP-89",
        invoice_date=datetime(2026, 11, 2, 10, 0, tzinfo=timezone.utc),
        status="received",
    )
    supplier = SimpleNamespace(id="sup-1", code="SUP01", name="شركة النسيج الحديثة")
    item = SimpleNamespace(id="item-2", code="ACC-01", name_ar="أزرار", item_type="accessory", category_id=None)
    unit = SimpleNamespace(id="unit-2", name_ar="علبة")

    exec_res = MagicMock()
    exec_res.all = MagicMock(return_value=[(line, invoice, supplier, item, unit, None)])
    db = AsyncMock()
    db.execute = AsyncMock(return_value=exec_res)

    user = MagicMock()
    user.id = "wm-1"

    with patch("app.api.v1.endpoints.finance.get_user_roles", AsyncMock(return_value={"warehouse_manager"})):
        resp = await list_purchased_items(current_user=user, db=db)

    assert resp.summary.prices_visible is False
    assert resp.summary.total_amount is None
    row = resp.items[0]
    assert row.unit_price is None
    assert row.discount_amount is None
    assert row.net_unit_cost is None
    assert row.line_total is None
    assert row.invoiced_quantity == 50.0

