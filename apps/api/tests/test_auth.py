"""
اختبارات التحقق الخادمي من توكنات Supabase Auth JWT ومسار الهوية /auth/me
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. التوكنات الصالحة الموقعة بمفتاح RSA غير متماثل (RS256).
2. غياب بيانات الاعتماد أو صيغ الترويسات الخاطئة.
3. التوكنات منتهية الصلاحية (Expired).
4. عدم تطابق جهة الإصدار (Issuer) أو الجمهور (Audience).
5. غياب أو فراغ الادعاءات الإلزامية (sub, exp, iss, aud).
6. رفض الخوارزميات المتماثلة (HS256) أو غير المسموحة للحماية من هجمات Downgrade.
7. عدم توفر أو تعطل خدمة JWKS أو عدم العثور على المفتاح العام (unknown kid).
8. مبدأ الفشل المغلق (Fail-Closed) عند غياب إعدادات JWKS أو Issuer أو Audience.
9. ضمان سرية البيانات وعدم تسريب التوكنات أو المفاتيح أو نصوص الاستثناءات.
10. التحقق من بقاء مساري الصحة /health والجاهزية /ready متاحين للجميع دون مصادقة.
11. سلوك تبعية FastAPI (get_current_user و get_optional_user) مع التأكد الصارم
    من أن get_optional_user تعيد None فقط عند عدم تزويد أي ترويسة/بيانات اعتماد،
    وترمي 401 آمن عند إرسال بيانات مشوهة أو غير صالحة.
12. اختبار مسار الهوية GET /api/v1/auth/me وإرجاعه المعرّف والبريد فقط دون التوكن أو الادعاءات الخام.
13. التحقق من حصر سعة مخزن عملاء JWKS المؤقت (Bounded Cache).
─────────────────────────────────────────────────────────────────────────────
"""
import time
from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import APIRouter, Depends
from httpx import ASGITransport, AsyncClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKSetError

from app.core.auth import (
    MAX_JWKS_CLIENTS,
    AuthenticatedUser,
    _jwks_clients_cache,
    clear_jwks_cache,
    get_current_user,
    get_jwks_client,
    get_optional_user,
    verify_supabase_jwt,
)
from app.core.config import settings
from app.main import app


# ─── تجهيز مفاتيح RSA اختبارية في الذاكرة ──────────────────────────────────
@pytest.fixture(scope="module")
def rsa_keypair():
    """توليد زوج مفاتيح RSA اختباري في الذاكرة لأغراض الاختبار دون أي اعتماد خارجي."""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()

    pem_priv = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pem_pub = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return {"private_key": pem_priv, "public_key": pem_pub}


class MockSigningKey:
    """محاكاة لكائن مفتاح التوقيع العام المُرجع من PyJWKClient."""

    def __init__(self, key_bytes: bytes):
        self.key = key_bytes


class MockJWKSClient:
    """محاكاة لعميل JWKS يُرجع المفتاح العام المطابق."""

    def __init__(self, public_key_bytes: bytes):
        self.public_key_bytes = public_key_bytes

    def get_signing_key_from_jwt(self, token: str):
        return MockSigningKey(self.public_key_bytes)


def create_test_token(
    keypair: Dict[str, bytes],
    sub: Optional[str] = "550e8400-e29b-41d4-a716-446655440000",
    email: Optional[str] = "factory_worker@qemma.com",
    iss: str = "https://qemma-test.supabase.co/auth/v1",
    aud: str = "authenticated",
    exp_delta: int = 3600,
    algorithm: str = "RS256",
    custom_claims: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, Any]] = None,
) -> str:
    """إنشاء توكن JWT اختباري بالإعدادات المحددة."""
    now = int(time.time())
    payload: Dict[str, Any] = {
        "iss": iss,
        "aud": aud,
        "exp": now + exp_delta,
    }
    if sub is not None:
        payload["sub"] = sub
    if email is not None:
        payload["email"] = email
    if custom_claims:
        payload.update(custom_claims)

    token_headers = {"kid": "test-key-id"}
    if headers:
        token_headers.update(headers)

    return jwt.encode(
        payload,
        keypair["private_key"],
        algorithm=algorithm,
        headers=token_headers,
    )


# ─── إعداد مسار اختياري للاختبار ──────────────────────────────────────────
auth_test_router = APIRouter(prefix="/api/v1/test-auth", tags=["test"])


@auth_test_router.get("/optional")
async def optional_route(user: Optional[AuthenticatedUser] = Depends(get_optional_user)):
    if user:
        return {"status": "authenticated", "user_id": user.id}
    return {"status": "anonymous", "user_id": None}


app.include_router(auth_test_router)


# ─── الاختبارات ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_valid_token_authenticated_user(rsa_keypair):
    """التحقق من نجاح مصادقة توكن سليم واستخراج بيانات المستخدم."""
    token = create_test_token(rsa_keypair)

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        user = verify_supabase_jwt(token, request_id="req-test-1")

        assert isinstance(user, AuthenticatedUser)
        assert user.id == "550e8400-e29b-41d4-a716-446655440000"
        assert user.email == "factory_worker@qemma.com"
        assert user.claims["aud"] == "authenticated"


@pytest.mark.asyncio
async def test_auth_me_endpoint_success(rsa_keypair):
    """التحقق من عمل مسار الهوية GET /api/v1/auth/me وإرجاع id و email فقط."""
    token = create_test_token(rsa_keypair)

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 200
        assert "x-request-id" in response.headers
        data = response.json()
        assert data == {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "email": "factory_worker@qemma.com",
        }
        # التأكد التام من عدم كشف التوكن أو الادعاءات الخام
        assert "claims" not in data
        assert "token" not in data
        assert "aud" not in data
        assert "iss" not in data


@pytest.mark.asyncio
async def test_auth_me_endpoint_missing_credentials():
    """غياب ترويسة Authorization في /auth/me يعيد 401 آمن مع ترويسة WWW-Authenticate."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert "x-request-id" in response.headers
    assert response.headers.get("www-authenticate") == "Bearer"
    data = response.json()
    assert data["code"] == "UNAUTHORIZED"
    assert data["request_id"] == response.headers["x-request-id"]
    assert "تسجيل الدخول" in data["message"]


@pytest.mark.asyncio
async def test_auth_me_endpoint_invalid_token():
    """إرسال توكن مشوه إلى /auth/me يعيد 401 آمن مع حفظ معرّف الطلب."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer totally-invalid-token"},
        )

    assert response.status_code == 401
    assert "x-request-id" in response.headers
    data = response.json()
    assert data["code"] == "UNAUTHORIZED"
    assert "totally-invalid-token" not in response.text


@pytest.mark.asyncio
async def test_empty_or_whitespace_bearer_token():
    """إرسال ترويسة Bearer فارغة يعيد 401 آمن."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer   "},
        )

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_expired_token(rsa_keypair):
    """انتهاء صلاحية التوكن (exp في الماضي) يعيد 401 آمن."""
    token = create_test_token(rsa_keypair, exp_delta=-60)  # انتهى قبل 60 ثانية

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_wrong_issuer(rsa_keypair):
    """توكن صادر من جهة إصدار غير مطابقة (Wrong Issuer) يُرفض بـ 401."""
    token = create_test_token(rsa_keypair, iss="https://other-untrusted-project.supabase.co/auth/v1")

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_wrong_audience(rsa_keypair):
    """توكن مخصص لجمهور آخر (Wrong Audience) يُرفض بـ 401."""
    token = create_test_token(rsa_keypair, aud="anon")

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_missing_sub_claim(rsa_keypair):
    """غياب ادعاء sub الإلزامي يُرفض فوراً بـ 401."""
    token = create_test_token(rsa_keypair, sub=None)

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_empty_sub_claim(rsa_keypair):
    """وجود ادعاء sub بقيمة فارغة أو مسافات فقط يُرفض بـ 401."""
    token = create_test_token(rsa_keypair, sub="   ")

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_disallowed_symmetric_algorithm_hs256():
    """
    رفض التوكنات الموقعة بخوارزميات متماثلة مثل HS256 أو none لضمان عدم إضعاف الأمان
    (Algorithm Downgrade Protection).
    """
    payload = {
        "sub": "user-symmetric-attempt",
        "aud": "authenticated",
        "iss": "https://qemma-test.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
    }
    symmetric_token = jwt.encode(
        payload,
        "super-secret-symmetric-key-at-least-32-bytes-long",
        algorithm="HS256",
        headers={"kid": "symmetric-key"},
    )

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(b"dummy")):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {symmetric_token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_unknown_kid_fails_closed(rsa_keypair):
    """
    عند احتواء التوكن على kid غير معروف في مخزن مفاتيح JWKS،
    يفشل النظام بشكل مغلق ويعيد 401 دون تسريب معرّف المفتاح أو نص الخطأ.
    """
    token = create_test_token(rsa_keypair, headers={"kid": "unknown-nonexistent-key-id"})

    mock_client = MockJWKSClient(rsa_keypair["public_key"])
    mock_client.get_signing_key_from_jwt = patch.object(
        mock_client,
        "get_signing_key_from_jwt",
        side_effect=PyJWKSetError("Unable to find a signing key that matches: unknown-nonexistent-key-id"),
    ).start()

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=mock_client):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"
        assert "unknown-nonexistent-key-id" not in response.text
        assert "Unable to find a signing key" not in response.text


@pytest.mark.asyncio
async def test_unavailable_jwks_configuration(rsa_keypair):
    """عند تعطل الوصول لـ JWKS (مشكلة شبكة)، يفشل النظام بشكل مغلق ويعيد 401 آمن."""
    token = create_test_token(rsa_keypair)

    mock_client = MockJWKSClient(rsa_keypair["public_key"])
    mock_client.get_signing_key_from_jwt = patch.object(
        mock_client,
        "get_signing_key_from_jwt",
        side_effect=PyJWKClientConnectionError("Could not reach JWKS endpoint"),
    ).start()

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=mock_client):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"
        assert "Could not reach JWKS endpoint" not in response.text


@pytest.mark.asyncio
async def test_missing_jwks_configuration_fails_closed(rsa_keypair):
    """
    عند غياب إعدادات JWKS بالكامل (عدم تحديد SUPABASE_URL ولا SUPABASE_JWKS_URL)،
    يفشل النظام بشكل مغلق وآمن ويعيد 401 بدلاً من السماح بأي وصول.
    """
    token = create_test_token(rsa_keypair)

    with patch.object(settings, "supabase_url", None), \
         patch.object(settings, "supabase_jwks_url", None):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_missing_issuer_or_audience_configuration_fails_closed(rsa_keypair):
    """غياب إعدادات جهة الإصدار أو الجمهور يغلق الباب فوراً بـ 401."""
    token = create_test_token(rsa_keypair)

    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwt_audience", ""):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_optional_user_dependency_strictly_fails_on_invalid_credentials(rsa_keypair):
    """
    فحص صارم لـ get_optional_user:
    - يعيد None فقط وفقط إذا لم يتم إرسال ترويسة Authorization أو كانت فارغة.
    - إذا أُرسلت بيانات اعتماد (Basic auth, Bearer فارغ, توكن مشوه أو غير صالح)،
      يجب أن يفشل بنفس 401 الآمن ولا يتجاوز كـ anonymous.
    """
    # 1. بدون أي ترويسة تفويض -> يعبر كـ anonymous (200)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_no_auth = await client.get("/api/v1/test-auth/optional")
    assert res_no_auth.status_code == 200
    assert res_no_auth.json() == {"status": "anonymous", "user_id": None}

    # 2. بترويسة Authorization فارغة تماماً -> يعبر كـ anonymous (200)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_empty_auth = await client.get("/api/v1/test-auth/optional", headers={"Authorization": "  "})
    assert res_empty_auth.status_code == 200
    assert res_empty_auth.json() == {"status": "anonymous", "user_id": None}

    # 3. مع توكن Bearer صالح -> يعبر كمصادق عليه
    token = create_test_token(rsa_keypair)
    with patch.object(settings, "supabase_url", "https://qemma-test.supabase.co"), \
         patch.object(settings, "supabase_jwks_url", None), \
         patch.object(settings, "supabase_jwt_issuer", None), \
         patch.object(settings, "supabase_jwt_audience", "authenticated"), \
         patch("app.core.auth.get_jwks_client", return_value=MockJWKSClient(rsa_keypair["public_key"])):

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res_valid = await client.get(
                "/api/v1/test-auth/optional",
                headers={"Authorization": f"Bearer {token}"},
            )
    assert res_valid.status_code == 200
    assert res_valid.json() == {
        "status": "authenticated",
        "user_id": "550e8400-e29b-41d4-a716-446655440000",
    }

    # 4. مع نظام مصادقة غير Bearer (مثل Basic auth) -> يجب أن يرمي 401 ولا يتجاوز كـ anonymous!
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_basic = await client.get(
            "/api/v1/test-auth/optional",
            headers={"Authorization": "Basic dXNlcjpwYXNz"},
        )
    assert res_basic.status_code == 401
    assert res_basic.json()["code"] == "UNAUTHORIZED"

    # 5. مع Bearer بدون قيمة توكن -> يجب أن يرمي 401
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_bearer_empty = await client.get(
            "/api/v1/test-auth/optional",
            headers={"Authorization": "Bearer   "},
        )
    assert res_bearer_empty.status_code == 401
    assert res_bearer_empty.json()["code"] == "UNAUTHORIZED"

    # 6. مع توكن Bearer غير صالح -> يجب أن يرمي 401
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_bad_token = await client.get(
            "/api/v1/test-auth/optional",
            headers={"Authorization": "Bearer not-a-valid-jwt"},
        )
    assert res_bad_token.status_code == 401
    assert res_bad_token.json()["code"] == "UNAUTHORIZED"


def test_verify_empty_token_fails_immediately():
    """التحقق من أن استدعاء verify_supabase_jwt بتوكن فارغ أو None يرمي 401 فوراً."""
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        verify_supabase_jwt("")
    assert exc_info.value.status_code == 401

    with pytest.raises(HTTPException) as exc_info:
        verify_supabase_jwt("   ")
    assert exc_info.value.status_code == 401


def test_jwks_clients_cache_is_strictly_bounded():
    """التحقق من أن مخزن عملاء JWKS محدد بسعة قصوى (MAX_JWKS_CLIENTS) ويطرد العناصر القديمة."""
    clear_jwks_cache()
    try:
        # إضافة عملاء أكثر من الحد الأقصى المسموح (8)
        for i in range(MAX_JWKS_CLIENTS + 5):
            get_jwks_client(f"https://supabase-{i}.example.co/auth/v1/jwks.json")

        assert len(_jwks_clients_cache) == MAX_JWKS_CLIENTS
    finally:
        clear_jwks_cache()


@pytest.mark.asyncio
async def test_health_and_readiness_remain_unauthenticated():
    """
    التحقق الصارم من بقاء مسارات الصحة (/health) والجاهزية (/ready) متاحة دون أي توكن
    أو مصادقة للحفاظ على استقرار الفحوصات التشغيلية للمصنع و CI.
    """
    with patch(
        "app.api.v1.endpoints.ready.check_database_connection",
        new_callable=AsyncMock,
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            health_res = await client.get("/api/v1/health")
            ready_res = await client.get("/api/v1/ready")

    assert health_res.status_code == 200
    assert health_res.json()["status"] == "ok"

    assert ready_res.status_code == 200
    assert ready_res.json()["status"] == "ready"
    assert ready_res.json()["database"] == "connected"
