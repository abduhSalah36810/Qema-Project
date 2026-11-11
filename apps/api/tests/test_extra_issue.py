"""
صرف خامات إضافي لأمر تشغيل قائم:
- أمين المخزن يصرف ويرحّل: خصم من مخزن الخامات + بالطريق، بتكلفة المتوسط المرجح لحظة الصرف.
- مسؤول الإنتاج (غير الصارف) يؤكد الاستلام: حاوية الأمر + الفرق موثق + تكلفة مضافة للأمر وقيد يومية.
- لا رصيد سالب، ولا صرف قبل استلام الخامات الأولى أو بعد بدء استلام المنتج التام، ولا منتجات تامة.
- الدورة تكتمل حتى الإغلاق دون رصيد معلق.
"""
from decimal import Decimal
import uuid

import pytest
from sqlalchemy import func, select

from app.modules.finance.models import JournalEntry
from app.modules.production.models import ProductionOrder, ProductionOrderMaterial, StockLedgerEntry
from app.modules.production.service import get_or_create_finished_goods_item
from app.modules.production.stock import stock_balance

from tests.test_phase1_closure import (  # noqa: F401 (ctx fixture)
    API,
    CLOSE_BODY,
    STAGES,
    _item,
    _product,
    _stock,
    _unit,
    _wh,
    ctx,
)


async def _order_in_production(session, a):
    """أمر بخامة واحدة: صُرفت 50 واستُلمت كاملة بالورشة (الحالة in_production)."""
    raw = await _wh(session, "main_raw_materials")
    meter = await _unit(session, "meter")
    fabric = await _item(session, meter)
    await _stock(session, fabric, raw, 200, cost="10")
    prod, variant = await _product(session)
    res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 10, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": 50}],
    })
    assert res.status_code == 201, res.text
    order_id = res.json()["id"]
    assert (await a["wh"].post(f"{API}/production/orders/{order_id}/dispatch")).status_code == 200
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 50}], "notes": "",
    })
    assert res.status_code == 200, res.text
    return order_id, fabric


async def _wip(session, item, order_id) -> float:
    wip = await _wh(session, "work_in_progress")
    return await stock_balance(session, item.id, wip.id, bucket_reference=f"order:{order_id}")


@pytest.mark.asyncio
async def test_extra_issue_full_cycle_costs_and_closes(ctx):
    session, a = ctx
    order_id, fabric = await _order_in_production(session, a)
    raw = await _wh(session, "main_raw_materials")
    piece = await _unit(session, "piece")
    button = await _item(session, piece)
    await _stock(session, button, raw, 20, cost="2")
    await _stock(session, fabric, raw, 100, cost="16")  # المتوسط المرجح للخامة يصبح 12
    raw_fabric_before = await stock_balance(session, fabric.id, raw.id)

    res = await a["wh"].post(f"{API}/production/orders/{order_id}/extra-issues", json={
        "reason": "إصلاح عيوب القص",
        "lines": [{"item_id": fabric.id, "quantity": 10}, {"item_id": button.id, "quantity": 5, "notes": "زرار احتياطي"}],
    })
    assert res.status_code == 201, res.text
    transfer = res.json()
    assert transfer["status"] == "in_transit"
    assert transfer["notes"].startswith("صرف إضافي")
    assert await stock_balance(session, fabric.id, raw.id) == pytest.approx(raw_fabric_before - 10)
    assert await _wip(session, fabric, order_id) == pytest.approx(50)

    order = (await a["pm"].get(f"{API}/production/orders/{order_id}")).json()
    assert order["status"] == "in_production"
    assert order["extra_issue_pending_dispatched_by"] == a["wh"].user.id

    # المنتج التام لا يُستلم وتكلفة الإضافي لم تدخل بعد
    for stage in STAGES:
        for value in ("in_progress", "completed"):
            assert (await a["pm"].post(f"{API}/production/orders/{order_id}/stages/{stage}", json={"status": value})).status_code == 200
    blocked = await a["wh"].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 10})
    assert blocked.status_code == 409 and "صرف خامات إضافي" in blocked.text

    # الصارف لا يؤكد استلام ما صرفه
    own = await a["wh"].post(f"{API}/production/orders/{order_id}/extra-issues/{transfer['id']}/receive", json={"received_lines": []})
    assert own.status_code in (403, 409)

    res = await a["pm"].post(f"{API}/production/orders/{order_id}/extra-issues/{transfer['id']}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 10}, {"item_id": button.id, "received_quantity": 4, "notes": "ناقص زرار"}],
        "notes": "",
    })
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "received_confirmed"
    again = await a["pm"].post(f"{API}/production/orders/{order_id}/extra-issues/{transfer['id']}/receive", json={"received_lines": []})
    assert again.status_code == 409

    assert await _wip(session, fabric, order_id) == pytest.approx(60)
    assert await _wip(session, button, order_id) == pytest.approx(4)

    costs = (await session.execute(
        select(ProductionOrder.actual_material_cost, ProductionOrder.unit_manufacturing_cost).where(ProductionOrder.id == order_id)
    )).one()
    # 50×10 + 10×12 + 4×2 = 628
    assert costs.actual_material_cost == Decimal("628.00")
    assert costs.unit_manufacturing_cost == Decimal("62.8000")
    M = ProductionOrderMaterial
    mats = {row.item_id: row for row in (await session.execute(
        select(M.item_id, M.planned_quantity, M.dispatched_quantity, M.received_quantity,
               M.discrepancy_quantity, M.unit_cost, M.status).where(M.order_id == order_id)
    )).all()}
    assert mats[fabric.id].dispatched_quantity == pytest.approx(60)
    assert mats[fabric.id].received_quantity == pytest.approx(60)
    assert mats[fabric.id].unit_cost == Decimal("10.3333")  # (500 + 120) / 60
    assert mats[button.id].planned_quantity == 0  # خارج المستلزمات الأصلية
    assert mats[button.id].discrepancy_quantity == pytest.approx(-1)
    assert mats[button.id].status == "received_with_discrepancy"
    journal = await session.scalar(select(func.count()).select_from(JournalEntry).where(JournalEntry.source_doc_id == transfer["id"]))
    assert journal == 1

    listed = (await a["pm"].get(f"{API}/production/orders/{order_id}/extra-issues")).json()
    assert [t["id"] for t in listed] == [transfer["id"]]

    # الدورة تكمل حتى الإغلاق
    res = await a["wh"].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 10})
    assert res.status_code == 201, res.text
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/material-reconciliations", json={"lines": [
        {"item_id": fabric.id, "consumed_quantity": 60, "returned_quantity": 0, "scrapped_quantity": 0},
        {"item_id": button.id, "consumed_quantity": 4, "returned_quantity": 0, "scrapped_quantity": 0},
    ]})
    assert res.status_code == 201, res.text
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/close", json=CLOSE_BODY)
    assert res.status_code == 200, res.text

    # بعد بدء/اكتمال استلام المنتج التام لا صرف إضافي
    late = await a["wh"].post(f"{API}/production/orders/{order_id}/extra-issues", json={
        "reason": "متأخر", "lines": [{"item_id": fabric.id, "quantity": 1}],
    })
    assert late.status_code == 409


@pytest.mark.asyncio
async def test_extra_issue_guards(ctx):
    session, a = ctx
    raw = await _wh(session, "main_raw_materials")
    meter = await _unit(session, "meter")

    # قبل استلام الخامات الأولى بالورشة: مرفوض
    fabric0 = await _item(session, meter)
    await _stock(session, fabric0, raw, 100)
    prod, variant = await _product(session)
    res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 5, "season": "summer"}],
        "custom_materials": [{"item_id": fabric0.id, "unit_id": meter.id, "planned_quantity": 10}],
    })
    early_order = res.json()["id"]
    assert (await a["wh"].post(f"{API}/production/orders/{early_order}/dispatch")).status_code == 200
    early = await a["wh"].post(f"{API}/production/orders/{early_order}/extra-issues", json={
        "reason": "مبكر", "lines": [{"item_id": fabric0.id, "quantity": 1}],
    })
    assert early.status_code == 409

    order_id, fabric = await _order_in_production(session, a)
    url = f"{API}/production/orders/{order_id}/extra-issues"

    # الصلاحية: مسؤول الإنتاج والمدير المالي لا يصرفان
    for actor in ("pm", "fm"):
        res = await a[actor].post(url, json={"reason": "سبب", "lines": [{"item_id": fabric.id, "quantity": 1}]})
        assert res.status_code == 403, actor

    # تحقق المدخلات
    assert (await a["wh"].post(url, json={"reason": "  ", "lines": [{"item_id": fabric.id, "quantity": 1}]})).status_code == 422
    assert (await a["wh"].post(url, json={"reason": "سبب", "lines": []})).status_code == 422
    assert (await a["wh"].post(url, json={"reason": "سبب", "lines": [{"item_id": fabric.id, "quantity": 0}]})).status_code == 422
    dup = await a["wh"].post(url, json={"reason": "سبب", "lines": [{"item_id": fabric.id, "quantity": 1}, {"item_id": fabric.id, "quantity": 2}]})
    assert dup.status_code == 422

    # لا رصيد سالب: المتاح 150
    short = await a["wh"].post(url, json={"reason": "سبب", "lines": [{"item_id": fabric.id, "quantity": 151}]})
    assert short.status_code == 409 and "المتاح 150" in short.text
    assert await stock_balance(session, fabric.id, raw.id) == pytest.approx(150)

    # المنتج التام لا يُصرف كخامة
    # صنف منتج تام حقيقي (FG-VAR-*) بنفس قواعد الدليل، لا صنف خامة معدَّل
    fg_prod, fg_variant = await _product(session)
    fg = await get_or_create_finished_goods_item(session, fg_prod.id, fg_variant.id)
    await session.commit()
    res = await a["wh"].post(url, json={"reason": "سبب", "lines": [{"item_id": fg.id, "quantity": 1}]})
    assert res.status_code == 422

    # صرف واحد بالطريق في كل مرة
    first = await a["wh"].post(url, json={"reason": "أول", "lines": [{"item_id": fabric.id, "quantity": 5}]})
    assert first.status_code == 201, first.text
    second = await a["wh"].post(url, json={"reason": "ثان", "lines": [{"item_id": fabric.id, "quantity": 5}]})
    assert second.status_code == 409

    # استلام بكمية أكبر من المصروف مرفوض، ومستند غير موجود 404
    over = await a["pm"].post(f"{url}/{first.json()['id']}/receive", json={"received_lines": [{"item_id": fabric.id, "received_quantity": 6}]})
    assert over.status_code == 409
    missing = await a["pm"].post(f"{url}/{uuid.uuid4()}/receive", json={"received_lines": []})
    assert missing.status_code == 404

    # لا تُعدَّل قيود الصرف المرحَّلة: الحركات الخاصة بالمستند ثابتة بعد الرفض
    entries = await session.scalar(select(func.count()).select_from(StockLedgerEntry).where(StockLedgerEntry.reference_doc_id == first.json()["id"]))
    assert entries == 2
