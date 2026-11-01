"""
تقارير ملخص النظام — مالية ومخزنية وإنتاجية.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.db.base  # noqa: F401 — تهيئة كافة نماذج SQLAlchemy

from app.core.auth import AuthenticatedUser
from app.core.permissions import require_permission
from app.db.session import get_db
from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry, SupplierInvoice, SupplierPayment
from app.modules.production.models import (
    CatalogItem,
    ProductionOrder,
    StockLedgerEntry,
    Warehouse,
)

router = APIRouter(prefix="/reports", tags=["reports"])


async def _get_account_balance(db: AsyncSession, account_id: str) -> Decimal:
    val = await db.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account_id)
    )
    return Decimal(str(val or 0))


async def _get_warehouse_id(db: AsyncSession, code: str) -> Optional[str]:
    return await db.scalar(select(Warehouse.id).where(Warehouse.code == code))


@router.get("/summary")
async def get_summary(
    period: str = Query(default="monthly", pattern="^(daily|weekly|monthly|quarterly|yearly)$"),
    current_user: AuthenticatedUser = Depends(require_permission("reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """ملخص تشغيلي شامل: خزينة، مخزون، إنتاج، رواتب."""
    now = datetime.now(timezone.utc)
    if period == "daily":
        since = now - timedelta(days=1)
    elif period == "weekly":
        since = now - timedelta(days=7)
    elif period == "monthly":
        since = now - timedelta(days=30)
    elif period == "quarterly":
        since = now - timedelta(days=90)
    else:  # yearly
        since = now - timedelta(days=365)

    # ─── الخزينة والعهدات ─────────────────────────────────────────────────────
    treasury = await db.scalar(select(CashAccount).where(CashAccount.account_type == "treasury", CashAccount.is_active.is_(True)))
    treasury_balance = await _get_account_balance(db, treasury.id) if treasury else Decimal("0")

    petty_accounts = (await db.scalars(
        select(CashAccount).where(CashAccount.account_type == "petty_cash", CashAccount.is_active.is_(True))
    )).all()
    petty_total = Decimal("0")
    for pc in petty_accounts:
        petty_total += await _get_account_balance(db, pc.id)

    # ─── إيرادات ومصروفات الفترة ─────────────────────────────────────────────
    revenues_period = await db.scalar(
        select(func.coalesce(func.sum(CashDocument.amount), 0)).where(
            CashDocument.document_type == "income",
            CashDocument.status == "approved",
            CashDocument.occurred_at >= since,
        )
    ) or 0
    expenses_period = await db.scalar(
        select(func.coalesce(func.sum(CashDocument.amount), 0)).where(
            CashDocument.document_type == "expense",
            CashDocument.status == "approved",
            CashDocument.occurred_at >= since,
        )
    ) or 0

    # ─── الإنتاج ──────────────────────────────────────────────────────────────
    active_orders = await db.scalar(
        select(func.count(ProductionOrder.id)).where(
            ProductionOrder.status.in_([
                "pending",
                "in_progress",
                "materials_dispatched",
                "in_production",
                "manufacturing_completed",
                "receipt_completed",
            ])
        )
    ) or 0
    completed_orders_period = await db.scalar(
        select(func.count(ProductionOrder.id)).where(
            ProductionOrder.status.in_(["completed", "closed"]),
            ProductionOrder.created_at >= since,
        )
    ) or 0

    # ─── المخزون ──────────────────────────────────────────────────────────────
    raw_wh_id = await _get_warehouse_id(db, "main_raw_materials")
    fg_wh_id = await _get_warehouse_id(db, "finished_goods")

    raw_material_items = 0
    finished_goods_items = 0
    if raw_wh_id:
        raw_material_items = await db.scalar(
            select(func.count(func.distinct(StockLedgerEntry.item_id))).where(StockLedgerEntry.warehouse_id == raw_wh_id)
        ) or 0
    if fg_wh_id:
        finished_goods_items = await db.scalar(
            select(func.count(func.distinct(StockLedgerEntry.item_id))).where(StockLedgerEntry.warehouse_id == fg_wh_id)
        ) or 0

    # ─── مستحقات الموردين ────────────────────────────────────────────────────
    total_supplier_invoiced = await db.scalar(
        select(func.coalesce(func.sum(SupplierInvoice.invoice_total), 0)).where(SupplierInvoice.status != "cancelled")
    ) or 0
    total_supplier_paid = await db.scalar(
        select(func.coalesce(func.sum(SupplierPayment.amount), 0)).where(SupplierPayment.status == "approved")
    ) or 0
    supplier_payables = Decimal(str(total_supplier_invoiced)) - Decimal(str(total_supplier_paid))

    return {
        "period": period,
        "generated_at": now.isoformat(),
        "treasury": {
            "balance": float(treasury_balance),
            "petty_cash_total": float(petty_total),
            "revenues_period": float(revenues_period),
            "expenses_period": float(expenses_period),
            "net_period": float(Decimal(str(revenues_period)) - Decimal(str(expenses_period))),
        },
        "production": {
            "active_orders": int(active_orders),
            "completed_orders_period": int(completed_orders_period),
        },
        "inventory": {
            "raw_material_distinct_items": int(raw_material_items),
            "finished_goods_distinct_items": int(finished_goods_items),
        },
        "payables": {
            "supplier_payables": float(supplier_payables),
        },
    }


@router.get("/inventory")
async def get_inventory_report(
    warehouse_code: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقرير أرصدة المخزون لكل صنف في كل مخزن."""
    stmt = (
        select(
            StockLedgerEntry.item_id,
            StockLedgerEntry.warehouse_id,
            func.coalesce(func.sum(StockLedgerEntry.quantity), 0).label("balance"),
        )
        .group_by(StockLedgerEntry.item_id, StockLedgerEntry.warehouse_id)
    )
    if warehouse_code:
        wh_id = await _get_warehouse_id(db, warehouse_code)
        if wh_id:
            stmt = stmt.where(StockLedgerEntry.warehouse_id == wh_id)

    rows = (await db.execute(stmt)).all()
    warehouses_map = {
        wh.id: wh.name_ar
        for wh in (await db.scalars(select(Warehouse))).all()
    }
    items_map = {
        item.id: {"code": item.code, "name_ar": item.name_ar}
        for item in (await db.scalars(select(CatalogItem))).all()
    }

    result = []
    for item_id, warehouse_id, balance in rows:
        item_info = items_map.get(item_id, {})
        result.append({
            "item_id": item_id,
            "item_code": item_info.get("code", ""),
            "item_name_ar": item_info.get("name_ar", ""),
            "warehouse_id": warehouse_id,
            "warehouse_name": warehouses_map.get(warehouse_id, ""),
            "balance": float(balance),
            "low_stock": float(balance) <= 0,
        })
    return {"items": result, "total_items": len(result)}


@router.get("/financial")
async def get_financial_report(
    since_days: int = Query(default=30, ge=1, le=365),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقرير مالي: إيرادات، مصروفات، مستحقات موردين."""
    since = datetime.now(timezone.utc) - timedelta(days=since_days)

    revenues = (await db.scalars(
        select(CashDocument).where(
            CashDocument.document_type == "income",
            CashDocument.status == "approved",
            CashDocument.occurred_at >= since,
        ).order_by(CashDocument.occurred_at.desc())
    )).all()

    expenses = (await db.scalars(
        select(CashDocument).where(
            CashDocument.document_type == "expense",
            CashDocument.status == "approved",
            CashDocument.occurred_at >= since,
        ).order_by(CashDocument.occurred_at.desc())
    )).all()

    total_revenues = sum(r.amount for r in revenues)
    total_expenses = sum(e.amount for e in expenses)

    return {
        "since_days": since_days,
        "since": since.isoformat(),
        "revenues": {
            "total": float(total_revenues),
            "count": len(revenues),
            "documents": [
                {
                    "id": r.id,
                    "number": r.document_number,
                    "amount": float(r.amount),
                    "description": r.description,
                    "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
                }
                for r in revenues[:50]
            ],
        },
        "expenses": {
            "total": float(total_expenses),
            "count": len(expenses),
            "documents": [
                {
                    "id": e.id,
                    "number": e.document_number,
                    "amount": float(e.amount),
                    "description": e.description,
                    "occurred_at": e.occurred_at.isoformat() if e.occurred_at else None,
                }
                for e in expenses[:50]
            ],
        },
        "net": float(Decimal(str(total_revenues)) - Decimal(str(total_expenses))),
    }
