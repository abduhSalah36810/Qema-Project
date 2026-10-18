"""
اختبارات health check — تعمل بدون قاعدة بيانات حقيقية.
"""
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app


@pytest.mark.asyncio
async def test_health_returns_ok():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["app"] == "qemma-erp"
    assert "version" in data


@pytest.mark.asyncio
async def test_health_schema():
    """تحقق أن الاستجابة تحتوي الحقول المطلوبة فقط."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/health")

    data = response.json()
    assert set(data.keys()) == {"status", "app", "version"}
    # التأكد أن لا معلومات بنية داخلية أو بيانات اتصال تُكشف
    assert "database_url" not in str(data)
    assert "password" not in str(data).lower()
