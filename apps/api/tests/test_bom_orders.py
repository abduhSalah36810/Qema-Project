"""
مستلزمات التصنيع لكل مقاس (BOM) وأمر التشغيل الموحد بحساب الاحتياجات تلقائياً.
"""
from decimal import Decimal
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
)

API = "/api/v1/production"


def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


def _user(uid, role):
    return AuthenticatedUser(id=uid, email=f"{uid}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    def __init__(self, client, user):
        self.client, self.user = client, user

    async def call(self, method, url, **kw):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    tag = _tag()
    yield session, {
        "pm": Actor(client, _user(f"bom-pm-{tag}", "production_manager")),
        "wh": Actor(client, _user(f"bom-wh-{tag}", "warehouse_manager")),
    }
    await client.aclose()
    app.dependency_overrides.clear()


async def _item(session, unit_code, name, approved=True, stock=None):
    unit = await session.scalar(select(Unit).where(Unit.code == unit_code))
    item = CatalogItem(
        id=str(uuid.uuid4()), code=f"BOM-{_tag()}", name_ar=f"{name} {_tag()}", item_type="raw_material",
        unit_id=unit.id, is_active=approved, approval_status="approved" if approved else "draft",
        classification_status="confirmed",
    )
    session.add(item)
    await session.flush()
    if stock:
        raw = await session.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
        session.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=item.id, unit_id=unit.id, warehouse_id=raw.id, location_type="warehouse",
            quantity=stock, reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_tag()}",
            entry_type="opening_balance", created_by="bom-test", unit_cost=Decimal("1"), total_cost=Decimal(str(stock)),
        ))
    await session.commit()
    return item


async def _product(session, name, sizes):
    prod = Product(id=str(uuid.uuid4()), code=f"P-{_tag()}", name_ar=f"{name} {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variants = {}
    for size in sizes:
        v = ProductVariant(id=str(uuid.uuid4()), product_id=prod.id, numeric_size=size, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
        session.add(v)
        variants[size] = v
    await session.commit()
    return prod, variants


async def _save_bom(actor, variant, lines):
    res = await actor.call("PUT", f"{API}/variants/{variant.id}/bom", json={
        "lines": [{"item_id": item.id, "quantity_per_piece": str(qty)} for item, qty in lines],
    })
    assert res.status_code == 200, res.text
    return res.json()


@pytest.mark.asyncio
async def test_bom_per_size_versioning_and_validation(ctx):
    session, a = ctx
    fabric = await _item(session, "meter", "قماش")
    buttons = await _item(session, "piece", "أزرار")
    draft = await _item(session, "piece", "صنف مسودة", approved=False)
    prod, v = await _product(session, "جلابية", [56, 58])

    b56 = await _save_bom(a["pm"], v[56], [(fabric, "2.5"), (buttons, 6)])
    b58 = await _save_bom(a["pm"], v[58], [(fabric, "2.8"), (buttons, 6)])
    assert b56["version_number"] == 1 and b58["lines"][0]["quantity_per_piece"] in (2.8, 6.0)

    boms = (await a["pm"].call("GET", f"{API}/products/{prod.id}/boms")).json()
    by_size = {x["numeric_size"]: x for x in boms["variants"]}
    fabric_qty = {s: next(l for l in by_size[s]["lines"] if l["item_id"] == fabric.id)["quantity_per_piece"] for s in (56, 58)}
    assert fabric_qty == {56: 2.5, 58: 2.8}, "كل مقاس له كمياته"

    # حفظ جديد = إصدار جديد
    again = await _save_bom(a["pm"], v[56], [(fabric, "2.6"), (buttons, 6)])
    assert again["version_number"] == 2

    dup = await a["pm"].call("PUT", f"{API}/variants/{v[56].id}/bom", json={
        "lines": [{"item_id": fabric.id, "quantity_per_piece": "1"}, {"item_id": fabric.id, "quantity_per_piece": "2"}],
    })
    assert dup.status_code == 422
    bad = await a["pm"].call("PUT", f"{API}/variants/{v[56].id}/bom", json={"lines": [{"item_id": draft.id, "quantity_per_piece": "1"}]})
    assert bad.status_code == 422
    denied = await a["wh"].call("PUT", f"{API}/variants/{v[56].id}/bom", json={"lines": [{"item_id": fabric.id, "quantity_per_piece": "1"}]})
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_requirements_aggregate_by_item_and_compare_stock(ctx):
    session, a = ctx
    buttons = await _item(session, "piece", "أزرار", stock=1500)
    cuffs = await _item(session, "piece", "أساور", stock=250)
    galabeya, gv = await _product(session, "جلابية", [56, 58])
    shirt, sv = await _product(session, "قميص", [40])
    await _save_bom(a["pm"], gv[56], [(buttons, 6), (cuffs, 2)])
    await _save_bom(a["pm"], gv[58], [(buttons, 6)])
    await _save_bom(a["pm"], sv[40], [(buttons, 4)])

    res = await a["pm"].call("POST", f"{API}/orders/requirements", json={"lines": [
        {"product_id": galabeya.id, "variant_id": gv[56].id, "quantity": 100},
        {"product_id": galabeya.id, "variant_id": gv[58].id, "quantity": 50},
        {"product_id": shirt.id, "variant_id": sv[40].id, "quantity": 80},
    ]})
    assert res.status_code == 200, res.text
    body = res.json()
    mats = {m["item_id"]: m for m in body["materials"]}
    assert mats[buttons.id]["required_quantity"] == 1220
    assert mats[buttons.id]["shortage_quantity"] == 0 and mats[buttons.id]["dispatchable_quantity"] == 1220
    assert mats[cuffs.id]["required_quantity"] == 200 and mats[cuffs.id]["available_quantity"] == 250
    assert body["can_create"] is True and body["has_shortage"] is False

    res = await a["pm"].call("POST", f"{API}/orders/requirements", json={"lines": [
        {"product_id": galabeya.id, "variant_id": gv[56].id, "quantity": 150},
    ]})
    cuff = next(m for m in res.json()["materials"] if m["item_id"] == cuffs.id)
    assert cuff["required_quantity"] == 300 and cuff["shortage_quantity"] == 50
    assert res.json()["has_shortage"] is True


@pytest.mark.asyncio
async def test_order_blocked_without_bom_and_listing_missing(ctx):
    session, a = ctx
    buttons = await _item(session, "piece", "أزرار")
    prod, v = await _product(session, "جلابية", [56, 60])
    await _save_bom(a["pm"], v[56], [(buttons, 6)])
    preview = (await a["pm"].call("POST", f"{API}/orders/requirements", json={"lines": [
        {"product_id": prod.id, "variant_id": v[60].id, "quantity": 10},
    ]})).json()
    assert preview["can_create"] is False and preview["lines"][0]["issue"]

    res = await a["pm"].call("POST", f"{API}/orders", json={"items": [
        {"product_id": prod.id, "variant_id": v[56].id, "target_quantity": 10, "season": "summer"},
        {"product_id": prod.id, "variant_id": v[60].id, "target_quantity": 10, "season": "summer"},
    ]})
    assert res.status_code == 422 and "مقاس 60" in res.json()["detail"]


@pytest.mark.asyncio
async def test_unified_order_freezes_bom_and_later_edits_do_not_change_it(ctx):
    session, a = ctx
    fabric = await _item(session, "meter", "قماش")
    buttons = await _item(session, "piece", "أزرار")
    galabeya, gv = await _product(session, "جلابية", [56, 58])
    shirt, sv = await _product(session, "قميص", [40])
    await _save_bom(a["pm"], gv[56], [(fabric, "2.5"), (buttons, 6)])
    await _save_bom(a["pm"], gv[58], [(fabric, "2.8"), (buttons, 6)])
    await _save_bom(a["pm"], sv[40], [(buttons, 4)])

    res = await a["pm"].call("POST", f"{API}/orders", json={"items": [
        {"product_id": galabeya.id, "variant_id": gv[56].id, "target_quantity": 100, "season": "summer"},
        {"product_id": galabeya.id, "variant_id": gv[58].id, "target_quantity": 50, "season": "summer"},
        {"product_id": shirt.id, "variant_id": sv[40].id, "target_quantity": 80, "season": "summer"},
    ]})
    assert res.status_code == 201, res.text
    order = res.json()
    planned = {m["item_id"]: m["planned_quantity"] for m in order["materials"]}
    assert planned == {fabric.id: 390.0, buttons.id: 1220.0}
    line56 = next(i for i in order["items"] if i["variant_id"] == gv[56].id)
    snap = {b["item_id"]: b for b in line56["bom_lines"]}
    assert snap[fabric.id]["quantity_per_piece"] == 2.5 and snap[fabric.id]["total_quantity"] == 250

    # تعديل BOM لاحقاً لا يغير الأمر القائم، ويؤثر على الأوامر الجديدة فقط
    await _save_bom(a["pm"], gv[56], [(fabric, "3"), (buttons, 6)])
    again = (await a["pm"].call("GET", f"{API}/orders/{order['id']}")).json()
    assert {m["item_id"]: m["planned_quantity"] for m in again["materials"]} == planned
    assert next(b for b in next(i for i in again["items"] if i["variant_id"] == gv[56].id)["bom_lines"] if b["item_id"] == fabric.id)["quantity_per_piece"] == 2.5
    new = (await a["pm"].call("POST", f"{API}/orders", json={"items": [
        {"product_id": galabeya.id, "variant_id": gv[56].id, "target_quantity": 10, "season": "summer"},
    ]})).json()
    assert next(m for m in new["materials"] if m["item_id"] == fabric.id)["planned_quantity"] == 30.0

    # خامة من المستلزمات المحفوظة لا تُحذف من مسودة الأمر
    fabric_line = next(m for m in order["materials"] if m["item_id"] == fabric.id)
    res = await a["pm"].call("DELETE", f"{API}/orders/{order['id']}/materials/{fabric_line['id']}")
    assert res.status_code == 409
