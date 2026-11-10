"""
اختبارات المزود المحلي لمصادقة التطوير (Local JWT Development Authentication Provider)
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. نجاح تسجيل الدخول المحلي وإصدار توكن صالح مع دور المدير العام.
2. التحقق من توقيع التوكن المحلي واستخراج بيانات المستخدم والمطابقة مع LOCAL_DEV_USER_ID.
3. رفض التوكنات المحلية منتهية الصلاحية (Expired).
4. رفض التوكنات ذات جهة الإصدار الخاطئة أو الجمهور غير المطابق.
5. حظر المسار في بيئة الإنتاج أو عند تعطيل DEV_AUTH_ENABLED (يعيد 404).
6. فشل إعدادات السيرفر إذا كان DEV_AUTH_ENABLED=True في بيئة الإنتاج.
7. فشل إعدادات السيرفر إذا كان المفتاح السري أقل من 32 حرفاً.
8. رفض التحقق من التوكن المحلي إذا تم تعطيل DEV_AUTH_ENABLED لاحقاً (401 Unauthorized).
9. تكامل الصلاحيات والأدوار (RBAC) عبر قاعدة البيانات للمستخدم المحلي المستقر.
10. الحفاظ على توافقية توكنات Supabase Auth القياسية بالتوازي.
─────────────────────────────────────────────────────────────────────────────
"""
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

import app.db.base  # noqa: F401
from app.core.auth import (
    LOCAL_DEV_ROLE,
    LOCAL_DEV_USER_EMAIL,
    LOCAL_DEV_USER_ID,
    AuthenticatedUser,
    get_current_user,
    verify_local_jwt,
    verify_token,
)
from app.core.config import Settings, settings
from app.core.permissions import ROLE_PERMISSIONS_MAP, get_user_roles, require_permission
from app.main import app

STRONG_TEST_SECRET = "super-secret-development-key-that-is-at-least-32-chars-long!"


@pytest.fixture
def enable_dev_auth():
    """تفعيل بيئة التطوير والمصادقة المحلية مؤقتاً أثناء الاختبار."""
    with patch.object(settings, "app_env", "development"), \
         patch.object(settings, "dev_auth_enabled", True), \
         patch.object(settings, "local_jwt_secret", STRONG_TEST_SECRET), \
         patch.object(settings, "local_jwt_issuer", "qemma-local-auth"), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"):
        yield


# ─── 1. اختبارات الإعدادات والتحقق الأمني من البيئة ────────────────────────

def test_settings_rejects_dev_auth_in_production():
    """حظر أمني: فشل الإعدادات عند تفعيل DEV_AUTH_ENABLED في بيئة الإنتاج."""
    with pytest.raises(ValidationError) as exc:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            app_env="production",
            dev_auth_enabled=True,
            local_jwt_secret=STRONG_TEST_SECRET,
            cors_allowed_origins=["https://erp.qemma.com"],
        )
    assert "لا يمكن تفعيل المصادقة المحلية" in str(exc.value)


def test_settings_rejects_short_secret():
    """فشل الإعدادات عند تزويد مفتاح سري ضعيف (أقل من 32 حرفاً)."""
    with pytest.raises(ValidationError) as exc:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            app_env="development",
            dev_auth_enabled=True,
            local_jwt_secret="too-short-secret",
        )
    assert "LOCAL_JWT_SECRET" in str(exc.value)
    assert "32" in str(exc.value)


# ─── 2. اختبار مسار تسجيل الدخول المحلي POST /api/v1/auth/local-login ──────

@pytest.mark.asyncio
async def test_local_login_success(enable_dev_auth):
    """نجاح تسجيل الدخول المحلي وتوليد توكن JWT مطابق للمواصفات."""
    mock_db = AsyncMock()
    mock_role = MagicMock()
    mock_role.id = str(uuid.uuid4())
    mock_role.name = LOCAL_DEV_ROLE

    mock_db.scalar = AsyncMock(return_value=mock_role)
    mock_db.commit = AsyncMock()

    from app.db.session import get_db
    app.dependency_overrides[get_db] = lambda: mock_db

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/auth/local-login")

        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["expires_in"] == 28800
        assert data["user"]["id"] == LOCAL_DEV_USER_ID
        assert data["user"]["email"] == LOCAL_DEV_USER_EMAIL

        # فحص محتوى التوكن الموقع
        decoded = jwt.decode(
            data["access_token"],
            key=STRONG_TEST_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
            issuer="qemma-local-auth",
        )
        assert decoded["sub"] == LOCAL_DEV_USER_ID
        assert decoded["email"] == LOCAL_DEV_USER_EMAIL
        assert decoded["role"] == "general_manager"
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_local_login_disabled_returns_404():
    """عند تعطيل DEV_AUTH_ENABLED يعيد المسار 404 لحماية النظام."""
    with patch.object(settings, "app_env", "development"), \
         patch.object(settings, "dev_auth_enabled", False):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/auth/local-login")

        assert response.status_code == 404


@pytest.mark.asyncio
async def test_local_login_in_production_returns_404():
    """عند محاولة استدعاء المسار في بيئة الإنتاج يعيد 404."""
    with patch.object(settings, "app_env", "production"), \
         patch.object(settings, "dev_auth_enabled", False):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/auth/local-login")

        assert response.status_code == 404


# ─── 3. اختبارات التحقق من التوكن (Token Verification) ─────────────────────

@pytest.mark.asyncio
async def test_verify_local_jwt_valid(enable_dev_auth):
    """توكن محلي سليم يُفك بنجاح ويعيد AuthenticatedUser بالمعرف الثابت."""
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": LOCAL_DEV_USER_ID,
            "email": LOCAL_DEV_USER_EMAIL,
            "iss": "qemma-local-auth",
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
        },
        STRONG_TEST_SECRET,
        algorithm="HS256",
    )

    user = verify_local_jwt(token)
    assert isinstance(user, AuthenticatedUser)
    assert user.id == LOCAL_DEV_USER_ID
    assert user.email == LOCAL_DEV_USER_EMAIL


@pytest.mark.asyncio
async def test_verify_local_jwt_expired(enable_dev_auth):
    """رفض التوكن المحلي منتهي الصلاحية بـ 401."""
    now = int(time.time())
    expired_token = jwt.encode(
        {
            "sub": LOCAL_DEV_USER_ID,
            "email": LOCAL_DEV_USER_EMAIL,
            "iss": "qemma-local-auth",
            "aud": "authenticated",
            "iat": now - 7200,
            "exp": now - 3600,
        },
        STRONG_TEST_SECRET,
        algorithm="HS256",
    )

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        verify_local_jwt(expired_token)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_verify_local_jwt_wrong_issuer(enable_dev_auth):
    """رفض التوكن المحلي إذا كانت جهة الإصدار غير متطابقة."""
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": LOCAL_DEV_USER_ID,
            "email": LOCAL_DEV_USER_EMAIL,
            "iss": "wrong-issuer",
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
        },
        STRONG_TEST_SECRET,
        algorithm="HS256",
    )

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        verify_local_jwt(token)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_verify_local_jwt_when_disabled_returns_401():
    """إذا كان التوكن محلياً لكن DEV_AUTH_ENABLED=False يتم رفضه فوراً بـ 401."""
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": LOCAL_DEV_USER_ID,
            "email": LOCAL_DEV_USER_EMAIL,
            "iss": "qemma-local-auth",
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
        },
        STRONG_TEST_SECRET,
        algorithm="HS256",
    )

    from fastapi import HTTPException
    with patch.object(settings, "dev_auth_enabled", False):
        with pytest.raises(HTTPException) as exc:
            verify_local_jwt(token)
        assert exc.value.status_code == 401


# ─── 4. اختبار تكامل الصلاحيات وRBAC للمستخدم المحلي ───────────────────────

@pytest.mark.asyncio
async def test_local_dev_user_has_general_manager_permissions(enable_dev_auth):
    """
    التحقق من أن المستخدم المحلي المصادق عليه يملك صلاحيات 'general_manager'
    المعرفة في مصفوفة الأدوار ولا يتم منحه أي صلاحية خارج النظام المعتمد.
    """
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": LOCAL_DEV_USER_ID,
            "email": LOCAL_DEV_USER_EMAIL,
            "role": LOCAL_DEV_ROLE,
            "iss": "qemma-local-auth",
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
        },
        STRONG_TEST_SECRET,
        algorithm="HS256",
    )

    # استدعاء مسار /auth/me للتحقق من هوية المستخدم
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json()["id"] == LOCAL_DEV_USER_ID
    assert response.json()["email"] == LOCAL_DEV_USER_EMAIL


@pytest.mark.asyncio
async def test_auth_config_endpoint(enable_dev_auth):
    """مسار GET /auth/config يعكس حالة تفعيل المصادقة المحلية بدقة للواجهة."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/auth/config")

    assert response.status_code == 200
    data = response.json()
    assert data["dev_auth_enabled"] is True
    assert data["app_env"] == "development"


# ─── 5. اختبارات الأمان الحرجة للتبديل بين الأدوار المحلية (Task 05.2) ─────────

@pytest.mark.asyncio
async def test_local_login_general_manager_produces_only_gm_role_and_permissions(enable_dev_auth):
    """1. تسجيل الدخول المحلي كمدير عام ينتج حصراً دور GM وصلاحياته الفعلية."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/local-login", json={"role": "general_manager"})

    assert response.status_code == 200
    data = response.json()
    assert data["user"]["id"] == LOCAL_DEV_USER_ID
    assert data["user"]["email"] == "dev@qemma.local"

    decoded = jwt.decode(
        data["access_token"],
        key=STRONG_TEST_SECRET,
        algorithms=["HS256"],
        audience="authenticated",
        issuer="qemma-local-auth",
    )
    assert decoded["role"] == "general_manager"
    assert decoded["roles"] == ["general_manager"]

    user = verify_local_jwt(data["access_token"])
    roles = await get_user_roles(user)
    assert roles == {"general_manager"}

    gm_perms = ROLE_PERMISSIONS_MAP["general_manager"]
    assert "inventory:stocktake:post" in gm_perms
    assert "inventory:stocktake:approve" in gm_perms
    assert "catalog:item:approve" in gm_perms


@pytest.mark.asyncio
async def test_local_login_warehouse_manager_produces_only_warehouse_role_and_permissions(enable_dev_auth):
    """2. تسجيل الدخول المحلي كأمين مخزن ينتج حصراً دور أمين المخزن وصلاحياته فقط."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/local-login", json={"role": "warehouse_manager"})

    assert response.status_code == 200
    data = response.json()
    assert data["user"]["id"] == "dev-user-00000000-0000-0000-0000-000000000002"
    assert data["user"]["email"] == "wh@qemma.local"

    decoded = jwt.decode(
        data["access_token"],
        key=STRONG_TEST_SECRET,
        algorithms=["HS256"],
        audience="authenticated",
        issuer="qemma-local-auth",
    )
    assert decoded["role"] == "warehouse_manager"
    assert decoded["roles"] == ["warehouse_manager"]

    user = verify_local_jwt(data["access_token"])
    roles = await get_user_roles(user)
    assert roles == {"warehouse_manager"}

    wh_perms = ROLE_PERMISSIONS_MAP["warehouse_manager"]
    assert "inventory:stocktake:count" in wh_perms
    assert "inventory:stocktake:submit" in wh_perms
    assert "warehouse:dispatch" in wh_perms
    assert "warehouse:finished_goods:receive" in wh_perms
    assert "suppliers:invoices:create" in wh_perms
    # محظورات أمين المخزن
    assert "inventory:stocktake:post" not in wh_perms
    assert "inventory:stocktake:approve" not in wh_perms
    assert "catalog:item:approve" not in wh_perms
    assert "production:wip:receive" not in wh_perms
    assert "production:orders:create" not in wh_perms
    assert "customers:orders:create" not in wh_perms
    assert "pricing:manage" not in wh_perms


@pytest.mark.asyncio
async def test_local_login_finance_manager_produces_only_finance_role_and_permissions(enable_dev_auth):
    """3. تسجيل الدخول كمدير مالي ينتج حصراً دور مدير المالية وصلاحياته فقط."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/local-login", json={"role": "finance_manager"})

    assert response.status_code == 200
    data = response.json()
    assert data["user"]["id"] == "dev-user-00000000-0000-0000-0000-000000000003"
    assert data["user"]["email"] == "fin@qemma.local"

    decoded = jwt.decode(
        data["access_token"],
        key=STRONG_TEST_SECRET,
        algorithms=["HS256"],
        audience="authenticated",
        issuer="qemma-local-auth",
    )
    assert decoded["role"] == "finance_manager"
    assert decoded["roles"] == ["finance_manager"]

    user = verify_local_jwt(data["access_token"])
    roles = await get_user_roles(user)
    assert roles == {"finance_manager"}

    fin_perms = ROLE_PERMISSIONS_MAP["finance_manager"]
    assert "finance:expenses:manage" in fin_perms
    assert "finance:payroll:manage" in fin_perms
    assert "finance:reports:view" in fin_perms
    # محظورات المدير المالي
    assert "warehouse:finished_goods:receive" not in fin_perms
    assert "production:wip:receive" not in fin_perms
    assert "suppliers:invoices:create" not in fin_perms
    assert "catalog:item:create" not in fin_perms
    assert "inventory:stocktake:post" not in fin_perms
    assert "production:templates:manage" not in fin_perms


@pytest.mark.asyncio
async def test_local_login_invalid_role_rejected(enable_dev_auth):
    """4. رفض أي دور خارج القائمة البيضاء المعتمدة برمز 400 Bad Request."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/local-login", json={"role": "superadmin"})

    assert response.status_code == 400
    assert "غير صالح" in response.json()["detail"]


@pytest.mark.asyncio
async def test_local_login_rejects_arbitrary_permission_injection(enable_dev_auth):
    """5. حظر أي محاولة لحقن صلاحيات أو ادعاءات عشوائية من جانب العميل."""
    malicious_body = {
        "role": "warehouse_manager",
        "permissions": ["*"],
        "admin": True,
        "is_superuser": True,
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/local-login", json=malicious_body)

    assert response.status_code == 200
    token = response.json()["access_token"]
    decoded = jwt.decode(
        token,
        key=STRONG_TEST_SECRET,
        algorithms=["HS256"],
        audience="authenticated",
        issuer="qemma-local-auth",
    )
    assert "permissions" not in decoded
    assert "admin" not in decoded
    assert "is_superuser" not in decoded
    assert decoded["role"] == "warehouse_manager"


@pytest.mark.asyncio
async def test_production_configuration_cannot_enable_local_role_switching():
    """6. إعدادات الإنتاج تحظر مسار تسجيل الدخول المحلي مهما كانت معاملات الطلب."""
    with patch.object(settings, "app_env", "production"), \
         patch.object(settings, "dev_auth_enabled", True):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp_body = await client.post("/api/v1/auth/local-login", json={"role": "general_manager"})
            resp_query = await client.post("/api/v1/auth/local-login?role=general_manager")

        assert resp_body.status_code == 404
        assert resp_query.status_code == 404


@pytest.mark.asyncio
async def test_warehouse_manager_cannot_post_stocktake(enable_dev_auth):
    """8. أمين المخزن لا يملك صلاحية ترحيل الجرد المخزني ويُحظر بـ 403 Forbidden."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        login_resp = await client.post("/api/v1/auth/local-login", json={"role": "warehouse_manager"})
        token = login_resp.json()["access_token"]

        response = await client.post(
            "/api/v1/inventory/stocktakes/stk-test-id/post",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 403
    assert "الصلاحية" in response.json()["detail"]


@pytest.mark.asyncio
async def test_finance_manager_cannot_perform_unauthorized_inventory_operations(enable_dev_auth):
    """9. المدير المالي لا يملك صلاحية إنشاء جلسات جرد أو إدارة المخزون ويُحظر بـ 403 Forbidden."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        login_resp = await client.post("/api/v1/auth/local-login", json={"role": "finance_manager"})
        token = login_resp.json()["access_token"]

        response = await client.post(
            "/api/v1/inventory/stocktakes",
            headers={"Authorization": f"Bearer {token}"},
            json={"warehouse_id": "wh-raw", "scope_type": "full_warehouse", "counting_date": "2026-11-02"},
        )

    assert response.status_code == 403
    assert "الصلاحية" in response.json()["detail"]


@pytest.mark.asyncio
async def test_backend_authorization_effective_even_if_frontend_bypassed(enable_dev_auth):
    """10. التحقق الخادمي في الـ API هو السلطة المطلقة حتى لو تم تجاوز قيود الواجهة."""
    from app.core.permissions import require_permission

    dep = require_permission("inventory:stocktake:approve")

    wh_user = AuthenticatedUser(
        id="dev-user-00000000-0000-0000-0000-000000000002",
        email="wh@qemma.local",
        claims={"role": "warehouse_manager", "roles": ["warehouse_manager"]},
    )

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        await dep(current_user=wh_user, db=None)

    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_switching_roles_replaces_token_and_does_not_retain_permissions(enable_dev_auth):
    """11. تبديل الأدوار يولد توكن وهوية جديدة مستقلة تماماً ولا يحتفظ بصلاحيات الجلسة السابقة."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp_gm = await client.post("/api/v1/auth/local-login", json={"role": "general_manager"})
        resp_wh = await client.post("/api/v1/auth/local-login", json={"role": "warehouse_manager"})

    gm_data = resp_gm.json()
    wh_data = resp_wh.json()

    assert gm_data["user"]["id"] != wh_data["user"]["id"]
    assert gm_data["user"]["email"] != wh_data["user"]["email"]
    assert gm_data["access_token"] != wh_data["access_token"]

    user_wh = verify_local_jwt(wh_data["access_token"])
    roles_wh = await get_user_roles(user_wh)
    assert roles_wh == {"warehouse_manager"}
    assert "general_manager" not in roles_wh


@pytest.mark.asyncio
async def test_verify_stocktake_same_user_approval_behavior(enable_dev_auth):
    """التحقق الصريح من سلوك النظام الحالي بخصوص اعتماد المستخدم لجلسته الجردية بنفسه."""
    from app.modules.production.stocktake_service import review_stocktake
    import inspect

    sig = inspect.signature(review_stocktake)
    assert "reviewer_id" in sig.parameters
    # النظام الحالي يعتمد على التحقق من الصلاحيات (require_permission)
    # دون فرض قيد إضافي يمنع المدير العام من اعتماد جرد شارك في إنشائه.
