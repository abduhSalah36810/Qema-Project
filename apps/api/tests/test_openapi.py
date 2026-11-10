"""
اختبارات مخطط OpenAPI وتوثيق عقد المصادقة (OpenAPI Auth Contract Tests)
─────────────────────────────────────────────────────────────────────────────
تتحقق من:
1. توثيق مخطط الأمان القابل لإعادة الاستخدام HTTP Bearer (مع bearerFormat="JWT").
2. توثيق نقطة النهاية GET /api/v1/auth/me كمسار محمي يتطلب Bearer Authentication.
3. مطابقة نموذج استجابة 200 في OpenAPI لهيكل الهوية الفعلي (UserIdentityResponse).
4. توثيق استجابة 401 الآمنة في OpenAPI عبر نموذج ErrorResponse دون تسريب أسرار أو توكنات.
5. بقاء نقاط فحص الصحة /api/v1/health والجاهزية /api/v1/ready كمسارات عامة (Public Endpoints) دون متطلبات أمان.
6. مطابقة استجابة الخطأ الفعلية في وقت التشغيل (Runtime) للنموذج الموثق في OpenAPI.
─────────────────────────────────────────────────────────────────────────────
"""
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app


def test_openapi_http_bearer_security_scheme_defined():
    """التحقق من تعريف مخطط الأمان HTTP Bearer في components.securitySchemes مع توثيق JWT."""
    openapi_schema = app.openapi()
    components = openapi_schema.get("components", {})
    security_schemes = components.get("securitySchemes", {})

    assert "HTTPBearer" in security_schemes, "مخطط HTTPBearer غير معرّف في securitySchemes"
    bearer_scheme = security_schemes["HTTPBearer"]

    assert bearer_scheme.get("type") == "http"
    assert bearer_scheme.get("scheme") == "bearer"
    assert bearer_scheme.get("bearerFormat") == "JWT"
    assert bearer_scheme.get("description"), "يجب توفير وصف توضيحي لمخطط الأمان"


def test_auth_me_requires_bearer_security():
    """التحقق من توثيق مسار GET /api/v1/auth/me بطلب مخطط الأمان HTTPBearer."""
    openapi_schema = app.openapi()
    paths = openapi_schema.get("paths", {})
    assert "/api/v1/auth/me" in paths, "المسار /api/v1/auth/me غير مدرج في paths"

    auth_me_op = paths["/api/v1/auth/me"].get("get", {})
    security = auth_me_op.get("security", [])

    assert any("HTTPBearer" in sec_item for sec_item in security), (
        "المسار /api/v1/auth/me لم يُوثّق كمسار يتطلب HTTPBearer"
    )


def test_auth_me_200_response_schema():
    """التحقق من مطابقة نموذج استجابة 200 لـ UserIdentityResponse بالمعرّف والبريد الإلكتروني."""
    openapi_schema = app.openapi()
    auth_me_op = openapi_schema["paths"]["/api/v1/auth/me"]["get"]
    responses = auth_me_op.get("responses", {})

    assert "200" in responses, "استجابة 200 غير موثقة في /api/v1/auth/me"
    resp_200 = responses["200"]
    schema_ref = resp_200.get("content", {}).get("application/json", {}).get("schema", {}).get("$ref", "")

    assert schema_ref.endswith("UserIdentityResponse"), "استجابة 200 لا ترتبط بنموذج UserIdentityResponse"

    user_identity_schema = openapi_schema["components"]["schemas"]["UserIdentityResponse"]
    properties = user_identity_schema.get("properties", {})

    assert "id" in properties, "حقل id مفقود في UserIdentityResponse"
    assert "email" in properties, "حقل email مفقود في UserIdentityResponse"
    assert "id" in user_identity_schema.get("required", []), "حقل id يجب أن يكون مطلوباً (required)"


def test_auth_me_401_response_schema():
    """التحقق من توثيق استجابة 401 الآمنة دون كشف أي أسرار أو تفاصيل داخلية."""
    openapi_schema = app.openapi()
    auth_me_op = openapi_schema["paths"]["/api/v1/auth/me"]["get"]
    responses = auth_me_op.get("responses", {})

    assert "401" in responses, "استجابة 401 غير موثقة في /api/v1/auth/me"
    resp_401 = responses["401"]
    schema_ref = resp_401.get("content", {}).get("application/json", {}).get("schema", {}).get("$ref", "")

    assert schema_ref.endswith("ErrorResponse"), "استجابة 401 لا ترتبط بنموذج ErrorResponse"

    error_schema = openapi_schema["components"]["schemas"]["ErrorResponse"]
    properties = error_schema.get("properties", {})

    # التحقق من وجود الحقول الأساسية للاستجابة الآمنة
    assert "code" in properties
    assert "message" in properties
    assert "detail" in properties
    assert "request_id" in properties

    # التحقق الصارم: حظر كشف أي حقول حساسة في نموذج الخطأ
    forbidden_fields = {"token", "secret", "jwt", "credentials", "claims", "password", "traceback", "exception"}
    assert not any(f in properties for f in forbidden_fields), (
        f"نموذج الخطأ يحتوي على حقول حساسة محظورة: {properties.keys()}"
    )


def test_health_and_ready_endpoints_remain_public():
    """التحقق من بقاء مسارات /api/v1/health و /api/v1/ready عامة دون متطلبات أمان في OpenAPI."""
    openapi_schema = app.openapi()
    paths = openapi_schema.get("paths", {})

    # 1. التأكد من عدم وجود متطلب أمان عام على مستوى التطبيق ككل
    assert "security" not in openapi_schema, "يوجد متطلب أمان عام يفرض المصادقة على كافة المسارات"

    # 2. فحص مسار /api/v1/health
    assert "/api/v1/health" in paths
    health_op = paths["/api/v1/health"].get("get", {})
    assert not health_op.get("security"), "مسار /api/v1/health لا يجب أن يتطلب مصادقة (Public)"

    # 3. فحص مسار /api/v1/ready
    assert "/api/v1/ready" in paths
    ready_op = paths["/api/v1/ready"].get("get", {})
    assert not ready_op.get("security"), "مسار /api/v1/ready لا يجب أن يتطلب مصادقة (Public)"


@pytest.mark.asyncio
async def test_runtime_401_response_matches_openapi_error_schema():
    """التحقق من أن استجابة وقت التشغيل (Runtime) الفعلية تطابق حقول ErrorResponse الموثقة."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    data = response.json()

    # فحص مطابقة بنية الاستجابة الفعلية لما هو موثق في OpenAPI
    assert data["code"] == "UNAUTHORIZED"
    assert data["message"] == "يجب تسجيل الدخول للوصول إلى هذا المورد."
    assert data["detail"] == data["message"]
    assert "request_id" in data
    assert data["request_id"] == response.headers["x-request-id"]
