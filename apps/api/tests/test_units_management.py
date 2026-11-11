"""
اختبارات إدارة وحدات القياس:
- الإضافة والتعديل والحذف للمدير العام فقط (catalog:units:manage).
- الوحدة المستخدمة في صنف أو حركة أو مستند: لا تُحذف ولا يتغير كودها، ويُسمح بتعديل اسمها.
- الكود والاسم فريدان، والكود يُوحَّد لحروف لاتينية صغيرة.
"""
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.production.models import CatalogItem, Unit


def _as(role: str, session):
    user = AuthenticatedUser(id=f"usr-{role}", email=f"{role}@qemma.test", claims={"sub": f"usr-{role}", "role": role})
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    return user


@pytest.fixture
def client_factory(session):
    def make(role: str) -> AsyncClient:
        _as(role, session)
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    yield make
    app.dependency_overrides.clear()


def _suffix() -> str:
    return uuid.uuid4().hex[:8]


@pytest.mark.asyncio
async def test_only_general_manager_manages_units(client_factory):
    for role in ("warehouse_manager", "production_manager", "finance_manager"):
        async with client_factory(role) as client:
            assert (await client.get("/api/v1/catalog/units/usage")).status_code in (200, 403)
            res = await client.post("/api/v1/catalog/units", json={"code": f"u{_suffix()}", "name_ar": f"وحدة {_suffix()}"})
            assert res.status_code == 403, role


@pytest.mark.asyncio
async def test_create_rename_and_delete_unused_unit(client_factory):
    sfx = _suffix()
    async with client_factory("general_manager") as client:
        res = await client.post("/api/v1/catalog/units", json={"code": f" Yd{sfx} ", "name_ar": f"  ياردة   {sfx} "})
        assert res.status_code == 201, res.text
        unit = res.json()
        assert unit["code"] == f"yd{sfx}"
        assert unit["name_ar"] == f"ياردة {sfx}"
        assert unit["in_use"] is False

        listed = (await client.get("/api/v1/catalog/units/usage")).json()
        assert any(u["id"] == unit["id"] and u["in_use"] is False for u in listed)
        # القائمة القديمة للنماذج تبقى كما هي
        assert any(u["id"] == unit["id"] for u in (await client.get("/api/v1/catalog/units")).json())

        # الكود والاسم فريدان (دون اعتبار حالة الأحرف)
        dup = await client.post("/api/v1/catalog/units", json={"code": f"YD{sfx}", "name_ar": "اسم مختلف"})
        assert dup.status_code == 409
        dup_name = await client.post("/api/v1/catalog/units", json={"code": f"other{sfx}", "name_ar": f"ياردة {sfx}"})
        assert dup_name.status_code == 409

        bad = await client.post("/api/v1/catalog/units", json={"code": "1 bad", "name_ar": "خطأ"})
        assert bad.status_code == 422

        # غير المستخدمة: يتغير كودها واسمها
        upd = await client.patch(f"/api/v1/catalog/units/{unit['id']}", json={"code": f"yard{sfx}", "name_ar": f"يارد {sfx}"})
        assert upd.status_code == 200, upd.text
        assert upd.json()["code"] == f"yard{sfx}"

        assert (await client.delete(f"/api/v1/catalog/units/{unit['id']}")).status_code == 204
        assert (await client.patch(f"/api/v1/catalog/units/{unit['id']}", json={"name_ar": "س"})).status_code == 404


@pytest.mark.asyncio
async def test_unit_in_use_is_protected_but_can_be_renamed(client_factory, session):
    sfx = _suffix()
    unit = Unit(code=f"used{sfx}", name_ar=f"وحدة مستخدمة {sfx}")
    session.add(unit)
    await session.flush()
    session.add(CatalogItem(
        id=str(uuid.uuid4()),
        code=f"UNT_{sfx}",
        name_ar="صنف يستخدم الوحدة",
        item_type="raw_material",
        unit_id=unit.id,
        approval_status="approved",
        is_active=True,
    ))
    await session.commit()

    async with client_factory("general_manager") as client:
        listed = (await client.get("/api/v1/catalog/units/usage")).json()
        row = next(u for u in listed if u["id"] == unit.id)
        assert row["in_use"] is True and row["catalog_items"] == 1

        assert (await client.delete(f"/api/v1/catalog/units/{unit.id}")).status_code == 409
        code_change = await client.patch(f"/api/v1/catalog/units/{unit.id}", json={"code": f"new{sfx}"})
        assert code_change.status_code == 409
        assert "لا يمكن حذفها ولا تغيير كودها" in code_change.json()["detail"] or "لا يمكن" in code_change.text

        rename = await client.patch(f"/api/v1/catalog/units/{unit.id}", json={"name_ar": f"اسم مصحح {sfx}", "code": f"used{sfx}"})
        assert rename.status_code == 200, rename.text
        assert rename.json()["name_ar"] == f"اسم مصحح {sfx}"
        assert rename.json()["code"] == f"used{sfx}"
