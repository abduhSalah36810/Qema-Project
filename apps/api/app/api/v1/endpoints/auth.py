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
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.errors import ErrorResponse

router = APIRouter()


class UserIdentityResponse(BaseModel):
    """نموذج استجابة الهوية الأدنى للمستخدم المصادق عليه."""
    id: str = Field(..., description="المعرّف الفريد للمستخدم (المشتق من sub في التوكن)")
    email: Optional[str] = Field(default=None, description="البريد الإلكتروني للمستخدم إن توفر في التوكن")


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
