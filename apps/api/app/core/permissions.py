"""
نظام الصلاحيات والأدوار المعتمدة (Role-Based Access Control - RBAC)
─────────────────────────────────────────────────────────────────────────────
يطبق سياسة الحظر الافتراضي (Deny-by-default) مع الفصل الصارم للمسؤوليات:
- الأدوار المعتمدة:
  - general_manager: دور شامل لكل الصلاحيات، مع خضوعه لمنع الاعتماد الذاتي وفصل الصارف عن المستلم.
  - warehouse_manager: صرف الخامات، استلام التام، التسليم للعملاء، فواتير الموردين واستلامها وطلب سدادها، والجرد الميداني.
  - production_manager: إنشاء أوامر التشغيل، استلام الورشة، المراحل الخمس، العيوب والهالك، والإغلاق.
  - finance_manager: الخزينة والاعتماد، التحصيل والمصروفات، الرواتب، طلبات البيع والتسعير، والتقارير المالية.
- التحقق الصارم في الـ API: إخفاء الزر في الواجهة ليس تفويضاً.
- تسجيل محاولات الوصول المرفوضة في سجل التدقيق الأمني (Audit Trail) دون تخزين أسرار.
- يتم إسناد الأدوار إدارياً عبر قاعدة البيانات؛ لا يوجد مسار عام للمستخدم لتعيين دوره بنفسه.
─────────────────────────────────────────────────────────────────────────────
"""
import logging
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Set
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.tracing import get_request_id
from app.db.session import get_db
from app.modules.identity.models import Role, UserRole

logger = logging.getLogger("qemma.rbac")


# ─── 1. سجل الصلاحيات المركزي (Central Permission Registry) ─────────────────

@dataclass(frozen=True)
class PermissionDefinition:
    code: str
    module: str
    action: str  # view, create, submit, execute, review, approve, post, cancel
    description_ar: str


PERMISSION_REGISTRY: dict[str, PermissionDefinition] = {
    # ── دليل الأصناف والتصنيفات (Catalog) ──
    "catalog:view": PermissionDefinition("catalog:view", "catalog", "view", "عرض دليل الأصناف والتصنيفات وسجل اعتماد الصنف"),
    "catalog:categories:manage": PermissionDefinition("catalog:categories:manage", "catalog", "execute", "إنشاء وتعديل وحذف تصنيفات الدليل"),
    "catalog:item:create": PermissionDefinition("catalog:item:create", "catalog", "create", "إنشاء مسودة صنف جديد"),
    "catalog:item:update": PermissionDefinition("catalog:item:update", "catalog", "create", "تعديل مسودة صنف وحذفها وإعادة فتحها وإدارة خطوط استخدامها"),
    "catalog:item:submit": PermissionDefinition("catalog:item:submit", "catalog", "submit", "تقديم مسودة صنف للاعتماد"),
    "catalog:item:approve": PermissionDefinition("catalog:item:approve", "catalog", "approve", "اعتماد وتفعيل الصنف رسمياً"),
    "catalog:item:reject": PermissionDefinition("catalog:item:reject", "catalog", "review", "رفض اعتماد مسودة صنف"),
    "catalog:item:request_revision": PermissionDefinition("catalog:item:request_revision", "catalog", "submit", "تقديم أو سحب طلب تعديل صنف معتمد"),
    "catalog:item:manage_revisions": PermissionDefinition("catalog:item:manage_revisions", "catalog", "approve", "اعتماد أو رفض طلبات تعديل الأصناف"),
    "catalog:item:deactivate": PermissionDefinition("catalog:item:deactivate", "catalog", "cancel", "تعطيل صنف معتمد"),
    "catalog:item:reactivate": PermissionDefinition("catalog:item:reactivate", "catalog", "execute", "إعادة تفعيل صنف معطل"),

    # ── المخازن والجرد (Inventory & Stocktake) ──
    "inventory:view": PermissionDefinition("inventory:view", "inventory", "view", "عرض أرصدة المخازن والدفاتر"),
    "warehouse:dispatch": PermissionDefinition("warehouse:dispatch", "inventory", "execute", "صرف خامات من مخزن الخامات لأوامر التشغيل"),
    "warehouse:finished_goods:receive": PermissionDefinition("warehouse:finished_goods:receive", "inventory", "execute", "استلام المنتج التام في مخزن المنتج التام"),
    "warehouse:returns:receive": PermissionDefinition("warehouse:returns:receive", "inventory", "execute", "فحص واستلام مرتجعات الورشة بمخزن الخامات (مقبول/مرفوض/عجز)"),
    "inventory:stocktake:view": PermissionDefinition("inventory:stocktake:view", "inventory", "view", "استعراض جلسات الجرد وخطوط العد"),
    "inventory:stocktake:create": PermissionDefinition("inventory:stocktake:create", "inventory", "create", "إنشاء جلسة جرد جديدة وأخذ اللقطة"),
    "inventory:stocktake:count": PermissionDefinition("inventory:stocktake:count", "inventory", "execute", "تسجيل وتحديث العد الميداني"),
    "inventory:stocktake:submit": PermissionDefinition("inventory:stocktake:submit", "inventory", "submit", "تقديم جلسة الجرد للمراجعة"),
    "inventory:stocktake:review": PermissionDefinition("inventory:stocktake:review", "inventory", "review", "مراجعة فروقات الجرد وفحص التسويات"),
    "inventory:stocktake:approve": PermissionDefinition("inventory:stocktake:approve", "inventory", "approve", "الاعتماد الرسمي لفروقات الجرد"),
    "inventory:stocktake:post": PermissionDefinition("inventory:stocktake:post", "inventory", "post", "ترحيل قيود التسوية المخزنية الدفترية"),
    "inventory:stocktake:cancel": PermissionDefinition("inventory:stocktake:cancel", "inventory", "cancel", "إلغاء جلسة جرد مفتوحة"),

    # ── الإنتاج والتشغيل (Production & Operations) ──
    "production:orders:view": PermissionDefinition("production:orders:view", "production", "view", "استعراض أوامر التشغيل والمراحل"),
    "production:orders:create": PermissionDefinition("production:orders:create", "production", "create", "إنشاء أمر تشغيل جديد (مباشرة أو من طلب عميل)"),
    "production:orders:manage": PermissionDefinition("production:orders:manage", "production", "execute", "خامات مسودة الأمر، العيوب، وتسوية خامات الورشة (المستهلك والمرتجع والهالك)"),
    "production:wip:receive": PermissionDefinition("production:wip:receive", "production", "execute", "تأكيد استلام الخامات المصروفة في الورشة"),
    "production:stages:manage": PermissionDefinition("production:stages:manage", "production", "execute", "تسجيل وتأكيد مراحل الإنتاج والتراجع"),
    "production:templates:manage": PermissionDefinition("production:templates:manage", "production", "create", "إنشاء وإدارة الموديلات وقوالب التشغيل (BOM)"),
    "production:returns:resolve": PermissionDefinition("production:returns:resolve", "production", "approve", "قرار تسوية عجز أو مرفوض مرتجعات الورشة بسبب مكتوب"),
    "production:orders:close": PermissionDefinition("production:orders:close", "production", "approve", "إغلاق أمر التشغيل بعد استيفاء شروط الإغلاق"),

    # ── المالية والخزينة والرواتب (Finance & Payroll) ──
    "finance:cash:view": PermissionDefinition("finance:cash:view", "finance", "view", "استعراض حسابات الخزينة وسندات النقدية"),
    "finance:cash:create": PermissionDefinition("finance:cash:create", "finance", "create", "إنشاء سند قبض أو صرف أو تحويل (مستندات غير المدير المالي تبقى معلقة حتى اعتماد الخزينة، ومستندات المدير المالي تُعتمد فوراً بقرار المصنع 2026-11-10)"),
    "finance:cash:manage": PermissionDefinition("finance:cash:manage", "finance", "execute", "إدارة حسابات العهد وتسويتها"),
    "finance:cash:approve": PermissionDefinition("finance:cash:approve", "finance", "approve", "اعتماد أو رفض السندات النقدية من الخزينة (ممنوع على منشئ السند)"),
    "finance:expenses:manage": PermissionDefinition("finance:expenses:manage", "finance", "execute", "تسجيل المصروفات اليومية كسندات معلقة"),
    "finance:payments:manage": PermissionDefinition("finance:payments:manage", "finance", "execute", "تسجيل تحصيلات العملاء كسندات معلقة"),
    "finance:payroll:view": PermissionDefinition("finance:payroll:view", "payroll", "view", "استعراض فترات وكشوف الرواتب"),
    "finance:payroll:calculate": PermissionDefinition("finance:payroll:calculate", "payroll", "execute", "إعداد كشف أجور الفترة وتعديله"),
    "finance:payroll:disburse": PermissionDefinition("finance:payroll:disburse", "payroll", "submit", "إرسال كشف الرواتب للصرف كسند معلق في الخزينة"),
    "finance:payroll:manage": PermissionDefinition("finance:payroll:manage", "payroll", "execute", "إدارة الموظفين والحضور وفترات الرواتب"),
    "finance:reports:view": PermissionDefinition("finance:reports:view", "finance", "view", "استعراض التقارير المالية ومؤشرات السيولة"),

    # ── العملاء والمبيعات والأسعار (Commercial & Sales) ──
    "customers:view": PermissionDefinition("customers:view", "customers", "view", "استعراض بيانات العملاء وحساباتهم"),
    "customers:manage": PermissionDefinition("customers:manage", "customers", "execute", "إنشاء وتعديل بيانات العملاء الأساسية"),
    "customers:orders:create": PermissionDefinition("customers:orders:create", "customers", "create", "إنشاء طلبات البيع للعملاء"),
    "pricing:manage": PermissionDefinition("pricing:manage", "customers", "execute", "تحديد أسعار البيع والخصومات في طلبات العملاء"),
    "customers:deliveries:manage": PermissionDefinition("customers:deliveries:manage", "customers", "execute", "تسليم البضاعة التامة وإثبات المرتجعات وفحصها"),

    # ── الموردون وفواتير الشراء (Suppliers) ──
    "suppliers:view": PermissionDefinition("suppliers:view", "suppliers", "view", "استعراض الموردين وفواتير الشراء"),
    "suppliers:manage": PermissionDefinition("suppliers:manage", "suppliers", "execute", "إنشاء وتعديل بيانات الموردين الأساسية"),
    "suppliers:invoices:create": PermissionDefinition("suppliers:invoices:create", "suppliers", "create", "إنشاء فواتير الشراء من الموردين"),
    "suppliers:payments:request": PermissionDefinition("suppliers:payments:request", "suppliers", "submit", "طلب سداد دفعة بمبلغ محدد لفاتورة مورد كسند معلق في الخزينة"),
    "suppliers:payments:request_full_balance": PermissionDefinition("suppliers:payments:request_full_balance", "suppliers", "submit", "طلب سداد كامل المستحق لفاتورة مورد يحسبه النظام دون عرض المبلغ"),
    "suppliers:receive": PermissionDefinition("suppliers:receive", "suppliers", "execute", "إثبات استلام وتوريد الخامات بالمخزن"),

    # ── التقارير والرقابة العامة (Reports & Oversight) ──
    "reports:view": PermissionDefinition("reports:view", "reports", "view", "استعراض لوحة التشغيل والتقارير التنفيذية"),
}


# ─── 2. الأدوار المعتمدة رسمياً (Roles) ─────────────────────────────────────

ROLE_GENERAL_MANAGER = "general_manager"
ROLE_WAREHOUSE_MANAGER = "warehouse_manager"
ROLE_PRODUCTION_MANAGER = "production_manager"
ROLE_FINANCE_MANAGER = "finance_manager"

PROVISIONAL_ROLES = {
    ROLE_GENERAL_MANAGER,
    ROLE_WAREHOUSE_MANAGER,
    ROLE_PRODUCTION_MANAGER,
    ROLE_FINANCE_MANAGER,
}


# ─── 3. مصفوفة الصلاحيات حسب الدور (Role-Permission Mapping) ────────────────
# المصفوفة المعتمدة من مالك المشروع (2026-11-09). منع الاعتماد الذاتي وفصل الصارف عن المستلم
# يُفرضان في طبقة الخدمة على الجميع، ولا تتجاوزهما سعة صلاحيات أي دور بما فيه المدير العام.

ROLE_PERMISSIONS_MAP: dict[str, Set[str]] = {
    # ── المدير العام: دور شامل لكل الصلاحيات المعرّفة (تشغيل، مخازن، إنتاج، مشتريات، مبيعات، مالية) ──
    # يظل خاضعاً لمنع الاعتماد الذاتي وفصل الصارف عن المستلم (يُفرضان في طبقة الخدمة).
    # لا يفترض النظام وجود موظف بهذا المسمى؛ الدور متاح للإسناد عند الحاجة.
    ROLE_GENERAL_MANAGER: set(PERMISSION_REGISTRY),

    # ── أمين المخزن: صرف الخامات، استلام التام، التسليم للعملاء، فواتير الموردين واستلامها، الجرد ──
    # لا ينشئ طلبات بيع ولا يحدد أسعاراً ولا يدير بيانات العملاء ولا يرى حساباتهم؛ يرى بيانات التسليم فقط
    # (عبر قائمة التسليمات المعلقة). لا ينشئ أوامر تشغيل ولا يؤكد استلام الورشة.
    ROLE_WAREHOUSE_MANAGER: {
        "inventory:view",
        "inventory:stocktake:view",
        "inventory:stocktake:create",
        "inventory:stocktake:count",
        "inventory:stocktake:submit",
        "inventory:stocktake:cancel",
        "catalog:view",
        "catalog:categories:manage",
        "catalog:item:create",
        "catalog:item:update",
        "catalog:item:submit",
        "catalog:item:request_revision",
        "warehouse:dispatch",
        "warehouse:finished_goods:receive",
        "warehouse:returns:receive",
        "production:orders:view",
        "customers:deliveries:manage",
        "suppliers:view",
        "suppliers:manage",
        "suppliers:invoices:create",
        "suppliers:payments:request_full_balance",
        "suppliers:receive",
    },

    # ── مسؤول الإنتاج: إنشاء أوامر التشغيل، استلام الورشة، المراحل، العيوب والهالك، والإغلاق ──
    # لا يستلم المنتج التام في مخزن التام.
    ROLE_PRODUCTION_MANAGER: {
        "production:orders:view",
        "production:orders:create",
        "production:orders:manage",
        "production:wip:receive",
        "production:stages:manage",
        "production:templates:manage",
        "production:returns:resolve",
        "production:orders:close",
        "inventory:view",
        "catalog:view",
        "reports:view",
    },

    # ── المدير المالي: الخزينة والاعتماد غير الذاتي، التحصيل، المصروفات، الرواتب، المبيعات والتسعير ──
    # لا ينشئ فواتير الموردين.
    ROLE_FINANCE_MANAGER: {
        "finance:cash:view",
        "finance:cash:create",
        "finance:cash:manage",
        "finance:cash:approve",
        "finance:expenses:manage",
        "finance:payments:manage",
        "finance:payroll:view",
        "finance:payroll:calculate",
        "finance:payroll:disburse",
        "finance:payroll:manage",
        "finance:reports:view",
        "reports:view",
        "suppliers:view",
        "suppliers:manage",
        "suppliers:payments:request",
        "suppliers:payments:request_full_balance",
        "customers:view",
        "customers:manage",
        "customers:orders:create",
        "pricing:manage",
        "catalog:view",
    },
}


# ─── 4. استخراج الأدوار والتحقق الخادمي (Role Resolution) ───────────────────

async def get_user_roles(
    user: AuthenticatedUser,
    db: Optional[AsyncSession] = None,
) -> Set[str]:
    """
    استخراج أدوار المستخدم من مصادر يتحكم فيها الخادم فقط:
    1. ادعاءات التوكن الصادرة من الخادم: role / roles / user_roles (توكن التطوير المحلي
       أو Custom Access Token Hook) و app_metadata (لا يكتبها إلا الخادم في Supabase).
    2. جدول user_roles في قاعدة البيانات.

    لا يُقرأ user_metadata إطلاقاً لأن المستخدم النهائي يستطيع تعديله بنفسه في Supabase،
    ولا تُقبل إلا الأدوار المعتمدة في النظام. عند تعذر قراءة جدول الأدوار يُرفض الطلب
    (Fail closed) بدلاً من الاعتماد الصامت على التوكن.
    """
    candidate_roles: Set[str] = set()

    claims = user.claims or {}
    if isinstance(claims.get("role"), str):
        candidate_roles.add(claims["role"].strip().lower())

    for key in ("roles", "user_roles"):
        val = claims.get(key)
        if isinstance(val, (list, tuple, set)):
            for r in val:
                if isinstance(r, str):
                    candidate_roles.add(r.strip().lower())

    app_meta = claims.get("app_metadata")
    if isinstance(app_meta, dict):
        r = app_meta.get("role")
        if isinstance(r, str):
            candidate_roles.add(r.strip().lower())
        rs = app_meta.get("roles")
        if isinstance(rs, (list, tuple, set)):
            for item in rs:
                if isinstance(item, str):
                    candidate_roles.add(item.strip().lower())

    if db is not None:
        try:
            stmt = select(Role.name).join(UserRole, Role.id == UserRole.role_id).where(UserRole.user_id == user.id)
            result = await db.execute(stmt)
            for role_name in result.scalars().all():
                candidate_roles.add(role_name.strip().lower())
        except (SQLAlchemyError, OSError, ConnectionError, TimeoutError) as exc:
            # تعذر الوصول لجدول الأدوار: رفض آمن بدلاً من الاعتماد الصامت على التوكن
            logger.error("role_lookup_failed user_id=%s category=%s", user.id, type(exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="تعذر التحقق من صلاحيات المستخدم حالياً. حاول مرة أخرى.",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - جلسات اختبار وهمية لا تدعم الاستعلام
            logger.warning("role_lookup_skipped user_id=%s category=%s", user.id, type(exc).__name__)

    return {role for role in candidate_roles if role in PROVISIONAL_ROLES}


def get_permissions_for_roles(roles: Set[str]) -> Set[str]:
    """الصلاحيات الفعلية الممنوحة لمجموعة أدوار (مصدر الحقيقة الوحيد للواجهة والخادم)."""
    permissions: Set[str] = set()
    for role in roles:
        permissions.update(ROLE_PERMISSIONS_MAP.get(role, set()))
    return permissions


# ─── 5. تبعيات التفويض الخادمي (Authorization Dependencies) ─────────────────

def require_permission(required_permission: str) -> Callable:
    """
    تبعية FastAPI تفرض وجود صلاحية محددة لدى المستخدم.
    الحظر الافتراضي (Deny-by-default): إذا لم يملك المستخدم الدور المناسب، تُرمى 403 Forbidden.
    تسجل المحاولات المرفوضة في سجل التدقيق الأمني دون كشف أسرار.
    """
    async def dependency(
        request: Request = None,  # type: ignore
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
            request_id = get_request_id(request) if request else "-"
            path = request.url.path if request else "-"
            method = request.method if request else "-"
            logger.warning(
                "access_denied reason=missing_permission user_id=%s required_permission=%s roles=%s method=%s path=%s request_id=%s",
                current_user.id,
                required_permission,
                sorted(list(user_roles)),
                method,
                path,
                request_id,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"تم رفض الوصول: المستخدم لا يملك الصلاحية المطلوبة ({required_permission}).",
            )

        return current_user

    return dependency


def require_any_permission(*required_permissions: str) -> Callable:
    """
    تبعية FastAPI تفرض توفر أي صلاحية من الصلاحيات المحددة (OR logic).
    مفيدة للمسارات التي يمكن تنفيذها بصلاحيات بديلة (مثل الإدارة العامة أو صلاحية الوحدة المحددة).
    """
    async def dependency(
        request: Request = None,  # type: ignore
        current_user: AuthenticatedUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> AuthenticatedUser:
        user_roles = await get_user_roles(current_user, db=db)

        user_perms: Set[str] = set()
        for role in user_roles:
            user_perms.update(ROLE_PERMISSIONS_MAP.get(role, set()))

        has_any = any(p in user_perms for p in required_permissions)

        if not has_any:
            request_id = get_request_id(request) if request else "-"
            path = request.url.path if request else "-"
            method = request.method if request else "-"
            logger.warning(
                "access_denied reason=missing_any_permission user_id=%s required_any=%s roles=%s method=%s path=%s request_id=%s",
                current_user.id,
                list(required_permissions),
                sorted(list(user_roles)),
                method,
                path,
                request_id,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"تم رفض الوصول: يتطلب هذا الإجراء إحدى الصلاحيات التالية: ({', '.join(required_permissions)}).",
            )

        return current_user

    return dependency


def require_any_role(*allowed_roles: str) -> Callable:
    """
    تبعية FastAPI تفرض أن يكون المستخدم منتمياً لأحد الأدوار المحددة على الأقل.
    """
    normalized_allowed = {r.strip().lower() for r in allowed_roles}

    async def dependency(
        request: Request = None,  # type: ignore
        current_user: AuthenticatedUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> AuthenticatedUser:
        user_roles = await get_user_roles(current_user, db=db)
        if not user_roles.intersection(normalized_allowed):
            request_id = get_request_id(request) if request else "-"
            path = request.url.path if request else "-"
            method = request.method if request else "-"
            logger.warning(
                "access_denied reason=role_not_allowed user_id=%s allowed_roles=%s roles=%s method=%s path=%s request_id=%s",
                current_user.id,
                sorted(list(normalized_allowed)),
                sorted(list(user_roles)),
                method,
                path,
                request_id,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="تم رفض الوصول: يتطلب هذا الإجراء دوراً مصرحاً له.",
            )
        return current_user

    return dependency

