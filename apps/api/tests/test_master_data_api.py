"""
اختبارات البيانات الأساسية القابلة للتعديل من الواجهة: الموديلات والمقاسات والموردون.
تتحقق من الصلاحيات، ومنع التكرار، وأن التعديل لا يمس السجلات التاريخية.
"""
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.production.service import get_or_create_finished_goods_item


def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


def _user(user_id: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(id=user_id, email=f"{user_id}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    def __init__(self, client: AsyncClient, user: AuthenticatedUser):
        self.client, self.user = client, user

    async def request(self, method: str, url: str, **kw):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kw)


@pytest.fixture
async def actors(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    yield {
        "gm": Actor(client, _user("md-gm", "general_manager")),
        "pm": Actor(client, _user("md-pm", "production_manager")),
        "wh": Actor(client, _user("md-wh", "warehouse_manager")),
        "fm": Actor(client, _user("md-fm", "finance_manager")),
    }
    await client.aclose()
    app.dependency_overrides.clear()


@pytest.fixture
async def fresh_session_actors(test_engine):
    """كل طلب بجلسة قاعدة بيانات مستقلة مثل الخادم الفعلي (يكشف أخطاء التحميل الكسول للعلاقات)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    factory = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

    async def _fresh_db():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_db] = _fresh_db
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    yield {
        "gm": Actor(client, _user("md-gm", "general_manager")),
        "wh": Actor(client, _user("md-wh", "warehouse_manager")),
    }
    await client.aclose()
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_catalog_governance_endpoints_work_with_fresh_sessions(fresh_session_actors):
    a = fresh_session_actors
    units = (await a["gm"].request("GET", "/api/v1/catalog/units")).json()
    cats = (await a["gm"].request("GET", "/api/v1/catalog/categories")).json()

    def flat(nodes):
        for n in nodes:
            yield n
            yield from flat(n.get("children") or [])

    category = next(c for c in flat(cats) if c["code"] == "FAB_MAIN")
    res = await a["wh"].request("POST", "/api/v1/catalog/items", json={
        "code": f"FRESH-{_tag()}", "name_ar": "قماش جلسة مستقلة", "item_type": "fabric",
        "unit_id": units[0]["id"], "category_id": category["id"], "classification_status": "confirmed",
    })
    assert res.status_code == 201, res.text
    item_id = res.json()["id"]
    res = await a["wh"].request("POST", f"/api/v1/catalog/items/{item_id}/submit", json={})
    assert res.status_code == 200, res.text
    res = await a["gm"].request("POST", f"/api/v1/catalog/items/{item_id}/approve", json={})
    assert res.status_code == 200, res.text
    assert res.json()["approval_status"] == "approved"
    assert res.json()["unit_name_ar"]

    # قائمة أصناف الإنتاج/المشتريات تعرض حالة الاعتماد الفعلية (كانت تعرض draft دائماً)
    listed = (await a["gm"].request("GET", "/api/v1/production/catalog-items")).json()
    row = next(i for i in listed if i["id"] == item_id)
    assert row["approval_status"] == "approved"
    assert row["classification_status"] == "confirmed"


@pytest.mark.asyncio
async def test_product_create_with_sizes_and_add_size(actors, session):
    code = f"md-{_tag()}"
    res = await actors["pm"].request("POST", "/api/v1/production/products", json={
        "code": code, "name_ar": "جلابية تجريبية", "description": "موديل اختبار",
        "variants": [{"numeric_size": 58, "letter_size": "L"}, {"numeric_size": 56, "season": "winter"}],
    })
    assert res.status_code == 201, res.text
    product = res.json()
    assert product["code"] == code.upper()
    assert [(v["numeric_size"], v["season"]) for v in product["variants"]] == [(56, "winter"), (58, "summer")]
    assert product["variants"][1]["sku"] == f"{code.upper()}-58-SUM"

    # مقاس مكرر لنفس الموسم مرفوض
    dup = await actors["pm"].request("POST", f"/api/v1/production/products/{product['id']}/variants", json=[{"numeric_size": 58}])
    assert dup.status_code == 409

    res = await actors["gm"].request("POST", f"/api/v1/production/products/{product['id']}/variants", json=[{"numeric_size": 60}])
    assert res.status_code == 201, res.text
    assert len(res.json()["variants"]) == 3

    # كود الموديل مكرر مرفوض
    dup = await actors["pm"].request("POST", "/api/v1/production/products", json={"code": code, "name_ar": "x"})
    assert dup.status_code == 409


@pytest.mark.asyncio
async def test_product_rename_keeps_existing_finished_goods_names(actors, session):
    res = await actors["gm"].request("POST", "/api/v1/production/products", json={
        "code": f"MD-{_tag()}", "name_ar": "الاسم القديم", "variants": [{"numeric_size": 58}],
    })
    product = res.json()
    variant_id = product["variants"][0]["id"]
    fg_item = await get_or_create_finished_goods_item(session, product["id"], variant_id)
    await session.commit()
    old_name = fg_item.name_ar

    res = await actors["pm"].request("PATCH", f"/api/v1/production/products/{product['id']}", json={"name_ar": "الاسم الجديد"})
    assert res.status_code == 200, res.text
    assert res.json()["name_ar"] == "الاسم الجديد"
    await session.refresh(fg_item)
    assert fg_item.name_ar == old_name, "تعديل اسم الموديل لا يعيد كتابة الأصناف المسجلة سابقاً"


@pytest.mark.asyncio
async def test_product_management_requires_permission(actors):
    for role in ("wh", "fm"):
        res = await actors[role].request("POST", "/api/v1/production/products", json={"code": f"MD-{_tag()}", "name_ar": "x"})
        assert res.status_code == 403


@pytest.mark.asyncio
async def test_supplier_update_and_permissions(actors):
    res = await actors["wh"].request("POST", "/api/v1/finance/suppliers", json={"code": f"SUP-{_tag()}", "name": "مورد قديم"})
    assert res.status_code == 201
    supplier = res.json()

    res = await actors["fm"].request("PATCH", f"/api/v1/finance/suppliers/{supplier['id']}", json={"name": "مورد معدل", "phone": "0100"})
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "مورد معدل"
    assert res.json()["code"] == supplier["code"]

    res = await actors["pm"].request("PATCH", f"/api/v1/finance/suppliers/{supplier['id']}", json={"name": "x"})
    assert res.status_code == 403

    res = await actors["gm"].request("PATCH", f"/api/v1/finance/suppliers/{uuid.uuid4()}", json={"name": "x"})
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_inventory_report_excludes_transfer_discrepancies_from_warehouse_stock(actors, session):
    """عجز النقل يُسجل في موقع «فروق» بلا مخزن؛ لا يجوز أن يظهر في التقرير كرصيد في «مخزن عام»."""
    from sqlalchemy import select
    from app.modules.production.models import CatalogItem, StockLedgerEntry

    item = (await session.scalars(select(CatalogItem).where(CatalogItem.item_type != "finished_garment").limit(1))).first()
    session.add(StockLedgerEntry(
        id=str(uuid.uuid4()), item_id=item.id, unit_id=item.unit_id, warehouse_id=None,
        location_type="discrepancy", quantity=2.0, reference_doc_type="warehouse_transfer",
        reference_doc_id=f"TR-{_tag()}", entry_type="receipt_discrepancy", created_by="test",
    ))
    await session.commit()

    report = (await actors["gm"].request("GET", "/api/v1/reports/inventory")).json()
    assert all(row["warehouse_id"] for row in report["items"]), "لا صفوف بدون مخزن في أرصدة المخازن"
    assert any(d["item_id"] == item.id and d["quantity"] >= 2.0 for d in report["transfer_discrepancies"])
