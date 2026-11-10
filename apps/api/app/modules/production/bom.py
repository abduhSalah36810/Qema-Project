"""
مستلزمات التصنيع لكل مقاس/مواصفة (Bill of Materials) وحساب احتياجات أمر التشغيل.
─────────────────────────────────────────────────────────────────────────────
- BOM المقاس = قالب تشغيل مرتبط بـ variant_id بكمية مرجعية = قطعة واحدة، بإصدارات:
  كل حفظ يُنشئ إصداراً جديداً «active» ويؤرشف السابق؛ لا يُعدَّل إصدار قائم أبداً،
  فتظل أوامر التشغيل التي استخدمت إصداراً سابقاً كما هي.
- الاحتياجات تُجمع حسب معرف الصنف ووحدته (لا بالاسم)، وتُقارن برصيد مخزن الخامات.
  المعاينة لا تحجز ولا تصرف شيئاً؛ الصرف يبقى بدورته الحالية.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
    utc_now,
)

BOM_ACTIVE = "active"
BOM_ARCHIVED = "archived"
QTY = Decimal("0.0001")


def variant_label(variant: ProductVariant) -> str:
    season = {"summer": "صيفي", "autumn": "خريفي", "winter": "شتوي"}.get((variant.season or "").lower(), variant.season or "")
    parts = [f"مقاس {variant.numeric_size}", variant.letter_size or "", season]
    return " · ".join(p for p in parts if p)


async def variant_bom_template(db: AsyncSession, variant_id: str) -> ProductionTemplate | None:
    return await db.scalar(
        select(ProductionTemplate)
        .where(ProductionTemplate.variant_id == variant_id, ProductionTemplate.is_active.is_(True))
        .order_by(ProductionTemplate.created_at.desc())
    )


async def active_bom_version(db: AsyncSession, variant_id: str) -> ProductionTemplateVersion | None:
    """الإصدار النشط لمستلزمات المقاس مع بنوده، أو None إن لم تُعرّف مستلزماته بعد."""
    template = await variant_bom_template(db, variant_id)
    if not template:
        return None
    return await db.scalar(
        select(ProductionTemplateVersion)
        .options(
            selectinload(ProductionTemplateVersion.lines).selectinload(ProductionTemplateLine.item),
            selectinload(ProductionTemplateVersion.lines).selectinload(ProductionTemplateLine.unit),
        )
        .where(ProductionTemplateVersion.template_id == template.id, ProductionTemplateVersion.status == BOM_ACTIVE)
        .order_by(ProductionTemplateVersion.version_number.desc())
    )


async def save_variant_bom(
    db: AsyncSession, *, variant: ProductVariant, lines: list, notes: str, user_id: str,
) -> ProductionTemplateVersion:
    """حفظ مستلزمات مقاس كإصدار جديد نشط (والسابق مؤرشف). البنود أصناف معتمدة نشطة من دليل الأصناف."""
    if not lines:
        raise HTTPException(status_code=422, detail="أضف صنفاً واحداً على الأقل إلى مستلزمات التصنيع.")
    seen: set[str] = set()
    resolved = []
    for line in lines:
        if line.item_id in seen:
            raise HTTPException(status_code=422, detail="لا تكرر الصنف نفسه في مستلزمات المقاس؛ اجمع كميته في سطر واحد.")
        seen.add(line.item_id)
        item = await db.get(CatalogItem, line.item_id)
        if not item or not item.is_active or item.approval_status != "approved":
            raise HTTPException(status_code=422, detail="أحد الأصناف غير موجود أو غير معتمد أو موقوف في دليل الأصناف.")
        if item.item_type == "finished_garment":
            raise HTTPException(status_code=422, detail=f"الصنف «{item.name_ar}» منتج تام ولا يُستخدم كمستلزم تصنيع.")
        resolved.append((line, item))

    product = await db.get(Product, variant.product_id)
    template = await variant_bom_template(db, variant.id)
    if template is None:
        template = ProductionTemplate(
            id=str(uuid.uuid4()),
            code=f"BOM-{variant.sku}"[:64],
            name_ar=f"مستلزمات {product.name_ar if product else ''} {variant_label(variant)}"[:128],
            product_id=variant.product_id,
            variant_id=variant.id,
            is_active=True,
            created_at=utc_now(),
        )
        db.add(template)
        await db.flush()

    previous = (await db.scalars(
        select(ProductionTemplateVersion).where(ProductionTemplateVersion.template_id == template.id)
    )).all()
    for old in previous:
        if old.status == BOM_ACTIVE:
            old.status = BOM_ARCHIVED
    version = ProductionTemplateVersion(
        id=str(uuid.uuid4()),
        template_id=template.id,
        version_number=max((v.version_number for v in previous), default=0) + 1,
        status=BOM_ACTIVE,
        reference_quantity=1.0,
        notes=(notes or "").strip() or f"حفظ بواسطة {user_id}",
        created_at=utc_now(),
    )
    db.add(version)
    await db.flush()
    for line, item in resolved:
        db.add(ProductionTemplateLine(
            id=str(uuid.uuid4()), version_id=version.id, item_id=item.id, unit_id=item.unit_id,
            quantity_per_reference=float(line.quantity_per_piece), notes=(line.notes or "").strip(),
        ))
    await db.flush()
    return version


async def raw_available(db: AsyncSession, item_ids: list[str]) -> dict[str, float]:
    """رصيد مخزن الخامات القابل للصرف (نفس حساب الصرف الحالي)."""
    if not item_ids:
        return {}
    raw = await db.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    if not raw:
        return {}
    rows = (await db.execute(
        select(StockLedgerEntry.item_id, func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
        .where(
            StockLedgerEntry.item_id.in_(item_ids),
            StockLedgerEntry.warehouse_id == raw.id,
            StockLedgerEntry.location_type == "warehouse",
        )
        .group_by(StockLedgerEntry.item_id)
    )).all()
    return {item_id: round(float(qty or 0.0), 4) for item_id, qty in rows}


@dataclass
class LineRequirement:
    product_id: str
    variant_id: str
    product_name: str
    variant_label: str
    quantity: float
    template_version_id: str | None
    bom_version_number: int | None
    has_bom: bool
    issue: str = ""
    materials: list[dict] = field(default_factory=list)


async def compute_requirements(db: AsyncSession, lines: list) -> dict:
    """
    lines: عناصر بها product_id, variant_id, quantity.
    يعيد لكل سطر مستلزماته (من BOM النشط) والإجمالي المجمع حسب (الصنف، الوحدة) مقارنة برصيد الخامات.
    """
    results: list[LineRequirement] = []
    totals: dict[tuple[str, str], dict] = {}
    for line in lines:
        product = await db.get(Product, line.product_id)
        variant = await db.get(ProductVariant, line.variant_id)
        if not product or not variant or variant.product_id != product.id:
            results.append(LineRequirement(
                product_id=line.product_id, variant_id=line.variant_id, product_name=product.name_ar if product else "",
                variant_label="", quantity=float(line.quantity), template_version_id=None, bom_version_number=None,
                has_bom=False, issue="الموديل أو المقاس غير صحيح.",
            ))
            continue
        version = await active_bom_version(db, variant.id)
        req = LineRequirement(
            product_id=product.id, variant_id=variant.id, product_name=product.name_ar,
            variant_label=variant_label(variant), quantity=float(line.quantity),
            template_version_id=version.id if version else None,
            bom_version_number=version.version_number if version else None,
            has_bom=bool(version and version.lines),
        )
        if product.is_active is False or variant.is_active is False:
            # موديل أو مقاس موقوف: لا يدخل في أوامر جديدة
            req.has_bom = False
            req.issue = "هذا الموديل موقوف." if product.is_active is False else "هذا المقاس موقوف."
        elif not req.has_bom:
            req.issue = "لا توجد مستلزمات تصنيع معرّفة لهذا المقاس."
        else:
            for tl in version.lines:
                per_piece = Decimal(str(tl.quantity_per_reference))
                total = (per_piece * Decimal(str(line.quantity))).quantize(QTY)
                req.materials.append({
                    "item_id": tl.item_id, "unit_id": tl.unit_id,
                    "item_name": tl.item.name_ar if tl.item else "", "item_code": tl.item.code if tl.item else "",
                    "unit_name": tl.unit.name_ar if tl.unit else "",
                    "quantity_per_piece": float(per_piece), "total_quantity": float(total),
                })
                key = (tl.item_id, tl.unit_id)
                agg = totals.setdefault(key, {
                    "item_id": tl.item_id, "unit_id": tl.unit_id,
                    "item_name": tl.item.name_ar if tl.item else "", "item_code": tl.item.code if tl.item else "",
                    "unit_name": tl.unit.name_ar if tl.unit else "", "required_quantity": Decimal("0"),
                    "item_active": bool(tl.item and tl.item.is_active and tl.item.approval_status == "approved"),
                })
                agg["required_quantity"] += total
        results.append(req)

    available = await raw_available(db, list({k[0] for k in totals}))
    summary = []
    for agg in totals.values():
        required = float(agg["required_quantity"])
        avail = max(0.0, available.get(agg["item_id"], 0.0))
        summary.append({
            **agg, "required_quantity": round(required, 4), "available_quantity": round(avail, 4),
            "dispatchable_quantity": round(min(required, avail), 4),
            "shortage_quantity": round(max(0.0, required - avail), 4),
        })
    summary.sort(key=lambda r: r["item_name"])
    missing = [r for r in results if not r.has_bom]
    return {
        "lines": results,
        "materials": summary,
        "can_create": bool(results) and not missing and all(m["item_active"] for m in summary),
        "has_shortage": any(m["shortage_quantity"] > 0 for m in summary),
    }


async def unit_name(db: AsyncSession, unit_id: str) -> str:
    unit = await db.get(Unit, unit_id)
    return unit.name_ar if unit else ""
