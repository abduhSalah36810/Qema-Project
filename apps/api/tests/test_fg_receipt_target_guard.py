"""
اختبارات حارس استلام المنتج التام (FG Receipt Target Guard - بند 1 من تجربة المالك)
─────────────────────────────────────────────────────────────────────────────
السيناريو الذي رصده المالك يدويًا:
أمر 50 قطعة، وأُدخل في شاشة استلام المنتج التام 50 سليم + 3 مرفوض (إجمالي 53) فقُبل.
المطلوب: رفض أي استلام يجعل (السليم السابق + المرفوض السابق + السليم الآن + المرفوض الآن)
أكبر من المستهدف للبند — برفض 409 ورسالة واضحة، دون أي تغيير في الأرصدة.

الدورة تمر عبر واجهات API الفعلية (لا mocks) مثل test_operational_cycle_e2e.
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
    ProductionOrder,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.service import get_or_create_finished_goods_item
from app.modules.production.stock import stock_balance

GM, WH, PM = "general_manager", "warehouse_manager", "production_manager"


def _uid() -> str:
    return str(uuid.uuid4())


def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


def _user(user_id: str, role: str) -> AuthenticatedUser:
    # الدور في app_metadata (يتحكم فيه الخادم) — لا نضعه في user_metadata
    return AuthenticatedUser(id=user_id, email=f"{user_id}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    def __init__(self, client: AsyncClient, user: AuthenticatedUser):
        self.client = client
        self.user = user

    async def _call(self, method: str, url: str, **kwargs):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kwargs)

    async def get(self, url, **kw):
        return await self._call("GET", url, **kw)

    async def post(self, url, **kw):
        return await self._call("POST", url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    actors = {
        "gm": Actor(client, _user("fg-guard-gm", GM)),
        "wh": Actor(client, _user("fg-guard-wh", WH)),
        "pm": Actor(client, _user("fg-guard-pm", PM)),
    }
    yield session, actors
    await client.aclose()
    app.dependency_overrides.clear()


async def _warehouse(session: AsyncSession, code: str) -> Warehouse:
    return (await session.scalar(select(Warehouse).where(Warehouse.code == code)))  # type: ignore[return-value]


async def _unit(session: AsyncSession, code: str) -> Unit:
    return (await session.scalar(select(Unit).where(Unit.code == code)))  # type: ignore[return-value]


async def _approved_item(session: AsyncSession, name: str, unit: Unit) -> CatalogItem:
    item = CatalogItem(
        id=_uid(), code=f"FGG-{_tag()}", name_ar=f"{name} {_tag()}", item_type="raw_material", unit_id=unit.id,
        is_active=True, approval_status="approved", classification_status="confirmed",
    )
    session.add(item)
    await session.commit()
    return item


async def _stock_raw(session: AsyncSession, item: CatalogItem, warehouse: Warehouse, qty: float, unit_cost: str) -> None:
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item.id, unit_id=item.unit_id, warehouse_id=warehouse.id, location_type="warehouse",
        quantity=qty, reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_tag()}",
        entry_type="opening_balance", created_by="fg-guard", unit_cost=Decimal(unit_cost),
        total_cost=(Decimal(str(qty)) * Decimal(unit_cost)).quantize(Decimal("0.01")),
    ))
    await session.commit()


async def _order_in_production(session: AsyncSession, a, target: int = 50, planned_fabric: float = 100.0):
    """أمر داخلي جاهز للاستلام: صرف ← استلام ورشة ← إتمام المراحل الخمس."""
    raw = await _warehouse(session, "main_raw_materials")
    meter, piece = await _unit(session, "meter"), await _unit(session, "piece")
    fabric = await _approved_item(session, "قماش حارس الاستلام", meter)
    await _stock_raw(session, fabric, raw, 500, "25")
    prod = Product(id=_uid(), code=f"PRD-{_tag()}", name_ar=f"منتج حارس الاستلام {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    session.add(variant)
    await session.commit()

    res = await a["pm"].post("/api/v1/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": target, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": planned_fabric}],
        "notes": "أمر حارس استلام المنتج التام",
    })
    assert res.status_code == 201, res.text
    order = res.json()
    order_id = order["id"]
    order_item = order["items"][0]

    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف"})
    assert res.status_code == 200, res.text
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": planned_fabric}], "notes": "",
    })
    assert res.status_code == 200, res.text
    for stage in ["cutting", "finishing", "snap_installation", "ironing", "packing"]:
        for status_value in ("in_progress", "completed"):
            res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/stages/{stage}", json={"status": status_value})
            assert res.status_code == 200, res.text
    return session, order_id, order_item, fabric


@pytest.mark.asyncio
async def test_rejected_quantity_cannot_exceed_target(ctx):
    """50 سليم + 3 مرفوض على أمر 50 قطعة يُرفض 409، ولا يتغير أي رصيد."""
    session, a = ctx
    fg_wh = await _warehouse(session, "finished_goods")
    _, order_id, order_item, _fabric = await _order_in_production(session, a, target=50)
    fg_item = await get_or_create_finished_goods_item(session, order_item["product_id"], order_item["variant_id"])

    # المحاولة المرفوضة من المالك: 50 سليم + 3 مرفوض = 53 > 50
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 50, "rejected_quantity": 3}],
        "notes": "تجربة المالك",
    })
    assert res.status_code == 409, res.text
    assert "تتجاوز الكمية المستهدفة" in res.json()["detail"]
    assert "53" in res.json()["detail"]
    # لا قيد مخزني ناتج عن الرفض
    assert await stock_balance(session, fg_item.id, fg_wh.id, bucket_reference="factory_brand") == 0.0

    # الاستلام الصحيح المسموح: 47 سليم + 3 مرفوض = 50 = المستهدف
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 47, "rejected_quantity": 3}],
        "notes": "استلام سليم ومرفوض بالسقف",
    })
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["accepted_quantity"] == 47 and body["rejected_quantity"] == 3
    line = body["lines"][0]
    assert line["total_received"] == 47
    assert line["remaining_quantity"] == 0, "المتبقي يُحسب بخصم المرفوض أيضاً"
    assert await stock_balance(session, fg_item.id, fg_wh.id, bucket_reference="factory_brand") == 47.0

    # بعد اكتمال السقف: أي إضافة سليم أو مرفوض تُرفض
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 1}],
    })
    assert res.status_code == 409
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 0, "rejected_quantity": 1}],
    })
    assert res.status_code == 409

    order = await session.get(ProductionOrder, order_id)
    await session.refresh(order)
    assert order.status == "receipt_completed"


@pytest.mark.asyncio
async def test_over_rejection_then_topup_is_rejected(ctx):
    """قبول 47 سليم + 1 مرفوض على أمر 50 ثم محاولة استكمال 3 سليم تُرفض لأن السقف (السليم + المرفوض) اكتمل."""
    session, a = ctx
    _, order_id, order_item, _fabric = await _order_in_production(session, a, target=50)

    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 47, "rejected_quantity": 1}],
    })
    assert res.status_code == 201, res.text

    # متاح بعد الاستلام: 50 − 47 − 1 = 2 فقط
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 3}],
    })
    assert res.status_code == 409, res.text
    assert "المتبقي بعد الاستلام (-1)" in res.json()["detail"]

    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": 2}],
    })
    assert res.status_code == 201, res.text
