"""اختبارات وحدة endpoints التقارير التشغيلية والمالية والمخزنية."""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest

import app.db.base  # noqa: F401


def _uid():
    return str(uuid.uuid4())


@pytest.mark.asyncio
async def test_get_summary_report():
    """التحقق من حساب الملخص التشغيلي الشامل (خزينة، مخزون، إنتاج)."""
    from app.api.v1.endpoints.reports import get_summary

    user = MagicMock()
    user.id = _uid()

    treasury = MagicMock()
    treasury.id = _uid()
    treasury.account_type = "treasury"
    treasury.is_active = True

    petty1 = MagicMock()
    petty1.id = _uid()
    petty1.account_type = "petty_cash"
    petty1.is_active = True

    db = AsyncMock()

    call_count = 0

    async def mock_scalar(stmt):
        nonlocal call_count
        call_count += 1
        # 1: treasury account, 2: treasury balance (5000), 3: petty balance (1200),
        # 4: revenues (20000), 5: expenses (8000), 6: active_orders (5),
        # 7: completed_orders (12), 8: raw_wh_id, 9: fg_wh_id, 10: raw_count (45),
        # 11: fg_count (20), 12: total_supplier_invoiced (30000), 13: total_supplier_paid (20000)
        returns = [
            treasury, Decimal("5000"), Decimal("1200"),
            Decimal("20000"), Decimal("8000"),
            5, 12,
            _uid(), _uid(), 45, 20,
            Decimal("30000"), Decimal("20000"),
        ]
        if call_count <= len(returns):
            return returns[call_count - 1]
        return 0

    db.scalar = AsyncMock(side_effect=mock_scalar)
    db.scalars = AsyncMock()
    db.scalars.return_value.all = MagicMock(return_value=[petty1])

    summary = await get_summary(period="monthly", current_user=user, db=db)

    assert summary["period"] == "monthly"
    assert summary["treasury"]["balance"] == 5000.0
    assert summary["treasury"]["petty_cash_total"] == 1200.0
    assert summary["treasury"]["revenues_period"] == 20000.0
    assert summary["treasury"]["expenses_period"] == 8000.0
    assert summary["treasury"]["net_period"] == 12000.0
    assert summary["production"]["active_orders"] == 5
    assert summary["production"]["completed_orders_period"] == 12
    assert summary["inventory"]["raw_material_distinct_items"] == 45
    assert summary["inventory"]["finished_goods_distinct_items"] == 20
    assert summary["payables"]["supplier_payables"] == 10000.0


@pytest.mark.asyncio
async def test_get_inventory_report():
    """تقرير أرصدة المخزون لكل صنف."""
    from app.api.v1.endpoints.reports import get_inventory_report

    user = MagicMock()
    user.id = _uid()

    db = AsyncMock()
    db.execute = AsyncMock()
    item_id = _uid()
    wh_id = _uid()
    db.execute.return_value.all = MagicMock(return_value=[
        (item_id, wh_id, Decimal("150.5")),
    ])

    wh = MagicMock()
    wh.id = wh_id
    wh.name_ar = "مخزن الخامات الرئيسي"

    item = MagicMock()
    item.id = item_id
    item.code = "FAB-001"
    item.name_ar = "قماش جبردين"

    scalars_call = 0

    def mock_scalars(stmt):
        nonlocal scalars_call
        scalars_call += 1
        res = MagicMock()
        if scalars_call == 1:
            res.all = MagicMock(return_value=[wh])
        else:
            res.all = MagicMock(return_value=[item])
        return res

    db.scalars = AsyncMock(side_effect=mock_scalars)

    res = await get_inventory_report(warehouse_code=None, current_user=user, db=db)

    assert res["total_items"] == 1
    assert res["items"][0]["item_code"] == "FAB-001"
    assert res["items"][0]["balance"] == 150.5
    assert res["items"][0]["low_stock"] is False


@pytest.mark.asyncio
async def test_get_financial_report():
    """تقرير المستندات المالية والإيرادات والمصروفات وصافي السيولة."""
    from app.api.v1.endpoints.reports import get_financial_report

    user = MagicMock()
    user.id = _uid()

    doc_rev = MagicMock()
    doc_rev.id = _uid()
    doc_rev.document_number = "CSH-REV-001"
    doc_rev.amount = Decimal("15000")
    doc_rev.description = "مبيعات نقدية"
    doc_rev.occurred_at = datetime.now(timezone.utc)

    doc_exp = MagicMock()
    doc_exp.id = _uid()
    doc_exp.document_number = "CSH-EXP-001"
    doc_exp.amount = Decimal("4000")
    doc_exp.description = "شراء مستلزمات"
    doc_exp.occurred_at = datetime.now(timezone.utc)

    db = AsyncMock()
    scalars_call = 0

    def mock_scalars(stmt):
        nonlocal scalars_call
        scalars_call += 1
        res = MagicMock()
        if scalars_call == 1:
            res.all = MagicMock(return_value=[doc_rev])
        else:
            res.all = MagicMock(return_value=[doc_exp])
        return res

    db.scalars = AsyncMock(side_effect=mock_scalars)

    res = await get_financial_report(since_days=30, current_user=user, db=db)

    assert res["since_days"] == 30
    assert res["revenues"]["total"] == 15000.0
    assert res["expenses"]["total"] == 4000.0
    assert res["net"] == 11000.0
    assert len(res["revenues"]["documents"]) == 1
    assert len(res["expenses"]["documents"]) == 1

