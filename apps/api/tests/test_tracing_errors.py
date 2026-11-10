"""
اختبارات تتبع الطلبات ومعالجة الأخطاء الآمنة المقواة (Hardened Tracing & Safe Errors Tests)
─────────────────────────────────────────────────────────────────────────────
تتحقق من:
1. عدم كشف نصوص أخطاء HTTPException الاعتباطية وإرجاع رسائل عربية آمنة ومستقرة.
2. عدم تسريب مدخلات التحقق الحساسة (كلمات المرور، التوكنات، أرقام الهواتف) في استجابات 422.
3. حجب نصوص الاستثناءات ومعلمات SQL وتتبع الأخطاء عن كل من الاستجابة والسجلات في أخطاء 500.
4. توفر ترويسة X-Request-ID في كافة المسارات: النجاح، الأخطاء المعالجة، أخطاء 500، وفحص CORS Preflight.
5. غياب معاملات الاستعلام (Query Parameters) عن السجلات نهائياً.
6. تجنب التكرار في تسجيل الأخطاء للطلب الواحد.
─────────────────────────────────────────────────────────────────────────────
"""
import logging
import uuid
import pytest
from fastapi import HTTPException
from httpx import AsyncClient, ASGITransport
from pydantic import BaseModel, Field

from app.main import app
from app.core.tracing import validate_or_generate_request_id, REQUEST_ID_REGEX


# نماذج اختبارية لاختبار أخطاء التحقق دون التأثير على نماذج الإنتاج
class HardenedValidationBody(BaseModel):
    user_id: int
    password: str = Field(min_length=8)
    phone: str = Field(min_length=10)
    auth_token: str


# مسارات اختبارية خاصة بالفحوصات الأمنية تُسجّل فقط أثناء تشغيل الاختبارات
@app.post("/api/v1/__test_hardened_validation", include_in_schema=False)
async def sample_hardened_validation_endpoint(payload: HardenedValidationBody):
    return {"status": "ok", "user_id": payload.user_id}


@app.get("/api/v1/__test_arbitrary_http_error", include_in_schema=False)
async def sample_arbitrary_http_error_endpoint():
    raise HTTPException(
        status_code=400,
        detail="CRITICAL_DB_SYNTAX: SELECT * FROM credentials WHERE pass='SUPER_SECRET_SQL_PASS'",
    )


@app.get("/api/v1/__test_auth_header_preservation", include_in_schema=False)
async def sample_auth_header_endpoint():
    raise HTTPException(
        status_code=401,
        detail="Unauthorized access attempt",
        headers={"WWW-Authenticate": "Bearer realm=qemma_erp"},
    )


@app.get("/api/v1/__test_crash_route", include_in_schema=False)
async def sample_hardened_server_error_endpoint():
    raise RuntimeError("CRITICAL_INTERNAL_LEAK: db_pass=super_secret_production_password_999")



@pytest.mark.asyncio
async def test_arbitrary_http_error_details_not_exposed():
    """التحقق من عدم كشف نصوص HTTPException.detail الاعتباطية للعميل وإرجاع رسالة عربية آمنة."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/__test_arbitrary_http_error")

    assert response.status_code == 400
    assert "x-request-id" in response.headers
    data = response.json()
    assert data["code"] == "BAD_REQUEST"
    assert data["request_id"] == response.headers["x-request-id"]

    # التأكد الصارم من عدم تسريب أي جزء من نص الاستثناء الاعتباطي
    assert "CRITICAL_DB_SYNTAX" not in response.text
    assert "credentials" not in response.text
    assert "SUPER_SECRET_SQL_PASS" not in response.text
    assert "SELECT" not in response.text

    # التحقق من إرجاع رسالة عربية آمنة ومستقرة
    assert "الطلب غير صالح أو تعذر تفسيره" in data["message"]


@pytest.mark.asyncio
async def test_http_exception_preserves_required_headers():
    """التحقق من الحفاظ على ترويسات الاستجابة المطلوبة (مثل WWW-Authenticate) مع معرّف الطلب."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/__test_auth_header_preservation")

    assert response.status_code == 401
    assert "x-request-id" in response.headers
    assert "www-authenticate" in response.headers
    assert response.headers["www-authenticate"] == "Bearer realm=qemma_erp"
    data = response.json()
    assert data["code"] == "UNAUTHORIZED"
    assert "يجب تسجيل الدخول" in data["message"]


@pytest.mark.asyncio
async def test_validator_messages_cannot_leak_sensitive_values():
    """التحقق من أن أخطاء التحقق 422 لا تسرب كلمات المرور أو التوكنات أو أرقام الهواتف."""
    secret_pass = "my_sensitive_password_12345"
    secret_phone = "01099999999_private_number"
    secret_token = "BEARER_TOKEN_SECRET_XYZ"

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/__test_hardened_validation",
            json={
                "user_id": "not_an_int",
                "password": "short",  # أقل من 8 أحرف
                "phone": "123",       # أقل من 10 أحرف
                # auth_token مفقود
            },
        )

    assert response.status_code == 422
    assert "x-request-id" in response.headers
    data = response.json()
    assert data["code"] == "VALIDATION_ERROR"
    assert data["request_id"] == response.headers["x-request-id"]
    assert isinstance(data["details"], list)

    # التحقق من أن نصوص المدققات لا تحوي مدخلات اعتباطية، وتعتمد على قائمة الأوصاف الآمنة
    for detail in data["details"]:
        assert "field" in detail
        assert "issue" in detail
        assert "type" in detail
        # التأكد أن الوصف مستقر وآمن وليس نص استثناء أو قيمة خام
        assert isinstance(detail["issue"], str)
        assert len(detail["issue"]) > 0

    # إرسال بيانات غير صالحة تحوي القيمة السرية مباشرة للتحقق من عدم انعكاسها
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response_leak_check = await client.post(
            "/api/v1/__test_hardened_validation",
            json={
                "user_id": secret_token,
                "password": secret_pass[:3],  # كلمة مرور قصيرة
                "phone": secret_phone[:3],
                "auth_token": secret_token,
            },
        )

    assert response_leak_check.status_code == 422
    assert secret_pass[:3] not in response_leak_check.text
    assert secret_phone[:3] not in response_leak_check.text
    assert secret_token not in response_leak_check.text


@pytest.mark.asyncio
async def test_unexpected_exception_text_absent_from_logs_and_response(caplog):
    """التحقق من غياب نص الاستثناء الداخلي عن الاستجابة وعن السجلات في أخطاء 500."""
    caplog.set_level(logging.INFO, logger="qemma.api")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/__test_crash_route")

    assert response.status_code == 500
    assert "x-request-id" in response.headers
    data = response.json()
    assert data["code"] == "INTERNAL_SERVER_ERROR"
    assert data["request_id"] == response.headers["x-request-id"]
    assert "حدث خطأ غير متوقع في الخادم" in data["message"]

    # التأكد من غياب النص الحساس والاستثناء تماماً عن جسم الاستجابة
    assert "CRITICAL_INTERNAL_LEAK" not in response.text
    assert "super_secret_production_password_999" not in response.text
    assert "RuntimeError" not in response.text
    assert "Traceback" not in response.text

    # فحص السجلات الملتقطة
    captured_logs = caplog.text

    # التأكد من غياب النص الحساس وتفاصيل الاستثناء عن السجلات تماماً
    assert "CRITICAL_INTERNAL_LEAK" not in captured_logs
    assert "super_secret_production_password_999" not in captured_logs
    assert "Traceback" not in captured_logs

    # التأكد من تسجيل تصنيف الخطأ الآمن (RuntimeError) ومعرّف الطلب
    assert "category=RuntimeError" in captured_logs
    assert f"request_id={data['request_id']}" in captured_logs

    # التأكد من عدم تكرار تسجيل الخطأ للطلب الواحد (تسجيل سجل خطأ واحد فقط)
    error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(error_records) == 1, f"Expected 1 error log, found {len(error_records)}"
    assert "category=RuntimeError" in error_records[0].message


@pytest.mark.asyncio
async def test_request_ids_present_on_all_paths():
    """التحقق من توفر معرّف الطلب X-Request-ID في كافة الحالات: النجاح، الأخطاء، وCORS Preflight."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        # 1. مسار النجاح 200
        res_ok = await client.get("/api/v1/health")
        assert res_ok.status_code == 200
        assert "x-request-id" in res_ok.headers
        assert REQUEST_ID_REGEX.match(res_ok.headers["x-request-id"])

        # 2. خطأ معالج 404
        res_404 = await client.get("/api/v1/not_found_test_path")
        assert res_404.status_code == 404
        assert "x-request-id" in res_404.headers
        assert res_404.json()["request_id"] == res_404.headers["x-request-id"]

        # 3. خطأ طريقة غير مسموحة 405
        res_405 = await client.post("/api/v1/health")
        assert res_405.status_code == 405
        assert "x-request-id" in res_405.headers
        assert res_405.json()["request_id"] == res_405.headers["x-request-id"]

        # 4. خطأ تحقق 422
        res_422 = await client.post("/api/v1/__test_hardened_validation", json={})
        assert res_422.status_code == 422
        assert "x-request-id" in res_422.headers
        assert res_422.json()["request_id"] == res_422.headers["x-request-id"]

        # 5. خطأ 500
        res_500 = await client.get("/api/v1/__test_crash_route")
        assert res_500.status_code == 500
        assert "x-request-id" in res_500.headers
        assert res_500.json()["request_id"] == res_500.headers["x-request-id"]


        # 6. فحص CORS Preflight (OPTIONS)
        res_options = await client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "X-Request-ID",
            },
        )
        assert res_options.status_code == 200
        assert "x-request-id" in res_options.headers
        assert REQUEST_ID_REGEX.match(res_options.headers["x-request-id"])
        assert "access-control-allow-origin" in res_options.headers


@pytest.mark.asyncio
async def test_query_params_absent_from_logs(caplog):
    """التحقق من أن معاملات الاستعلام لا تظهر نهائياً في سجلات الخادم."""
    caplog.set_level(logging.INFO, logger="qemma.api")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/v1/health?user_token=SECRET_TOKEN_456&query_val=SENSITIVE_PARAM"
        )

    assert response.status_code == 200
    log_text = caplog.text
    assert "request_completed" in log_text
    assert "path=/api/v1/health" in log_text

    # التأكد الصارم من عدم ظهور أسماء أو قيم معاملات الاستعلام
    assert "user_token" not in log_text
    assert "SECRET_TOKEN_456" not in log_text
    assert "query_val" not in log_text
    assert "SENSITIVE_PARAM" not in log_text


def test_validator_unit_cases():
    """اختبارات الوحدة لدالة التحقق من معرّف الطلب."""
    assert validate_or_generate_request_id(None) is not None
    assert validate_or_generate_request_id("") is not None
    assert validate_or_generate_request_id("   ") is not None
    assert validate_or_generate_request_id("valid-id_123") == "valid-id_123"
    assert validate_or_generate_request_id("a" * 64) == "a" * 64
    assert validate_or_generate_request_id("a" * 65) != "a" * 65
    assert validate_or_generate_request_id("bad id with spaces") != "bad id with spaces"
    assert validate_or_generate_request_id("header\r\ninjection") != "header\r\ninjection"
