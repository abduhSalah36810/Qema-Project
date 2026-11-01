"""
نظام الصلاحيات والأدوار المعتمدة مؤقتاً (Provisional Role-Based Access Control)
─────────────────────────────────────────────────────────────────────────────
يطبق سياسة الحظر الافتراضي (Deny-by-default):
- الأدوار المؤقتة:
  - general_manager: إدارة الأسعار، العملاء، قوالب الإنتاج، أوامر التشغيل، وتحديث المراحل.
  - warehouse_manager: فحص المخزون وتأكيد استلام المواد للدفعة في مخزن تحت التشغيل.
  - finance_manager: إدارة المصروفات، كشوف الرواتب، وسجلات المدفوعات والتقارير المالية.
- التحقق الصارم في الـ API: إخفاء الزر في الواجهة ليس تفويضاً.
- يتم إسناد الأدوار إدارياً عبر قاعدة البيانات (Seeding/Admin Function)؛ لا يوجد مسار عام للمستخدم لتعيين دوره بنفسه.
─────────────────────────────────────────────────────────────────────────────
"""
from typing import Callable, Iterable, List, Optional, Set
from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.modules.identity.models import Role, UserRole


# الأدوار المعتمدة مؤقتاً
ROLE_GENERAL_MANAGER = "general_manager"
ROLE_WAREHOUSE_MANAGER = "warehouse_manager"
ROLE_FINANCE_MANAGER = "finance_manager"

PROVISIONAL_ROLES = {
    ROLE_GENERAL_MANAGER,
    ROLE_WAREHOUSE_MANAGER,
    ROLE_FINANCE_MANAGER,
}

# مصفوفة الصلاحيات المؤقتة حسب الدور
ROLE_PERMISSIONS_MAP: dict[str, Set[str]] = {
    ROLE_GENERAL_MANAGER: {
        "production:templates:manage",
        "production:orders:manage",
        "production:stages:manage",
        "production:orders:view",
        "inventory:view",
        "inventory:manage",
        "catalog:view",
        "catalog:item:create",
        "catalog:item:update",
        "catalog:item:submit",
        "catalog:item:approve",
        "catalog:item:reject",
        "catalog:item:request_revision",
        "catalog:item:manage_revisions",
        "catalog:item:deactivate",
        "catalog:item:reactivate",
        "catalog:item:view_history",
        "warehouse:confirm_receipt",
        "warehouse:dispatch",
        "pricing:manage",
        "customers:manage",
        "customers:view",
        "customers:deliveries:manage",
        "finance:manage",
        "finance:cash:view",
        "suppliers:view",
        "suppliers:manage",
        "suppliers:receive",
    },
    ROLE_WAREHOUSE_MANAGER: {
        "inventory:view",
        "inventory:manage",
        "catalog:view",
        "catalog:item:create",
        "catalog:item:update",
        "catalog:item:submit",
        "catalog:item:request_revision",
        "catalog:item:view_history",
        "warehouse:confirm_receipt",
        "warehouse:dispatch",
        "production:orders:view",
        "customers:deliveries:manage",
        "suppliers:view",
        "suppliers:receive",
    },
    ROLE_FINANCE_MANAGER: {
        "finance:expenses:manage",
        "finance:cash:view",
        "finance:cash:manage",
        "suppliers:view",
        "suppliers:manage",
        "finance:payroll:manage",
        "finance:payments:manage",
        "finance:reports:view",
        "customers:view",
        "production:orders:view",
    },
}


async def get_user_roles(
    user: AuthenticatedUser,
    db: Optional[AsyncSession] = None,
) -> Set[str]:
    """
    استخراج أدوار المستخدم:
    1. من ادعاءات التوكن (JWT claims: role / roles / user_metadata / app_metadata).
    2. من جدول user_roles في قاعدة البيانات إذا توفرت الجلسة.
    """
    roles: Set[str] = set()

    # 1. فحص ادعاءات الـ JWT
    claims = user.claims or {}
    if "role" in claims and isinstance(claims["role"], str):
        roles.add(claims["role"].strip().lower())

    for key in ("roles", "user_roles"):
        val = claims.get(key)
        if isinstance(val, (list, tuple, set)):
            for r in val:
                if isinstance(r, str):
                    roles.add(r.strip().lower())

    for meta_key in ("app_metadata", "user_metadata"):
        meta = claims.get(meta_key)
        if isinstance(meta, dict):
            r = meta.get("role")
            if isinstance(r, str):
                roles.add(r.strip().lower())
            rs = meta.get("roles")
            if isinstance(rs, (list, tuple, set)):
                for item in rs:
                    if isinstance(item, str):
                        roles.add(item.strip().lower())

    # 2. الاستعلام من قاعدة البيانات إن وُجدت جلسة
    if db is not None:
        try:
            stmt = select(Role.name).join(UserRole, Role.id == UserRole.role_id).where(UserRole.user_id == user.id)
            result = await db.execute(stmt)
            for role_name in result.scalars().all():
                roles.add(role_name.strip().lower())
        except Exception:
            # إذا تعذر الاتصال بـ DB، نعتمد على ما وُجد بالتوكن
            pass

    return roles


def require_permission(required_permission: str) -> Callable:
    """
    تبعية FastAPI تفرض وجود صلاحية محددة لدى المستخدم.
    الحظر الافتراضي (Deny-by-default): إذا لم يملك المستخدم الدور المناسب، تُرمى 403 Forbidden.
    """
    async def dependency(
        current_user: AuthenticatedUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> AuthenticatedUser:
        user_roles = await get_user_roles(current_user, db=db)

        # التحقق من أن أحد أدوار المستخدم يمنح الصلاحية المطلوبة
        has_permission = False
        for role in user_roles:
            perms = ROLE_PERMISSIONS_MAP.get(role, set())
            if required_permission in perms:
                has_permission = True
                break

        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"تم رفض الوصول: المستخدم لا يملك الصلاحية المطلوبة ({required_permission}).",
            )

        return current_user

    return dependency


def require_any_role(*allowed_roles: str) -> Callable:
    """
    تبعية FastAPI تفرض أن يكون المستخدم منتمياً لأحد الأدوار المحددة على الأقل.
    """
    normalized_allowed = {r.strip().lower() for r in allowed_roles}

    async def dependency(
        current_user: AuthenticatedUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> AuthenticatedUser:
        user_roles = await get_user_roles(current_user, db=db)
        if not user_roles.intersection(normalized_allowed):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="تم رفض الوصول: يتطلب هذا الإجراء دوراً مصرحاً له.",
            )
        return current_user

    return dependency
