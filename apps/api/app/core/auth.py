"""
وحدة المصادقة والتحقق من توكنات Supabase Auth JWT
─────────────────────────────────────────────────────────────────────────────
توفر:
1. التحقق الخادمي من توكنات JWT الصادرة من Supabase Auth باستخدام المفاتيح غير المتماثلة (JWKS).
2. فحص صارم ومحمي للتوقيع وخوارزميات التشفير المسموحة حصراً (RS256, ES256).
3. التحقق الإلزامي من الادعاءات القياسية: iss (جهة الإصدار)، aud (الجمهور)، exp (الصلاحية)، و sub (المستخدم).
4. مبدأ الإغلاق الآمن عند الفشل (Fail-Closed): أي نقص في الإعدادات أو عدم مطابقة المفتاح يعيد 401 آمن.
5. استخراج هوية المستخدم المصادق عليه AuthenticatedUser دون فرض أي قواعد أدوار أو صلاحيات.
6. حجب التوكنات والادعاءات ومواد المفاتيح ونصوص الاستثناءات عن الاستجابات والسجلات.
─────────────────────────────────────────────────────────────────────────────
"""
import logging
from typing import Any, Dict, List, Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient, PyJWKClientError, PyJWTError
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.tracing import get_request_id

logger = logging.getLogger("qemma.api")

# الخوارزميات غير المتماثلة المسموح بها حصراً لمفاتيح JWKS
# يُمنع نهائياً قبول الخوارزميات المتماثلة (مثل HS256) أو "none" لضمان عدم إضعاف الأمان
ALLOWED_ASYMMETRIC_ALGORITHMS: List[str] = ["RS256", "ES256"]

# مخزن مؤقت لعملاء JWKS لضمان إعادة استخدام المفاتيح المخزنة (Key Caching) مع حد أقصى للذاكرة
MAX_JWKS_CLIENTS = 8
_jwks_clients_cache: Dict[str, PyJWKClient] = {}

# مخطط استخراج ترويسة Authorization: Bearer <token> مع auto_error=False وتوثيق صيغة JWT في OpenAPI
http_bearer_scheme = HTTPBearer(
    auto_error=False,
    bearerFormat="JWT",
    description="توكن الوصول (JWT) الصادر من Supabase Auth — يُرسل في ترويسة Authorization: Bearer <token>",
)


class AuthenticatedUser(BaseModel):
    """
    هوية المستخدم المصادق عليها مستخرجة من توكن Supabase Auth.
    تقتصر على المعرّف الأساسي (sub) والبيانات الموثقة فقط، دون فرض قواعد صلاحيات أو أدوار.
    """
    id: str = Field(..., description="المعرّف الفريد للمستخدم (UUID) المشتق من حقل sub")
    email: Optional[str] = Field(default=None, description="البريد الإلكتروني للمستخدم إن توفر في التوكن")
    claims: Dict[str, Any] = Field(default_factory=dict, description="كامل ادعاءات التوكن لأغراض التفويض المستقبلي")


def get_jwks_client(jwks_url: str) -> PyJWKClient:
    """
    إنشاء أو استرجاع عميل JWKS مع التخزين المؤقت للمفاتيح (Caching) وحد أقصى محكم.
    يحفظ المفاتيح في الذاكرة لتفادي تكرار طلبات الشبكة لكل استدعاء.
    """
    if jwks_url not in _jwks_clients_cache:
        if len(_jwks_clients_cache) >= MAX_JWKS_CLIENTS:
            _jwks_clients_cache.pop(next(iter(_jwks_clients_cache)))
        _jwks_clients_cache[jwks_url] = PyJWKClient(
            uri=jwks_url,
            cache_keys=True,
            max_cached_keys=16,
            cache_jwk_set=True,
            lifespan=300,  # الاحتفاظ بالمفاتيح المخزنة لمدة 5 دقائق
        )
    return _jwks_clients_cache[jwks_url]


def clear_jwks_cache() -> None:
    """تفريغ المخزن المؤقت للمفاتيح (مفيد للاختبارات وتحديث المفاتيح)."""
    _jwks_clients_cache.clear()


def verify_supabase_jwt(token: str, request_id: str = "-") -> AuthenticatedUser:
    """
    التحقق الخادمي الصارم من توكن Supabase Auth JWT:
    - التحقق من التوقيع الرقمي بمفتاح JWKS المناسب.
    - مطابقة الادعاءات الإلزامية: iss, aud, exp, sub.
    - الفشل الآمن (Fail-Closed): رمي HTTP 401 عند أي خلل دون كشف نصوص التوكن أو تفاصيل المفاتيح.
    """
    if not token or not isinstance(token, str) or not token.strip():
        logger.warning("auth_failed reason=empty_token request_id=%s", request_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Bearer"},
        )

    jwks_url = settings.resolved_jwks_url
    expected_issuer = settings.resolved_jwt_issuer
    expected_audience = settings.supabase_jwt_audience

    if not jwks_url or not expected_issuer or not expected_audience:
        logger.warning("auth_failed reason=configuration_missing request_id=%s", request_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        # جلب المفتاح العام المقابل لـ kid المحدد في ترويسة التوكن
        jwks_client = get_jwks_client(jwks_url)
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        # فك وفحص التوكن مع الخوارزميات غير المتماثلة المعتمدة حصراً
        payload = jwt.decode(
            token,
            key=signing_key.key,
            algorithms=ALLOWED_ASYMMETRIC_ALGORITHMS,
            audience=expected_audience,
            issuer=expected_issuer,
            options={
                "require": ["exp", "iss", "aud", "sub"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_iss": True,
                "verify_aud": True,
            },
        )

        sub = payload.get("sub")
        if not sub or not isinstance(sub, str) or not sub.strip():
            logger.warning("auth_failed reason=empty_sub request_id=%s", request_id)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": "Bearer"},
            )

        return AuthenticatedUser(
            id=sub.strip(),
            email=payload.get("email") if isinstance(payload.get("email"), str) else None,
            claims=payload,
        )

    except HTTPException:
        raise
    except (PyJWTError, PyJWKClientError, Exception) as exc:
        # تسجيل تصنيف الخطأ الآمن فقط دون طباعة التوكن أو ادعاءاته أو مواد المفتاح
        error_category = exc.__class__.__name__
        logger.warning(
            "auth_failed category=%s request_id=%s",
            error_category,
            request_id,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Bearer"},
        ) from None


async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(http_bearer_scheme),
) -> AuthenticatedUser:
    """
    تبعية FastAPI لإلزام التحقق من المستخدم وإرجاع هويته المصادق عليها.
    ترمي HTTP 401 آمن عند غياب التوكن أو عدم صلاحيته.
    """
    request_id = get_request_id(request)

    if credentials is None or not credentials.credentials or not credentials.credentials.strip():
        logger.warning("auth_failed reason=missing_credentials request_id=%s", request_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Bearer"},
        )

    return verify_supabase_jwt(credentials.credentials.strip(), request_id=request_id)


async def get_optional_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(http_bearer_scheme),
) -> Optional[AuthenticatedUser]:
    """
    تبعية FastAPI اختيارية:
    - تعيد None حصراً عند عدم إرسال ترويسة Authorization أو عدم تزويد أي بيانات اعتماد.
    - إذا أُرسلت بيانات اعتماد وكانت مشوهة أو غير صالحة أو منتهية الصلاحية،
      ترمي نفس خطأ HTTP 401 الآمن كما في التبعية الإلزامية.
    """
    if "authorization" not in request.headers:
        return None

    raw_auth = request.headers.get("authorization", "").strip()
    if not raw_auth:
        return None

    request_id = get_request_id(request)

    if credentials is None or not credentials.credentials or not credentials.credentials.strip():
        logger.warning("auth_failed reason=invalid_credentials_format request_id=%s", request_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Bearer"},
        )

    return verify_supabase_jwt(credentials.credentials.strip(), request_id=request_id)
