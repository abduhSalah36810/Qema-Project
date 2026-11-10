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
from fastapi import APIRouter, Depends, HTTPException, Query, status
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
    roles: list[str] = Field(default_factory=list, description="الأدوار الفعلية المعتمدة خادمياً")
    permissions: list[str] = Field(default_factory=list, description="الصلاحيات الفعلية المشتقة من الأدوار (مصدر الحقيقة للواجهة)")


class LocalLoginRequest(BaseModel):
    """طلب تسجيل الدخول المحلي مع اختيار الدور المصرح به."""
    role: Optional[str] = Field(default=None, description="الدور المحلي المطلوب: general_manager, warehouse_manager, production_manager, finance_manager")


class LocalLoginResponse(BaseModel):
    """نموذج استجابة تسجيل الدخول المحلي للتطوير."""
    access_token: str = Field(..., description="توكن الوصول JWT المحلي")
    token_type: str = Field(default="bearer", description="نوع التوكن")
    expires_in: int = Field(..., description="مدة الصلاحية بالثواني")
    user: UserIdentityResponse = Field(..., description="بيانات المستخدم المحلي المستقر")


# قائمة الأدوار المحلية المصرح بها حصراً لبيئة التطوير والاختبار
ALLOWED_LOCAL_ROLES = {
    "general_manager",
    "warehouse_manager",
    "production_manager",
    "finance_manager",
}

# هويات اصطناعية منفصلة لكل دور لدعم سيناريوهات Maker-Checker وتفريق المسؤوليات
LOCAL_ROLE_PROFILES = {
    "general_manager": {
        "id": LOCAL_DEV_USER_ID,
        "email": LOCAL_DEV_USER_EMAIL,
    },
    "warehouse_manager": {
        "id": "dev-user-00000000-0000-0000-0000-000000000002",
        "email": "wh@qemma.local",
    },
    "production_manager": {
        "id": "dev-user-00000000-0000-0000-0000-000000000004",
        "email": "prod@qemma.local",
    },
    "finance_manager": {
        "id": "dev-user-00000000-0000-0000-0000-000000000003",
        "email": "fin@qemma.local",
    },
}


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
    is_eligible = settings.app_env.lower() in ("development", "testing")
    return AuthConfigResponse(
        dev_auth_enabled=bool(settings.dev_auth_enabled and is_eligible),
        supabase_configured=bool(settings.resolved_jwks_url),
        app_env=settings.app_env,
    )


@router.post(
    "/local-login",
    response_model=LocalLoginResponse,
    status_code=200,
    summary="تسجيل الدخول كمطور محلي (بيئة التطوير والاختبار فقط)",
    description="توليد توكن JWT محلي موثوق للدور المختار من القائمة البيضاء المعتمدة.",
    responses={
        200: {"description": "تم إصدار التوكن المحلي بنجاح", "model": LocalLoginResponse},
        400: {"description": "الدور المطلوب غير صالح أو غير مصرح به", "model": ErrorResponse},
        404: {"description": "المصادقة المحلية غير مفعلة أو البيئة ليست development/testing", "model": ErrorResponse},
    },
)
async def local_dev_login(
    payload_data: Optional[LocalLoginRequest] = None,
    role: Optional[str] = Query(default=None),
) -> LocalLoginResponse:
    """
    تسجيل دخول المطور المحلي:
    - محمي بالتحقق الصارم من كون البيئة development أو testing و DEV_AUTH_ENABLED=true.
    - محظور في بيئة الإنتاج أو البيئات المرحلية قطعياً بصرف النظر عن المعاملات.
    - لا يقبل أدواراً عشوائية أو صلاحيات مخصصة من العميل؛ يقتصر حصراً على القائمة البيضاء.
    - يوقع توكن JWT محلي باستخدام المفتاح السري المحلي وخوارزمية HS256 فوري دون تأخير.
    """
    is_eligible = settings.app_env.lower() in ("development", "testing")
    if not settings.dev_auth_enabled or not is_eligible:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="مسار المصادقة المحلية غير متاح في بيئة التشغيل الحالية.",
        )

    if not settings.local_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="المفتاح السري المحلي غير مهيأ في الخادم.",
        )

    # استخراج الدور المطلوب إما من جسم الطلب (JSON Body) أو معلمات الاستعلام (Query Parameter)
    requested_role = None
    if payload_data and payload_data.role:
        requested_role = payload_data.role
    elif role:
        requested_role = role

    target_role = requested_role.strip().lower() if requested_role else LOCAL_DEV_ROLE

    # التحقق الأمني الصارم: رفض أي دور خارج القائمة البيضاء المعتمدة
    if target_role not in ALLOWED_LOCAL_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"الدور المطلوب '{target_role}' غير صالح. الأدوار المصرح بها محلياً: {', '.join(sorted(ALLOWED_LOCAL_ROLES))}",
        )

    profile = LOCAL_ROLE_PROFILES[target_role]

    now = int(time.time())
    expires_in = 8 * 3600  # 8 ساعات
    exp = now + expires_in

    payload = {
        "sub": profile["id"],
        "email": profile["email"],
        "role": target_role,
        "roles": [target_role],
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
            id=profile["id"],
            email=profile["email"],
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
    db: AsyncSession = Depends(get_db),
) -> UserIdentityResponse:
    """
    استرجاع هوية المستخدم المصادق عليه مع أدواره وصلاحياته الفعلية كما يحسبها الخادم.
    الواجهة تعتمد هذه القائمة لإظهار الشاشات والإجراءات بدلاً من نسخة يدوية من مصفوفة الصلاحيات.
    """
    from app.core.permissions import get_permissions_for_roles, get_user_roles

    roles = await get_user_roles(current_user, db=db)
    return UserIdentityResponse(
        id=current_user.id,
        email=current_user.email,
        roles=sorted(roles),
        permissions=sorted(get_permissions_for_roles(roles)),
    )
