"""
مرتجعات العملاء: الحالة عند الاستلام، والفحص المقسم لكل سطر (صالح للبيع / تالف)، والقوائم.
- الصالح فقط يعود للرصيد القابل للبيع، والتالف يُعدم كهالك (5200) ولا يختلط بالرصيد.
- لا مرتجع يتجاوز المسلم ناقص المرتجع سابقاً، ولا فحص مرتين.
- لا استرداد نقدي تلقائي: الفحص لا ينشئ سند صرف ولا يغير ذمة العميل مرة ثانية.
"""
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.modules.finance.models import CashDocument, JournalEntry, JournalEntryLine
from app.modules.production.stock import RETURN_PENDING_PREFIX, stock_balance

from tests.test_p1_backend_fixes import (  # noqa: F401 (ctx fixture)
    API,
    Actor,
    _user,
    _finished_stock,
    _product_with_variant,
    _tag,
    _warehouse,
    ctx,
)


async def _delivered_order(session, a, *, qty="10", delivered="10"):
    prod, variant = await _product_with_variant(session)
    fg_item = await _finished_stock(session, prod, variant, 20, "100")
    res = await a["gm"].post(f"{API}/customers", json={"code": f"CUS-{_tag()}", "name": f"عميل مرتجعات {_tag()}"})
    customer_id = res.json()["id"]
    res = await a["gm"].post(f"{API}/customers/{customer_id}/orders", json={
        "order_type": "ready_goods",
        "lines": [{"product_id": prod.id, "variant_id": variant.id, "quantity": qty, "unit_price": "500.00"}],
    })
    assert res.status_code == 201, res.text
    order = res.json()
    res = await a["wh"].post(f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries", json={
        "lines": [{"order_line_id": order["lines"][0]["id"], "quantity": delivered}], "received_by": "مندوب",
    })
    assert res.status_code == 201, res.text
    return customer_id, order, res.json(), fg_item


async def _returnable(a, delivery_number):
    res = await a["wh"].get(f"{API}/customers/returnable-deliveries", params={"search": delivery_number})
    assert res.status_code == 200, res.text
    rows = [d for d in res.json() if d["delivery_number"] == delivery_number]
    return rows[0] if rows else None


@pytest.mark.asyncio
async def test_split_inspection_restocks_only_resalable_and_scraps_damaged(ctx):
    session, a = ctx
    fg = await _warehouse(session, "finished_goods")
    customer_id, order, delivery, fg_item = await _delivered_order(session, a)

    target = await _returnable(a, delivery["delivery_number"])
    assert target and target["lines"][0]["returnable_quantity"] == 10
    line_id = target["lines"][0]["delivery_line_id"]

    res = await a["wh"].post(f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries/{delivery['id']}/return", json={
        "reason": "عيوب خياطة", "received_by": "سائق العميل",
        "lines": [{"delivery_line_id": line_id, "quantity": "5", "condition": "damaged", "notes": "3 قطع ممزقة"}],
    })
    assert res.status_code == 201, res.text
    ret = res.json()
    assert ret["disposition"] == "pending_inspection"
    assert ret["lines"][0]["condition"] == "damaged"
    assert ret["created_by"] == a["wh"].user.id
    pending_bucket = f"{RETURN_PENDING_PREFIX}{customer_id}"
    sellable_before = await stock_balance(session, fg_item.id, fg.id, bucket_reference="factory_brand")
    assert await stock_balance(session, fg_item.id, fg.id, bucket_reference=pending_bucket) == 5.0

    # المتبقي القابل للإرجاع ينقص بالمرتجع
    assert (await _returnable(a, delivery["delivery_number"]))["lines"][0]["returnable_quantity"] == 5

    # قائمة بانتظار الفحص بلا مبالغ
    pending = (await a["wh"].get(f"{API}/customers/returns", params={"status": "pending"})).json()
    row = next(r for r in pending if r["id"] == ret["id"])
    assert row["delivery_number"] == delivery["delivery_number"] and row["order_number"] == order["order_number"]
    assert "return_value" not in row

    url = f"{API}/customers/{customer_id}/returns/{ret['id']}/inspection"
    rline = ret["lines"][0]["id"]
    bad = await a["wh"].post(url, json={"lines": [{"return_line_id": rline, "restocked_quantity": "2", "scrapped_quantity": "2"}]})
    assert bad.status_code == 422  # المجموع لا يساوي الكمية
    both = await a["wh"].post(url, json={"disposition": "restocked", "lines": [{"return_line_id": rline, "restocked_quantity": "5", "scrapped_quantity": "0"}]})
    assert both.status_code == 422

    docs_before = await session.scalar(select(func.count()).select_from(CashDocument))
    res = await a["wh"].post(url, json={
        "lines": [{"return_line_id": rline, "restocked_quantity": "2", "scrapped_quantity": "3"}],
        "notes": "قطعتان سليمتان بعد الكي",
    })
    assert res.status_code == 200, res.text
    inspected = res.json()
    assert inspected["disposition"] == "partially_restocked"
    assert inspected["inspected_by"] == a["wh"].user.id and inspected["inspected_at"]
    assert inspected["inspection_notes"] == "قطعتان سليمتان بعد الكي"
    assert inspected["reason"] == "عيوب خياطة"  # لا يُلحق الفحص بالسبب
    assert inspected["lines"][0]["restocked_quantity"] == 2 and inspected["lines"][0]["scrapped_quantity"] == 3

    assert await stock_balance(session, fg_item.id, fg.id, bucket_reference=pending_bucket) == 0.0
    assert await stock_balance(session, fg_item.id, fg.id, bucket_reference="factory_brand") == sellable_before + 2.0

    # التالف فقط يُحمّل هالكاً: 3 × 100
    scrap = await session.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.debit), 0))
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.entry_id)
        .where(JournalEntry.source_doc_type == "customer_return_scrap", JournalEntry.source_doc_id == ret["id"])
    )
    assert Decimal(str(scrap)) == Decimal("300.00")
    # لا استرداد نقدي تلقائي
    assert await session.scalar(select(func.count()).select_from(CashDocument)) == docs_before

    again = await a["wh"].post(url, json={"disposition": "scrapped"})
    assert again.status_code == 409

    history = (await a["gm"].get(f"{API}/customers/returns", params={"status": "inspected", "order_id": order["id"]})).json()
    assert [r["id"] for r in history] == [ret["id"]]


@pytest.mark.asyncio
async def test_return_limits_and_permissions(ctx):
    session, a = ctx
    customer_id, order, delivery, _ = await _delivered_order(session, a, qty="4", delivered="4")
    target = await _returnable(a, delivery["delivery_number"])
    line_id = target["lines"][0]["delivery_line_id"]
    url = f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries/{delivery['id']}/return"

    assert (await a["wh"].post(url, json={"reason": "x", "lines": [{"delivery_line_id": line_id, "quantity": "1", "condition": "broken"}]})).status_code == 422
    assert (await a["wh"].post(url, json={"reason": "مقاس خطأ", "lines": [{"delivery_line_id": line_id, "quantity": "4", "condition": "good"}]})).status_code == 201
    over = await a["wh"].post(url, json={"reason": "مرة أخرى", "lines": [{"delivery_line_id": line_id, "quantity": "1"}]})
    assert over.status_code == 409
    # التسليم المرتجع بالكامل لا يظهر في القابل للإرجاع
    assert await _returnable(a, delivery["delivery_number"]) is None

    # مسؤول الإنتاج لا يرى المرتجعات ولا يسجلها؛ المدير المالي يرى السجل فقط
    a["pm"] = Actor(a["wh"].client, _user(f"ret-pm-{_tag()}", "production_manager"))
    assert (await a["pm"].get(f"{API}/customers/returns")).status_code == 403
    assert (await a["pm"].get(f"{API}/customers/returnable-deliveries")).status_code == 403
    assert (await a["fm"].get(f"{API}/customers/returns")).status_code == 200
    assert (await a["fm"].get(f"{API}/customers/returnable-deliveries")).status_code == 403
    assert (await a["fm"].post(url, json={"reason": "x", "lines": [{"delivery_line_id": line_id, "quantity": "1"}]})).status_code == 403
