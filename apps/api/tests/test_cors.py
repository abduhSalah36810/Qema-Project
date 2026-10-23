"""
اختبارات سياسة CORS المقواة وإعداداتها الآمنة (Hardened CORS Policy Tests)
─────────────────────────────────────────────────────────────────────────────
تتحقق من:
1. استجابة طلبات الفحص المسبق (OPTIONS Preflight) للنطاقات المصرح بها بنجاح (200).
2. دعم الترويسات المطلوبة للواجهة الأمامية: Authorization وContent-Type وX-Request-ID وAccept وOrigin.
3. دعم طرق HTTP المطلوبة للواجهة: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD.
4. تفعيل الاعتمادات (Access-Control-Allow-Credentials: true) وإتاحة معرّف الطلب (Expose X-Request-ID).
5. بقاء معرّف الطلب X-Request-ID حاضراً في استجابات Preflight وكافة الاستجابات.
6. حجب ترويسات CORS عن النطاقات غير المصرح بها (Disallowed Origins).
7. رفض ترويسات الطلب المسبق غير المعتمدة (Disallowed Headers).
8. التحقق الآمن في Pydantic Settings:
   - حظر النطاق العام '*' وحظر 'null' لمنع الهجمات عند تفعيل الاعتمادات.
   - حظر النطاقات التي لا تبدأ ببروتوكول صريح (http:// أو https://).
   - حظر نطاقات localhost/127.0.0.1 في بيئة الإنتاج (app_env=production).
   - إلزامية تحديد CORS_ALLOWED_ORIGINS في بيئة الإنتاج وعدم تركه فارغاً.
   - معالجة النصوص المفصولة بفواصل وصيغة مصفوفة JSON وإزالة الشرطة المائلة الأخيرة (trailing slash).
─────────────────────────────────────────────────────────────────────────────
"""
import pytest
from httpx import AsyncClient, ASGITransport
from pydantic_core import ValidationError

from app.main import app
from app.core.config import Settings
from app.core.tracing import REQUEST_ID_REGEX


# ─────────────────────────────────────────────────────────────────────────────
# 1. اختبارات مسار CORS Preflight (OPTIONS)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cors_preflight_allowed_origin_success():
    """التحقق من نجاح طلب OPTIONS Preflight للنطاق المصرح به مع الترويسات المطلوبة ومعرّف الطلب."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization, Content-Type, X-Request-ID",
            },
        )

    assert response.status_code == 200
    headers = response.headers

    # التحقق من ترويسات CORS الأساسية
    assert headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert headers.get("access-control-allow-credentials") == "true"
    assert "access-control-allow-methods" in headers
    assert "GET" in headers["access-control-allow-methods"]

    # التحقق من الترويسات المسموحة
    allow_headers = headers.get("access-control-allow-headers", "").lower()
    assert "authorization" in allow_headers
    assert "content-type" in allow_headers
    assert "x-request-id" in allow_headers

    # التحقق من مدة التخزين المؤقت للـ preflight
    assert headers.get("access-control-max-age") == "600"

    # التحقق الحاسم: ترويسة X-Request-ID موجودة وصالحة في استجابة Preflight
    assert "x-request-id" in headers
    assert REQUEST_ID_REGEX.match(headers["x-request-id"])


@pytest.mark.asyncio
async def test_cors_preflight_127_0_0_1_origin_success():
    """التحقق من أن النطاق البديل للتطوير المحلي (127.0.0.1) مسموح به صراحة."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization, content-type",
            },
        )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"
    assert response.headers.get("access-control-allow-credentials") == "true"
    assert "x-request-id" in response.headers


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
async def test_cors_preflight_supported_methods(method: str):
    """التحقق من دعم طرق HTTP المتعددة التي تستخدمها الواجهة الأمامية."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": method,
            },
        )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert method in response.headers.get("access-control-allow-methods", "")


@pytest.mark.asyncio
async def test_cors_preflight_disallowed_origin_fails():
    """التحقق من حجب ترويسات CORS عن النطاقات غير المصرح بها في طلبات Preflight."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://malicious-attacker.com",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            },
        )

    # يرفض الوسيط إضافة access-control-allow-origin
    assert "access-control-allow-origin" not in response.headers
    # ومع ذلك معرّف الطلب محفوظ لتتبع أي نشاط مشبوه
    assert "x-request-id" in response.headers


@pytest.mark.asyncio
async def test_cors_preflight_disallowed_header_rejected():
    """التحقق من رفض طلب Preflight إذا طلب ترويسة غير مسموحة."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "X-Custom-Malicious-Header",
            },
        )

    # Starlette يرجع 400 مع نص Disallowed CORS headers عند طلب ترويسة غير مدرجة
    assert response.status_code == 400
    assert "Disallowed CORS headers" in response.text
    assert "x-request-id" in response.headers


# ─────────────────────────────────────────────────────────────────────────────
# 2. اختبارات الطلبات الفعلية (Simple / Authenticated Requests)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cors_actual_request_allowed_origin():
    """التحقق من تضمين ترويسات CORS وترويسة expose-headers في الطلبات العادية الناجحة."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/v1/health",
            headers={"Origin": "http://localhost:5173"},
        )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert response.headers.get("access-control-allow-credentials") == "true"
    # ترويسة X-Request-ID معرّفة صراحة في expose-headers ليتمكن جافاسكريبت المتصفح من قراءتها
    assert "X-Request-ID" in response.headers.get("access-control-expose-headers", "")
    assert "x-request-id" in response.headers


@pytest.mark.asyncio
async def test_cors_actual_request_disallowed_origin():
    """التحقق من أن الطلب الفعلي من نطاق غير مصرح به لا يتلقى ترويسة access-control-allow-origin."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/v1/health",
            headers={"Origin": "http://untrusted-external-site.org"},
        )

    assert response.status_code == 200
    # الخادم يستجيب ولكن دون ترويسة السماح فيمنع المتصفح الواجهة من قراءة البيانات
    assert "access-control-allow-origin" not in response.headers
    assert "x-request-id" in response.headers


# ─────────────────────────────────────────────────────────────────────────────
# 3. اختبارات التحقق الآمن للإعدادات (Settings Validation Tests)
# ─────────────────────────────────────────────────────────────────────────────

def test_cors_settings_disallows_wildcard_string():
    """التحقق من فشل الإعدادات بشكل صريح عند استخدام النطاق العام '*' كنص."""
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            cors_allowed_origins="*",
        )
    errors = str(exc_info.value)
    assert "غير مسموح به مع تفعيل المصادقة والاعتمادات" in errors


def test_cors_settings_disallows_wildcard_in_list():
    """التحقق من فشل الإعدادات إذا تضمنت القائمة النطاق العام '*'."""
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            cors_allowed_origins=["http://localhost:5173", "*"],
        )
    errors = str(exc_info.value)
    assert "غير مسموح به مع تفعيل المصادقة والاعتمادات" in errors


def test_cors_settings_disallows_null_origin():
    """التحقق من حظر النطاق 'null' لمنع استغلاله عبر iframes أو ملفات محلية."""
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            cors_allowed_origins="null",
        )
    errors = str(exc_info.value)
    assert "غير مسموح به مع تفعيل المصادقة والاعتمادات" in errors


def test_cors_settings_disallows_invalid_scheme():
    """التحقق من إلزامية أن يبدأ النطاق بـ http:// أو https://."""
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            cors_allowed_origins="localhost:5173",
        )
    assert "يجب أن يبدأ ببروتوكول صريح" in str(exc_info.value)

    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            cors_allowed_origins="ftp://example.com",
        )
    assert "يجب أن يبدأ ببروتوكول صريح" in str(exc_info.value)


def test_cors_settings_parsing_and_normalization():
    """التحقق من تجريد الشرطة المائلة الأخيرة وتقليم المسافات ودعم القوائم والمصفوفات."""
    # 1. نص مفصول بفاصلة مع مسافات وشرطة مائلة زائدة
    s1 = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        cors_allowed_origins=" http://localhost:5173/ , http://127.0.0.1:5173/ ",
    )
    assert s1.cors_allowed_origins == ["http://localhost:5173", "http://127.0.0.1:5173"]

    # 2. مصفوفة بصيغة JSON
    s2 = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        cors_allowed_origins='["https://app.example.com/", "https://admin.example.com"]',
    )
    assert s2.cors_allowed_origins == ["https://app.example.com", "https://admin.example.com"]


def test_cors_production_safety_validation():
    """التحقق من تطبيق قيود الأمان الصارمة في بيئة الإنتاج (app_env=production)."""
    # 1. رفض localhost في الإنتاج
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            app_env="production",
            cors_allowed_origins="http://localhost:5173",
        )
    assert "غير مسموح به في بيئة الإنتاج" in str(exc_info.value)

    # 2. رفض 127.0.0.1 في الإنتاج
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            app_env="production",
            cors_allowed_origins="http://127.0.0.1:5173",
        )
    assert "غير مسموح به في بيئة الإنتاج" in str(exc_info.value)

    # 3. رفض الإعدادات الفارغة في الإنتاج
    with pytest.raises(ValidationError) as exc_info:
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            app_env="production",
            cors_allowed_origins="",
        )
    assert "يجب تحديد CORS_ALLOWED_ORIGINS صراحة وبشكل آمن في بيئة الإنتاج" in str(exc_info.value)

    # 4. قبول النطاق الآمن في الإنتاج
    prod_settings = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        app_env="production",
        cors_allowed_origins="https://app.qemma-factory.com",
    )
    assert prod_settings.cors_allowed_origins == ["https://app.qemma-factory.com"]
