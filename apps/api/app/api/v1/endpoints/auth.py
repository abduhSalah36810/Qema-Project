"""
مسار الهوية للمستخدم الحالي — GET /api/v1/auth/me
─────────────────────────────────────────────────────────────────────────────
يوفر:
1. استرجاع الهوية المصادق عليها الأدنى للمستخدم الحالي عبر توكن Supabase Auth JWT.
2. حماية المسار بتبعية get_current_user لضمان إلزامية المصادقة.
3. إرجاع المعرّف الثابت للمستخدم (id مشتق من sub) والبريد الإلكتروني الموثق (إن وجد) فقط.
4. حجب تام للتوكن الخام وكافة الادعاءات غير الضرورية.
─────────────────────────────────────────────────────────────────────────────
"""
import logging
import time
import uuid
from typing import Optional

logger = logging.getLogger("qemma.api.auth")

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    LOCAL_DEV_ROLE,
    LOCAL_DEV_USER_EMAIL,
    LOCAL_DEV_USER_ID,
    AuthenticatedUser,
    get_current_user,
)
from app.core.config import settings
from app.core.errors import ErrorResponse
from app.db.session import get_db
from app.modules.identity.models import Role, UserRole

router = APIRouter()


class UserIdentityResponse(BaseModel):
    """نموذج استجابة الهوية الأدنى للمستخدم المصادق عليه."""
    id: str = Field(..., description="المعرّف الفريد للمستخدم (المشتق من sub في التوكن)")
    email: Optional[str] = Field(default=None, description="البريد الإلكتروني للمستخدم إن توفر في التوكن")


class LocalLoginResponse(BaseModel):
    """نموذج استجابة تسجيل الدخول المحلي للتطوير."""
    access_token: str = Field(..., description="توكن الوصول JWT المحلي")
    token_type: str = Field(default="bearer", description="نوع التوكن")
    expires_in: int = Field(..., description="مدة الصلاحية بالثواني")
    user: UserIdentityResponse = Field(..., description="بيانات المستخدم المحلي المستقر")


class AuthConfigResponse(BaseModel):
    """حالة توفر مزودات المصادقة في بيئة التشغيل الحالية."""
    dev_auth_enabled: bool
    supabase_configured: bool
    app_env: str


@router.get(
    "/config",
    response_model=AuthConfigResponse,
    status_code=200,
    summary="فحص حالة توفر مزودات المصادقة",
)
async def get_auth_config() -> AuthConfigResponse:
    """استرجاع حالة مزودات المصادقة النشطة لمساعدة الواجهة في عرض خيارات الدخول المناسبة."""
    is_dev = settings.app_env.lower() == "development"
    return AuthConfigResponse(
        dev_auth_enabled=bool(settings.dev_auth_enabled and is_dev),
        supabase_configured=bool(settings.resolved_jwks_url),
        app_env=settings.app_env,
    )


@router.post(
    "/local-login",
    response_model=LocalLoginResponse,
    status_code=200,
    summary="تسجيل الدخول كمطور محلي (بيئة التطوير فقط)",
    description="توليد توكن JWT محلي موثوق وإسناد دور المدير العام في قاعدة البيانات المعزولة للمطور.",
    responses={
        200: {"description": "تم إصدار التوكن المحلي بنجاح", "model": LocalLoginResponse},
        404: {"description": "المصادقة المحلية غير مفعلة أو البيئة ليست development", "model": ErrorResponse},
    },
)
async def local_dev_login() -> LocalLoginResponse:
    """
    تسجيل دخول المطور المحلي:
    - محمي بالتحقق الصارم من APP_ENV=development و DEV_AUTH_ENABLED=true.
    - محظور في بيئة الإنتاج أو البيئات المرحلية قطعياً.
    - يوقع توكن JWT محلي باستخدام المفتاح السري المحلي وخوارزمية HS256 فوري دون تأخير.
    """
    if not settings.dev_auth_enabled or settings.app_env.lower() != "development":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="مسار المصادقة المحلية غير متاح في بيئة التشغيل الحالية.",
        )

    if not settings.local_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="المفتاح السري المحلي غير مهيأ في الخادم.",
        )

    # توليد التوكن المحلي الموقع فوراً دون حظر على الاتصال الشبكي
    now = int(time.time())
    expires_in = 8 * 3600  # 8 ساعات
    exp = now + expires_in

    payload = {
        "sub": LOCAL_DEV_USER_ID,
        "email": LOCAL_DEV_USER_EMAIL,
        "role": LOCAL_DEV_ROLE,
        "roles": [LOCAL_DEV_ROLE],
        "iss": settings.local_jwt_issuer,
        "aud": settings.supabase_jwt_audience,
        "iat": now,
        "exp": exp,
    }

    token = jwt.encode(
        payload,
        settings.local_jwt_secret,
        algorithm="HS256",
    )

    return LocalLoginResponse(
        access_token=token,
        token_type="bearer",
        expires_in=expires_in,
        user=UserIdentityResponse(
            id=LOCAL_DEV_USER_ID,
            email=LOCAL_DEV_USER_EMAIL,
        ),
    )


@router.get(
    "/me",
    response_model=UserIdentityResponse,
    status_code=200,
    summary="استرجاع الهوية الأدنى للمستخدم المصادق عليه",
    description="استرجاع المعرّف الفريد والبريد الإلكتروني للمستخدم المصادق عليه عبر توكن Supabase Auth JWT الممرر في ترويسة Authorization: Bearer <token>.",
    responses={
        200: {
            "description": "تم التحقق من التوكن بنجاح واسترجاع هوية المستخدم المصادق عليه",
            "model": UserIdentityResponse,
        },
        401: {
            "description": "فشل المصادقة: غياب التوكن، أو كونه غير صالح، أو انتهاء صلاحيته. تعاد استجابة آمنة تحوي معرّف الطلب دون كشف أسرار أو تفاصيل داخلية",
            "model": ErrorResponse,
        },
    },
)
async def get_current_identity(
    current_user: AuthenticatedUser = Depends(get_current_user),
) -> UserIdentityResponse:
    """
    استرجاع الهوية الأدنى للمستخدم المصادق عليه حالياً.
    يُرجع المعرّف الثابت والبريد الإلكتروني فقط دون تفاصيل التوكن أو الادعاءات الخام.
    """
    return UserIdentityResponse(
        id=current_user.id,
        email=current_user.email,
    )
