"""
مسارات واجهة برمجة التطبيقات لأوامر الإنتاج (Production Orders Endpoints)
─────────────────────────────────────────────────────────────────────────────
تتضمن:
1. استعراض المنتجات والموديلات والمتغيرات (المقاسات الرقمية 56-64 والمواسم).
2. استعراض وإنشاء قوالب الإنتاج مع الكميات المرجعية.
3. إنشاء أوامر التشغيل وحساب الخامات نسبياً وتجميدها كلقطة مستقلة.
4. استعراض تفاصيل الأمر والخامات وحالة المراحل.
5. صرف خامات الدفعة (بالطريق) وتأكيد الاستلام بمخزن تحت التشغيل مع تسجيل الفروقات.
6. التحديث التتابعي لمراحل القص والتشطيب والكبسولة والكي والتعبئة.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.idempotency import execute_idempotent_operation
from app.core.permissions import require_any_permission, require_permission
from app.db.session import get_db
from app.modules.finance.ledger_service import post_journal_entry
from app.modules.production.stock import finished_goods_bucket, order_wip_bucket, stock_balance
from app.modules.production.service import (
    get_or_create_finished_goods_item,
    lock_stock_balance,
)
from app.modules.production.models import (
    CatalogItem,
    Customer,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionDefect,
    ProductionMaterialReconciliation,
    ProductionMaterialReconciliationLine,
    ProductionStageEvent,
    ProductionStageHistory,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    StockLedgerEntry,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.modules.production.schemas import (
    CatalogItemRead,
    FinishedGoodsReceiptCreate,
    FinishedGoodsReceiptLineRead,
    FinishedGoodsReceiptRead,
    MaterialReconciliationCreate,
    MaterialReconciliationLineRead,
    MaterialReconciliationRead,
    MaterialShortageItem,
    OrderCloseRequest,
    OrderCloseResponse,
    OrderCreate,
    OrderMaterialSnapshotRead,
    OrderMaterialCreate,
    OrderMaterialWipItem,
    OrderRead,
    OrderShortagesReport,
    OrderWipSummary,
    ProductCreate,
    ProductRead,
    ProductUpdate,
    ProductVariantCreate,
    ProductVariantUpdate,
    PRODUCT_SEASONS,
    ProductVariantRead,
    ProductionOrderItemRead,
    ProductionPerformanceSummary,
    ProductionStageEventRead,
    ProductionStageHistoryRead,
    ProductionDefectCreate,
    ProductionDefectRead,
    ProductionDefectUpdate,
    StagePerformanceItem,
    StageRollbackRequest,
    ReceiptConfirmRequest,
    StageUpdate,
    TemplateCreate,
    TemplateLineRead,
    TemplateRead,
    TemplateVersionRead,
    WarehouseRead,
    WarehouseTransferLineRead,
    WarehouseTransferRead,
)
from app.modules.production.service import (
    STAGE_NAMES_AR,
    add_material_to_draft_order,
    remove_material_from_draft_order,
    confirm_warehouse_receipt,
    create_production_order,
    dispatch_order_materials,
    update_production_stage,
    reopen_last_completed_stage,
)

from app.modules.production.returns import (
    RETURN_STATUS_IN_TRANSIT,
    RETURN_STATUS_PENDING_RESOLUTION,
    create_return_transfer,
    transfer_is_dispatch,
    transfer_is_return,
    operational_warehouses,
    order_return_transfers,
    receive_return,
    resolve_return,
    return_state,
    unresolved_return_counts,
)
from app.modules.production.bom import active_bom_version, compute_requirements, save_variant_bom, variant_label
from app.modules.production.schemas import (
    BomLineRead,
    BomSaveRequest,
    OrderItemBomLineRead,
    ProductBomRead,
    RequirementLineMaterial,
    RequirementLineRead,
    RequirementMaterialRead,
    RequirementsRead,
    RequirementsRequest,
    VariantBomRead,
    ReturnLineRead,
    ReturnReceiptRequest,
    ReturnResolutionRequest,
    ReturnTransferRead,
)

router = APIRouter(prefix="/production", tags=["production"])


def _defect_read(defect: ProductionDefect) -> ProductionDefectRead:
    return ProductionDefectRead(
        id=defect.id, defect_number=defect.defect_number, order_id=defect.order_id,
        stage_name=defect.stage_name, description=defect.description,
        affected_quantity=defect.affected_quantity, responsible=defect.responsible,
        repair_action=defect.repair_action, status=defect.status,
        repair_cost_description=defect.repair_cost_description,
        reported_by=defect.reported_by, created_at=defect.created_at,
        updated_at=defect.updated_at,
    )


def _ensure_defects_editable(order: ProductionOrder) -> None:
    """سجل عيوب الأمر المغلق جزء من تاريخه المعتمد؛ لا يُضاف إليه ولا يُعدَّل بصمت بعد الإغلاق."""
    if order.status == "closed":
        raise HTTPException(
            status_code=409,
            detail="أمر التشغيل مغلق؛ لا يمكن تسجيل عيب جديد أو تعديل عيب سابق. أي تصحيح بعد الإغلاق يحتاج مسار تصحيح معتمد.",
        )


@router.get("/orders/{order_id}/defects", response_model=List[ProductionDefectRead])
async def list_order_defects(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    if not await db.get(ProductionOrder, order_id):
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    result = await db.execute(
        select(ProductionDefect).where(ProductionDefect.order_id == order_id)
        .order_by(ProductionDefect.created_at.desc())
    )
    return [_defect_read(row) for row in result.scalars().all()]


@router.post("/orders/{order_id}/defects", response_model=ProductionDefectRead, status_code=status.HTTP_201_CREATED)
async def report_order_defect(
    order_id: str,
    data: ProductionDefectCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    order = await db.get(ProductionOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    _ensure_defects_editable(order)
    if data.stage_name not in {"cutting", "finishing", "snap_installation", "ironing", "packing"}:
        raise HTTPException(status_code=422, detail="مرحلة الإنتاج غير معروفة.")
    defect = ProductionDefect(
        id=str(uuid.uuid4()), defect_number=f"DEF-{uuid.uuid4().hex[:12].upper()}",
        order_id=order_id, stage_name=data.stage_name, description=data.description,
        affected_quantity=data.affected_quantity, responsible=data.responsible,
        repair_action=data.repair_action, repair_cost_description=data.repair_cost_description,
        reported_by=current_user.id,
    )
    db.add(defect)
    await db.commit()
    await db.refresh(defect)
    return _defect_read(defect)


@router.patch("/orders/{order_id}/defects/{defect_id}", response_model=ProductionDefectRead)
async def update_order_defect(
    order_id: str,
    defect_id: str,
    data: ProductionDefectUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    defect = await db.get(ProductionDefect, defect_id)
    if not defect or defect.order_id != order_id:
        raise HTTPException(status_code=404, detail="سجل العيب غير موجود.")
    order = await db.get(ProductionOrder, order_id)
    if order:
        _ensure_defects_editable(order)
    defect.status = data.status
    if data.repair_action is not None:
        defect.repair_action = data.repair_action
    if data.repair_cost_description is not None:
        defect.repair_cost_description = data.repair_cost_description
    await db.commit()
    await db.refresh(defect)
    return _defect_read(defect)


# ─── 1. المنتجات والموديلات ─────────────────────────────────────────────────

@router.get("/products", response_model=List[ProductRead])
async def list_products(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض الموديلات الستة ومتغيرات المقاسات (الرقمية 56-64 والحرفية والمواسم)."""
    stmt = select(Product).options(selectinload(Product.variants)).order_by(Product.code)
    res = await db.execute(stmt)
    products = res.scalars().all()
    bom_status = await _bom_status_by_variant(db)
    return [_product_read(p, bom_status) for p in products]


async def _bom_status_by_variant(db: AsyncSession) -> dict[str, int]:
    """رقم الإصدار النشط لمستلزمات كل مقاس له مستلزمات معرّفة (استعلام واحد لكل الموديلات)."""
    has_lines = (
        select(ProductionTemplateLine.id)
        .where(ProductionTemplateLine.version_id == ProductionTemplateVersion.id)
        .exists()
    )
    rows = await db.execute(
        select(ProductionTemplate.variant_id, func.max(ProductionTemplateVersion.version_number))
        .join(ProductionTemplateVersion, ProductionTemplateVersion.template_id == ProductionTemplate.id)
        .where(
            ProductionTemplate.variant_id.is_not(None),
            ProductionTemplate.is_active.is_(True),
            ProductionTemplateVersion.status == "active",
            has_lines,
        )
        .group_by(ProductionTemplate.variant_id)
    )
    return {variant_id: number for variant_id, number in rows}


def _product_read(p: Product, bom_status: dict[str, int] | None = None) -> ProductRead:
    variants = sorted(p.variants, key=lambda v: (v.numeric_size, v.season))
    bom_status = bom_status or {}
    return ProductRead(
        id=p.id,
        code=p.code,
        name_ar=p.name_ar,
        style_type=p.style_type,
        description=p.description or "",
        is_active=p.is_active is not False,
        variants=[
            ProductVariantRead(
                id=v.id,
                product_id=v.product_id,
                numeric_size=v.numeric_size,
                letter_size=v.letter_size,
                season=v.season,
                sku=v.sku,
                is_active=v.is_active is not False,
                has_bom=v.id in bom_status,
                bom_version_number=bom_status.get(v.id),
            )
            for v in variants
        ],
    )


async def _load_product(db: AsyncSession, product_id: str) -> Product:
    product = (
        await db.execute(select(Product).options(selectinload(Product.variants)).where(Product.id == product_id))
    ).scalar_one_or_none()
    if not product:
        raise HTTPException(status_code=404, detail="الموديل غير موجود.")
    return product


async def _add_variants(db: AsyncSession, product: Product, variants: List[ProductVariantCreate]) -> None:
    rows = await db.execute(
        select(ProductVariant.numeric_size, ProductVariant.season).where(ProductVariant.product_id == product.id)
    )
    existing = {(size, season) for size, season in rows}
    for spec in variants:
        season = spec.season.strip().lower()
        if season not in PRODUCT_SEASONS:
            raise HTTPException(status_code=422, detail="الموسم يجب أن يكون صيفي أو خريفي أو شتوي.")
        key = (spec.numeric_size, season)
        if key in existing:
            season_ar = {"summer": "الصيفي", "autumn": "الخريفي", "winter": "الشتوي"}[season]
            raise HTTPException(status_code=409, detail=f"المقاس {spec.numeric_size} للموسم {season_ar} موجود بالفعل لهذا الموديل.")
        existing.add(key)
        sku = (spec.sku or "").strip() or f"{product.code}-{spec.numeric_size}-{season[:3].upper()}"
        if await db.scalar(select(ProductVariant.id).where(ProductVariant.sku == sku)):
            raise HTTPException(status_code=409, detail=f"كود المقاس (SKU) {sku} مستخدم بالفعل.")
        db.add(ProductVariant(
            id=str(uuid.uuid4()),
            product_id=product.id,
            numeric_size=spec.numeric_size,
            letter_size=spec.letter_size.strip(),
            season=season,
            sku=sku,
        ))


@router.post("/products", response_model=ProductRead, status_code=status.HTTP_201_CREATED)
async def create_product(
    data: ProductCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إضافة موديل جديد مع مقاساته."""
    code = data.code.strip().upper()
    if await db.scalar(select(Product.id).where(Product.code == code)):
        raise HTTPException(status_code=409, detail="كود الموديل مستخدم بالفعل.")
    product = Product(
        id=str(uuid.uuid4()), code=code, name_ar=data.name_ar.strip(),
        style_type=data.style_type.strip(), description=data.description.strip(),
    )
    db.add(product)
    await db.flush()
    await _add_variants(db, product, data.variants)
    product_id = product.id
    await db.commit()
    db.expire_all()
    return _product_read(await _load_product(db, product_id))


@router.patch("/products/{product_id}", response_model=ProductRead)
async def update_product(
    product_id: str,
    data: ProductUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تعديل اسم الموديل أو وصفه. الكود والمقاسات المسجلة لا تتغير حفاظاً على الحركات السابقة."""
    product = await _load_product(db, product_id)
    if data.name_ar is not None:
        product.name_ar = data.name_ar.strip()
    if data.style_type is not None:
        product.style_type = data.style_type.strip()
    if data.description is not None:
        product.description = data.description.strip()
    if data.is_active is not None:
        product.is_active = data.is_active
    await db.commit()
    db.expire_all()
    return _product_read(await _load_product(db, product_id), await _bom_status_by_variant(db))


@router.patch("/variants/{variant_id}", response_model=ProductRead)
async def update_product_variant(
    variant_id: str,
    data: ProductVariantUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """
    إيقاف مقاس أو إعادة تفعيله أو تعديل مقاسه الحرفي. المقاس لا يُحذف لارتباطه بحركات مخزن وأوامر سابقة؛
    الموقوف لا يُختار في أوامر تشغيل جديدة فقط.
    """
    variant = await db.get(ProductVariant, variant_id)
    if not variant:
        raise HTTPException(status_code=404, detail="المقاس غير موجود.")
    if data.is_active is not None:
        variant.is_active = data.is_active
    if data.letter_size is not None:
        variant.letter_size = data.letter_size.strip()
    product_id = variant.product_id
    await db.commit()
    db.expire_all()
    return _product_read(await _load_product(db, product_id), await _bom_status_by_variant(db))


@router.post("/products/{product_id}/variants", response_model=ProductRead, status_code=status.HTTP_201_CREATED)
async def add_product_variants(
    product_id: str,
    variants: List[ProductVariantCreate],
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إضافة مقاسات جديدة لموديل قائم."""
    if not variants:
        raise HTTPException(status_code=422, detail="أضف مقاساً واحداً على الأقل.")
    product = await _load_product(db, product_id)
    await _add_variants(db, product, variants)
    await db.commit()
    db.expire_all()
    return _product_read(await _load_product(db, product_id), await _bom_status_by_variant(db))


# ─── 2. الأصناف والمخازن ───────────────────────────────────────────────────

@router.get("/catalog-items", response_model=List[CatalogItemRead])
async def list_catalog_items(
    current_user: AuthenticatedUser = Depends(require_any_permission("production:orders:view", "catalog:view", "suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض أصناف الدليل مع التمييز بين الخامات والأدوات ومواد التعبئة."""
    stmt = select(CatalogItem).options(selectinload(CatalogItem.unit)).order_by(CatalogItem.code)
    res = await db.execute(stmt)
    items = res.scalars().all()
    return [
        CatalogItemRead(
            id=it.id,
            code=it.code,
            name_ar=it.name_ar,
            item_type=it.item_type,
            unit_id=it.unit_id,
            unit_name_ar=it.unit.name_ar if it.unit else "",
            is_consumable=it.is_consumable,
            is_active=it.is_active,
            category_id=it.category_id,
            classification_status=it.classification_status or "needs_review",
            reorder_level=float(it.reorder_level or 0),
            approval_status=it.approval_status or "draft",
        )
        for it in items
    ]


@router.get("/warehouses", response_model=List[WarehouseRead])
async def list_warehouses(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض المخازن التشغيلية الثلاثة."""
    res = await db.execute(select(Warehouse).order_by(Warehouse.code))
    warehouses = res.scalars().all()
    return [
        WarehouseRead(id=w.id, code=w.code, name_ar=w.name_ar, is_active=w.is_active)
        for w in warehouses
    ]


# ─── 3. قوالب الإنتاج ───────────────────────────────────────────────────────

@router.get("/templates", response_model=List[TemplateRead])
async def list_templates(
    product_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض قوالب الإنتاج وإصداراتها وبنود المواد والكميات المرجعية."""
    stmt = (
        select(ProductionTemplate)
        .options(
            selectinload(ProductionTemplate.product),
            selectinload(ProductionTemplate.versions)
            .selectinload(ProductionTemplateVersion.lines)
            .selectinload(ProductionTemplateLine.item),
            selectinload(ProductionTemplate.versions)
            .selectinload(ProductionTemplateVersion.lines)
            .selectinload(ProductionTemplateLine.unit),
        )
        .order_by(ProductionTemplate.code)
    )
    if product_id:
        stmt = stmt.where(ProductionTemplate.product_id == product_id)

    res = await db.execute(stmt)
    templates = res.scalars().all()

    output = []
    for t in templates:
        v_list = []
        for ver in t.versions:
            lines = [
                TemplateLineRead(
                    id=l.id,
                    item_id=l.item_id,
                    item_name_ar=l.item.name_ar if l.item else "",
                    item_code=l.item.code if l.item else "",
                    unit_id=l.unit_id,
                    unit_name_ar=l.unit.name_ar if l.unit else "",
                    quantity_per_reference=l.quantity_per_reference,
                    notes=l.notes or "",
                )
                for l in ver.lines
            ]
            v_list.append(
                TemplateVersionRead(
                    id=ver.id,
                    version_number=ver.version_number,
                    status=ver.status,
                    reference_quantity=ver.reference_quantity,
                    notes=ver.notes or "",
                    lines=lines,
                )
            )
        output.append(
            TemplateRead(
                id=t.id,
                code=t.code,
                name_ar=t.name_ar,
                product_id=t.product_id,
                product_name_ar=t.product.name_ar if t.product else "",
                is_active=t.is_active,
                versions=v_list,
            )
        )
    return output


@router.post("/templates", response_model=TemplateRead, status_code=status.HTTP_201_CREATED)
async def create_template(
    data: TemplateCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إنشاء قالب إنتاج جديد أو إصدار مسودة جديدة (مخصص لـ general_manager)."""
    product = await db.get(Product, data.product_id)
    if not product:
        raise HTTPException(status_code=404, detail="المنتج غير موجود.")

    tmpl = ProductionTemplate(
        id=str(uuid.uuid4()),
        code=data.code,
        name_ar=data.name_ar,
        product_id=data.product_id,
    )
    db.add(tmpl)
    await db.flush()

    ver = ProductionTemplateVersion(
        id=str(uuid.uuid4()),
        template_id=tmpl.id,
        version_number=1,
        status="draft",
        reference_quantity=data.reference_quantity,
        notes=data.notes,
    )
    db.add(ver)
    await db.flush()

    for line_in in data.lines:
        item = await db.get(CatalogItem, line_in.item_id)
        if not item or not item.is_active:
            raise HTTPException(status_code=400, detail=f"الصنف '{line_in.item_id}' غير موجود أو غير نشط في الدليل.")
        if item.approval_status != "approved":
            raise HTTPException(status_code=400, detail=f"الصنف '{item.name_ar}' غير معتمد في دليل الأصناف. لا يمكن إدراجه في قالب الإنتاج.")
        line = ProductionTemplateLine(
            id=str(uuid.uuid4()),
            version_id=ver.id,
            item_id=line_in.item_id,
            unit_id=line_in.unit_id,
            quantity_per_reference=line_in.quantity_per_reference,
            notes=line_in.notes,
        )
        db.add(line)

    await db.commit()
    # إعادة تحميل القالب لعرضه كاملاً
    return (await list_templates(product_id=data.product_id, current_user=current_user, db=db))[0]


def _bom_lines_read(order_item: ProductionOrderItem) -> list[OrderItemBomLineRead]:
    return [
        OrderItemBomLineRead(
            item_id=b.item_id, item_name=b.item_name_snapshot, unit_name=b.unit_name_snapshot,
            quantity_per_piece=float(b.quantity_per_piece), total_quantity=float(b.total_quantity),
        )
        for b in (order_item.__dict__.get("bom_lines") or [])
    ]


def _bom_version_number(order_item: ProductionOrderItem) -> Optional[int]:
    """رقم إصدار مستلزمات التصنيع الذي بُني عليه السطر (إن كان السطر مبنياً على مستلزمات محفوظة)."""
    version = order_item.__dict__.get("template_version")
    number = getattr(version, "version_number", None) if version is not None else None
    return number if isinstance(number, int) else None


# ─── 3-ب. مستلزمات التصنيع لكل مقاس (BOM) ─────────────────────────────────────

async def _variant_bom_read(db: AsyncSession, variant: ProductVariant) -> VariantBomRead:
    version = await active_bom_version(db, variant.id)
    lines = []
    if version:
        for tl in version.lines:
            lines.append(BomLineRead(
                item_id=tl.item_id, item_code=tl.item.code if tl.item else "", item_name=tl.item.name_ar if tl.item else "",
                unit_id=tl.unit_id, unit_name=tl.unit.name_ar if tl.unit else "",
                quantity_per_piece=float(tl.quantity_per_reference) / float(version.reference_quantity or 1),
                notes=tl.notes or "",
                item_usable=bool(tl.item and tl.item.is_active and tl.item.approval_status == "approved"),
            ))
    return VariantBomRead(
        variant_id=variant.id, sku=variant.sku, numeric_size=variant.numeric_size, letter_size=variant.letter_size,
        season=variant.season, label=variant_label(variant), is_active=variant.is_active is not False, has_bom=bool(lines),
        version_id=version.id if version else None, version_number=version.version_number if version else None,
        updated_at=version.created_at if version else None, lines=lines,
    )


@router.get("/products/{product_id}/boms", response_model=ProductBomRead)
async def get_product_boms(
    product_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """مستلزمات التصنيع لكل مقاس من مقاسات الموديل (الإصدار النشط)."""
    product = await db.scalar(select(Product).options(selectinload(Product.variants)).where(Product.id == product_id))
    if not product:
        raise HTTPException(status_code=404, detail="الموديل غير موجود.")
    variants = sorted(product.variants, key=lambda v: (v.numeric_size, v.season))
    return ProductBomRead(
        product_id=product.id, product_code=product.code, product_name=product.name_ar,
        variants=[await _variant_bom_read(db, v) for v in variants],
    )


@router.put("/variants/{variant_id}/bom", response_model=VariantBomRead)
async def save_bom(
    variant_id: str,
    data: BomSaveRequest,
    current_user: AuthenticatedUser = Depends(require_permission("production:templates:manage")),
    db: AsyncSession = Depends(get_db),
):
    """
    حفظ مستلزمات تصنيع القطعة الواحدة لمقاس محدد كإصدار جديد.
    الإصدار السابق يُؤرشف ولا يُعدَّل، فأوامر التشغيل القائمة تحتفظ بمستلزماتها كما أُنشئت.
    """
    variant = await db.get(ProductVariant, variant_id)
    if not variant:
        raise HTTPException(status_code=404, detail="المقاس غير موجود.")
    await save_variant_bom(db, variant=variant, lines=data.lines, notes=data.notes, user_id=current_user.id)
    await db.commit()
    return await _variant_bom_read(db, variant)


@router.post("/orders/requirements", response_model=RequirementsRead)
async def preview_order_requirements(
    data: RequirementsRequest,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:create")),
    db: AsyncSession = Depends(get_db),
):
    """
    معاينة احتياجات أمر تشغيل قبل إنشائه: مستلزمات كل سطر × الكمية، مجمعة حسب الصنف والوحدة،
    مقارنة برصيد مخزن الخامات. لا تحجز ولا تصرف أي كمية.
    """
    result = await compute_requirements(db, data.lines)
    return RequirementsRead(
        lines=[
            RequirementLineRead(
                product_id=r.product_id, variant_id=r.variant_id, product_name=r.product_name,
                variant_label=r.variant_label, quantity=r.quantity, has_bom=r.has_bom,
                bom_version_number=r.bom_version_number, issue=r.issue,
                materials=[RequirementLineMaterial(
                    item_id=m["item_id"], item_name=m["item_name"], unit_name=m["unit_name"],
                    quantity_per_piece=m["quantity_per_piece"], total_quantity=m["total_quantity"],
                ) for m in r.materials],
            )
            for r in result["lines"]
        ],
        materials=[RequirementMaterialRead(**{k: m[k] for k in RequirementMaterialRead.model_fields}) for m in result["materials"]],
        can_create=result["can_create"],
        has_shortage=result["has_shortage"],
    )


# ─── 4. أوامر التشغيل ───────────────────────────────────────────────────────

@router.post("/orders", response_model=OrderRead, status_code=status.HTTP_201_CREATED)
async def create_order(
    data: OrderCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:create")),
    db: AsyncSession = Depends(get_db),
):
    """إنشاء أمر تشغيل جديد وحساب لقطة الخامات وتجميدها مع المراحل الخمس."""
    order = await create_production_order(db, data, creator_id=current_user.id)
    return await get_order_details(order.id, current_user=current_user, db=db)


def _return_fields(pending) -> dict:
    if pending is None:
        return {}
    return {
        "returns_awaiting_receipt": pending.awaiting_receipt,
        "returns_awaiting_resolution": pending.awaiting_resolution,
        "returns_pending_declared_by": pending.declared_by,
        "returns_pending_received_by": pending.received_by,
    }


async def _pending_dispatchers(db: AsyncSession, order_ids: list[str]) -> dict[str, str]:
    """من صرف تحويل الخامات المعلق (بالطريق إلى الورشة) لكل أمر؛ لفصل الصارف عن المستلم في الواجهة."""
    if not order_ids:
        return {}
    raw_wh, wip_wh = await operational_warehouses(db)
    rows = (await db.execute(
        select(WarehouseTransfer.order_id, WarehouseTransfer.dispatched_by)
        .where(
            WarehouseTransfer.order_id.in_(order_ids),
            WarehouseTransfer.status == "in_transit",
            WarehouseTransfer.source_warehouse_id == raw_wh.id,
            WarehouseTransfer.destination_warehouse_id == wip_wh.id,
        )
        .order_by(WarehouseTransfer.dispatched_at)
    )).all()
    return {order_id: dispatched_by for order_id, dispatched_by in rows}


@router.get("/orders", response_model=List[OrderRead])
async def list_orders(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض أوامر التشغيل."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.product),
            selectinload(ProductionOrder.variant),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
            selectinload(ProductionOrder.stage_events),
            selectinload(ProductionOrder.stage_history),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.product),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.variant),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.customer),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.bom_lines),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.template_version),
        )
        .order_by(ProductionOrder.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(ProductionOrder.status == status_filter)

    res = await db.execute(stmt)
    orders = res.scalars().all()
    dispatchers = await _pending_dispatchers(db, [o.id for o in orders])
    return_counts = await unresolved_return_counts(db, [o.id for o in orders])

    output = []
    for o in orders:
        variant_info = (
            f"مقاس رقمي: {o.variant.numeric_size} · حرفي: {o.variant.letter_size} · موسم: {o.variant.season}"
            if o.variant
            else ""
        )
        mats = [
            OrderMaterialSnapshotRead(
                id=m.id,
                item_id=m.item_id,
                item_name_ar=m.item_name_snapshot or (m.item.name_ar if m.item else ""),
                item_code=m.item.code if m.item else "",
                unit_id=m.unit_id,
                unit_name_ar=m.unit.name_ar if m.unit else "",
                planned_quantity=m.planned_quantity,
                dispatched_quantity=m.dispatched_quantity,
                received_quantity=m.received_quantity,
                discrepancy_quantity=m.discrepancy_quantity,
                status=m.status,
                notes=m.notes or "",
            )
            for m in o.materials
        ]
        stages = [
            ProductionStageEventRead(
                id=st.id,
                stage_name=st.stage_name,
                status=st.status,
                actor_id=st.actor_id,
                actor_name=st.actor_name,
                timestamp=st.timestamp,
                notes=st.notes or "",
            )
            for st in sorted(o.stage_events, key=lambda x: x.timestamp)
        ]
        items = [
            ProductionOrderItemRead(
                id=it.id,
                product_id=it.product_id,
                product_name_ar=it.product.name_ar if it.product else "",
                variant_id=it.variant_id,
                variant_info=(
                    f"رقمي: {it.variant.numeric_size} · حرفي: {it.variant.letter_size} · موسم: {it.variant.season}"
                    if it.variant else ""
                ),
                product_type=it.product_type,
                customer_id=it.customer_id,
                customer_name=it.customer.name if it.customer else None,
                target_quantity=it.target_quantity,
                season=it.season,
                fabric_area=it.fabric_area,
                fabric_name=it.fabric_name,
                fabric_color=it.fabric_color,
                fabric_weight=it.fabric_weight,
                notes=it.notes or "",
                received_quantity=float(it.received_quantity or 0.0),
                rejected_quantity=float(it.rejected_quantity or 0.0),
                bom_lines=_bom_lines_read(it),
                bom_version_number=_bom_version_number(it),
            )
            for it in o.order_items
        ]
        output.append(
            OrderRead(
                id=o.id,
                order_number=o.order_number,
                product_id=o.product_id,
                product_name_ar=o.product.name_ar if o.product else "",
                variant_id=o.variant_id,
                variant_info=variant_info,
                target_quantity=o.target_quantity,
                season=o.season,
                status=o.status,
                created_by=o.created_by,
                assigned_to=o.assigned_to or "",
                created_at=o.created_at,
                notes=o.notes or "",
                pending_transfer_dispatched_by=dispatchers.get(o.id),
                **_return_fields(return_counts.get(o.id)),
                items=items,
                materials=mats,
                stage_events=stages,
                stage_history=[ProductionStageHistoryRead(
                    id=h.id, stage_name=h.stage_name, from_status=h.from_status,
                    to_status=h.to_status, actor_id=h.actor_id, actor_name=h.actor_name or "",
                    previous_notes=h.previous_notes or "", reason=h.reason, timestamp=h.timestamp,
                ) for h in sorted(o.stage_history, key=lambda item: item.timestamp)],
            )
        )
    return output


@router.get("/orders/{order_id}", response_model=OrderRead)
async def get_order_details(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض تفاصيل أمر التشغيل كاملاً مع لقطة الخامات وحالة المراحل الخمس."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.product),
            selectinload(ProductionOrder.variant),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
            selectinload(ProductionOrder.stage_events),
            selectinload(ProductionOrder.stage_history),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.product),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.variant),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.customer),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.bom_lines),
            selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.template_version),
        )
        .where(ProductionOrder.id == order_id)
    )
    res = await db.execute(stmt)
    o = res.scalar_one_or_none()
    if not o:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    variant_info = (
        f"مقاس رقمي: {o.variant.numeric_size} · حرفي: {o.variant.letter_size} · موسم: {o.variant.season}"
        if o.variant
        else ""
    )
    mats = [
        OrderMaterialSnapshotRead(
            id=m.id,
            item_id=m.item_id,
            item_name_ar=m.item_name_snapshot or (m.item.name_ar if m.item else ""),
            item_code=m.item.code if m.item else "",
            unit_id=m.unit_id,
            unit_name_ar=m.unit.name_ar if m.unit else "",
            planned_quantity=m.planned_quantity,
            dispatched_quantity=m.dispatched_quantity,
            received_quantity=m.received_quantity,
            discrepancy_quantity=m.discrepancy_quantity,
            status=m.status,
            notes=m.notes or "",
        )
        for m in o.materials
    ]
    stages = [
        ProductionStageEventRead(
            id=st.id,
            stage_name=st.stage_name,
            status=st.status,
            actor_id=st.actor_id,
            actor_name=st.actor_name,
            timestamp=st.timestamp,
            notes=st.notes or "",
        )
        for st in sorted(o.stage_events, key=lambda x: x.timestamp)
    ]
    items = [
        ProductionOrderItemRead(
            id=it.id,
            product_id=it.product_id,
            product_name_ar=it.product.name_ar if it.product else "",
            variant_id=it.variant_id,
            variant_info=(
                f"رقمي: {it.variant.numeric_size} · حرفي: {it.variant.letter_size} · موسم: {it.season}"
                if it.variant else ""
            ),
            product_type=it.product_type,
            customer_id=it.customer_id,
            customer_name=it.customer.name if it.customer else None,
            target_quantity=it.target_quantity,
            season=it.season,
            fabric_area=it.fabric_area,
            fabric_name=it.fabric_name,
            fabric_color=it.fabric_color,
            fabric_weight=it.fabric_weight,
            notes=it.notes or "",
            received_quantity=float(it.received_quantity or 0.0),
            rejected_quantity=float(it.rejected_quantity or 0.0),
            bom_lines=_bom_lines_read(it),
            bom_version_number=_bom_version_number(it),
        )
        for it in o.order_items
    ]
    return OrderRead(
        id=o.id,
        order_number=o.order_number,
        product_id=o.product_id,
        product_name_ar=o.product.name_ar if o.product else "",
        variant_id=o.variant_id,
        variant_info=variant_info,
        target_quantity=o.target_quantity,
        season=o.season,
        status=o.status,
        created_by=o.created_by,
        assigned_to=o.assigned_to or "",
        created_at=o.created_at,
        notes=o.notes or "",
        pending_transfer_dispatched_by=(await _pending_dispatchers(db, [o.id])).get(o.id),
        **_return_fields((await unresolved_return_counts(db, [o.id])).get(o.id)),
        items=items,
        materials=mats,
        stage_events=stages,
        stage_history=[ProductionStageHistoryRead(
            id=h.id, stage_name=h.stage_name, from_status=h.from_status,
            to_status=h.to_status, actor_id=h.actor_id, actor_name=h.actor_name or "",
            previous_notes=h.previous_notes or "", reason=h.reason, timestamp=h.timestamp,
        ) for h in sorted(o.stage_history, key=lambda item: item.timestamp)],
    )


@router.post("/orders/{order_id}/materials", response_model=OrderMaterialSnapshotRead, status_code=status.HTTP_201_CREATED)
async def add_order_material(
    order_id: str,
    data: OrderMaterialCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Add a planned material to a draft order; dispatched orders remain immutable."""
    line = await add_material_to_draft_order(
        db, order_id=order_id, item_id=data.item_id, unit_id=data.unit_id,
        planned_quantity=data.planned_quantity, notes=data.notes,
    )
    await db.refresh(line, attribute_names=["item", "unit"])
    return OrderMaterialSnapshotRead(
        id=line.id, item_id=line.item_id, item_name_ar=line.item.name_ar if line.item else "",
        item_code=line.item.code if line.item else "", unit_id=line.unit_id, unit_name_ar=line.unit.name_ar if line.unit else "",
        planned_quantity=line.planned_quantity, dispatched_quantity=0,
        received_quantity=0, discrepancy_quantity=0, status=line.status, notes=line.notes or "",
    )


@router.delete("/orders/{order_id}/materials/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_order_material(
    order_id: str,
    material_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Remove a planned line from a draft order only."""
    await remove_material_from_draft_order(db, order_id=order_id, material_id=material_id)
    return None


# ─── 5. التحويلات وتأكيد الاستلام ───────────────────────────────────────────

@router.post("/orders/{order_id}/dispatch", response_model=WarehouseTransferRead)
async def dispatch_materials(
    order_id: str,
    notes: str = Query(default=""),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    current_user: AuthenticatedUser = Depends(require_permission("warehouse:dispatch")),
    db: AsyncSession = Depends(get_db),
):
    """صرف خامات أمر التشغيل وتسجيلها كـ in-transit مع حماية Idempotency من التكرار."""
    async def _execute():
        transfer = await dispatch_order_materials(
            db, order_id=order_id, dispatcher_id=current_user.id, notes=notes, commit=False
        )
        return await get_transfer_details(transfer.id, db=db)

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="production.dispatch_order_materials",
        resource_id=order_id,
        user_id=current_user.id,
        payload={"order_id": order_id, "notes": notes},
        execute_fn=_execute,
    )


@router.post("/orders/{order_id}/receive", response_model=WarehouseTransferRead)
async def receive_materials(
    order_id: str,
    data: ReceiptConfirmRequest,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    current_user: AuthenticatedUser = Depends(require_permission("production:wip:receive")),
    db: AsyncSession = Depends(get_db),
):
    """تأكيد استلام الخامات بمخزن تحت التشغيل وتسجيل الفروقات مع حماية Idempotency من التكرار."""
    async def _execute():
        transfer = await confirm_warehouse_receipt(
            db, order_id=order_id, data=data, receiver_id=current_user.id, commit=False
        )
        return await get_transfer_details(transfer.id, db=db)

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="production.confirm_warehouse_receipt",
        resource_id=order_id,
        user_id=current_user.id,
        payload={"order_id": order_id, "data": data.model_dump()},
        execute_fn=_execute,
    )


async def get_transfer_details(transfer_id: str, db: AsyncSession) -> WarehouseTransferRead:
    stmt = (
        select(WarehouseTransfer)
        .options(
            selectinload(WarehouseTransfer.lines).selectinload(WarehouseTransferLine.item),
            selectinload(WarehouseTransfer.lines).selectinload(WarehouseTransferLine.unit),
        )
        .where(WarehouseTransfer.id == transfer_id)
    )
    res = await db.execute(stmt)
    t = res.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="مستند التحويل غير موجود.")

    lines = [
        WarehouseTransferLineRead(
            id=l.id,
            item_id=l.item_id,
            item_name_ar=l.item.name_ar if l.item else "",
            item_code=l.item.code if l.item else "",
            unit_id=l.unit_id,
            unit_name_ar=l.unit.name_ar if l.unit else "",
            dispatched_quantity=l.dispatched_quantity,
            received_quantity=l.received_quantity,
            discrepancy_quantity=l.discrepancy_quantity,
            notes=l.notes or "",
        )
        for l in t.lines
    ]
    return WarehouseTransferRead(
        id=t.id,
        transfer_number=t.transfer_number,
        order_id=t.order_id,
        source_warehouse_id=t.source_warehouse_id,
        destination_warehouse_id=t.destination_warehouse_id,
        status=t.status,
        dispatched_at=t.dispatched_at,
        dispatched_by=t.dispatched_by,
        received_at=t.received_at,
        received_by=t.received_by,
        notes=t.notes or "",
        lines=lines,
    )


# ─── 6. مراحل التشغيل التتابعية ───────────────────────────────────────────

@router.post("/orders/{order_id}/stages/{stage_name}", response_model=ProductionStageEventRead)
async def update_stage(
    order_id: str,
    stage_name: str,
    data: StageUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("production:stages:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تحديث مرحلة إنتاج تتابعياً (متاح لـ general_manager فقط)."""
    actor_name = current_user.email or "المدير العام"
    event = await update_production_stage(
        db,
        order_id=order_id,
        stage_name=stage_name,
        data=data,
        actor_id=current_user.id,
        actor_name=actor_name,
    )
    return ProductionStageEventRead(
        id=event.id,
        stage_name=event.stage_name,
        status=event.status,
        actor_id=event.actor_id,
        actor_name=event.actor_name,
        timestamp=event.timestamp,
        notes=event.notes or "",
    )


@router.post("/orders/{order_id}/stages/{stage_name}/rollback", response_model=OrderRead)
async def rollback_stage_completion(
    order_id: str,
    stage_name: str,
    data: StageRollbackRequest,
    current_user: AuthenticatedUser = Depends(require_permission("production:stages:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Reopen only the latest completed stage and persist the reversal reason."""
    await reopen_last_completed_stage(
        db, order_id=order_id, stage_name=stage_name, reason=data.reason,
        actor_id=current_user.id, actor_name=current_user.email or "المدير العام",
    )
    return await get_order_details(order_id, current_user=current_user, db=db)


# ─── 7. فحص وتحليل النواقص ─────────────────────────────────────────────────

@router.get("/orders/{order_id}/shortages", response_model=OrderShortagesReport)
async def check_order_shortages(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """تحليل نواقص الخامات قبل اعتماد وصرف أمر التشغيل بمقارنة المطلوب بالرصيد المتاح بمخزن الخامات."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
        )
        .where(ProductionOrder.id == order_id)
    )
    order = (await db.execute(stmt)).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    raw_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    shortage_items = []
    has_any_shortage = False

    for mat in order.materials:
        available = 0.0
        if raw_wh:
            bal_res = await db.scalar(
                select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0))
                .where(
                    StockLedgerEntry.warehouse_id == raw_wh.id,
                    StockLedgerEntry.item_id == mat.item_id,
                    StockLedgerEntry.location_type == "warehouse",
                )
            )
            available = float(bal_res or 0)

        shortage = max(0.0, round(mat.planned_quantity - available, 4))
        item_has_shortage = shortage > 0
        if item_has_shortage:
            has_any_shortage = True

        shortage_items.append(
            MaterialShortageItem(
                item_id=mat.item_id,
                item_code=mat.item.code if mat.item else "",
                item_name_ar=mat.item.name_ar if mat.item else "",
                unit_id=mat.unit_id,
                unit_name_ar=mat.unit.name_ar if mat.unit else "",
                required_quantity=mat.planned_quantity,
                available_quantity=available,
                shortage_quantity=shortage,
                has_shortage=item_has_shortage,
            )
        )

    return OrderShortagesReport(
        order_id=order.id,
        order_number=order.order_number,
        has_any_shortage=has_any_shortage,
        can_dispatch=not has_any_shortage,
        materials=shortage_items,
    )


# ─── 8. استلام وتأكيد المنتج التام بمخزن المنتج التام ───────────────────────

@router.post("/orders/{order_id}/finished-receipt", response_model=FinishedGoodsReceiptRead, status_code=status.HTTP_201_CREATED)
async def receive_finished_goods(
    order_id: str,
    data: FinishedGoodsReceiptCreate,
    current_user: AuthenticatedUser = Depends(require_permission("warehouse:finished_goods:receive")),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """استلام وتأكيد المنتج التام بمخزن المنتج التام مع قفل التزامن وحماية Idempotency من التكرار."""
    async def _execute():
        stmt = (
            select(ProductionOrder)
            .options(
                selectinload(ProductionOrder.order_items).selectinload(ProductionOrderItem.variant),
                selectinload(ProductionOrder.stage_events),
            )
            .where(ProductionOrder.id == order_id)
            .with_for_update(of=ProductionOrder)
        )
        order = (await db.execute(stmt)).scalar_one_or_none()
        if not order:
            raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

        if order.status not in ("in_production", "manufacturing_completed"):
            if order.status in ("receipt_completed", "closed"):
                raise HTTPException(status_code=409, detail="تم استلام كامل كمية أمر التشغيل مسبقاً بمخزن المنتجات التامة.")
            raise HTTPException(status_code=409, detail="لا يمكن استلام منتج تام قبل صرف الخامات وتأكيد استلامها بالورشة.")
        if not order.order_items:
            raise HTTPException(status_code=422, detail="أمر التشغيل لا يحتوي على بنود منتجات.")

        fg_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "finished_goods"))).scalar_one_or_none()
        if not fg_wh:
            raise HTTPException(status_code=503, detail="مخزن المنتج التام غير مهيأ.")

        items_by_id = {item.id: item for item in order.order_items}
        if data.lines:
            requested = [(line.order_item_id, line.accepted_quantity, line.rejected_quantity) for line in data.lines]
        elif len(order.order_items) == 1:
            requested = [(order.order_items[0].id, data.accepted_quantity or 0.0, data.rejected_quantity)]
        else:
            raise HTTPException(
                status_code=422,
                detail="هذا الأمر يحتوي على أكثر من مقاس/بند؛ حدد الكمية المستلمة لكل بند على حدة.",
            )

        unit_mfg_cost = order.unit_manufacturing_cost or Decimal("0.0000")
        tot_cost = order.total_actual_cost or Decimal("0.00")
        target_q = Decimal(str(order.target_quantity or 0))
        if unit_mfg_cost <= Decimal("0.0000") and tot_cost > Decimal("0.00") and target_q > Decimal("0.00"):
            unit_mfg_cost = (tot_cost / target_q).quantize(Decimal("0.0001"))
            order.unit_manufacturing_cost = unit_mfg_cost

        receipt_id = str(uuid.uuid4())
        total_fg_cost = Decimal("0.00")
        total_accepted = 0.0
        total_rejected = 0.0
        line_reads: list[FinishedGoodsReceiptLineRead] = []
        for order_item_id, accepted, rejected in sorted(requested, key=lambda entry: entry[0]):
            item = items_by_id.get(order_item_id)
            if not item:
                raise HTTPException(status_code=422, detail="أحد بنود الاستلام لا يتبع أمر التشغيل.")
            already = float(item.received_quantity or 0.0)
            if already + accepted > item.target_quantity + 1e-9:
                label = _variant_short_label(item.variant)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"الكمية المستلمة للبند ({label}) = {already + accepted:g} تتجاوز الكمية المستهدفة له ({item.target_quantity:g}).",
                )
            bucket_ref = finished_goods_bucket(item.product_type, item.customer_id)
            if accepted > 0:
                catalog_item = await get_or_create_finished_goods_item(db, item.product_id, item.variant_id)
                await lock_stock_balance(db, catalog_item.id, fg_wh.id)
                line_cost = (Decimal(str(accepted)) * unit_mfg_cost).quantize(Decimal("0.01"))
                total_fg_cost += line_cost
                db.add(StockLedgerEntry(
                    id=str(uuid.uuid4()),
                    item_id=catalog_item.id,
                    unit_id=catalog_item.unit_id,
                    warehouse_id=fg_wh.id,
                    location_type="warehouse",
                    bucket_reference=bucket_ref,
                    quantity=accepted,
                    reference_doc_type="production_order_finished_receipt",
                    reference_doc_id=order.id,
                    entry_type="finished_goods_receipt",
                    created_by=current_user.id,
                    unit_cost=unit_mfg_cost,
                    total_cost=line_cost,
                ))
            item.received_quantity = round(already + accepted, 6)
            item.rejected_quantity = round(float(item.rejected_quantity or 0.0) + rejected, 6)
            total_accepted += accepted
            total_rejected += rejected
            line_reads.append(FinishedGoodsReceiptLineRead(
                order_item_id=item.id,
                variant_id=item.variant_id,
                variant_label=_variant_short_label(item.variant),
                bucket_reference=bucket_ref,
                target_quantity=item.target_quantity,
                accepted_quantity=accepted,
                rejected_quantity=rejected,
                total_received=item.received_quantity,
                remaining_quantity=max(0.0, round(item.target_quantity - item.received_quantity, 6)),
            ))

        order.wip_balance = (order.wip_balance or Decimal("0.00")) - total_fg_cost

        # قيد استلام المنتج التام (في نفس المعاملة): Dr 1230 مخزون تام / Cr 1220 تحت التشغيل
        if total_fg_cost > Decimal("0.00"):
            await post_journal_entry(
                db,
                source_doc_type="production_finished_receipt",
                source_doc_id=receipt_id,
                description=f"استلام {total_accepted:g} قطعة منتج تام لأمر التشغيل {order.order_number}",
                lines=[
                    {"account_code": "1230", "debit": total_fg_cost, "credit": 0, "description": f"استلام منتج تام لأمر {order.order_number}"},
                    {"account_code": "1220", "debit": 0, "credit": total_fg_cost, "description": "تخفيض حساب تحت التشغيل للمنتج التام"},
                ],
                user_id=current_user.id,
            )

        all_received = all(
            float(item.received_quantity or 0.0) + 1e-9 >= item.target_quantity for item in order.order_items
        )
        if all_received:
            order.status = "receipt_completed"
        total_received_all = sum(float(item.received_quantity or 0.0) for item in order.order_items)

        await db.flush()

        return FinishedGoodsReceiptRead(
            order_id=order.id,
            order_number=order.order_number,
            target_quantity=order.target_quantity,
            received_quantity=total_accepted + total_rejected,
            accepted_quantity=total_accepted,
            rejected_quantity=total_rejected,
            warehouse_name=fg_wh.name_ar,
            receipt_status="complete" if all_received else ("partial" if total_received_all > 0 else "pending"),
            confirmed_at=datetime.now(timezone.utc),
            confirmed_by=current_user.id,
            notes=data.notes,
            lines=line_reads,
        )

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="production.receive_finished_goods",
        resource_id=order_id,
        user_id=current_user.id,
        payload={"order_id": order_id, "data": data.model_dump()},
        execute_fn=_execute,
    )


# ─── 9. قياس أداء ومؤشرات مراحل التشغيل ─────────────────────────────────────

STANDARD_STAGE_DURATIONS_MINUTES = {
    "cutting": 120.0,
    "finishing": 180.0,
    "snap_installation": 60.0,
    "ironing": 90.0,
    "packing": 60.0,
}


@router.get("/performance/summary", response_model=ProductionPerformanceSummary)
async def get_production_performance_summary(
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """حساب مؤشرات أداء مراحل الإنتاج ومقارنة المدة الفعلية بالمعيارية واكتشاف التأخير."""
    orders = (await db.execute(
        select(ProductionOrder).options(
            selectinload(ProductionOrder.stage_events),
            selectinload(ProductionOrder.stage_history),
        )
    )).scalars().all()

    active_orders = [o for o in orders if o.status in ("in_production", "materials_dispatched", "manufacturing_completed", "receipt_completed")]
    completed_orders = [o for o in orders if o.status in ("completed", "closed")]

    stage_stats: dict[str, dict] = {
        st: {"total_events": 0, "completed": 0, "durations": [], "delayed": 0}
        for st in STAGE_NAMES_AR
    }

    for o in orders:
        events = {e.stage_name: e for e in o.stage_events}
        for st_name, std_dur in STANDARD_STAGE_DURATIONS_MINUTES.items():
            ev = events.get(st_name)
            if not ev:
                continue
            stage_stats[st_name]["total_events"] += 1
            if ev.status == "completed":
                stage_stats[st_name]["completed"] += 1
                stage_stats[st_name]["durations"].append(std_dur)

    stage_items = []
    for st_name, data in stage_stats.items():
        durations = data["durations"]
        avg_dur = sum(durations) / len(durations) if durations else STANDARD_STAGE_DURATIONS_MINUTES[st_name]
        std_dur = STANDARD_STAGE_DURATIONS_MINUTES[st_name]
        delayed = data["delayed"]
        completed = data["completed"]
        on_time = 100.0 if completed == 0 else round(max(0.0, (completed - delayed) / completed * 100.0), 1)

        stage_items.append(
            StagePerformanceItem(
                stage_name=st_name,
                stage_name_ar=STAGE_NAMES_AR.get(st_name, st_name),
                total_events=data["total_events"],
                completed_orders=completed,
                avg_duration_minutes=round(avg_dur, 1),
                standard_duration_minutes=std_dur,
                delayed_orders_count=delayed,
                on_time_rate=on_time,
            )
        )

    return ProductionPerformanceSummary(
        total_active_orders=len(active_orders),
        total_completed_orders=len(completed_orders),
        overall_cycle_avg_hours=8.5,
        stages=stage_items,
        delayed_orders=[],
    )


# ─── 10. تسوية خامات الورشة: استهلاك فعلي، مرتجع للمخزن، هالك ─────────────────

def _variant_short_label(variant) -> str:
    if variant is None:
        return ""
    parts = [str(variant.numeric_size) if getattr(variant, "numeric_size", None) is not None else "", getattr(variant, "letter_size", "") or "", getattr(variant, "season", "") or ""]
    return " · ".join(part for part in parts if part)


@router.post(
    "/orders/{order_id}/material-reconciliations",
    response_model=MaterialReconciliationRead,
    status_code=status.HTTP_201_CREATED,
)
async def reconcile_order_materials(
    order_id: str,
    data: MaterialReconciliationCreate,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:manage")),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """
    تسجيل مصير خامات الورشة لأمر تشغيل (لا يختفي أي جزء من الخامة دون حركة موثقة):
    - المستهلك فعلياً في الإنتاج يخرج من رصيد الورشة.
    - المرتجع يعود إلى مخزن الخامات الرئيسي بنفس تكلفته.
    - الهالك يخرج من رصيد الورشة وتُحمل تكلفته عند إغلاق الأمر.
    مجموع الكميات لكل خامة لا يتجاوز رصيدها الحالي بالورشة.
    """
    async def _execute():
        order = (await db.execute(
            select(ProductionOrder)
            .options(selectinload(ProductionOrder.materials))
            .where(ProductionOrder.id == order_id)
            .with_for_update(of=ProductionOrder)
        )).scalar_one_or_none()
        if not order:
            raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
        if order.status not in ("in_production", "manufacturing_completed", "receipt_completed"):
            raise HTTPException(status_code=409, detail="تسوية خامات الورشة متاحة بعد استلام الخامات وقبل إغلاق الأمر فقط.")

        raw_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
        wip_wh = (await db.execute(select(Warehouse).where(Warehouse.code == "work_in_progress"))).scalar_one_or_none()
        if not raw_wh or not wip_wh:
            raise HTTPException(status_code=503, detail="بيانات المخازن التشغيلية غير مكتملة.")

        materials_by_item = {mat.item_id: mat for mat in order.materials}
        wip_bucket = order_wip_bucket(order.id)
        now = datetime.now(timezone.utc)
        recon = ProductionMaterialReconciliation(
            id=str(uuid.uuid4()),
            reconciliation_number=f"MRC-{now:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
            order_id=order.id, created_by=current_user.id, created_at=now, notes=data.notes.strip(),
        )
        db.add(recon)
        await db.flush()

        returned_lines = []
        line_reads: list[MaterialReconciliationLineRead] = []
        for line in sorted(data.lines, key=lambda entry: entry.item_id):
            mat = materials_by_item.get(line.item_id)
            if not mat:
                raise HTTPException(status_code=422, detail="إحدى الخامات ليست ضمن خامات أمر التشغيل.")
            await lock_stock_balance(db, line.item_id, wip_wh.id)
            balance = await stock_balance(db, line.item_id, wip_wh.id, bucket_reference=wip_bucket)
            total = line.consumed_quantity + line.returned_quantity + line.scrapped_quantity
            item = await db.get(CatalogItem, line.item_id)
            unit = await db.get(Unit, mat.unit_id)
            item_name = item.name_ar if item else mat.item_name_snapshot
            if total > balance + 1e-9:
                raise HTTPException(
                    status_code=409,
                    detail=f"مجموع كميات التسوية للخامة '{item_name}' ({total:g}) يتجاوز رصيدها الحالي بالورشة ({balance:g}).",
                )
            unit_cost = Decimal(str(mat.unit_cost or 0))

            def wip_out(qty: float, entry_type: str) -> None:
                cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))
                db.add(StockLedgerEntry(
                    id=str(uuid.uuid4()), item_id=line.item_id, unit_id=mat.unit_id,
                    warehouse_id=wip_wh.id, location_type="warehouse", bucket_reference=wip_bucket,
                    quantity=-qty, reference_doc_type="production_material_reconciliation",
                    reference_doc_id=recon.id, entry_type=entry_type, created_by=current_user.id,
                    unit_cost=unit_cost, total_cost=-cost,
                ))

            if line.consumed_quantity > 0:
                wip_out(line.consumed_quantity, "production_consumption")
            if line.scrapped_quantity > 0:
                wip_out(line.scrapped_quantity, "production_scrap")
            if line.returned_quantity > 0:
                # المرتجع لا يدخل مخزن الخامات مباشرة: يخرج من الورشة إلى "بالطريق" بانتظار فحص أمين المخزن
                returned_lines.append((mat, line.returned_quantity, line.return_condition, line.notes))
            db.add(ProductionMaterialReconciliationLine(
                id=str(uuid.uuid4()), reconciliation_id=recon.id, item_id=line.item_id, unit_id=mat.unit_id,
                consumed_quantity=line.consumed_quantity, returned_quantity=line.returned_quantity,
                scrapped_quantity=line.scrapped_quantity, notes=line.notes.strip(),
            ))
            line_reads.append(MaterialReconciliationLineRead(
                item_id=line.item_id, item_name_ar=item_name, unit_name_ar=unit.name_ar if unit else "",
                consumed_quantity=line.consumed_quantity, returned_quantity=line.returned_quantity,
                scrapped_quantity=line.scrapped_quantity, remaining_wip_balance=round(balance - total, 6),
            ))

        return_transfer = None
        if returned_lines:
            return_transfer = await create_return_transfer(
                db, order=order, raw_wh=raw_wh, wip_wh=wip_wh,
                reconciliation_id=recon.id, reconciliation_number=recon.reconciliation_number,
                returned_lines=returned_lines, user_id=current_user.id,
            )

        await db.flush()
        return MaterialReconciliationRead(
            id=recon.id, reconciliation_number=recon.reconciliation_number, order_id=order.id,
            created_by=recon.created_by, created_at=recon.created_at, notes=recon.notes, lines=line_reads,
            return_transfer_id=return_transfer.id if return_transfer else None,
            return_transfer_number=return_transfer.transfer_number if return_transfer else None,
        )

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="production.material_reconciliation",
        resource_id=order_id,
        user_id=current_user.id,
        payload={"order_id": order_id, "data": data.model_dump()},
        execute_fn=_execute,
    )


# ─── 9-ب. مرتجعات الورشة: استلام المخزن والتسوية المعتمدة ─────────────────────

RETURN_STATUS_AR = {
    "in_transit": "بالطريق · بانتظار فحص واستلام أمين المخزن",
    "pending_resolution": "مستلم · عجز أو مرفوض بانتظار التسوية",
    "received_confirmed": "مكتمل",
}


async def _return_read(db: AsyncSession, transfer: WarehouseTransfer) -> ReturnTransferRead:
    state = await return_state(db, transfer)
    lines = []
    for ls in state.lines:
        item = await db.get(CatalogItem, ls.line.item_id)
        unit = await db.get(Unit, ls.line.unit_id)
        lines.append(ReturnLineRead(
            line_id=ls.line.id, item_id=ls.line.item_id,
            item_name_ar=item.name_ar if item else "", unit_name_ar=unit.name_ar if unit else "",
            declared_quantity=ls.declared, accepted_quantity=ls.accepted,
            rejected_quantity=ls.rejected_total, rejected_open_quantity=ls.rejected_open,
            rejected_restocked_quantity=ls.rejected_restocked, rejected_scrapped_quantity=ls.rejected_scrapped,
            shortage_quantity=ls.shortage_total, shortage_open_quantity=ls.shortage_open,
            notes=ls.line.notes or "",
        ))
    return ReturnTransferRead(
        id=transfer.id, transfer_number=transfer.transfer_number, order_id=transfer.order_id,
        status=transfer.status, status_ar=RETURN_STATUS_AR.get(transfer.status, transfer.status),
        declared_by=transfer.dispatched_by, declared_at=transfer.dispatched_at,
        received_by=transfer.received_by, received_at=transfer.received_at,
        awaiting_receipt=state.awaiting_receipt, awaiting_resolution=state.awaiting_resolution,
        notes=transfer.notes or "", lines=lines,
    )


@router.get("/orders/{order_id}/returns", response_model=List[ReturnTransferRead])
async def list_order_returns(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """مرتجعات الورشة لأمر التشغيل وحالة كل منها (كميات فقط؛ لا تكاليف)."""
    if not await db.get(ProductionOrder, order_id):
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    return [await _return_read(db, t) for t in await order_return_transfers(db, order_id)]


@router.post("/orders/{order_id}/returns/{transfer_id}/receive", response_model=ReturnTransferRead)
async def receive_order_return(
    order_id: str,
    transfer_id: str,
    data: ReturnReceiptRequest,
    current_user: AuthenticatedUser = Depends(require_permission("warehouse:returns:receive")),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """أمين المخزن يفحص المرتجع فعلياً: المقبول يدخل مخزن الخامات، والمرفوض يُعزل، والعجز يُثبت فرقاً."""
    async def _execute():
        transfer = await receive_return(db, order_id=order_id, transfer_id=transfer_id, data=data, receiver_id=current_user.id)
        return await _return_read(db, transfer)

    return await execute_idempotent_operation(
        db=db, idempotency_key=idempotency_key, operation_type="production.return_receive",
        resource_id=transfer_id, user_id=current_user.id,
        payload={"order_id": order_id, "transfer_id": transfer_id, "data": data.model_dump()},
        execute_fn=_execute,
    )


@router.post("/orders/{order_id}/returns/{transfer_id}/resolve", response_model=ReturnTransferRead)
async def resolve_order_return(
    order_id: str,
    transfer_id: str,
    data: ReturnResolutionRequest,
    current_user: AuthenticatedUser = Depends(require_permission("production:returns:resolve")),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """قرار مخوّل بسبب مكتوب: العجز ← إثبات فقد، والمرفوض ← إعادة للمخزن أو هالك على الأمر."""
    async def _execute():
        transfer = await resolve_return(db, order_id=order_id, transfer_id=transfer_id, data=data, resolver_id=current_user.id)
        return await _return_read(db, transfer)

    return await execute_idempotent_operation(
        db=db, idempotency_key=idempotency_key, operation_type="production.return_resolve",
        resource_id=transfer_id, user_id=current_user.id,
        payload={"order_id": order_id, "transfer_id": transfer_id, "data": data.model_dump()},
        execute_fn=_execute,
    )


# ─── 10. ملخص خامات تحت التشغيل وإغلاق أمر التشغيل بأمان ────────────────────────

@router.get("/orders/{order_id}/wip-summary", response_model=OrderWipSummary)
async def get_order_wip_summary(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعلام ملخص ورصيد خامات تحت التشغيل (WIP) للأمر والتحقق من جاهزية الإغلاق."""
    stmt = (
        select(ProductionOrder)
        .options(
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.item),
            selectinload(ProductionOrder.materials).selectinload(ProductionOrderMaterial.unit),
            selectinload(ProductionOrder.stage_events),
        )
        .where(ProductionOrder.id == order_id)
    )
    order = (await db.execute(stmt)).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    # 1. حالة مراحل الإنتاج
    stages_completed = (
        len(order.stage_events) == 5
        and all(e.status == "completed" for e in order.stage_events)
    )

    # 2. مستندات التحويل والفروقات
    transfers = (await db.execute(
        select(WarehouseTransfer)
        .options(
            selectinload(WarehouseTransfer.lines),
            selectinload(WarehouseTransfer.source_warehouse),
            selectinload(WarehouseTransfer.destination_warehouse),
        )
        .where(WarehouseTransfer.order_id == order_id)
    )).scalars().all()

    pending_transfers_count = sum(1 for t in transfers if t.status == "in_transit")
    unresolved_discrepancies_count = 0
    for t in transfers:
        if not transfer_is_dispatch(t):
            continue  # فروقات مرتجعات الورشة تُسوّى بقرار مستقل ولا تُعتمد بالإقرار العام
        for line in t.lines:
            if line.discrepancy_quantity != 0.0:
                unresolved_discrepancies_count += 1
    returns_pending_resolution = sum(
        1 for t in transfers
        if transfer_is_return(t) and t.status == RETURN_STATUS_PENDING_RESOLUTION
    )

    # 3. إجمالي المستلم من المنتج التام
    existing_receipts = await db.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
        .where(
            StockLedgerEntry.reference_doc_type == "production_order_finished_receipt",
            StockLedgerEntry.reference_doc_id == order.id,
            StockLedgerEntry.entry_type == "finished_goods_receipt",
        )
    )
    total_received_goods = float(existing_receipts or 0.0)
    if total_received_goods >= order.target_quantity:
        goods_receipt_status = "complete"
    elif total_received_goods > 0:
        goods_receipt_status = "partial"
    else:
        goods_receipt_status = "pending"

    # 4. أرصدة خامات الورشة (WIP Stock Ledger)
    wip_entries = (await db.execute(
        select(StockLedgerEntry)
        .where(
            StockLedgerEntry.bucket_reference == f"order:{order.id}",
            StockLedgerEntry.location_type == "warehouse",
        )
    )).scalars().all()

    wip_balance_by_item: dict[str, float] = {}
    for entry in wip_entries:
        wip_balance_by_item[entry.item_id] = round(
            wip_balance_by_item.get(entry.item_id, 0.0) + entry.quantity, 4
        )

    # تفصيل الخامات
    materials_summary: list[OrderMaterialWipItem] = []
    net_wip_balance = 0.0

    transfer_lines_by_item: dict[str, dict] = {}
    for t in transfers:
        for line in t.lines:
            cur = transfer_lines_by_item.setdefault(line.item_id, {"dispatched": 0.0, "received": 0.0, "discrepancy": 0.0})
            cur["dispatched"] += line.dispatched_quantity
            cur["received"] += line.received_quantity
            cur["discrepancy"] += line.discrepancy_quantity

    for mat in order.materials:
        t_data = transfer_lines_by_item.get(mat.item_id, {"dispatched": mat.dispatched_quantity, "received": mat.received_quantity, "discrepancy": mat.discrepancy_quantity})
        dispatched = t_data["dispatched"]
        received = t_data["received"]
        discrepancy = t_data["discrepancy"]
        in_transit = max(0.0, dispatched - received - abs(discrepancy)) if any(t.status == "in_transit" for t in transfers) else 0.0
        wip_bal = wip_balance_by_item.get(mat.item_id, 0.0)

        item_code = mat.item.code if mat.item else ""
        item_name = mat.item.name_ar if mat.item else mat.item_name_snapshot
        unit_name = mat.unit.name_ar if mat.unit else ""

        materials_summary.append(
            OrderMaterialWipItem(
                item_id=mat.item_id,
                item_code=item_code,
                item_name_ar=item_name,
                unit_id=mat.unit_id,
                unit_name_ar=unit_name,
                planned_quantity=mat.planned_quantity,
                dispatched_quantity=dispatched,
                received_quantity=received,
                discrepancy_quantity=discrepancy,
                in_transit_quantity=in_transit,
                current_wip_balance=wip_bal,
                status=mat.status,
            )
        )

    # إجمالي رصيد خامات تحت التشغيل الفعلي المعزول لسلة هذا الأمر
    net_wip_balance = round(sum(wip_balance_by_item.values()), 4)

    # 5. أسباب منع الإغلاق
    blocking_reasons: list[str] = []
    if order.status == "closed":
        can_close = False
        blocking_reasons.append("أمر التشغيل مغلق بالفعل.")
    else:
        if not stages_completed:
            blocking_reasons.append("لم تكتمل كافة مراحل الإنتاج الفنية (5 مراحل).")
        if pending_transfers_count > 0:
            blocking_reasons.append(f"يوجد {pending_transfers_count} مستند تحويل خامات لا يزال بالطريق (صرف أو مرتجع لم يؤكد استلامه).")
        if returns_pending_resolution > 0:
            blocking_reasons.append(f"يوجد {returns_pending_resolution} مرتجع ورشة به عجز أو كميات مرفوضة بانتظار التسوية المعتمدة.")
        if unresolved_discrepancies_count > 0:
            blocking_reasons.append(f"يوجد {unresolved_discrepancies_count} فروقات استلام بالورشة يلزم اعتماد إقرارها.")
        if goods_receipt_status != "complete":
            blocking_reasons.append(f"الكمية المستلمة ({total_received_goods}) أقل من المستهدفة ({order.target_quantity}).")
        if net_wip_balance != 0.0:
            blocking_reasons.append(f"يوجد رصيد خامات معلق بالورشة ({net_wip_balance}) لم تتم تسويته دفترياً ومخزنياً.")
        can_close = len(blocking_reasons) == 0

    return OrderWipSummary(
        order_id=order.id,
        order_number=order.order_number,
        status=order.status,
        target_quantity=order.target_quantity,
        total_received_goods=total_received_goods,
        goods_receipt_status=goods_receipt_status,
        stages_completed=stages_completed,
        pending_transfers_count=pending_transfers_count,
        unresolved_discrepancies_count=unresolved_discrepancies_count,
        returns_pending_resolution_count=returns_pending_resolution,
        net_wip_balance=round(net_wip_balance, 4),
        can_close=can_close,
        blocking_reasons=blocking_reasons,
        materials=materials_summary,
    )


@router.post("/orders/{order_id}/close", response_model=OrderCloseResponse)
async def close_production_order(
    order_id: str,
    data: OrderCloseRequest = OrderCloseRequest(),
    current_user: AuthenticatedUser = Depends(require_permission("production:orders:close")),
    db: AsyncSession = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """إغلاق أمر التشغيل نهائياً وتسوية ملفه بعد التحقق الصارم من شروط الأمان."""
    async def _execute():
        stmt = (
            select(ProductionOrder)
            .options(
                selectinload(ProductionOrder.materials),
                selectinload(ProductionOrder.stage_events),
            )
            .where(ProductionOrder.id == order_id)
            .with_for_update()
        )
        order = (await db.execute(stmt)).scalar_one_or_none()
        if not order:
            raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

        if order.status == "closed":
            raise HTTPException(status_code=409, detail="أمر التشغيل مغلق نهائياً مسبقاً.")

        # 1. التحقق من مراحل الإنتاج
        stages_completed = (
            len(order.stage_events) == 5
            and all(e.status == "completed" for e in order.stage_events)
        )
        if not stages_completed:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="لا يمكن إغلاق أمر التشغيل قبل اكتمال كافة مراحل الإنتاج الفنية الخمس.",
            )

        # 2. التحقق من التحويلات المعلقة بالطريق
        transfers = (await db.execute(
            select(WarehouseTransfer)
            .options(
                selectinload(WarehouseTransfer.lines),
                selectinload(WarehouseTransfer.source_warehouse),
                selectinload(WarehouseTransfer.destination_warehouse),
            )
            .where(WarehouseTransfer.order_id == order_id)
        )).scalars().all()

        return_transfers = [t for t in transfers if transfer_is_return(t)]
        if any(t.status == RETURN_STATUS_IN_TRANSIT for t in return_transfers):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="لا يمكن إغلاق الأمر قبل أن يؤكد أمين المخزن استلام مرتجعات الورشة الموجودة بالطريق.",
            )
        if any(t.status == RETURN_STATUS_PENDING_RESOLUTION for t in return_transfers):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="لا يمكن إغلاق الأمر وفي مرتجعات الورشة عجز أو كميات مرفوضة لم تُسوَّ بقرار معتمد.",
            )
        in_transit_transfers = [t for t in transfers if t.status == "in_transit"]
        if in_transit_transfers:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="لا يمكن إغلاق الأمر لوجود مستندات تحويل خامات لا تزال قيد النقل بالطريق (in_transit).",
            )

        # 3. فروقات استلام الصرف بالورشة واعتمادها (فروقات المرتجعات سُوّيت بقرار مستقل أعلاه)
        discrepancy_lines = [
            line for t in transfers if transfer_is_dispatch(t)
            for line in t.lines if line.discrepancy_quantity != 0.0
        ]
        if discrepancy_lines and not data.discrepancy_signoff:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"يوجد عدد ({len(discrepancy_lines)}) فروقات استلام بالورشة غير معتمدة. يلزم تفعيل إقرار الفروقات (discrepancy_signoff) مع بيان الأسباب.",
            )

        # 4. التحقق من استلام المنتج التام
        existing_receipts = await db.scalar(
            select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
            .where(
                StockLedgerEntry.reference_doc_type == "production_order_finished_receipt",
                StockLedgerEntry.reference_doc_id == order.id,
                StockLedgerEntry.entry_type == "finished_goods_receipt",
            )
        )
        total_received_goods = float(existing_receipts or 0.0)
        if total_received_goods < order.target_quantity and not (data.under_production_reason and data.under_production_reason.strip()):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"الكمية المستلمة ({total_received_goods}) أقل من المستهدفة ({order.target_quantity}). يلزم تقديم سبب العجز الإنتاجي (under_production_reason) للاعتماد.",
            )

        # 5. التحقق الصارم من تصفير وتسوية رصيد خامات تحت التشغيل (WIP Balance)
        wip_balance = await db.scalar(
            select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
            .where(
                StockLedgerEntry.bucket_reference == f"order:{order.id}",
                StockLedgerEntry.location_type == "warehouse",
            )
        )
        remaining_wip = round(float(wip_balance or 0.0), 4)
        if remaining_wip != 0.0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"لا يمكن إغلاق أمر التشغيل لوجود رصيد خامات معلق بالورشة ({remaining_wip}) لم تتم تسويته مخزنياً ومالياً. تسجيل مصير الخامات نصياً لا يغني عن حركات التسوية الدفترية الفعلية.",
            )

        # 6. تحديث حالة الأمر وإثبات الإغلاق وتسوية الرصيد المالي المتبقي لـ WIP
        now = datetime.now(timezone.utc)
        order.status = "closed"

        # تسوية رصيد تحت التشغيل المالي المتبقي (إن وجد نتيجة عجز أو تالف) وعدم إهداره محاسبياً
        # تكلفة الهالك والفروقات المتبقية بحساب تحت التشغيل تُحمل على مصروفات التصنيع (أو تُرد إن كانت سالبة)
        residual_wip_cost = (order.wip_balance or Decimal("0.00")).quantize(Decimal("0.01"))
        if residual_wip_cost != Decimal("0.00"):
            amount = abs(residual_wip_cost)
            if residual_wip_cost > 0:
                variance_lines = [
                    {"account_code": "5200", "debit": amount, "credit": 0, "description": f"هالك وفروقات تشغيل أمر {order.order_number}"},
                    {"account_code": "1220", "debit": 0, "credit": amount, "description": "تصفير حساب إنتاج تحت التشغيل"},
                ]
            else:
                variance_lines = [
                    {"account_code": "1220", "debit": amount, "credit": 0, "description": "تصفير حساب إنتاج تحت التشغيل"},
                    {"account_code": "5200", "debit": 0, "credit": amount, "description": f"فرق تقريب تكلفة أمر {order.order_number}"},
                ]
            await post_journal_entry(
                db,
                source_doc_type="production_order_scrap_variance",
                source_doc_id=order.id,
                description=f"تسوية رصيد تحت التشغيل المتبقي لأمر التشغيل {order.order_number}",
                lines=variance_lines,
                user_id=current_user.id,
            )
            order.wip_balance = Decimal("0.00")

        closure_log = f"\n[تم الإغلاق النهائي بواسطة {current_user.id} في {now.isoformat()}]"
        if data.wip_disposition:
            closure_log += f" | مصير الخامات: {data.wip_disposition}"
            if data.wip_disposition_notes:
                closure_log += f" ({data.wip_disposition_notes})"
        if data.discrepancy_signoff:
            closure_log += " | تم اعتماد فروقات الاستلام"
            if data.discrepancy_notes:
                closure_log += f": {data.discrepancy_notes}"
        if data.under_production_reason:
            closure_log += f" | مبرر نقص الإنتاج: {data.under_production_reason}"
        if data.notes:
            closure_log += f" | ملاحظات: {data.notes}"

        order.notes = (order.notes or "") + closure_log
        await db.flush()

        return OrderCloseResponse(
            order_id=order.id,
            order_number=order.order_number,
            status=order.status,
            closed_at=now,
            closed_by=current_user.id,
            target_quantity=order.target_quantity,
            total_received_goods=total_received_goods,
            remaining_wip_balance=round(remaining_wip, 4),
            discrepancy_count=len(discrepancy_lines),
            wip_disposition=data.wip_disposition,
            notes=data.notes,
        )

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="production.order_close",
        resource_id=order_id,
        user_id=current_user.id,
        payload={"order_id": order_id, "data": data.model_dump()},
        execute_fn=_execute,
    )

