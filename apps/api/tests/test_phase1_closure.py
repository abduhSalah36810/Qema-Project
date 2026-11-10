"""
اختبارات إغلاق المرحلة الأولى (قرارات المالك 2026-11-09):
A. مرتجعات الورشة المضبوطة (بالطريق ← فحص المخزن ← تسوية معتمدة ← الإغلاق).
B. طلب سداد كامل المستحق من المخزن دون رؤية المبالغ.
C. Maker-Checker على مصدر كشف الرواتب.
D. تتبع منفذ كل خطوة في المنتج التام دون ادعاء فصل صرف/استلام غير موجود.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID
from app.modules.finance.models import CashDocument
from app.modules.production.models import (
    CatalogItem,
    PayPeriodEvent,
    Product,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.modules.production.stock import stock_balance

GM, WH, PM, FM = "general_manager", "warehouse_manager", "production_manager", "finance_manager"
API = "/api/v1"
STAGES = ["cutting", "finishing", "snap_installation", "ironing", "packing"]


def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


def _user(user_id: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(id=user_id, email=f"{user_id}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    def __init__(self, client: AsyncClient, user: AuthenticatedUser):
        self.client, self.user = client, user

    async def call(self, method: str, url: str, **kw):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kw)

    async def get(self, url, **kw):
        return await self.call("GET", url, **kw)

    async def post(self, url, **kw):
        return await self.call("POST", url, **kw)

    async def patch(self, url, **kw):
        return await self.call("PATCH", url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    tag = _tag()
    actors = {
        "gm": Actor(client, _user(f"p1-gm-{tag}", GM)),
        "gm2": Actor(client, _user(f"p1-gm2-{tag}", GM)),
        "wh": Actor(client, _user(f"p1-wh-{tag}", WH)),
        "pm": Actor(client, _user(f"p1-pm-{tag}", PM)),
        "fm": Actor(client, _user(f"p1-fm-{tag}", FM)),
        "fm2": Actor(client, _user(f"p1-fm2-{tag}", FM)),
    }
    yield session, actors
    await client.aclose()
    app.dependency_overrides.clear()


async def _wh(session, code) -> Warehouse:
    return await session.scalar(select(Warehouse).where(Warehouse.code == code))


async def _unit(session, code) -> Unit:
    return await session.scalar(select(Unit).where(Unit.code == code))


async def _item(session, unit) -> CatalogItem:
    item = CatalogItem(
        id=str(uuid.uuid4()), code=f"P1-{_tag()}", name_ar=f"خامة إغلاق {_tag()}", item_type="raw_material",
        unit_id=unit.id, is_active=True, approval_status="approved", classification_status="confirmed",
    )
    session.add(item)
    await session.commit()
    return item


async def _stock(session, item, warehouse, qty: float, cost: str = "10") -> None:
    session.add(StockLedgerEntry(
        id=str(uuid.uuid4()), item_id=item.id, unit_id=item.unit_id, warehouse_id=warehouse.id,
        location_type="warehouse", quantity=qty, reference_doc_type="opening_balance",
        reference_doc_id=f"OPEN-{_tag()}", entry_type="opening_balance", created_by="p1-test",
        unit_cost=Decimal(cost), total_cost=(Decimal(str(qty)) * Decimal(cost)).quantize(Decimal("0.01")),
    ))
    await session.commit()


async def _product(session):
    prod = Product(id=str(uuid.uuid4()), code=f"PRD-{_tag()}", name_ar=f"جلابية إغلاق {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variant = ProductVariant(id=str(uuid.uuid4()), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    session.add(variant)
    await session.commit()
    return prod, variant


async def _raw_usable(session, item) -> float:
    raw = await _wh(session, "main_raw_materials")
    return await stock_balance(session, item.id, raw.id)


async def _discrepancy_balance(session, item, bucket) -> float:
    value = await session.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0)).where(
            StockLedgerEntry.item_id == item.id,
            StockLedgerEntry.location_type == "discrepancy",
            StockLedgerEntry.bucket_reference == bucket,
        )
    )
    return round(float(value or 0.0), 6)


async def _order_ready_for_reconciliation(session, a, *, dispatcher="wh", wip_receiver="pm", fg_receiver="wh"):
    """أمر بخامة واحدة: صُرفت 50، استُلمت كاملة بالورشة، اكتملت المراحل، واستُلم التام كاملاً."""
    raw = await _wh(session, "main_raw_materials")
    meter = await _unit(session, "meter")
    fabric = await _item(session, meter)
    await _stock(session, fabric, raw, 200)
    prod, variant = await _product(session)
    res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 10, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": 50}],
    })
    assert res.status_code == 201, res.text
    order_id = res.json()["id"]
    res = await a[dispatcher].post(f"{API}/production/orders/{order_id}/dispatch")
    assert res.status_code == 200, res.text
    res = await a[wip_receiver].post(f"{API}/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 50}], "notes": "",
    })
    assert res.status_code == 200, res.text
    for stage in STAGES:
        for value in ("in_progress", "completed"):
            res = await a["pm"].post(f"{API}/production/orders/{order_id}/stages/{stage}", json={"status": value})
            assert res.status_code == 200, res.text
    res = await a[fg_receiver].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 10})
    assert res.status_code == 201, res.text
    return order_id, fabric


async def _reconcile_with_return(a, order_id, fabric, *, consumed=30, returned=20, condition="good", notes=""):
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/material-reconciliations", json={
        "lines": [{
            "item_id": fabric.id, "consumed_quantity": consumed, "returned_quantity": returned,
            "return_condition": condition, "notes": notes,
        }],
    })
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["return_transfer_id"]
    return body["return_transfer_id"]


CLOSE_BODY = {"discrepancy_signoff": True, "discrepancy_notes": "مراجعة", "under_production_reason": "—"}


# ═════════════════════════════════════════════════════════════════════════════
# A. مرتجعات الورشة
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_return_does_not_increase_usable_stock_before_warehouse_confirmation(ctx):
    session, a = ctx
    order_id, fabric = await _order_ready_for_reconciliation(session, a)
    before = await _raw_usable(session, fabric)
    transfer_id = await _reconcile_with_return(a, order_id, fabric)

    assert await _raw_usable(session, fabric) == before, "المرتجع لا يدخل الرصيد القابل للصرف قبل الفحص"
    in_transit = await session.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0)).where(
            StockLedgerEntry.location_type == "in_transit", StockLedgerEntry.bucket_reference == transfer_id,
        )
    )
    assert float(in_transit) == 20.0

    returns = (await a["wh"].get(f"{API}/production/orders/{order_id}/returns")).json()
    assert [r["id"] for r in returns] == [transfer_id]
    assert returns[0]["awaiting_receipt"] is True
    order = (await a["wh"].get(f"{API}/production/orders/{order_id}")).json()
    assert order["returns_awaiting_receipt"] == 1
    assert order["returns_pending_declared_by"] == [a["pm"].user.id]
    listed = next(o for o in (await a["wh"].get(f"{API}/production/orders")).json() if o["id"] == order_id)
    assert listed["returns_awaiting_receipt"] == 1

    # مسؤول الإنتاج لا يؤكد استلام المخزن، ومن سجّل المرتجع لا يستلمه
    body = {"lines": [{"item_id": fabric.id, "accepted_quantity": 20}]}
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive", json=body)
    assert res.status_code == 403
    res = await a["wh"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive", json=body)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "received_confirmed"
    assert await _raw_usable(session, fabric) == before + 20


@pytest.mark.asyncio
async def test_return_recorder_cannot_confirm_own_return_even_as_general_manager(ctx):
    session, a = ctx
    order_id, fabric = await _order_ready_for_reconciliation(session, a)
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/material-reconciliations", json={
        "lines": [{"item_id": fabric.id, "consumed_quantity": 40, "returned_quantity": 10}],
    })
    assert res.status_code == 201, res.text
    transfer_id = res.json()["return_transfer_id"]
    body = {"lines": [{"item_id": fabric.id, "accepted_quantity": 10}]}
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive", json=body)
    assert res.status_code == 409
    res = await a["gm2"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive", json=body)
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_workshop_receipt_selects_dispatch_transfer_not_a_later_return(ctx):
    """استلام الورشة يختار تحويل الصرف (خامات ← ورشة) ولا يختار تحويلاً عكسياً أحدث للأمر نفسه."""
    session, a = ctx
    raw = await _wh(session, "main_raw_materials")
    wip = await _wh(session, "work_in_progress")
    meter = await _unit(session, "meter")
    fabric = await _item(session, meter)
    await _stock(session, fabric, raw, 100)
    prod, variant = await _product(session)
    res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 5, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": 15}],
    })
    order_id = res.json()["id"]
    res = await a["wh"].post(f"{API}/production/orders/{order_id}/dispatch")
    assert res.status_code == 200, res.text
    dispatch_id = res.json()["id"]

    # تحويل عكسي (ورشة ← خامات) أحدث تاريخاً للأمر نفسه
    decoy = WarehouseTransfer(
        id=str(uuid.uuid4()), transfer_number=f"RT-DECOY-{_tag()}", order_id=order_id,
        source_warehouse_id=wip.id, destination_warehouse_id=raw.id, status="in_transit",
        dispatched_at=datetime.now(timezone.utc) + timedelta(hours=1), dispatched_by="someone-else",
    )
    session.add(decoy)
    await session.flush()
    session.add(WarehouseTransferLine(
        id=str(uuid.uuid4()), transfer_id=decoy.id, item_id=fabric.id, unit_id=meter.id,
        dispatched_quantity=1.0, received_quantity=0.0, discrepancy_quantity=0.0,
    ))
    await session.commit()

    res = await a["pm"].post(f"{API}/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 15}], "notes": "",
    })
    assert res.status_code == 200, res.text
    assert res.json()["id"] == dispatch_id
    assert res.json()["destination_warehouse_id"] == wip.id
    await session.refresh(decoy)
    assert decoy.status == "in_transit" and decoy.received_by is None

    # قائمة المرتجعات لا تعرض تحويل الصرف
    returns = (await a["pm"].get(f"{API}/production/orders/{order_id}/returns")).json()
    assert [r["id"] for r in returns] == [decoy.id]


@pytest.mark.asyncio
async def test_partial_return_with_shortage_and_rejected_requires_explanation_and_segregates(ctx):
    session, a = ctx
    order_id, fabric = await _order_ready_for_reconciliation(session, a)
    before = await _raw_usable(session, fabric)
    transfer_id = await _reconcile_with_return(
        a, order_id, fabric, returned=20, condition="needs_inspection", notes="بعض القطع متسخة",
    )
    url = f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive"

    # يجب ذكر كل الخامات صراحة، والمجموع لا يتجاوز المرتجع، والعجز/المرفوض يحتاج تفسيراً
    res = await a["wh"].post(url, json={"lines": [{"item_id": fabric.id, "accepted_quantity": 15, "rejected_quantity": 3}]})
    assert res.status_code == 422
    res = await a["wh"].post(url, json={"lines": [{"item_id": fabric.id, "accepted_quantity": 18, "rejected_quantity": 3, "notes": "x"}]})
    assert res.status_code == 409
    res = await a["wh"].post(url, json={
        "lines": [{"item_id": fabric.id, "accepted_quantity": 15, "rejected_quantity": 3, "notes": "3 م تالفة بالزيت و2 م غير موجودة"}],
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "pending_resolution"
    line = body["lines"][0]
    assert (line["declared_quantity"], line["accepted_quantity"], line["rejected_quantity"], line["shortage_quantity"]) == (20, 15, 3, 2)
    assert line["rejected_open_quantity"] == 3 and line["shortage_open_quantity"] == 2

    # المقبول فقط يدخل الرصيد القابل للصرف؛ المرفوض معزول خارج المخازن والعجز فرق نقل
    assert await _raw_usable(session, fabric) == before + 15
    assert await _discrepancy_balance(session, fabric, f"return_rejected:{transfer_id}") == 3
    assert await _discrepancy_balance(session, fabric, transfer_id) == 2
    # المرفوض لا يُصنف هالكاً تلقائياً
    scrap = await session.scalar(select(func.count(StockLedgerEntry.id)).where(
        StockLedgerEntry.entry_type == "return_rejected_scrap", StockLedgerEntry.bucket_reference == f"return_rejected:{transfer_id}",
    ))
    assert scrap == 0
    order = (await a["pm"].get(f"{API}/production/orders/{order_id}")).json()
    assert order["returns_awaiting_resolution"] == 1


@pytest.mark.asyncio
async def test_closure_blocked_until_returns_received_and_resolved(ctx):
    session, a = ctx
    order_id, fabric = await _order_ready_for_reconciliation(session, a)
    before = await _raw_usable(session, fabric)
    transfer_id = await _reconcile_with_return(a, order_id, fabric, returned=20)
    close_url = f"{API}/production/orders/{order_id}/close"

    # 1) المرتجع بالطريق
    res = await a["pm"].post(close_url, json=CLOSE_BODY)
    assert res.status_code == 409 and "مرتجعات" in res.json()["detail"]
    summary = (await a["pm"].get(f"{API}/production/orders/{order_id}/wip-summary")).json()
    assert summary["can_close"] is False

    # 2) مستلم بعجز ومرفوض غير مسوّيين
    res = await a["wh"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive", json={
        "lines": [{"item_id": fabric.id, "accepted_quantity": 14, "rejected_quantity": 4, "notes": "4 تالفة، 2 مفقودة"}],
    })
    assert res.status_code == 200, res.text
    res = await a["pm"].post(close_url, json=CLOSE_BODY)
    assert res.status_code == 409 and "تُسوَّ" in res.json()["detail"]
    summary = (await a["pm"].get(f"{API}/production/orders/{order_id}/wip-summary")).json()
    assert any("مرتجع ورشة" in reason for reason in summary["blocking_reasons"])

    # 3) التسوية المعتمدة
    resolve_url = f"{API}/production/orders/{order_id}/returns/{transfer_id}/resolve"
    shortage = {"item_id": fabric.id, "kind": "shortage", "disposition": "write_off", "quantity": 2, "reason": "لم يُعثر عليها بعد البحث"}
    res = await a["wh"].post(resolve_url, json={"lines": [shortage]})
    assert res.status_code == 403, "أمين المخزن لا يسوّي ما أثبته"
    res = await a["pm"].post(resolve_url, json={"lines": [{**shortage, "quantity": 3}]})
    assert res.status_code == 409, "لا تتجاوز التسوية العجز المعلق"
    res = await a["pm"].post(resolve_url, json={"lines": [
        shortage,
        {"item_id": fabric.id, "kind": "rejected", "disposition": "restock", "quantity": 1, "reason": "بعد الغسيل صالحة"},
    ]})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "pending_resolution"  # بقي 3 مرفوض
    res = await a["pm"].post(close_url, json=CLOSE_BODY)
    assert res.status_code == 409

    res = await a["pm"].post(resolve_url, json={"lines": [
        {"item_id": fabric.id, "kind": "rejected", "disposition": "scrap", "quantity": 3, "reason": "تالفة نهائياً"},
    ]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "received_confirmed"
    line = body["lines"][0]
    assert line["rejected_restocked_quantity"] == 1 and line["rejected_scrapped_quantity"] == 3
    assert line["shortage_open_quantity"] == 0 and line["rejected_open_quantity"] == 0
    assert "تالفة نهائياً" in line["notes"] and "بعد الغسيل صالحة" in line["notes"]
    assert await _raw_usable(session, fabric) == before + 15  # 14 مقبول + 1 أعيد بقرار

    res = await a["pm"].post(close_url, json=CLOSE_BODY)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_return_receiver_cannot_resolve_own_findings(ctx):
    session, a = ctx
    order_id, fabric = await _order_ready_for_reconciliation(session, a)
    transfer_id = await _reconcile_with_return(a, order_id, fabric, returned=10)
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/receive", json={
        "lines": [{"item_id": fabric.id, "accepted_quantity": 9, "notes": "متر مفقود"}],
    })
    assert res.status_code == 200, res.text
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/resolve", json={"lines": [
        {"item_id": fabric.id, "kind": "shortage", "disposition": "write_off", "quantity": 1, "reason": "فقد"},
    ]})
    assert res.status_code == 409
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/returns/{transfer_id}/resolve", json={"lines": [
        {"item_id": fabric.id, "kind": "shortage", "disposition": "write_off", "quantity": 1, "reason": "فقد"},
    ]})
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_damaged_return_requires_condition_notes(ctx):
    session, a = ctx
    order_id, fabric = await _order_ready_for_reconciliation(session, a)
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/material-reconciliations", json={
        "lines": [{"item_id": fabric.id, "consumed_quantity": 40, "returned_quantity": 10, "return_condition": "damaged"}],
    })
    assert res.status_code == 422


# ═════════════════════════════════════════════════════════════════════════════
# B. طلب سداد كامل المستحق من المخزن
# ═════════════════════════════════════════════════════════════════════════════

async def _fund(a, amount: str) -> None:
    res = await a["fm"].post(f"{API}/finance/cash-documents", json={
        "document_type": "income", "to_account_id": CANONICAL_TREASURY_ID, "amount": amount,
        "description": "تمويل اختبار الإغلاق", "occurred_at": datetime.now(timezone.utc).isoformat(),
    })
    assert res.status_code == 201, res.text
    # مستند المدير المالي يُعتمد ويُرحّل لحظة إنشائه
    assert res.json()["status"] == "approved", res.text


@pytest.mark.asyncio
async def test_warehouse_full_balance_request_hides_amount_and_blocks_duplicates(ctx):
    session, a = ctx
    meter = await _unit(session, "meter")
    fabric = await _item(session, meter)
    await _fund(a, "5000.00")
    res = await a["wh"].post(f"{API}/finance/suppliers", json={"code": f"SUP-{_tag()}", "name": "مورد السداد الكامل"})
    supplier_id = res.json()["id"]
    res = await a["wh"].post(f"{API}/finance/supplier-invoices", json={
        "supplier_id": supplier_id, "invoice_number": f"INV-{_tag()}", "invoice_date": datetime.now(timezone.utc).isoformat(),
        "lines": [{"item_id": fabric.id, "unit_id": meter.id, "invoiced_quantity": 10, "unit_price": "50"}],
    })
    assert res.status_code == 201, res.text
    invoice = res.json()
    full_url = f"{API}/finance/supplier-invoices/{invoice['id']}/payment-requests/full-balance"

    # لم يُستلم شيء بعد
    res = await a["wh"].post(full_url, json={})
    assert res.status_code == 409

    res = await a["wh"].post(f"{API}/finance/supplier-invoices/{invoice['id']}/receive", json={
        "lines": [{"line_id": invoice["lines"][0]["id"], "received_quantity": 6}],
    })
    assert res.status_code == 200, res.text
    wh_view = next(i for i in (await a["wh"].get(f"{API}/finance/supplier-invoices")).json() if i["id"] == invoice["id"])
    assert wh_view["can_request_full_balance"] is True
    assert Decimal(str(wh_view["payable_balance"])) == 0 and Decimal(str(wh_view["invoice_total"])) == 0

    res = await a["wh"].post(full_url, json={"notes": "المورد طالب بالسداد"})
    assert res.status_code == 201, res.text
    ack = res.json()
    assert not any(word in key for key in ack for word in ("amount", "total", "balance", "price"))
    assert ack["status"] == "pending"

    # المالية ترى المبلغ الفعلي في الخزينة: قيمة المستلم فقط (6 × 50)
    doc = await session.scalar(select(CashDocument).where(CashDocument.document_number == ack["cash_document_number"]))
    assert doc.amount == Decimal("300.00") and doc.status == "pending"
    fm_docs = (await a["fm"].get(f"{API}/finance/cash-documents", params={"status": "pending"})).json()
    assert any(d["id"] == doc.id and Decimal(str(d["amount"])) == Decimal("300.00") for d in fm_docs)
    res = await a["wh"].get(f"{API}/finance/cash-documents")
    assert res.status_code == 403

    # لا طلب مكرر، ولا اعتماد من المخزن، والاعتماد من الخزينة
    res = await a["wh"].post(full_url, json={})
    assert res.status_code == 409
    wh_view = next(i for i in (await a["wh"].get(f"{API}/finance/supplier-invoices")).json() if i["id"] == invoice["id"])
    assert wh_view["has_pending_payment_request"] is True and wh_view["can_request_full_balance"] is False
    res = await a["wh"].post(f"{API}/finance/cash-documents/{doc.id}/decision", json={"decision": "approve"})
    assert res.status_code == 403
    res = await a["fm"].post(f"{API}/finance/cash-documents/{doc.id}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text

    # بعد السداد لا مستحق عن المستلم؛ لا طلب زائد
    res = await a["wh"].post(full_url, json={})
    assert res.status_code == 409
    fm_view = next(i for i in (await a["fm"].get(f"{API}/finance/supplier-invoices")).json() if i["id"] == invoice["id"])
    assert Decimal(str(fm_view["paid_total"])) == Decimal("300.00")


# ═════════════════════════════════════════════════════════════════════════════
# C. Maker-Checker على مصدر كشف الرواتب
# ═════════════════════════════════════════════════════════════════════════════

async def _prepared_period(a, preparer: str) -> dict:
    tag = _tag()
    res = await a["fm"].post(f"{API}/payroll/employees", json={"code": f"EMP-{tag}", "name": f"موظف اختبار {tag}", "base_salary": 1000})
    assert res.status_code == 201, res.text
    start = datetime(2300, 1, 1, tzinfo=timezone.utc) + timedelta(days=int(uuid.uuid4().int % 200000))
    res = await a["fm"].post(f"{API}/payroll/periods", json={
        "period_name": f"فترة {tag}", "start_date": start.isoformat(), "end_date": (start + timedelta(hours=12)).isoformat(),
    })
    assert res.status_code == 201, res.text
    period_id = res.json()["id"]
    res = await a[preparer].post(f"{API}/payroll/periods/{period_id}/calculate")
    assert res.status_code == 200, res.text
    return res.json()


async def _payroll_document_id(session, period_id: str) -> str:
    doc = await session.scalar(select(CashDocument).where(
        CashDocument.source_system == "payroll", CashDocument.source_reference == period_id,
    ))
    return doc.id


@pytest.mark.asyncio
async def test_general_manager_prepares_payroll_cannot_approve_disbursement(ctx):
    session, a = ctx
    detail = await _prepared_period(a, "gm")
    period_id = detail["period"]["id"]
    await _fund(a, f"{Decimal(str(detail['total_net'])) + 100:.2f}")
    # المدير العام أعد الكشف وقدّمه للصرف: يبقى معلقاً حتى يعتمده المدير المالي
    res = await a["gm"].post(f"{API}/payroll/periods/{period_id}/disburse")
    assert res.status_code == 200, res.text
    assert res.json()["period"]["status"] == "submitted"
    doc_id = await _payroll_document_id(session, period_id)

    # قائمة "ما أستطيع اعتماده" لا تعرض السند لمن أعد الكشف، وتعرضه للمدير المالي
    mine = (await a["gm"].get(f"{API}/finance/cash-documents", params={"approvable_by_me": "true"})).json()
    assert doc_id not in {d["id"] for d in mine}
    others = (await a["fm"].get(f"{API}/finance/cash-documents", params={"approvable_by_me": "true"})).json()
    assert doc_id in {d["id"] for d in others}

    res = await a["gm"].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 409
    res = await a["gm2"].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text

    actions = (await session.execute(select(PayPeriodEvent.action, PayPeriodEvent.actor_id).where(
        PayPeriodEvent.period_id == period_id,
    ))).all()
    assert ("calculate", a["gm"].user.id) in actions
    assert ("submit_for_disbursement", a["gm"].user.id) in actions


@pytest.mark.asyncio
async def test_finance_manager_prepares_and_disburses_payroll_immediately(ctx):
    """قرار المصنع: المدير المالي يعد الكشف ويصرفه دون جهة اعتماد؛ السند يُعتمد ويُخصم لحظة التقديم."""
    session, a = ctx
    detail = await _prepared_period(a, "fm")
    period_id = detail["period"]["id"]
    total = Decimal(str(detail["total_net"]))
    await _fund(a, f"{total + 100:.2f}")
    res = await a["fm"].post(f"{API}/payroll/periods/{period_id}/disburse")
    assert res.status_code == 200, res.text
    assert res.json()["period"]["status"] == "paid"
    doc = await session.scalar(select(CashDocument).where(
        CashDocument.source_system == "payroll", CashDocument.source_reference == period_id,
    ))
    assert doc.status == "approved" and doc.approved_by == a["fm"].user.id


@pytest.mark.asyncio
async def test_finance_prepares_and_adjusts_payroll_cannot_approve_disbursement(ctx):
    session, a = ctx
    detail = await _prepared_period(a, "fm")
    period_id = detail["period"]["id"]
    run_id = detail["runs"][0]["id"]
    # تعديل الكشف من مستخدم ثانٍ يجعله من المُعدّين أيضاً
    res = await a["fm2"].patch(f"{API}/payroll/periods/{period_id}/runs/{run_id}", json={"bonus_amount": "50.00", "reason": "حافز معتمد"})
    assert res.status_code == 200, res.text
    total = Decimal(str(res.json()["total_net"]))
    await _fund(a, f"{total + 100:.2f}")
    res = await a["gm"].post(f"{API}/payroll/periods/{period_id}/disburse")
    assert res.status_code == 200, res.text
    doc_id = await _payroll_document_id(session, period_id)

    for preparer in ("fm", "fm2"):
        res = await a[preparer].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
        assert res.status_code == 409, preparer
    res = await a["gm"].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 409, "منشئ السند لا يعتمده"
    res = await a["gm2"].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text


# ═════════════════════════════════════════════════════════════════════════════
# D. تتبع منفذ خطوات المنتج التام
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_finished_goods_actors_are_recorded(ctx):
    session, a = ctx
    order_id, _ = await _order_ready_for_reconciliation(session, a)
    order = (await a["pm"].get(f"{API}/production/orders/{order_id}")).json()
    packing = [e for e in order["stage_events"] if e["stage_name"] == "packing"]
    assert packing and all(e["actor_id"] == a["pm"].user.id for e in packing)
    receipt_actors = (await session.execute(select(StockLedgerEntry.created_by).where(
        StockLedgerEntry.reference_doc_id == order_id, StockLedgerEntry.entry_type == "finished_goods_receipt",
    ))).scalars().all()
    assert receipt_actors and set(receipt_actors) == {a["wh"].user.id}

    # مسؤول الإنتاج لا يستلم التام
    res = await a["pm"].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 1})
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_general_manager_can_pack_and_receive_finished_goods_with_actor_trace(ctx):
    """المدير العام دور شامل: يسجل التعبئة ويستلم التام، ويُسجل اسمه في كل خطوة (لا مستند صرف للتام)."""
    session, a = ctx
    raw = await _wh(session, "main_raw_materials")
    meter = await _unit(session, "meter")
    fabric = await _item(session, meter)
    await _stock(session, fabric, raw, 50)
    prod, variant = await _product(session)
    res = await a["gm"].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 4, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": 8}],
    })
    order_id = res.json()["id"]
    assert (await a["wh"].post(f"{API}/production/orders/{order_id}/dispatch")).status_code == 200
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 8}], "notes": "",
    })
    assert res.status_code == 200, res.text
    for stage in STAGES:
        for value in ("in_progress", "completed"):
            assert (await a["gm"].post(f"{API}/production/orders/{order_id}/stages/{stage}", json={"status": value})).status_code == 200
    res = await a["gm"].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 4})
    assert res.status_code == 201, res.text

    order = (await a["gm"].get(f"{API}/production/orders/{order_id}")).json()
    assert {e["actor_id"] for e in order["stage_events"] if e["stage_name"] == "packing"} == {a["gm"].user.id}
    receipt_actors = (await session.execute(select(StockLedgerEntry.created_by).where(
        StockLedgerEntry.reference_doc_id == order_id, StockLedgerEntry.entry_type == "finished_goods_receipt",
    ))).scalars().all()
    assert set(receipt_actors) == {a["gm"].user.id}
