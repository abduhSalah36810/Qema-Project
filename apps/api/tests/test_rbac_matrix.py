"""
اختبارات مصفوفة الصلاحيات المعتمدة من مالك المشروع (2026-11-09).
─────────────────────────────────────────────────────────────────────────────
ثلاث طبقات:
1. مصفوفة ثابتة مستخرجة من مسارات FastAPI الفعلية: من يُسمح له بكل عملية حساسة،
   وأن كل صلاحية معرّفة مستخدمة فعلاً، وأن الاعتماد المالي له مسار واحد فقط (الخزينة).
2. طلبات HTTP مباشرة لكل دور من الأدوار الأربعة: 403 للمرفوض، وتجاوز التفويض للمسموح.
3. سيناريوهات سلوكية على قاعدة الاختبار: فصل الصارف عن المستلم، منع تعديل العيوب بعد الإغلاق،
   إنشاء طلب البيع، الإغلاق بشروطه، ومنع الاعتماد الذاتي حتى للمدير العام.
"""
from datetime import datetime, timezone
import uuid

import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.permissions import PERMISSION_REGISTRY, ROLE_PERMISSIONS_MAP
from app.db.session import get_db
from app.main import app
from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductionOrder,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
)

GM, WH, PM, FM = "general_manager", "warehouse_manager", "production_manager", "finance_manager"
ALL_ROLES = (GM, WH, PM, FM)
API = "/api/v1"


# ═════════════════════════════════════════════════════════════════════════════
# 1. المصفوفة الثابتة المستخرجة من المسارات الفعلية
# ═════════════════════════════════════════════════════════════════════════════

def _closure_values(fn) -> dict:
    if not getattr(fn, "__closure__", None):
        return {}
    return {name: cell.cell_contents for name, cell in zip(fn.__code__.co_freevars, fn.__closure__)}


def _route_requirements(route: APIRoute) -> list[tuple[str, frozenset[str]]]:
    """
    يستخرج شروط التفويض لمسار: قائمة (all|any, صلاحيات). كل عنصر يجب تحققه (AND)،
    و"any" يعني أن أي صلاحية من المجموعة تكفي.
    """
    reqs: list[tuple[str, frozenset[str]]] = []

    def walk(dependant):
        for dep in dependant.dependencies:
            values = _closure_values(dep.call)
            if "required_permission" in values:
                reqs.append(("all", frozenset({values["required_permission"]})))
            elif "required_permissions" in values:
                reqs.append(("any", frozenset(values["required_permissions"])))
            elif "normalized_allowed" in values:
                reqs.append(("role", frozenset(values["normalized_allowed"])))
            walk(dep)

    walk(route.dependant)
    return reqs


def _iter_api_routes(routes, prefix: str = ""):
    """يمر على كل المسارات بما فيها الموجهات المضمّنة (FastAPI الحديث يغلفها في _IncludedRouter)."""
    for route in routes:
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
        elif hasattr(route, "original_router") and hasattr(route, "include_context"):
            child_prefix = getattr(route.include_context, "prefix", "") or ""
            yield from _iter_api_routes(route.original_router.routes, prefix + child_prefix)


def _route_index() -> dict[tuple[str, str], list[tuple[str, frozenset[str]]]]:
    index = {}
    for path, route in _iter_api_routes(app.routes):
        for method in route.methods:
            index[(method, path)] = _route_requirements(route)
    assert len(index) > 50, "تعذر استخراج مسارات الـ API"
    return index


def _allowed_roles(reqs) -> set[str]:
    allowed = set()
    for role in ALL_ROLES:
        perms = ROLE_PERMISSIONS_MAP[role]
        ok = True
        for kind, values in reqs:
            if kind == "all" and not values <= perms:
                ok = False
            elif kind == "any" and not values & perms:
                ok = False
            elif kind == "role" and role not in values:
                ok = False
        if ok:
            allowed.add(role)
    return allowed


EXPECTED_MATRIX = {
    # المشتريات
    ("POST", f"{API}/finance/supplier-invoices"): {GM, WH},
    ("POST", f"{API}/finance/supplier-invoices/{{invoice_id}}/receive"): {GM, WH},
    # طلب سداد بمبلغ يحدده المستخدم: المالية والمدير العام؛ أمين المخزن يطلب "كامل المستحق" دون رؤية المبلغ
    ("POST", f"{API}/finance/supplier-invoices/{{invoice_id}}/payments"): {GM, FM},
    ("POST", f"{API}/finance/supplier-invoices/{{invoice_id}}/payment-requests/full-balance"): {GM, WH, FM},
    # العملاء: البيانات الأساسية والحسابات للمدير العام والمالي فقط؛ أمين المخزن يرى التسليمات فقط
    ("GET", f"{API}/customers"): {GM, FM},
    ("GET", f"{API}/customers/{{customer_id}}/account"): {GM, FM},
    ("POST", f"{API}/customers"): {GM, FM},
    ("PATCH", f"{API}/customers/{{customer_id}}"): {GM, FM},
    ("GET", f"{API}/customers/pending-deliveries"): {GM, WH},
    # المبيعات والتسعير والتسليم والتحصيل
    ("POST", f"{API}/customers/{{customer_id}}/orders"): {GM, FM},
    ("POST", f"{API}/customers/{{customer_id}}/orders/{{order_id}}/deliveries"): {GM, WH},
    ("POST", f"{API}/customers/{{customer_id}}/orders/{{order_id}}/payments"): {GM, FM},
    # الإنتاج: الإنشاء المباشر وغير المباشر
    ("POST", f"{API}/production/orders"): {GM, PM},
    ("POST", f"{API}/customers/{{customer_id}}/orders/{{order_id}}/production-orders"): {GM, PM},
    # فصل المخازن: الصرف، استلام الورشة، استلام التام
    ("POST", f"{API}/production/orders/{{order_id}}/dispatch"): {GM, WH},
    ("POST", f"{API}/production/orders/{{order_id}}/receive"): {GM, PM},
    ("POST", f"{API}/production/orders/{{order_id}}/finished-receipt"): {GM, WH},
    # التشغيل في الورشة
    ("POST", f"{API}/production/orders/{{order_id}}/stages/{{stage_name}}"): {GM, PM},
    ("POST", f"{API}/production/orders/{{order_id}}/defects"): {GM, PM},
    ("PATCH", f"{API}/production/orders/{{order_id}}/defects/{{defect_id}}"): {GM, PM},
    ("POST", f"{API}/production/orders/{{order_id}}/material-reconciliations"): {GM, PM},
    # مرتجعات الورشة: المخزن يفحص ويستلم، والإنتاج أو المدير العام يسوّي العجز والمرفوض
    ("POST", f"{API}/production/orders/{{order_id}}/returns/{{transfer_id}}/receive"): {GM, WH},
    ("POST", f"{API}/production/orders/{{order_id}}/returns/{{transfer_id}}/resolve"): {GM, PM},
    ("POST", f"{API}/production/orders/{{order_id}}/close"): {GM, PM},
    # الخزينة والرواتب: المدير العام دور شامل، والاعتماد يبقى خاضعاً لمنع الاعتماد الذاتي
    ("POST", f"{API}/finance/cash-documents"): {GM, FM},
    ("POST", f"{API}/finance/cash-documents/{{document_id}}/decision"): {GM, FM},
    ("POST", f"{API}/finance/daily-expenses"): {GM, FM},
    ("POST", f"{API}/finance/petty-cash"): {GM, FM},
    ("POST", f"{API}/payroll/periods/{{period_id}}/calculate"): {GM, FM},
    ("POST", f"{API}/payroll/periods/{{period_id}}/disburse"): {GM, FM},
}


@pytest.mark.parametrize("route_key", sorted(EXPECTED_MATRIX), ids=lambda k: f"{k[0]} {k[1]}")
def test_route_allows_exactly_the_approved_roles(route_key):
    index = _route_index()
    assert route_key in index, f"المسار غير موجود: {route_key}"
    reqs = index[route_key]
    assert reqs, f"المسار بلا أي تفويض: {route_key}"
    assert _allowed_roles(reqs) == EXPECTED_MATRIX[route_key]


def test_every_declared_permission_is_enforced_by_some_route():
    """صلاحية معرّفة بلا مسار يفرضها تضلل قارئ المصفوفة؛ هذا الاختبار يفشل عند وجودها."""
    used = set()
    for reqs in _route_index().values():
        for kind, values in reqs:
            if kind in ("all", "any"):
                used |= values
    unused = set(PERMISSION_REGISTRY) - used
    assert not unused, f"صلاحيات معرّفة لا يفرضها أي مسار: {sorted(unused)}"


def test_every_route_permission_and_role_grant_is_registered():
    referenced = set()
    for reqs in _route_index().values():
        for kind, values in reqs:
            if kind in ("all", "any"):
                referenced |= values
    assert referenced <= set(PERMISSION_REGISTRY), sorted(referenced - set(PERMISSION_REGISTRY))
    for role, perms in ROLE_PERMISSIONS_MAP.items():
        assert perms <= set(PERMISSION_REGISTRY), (role, sorted(perms - set(PERMISSION_REGISTRY)))


def test_treasury_decision_is_the_only_financial_approval_route():
    approval_routes = [
        key for key, reqs in _route_index().items()
        if any("finance:cash:approve" in values for _, values in reqs)
    ]
    assert approval_routes == [("POST", f"{API}/finance/cash-documents/{{document_id}}/decision")]


def test_general_manager_holds_every_declared_permission():
    """المدير العام دور شامل: كل صلاحية معرّفة، بما فيها الإنشاء المالي والتحصيل والرواتب."""
    assert ROLE_PERMISSIONS_MAP[GM] == set(PERMISSION_REGISTRY)
    for perm in ("finance:cash:create", "finance:payments:manage", "finance:payroll:calculate",
                 "finance:payroll:disburse", "finance:expenses:manage", "finance:cash:manage"):
        assert perm in ROLE_PERMISSIONS_MAP[GM]


def test_full_role_matrix_snapshot():
    """لقطة كاملة لمصفوفة الأدوار؛ أي تغيير فيها يجب أن يكون مقصوداً ومعتمداً."""
    assert ROLE_PERMISSIONS_MAP[WH] == {
        "inventory:view", "inventory:stocktake:view", "inventory:stocktake:create", "inventory:stocktake:count",
        "inventory:stocktake:submit", "inventory:stocktake:cancel",
        "catalog:view", "catalog:categories:manage", "catalog:item:create", "catalog:item:update",
        "catalog:item:submit", "catalog:item:request_revision",
        "warehouse:dispatch", "warehouse:finished_goods:receive", "warehouse:returns:receive",
        "production:orders:view", "customers:deliveries:manage",
        "suppliers:view", "suppliers:manage", "suppliers:invoices:create",
        "suppliers:payments:request_full_balance", "suppliers:receive",
    }
    assert ROLE_PERMISSIONS_MAP[PM] == {
        "production:orders:view", "production:orders:create", "production:orders:manage",
        "production:wip:receive", "production:stages:manage", "production:templates:manage",
        "production:returns:resolve", "production:orders:close", "inventory:view", "catalog:view", "reports:view",
    }
    assert ROLE_PERMISSIONS_MAP[FM] == {
        "finance:cash:view", "finance:cash:create", "finance:cash:manage", "finance:cash:approve",
        "finance:expenses:manage", "finance:payments:manage", "finance:payroll:view",
        "finance:payroll:calculate", "finance:payroll:disburse", "finance:payroll:manage",
        "finance:reports:view", "reports:view",
        "suppliers:view", "suppliers:manage", "suppliers:payments:request", "suppliers:payments:request_full_balance",
        "customers:view", "customers:manage", "customers:orders:create", "pricing:manage",
        "catalog:view",
    }
    # لا صلاحية لإدارة المستخدمين قبل وجود شاشة وAPI مكتملين لها
    assert not any(p.startswith("admin:") for perms in ROLE_PERMISSIONS_MAP.values() for p in perms)


# ═════════════════════════════════════════════════════════════════════════════
# 2. طلبات HTTP مباشرة لكل دور
# ═════════════════════════════════════════════════════════════════════════════

def _user(user_id: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(id=user_id, email=f"{user_id}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    def __init__(self, client: AsyncClient, user: AuthenticatedUser):
        self.client, self.user = client, user

    async def call(self, method: str, url: str, **kw):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kw)

    async def post(self, url, **kw):
        return await self.call("POST", url, **kw)

    async def patch(self, url, **kw):
        return await self.call("PATCH", url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    actors = {
        GM: Actor(client, _user("rbac-gm", GM)),
        WH: Actor(client, _user("rbac-wh", WH)),
        PM: Actor(client, _user("rbac-pm", PM)),
        FM: Actor(client, _user("rbac-fm", FM)),
        "fm2": Actor(client, _user("rbac-fm-2", FM)),
        "gm2": Actor(client, _user("rbac-gm-2", GM)),
    }
    yield session, actors, client
    await client.aclose()
    app.dependency_overrides.clear()


MISSING = "00000000-0000-0000-0000-00000000dead"
HTTP_CASES = [
    ("POST", f"{API}/finance/supplier-invoices", {}),
    ("POST", f"{API}/customers/{MISSING}/orders", {}),
    ("POST", f"{API}/customers/{MISSING}/orders/{MISSING}/production-orders", {}),
    ("POST", f"{API}/production/orders", {}),
    ("POST", f"{API}/production/orders/{MISSING}/receive", {"received_lines": [], "notes": ""}),
    ("POST", f"{API}/production/orders/{MISSING}/finished-receipt", {"accepted_quantity": 1}),
    ("POST", f"{API}/production/orders/{MISSING}/close", {}),
    ("POST", f"{API}/production/orders/{MISSING}/defects", {}),
    ("POST", f"{API}/production/orders/{MISSING}/material-reconciliations", {}),
    ("POST", f"{API}/finance/cash-documents/{MISSING}/decision", {"decision": "approve"}),
    ("GET", f"{API}/customers", None),
    ("GET", f"{API}/customers/{MISSING}/account", None),
    ("POST", f"{API}/customers", {}),
    ("GET", f"{API}/customers/pending-deliveries", None),
    ("POST", f"{API}/customers/{MISSING}/orders/{MISSING}/payments", {}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("method,url,body", HTTP_CASES, ids=[c[1].replace(MISSING, "X") for c in HTTP_CASES])
async def test_http_enforcement_per_role(ctx, method, url, body):
    _, a, client = ctx
    route_key = next(k for k in EXPECTED_MATRIX if k[0] == method and _matches(k[1], url))
    allowed = EXPECTED_MATRIX[route_key]
    for role in ALL_ROLES:
        res = await a[role].call(method, url, json=body)
        if role in allowed:
            assert res.status_code not in (401, 403), (role, url, res.status_code, res.text)
        else:
            assert res.status_code == 403, (role, url, res.status_code, res.text)

    # بلا توكن: 401
    app.dependency_overrides.pop(get_current_user, None)
    res = await client.request(method, url, json=body)
    assert res.status_code == 401


def _matches(pattern: str, url: str) -> bool:
    import re
    regex = re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(pattern))
    return re.fullmatch(regex, url) is not None


# ═════════════════════════════════════════════════════════════════════════════
# 3. سيناريوهات سلوكية
# ═════════════════════════════════════════════════════════════════════════════

def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


async def _wh(session, code):
    return await session.scalar(select(Warehouse).where(Warehouse.code == code))


async def _unit(session, code):
    return await session.scalar(select(Unit).where(Unit.code == code))


async def _approved_item(session, unit) -> CatalogItem:
    item = CatalogItem(
        id=str(uuid.uuid4()), code=f"RBAC-{_tag()}", name_ar=f"خامة صلاحيات {_tag()}", item_type="raw_material",
        unit_id=unit.id, is_active=True, approval_status="approved", classification_status="confirmed",
    )
    session.add(item)
    await session.commit()
    return item


async def _product(session):
    prod = Product(id=str(uuid.uuid4()), code=f"PRD-{_tag()}", name_ar=f"جلابية صلاحيات {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variant = ProductVariant(id=str(uuid.uuid4()), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    session.add(variant)
    await session.commit()
    return prod, variant


async def _dispatched_order(session, a, dispatcher):
    raw = await _wh(session, "main_raw_materials")
    meter = await _unit(session, "meter")
    fabric = await _approved_item(session, meter)
    session.add(StockLedgerEntry(
        id=str(uuid.uuid4()), item_id=fabric.id, unit_id=meter.id, warehouse_id=raw.id, location_type="warehouse",
        quantity=100, reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_tag()}",
        entry_type="opening_balance", created_by="rbac-test",
    ))
    await session.commit()
    prod, variant = await _product(session)
    res = await a[PM].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 10, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": 20}],
    })
    assert res.status_code == 201, res.text
    order_id = res.json()["id"]
    res = await dispatcher.post(f"{API}/production/orders/{order_id}/dispatch")
    assert res.status_code == 200, res.text
    return order_id, fabric


@pytest.mark.asyncio
async def test_dispatcher_cannot_confirm_own_wip_receipt_even_as_general_manager(ctx):
    session, a, _ = ctx
    order_id, fabric = await _dispatched_order(session, a, a[GM])
    body = {"received_lines": [{"item_id": fabric.id, "received_quantity": 20}], "notes": ""}

    res = await a[GM].post(f"{API}/production/orders/{order_id}/receive", json=body)
    assert res.status_code == 409, res.text
    assert "صرف" in res.json()["detail"]

    # أمين المخزن لا يؤكد استلام الورشة إطلاقاً
    res = await a[WH].post(f"{API}/production/orders/{order_id}/receive", json=body)
    assert res.status_code == 403

    # مسؤول الإنتاج (مستخدم مختلف) يؤكد الاستلام
    res = await a[PM].post(f"{API}/production/orders/{order_id}/receive", json=body)
    assert res.status_code == 200, res.text
    assert res.json()["received_by"] == "rbac-pm"


@pytest.mark.asyncio
async def test_warehouse_dispatch_then_production_receipt_is_the_normal_path(ctx):
    session, a, _ = ctx
    order_id, fabric = await _dispatched_order(session, a, a[WH])
    res = await a[PM].post(f"{API}/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 20}], "notes": "",
    })
    assert res.status_code == 200, res.text

    # مسؤول الإنتاج لا يستلم المنتج التام، ولا يصرف خامات
    res = await a[PM].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 1})
    assert res.status_code == 403
    res = await a[PM].post(f"{API}/production/orders/{order_id}/dispatch")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_close_requires_business_conditions_for_permitted_roles(ctx):
    session, a, _ = ctx
    order_id, _ = await _dispatched_order(session, a, a[WH])
    for role in (WH, FM):
        res = await a[role].post(f"{API}/production/orders/{order_id}/close", json={})
        assert res.status_code == 403
    for role in (PM, GM):
        res = await a[role].post(f"{API}/production/orders/{order_id}/close", json={})
        assert res.status_code == 409, res.text  # المراحل غير مكتملة: التفويض لا يتجاوز شروط الإغلاق


@pytest.mark.asyncio
async def test_defects_frozen_after_order_closure(ctx):
    session, a, _ = ctx
    prod, variant = await _product(session)
    fabric = await _approved_item(session, await _unit(session, "meter"))
    res = await a[PM].post(f"{API}/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": 5, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": fabric.unit_id, "planned_quantity": 5}],
    })
    assert res.status_code == 201, res.text
    order_id = res.json()["id"]
    defect_body = {
        "stage_name": "cutting", "description": "قص مائل", "affected_quantity": 1,
        "responsible": "خط القص", "repair_action": "إعادة قص",
    }
    res = await a[PM].post(f"{API}/production/orders/{order_id}/defects", json=defect_body)
    assert res.status_code == 201, res.text
    defect_id = res.json()["id"]

    # إغلاق الأمر (محاكاة الحالة النهائية مباشرة لعزل قاعدة العيوب عن دورة الإغلاق الكاملة)
    order = await session.get(ProductionOrder, order_id)
    order.status = "closed"
    await session.commit()

    for actor in (a[PM], a[GM]):
        res = await actor.post(f"{API}/production/orders/{order_id}/defects", json=defect_body)
        assert res.status_code == 409, res.text
        res = await actor.patch(f"{API}/production/orders/{order_id}/defects/{defect_id}", json={"status": "repaired"})
        assert res.status_code == 409, res.text

    res = await a[WH].patch(f"{API}/production/orders/{order_id}/defects/{defect_id}", json={"status": "repaired"})
    assert res.status_code == 403
    rows = (await a[PM].call("GET", f"{API}/production/orders/{order_id}/defects")).json()
    assert [d["status"] for d in rows] == ["reported"]


@pytest.mark.asyncio
async def test_sales_order_and_pricing_roles(ctx):
    session, a, _ = ctx
    prod, variant = await _product(session)
    res = await a[WH].post(f"{API}/customers", json={"code": f"CUS-{_tag()}", "name": "عميل مرفوض"})
    assert res.status_code == 403, "أمين المخزن لا ينشئ عملاء"
    res = await a[FM].post(f"{API}/customers", json={"code": f"CUS-{_tag()}", "name": "عميل صلاحيات"})
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]
    res = await a[GM].call("PATCH", f"{API}/customers/{customer_id}", json={"city": "القاهرة"})
    assert res.status_code == 200, res.text
    for path in (f"{API}/customers", f"{API}/customers/{customer_id}/account"):
        res = await a[WH].call("GET", path)
        assert res.status_code == 403, "أمين المخزن لا يرى حسابات العملاء"
    body = {
        "order_type": "custom_manufacturing",
        "lines": [{"product_id": prod.id, "variant_id": variant.id, "quantity": "10", "unit_price": "250.00"}],
    }
    for role in (WH, PM):
        res = await a[role].post(f"{API}/customers/{customer_id}/orders", json=body)
        assert res.status_code == 403, (role, res.text)
    for role in (FM, GM):
        res = await a[role].post(f"{API}/customers/{customer_id}/orders", json=body)
        assert res.status_code == 201, (role, res.text)
    order = res.json()

    # الإنشاء غير المباشر لأمر تشغيل من طلب العميل
    line_id = order["lines"][0]["id"]
    payload = {"customer_order_line_id": line_id, "quantity": 5}
    for role in (WH, FM):
        res = await a[role].post(f"{API}/customers/{customer_id}/orders/{order['id']}/production-orders", json=payload)
        assert res.status_code == 403, (role, res.text)
    res = await a[PM].post(f"{API}/customers/{customer_id}/orders/{order['id']}/production-orders", json=payload)
    assert res.status_code not in (401, 403), res.text


@pytest.mark.asyncio
async def test_supplier_invoice_roles_and_general_manager_cannot_self_approve(ctx):
    session, a, _ = ctx
    meter = await _unit(session, "meter")
    fabric = await _approved_item(session, meter)

    # المدير المالي لا جهة اعتماد فوقه: سنده يُعتمد ويُرحّل لحظة إنشائه
    res = await a[FM].post(f"{API}/finance/cash-documents", json={
        "document_type": "income", "to_account_id": CANONICAL_TREASURY_ID, "amount": "10000.00",
        "description": "تمويل اختبار الصلاحيات", "occurred_at": datetime.now(timezone.utc).isoformat(),
    })
    assert res.status_code == 201, res.text
    funding = res.json()
    assert funding["status"] == "approved" and funding["approved_by"] == a[FM].user.id
    res = await a["fm2"].post(f"{API}/finance/cash-documents/{funding['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 409, "لا اعتماد مزدوج"

    # المدير العام ينشئ سنداً نقدياً (دور شامل) لكنه لا يعتمده بنفسه
    res = await a[GM].post(f"{API}/finance/cash-documents", json={
        "document_type": "income", "to_account_id": CANONICAL_TREASURY_ID, "amount": "1.00",
        "description": "إيداع من المدير العام", "occurred_at": datetime.now(timezone.utc).isoformat(),
    })
    assert res.status_code == 201, res.text
    gm_doc = res.json()
    assert gm_doc["status"] == "pending"
    res = await a[GM].post(f"{API}/finance/cash-documents/{gm_doc['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 409, "المدير العام لا يعتمد سنداً أنشأه"
    res = await a["gm2"].post(f"{API}/finance/cash-documents/{gm_doc['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text

    # لا يُنشأ سداد مورد مستقل من شاشة السندات العامة؛ السداد يمر عبر فاتورة المورد فقط
    for role in (GM, FM):
        res = await a[role].post(f"{API}/finance/cash-documents", json={
            "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "10.00",
            "description": "سداد مورد بلا فاتورة", "occurred_at": datetime.now(timezone.utc).isoformat(),
            "source_system": "supplier_payment", "source_reference": str(uuid.uuid4()),
        })
        assert res.status_code == 422, (role, res.text)

    res = await a[GM].post(f"{API}/finance/suppliers", json={"code": f"SUP-{_tag()}", "name": "مورد صلاحيات"})
    assert res.status_code == 201, res.text
    supplier_id = res.json()["id"]
    invoice_body = {
        "supplier_id": supplier_id, "invoice_number": f"INV-{_tag()}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "lines": [{"item_id": fabric.id, "unit_id": meter.id, "invoiced_quantity": 10, "unit_price": "50"}],
    }
    for role in (FM, PM):
        res = await a[role].post(f"{API}/finance/supplier-invoices", json=invoice_body)
        assert res.status_code == 403, (role, res.text)
    res = await a[WH].post(f"{API}/finance/supplier-invoices", json=invoice_body)
    assert res.status_code == 201, res.text
    res = await a[GM].post(f"{API}/finance/supplier-invoices", json={**invoice_body, "invoice_number": f"INV-{_tag()}"})
    assert res.status_code == 201, res.text
    invoice = res.json()

    res = await a[WH].post(f"{API}/finance/supplier-invoices/{invoice['id']}/receive", json={
        "lines": [{"line_id": invoice["lines"][0]["id"], "received_quantity": 10}],
    })
    assert res.status_code == 200, res.text

    # أمين المخزن لا يطلب سداداً بمبلغ يكتبه (المبالغ سرية عنه)
    res = await a[WH].post(f"{API}/finance/supplier-invoices/{invoice['id']}/payments", json={"amount": "50.00", "description": "طلب سداد من المخزن"})
    assert res.status_code == 403

    # المدير العام يطلب السداد ثم يُمنع من اعتماد طلبه بنفسه
    res = await a[GM].post(f"{API}/finance/supplier-invoices/{invoice['id']}/payments", json={"amount": "100.00", "description": "سداد"})
    assert res.status_code == 201, res.text
    pay_doc = res.json()
    assert pay_doc["status"] == "pending"
    res = await a[GM].post(f"{API}/finance/cash-documents/{pay_doc['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 409, "المدير العام لا يعتمد مستنداً أنشأه"
    res = await a[FM].post(f"{API}/finance/cash-documents/{pay_doc['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_general_manager_collection_requires_another_approver(ctx):
    session, a, _ = ctx
    prod, variant = await _product(session)
    res = await a[GM].post(f"{API}/customers", json={"code": f"CUS-{_tag()}", "name": "عميل تحصيل"})
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]
    res = await a[GM].post(f"{API}/customers/{customer_id}/orders", json={
        "order_type": "custom_manufacturing",
        "lines": [{"product_id": prod.id, "variant_id": variant.id, "quantity": "4", "unit_price": "100.00"}],
    })
    assert res.status_code == 201, res.text
    order_id = res.json()["id"]

    res = await a[GM].post(f"{API}/customers/{customer_id}/orders/{order_id}/payments", json={
        "amount": "100.00", "method": "cash", "received_at": datetime.now(timezone.utc).isoformat(),
    })
    assert res.status_code == 201, res.text
    doc_id = res.json()["cash_document_id"]
    assert doc_id
    res = await a[GM].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 409, "المدير العام لا يعتمد تحصيلاً سجّله"
    res = await a[FM].post(f"{API}/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_pending_deliveries_carry_no_financial_fields(ctx):
    _, a, _ = ctx
    res = await a[WH].call("GET", f"{API}/customers/pending-deliveries")
    assert res.status_code == 200, res.text
    money_words = ("price", "amount", "balance", "paid", "total", "discount")
    for row in res.json():
        assert not [k for k in row if any(w in k for w in money_words)], row


@pytest.mark.asyncio
async def test_order_payload_exposes_pending_dispatcher_until_received(ctx):
    session, a, _ = ctx
    order_id, fabric = await _dispatched_order(session, a, a[WH])
    detail = (await a[PM].call("GET", f"{API}/production/orders/{order_id}")).json()
    assert detail["pending_transfer_dispatched_by"] == "rbac-wh"
    listed = next(o for o in (await a[WH].call("GET", f"{API}/production/orders")).json() if o["id"] == order_id)
    assert listed["pending_transfer_dispatched_by"] == "rbac-wh"

    res = await a[PM].post(f"{API}/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 20}], "notes": "",
    })
    assert res.status_code == 200, res.text
    detail = (await a[PM].call("GET", f"{API}/production/orders/{order_id}")).json()
    assert detail["pending_transfer_dispatched_by"] is None


@pytest.mark.asyncio
async def test_general_manager_receives_but_never_own_dispatch(ctx):
    """المدير العام يملك الاستلام، لكنه لا يؤكد استلام حركة صرفها بنفسه."""
    session, a, _ = ctx
    order_id, fabric = await _dispatched_order(session, a, a["gm2"])
    body = {"received_lines": [{"item_id": fabric.id, "received_quantity": 20}], "notes": ""}
    res = await a["gm2"].post(f"{API}/production/orders/{order_id}/receive", json=body)
    assert res.status_code == 409
    res = await a[GM].post(f"{API}/production/orders/{order_id}/receive", json=body)
    assert res.status_code == 200, res.text
    # مسار استلام التام متاح للمدير العام (الرفض هنا لشرط تشغيلي: المراحل لم تكتمل)
    res = await a[GM].post(f"{API}/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 1})
    assert res.status_code not in (401, 403), res.text
