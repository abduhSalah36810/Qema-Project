"""
اختبارات الجاهزية التشغيلية لقاعدة البيانات (Readiness Endpoint Tests)
─────────────────────────────────────────────────────────────────────────────
تتحقق من:
1. إرجاع 200 وحالة جاهزية صريحة عند نجاح استعلام قاعدة البيانات (SELECT 1).
2. إرجاع 503 واستجابة آمنة تحوي معرّف الطلب دون تسريب نصوص الاتصال أو الأسرار عند تعطل قاعدة البيانات.
3. استقلالية مسار الصحة /api/v1/health التامة عن حالة قاعدة البيانات.
تعتمد هذه الاختبارات على عزل ومحاكاة (Mocking) فحص الاتصال لتعمل بكفاءة دون اشتراط خادم PostgreSQL محلي.
─────────────────────────────────────────────────────────────────────────────
"""
from unittest.mock import AsyncMock, patch
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app


@pytest.mark.asyncio
async def test_ready_endpoint_success():
    """التحقق من نجاح فحص الجاهزية (200) عند توفر الاتصال بقاعدة البيانات."""
    with patch(
        "app.api.v1.endpoints.ready.check_database_connection",
        new_callable=AsyncMock,
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/ready")

    assert response.status_code == 200
    assert "x-request-id" in response.headers
    data = response.json()
    assert data["status"] == "ready"
    assert data["database"] == "connected"


@pytest.mark.asyncio
async def test_ready_endpoint_db_unavailable():
    """التحقق من إرجاع 503 آمن مع معرّف الطلب عند فشل الاتصال بقاعدة البيانات."""
    with patch(
        "app.api.v1.endpoints.ready.check_database_connection",
        side_effect=OSError("Connection refused: 127.0.0.1:5432 - secret_db_password_xyz"),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/ready")

    assert response.status_code == 503
    assert "x-request-id" in response.headers
    data = response.json()
    assert data["code"] == "SERVICE_UNAVAILABLE"
    assert data["request_id"] == response.headers["x-request-id"]
    assert "قاعدة البيانات غير متوفرة" in data["message"]

    # التأكد الصارم من عدم تسريب أي تفاصيل اتصال أو نصوص استثناءات
    assert "secret_db_password_xyz" not in response.text
    assert "Connection refused" not in response.text
    assert "127.0.0.1:5432" not in response.text
    assert "OSError" not in response.text


@pytest.mark.asyncio
async def test_health_remains_independent_of_database():
    """التحقق من أن مسار /health يعمل باستقلالية تامة ولا يتأثر بحالة قاعدة البيانات."""
    # حتى لو كان فحص الاتصال بقاعدة البيانات يرمي استثناءً حاداً
    with patch(
        "app.api.v1.endpoints.ready.check_database_connection",
        side_effect=RuntimeError("Database crashed"),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/health")

    assert response.status_code == 200
    data = response.json()
    assert data == {
        "status": "ok",
        "app": "qemma-erp",
        "version": "0.1.0",
    }
