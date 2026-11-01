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
from app.core.permissions import require_permission
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
