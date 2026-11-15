"""
قرار المالك 2026-11-11: المدير المالي يعتمد أصناف الدليل والجرد (أمين المخزن ينشئ ويعدّ ويقدّم).
- المدير المالي يعتمد أو يرفض صنفاً قدّمه أمين المخزن.
- المدير المالي يعتمد جرداً عدّه أمين المخزن ويرحّل تسوياته.
- مسؤول الإنتاج لا يعتمد أياً منهما، ومنع الاعتماد الذاتي باقٍ للجميع.
"""
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.core.auth import get_current_user
from app.core.permissions import ROLE_FINANCE_MANAGER, ROLE_GENERAL_MANAGER, ROLE_PRODUCTION_MANAGER, ROLE_WAREHOUSE_MANAGER
from app.db.session import get_db
from app.main import app
from app.modules.production.models import Unit

from tests.test_stocktake import make_auth_user, setup_stocktake_data  # noqa: F401 (fixture)


def _as(user_id: str, role: str) -> None:
    app.dependency_overrides[get_current_user] = lambda: make_auth_user(user_id, role)


@pytest.fixture
async def client(session):
    app.dependency_overrides[get_db] = lambda: session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def _submitted_item(client, session) -> str:
    unit = await session.scalar(select(Unit).where(Unit.code == "meter"))
    _as("fma-wh", ROLE_WAREHOUSE_MANAGER)
    res = await client.post("/api/v1/catalog/items", json={
        "code": f"FMA-{uuid.uuid4().hex[:6].upper()}", "name_ar": "قماش اعتماد مالي", "item_type": "fabric", "unit_id": unit.id, "classification_status": "confirmed",
    })
    assert res.status_code == 201, res.text
    item_id = res.json()["id"]
    assert (await client.post(f"/api/v1/catalog/items/{item_id}/submit")).status_code == 200
    return item_id


@pytest.mark.asyncio
async def test_finance_manager_approves_and_rejects_catalog_items(client, session):
    item_id = await _submitted_item(client, session)
    _as("fma-pm", ROLE_PRODUCTION_MANAGER)
    assert (await client.post(f"/api/v1/catalog/items/{item_id}/approve")).status_code == 403
    _as("fma-fm", ROLE_FINANCE_MANAGER)
    res = await client.post(f"/api/v1/catalog/items/{item_id}/approve")
    assert res.status_code == 200, res.text
    assert res.json()["approval_status"] == "approved"

    other = await _submitted_item(client, session)
    _as("fma-fm", ROLE_FINANCE_MANAGER)
    res = await client.post(f"/api/v1/catalog/items/{other}/reject", json={"rejection_reason": "الاسم غير واضح"})
    assert res.status_code == 200, res.text
    assert res.json()["approval_status"] == "rejected"

    # منع الاعتماد الذاتي باقٍ: من قدّم الصنف لا يعتمده حتى لو كان المدير العام
    _as("fma-gm", ROLE_GENERAL_MANAGER)
    unit = await session.scalar(select(Unit).where(Unit.code == "meter"))
    res = await client.post("/api/v1/catalog/items", json={
        "code": f"FMA-{uuid.uuid4().hex[:6].upper()}", "name_ar": "صنف مدير", "item_type": "fabric", "unit_id": unit.id, "classification_status": "confirmed",
    })
    own = res.json()["id"]
    await client.post(f"/api/v1/catalog/items/{own}/submit")
    assert (await client.post(f"/api/v1/catalog/items/{own}/approve")).status_code in (403, 409)


@pytest.mark.asyncio
async def test_finance_manager_approves_and_posts_stocktake(client, session, setup_stocktake_data):
    data = setup_stocktake_data
    _as("fmst-wh", ROLE_WAREHOUSE_MANAGER)
    res = await client.post("/api/v1/inventory/stocktakes", json={
        "warehouse_id": data["warehouse"].id, "scope_type": "specific_items", "item_ids": [data["item1"].id],
    })
    assert res.status_code == 201, res.text
    st_id = res.json()["id"]
    line_id = res.json()["lines"][0]["id"]
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/counts", json={"counts": [{"line_id": line_id, "counted_quantity": 95.0}]})
    assert (await client.post(f"/api/v1/inventory/stocktakes/{st_id}/submit")).status_code == 200

    # أمين المخزن ومسؤول الإنتاج لا يعتمدان
    assert (await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})).status_code == 403
    _as("fmst-pm", ROLE_PRODUCTION_MANAGER)
    assert (await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})).status_code == 403

    _as("fmst-fm", ROLE_FINANCE_MANAGER)
    assert (await client.get(f"/api/v1/inventory/stocktakes/{st_id}")).status_code == 200
    res = await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})
    assert res.status_code == 200, res.text
    res = await client.post(f"/api/v1/inventory/stocktakes/{st_id}/post", json={"notes": "ترحيل المدير المالي"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "posted"
    assert res.json()["shortage_count"] == 1


@pytest.mark.asyncio
async def test_finance_manager_can_create_purchase_invoice_but_cannot_receive_goods(client, session):
    """
    PUR-DEC-01: المدير المالي ينشئ فواتير الشراء (suppliers:invoices:create)،
    ولكنه لا يملك صلاحية استلام البضاعة بالمخزن (suppliers:receive) التي تخص أمين المخزن.
    """
    from datetime import datetime, timezone
    from app.modules.finance.models import Supplier
    from app.modules.production.models import CatalogItem, Unit

    unit = await session.scalar(select(Unit).where(Unit.code == "meter"))
    sup = Supplier(
        id=str(uuid.uuid4()),
        code=f"SUP-{uuid.uuid4().hex[:6].upper()}",
        name="مورد أقمشة للتجربة",
        created_by="test",
    )
    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"ITM-{uuid.uuid4().hex[:6].upper()}",
        name_ar="قماش معتمد للشراء",
        item_type="fabric",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    session.add(sup)
    session.add(item)
    await session.commit()

    # 1. المدير المالي يستطيع إنشاء فاتورة شراء
    _as("pur-fm", ROLE_FINANCE_MANAGER)
    inv_payload = {
        "supplier_id": sup.id,
        "invoice_number": f"INV-{uuid.uuid4().hex[:6].upper()}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "lines": [
            {
                "item_id": item.id,
                "unit_id": unit.id,
                "invoiced_quantity": 50.0,
                "unit_price": "100.00",
                "discount_amount": "0.00",
            }
        ],
        "notes": "فاتورة أعدها المدير المالي",
    }
    res_create = await client.post("/api/v1/finance/supplier-invoices", json=inv_payload)
    assert res_create.status_code == 201, res_create.text
    invoice_id = res_create.json()["id"]

    # 2. المدير المالي يُمنع (403 Forbidden) من استلام البضاعة في المخزن
    receive_payload = {
        "lines": [
            {
                "line_id": res_create.json()["lines"][0]["id"],
                "received_quantity": 50.0,
                "notes": "محاولة استلام بواسطة المدير المالي",
            }
        ],
        "notes": "استلام",
    }
    res_recv_fm = await client.post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json=receive_payload)
    assert res_recv_fm.status_code == 403

    # 3. أمين المخزن يستطيع استلام البضاعة
    _as("pur-wh", ROLE_WAREHOUSE_MANAGER)
    res_recv_wh = await client.post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json=receive_payload)
    assert res_recv_wh.status_code == 200, res_recv_wh.text
    assert res_recv_wh.json()["status"] == "received"

