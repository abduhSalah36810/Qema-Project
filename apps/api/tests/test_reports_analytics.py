"""
اختبارات التحليلات المالية: الفترات بتوقيت القاهرة، أعمار الديون، تحليل المبيعات، ربحية الموديلات،
والتأكد من أن كل مسار تحليلات يعمل ومحمي بالصلاحيات.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.modules.reports import analytics
from tests.test_operational_cycle_e2e import (  # noqa: F401  (ctx fixture)
    _finished_stock,
    _product_with_sizes,
    _tag,
    ctx,
)


# ─── وحدات منطقية ────────────────────────────────────────────────────────────

def test_period_bounds_use_cairo_calendar_and_previous_period():
    p = analytics.make_period(date(2026, 11, 1), date(2026, 11, 30))
    assert p.days == 30
    # منتصف ليل القاهرة 1 نوفمبر (UTC+2 في نوفمبر) = 22:00 UTC يوم 31 أكتوبر
    assert p.start == datetime(2026, 10, 31, 22, 0, tzinfo=timezone.utc)
    assert p.end == datetime(2026, 11, 30, 22, 0, tzinfo=timezone.utc)
    prev = p.previous()
    assert (prev.date_from, prev.date_to) == (date(2026, 10, 2), date(2026, 10, 31))
    with pytest.raises(HTTPException):
        analytics.make_period(date(2026, 11, 2), date(2026, 11, 1))
    with pytest.raises(HTTPException):
        analytics.make_period(date(2023, 1, 1), date(2026, 1, 1))
    assert analytics.resolve_period(None, None).date_from.day == 1


def test_aging_bucket_boundaries():
    assert [analytics._bucket(d) for d in (0, 30, 31, 60, 61, 90, 91, 400)] == [
        "0_30", "0_30", "31_60", "31_60", "61_90", "61_90", "90_plus", "90_plus",
    ]


def test_expense_category_and_cash_figures_exclude_transfers():
    docs = [
        SimpleNamespace(document_type="income", source_system="customer_payment", amount=Decimal("500"), description=""),
        SimpleNamespace(document_type="income", source_system=None, amount=Decimal("100"), description="رصيد افتتاحي"),
        SimpleNamespace(document_type="expense", source_system="supplier_payment", amount=Decimal("200"), description=""),
        SimpleNamespace(document_type="expense", source_system="payroll", amount=Decimal("300"), description=""),
        SimpleNamespace(document_type="expense", source_system=None, amount=Decimal("40"), description="[كهرباء ومياه] فاتورة"),
        SimpleNamespace(document_type="transfer", source_system=None, amount=Decimal("999"), description="تمويل عهدة"),
    ]
    f = analytics.cash_figures(docs)
    assert f["inflows"] == Decimal("600.00") and f["outflows"] == Decimal("540.00")
    assert f["net_cash"] == Decimal("60.00") and f["operating_expenses"] == Decimal("40.00")
    assert analytics.expense_category(docs[4]) == "كهرباء ومياه"
    assert analytics.expense_category(docs[3]) == "رواتب"
    assert analytics.expense_category(SimpleNamespace(source_system=None, description="بدون تصنيف")) == "مصروفات أخرى"


# ─── سيناريو حقيقي عبر الـ API ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_sales_profitability_and_aging_match_a_real_sale(ctx):
    session, a = ctx
    prod, v56, v60 = await _product_with_sizes(session)
    await _finished_stock(session, prod, v56, 20, cost="100")

    res = await a["gm"].post("/api/v1/customers", json={"code": f"CUS-{_tag()}", "name": "عميل التحليلات"})
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]
    # 10 × 500 + 5 × 600 = 8000 − خصم 400 = 7600 (نسبة الصافي 0.95)
    res = await a["gm"].post(f"/api/v1/customers/{customer_id}/orders", json={
        "order_type": "ready_goods", "discount_amount": "400.00",
        "lines": [
            {"product_id": prod.id, "variant_id": v56.id, "quantity": "10", "unit_price": "500.00"},
            {"product_id": prod.id, "variant_id": v60.id, "quantity": "5", "unit_price": "600.00"},
        ],
    })
    assert res.status_code == 201, res.text
    order = res.json()
    line56 = next(l for l in order["lines"] if l["variant_id"] == v56.id)
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order['id']}/deliveries", json={
        "lines": [{"order_line_id": line56["id"], "quantity": "10"}], "received_by": "مندوب",
    })
    assert res.status_code == 201, res.text
    # تحصيل 1000 من المدير المالي يُعتمد فوراً
    res = await a["fm"].post(f"/api/v1/customers/{customer_id}/orders/{order['id']}/payments", json={"amount": "1000.00", "method": "cash"})
    assert res.status_code == 201 and res.json()["status"] == "approved", res.text

    today = datetime.now(analytics.CAIRO).date().isoformat()
    params = {"date_from": today, "date_to": today}

    sales = (await a["fm"].get("/api/v1/reports/analytics/sales", params=params)).json()
    cust = next(r for r in sales["by_customer"] if r["key"] == customer_id)
    assert cust["net_sales"] == 4750.0 and cust["quantity"] == 10.0 and cust["avg_price"] == 475.0
    model = next(r for r in sales["by_model"] if r["key"] == prod.id)
    assert model["net_sales"] == 4750.0
    size = next(r for r in sales["by_size"] if r["key"] == v56.id)
    assert size["quantity"] == 10.0

    prof = (await a["fm"].get("/api/v1/reports/analytics/model-profitability", params=params)).json()
    row = next(r for r in prof["rows"] if r["product_id"] == prod.id)
    assert row["net_sales"] == 4750.0 and row["cogs"] == 1000.0 and row["gross_profit"] == 3750.0
    assert row["unit_cost"] == 100.0 and row["margin_pct"] == pytest.approx(78.9, abs=0.1)

    aging = (await a["fm"].get("/api/v1/reports/analytics/aging", params={"party": "customers"})).json()
    arow = next(r for r in aging["rows"] if r["party_id"] == customer_id)
    assert arow["total"] == 3750.0 and arow["0_30"] == 3750.0 and arow["90_plus"] == 0.0

    # تقرير المديونيات القائم يعطي نفس الرصيد
    ar = (await a["fm"].get("/api/v1/reports/accounts-receivable")).json()
    assert next(r for r in ar["customers"] if r["customer_id"] == customer_id)["balance_due"] == 3750.0


@pytest.mark.asyncio
async def test_all_analytics_endpoints_respond_and_are_permission_guarded(ctx):
    _, a = ctx
    urls = [
        "/api/v1/reports/analytics/overview",
        "/api/v1/reports/analytics/aging?party=suppliers",
        "/api/v1/reports/analytics/sales",
        "/api/v1/reports/analytics/model-profitability",
        "/api/v1/reports/analytics/payroll-cost",
        "/api/v1/reports/analytics/losses",
        "/api/v1/reports/analytics/stock-health",
        "/api/v1/reports/cash-flow?date_from=2026-01-01&date_to=2026-12-31",
    ]
    for url in urls:
        res = await a["fm"].get(url)
        assert res.status_code == 200, (url, res.text)
    overview = (await a["fm"].get(urls[0])).json()
    assert {k["key"] for k in overview["kpis"]} >= {"sales", "gross_profit", "net_cash", "payroll"}
    assert len(overview["monthly"]) == 12
    # أمين المخزن ومسؤول الإنتاج لا يرون التحليلات المالية
    for role in ("wh", "pm"):
        assert (await a[role].get("/api/v1/reports/analytics/overview")).status_code == 403
    assert (await a["wh"].get("/api/v1/reports/analytics/stock-health")).status_code == 200
    bad = await a["fm"].get("/api/v1/reports/analytics/sales", params={"date_from": "2026-05-02", "date_to": "2026-05-01"})
    assert bad.status_code == 422
