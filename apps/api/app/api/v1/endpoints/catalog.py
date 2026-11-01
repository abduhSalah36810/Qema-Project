"""
واجهات Backend APIs لإدارة دليل الأصناف والتصنيفات وخطوط الاستخدام (Catalog Management APIs)
─────────────────────────────────────────────────────────────────────────────
تغطي Phase 3.2:
1. إدارة شجرة تصنيفات المواد (Item Categories CRUD, Tree, Cycle Prevention, Active Checks).
2. إدارة دليل الأصناف والمواد (Catalog Items CRUD, Filtering, Pagination, Attributes, Reorder Level).
3. حماية هويات أصناف المنتجات التامة (FG-VAR-* Finished Goods Protection).
4. إدارة خطوط الاستخدام ووسوم الأصناف (Application Lines & Informational Usages).
5. استعراض وحدات القياس المتاحة (Units Read-Only).
─────────────────────────────────────────────────────────────────────────────
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import get_user_roles, require_permission
from app.db.session import get_db
from app.modules.customers.models import CustomerDeliveryLine, CustomerOrderLine
from app.modules.finance.models import SupplierInvoiceLine
from app.modules.production.models import (
    ApplicationLine,
    CatalogApprovalHistory,
    CatalogItem,
    CatalogItemRevision,
    CatalogItemUsage,
    ItemCategory,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionTemplateLine,
    StockLedgerEntry,
    Unit,
)
from app.modules.production.schemas import (
    ApplicationLineRead,
    CatalogApprovalHistoryRead,
    CatalogItemCreate,
    CatalogItemDetailRead,
    CatalogItemRead,
    CatalogItemRejectRequest,
    CatalogItemRevisionCreate,
    CatalogItemRevisionRead,
    CatalogItemRevisionRejectRequest,
    CatalogItemUpdate,
    CatalogItemUsageCreate,
    ItemCategoryCreate,
    ItemCategoryRead,
    ItemCategoryTreeRead,
    ItemCategoryUpdate,
    UnitRead,
)

router = APIRouter(prefix="/catalog", tags=["catalog"])

# ─── الاعتماديات وتفويض الصلاحيات (RBAC Dependencies) ────────────────────────
Database = Annotated[AsyncSession, Depends(get_db)]
CatalogViewer = Annotated[AuthenticatedUser, Depends(require_permission("inventory:view"))]
CatalogManager = Annotated[AuthenticatedUser, Depends(require_permission("inventory:manage"))]
CatalogApprover = Annotated[AuthenticatedUser, Depends(require_permission("catalog:item:approve"))]
CatalogRevisionManager = Annotated[AuthenticatedUser, Depends(require_permission("catalog:item:manage_revisions"))]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def make_item_snapshot(item: CatalogItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "code": item.code,
        "name_ar": item.name_ar,
        "item_type": item.item_type,
        "unit_id": item.unit_id,
        "category_id": item.category_id,
        "classification_status": item.classification_status,
        "attributes": item.attributes or {},
        "reorder_level": float(item.reorder_level) if item.reorder_level is not None else 0.0,
        "is_consumable": item.is_consumable,
        "is_active": item.is_active,
        "approval_status": item.approval_status,
    }


def calculate_item_fingerprint(item: CatalogItem) -> str:
    snap = make_item_snapshot(item)
    core_content = {
        "name_ar": snap["name_ar"],
        "category_id": snap["category_id"],
        "classification_status": snap["classification_status"],
        "attributes": snap["attributes"],
        "reorder_level": snap["reorder_level"],
        "is_consumable": snap["is_consumable"],
    }
    serialized = json.dumps(core_content, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def serialize_catalog_item(item: CatalogItem, has_pending_revision: bool = False) -> CatalogItemRead:
    return CatalogItemRead(
        id=item.id,
        code=item.code,
        name_ar=item.name_ar,
        item_type=item.item_type,
        unit_id=item.unit_id,
        unit_name_ar=item.unit.name_ar if item.unit else None,
        is_consumable=item.is_consumable,
        is_active=item.is_active,
        category_id=item.category_id,
        classification_status=item.classification_status,
        attributes=item.attributes or {},
        reorder_level=float(item.reorder_level) if item.reorder_level is not None else 0.0,
        approval_status=item.approval_status,
        rejection_reason=item.rejection_reason,
        submitted_at=item.submitted_at,
        submitted_by=item.submitted_by,
        approved_at=item.approved_at,
        approved_by=item.approved_by,
        has_pending_revision=has_pending_revision,
    )

# الفئات المعيارية المبذورة في Migration 0011 (يحظر حذفها الفعلي)
SEEDED_CATEGORY_CODES = {
    "FABRICS_MAIN", "GARMENT_COMPONENTS", "SEWING_SUPPLIES", "INTERLINING_REINFORCEMENT",
    "TRIMS_FASTENERS", "CUTTING_SUPPLIES", "FINISHING_PRESSING", "PACKAGING_MATERIALS",
    "TOOLS_CONSUMABLES", "MACHINERY_MAINTENANCE",
    "FAB_MAIN", "FAB_CONTRAST", "FAB_LINING", "CMP_CUFFS", "CMP_COLLARS_MANDARIN",
    "CMP_COLLARS_FULL", "CMP_POCKETS", "CMP_PLACKETS", "SEW_THREAD_SEWING",
    "SEW_THREAD_OVERLOCK", "SEW_THREAD_EMBROIDERY", "INT_ROLLS", "INT_PRECUT",
    "INT_STIFFENERS", "TRM_BUTTONS", "TRM_SNAPS", "TRM_HOOKS", "TRM_ZIPPERS",
    "TRM_CORDS_RIBBONS", "CUT_NUMBERING", "CUT_PAPER", "CUT_MARKING",
    "FIN_IRONING_COVERS", "FIN_CHEMICALS", "PKG_BAGS", "PKG_BOXES", "PKG_CARTONS",
    "PKG_COLLAR_SUPPORTS", "PKG_LABELS_TAGS", "PKG_TAPES_TIES", "TOL_CUTTING",
    "TOL_MEASURING", "TOL_HAND_TOOLS", "MNT_NEEDLES", "MNT_HOOKS_LOOPERS",
    "MNT_KNIVES_BLADES", "MNT_FEET_PLATES", "MNT_LUBRICANTS", "MNT_PARTS_ELECTRICAL",
}


# ═════════════════════════════════════════════════════════════════════════════
# 1. إدارة شجرة تصنيفات المواد (Item Categories)
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/categories", response_model=List[ItemCategoryRead])
async def list_categories(
    current_user: CatalogViewer,
    db: Database,
    is_active: Optional[bool] = Query(default=None, description="تصفية حسب حالة التفعيل"),
    parent_id: Optional[str] = Query(default=None, description="تصفية حسب معرف التصنيف الأب ('root' للتصنيفات الرئيسية)"),
    search: Optional[str] = Query(default=None, max_length=128, description="البحث بالاسم أو الكود"),
):
    """عرض قائمة مسطحة بتصنيفات الأصناف مع إمكانية التصفية والبحث."""
    del current_user
    stmt = select(ItemCategory).order_by(ItemCategory.sort_order, ItemCategory.code)

    if is_active is not None:
        stmt = stmt.where(ItemCategory.is_active == is_active)

    if parent_id is not None:
        if parent_id.lower() == "root":
            stmt = stmt.where(ItemCategory.parent_id.is_(None))
        else:
            stmt = stmt.where(ItemCategory.parent_id == parent_id)

    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(or_(ItemCategory.name_ar.ilike(term), ItemCategory.code.ilike(term)))

    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/categories/tree", response_model=List[ItemCategoryTreeRead])
async def get_categories_tree(
    current_user: CatalogViewer,
    db: Database,
    is_active: Optional[bool] = Query(default=None, description="تصفية التصنيفات النشطة فقط"),
):
    """عرض التصنيفات كهيكل شجري متداخل (Hierarchical Tree)."""
    del current_user
    stmt = select(ItemCategory).order_by(ItemCategory.sort_order, ItemCategory.code)
    if is_active is not None:
        stmt = stmt.where(ItemCategory.is_active == is_active)

    all_categories = (await db.scalars(stmt)).all()

    # بناء الشجرة في الذاكرة
    categories_by_parent: dict[Optional[str], list[ItemCategory]] = {}
    for cat in all_categories:
        categories_by_parent.setdefault(cat.parent_id, []).append(cat)

    def _build_subtree(parent_key: Optional[str]) -> list[ItemCategoryTreeRead]:
        nodes = []
        for cat in categories_by_parent.get(parent_key, []):
            node = ItemCategoryTreeRead(
                id=cat.id,
                code=cat.code,
                name_ar=cat.name_ar,
                name_en=cat.name_en,
                parent_id=cat.parent_id,
                description=cat.description,
                is_active=cat.is_active,
                sort_order=cat.sort_order,
                subcategories=_build_subtree(cat.id),
            )
            nodes.append(node)
        return nodes

    return _build_subtree(None)


@router.get("/categories/{category_id}", response_model=ItemCategoryRead)
async def get_category(category_id: str, current_user: CatalogViewer, db: Database):
    """عرض تفاصيل تصنيف محدد بالمعرف أو الكود."""
    del current_user
    stmt = select(ItemCategory).where(or_(ItemCategory.id == category_id, ItemCategory.code == category_id))
    category = (await db.scalars(stmt)).first()
    if not category:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="التصنيف المطلوب غير موجود في النظام.",
        )
    return category


@router.post("/categories", response_model=ItemCategoryRead, status_code=status.HTTP_201_CREATED)
async def create_category(data: ItemCategoryCreate, current_user: CatalogManager, db: Database):
    """إنشاء تصنيف رئيسي أو فرعي جديد."""
    del current_user

    # 1. التحقق من عدم تكرار الكود
    code_trimmed = data.code.strip().upper()
    existing_code = (await db.scalars(select(ItemCategory).where(ItemCategory.code == code_trimmed))).first()
    if existing_code:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"كود التصنيف '{code_trimmed}' مسجل مسبقاً في النظام.",
        )

    # 2. التحقق من وجود التصنيف الأب وحالته إذا حُدد
    parent = None
    if data.parent_id:
        parent = await db.get(ItemCategory, data.parent_id)
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="التصنيف الأب المحدد غير موجود.",
            )
        if not parent.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="لا يمكن إنشاء تصنيف فرعي تحت تصنيف معطل.",
            )

    new_cat = ItemCategory(
        id=str(uuid.uuid4()),
        code=code_trimmed,
        name_ar=data.name_ar.strip(),
        name_en=data.name_en.strip() if data.name_en else None,
        parent_id=data.parent_id,
        description=data.description.strip(),
        is_active=data.is_active,
        sort_order=data.sort_order,
    )
    db.add(new_cat)
    await db.commit()
    await db.refresh(new_cat)
    return new_cat


@router.patch("/categories/{category_id}", response_model=ItemCategoryRead)
async def update_category(category_id: str, data: ItemCategoryUpdate, current_user: CatalogManager, db: Database):
    """تعديل بيانات تصنيف (الاسم، الوصف، الأب، الترتيب، حالة التفعيل)."""
    del current_user
    category = await db.get(ItemCategory, category_id)
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="التصنيف المطلوب غير موجود.")

    # 1. التحقق من تعديل التصنيف الأب ومنع الحلقات
    if data.parent_id is not None and data.parent_id != category.parent_id:
        if data.parent_id == category.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="لا يمكن جعل التصنيف أباً لنفسه.",
            )
        parent = await db.get(ItemCategory, data.parent_id)
        if not parent:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="التصنيف الأب المحدد غير موجود.")
        if not parent.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="لا يمكن نقل التصنيف تحت تصنيف معطل.")

        # التحقق العودي من عدم حدوث حلقة تكرارية في شجرة الأجداد
        curr = parent.parent_id
        while curr:
            if curr == category.id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="لا يمكن نقل التصنيف لأحد فروعه التابعة لتجنب حدوث دورة تكرارية في الشجرة.",
                )
            ancestor = await db.get(ItemCategory, curr)
            curr = ancestor.parent_id if ancestor else None

        category.parent_id = data.parent_id

    # 2. التحقق عند التعطيل (is_active = False)
    if data.is_active is False and category.is_active is True:
        # فحص وجود أصناف نشطة مرتبطة
        active_items_count = (await db.scalars(
            select(func.count(CatalogItem.id)).where(CatalogItem.category_id == category.id, CatalogItem.is_active.is_(True))
        )).one()
        if active_items_count > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"لا يمكن تعطيل التصنيف لوجود {active_items_count} صنف نشط مرتبط به. يجب تعطيل الأصناف أو نقلها أولاً.",
            )

        # فحص وجود فروع نشطة
        active_children_count = (await db.scalars(
            select(func.count(ItemCategory.id)).where(ItemCategory.parent_id == category.id, ItemCategory.is_active.is_(True))
        )).one()
        if active_children_count > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"لا يمكن تعطيل التصنيف لوجود {active_children_count} تصنيف فرعي نشط تابع له. يجب تعطيل الفروع أولاً.",
            )

    if data.name_ar is not None:
        category.name_ar = data.name_ar.strip()
    if data.name_en is not None:
        category.name_en = data.name_en.strip() if data.name_en else None
    if data.description is not None:
        category.description = data.description.strip()
    if data.is_active is not None:
        category.is_active = data.is_active
    if data.sort_order is not None:
        category.sort_order = data.sort_order

    await db.commit()
    await db.refresh(category)
    return category


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(category_id: str, current_user: CatalogManager, db: Database):
    """حذف تصنيف مخصص فقط إذا كان غير مرتبط بأي أصناف أو فروع وغير مستخدم تاريخياً."""
    del current_user
    category = await db.get(ItemCategory, category_id)
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="التصنيف المطلوب غير موجود.")

    # حظر حذف الفئات المعيارية المعتمدة
    if category.code in SEEDED_CATEGORY_CODES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف التصنيفات المعيارية الأساسية للنظام؛ يرجى استخدام خيار التعطيل بدلاً من الحذف.",
        )

    # فحص ارتباط التصنيف بأي أصناف
    items_count = (await db.scalars(select(func.count(CatalogItem.id)).where(CatalogItem.category_id == category.id))).one()
    if items_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف التصنيف لارتباطه بأصناف مسجلة في الدليل؛ يرجى استخدام التعطيل لحفظ السجل التاريخي.",
        )

    # فحص وجود فئات فرعية تابعة
    children_count = (await db.scalars(select(func.count(ItemCategory.id)).where(ItemCategory.parent_id == category.id))).one()
    if children_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف التصنيف لوجود تصنيفات فرعية تابعة له. يرجى نقل أو حذف الفروع أولاً.",
        )

    await db.delete(category)
    await db.commit()
    return None


# ═════════════════════════════════════════════════════════════════════════════
# 2. إدارة دليل الأصناف والمواد (Catalog Items)
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/items", response_model=List[CatalogItemRead])
async def list_catalog_items(
    current_user: CatalogViewer,
    db: Database,
    search: Optional[str] = Query(default=None, max_length=128, description="البحث بكود الصنف أو اسمه بالعربية"),
    item_type: Optional[str] = Query(default=None, max_length=64, description="تصفية حسب نوع الصنف"),
    category_id: Optional[str] = Query(default=None, description="تصفية حسب معرف التصنيف"),
    unit_id: Optional[str] = Query(default=None, description="تصفية حسب وحدة القياس"),
    classification_status: Optional[str] = Query(default=None, pattern="^(confirmed|suggested|needs_review|not_applicable)$"),
    approval_status: Optional[str] = Query(default=None, pattern="^(draft|pending_review|approved|rejected)$", description="تصفية الأصناف حسب حالة دورة الاعتماد"),
    is_active: Optional[bool] = Query(default=None, description="تصفية الأصناف النشطة أو المعطلة"),
    application_line_id: Optional[str] = Query(default=None, description="تصفية الأصناف حسب خط التطبيق"),
    limit: int = Query(default=50, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
    sort_by: str = Query(default="code", pattern="^(code|name_ar|created_at|reorder_level)$"),
    sort_dir: str = Query(default="asc", pattern="^(asc|desc)$"),
):
    """عرض قائمة الأصناف مع الفلترة والبحث والترتيب ودورة الاعتماد والـ Pagination."""
    del current_user
    stmt = (
        select(CatalogItem)
        .options(selectinload(CatalogItem.unit), selectinload(CatalogItem.category))
    )

    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(or_(CatalogItem.name_ar.ilike(term), CatalogItem.code.ilike(term)))

    if item_type:
        stmt = stmt.where(CatalogItem.item_type == item_type)

    if category_id:
        stmt = stmt.where(CatalogItem.category_id == category_id)

    if unit_id:
        stmt = stmt.where(CatalogItem.unit_id == unit_id)

    if classification_status:
        stmt = stmt.where(CatalogItem.classification_status == classification_status)

    if approval_status:
        stmt = stmt.where(CatalogItem.approval_status == approval_status)

    if is_active is not None:
        stmt = stmt.where(CatalogItem.is_active == is_active)

    if application_line_id:
        stmt = stmt.join(CatalogItemUsage, CatalogItem.id == CatalogItemUsage.item_id).where(
            CatalogItemUsage.application_id == application_line_id
        )

    # الترتيب
    sort_col = getattr(CatalogItem, sort_by)
    stmt = stmt.order_by(sort_col.desc() if sort_dir == "desc" else sort_col.asc())
    stmt = stmt.limit(limit).offset(offset)

    items = (await db.scalars(stmt)).all()

    # فحص طلبات التعديل المفتوحة للأصناف المعروضة دفعة واحدة
    item_ids = [it.id for it in items]
    open_rev_item_ids: set[str] = set()
    if item_ids:
        rev_stmt = select(CatalogItemRevision.item_id).where(
            CatalogItemRevision.item_id.in_(item_ids),
            CatalogItemRevision.status == "pending_review",
        )
        open_rev_item_ids = set((await db.scalars(rev_stmt)).all())

    return [serialize_catalog_item(it, has_pending_revision=(it.id in open_rev_item_ids)) for it in items]


@router.get("/items/{item_id}", response_model=CatalogItemDetailRead)
async def get_catalog_item(item_id: str, current_user: CatalogViewer, db: Database):
    """عرض تفاصيل صنف محدد مع فئته ووحدته ووسوم التطبيقات والمراجعة المفتوحة إن وجدت."""
    del current_user
    stmt = (
        select(CatalogItem)
        .options(
            selectinload(CatalogItem.unit),
            selectinload(CatalogItem.category),
            selectinload(CatalogItem.usages).selectinload(CatalogItemUsage.application),
        )
        .where(or_(CatalogItem.id == item_id, CatalogItem.code == item_id))
    )
    item = (await db.scalars(stmt)).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود في الدليل.")

    # جلب أي طلب تعديل مفتوح لهذا الصنف
    pending_rev = (
        await db.scalars(
            select(CatalogItemRevision).where(
                CatalogItemRevision.item_id == item.id,
                CatalogItemRevision.status == "pending_review",
            )
        )
    ).first()

    pending_rev_read = None
    if pending_rev:
        pending_rev_read = CatalogItemRevisionRead(
            id=pending_rev.id,
            item_id=pending_rev.item_id,
            revision_number=pending_rev.revision_number,
            status=pending_rev.status,
            proposed_changes=pending_rev.proposed_changes or {},
            change_summary=pending_rev.change_summary,
            base_fingerprint=pending_rev.base_fingerprint,
            submitted_by=pending_rev.submitted_by,
            submitted_at=pending_rev.submitted_at,
            reviewed_by=pending_rev.reviewed_by,
            reviewed_at=pending_rev.reviewed_at,
            rejection_reason=pending_rev.rejection_reason,
            created_at=pending_rev.created_at,
        )

    usages_list = [
        ApplicationLineRead(
            id=u.application.id,
            code=u.application.code,
            name_ar=u.application.name_ar,
            name_en=u.application.name_en,
            description=u.application.description,
            is_active=u.application.is_active,
            sort_order=u.application.sort_order,
        )
        for u in item.usages
        if u.application
    ]

    return CatalogItemDetailRead(
        id=item.id,
        code=item.code,
        name_ar=item.name_ar,
        item_type=item.item_type,
        unit_id=item.unit_id,
        unit_name_ar=item.unit.name_ar if item.unit else None,
        is_consumable=item.is_consumable,
        is_active=item.is_active,
        category_id=item.category_id,
        classification_status=item.classification_status,
        attributes=item.attributes or {},
        reorder_level=float(item.reorder_level) if item.reorder_level is not None else 0.0,
        approval_status=item.approval_status,
        rejection_reason=item.rejection_reason,
        submitted_at=item.submitted_at,
        submitted_by=item.submitted_by,
        approved_at=item.approved_at,
        approved_by=item.approved_by,
        has_pending_revision=pending_rev is not None,
        category=ItemCategoryRead(
            id=item.category.id,
            code=item.category.code,
            name_ar=item.category.name_ar,
            name_en=item.category.name_en,
            parent_id=item.category.parent_id,
            description=item.category.description,
            is_active=item.category.is_active,
            sort_order=item.category.sort_order,
        ) if item.category else None,
        unit=UnitRead(
            id=item.unit.id,
            code=item.unit.code,
            name_ar=item.unit.name_ar,
        ) if item.unit else None,
        usages=usages_list,
        pending_revision=pending_rev_read,
    )


@router.post("/items", response_model=CatalogItemRead, status_code=status.HTTP_201_CREATED)
async def create_catalog_item(data: CatalogItemCreate, current_user: CatalogManager, db: Database):
    """إنشاء صنف جديد في دليل الخامات والمستلزمات كمسودة (draft)."""
    code_trimmed = data.code.strip()

    # 1. حماية دورة المنتجات التامة المعتمدة في Phase 2
    if code_trimmed.startswith("FG-VAR-") or data.item_type == "finished_garment":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="أصناف المنتجات التامة (FG-VAR-*) تنشأ حصرياً وبشكل تلقائي عبر دورة استلام الإنتاج التام.",
        )

    # 2. التحقق من عدم تكرار الكود
    existing_code = (await db.scalars(select(CatalogItem).where(CatalogItem.code == code_trimmed))).first()
    if existing_code:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"كود الصنف '{code_trimmed}' مسجل مسبقاً في الدليل.",
        )

    # 3. التحقق من وجود وحدة القياس
    unit = await db.get(Unit, data.unit_id)
    if not unit:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="وحدة القياس المحددة غير موجودة في النظام.",
        )

    # 4. التحقق من التصنيف وحالته إن حُدد
    category = None
    if data.category_id:
        category = await db.get(ItemCategory, data.category_id)
        if not category:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="التصنيف المحدد غير موجود.")
        if not category.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="لا يمكن تعيين الصنف تحت تصنيف معطل.")

    # 5. إنشاء الصنف كمسودة
    new_item = CatalogItem(
        id=str(uuid.uuid4()),
        code=code_trimmed,
        name_ar=data.name_ar.strip(),
        item_type=data.item_type.strip(),
        unit_id=data.unit_id,
        category_id=data.category_id,
        classification_status=data.classification_status,
        attributes=data.attributes or {},
        reorder_level=Decimal(str(data.reorder_level)),
        is_consumable=data.is_consumable,
        is_active=False,  # مسودة الصنف تكون دائماً غير مفعلة بموجب قيد قاعدة البيانات
        approval_status="draft",
        rejection_reason=None,
        submitted_at=None,
        submitted_by=None,
        approved_at=None,
        approved_by=None,
    )
    db.add(new_item)
    await db.flush()

    # 6. إضافة وسوم خطوط التطبيق المبدئية إن وجدت
    if data.application_line_ids:
        for app_id in set(data.application_line_ids):
            app_line = await db.get(ApplicationLine, app_id)
            if not app_line or not app_line.is_active:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"خط التطبيق '{app_id}' غير موجود أو معطل.",
                )
            usage = CatalogItemUsage(item_id=new_item.id, application_id=app_id)
            db.add(usage)

    # 7. تسجيل حركة التدقيق الأولى في سجل التدقيق غير القابل للمسح
    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "warehouse_manager")
    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=new_item.id,
            revision_id=None,
            event_type="created",
            from_status=None,
            to_status="draft",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason="إنشاء مسودة صنف جديدة في الدليل",
            before_snapshot={},
            after_snapshot=make_item_snapshot(new_item),
            created_at=utc_now(),
        )
    )

    await db.commit()
    await db.refresh(new_item)
    return serialize_catalog_item(new_item)


@router.patch("/items/{item_id}", response_model=CatalogItemRead)
async def update_catalog_item(item_id: str, data: CatalogItemUpdate, current_user: CatalogManager, db: Database):
    """تعديل بيانات صنف في الدليل (المسودات فقط؛ الأصناف المعتمدة تتطلب تقديم طلب تعديل Revision)."""
    del current_user
    stmt = (
        select(CatalogItem)
        .options(selectinload(CatalogItem.unit), selectinload(CatalogItem.category))
        .where(CatalogItem.id == item_id)
    )
    item = (await db.scalars(stmt)).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود في الدليل.")

    # 1. حماية دورة المنتجات التامة FG-VAR-*
    is_finished_good = item.code.startswith("FG-VAR-") or item.item_type == "finished_garment"
    if is_finished_good:
        if data.unit_id and data.unit_id != item.unit_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="لا يمكن تغيير وحدة قياس صنف المنتج التام.")
        if data.item_type and data.item_type != item.item_type:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="لا يمكن تغيير نوع صنف المنتج التام.")
        if data.classification_status and data.classification_status != "not_applicable":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="أصناف المنتجات التامة يجب أن تظل بحالة غير منطبق (not_applicable).",
            )

    # 2. حوكمة تعديل الأصناف المعتمدة وقيد المراجعة
    if item.approval_status == "approved":
        disallowed_direct_fields = (data.name_ar, data.category_id, data.attributes, data.classification_status)
        if any(v is not None for v in disallowed_direct_fields):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="الصنف معتمد حالياً. لا يمكن تعديل بيانات الصنف الأساسية أو مواصفاته مباشرة؛ يرجى تقديم طلب تعديل (Revision) للمراجعة والاعتماد.",
            )
    elif item.approval_status == "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="الصنف قيد المراجعة حالياً؛ لا يمكن تعديل بياناته حتى يتم البت فيه أو رفضه.",
        )

    # 2. فحص وتحديث التصنيف
    if data.category_id is not None and data.category_id != item.category_id:
        cat = await db.get(ItemCategory, data.category_id)
        if not cat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="التصنيف المحدد غير موجود.")
        if not cat.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="لا يمكن نقل الصنف تحت تصنيف معطل.")
        item.category_id = data.category_id
        item.category = cat

    # 3. فحص وتحديث وحدة القياس
    if data.unit_id is not None and data.unit_id != item.unit_id:
        unit = await db.get(Unit, data.unit_id)
        if not unit:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="وحدة القياس المحددة غير موجودة.")

        # حظر تعديل وحدة الصنف إذا وُجدت أي حركات مخزنية تاريخية
        ledger_count = (await db.scalars(
            select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == item.id)
        )).one()
        if ledger_count > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="لا يمكن تعديل وحدة القياس لصنف لديه حركات مخزنية مسجلة للحفاظ على سلامة الأرصدة ودفتر الأستاذ.",
            )
        item.unit_id = data.unit_id
        item.unit = unit

    # 4. تحديث المواصفات
    if data.attributes is not None:
        item.attributes = data.attributes

    if data.name_ar is not None:
        item.name_ar = data.name_ar.strip()
    if data.item_type is not None and not is_finished_good:
        item.item_type = data.item_type.strip()
    if data.classification_status is not None and not is_finished_good:
        item.classification_status = data.classification_status
    if data.reorder_level is not None:
        item.reorder_level = Decimal(str(data.reorder_level))
    if data.is_consumable is not None:
        item.is_consumable = data.is_consumable
    if data.is_active is not None:
        if data.is_active and item.approval_status != "approved":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="لا يمكن تفعيل الصنف إلا بعد اعتماده رسمياً (الأصناف المسودة أو قيد المراجعة أو المرفوضة لا يمكن تفعيلها).",
            )
        item.is_active = data.is_active

    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog_item(item_id: str, current_user: CatalogManager, db: Database):
    """حذف صنف من الدليل فقط إذا كان غير معتمد وغير مرتبط بأي حركات مخزنية أو فواتير أو أوامر إنتاج."""
    del current_user
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود في الدليل.")

    # حظر حذف صنف المنتج التام
    if item.code.startswith("FG-VAR-") or item.item_type == "finished_garment":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف أصناف المنتجات التامة الموحدة؛ يرجى استخدام التعطيل بدلاً من الحذف.",
        )

    # حظر حذف الأصناف المعتمدة أو قيد المراجعة
    if item.approval_status == "approved":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف صنف معتمد؛ يرجى استخدام التعطيل بدلاً من الحذف للحفاظ على سلامة العمليات.",
        )
    if item.approval_status == "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="لا يمكن حذف صنف قيد المراجعة والاعتماد؛ يرجى رفضه أو إلغاؤه أولاً.",
        )

    # التحقق من الارتباطات التشغيلية
    ledger_count = (await db.scalars(select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == item.id))).one()
    if ledger_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف الصنف لوجود حركات مخزنية مسجلة به في دفتر أستاذ المخزون؛ استخدم خيار التعطيل بدلاً من الحذف.",
        )

    mat_count = (await db.scalars(select(func.count(ProductionOrderMaterial.id)).where(ProductionOrderMaterial.item_id == item.id))).one()
    if mat_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف الصنف لارتباطه بخامات أوامر تشغيل سابقة؛ استخدم التعطيل بدلاً من الحذف.",
        )

    tmpl_count = (await db.scalars(select(func.count(ProductionTemplateLine.id)).where(ProductionTemplateLine.item_id == item.id))).one()
    if tmpl_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف الصنف لارتباطه بقوالب إنتاج معتمدة؛ استخدم التعطيل بدلاً من الحذف.",
        )

    inv_count = (await db.scalars(select(func.count(SupplierInvoiceLine.id)).where(SupplierInvoiceLine.item_id == item.id))).one()
    if inv_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="لا يمكن حذف الصنف لارتباطه بفواتير مشتريات موردين مسجلة؛ استخدم التعطيل بدلاً من الحذف.",
        )

    # حذف وسوم الاستخدام وحذف الصنف
    await db.delete(item)
    await db.commit()
    return None


# ═════════════════════════════════════════════════════════════════════════════
# 2.B حوكمة دورة الاعتماد وإدارة المراجعات (Catalog Governance & Revisions)
# ═════════════════════════════════════════════════════════════════════════════

@router.post("/items/{item_id}/submit", response_model=CatalogItemRead)
async def submit_item_for_review(item_id: str, current_user: CatalogManager, db: Database):
    """تقديم مسودة صنف للمراجعة والاعتماد (draft/rejected -> pending_review)."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status == "approved":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="الصنف معتمد بالفعل.")
    if item.approval_status == "pending_review":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="الصنف مقدم للمراجعة بالفعل.")

    from_status = item.approval_status
    before_snap = make_item_snapshot(item)

    now = utc_now()
    item.approval_status = "pending_review"
    item.submitted_at = now
    item.submitted_by = current_user.id
    item.rejection_reason = None

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "warehouse_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=None,
            event_type="submitted",
            from_status=from_status,
            to_status="pending_review",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason="تقديم الصنف للمراجعة والاعتماد",
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.post("/items/{item_id}/approve", response_model=CatalogItemRead)
async def approve_catalog_item(item_id: str, current_user: CatalogApprover, db: Database):
    """اعتماد الصنف (pending_review -> approved) مع منع الاعتماد الذاتي والتأكد من جودة التصنيف."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"لا يمكن اعتماد الصنف وهو بالحالة الحالية '{item.approval_status}'؛ يجب أن يكون قيد المراجعة.",
        )

    # 1. منع الاعتماد الذاتي (Anti-Self-Approval / Segregation of Duties)
    if item.submitted_by and item.submitted_by == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="حظر الاعتماد الذاتي (Anti-Self-Approval): لا يجوز لمقدم الطلب اعتماد الصنف بنفسه؛ يجب أن يعتمده مراجع آخر أو المدير العام.",
        )

    # 2. فحص حالة التصنيف (Classification Guard)
    if item.classification_status == "needs_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="لا يمكن اعتماد صنف بحالة تصنيف 'يحتاج مراجعة' (needs_review). يرجى تأكيد التصنيف أولاً قبل الاعتماد النهائي.",
        )

    before_snap = make_item_snapshot(item)
    now = utc_now()
    item.approval_status = "approved"
    item.is_active = True
    item.approved_at = now
    item.approved_by = current_user.id
    item.rejection_reason = None

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "general_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=None,
            event_type="approved",
            from_status="pending_review",
            to_status="approved",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason="اعتماد الصنف وإدراجه رسمياً في دليل التشغيل",
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.post("/items/{item_id}/reject", response_model=CatalogItemRead)
async def reject_catalog_item(item_id: str, data: CatalogItemRejectRequest, current_user: CatalogApprover, db: Database):
    """رفض اعتماد الصنف (pending_review -> rejected) مع اشتراط سبب الرفض إلزامي."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"لا يمكن رفض الصنف وهو بالحالة الحالية '{item.approval_status}'؛ يجب أن يكون قيد المراجعة.",
        )

    reason_clean = data.rejection_reason.strip()
    if len(reason_clean) < 10:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="سبب الرفض إلزامي ويجب ألا يقل عن 10 أحرف لتوضيح النواقص للمصنع.",
        )

    before_snap = make_item_snapshot(item)
    now = utc_now()
    item.approval_status = "rejected"
    item.is_active = False
    item.rejection_reason = reason_clean

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "general_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=None,
            event_type="rejected",
            from_status="pending_review",
            to_status="rejected",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason=reason_clean,
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.post("/items/{item_id}/reopen", response_model=CatalogItemRead)
async def reopen_rejected_item(item_id: str, current_user: CatalogManager, db: Database):
    """إعادة فتح صنف مرفوض كمسودة للتعديل وإعادة التقديم (rejected -> draft)."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status != "rejected":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="يمكن إعادة فتح الأصناف المرفوضة فقط.",
        )

    before_snap = make_item_snapshot(item)
    now = utc_now()
    item.approval_status = "draft"
    item.is_active = False

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "warehouse_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=None,
            event_type="reopened",
            from_status="rejected",
            to_status="draft",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason="إعادة فتح الصنف للتصحيح والتعديل كمسودة",
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.post("/items/{item_id}/deactivate", response_model=CatalogItemRead)
async def deactivate_catalog_item(item_id: str, current_user: CatalogApprover, db: Database):
    """تعطيل صنف معتمد لمنع استخدامه في العمليات التشغيلية الجديدة (is_active = False)."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status != "approved":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="التعطيل مخصص للأصناف المعتمدة فقط؛ الأصناف غير المعتمدة محظورة تشغيلياً بطبيعتها.",
        )

    if not item.is_active:
        return serialize_catalog_item(item)

    before_snap = make_item_snapshot(item)
    now = utc_now()
    item.is_active = False

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "general_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=None,
            event_type="deactivated",
            from_status="approved",
            to_status="approved",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason="تعطيل الصنف من الاستخدام التشغيلي",
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.post("/items/{item_id}/reactivate", response_model=CatalogItemRead)
async def reactivate_catalog_item(item_id: str, current_user: CatalogApprover, db: Database):
    """إعادة تفعيل صنف معطل (is_active = True)."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status != "approved":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="لا يمكن تفعيل صنف غير معتمد؛ التفعيل مخصص للأصناف المعتمدة فقط.",
        )

    if item.is_active:
        return serialize_catalog_item(item)

    before_snap = make_item_snapshot(item)
    now = utc_now()
    item.is_active = True

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "general_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=None,
            event_type="reactivated",
            from_status=item.approval_status,
            to_status=item.approval_status,
            actor_id=current_user.id,
            actor_role=actor_role,
            reason="إعادة تفعيل الصنف للاستخدام التشغيلي",
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(item)
    return serialize_catalog_item(item)


@router.post("/items/{item_id}/revisions", response_model=CatalogItemRevisionRead, status_code=status.HTTP_201_CREATED)
async def create_item_revision(item_id: str, data: CatalogItemRevisionCreate, current_user: CatalogManager, db: Database):
    """تقديم طلب تعديل (Revision) لصنف معتمد دون المساس بالنسخة الحية."""
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    if item.approval_status != "approved":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="طلبات التعديل (Revisions) متاحة فقط للأصناف المعتمدة (approved)؛ للأصناف المسودة استخدم التعديل المباشر.",
        )

    # التحقق من وجود مراجعة مفتوحة قيد المراجعة
    open_rev = (await db.scalars(
        select(CatalogItemRevision).where(
            CatalogItemRevision.item_id == item.id,
            CatalogItemRevision.status == "pending_review",
        )
    )).first()
    if open_rev:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"يوجد طلب تعديل مفتوح بالفعل برقم #{open_rev.revision_number} قيد المراجعة لهذا الصنف. يرجى انتظار البت فيه أو إلغاؤه.",
        )

    # حماية الوثائق التاريخية: منع تغيير اسم الصنف إذا كانت هناك معاملات مرتبطة به
    proposed = data.proposed_changes or {}
    new_name = proposed.get("name_ar")
    if new_name is not None and isinstance(new_name, str) and new_name.strip() != item.name_ar:
        has_ledger = (await db.scalar(select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == item.id))) > 0
        has_prod = (await db.scalar(select(func.count(ProductionOrderMaterial.id)).where(ProductionOrderMaterial.item_id == item.id))) > 0
        has_inv = (await db.scalar(select(func.count(SupplierInvoiceLine.id)).where(SupplierInvoiceLine.item_id == item.id))) > 0
        if has_ledger or has_prod or has_inv:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="لا يمكن تقديم طلب لتعديل اسم الصنف (name_ar) لصنف ارتبط بحركات مخزنية أو فواتير موردين أو أوامر إنتاج سابقة، وذلك لحماية سلامة الوثائق التاريخية. يرجى إنشاء صنف جديد بدلاً من ذلك.",
            )

    # حساب رقم المراجعة التالي
    max_rev = await db.scalar(
        select(func.coalesce(func.max(CatalogItemRevision.revision_number), 0)).where(
            CatalogItemRevision.item_id == item.id
        )
    )
    next_rev_num = (max_rev or 0) + 1

    fingerprint = calculate_item_fingerprint(item)
    now = utc_now()

    revision = CatalogItemRevision(
        id=str(uuid.uuid4()),
        item_id=item.id,
        revision_number=next_rev_num,
        status="pending_review",
        proposed_changes=data.proposed_changes,
        change_summary=data.change_summary.strip(),
        base_fingerprint=fingerprint,
        submitted_by=current_user.id,
        submitted_at=now,
        created_at=now,
    )
    db.add(revision)
    await db.flush()

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "warehouse_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=revision.id,
            event_type="revision_submitted",
            from_status="approved",
            to_status="approved",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason=f"تقديم طلب تعديل #{next_rev_num}: {data.change_summary.strip()}",
            before_snapshot=make_item_snapshot(item),
            after_snapshot={"proposed_changes": data.proposed_changes},
            created_at=now,
        )
    )
    await db.commit()
    await db.refresh(revision)

    return CatalogItemRevisionRead(
        id=revision.id,
        item_id=revision.item_id,
        revision_number=revision.revision_number,
        status=revision.status,
        proposed_changes=revision.proposed_changes or {},
        change_summary=revision.change_summary,
        base_fingerprint=revision.base_fingerprint,
        submitted_by=revision.submitted_by,
        submitted_at=revision.submitted_at,
        reviewed_by=revision.reviewed_by,
        reviewed_at=revision.reviewed_at,
        rejection_reason=revision.rejection_reason,
        created_at=revision.created_at,
    )


@router.post("/items/{item_id}/revisions/{revision_id}/approve", response_model=CatalogItemRevisionRead)
async def approve_item_revision(item_id: str, revision_id: str, current_user: CatalogApprover, db: Database):
    """اعتماد طلب التعديل وتطبيقه ذرياً (Atomically) على الصنف الحي مع تسجيل التاريخ."""
    revision = await db.get(CatalogItemRevision, revision_id)
    if not revision or revision.item_id != item_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="طلب التعديل غير موجود لهذا الصنف.")

    if revision.status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"طلب التعديل بالحالة '{revision.status}' ولا يمكن اعتماده.",
        )

    # منع الاعتماد الذاتي
    if revision.submitted_by and revision.submitted_by == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="حظر الاعتماد الذاتي (Anti-Self-Approval): لا يجوز لمقدم طلب التعديل اعتماده بنفسه.",
        )

    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف الأصلي غير موجود.")

    before_snap = make_item_snapshot(item)
    now = utc_now()

    # تطبيق التغييرات المقترحة ذرياً
    changes = revision.proposed_changes or {}
    if "name_ar" in changes and isinstance(changes["name_ar"], str):
        new_name = changes["name_ar"].strip()
        if new_name != item.name_ar:
            has_ledger = (await db.scalar(select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == item.id))) > 0
            has_prod = (await db.scalar(select(func.count(ProductionOrderMaterial.id)).where(ProductionOrderMaterial.item_id == item.id))) > 0
            has_inv = (await db.scalar(select(func.count(SupplierInvoiceLine.id)).where(SupplierInvoiceLine.item_id == item.id))) > 0
            if has_ledger or has_prod or has_inv:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="لا يمكن اعتماد تعديل اسم الصنف (name_ar) لوجود حركات مخزنية أو فواتير أو أوامر إنتاج سابقة مرتبطة به.",
                )
            item.name_ar = new_name

    if "category_id" in changes:
        cat_id = changes["category_id"]
        if cat_id is not None:
            cat = await db.get(ItemCategory, cat_id)
            if not cat or not cat.is_active:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="التصنيف المقترح غير صالح أو معطل.")
        item.category_id = cat_id

    if "classification_status" in changes and isinstance(changes["classification_status"], str):
        if changes["classification_status"] not in {"confirmed", "suggested", "needs_review", "not_applicable"}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="حالة التصنيف المقترحة غير صالحة.")
        item.classification_status = changes["classification_status"]

    if "attributes" in changes and isinstance(changes["attributes"], dict):
        merged_attrs = dict(item.attributes or {})
        merged_attrs.update(changes["attributes"])
        item.attributes = merged_attrs

    if "reorder_level" in changes and changes["reorder_level"] is not None:
        try:
            val = float(changes["reorder_level"])
            if val >= 0:
                item.reorder_level = Decimal(str(val))
        except (ValueError, TypeError):
            pass

    if "is_consumable" in changes and isinstance(changes["is_consumable"], bool):
        item.is_consumable = changes["is_consumable"]

    # تحديث حالة المراجعة
    revision.status = "applied"
    revision.reviewed_by = current_user.id
    revision.reviewed_at = now

    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "general_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item.id,
            revision_id=revision.id,
            event_type="revision_applied",
            from_status="approved",
            to_status="approved",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason=f"اعتماد وتطبيق طلب التعديل #{revision.revision_number}: {revision.change_summary}",
            before_snapshot=before_snap,
            after_snapshot=make_item_snapshot(item),
            created_at=now,
        )
    )

    await db.commit()
    await db.refresh(revision)

    return CatalogItemRevisionRead(
        id=revision.id,
        item_id=revision.item_id,
        revision_number=revision.revision_number,
        status=revision.status,
        proposed_changes=revision.proposed_changes or {},
        change_summary=revision.change_summary,
        base_fingerprint=revision.base_fingerprint,
        submitted_by=revision.submitted_by,
        submitted_at=revision.submitted_at,
        reviewed_by=revision.reviewed_by,
        reviewed_at=revision.reviewed_at,
        rejection_reason=revision.rejection_reason,
        created_at=revision.created_at,
    )


@router.post("/items/{item_id}/revisions/{revision_id}/reject", response_model=CatalogItemRevisionRead)
async def reject_item_revision(
    item_id: str,
    revision_id: str,
    data: CatalogItemRevisionRejectRequest,
    current_user: CatalogApprover,
    db: Database,
):
    """رفض طلب تعديل مع تسجيل السبب الإلزامي دون التأثير على الصنف المعتمد."""
    revision = await db.get(CatalogItemRevision, revision_id)
    if not revision or revision.item_id != item_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="طلب التعديل غير موجود لهذا الصنف.")

    if revision.status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"طلب التعديل بالحالة '{revision.status}' ولا يمكن رفضه.",
        )

    reason_clean = data.rejection_reason.strip()
    now = utc_now()
    revision.status = "rejected"
    revision.rejection_reason = reason_clean
    revision.reviewed_by = current_user.id
    revision.reviewed_at = now

    item = await db.get(CatalogItem, item_id)
    roles = await get_user_roles(current_user, db=db)
    actor_role = next(iter(roles), "general_manager")

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item_id,
            revision_id=revision.id,
            event_type="revision_rejected",
            from_status="approved",
            to_status="approved",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason=f"رفض طلب التعديل #{revision.revision_number}: {reason_clean}",
            before_snapshot=make_item_snapshot(item) if item else {},
            after_snapshot={"status": "rejected", "rejection_reason": reason_clean},
            created_at=now,
        )
    )

    await db.commit()
    await db.refresh(revision)

    return CatalogItemRevisionRead(
        id=revision.id,
        item_id=revision.item_id,
        revision_number=revision.revision_number,
        status=revision.status,
        proposed_changes=revision.proposed_changes or {},
        change_summary=revision.change_summary,
        base_fingerprint=revision.base_fingerprint,
        submitted_by=revision.submitted_by,
        submitted_at=revision.submitted_at,
        reviewed_by=revision.reviewed_by,
        reviewed_at=revision.reviewed_at,
        rejection_reason=revision.rejection_reason,
        created_at=revision.created_at,
    )


@router.post("/items/{item_id}/revisions/{revision_id}/cancel", response_model=CatalogItemRevisionRead)
async def cancel_item_revision(item_id: str, revision_id: str, current_user: CatalogManager, db: Database):
    """إلغاء طلب تعديل مفتوح من قبل مقدم الطلب أو الإدارة."""
    revision = await db.get(CatalogItemRevision, revision_id)
    if not revision or revision.item_id != item_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="طلب التعديل غير موجود لهذا الصنف.")

    if revision.status != "pending_review":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"طلب التعديل بالحالة '{revision.status}' ولا يمكن إلغاؤه.",
        )

    roles = await get_user_roles(current_user, db=db)
    is_admin = "general_manager" in roles
    if revision.submitted_by != current_user.id and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="لا يمكن إلغاء طلب التعديل إلا من قبل المستخدم الذي قدمه أو المدير العام.",
        )

    now = utc_now()
    revision.status = "cancelled"

    actor_role = next(iter(roles), "warehouse_manager")
    item = await db.get(CatalogItem, item_id)

    db.add(
        CatalogApprovalHistory(
            id=str(uuid.uuid4()),
            item_id=item_id,
            revision_id=revision.id,
            event_type="revision_cancelled",
            from_status="approved",
            to_status="approved",
            actor_id=current_user.id,
            actor_role=actor_role,
            reason=f"إلغاء طلب التعديل #{revision.revision_number}",
            before_snapshot=make_item_snapshot(item) if item else {},
            after_snapshot={"status": "cancelled"},
            created_at=now,
        )
    )

    await db.commit()
    await db.refresh(revision)

    return CatalogItemRevisionRead(
        id=revision.id,
        item_id=revision.item_id,
        revision_number=revision.revision_number,
        status=revision.status,
        proposed_changes=revision.proposed_changes or {},
        change_summary=revision.change_summary,
        base_fingerprint=revision.base_fingerprint,
        submitted_by=revision.submitted_by,
        submitted_at=revision.submitted_at,
        reviewed_by=revision.reviewed_by,
        reviewed_at=revision.reviewed_at,
        rejection_reason=revision.rejection_reason,
        created_at=revision.created_at,
    )


@router.get("/items/{item_id}/revisions", response_model=List[CatalogItemRevisionRead])
async def list_item_revisions(item_id: str, current_user: CatalogViewer, db: Database):
    """عرض سجل طلبات التعديل لصنف محدد."""
    del current_user
    stmt = (
        select(CatalogItemRevision)
        .where(CatalogItemRevision.item_id == item_id)
        .order_by(CatalogItemRevision.revision_number.desc())
    )
    revs = (await db.scalars(stmt)).all()
    return [
        CatalogItemRevisionRead(
            id=r.id,
            item_id=r.item_id,
            revision_number=r.revision_number,
            status=r.status,
            proposed_changes=r.proposed_changes or {},
            change_summary=r.change_summary,
            base_fingerprint=r.base_fingerprint,
            submitted_by=r.submitted_by,
            submitted_at=r.submitted_at,
            reviewed_by=r.reviewed_by,
            reviewed_at=r.reviewed_at,
            rejection_reason=r.rejection_reason,
            created_at=r.created_at,
        )
        for r in revs
    ]


@router.get("/items/{item_id}/history", response_model=List[CatalogApprovalHistoryRead])
async def get_item_approval_history(item_id: str, current_user: CatalogViewer, db: Database):
    """عرض سجل التدقيق التاريخي الكامل للصنف غير القابل للتعديل أو المسح."""
    del current_user
    stmt = (
        select(CatalogApprovalHistory)
        .where(CatalogApprovalHistory.item_id == item_id)
        .order_by(CatalogApprovalHistory.created_at.desc())
    )
    entries = (await db.scalars(stmt)).all()
    return [
        CatalogApprovalHistoryRead(
            id=e.id,
            item_id=e.item_id,
            revision_id=e.revision_id,
            event_type=e.event_type,
            from_status=e.from_status,
            to_status=e.to_status,
            actor_id=e.actor_id,
            actor_role=e.actor_role,
            reason=e.reason,
            before_snapshot=e.before_snapshot or {},
            after_snapshot=e.after_snapshot or {},
            created_at=e.created_at,
        )
        for e in entries
    ]


@router.get("/pending-reviews", response_model=List[CatalogItemRead])
async def list_pending_reviews(
    current_user: CatalogViewer,
    db: Database,
    limit: int = Query(default=50, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
):
    """قائمة انتظار الأصناف المقدمة للمراجعة والاعتماد (Approval Queue)."""
    del current_user
    stmt = (
        select(CatalogItem)
        .options(selectinload(CatalogItem.unit), selectinload(CatalogItem.category))
        .where(CatalogItem.approval_status == "pending_review")
        .order_by(CatalogItem.submitted_at.asc())
        .limit(limit)
        .offset(offset)
    )
    items = (await db.scalars(stmt)).all()
    return [serialize_catalog_item(it, False) for it in items]


@router.get("/pending-revisions", response_model=List[CatalogItemRevisionRead])
async def list_pending_revisions(
    current_user: CatalogViewer,
    db: Database,
    limit: int = Query(default=50, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
):
    """قائمة انتظار طلبات التعديل المفتوحة للأصناف المعتمدة (Revision Queue)."""
    del current_user
    stmt = (
        select(CatalogItemRevision)
        .where(CatalogItemRevision.status == "pending_review")
        .order_by(CatalogItemRevision.submitted_at.asc())
        .limit(limit)
        .offset(offset)
    )
    revs = (await db.scalars(stmt)).all()
    return [
        CatalogItemRevisionRead(
            id=r.id,
            item_id=r.item_id,
            revision_number=r.revision_number,
            status=r.status,
            proposed_changes=r.proposed_changes or {},
            change_summary=r.change_summary,
            base_fingerprint=r.base_fingerprint,
            submitted_by=r.submitted_by,
            submitted_at=r.submitted_at,
            reviewed_by=r.reviewed_by,
            reviewed_at=r.reviewed_at,
            rejection_reason=r.rejection_reason,
            created_at=r.created_at,
        )
        for r in revs
    ]


# ═════════════════════════════════════════════════════════════════════════════
# 3. خطوط التطبيق ووسوم الاستخدام (Application Lines & Item Usages)
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/application-lines", response_model=List[ApplicationLineRead])
async def list_application_lines(
    current_user: CatalogViewer,
    db: Database,
    is_active: Optional[bool] = Query(default=None, description="تصفية خطوط التطبيق النشطة أو المعطلة"),
):
    """عرض قائمة خطوط وتطبيقات الملابس المرجعية المعتمدة."""
    del current_user
    stmt = select(ApplicationLine).order_by(ApplicationLine.sort_order, ApplicationLine.code)
    if is_active is not None:
        stmt = stmt.where(ApplicationLine.is_active == is_active)
    return (await db.scalars(stmt)).all()


@router.get("/items/{item_id}/usages", response_model=List[ApplicationLineRead])
async def get_item_usages(item_id: str, current_user: CatalogViewer, db: Database):
    """عرض خطوط التطبيق والاستخدامات المرتبطة بصنف معين."""
    del current_user
    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    stmt = (
        select(ApplicationLine)
        .join(CatalogItemUsage, ApplicationLine.id == CatalogItemUsage.application_id)
        .where(CatalogItemUsage.item_id == item.id)
        .order_by(ApplicationLine.sort_order, ApplicationLine.code)
    )
    return (await db.scalars(stmt)).all()


@router.post("/items/{item_id}/usages", response_model=ApplicationLineRead, status_code=status.HTTP_201_CREATED)
async def add_item_usage(item_id: str, data: CatalogItemUsageCreate, current_user: CatalogManager, db: Database):
    """إضافة وسم استخدام لربط الصنف بخط تطبيق ملابس معين (وسم استرشادي فقط)."""
    del current_user

    item = await db.get(CatalogItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="الصنف المطلوب غير موجود.")

    app_line = await db.get(ApplicationLine, data.application_id)
    if not app_line:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="خط التطبيق المحدد غير موجود.")
    if not app_line.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="لا يمكن ربط الصنف بخط تطبيق معطل.")

    # التحقق من عدم التكرار
    existing = await db.get(CatalogItemUsage, (item.id, app_line.id))
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="وسم الاستخدام هذا مضاف مسبقاً للصنف.",
        )

    usage = CatalogItemUsage(item_id=item.id, application_id=app_line.id)
    db.add(usage)
    await db.commit()

    return ApplicationLineRead(
        id=app_line.id,
        code=app_line.code,
        name_ar=app_line.name_ar,
        name_en=app_line.name_en,
        description=app_line.description,
        is_active=app_line.is_active,
        sort_order=app_line.sort_order,
    )


@router.delete("/items/{item_id}/usages/{application_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_item_usage(item_id: str, application_id: str, current_user: CatalogManager, db: Database):
    """إزالة وسم خط تطبيق من الصنف."""
    del current_user
    usage = await db.get(CatalogItemUsage, (item_id, application_id))
    if not usage:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="وسم الاستخدام غير موجود لهذا الصنف.",
        )

    await db.delete(usage)
    await db.commit()
    return None


# ═════════════════════════════════════════════════════════════════════════════
# 4. وحدات القياس (Units — Read Only)
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/units", response_model=List[UnitRead])
async def list_units(current_user: CatalogViewer, db: Database):
    """عرض وحدات القياس المتاحة في النظام لاستخدامها في نماذج إدخال الأصناف (قراءة فقط دون تحويلات)."""
    del current_user
    stmt = select(Unit).order_by(Unit.code)
    return (await db.scalars(stmt)).all()
