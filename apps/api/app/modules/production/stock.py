"""
مصدر الحقيقة الوحيد لأرصدة المخزون.
─────────────────────────────────────────────────────────────────────────────
الرصيد = مجموع كميات stock_ledger_entries (سجل غير قابل للتعديل). لا يوجد رصيد مخزّن.

حاويات الملكية داخل مخزن المنتج التام (bucket_reference):
- factory_brand                      : إنتاج المصنع المتاح للبيع العام.
- private_label:{customer_id}        : إنتاج خاص لعميل محدد؛ لا يُسلم إلا له.
- return_pending_inspection:{cid}    : مرتجع عميل تحت الفحص؛ غير متاح للبيع.
- order:{production_order_id}        : خامات أمر تشغيل داخل مخزن تحت التشغيل.
- NULL                               : مخزن الخامات (لا يحتاج حاويات).
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.production.models import StockLedgerEntry

ANY_BUCKET = object()
FACTORY_BRAND_BUCKET = "factory_brand"
RETURN_PENDING_PREFIX = "return_pending_inspection:"
SELLABLE_PREFIXES = (FACTORY_BRAND_BUCKET, "private_label:")


def finished_goods_bucket(product_type: str | None, customer_id: str | None) -> str:
    if product_type == "private_label" and customer_id:
        return f"private_label:{customer_id}"
    return FACTORY_BRAND_BUCKET


def delivery_bucket_for_order(order_type: str, customer_id: str) -> str:
    return f"private_label:{customer_id}" if order_type == "custom_manufacturing" else FACTORY_BRAND_BUCKET


def order_wip_bucket(order_id: str) -> str:
    return f"order:{order_id}"


async def stock_balance(
    db: AsyncSession,
    item_id: str,
    warehouse_id: str,
    *,
    bucket_reference=ANY_BUCKET,
    location_type: str = "warehouse",
) -> float:
    """رصيد صنف في مخزن (واختيارياً في حاوية ملكية محددة)."""
    stmt = select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0)).where(
        StockLedgerEntry.item_id == item_id,
        StockLedgerEntry.warehouse_id == warehouse_id,
        StockLedgerEntry.location_type == location_type,
    )
    if bucket_reference is not ANY_BUCKET:
        if bucket_reference is None:
            stmt = stmt.where(StockLedgerEntry.bucket_reference.is_(None))
        else:
            stmt = stmt.where(StockLedgerEntry.bucket_reference == bucket_reference)
    return round(float((await db.scalar(stmt)) or 0.0), 6)


async def balances_by_bucket(db: AsyncSession, warehouse_id: str, item_ids: list[str] | None = None) -> dict[tuple[str, str | None], float]:
    """أرصدة (صنف، حاوية) في مخزن واحد."""
    stmt = (
        select(StockLedgerEntry.item_id, StockLedgerEntry.bucket_reference, func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
        .where(StockLedgerEntry.warehouse_id == warehouse_id, StockLedgerEntry.location_type == "warehouse")
        .group_by(StockLedgerEntry.item_id, StockLedgerEntry.bucket_reference)
    )
    if item_ids is not None:
        stmt = stmt.where(StockLedgerEntry.item_id.in_(item_ids))
    rows = (await db.execute(stmt)).all()
    return {(item_id, bucket): round(float(qty or 0.0), 6) for item_id, bucket, qty in rows}
