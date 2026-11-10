"""
تقارير ملخص النظام — مالية ومخزنية وإنتاجية.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.db.base  # noqa: F401 — تهيئة كافة نماذج SQLAlchemy

from app.core.auth import AuthenticatedUser
from app.core.permissions import get_permissions_for_roles, get_user_roles, require_any_permission, require_permission
from app.db.session import get_db
from app.modules.finance.models import (
    Account, CashAccount, CashDocument, CashLedgerEntry, CustodySettlement,
    JournalEntry, JournalEntryLine, Supplier, SupplierInvoice, SupplierInvoiceLine, SupplierPayment,
)
from app.modules.customers.models import (
    CustomerOrder, CustomerOrderLine, CustomerPayment,
    CustomerDelivery, CustomerDeliveryLine,
)
from app.modules.production.models import (
    CatalogItem,
    Customer,
    Product,
    ProductionDefect,
    ProductionOrder,
    ProductionOrderMaterial,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID, get_weighted_average_cost
from app.modules.finance.balances import (
    customer_order_financials,
    customer_totals,
    document_net_sales_value,
    load_customer_orders,
    supplier_invoice_financials,
    supplier_totals,
)

from app.modules.reports import analytics

router = APIRouter(prefix="/reports", tags=["reports"])


def _since_bounds(since_days: int, date_from: Optional[date], date_to: Optional[date]) -> tuple[datetime, datetime]:
    """فترة التقرير: من/إلى بالتقويم وبتوقيت القاهرة إن حُددت، وإلا آخر since_days يوماً."""
    if date_from or date_to:
        p = analytics.resolve_period(date_from, date_to)
        return p.start, p.end
    now = datetime.now(timezone.utc)
    return now - timedelta(days=since_days), now + timedelta(days=1)


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

    permissions = get_permissions_for_roles(await get_user_roles(current_user, db=db))
    can_view_finance = "finance:reports:view" in permissions

    # ─── الخزينة والعهدات (الخزنة الرئيسية الوحيدة المعتمدة) ──────────────────
    treasury = await db.get(CashAccount, CANONICAL_TREASURY_ID)
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
                "draft",
                "materials_dispatched",
                "in_production",
                "manufacturing_completed",
                "receipt_completed",
            ])
        )
    ) or 0
    completed_orders_period = await db.scalar(
        select(func.count(ProductionOrder.id)).where(
            ProductionOrder.status.in_(["receipt_completed", "closed"]),
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

    # ─── مستحقات الموردين ومديونيات العملاء (نفس قواعد شاشات الموردين والعملاء) ──
    supplier_payables = sum((t.balance for t in (await supplier_totals(db)).values()), Decimal("0.00")) if can_view_finance else Decimal("0")
    customer_receivables = sum((t.balance for t in (await customer_totals(db)).values()), Decimal("0.00")) if can_view_finance else Decimal("0")

    treasury_block = None
    if can_view_finance:
        treasury_block = {
            "balance": float(treasury_balance),
            "petty_cash_total": float(petty_total),
            # أساس نقدي: مقبوضات ومدفوعات معتمدة في الخزينة خلال الفترة (تشمل التحصيلات وسداد الموردين)
            "cash_in_period": float(revenues_period),
            "cash_out_period": float(expenses_period),
            "revenues_period": float(revenues_period),
            "expenses_period": float(expenses_period),
            "net_period": float(Decimal(str(revenues_period)) - Decimal(str(expenses_period))),
            "basis": "cash",
        }

    return {
        "period": period,
        "generated_at": now.isoformat(),
        "treasury": treasury_block,
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
            "customer_receivables": float(customer_receivables),
        } if can_view_finance else None,
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
        # أرصدة المخازن الفعلية فقط؛ البضاعة بالطريق وعجز النقل ليست رصيداً في مخزن
        .where(StockLedgerEntry.warehouse_id.is_not(None), StockLedgerEntry.location_type == "warehouse")
        .group_by(StockLedgerEntry.item_id, StockLedgerEntry.warehouse_id)
    )
    if warehouse_code:
        wh_id = await _get_warehouse_id(db, warehouse_code)
        if wh_id:
            stmt = stmt.where(StockLedgerEntry.warehouse_id == wh_id)

    rows = (await db.execute(stmt)).all()
    STANDARD_WH_NAMES = {
        "main_raw_materials": "مخزن الخامات والمستلزمات",
        "work_in_progress": "مخزن تحت التشغيل (WIP)",
        "finished_goods": "مخزن المنتجات التامة",
        "machinery": "مخزن الماكينات والمعدات",
    }
    warehouses_map = {}
    for wh in (await db.scalars(select(Warehouse))).all():
        name = wh.name_ar or STANDARD_WH_NAMES.get(wh.code, wh.code)
        warehouses_map[wh.id] = name
        if wh.code:
            warehouses_map[wh.code] = name

    items_map = {
        item.id: {"code": item.code, "name_ar": item.name_ar}
        for item in (await db.scalars(select(CatalogItem))).all()
    }

    result = []
    for item_id, warehouse_id, balance in rows:
        item_info = items_map.get(item_id, {})
        wh_name = warehouses_map.get(warehouse_id) or STANDARD_WH_NAMES.get(warehouse_id, "مخزن عام")
        result.append({
            "item_id": item_id,
            "item_code": item_info.get("code", ""),
            "item_name_ar": item_info.get("name_ar", ""),
            "warehouse_id": warehouse_id,
            "warehouse_name": wh_name,
            "warehouse_name_ar": wh_name,
            "balance": float(balance),
            "low_stock": float(balance) <= 0,
        })

    # فروق النقل (عجز بين المصروف من المخزن والمستلم بالورشة): مسجلة بالدفتر لكنها خارج المخازن
    disc_rows = (await db.execute(
        select(StockLedgerEntry.item_id, func.sum(StockLedgerEntry.quantity))
        .where(StockLedgerEntry.location_type == "discrepancy")
        .group_by(StockLedgerEntry.item_id)
    )).all()
    discrepancies = [
        {
            "item_id": item_id,
            "item_code": items_map.get(item_id, {}).get("code", ""),
            "item_name_ar": items_map.get(item_id, {}).get("name_ar", ""),
            "quantity": float(qty or 0),
        }
        for item_id, qty in disc_rows
        if abs(float(qty or 0)) > 1e-9
    ]
    return {"items": result, "total_items": len(result), "transfer_discrepancies": discrepancies}


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



# ═══════════════════════════════════════════════════════════════════════════════
# التقارير المالية المتخصصة والمحاسبية المتقدمة
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/trial-balance")
async def report_trial_balance(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """ميزان المراجعة المحاسبي العام: إجمالي المدين والدائن وصافي الرصيد لكل حساب."""
    accounts = (await db.scalars(select(Account).where(Account.is_active.is_(True)).order_by(Account.code))).all()
    rows = []
    total_debit = Decimal("0.00")
    total_credit = Decimal("0.00")
    for acc in accounts:
        dr = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.debit), 0)).where(JournalEntryLine.account_id == acc.id)
        ) or 0))
        cr = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.credit), 0)).where(JournalEntryLine.account_id == acc.id)
        ) or 0))
        if dr == 0 and cr == 0:
            continue
        rows.append({
            "code": acc.code,
            "name_ar": acc.name_ar,
            "account_type": acc.account_type,
            "debit": float(dr),
            "credit": float(cr),
            "net": float(dr - cr),
        })
        total_debit += dr
        total_credit += cr

    return {
        "rows": rows,
        "total_debit": float(total_debit),
        "total_credit": float(total_credit),
        "difference": float(total_debit - total_credit),
        "is_balanced": total_debit == total_credit,
    }


@router.get("/cash-flow")
async def report_cash_flow(
    since_days: int = Query(default=30, ge=1, le=365),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقرير التدفقات النقدية التشغيلية مقسمة حسب طبيعة النشاط."""
    since, until = _since_bounds(since_days, date_from, date_to)

    docs = (await db.scalars(
        select(CashDocument).where(
            CashDocument.status == "approved",
            CashDocument.occurred_at >= since,
            CashDocument.occurred_at < until,
        ).order_by(CashDocument.occurred_at.desc())
    )).all()

    inflows_customers = Decimal("0.00")
    inflows_other = Decimal("0.00")
    outflows_suppliers = Decimal("0.00")
    outflows_expenses = Decimal("0.00")
    outflows_other = Decimal("0.00")

    items = []
    for d in docs:
        amt = Decimal(str(d.amount))
        category = "other"
        if d.document_type == "income":
            if d.source_system == "customer_payment":
                inflows_customers += amt
                category = "تحصيل من عملاء"
            else:
                inflows_other += amt
                category = "إيرادات أخرى"
        elif d.document_type == "expense":
            if d.source_system == "supplier_payment":
                outflows_suppliers += amt
                category = "سداد موردين"
            elif d.source_system == "daily_expense":
                outflows_expenses += amt
                category = "مصروفات تشغيلية"
            else:
                outflows_other += amt
                category = "مصروفات أخرى"

        items.append({
            "id": d.id,
            "number": d.document_number,
            "type": d.document_type,
            "amount": float(d.amount),
            "category": category,
            "description": d.description,
            "occurred_at": d.occurred_at.isoformat() if d.occurred_at else None,
        })

    total_in = inflows_customers + inflows_other
    total_out = outflows_suppliers + outflows_expenses + outflows_other

    return {
        "period_days": since_days,
        "since": since.isoformat(),
        "summary": {
            "total_inflows": float(total_in),
            "total_outflows": float(total_out),
            "net_cash_flow": float(total_in - total_out),
            "customer_collections": float(inflows_customers),
            "supplier_payments": float(outflows_suppliers),
            "operating_expenses": float(outflows_expenses),
        },
        "items": items[:100],
    }


@router.get("/customer-statement/{customer_id}")
async def report_customer_statement(
    customer_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """كشف حساب عميل بنفس قواعد شاشة حساب العميل: المسلم − المرتجع − المحصّل المعتمد."""
    customer = await db.get(Customer, customer_id)
    if not customer:
        raise HTTPException(404, "العميل غير موجود.")

    orders_data = []
    totals = {"total_ordered": Decimal("0.00"), "total_delivered": Decimal("0.00"), "total_returned": Decimal("0.00"),
              "total_paid": Decimal("0.00"), "pending_payments": Decimal("0.00")}
    for o in await load_customer_orders(db, customer.id):
        fin = customer_order_financials(o)
        totals["total_ordered"] += fin.total_amount
        totals["total_delivered"] += fin.delivered_value
        totals["total_returned"] += fin.returned_value
        totals["total_paid"] += fin.paid_approved
        totals["pending_payments"] += fin.paid_pending
        orders_data.append({
            "order_id": o.id,
            "order_number": o.order_number,
            "order_type": o.order_type,
            "status": o.status,
            "gross_amount": float(fin.gross_amount),
            "discount_amount": float(fin.discount_amount),
            "total_amount": float(fin.total_amount),
            "delivered_value": float(fin.delivered_value),
            "returned_value": float(fin.returned_value),
            "paid_amount": float(fin.paid_approved),
            "pending_payments": float(fin.paid_pending),
            "balance_due": float(fin.receivable),
            "remaining_on_order": float(fin.remaining_on_order),
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "payments": [
                {
                    "id": p.id,
                    "receipt_number": p.receipt_number,
                    "amount": float(p.amount),
                    "method": p.method,
                    "status": p.status,
                    "received_at": p.received_at.isoformat() if p.received_at else None,
                }
                for p in o.payments
            ],
        })
    balance = totals["total_delivered"] - totals["total_returned"] - totals["total_paid"]
    return {
        "customer": {"id": customer.id, "name": customer.name, "code": customer.code, "phone": customer.phone},
        "totals": {
            "total_ordered": float(totals["total_ordered"]),
            "total_invoiced": float(totals["total_delivered"]),
            "total_returned": float(totals["total_returned"]),
            "total_paid": float(totals["total_paid"]),
            "pending_payments": float(totals["pending_payments"]),
            "balance_due": float(balance),
        },
        "orders": orders_data,
    }


@router.get("/supplier-statement/{supplier_id}")
async def report_supplier_statement(
    supplier_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """كشف حساب مورد بنفس قواعد شاشة الموردين: المستحق = قيمة المستلم − المسدد المعتمد."""
    supplier = await db.get(Supplier, supplier_id)
    if not supplier:
        raise HTTPException(404, "المورد غير موجود.")
    invoices = (await db.scalars(
        select(SupplierInvoice).where(SupplierInvoice.supplier_id == supplier.id).order_by(SupplierInvoice.invoice_date.desc())
    )).all()
    total_invoiced = total_received = total_paid = total_pending = Decimal("0.00")
    invoices_data = []
    for inv in invoices:
        fin = await supplier_invoice_financials(db, inv)
        if inv.status != "cancelled":
            total_invoiced += fin.invoice_total
            total_received += fin.received_value
            total_paid += fin.paid_approved
            total_pending += fin.paid_pending
        invoices_data.append({
            "invoice_id": inv.id,
            "internal_number": inv.internal_number,
            "invoice_number": inv.invoice_number,
            "invoice_date": inv.invoice_date.isoformat() if inv.invoice_date else None,
            "status": inv.status,
            "invoice_total": float(fin.invoice_total),
            "received_value": float(fin.received_value),
            "paid_total": float(fin.paid_approved),
            "pending_payments": float(fin.paid_pending),
            "balance_due": float(fin.payable_balance),
            "remaining_on_invoice": float(fin.balance_due),
        })
    return {
        "supplier": {"id": supplier.id, "code": supplier.code, "name": supplier.name, "phone": supplier.phone},
        "totals": {
            "total_invoiced": float(total_invoiced),
            "total_received": float(total_received),
            "total_paid": float(total_paid),
            "pending_payments": float(total_pending),
            "balance_due": float(total_received - total_paid),
        },
        "invoices": invoices_data,
    }


@router.get("/custody-reconciliation")
async def report_custody_reconciliation(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقرير مطابقة وتسوية العهد النقدية للموظفين."""
    accounts = (await db.scalars(
        select(CashAccount).where(CashAccount.account_type == "petty_cash").order_by(CashAccount.created_at.desc())
    )).all()

    items = []
    total_original = Decimal("0.00")
    total_expenses = Decimal("0.00")
    total_returned = Decimal("0.00")
    total_remaining = Decimal("0.00")

    for acc in accounts:
        funded = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(
                CashLedgerEntry.account_id == acc.id,
                CashLedgerEntry.amount > 0,
            )
        ) or 0))
        expenses = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(func.abs(CashLedgerEntry.amount)), 0)).where(
                CashLedgerEntry.account_id == acc.id,
                CashLedgerEntry.amount < 0,
            )
        ) or 0))
        current_bal = funded - expenses

        # أحدث تسوية رسمية إن وجدت
        settlement = await db.scalar(
            select(CustodySettlement)
            .where(CustodySettlement.custody_account_id == acc.id)
            .order_by(CustodySettlement.created_at.desc())
        )

        returned = settlement.returned_cash_amount if settlement else Decimal("0.00")
        unsettled = settlement.remaining_unsettled_amount if settlement else current_bal

        total_original += funded
        total_expenses += expenses
        total_returned += returned
        total_remaining += unsettled

        items.append({
            "account_id": acc.id,
            "account_number": acc.account_number,
            "name": acc.name,
            "is_active": acc.is_active,
            "status": "نشط" if acc.is_active else "تمت التسوية والإغلاق",
            "original_amount": float(funded),
            "approved_expenses": float(expenses),
            "returned_to_treasury": float(returned),
            "current_balance": float(current_bal),
            "remaining_unsettled": float(unsettled),
            "settlement_number": settlement.settlement_number if settlement else None,
            "is_balanced": (funded == (expenses + returned + (Decimal("0.00") if not acc.is_active else current_bal))),
        })

    return {
        "totals": {
            "original_amount": float(total_original),
            "approved_expenses": float(total_expenses),
            "returned_cash": float(total_returned),
            "remaining_unsettled": float(total_remaining),
        },
        "accounts": items,
    }


@router.get("/inventory-valuation")
async def report_inventory_valuation(
    warehouse_code: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقييم المخزون المالي بمتوسط التكلفة المرجح (WAC) لكل صنف ومخزن."""
    warehouses = (await db.scalars(select(Warehouse).where(Warehouse.is_active.is_(True)))).all()
    if warehouse_code:
        warehouses = [w for w in warehouses if w.code == warehouse_code]

    valuation_by_warehouse = {}
    grand_total_valuation = Decimal("0.00")

    # رصيد كل صنف في كل مخزن باستعلام واحد (بدل استعلام لكل صنف × مخزن)
    balance_rows = (await db.execute(
        select(StockLedgerEntry.warehouse_id, StockLedgerEntry.item_id, func.sum(StockLedgerEntry.quantity))
        .where(
            StockLedgerEntry.warehouse_id.in_([w.id for w in warehouses]),
            StockLedgerEntry.location_type == "warehouse",
        )
        .group_by(StockLedgerEntry.warehouse_id, StockLedgerEntry.item_id)
    )).all() if warehouses else []
    positive = {(wid, iid): Decimal(str(q or 0)) for wid, iid, q in balance_rows if Decimal(str(q or 0)) > 0}
    item_ids = {iid for _, iid in positive}
    items_by_id = {
        it.id: it for it in (await db.scalars(
            select(CatalogItem).where(CatalogItem.id.in_(item_ids), CatalogItem.is_active.is_(True))
        )).all()
    } if item_ids else {}
    units_by_id = {u.id: u for u in (await db.scalars(select(Unit))).all()}

    for wh in warehouses:
        wh_rows = []
        wh_total = Decimal("0.00")

        for item in sorted((items_by_id[iid] for (wid, iid) in positive if wid == wh.id and iid in items_by_id), key=lambda it: it.code):
            qty = positive[(wh.id, item.id)]
            wac = await get_weighted_average_cost(db, item.id, wh.id)
            total_val = (qty * wac).quantize(Decimal("0.01"))
            wh_total += total_val

            unit = units_by_id.get(item.unit_id)
            wh_rows.append({
                "item_id": item.id,
                "item_code": item.code,
                "item_name_ar": item.name_ar,
                "unit_name_ar": unit.name_ar if unit else "",
                "quantity": float(qty),
                "wac_unit_cost": float(wac),
                "total_valuation": float(total_val),
            })

        grand_total_valuation += wh_total
        valuation_by_warehouse[wh.code] = {
            "warehouse_name_ar": wh.name_ar,
            "warehouse_code": wh.code,
            "total_valuation": float(wh_total),
            "items": wh_rows,
        }

    return {
        "grand_total_valuation": float(grand_total_valuation),
        "warehouses": valuation_by_warehouse,
    }


@router.get("/wip-valuation")
async def report_wip_valuation(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقييم الإنتاج تحت التشغيل (WIP) وتكلفة الأوامر المفتوحة."""
    orders = (await db.scalars(
        select(ProductionOrder)
        .where(ProductionOrder.status.in_(["materials_dispatched", "in_production", "manufacturing_completed", "receipt_completed"]))
        .order_by(ProductionOrder.created_at.desc())
    )).all()

    total_wip = Decimal("0.00")
    total_materials = Decimal("0.00")
    total_labor = Decimal("0.00")
    total_overhead = Decimal("0.00")
    rows = []

    for o in orders:
        product = await db.get(Product, o.product_id)
        total_wip += o.wip_balance
        total_materials += o.actual_material_cost
        total_labor += o.actual_labor_cost
        total_overhead += o.actual_overhead_cost

        has_labor_overhead = (o.actual_labor_cost > Decimal("0.00") or o.actual_overhead_cost > Decimal("0.00"))
        costing_status = "complete" if has_labor_overhead else "incomplete_materials_only"

        rows.append({
            "order_id": o.id,
            "order_number": o.order_number,
            "product_name": product.name_ar if product else "",
            "season": o.season,
            "target_quantity": o.target_quantity,
            "status": o.status,
            "costing_status": costing_status,
            "is_cost_complete": has_labor_overhead,
            "material_cost": float(o.actual_material_cost),
            "labor_cost": float(o.actual_labor_cost),
            "overhead_cost": float(o.actual_overhead_cost),
            "total_actual_cost": float(o.total_actual_cost),
            "wip_balance": float(o.wip_balance),
            "unit_manufacturing_cost": float(o.unit_manufacturing_cost),
        })

    return {
        "totals": {
            "total_wip_balance": float(total_wip),
            "total_materials_cost": float(total_materials),
            "total_labor_cost": float(total_labor),
            "total_overhead_cost": float(total_overhead),
            "active_orders_count": len(rows),
        },
        "orders": rows,
    }


@router.get("/cogs")
async def report_cogs(
    since_days: int = Query(default=30, ge=1, le=365),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقرير تكلفة البضاعة المباعة (COGS) المستخرجة من قيود تسليمات العملاء."""
    since, until = _since_bounds(since_days, date_from, date_to)

    entries = (await db.scalars(
        select(StockLedgerEntry).where(
            StockLedgerEntry.entry_type == "customer_delivery_dispatch",
            StockLedgerEntry.created_at >= since,
            StockLedgerEntry.created_at < until,
        ).order_by(StockLedgerEntry.created_at.desc())
    )).all()

    total_cogs = Decimal("0.00")
    items = []
    for entry in entries:
        catalog_item = await db.get(CatalogItem, entry.item_id)
        delivery = await db.get(CustomerDelivery, entry.reference_doc_id)
        cost_val = abs(entry.total_cost)
        total_cogs += cost_val

        items.append({
            "delivery_number": delivery.delivery_number if delivery else entry.reference_doc_id,
            "delivered_at": entry.created_at.isoformat(),
            "item_code": catalog_item.code if catalog_item else "",
            "item_name_ar": catalog_item.name_ar if catalog_item else "",
            "quantity": abs(entry.quantity),
            "unit_cost": float(entry.unit_cost),
            "total_cogs": float(cost_val),
        })

    return {
        "period_days": since_days,
        "total_cogs": float(total_cogs),
        "items_count": len(items),
        "entries": items[:100],
    }


@router.get("/production-cost-analysis/{order_id}")
async def report_production_cost_analysis(
    order_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تحليل تفصيلي لتكلفة أمر تشغيل: خامات، تشغيل، انحرافات وتكلفة القطعة مع فصل مكونات التكلفة."""
    order = await db.get(ProductionOrder, order_id)
    if not order:
        raise HTTPException(404, "أمر التشغيل غير موجود.")

    product = await db.get(Product, order.product_id)
    materials = (await db.scalars(
        select(ProductionOrderMaterial).where(ProductionOrderMaterial.order_id == order.id)
    )).all()

    materials_detail = []
    for mat in materials:
        item = await db.get(CatalogItem, mat.item_id)
        unit = await db.get(Unit, mat.unit_id)
        materials_detail.append({
            "item_code": item.code if item else "",
            "item_name_ar": item.name_ar if item else mat.item_name_snapshot,
            "unit": unit.name_ar if unit else "",
            "planned_quantity": mat.planned_quantity,
            "dispatched_quantity": mat.dispatched_quantity,
            "received_quantity": mat.received_quantity,
            "discrepancy": mat.discrepancy_quantity,
            "unit_cost": float(mat.unit_cost),
            "total_cost": float(mat.total_cost),
            "status": mat.status,
        })

    has_labor_overhead = (order.actual_labor_cost > Decimal("0.00") or order.actual_overhead_cost > Decimal("0.00"))
    costing_status = "complete" if has_labor_overhead else "incomplete_materials_only"

    defects = (await db.scalars(
        select(ProductionDefect).where(ProductionDefect.order_id == order.id)
    )).all()
    defect_count = len(defects)
    affected_defects_qty = sum((d.affected_quantity for d in defects), 0.0)

    return {
        "order_id": order.id,
        "order_number": order.order_number,
        "product_name": product.name_ar if product else "",
        "season": order.season,
        "target_quantity": order.target_quantity,
        "status": order.status,
        "costing_status": costing_status,
        "is_cost_complete": has_labor_overhead,
        "cost_summary": {
            "planned_material_cost": float(order.planned_material_cost),
            "material_cost": float(order.actual_material_cost),
            "direct_labor_cost": float(order.actual_labor_cost),
            "operation_cost": 0.0,
            "allocated_overhead": float(order.actual_overhead_cost),
            "total_actual_manufacturing_cost": float(order.total_actual_cost),
            "actual_unit_cost": float(order.unit_manufacturing_cost),
            "wip_balance": float(order.wip_balance),
        },
        "quality_metrics": {
            "defect_records_count": defect_count,
            "affected_defects_quantity": float(affected_defects_qty),
        },
        "materials": materials_detail,
    }


# ─── التقارير المالية المتكاملة (قائمة الدخل، الميزانية، الأستاذ، ذمم العملاء والموردين) ───

@router.get("/profit-and-loss")
async def report_profit_and_loss(
    since_days: Optional[int] = Query(default=None, ge=1, le=730),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """
    قائمة الأرباح والخسائر (Income Statement / P&L):
    - الإيرادات (4100 مبيعات منتجات تامة، 4200 إيرادات تشغيل)
    - تكلفة البضاعة المباعة (5100 COGS، 5200 هالك وفروق تشغيل)
    - إجمالي الربح التشغيلي
    - المصروفات التشغيلية والعمومية (5300، 5400)
    - صافي أرباح / خسائر الفترة
    """
    accounts = (await db.scalars(select(Account).where(Account.is_active.is_(True)))).all()
    accounts_by_code = {a.code: a for a in accounts}

    since_date = (datetime.now(timezone.utc) - timedelta(days=since_days)).date() if since_days else None

    async def get_account_net(code_prefix: str, nature: str) -> tuple[Decimal, list]:
        matched_accounts = [a for code, a in accounts_by_code.items() if code.startswith(code_prefix)]
        total = Decimal("0.00")
        items = []
        for acc in matched_accounts:
            q_dr = select(func.coalesce(func.sum(JournalEntryLine.debit), 0)).join(
                JournalEntry, JournalEntry.id == JournalEntryLine.entry_id
            ).where(JournalEntryLine.account_id == acc.id)
            q_cr = select(func.coalesce(func.sum(JournalEntryLine.credit), 0)).join(
                JournalEntry, JournalEntry.id == JournalEntryLine.entry_id
            ).where(JournalEntryLine.account_id == acc.id)
            if since_date:
                q_dr = q_dr.where(JournalEntry.entry_date >= since_date)
                q_cr = q_cr.where(JournalEntry.entry_date >= since_date)
            dr = Decimal(str(await db.scalar(q_dr) or 0))
            cr = Decimal(str(await db.scalar(q_cr) or 0))
            net = (cr - dr) if nature == "credit" else (dr - cr)
            if dr != 0 or cr != 0:
                items.append({
                    "code": acc.code,
                    "name_ar": acc.name_ar,
                    "debit": float(dr),
                    "credit": float(cr),
                    "net_amount": float(net),
                })
                total += net
        return total, items

    rev_sales, sales_items = await get_account_net("4100", "credit")
    rev_services, service_items = await get_account_net("4200", "credit")
    total_revenue = rev_sales + rev_services
    revenue_items = sales_items + service_items

    cogs_val, cogs_items = await get_account_net("5100", "debit")
    scrap_val, scrap_items = await get_account_net("5200", "debit")
    total_cogs = cogs_val + scrap_val
    cost_of_sales_items = cogs_items + scrap_items

    gross_profit = total_revenue - total_cogs

    ops_val, ops_items = await get_account_net("5300", "debit")
    admin_val, admin_items = await get_account_net("5400", "debit")
    total_operating_expenses = ops_val + admin_val
    expense_items = ops_items + admin_items

    net_income = gross_profit - total_operating_expenses

    return {
        "period_days": since_days,
        "revenues": {
            "items": revenue_items,
            "total_revenue": float(total_revenue),
        },
        "cost_of_goods_sold": {
            "items": cost_of_sales_items,
            "total_cogs": float(total_cogs),
        },
        "gross_profit": float(gross_profit),
        "gross_profit_margin_pct": float(round((gross_profit / total_revenue * 100), 2)) if total_revenue > 0 else 0.0,
        "operating_expenses": {
            "items": expense_items,
            "total_expenses": float(total_operating_expenses),
        },
        "net_income": float(net_income),
        "net_profit_margin_pct": float(round((net_income / total_revenue * 100), 2)) if total_revenue > 0 else 0.0,
    }


@router.get("/balance-sheet")
async def report_balance_sheet(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """
    الميزانية العمومية (Balance Sheet):
    الأصول = الالتزامات + حقوق الملكية
    """
    accounts = (await db.scalars(select(Account).where(Account.is_active.is_(True)))).all()

    async def get_balance(code: str) -> tuple[Decimal, str]:
        acc = next((a for a in accounts if a.code == code), None)
        if not acc:
            return Decimal("0.00"), ""
        dr = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.debit), 0)).where(JournalEntryLine.account_id == acc.id)
        ) or 0))
        cr = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.credit), 0)).where(JournalEntryLine.account_id == acc.id)
        ) or 0))
        net = (dr - cr) if acc.account_type == "asset" else (cr - dr)
        return net, acc.name_ar

    cash_val, cash_name = await get_balance("1010")
    petty_val, petty_name = await get_balance("1020")
    banks_val, banks_name = await get_balance("1030")
    ar_val, ar_name = await get_balance("1100")
    raw_inv_val, raw_inv_name = await get_balance("1210")
    wip_inv_val, wip_inv_name = await get_balance("1220")
    fg_inv_val, fg_inv_name = await get_balance("1230")

    current_assets = [
        {"code": "1010", "name_ar": cash_name or "الخزينة الرئيسية", "amount": float(cash_val)},
        {"code": "1020", "name_ar": petty_name or "صناديق العهد النقدية", "amount": float(petty_val)},
        {"code": "1030", "name_ar": banks_name or "البنوك", "amount": float(banks_val)},
        {"code": "1100", "name_ar": ar_name or "العملاء - ذمم مدينة", "amount": float(ar_val)},
        {"code": "1210", "name_ar": raw_inv_name or "مخزون الخامات والمستلزمات", "amount": float(raw_inv_val)},
        {"code": "1220", "name_ar": wip_inv_name or "مخزون الإنتاج تحت التشغيل (WIP)", "amount": float(wip_inv_val)},
        {"code": "1230", "name_ar": fg_inv_name or "مخزون المنتجات التامة", "amount": float(fg_inv_val)},
    ]
    total_assets = sum((item["amount"] for item in current_assets), 0.0)

    ap_val, ap_name = await get_balance("2100")
    current_liabilities = [
        {"code": "2100", "name_ar": ap_name or "الموردين - ذمم دائنة", "amount": float(ap_val)},
    ]
    total_liabilities = sum((item["amount"] for item in current_liabilities), 0.0)

    capital_val, capital_name = await get_balance("3000")

    rev_dr = Decimal(str(await db.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.debit), 0))
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(Account.code.like("4%"))
    ) or 0))
    rev_cr = Decimal(str(await db.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.credit), 0))
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(Account.code.like("4%"))
    ) or 0))
    exp_dr = Decimal(str(await db.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.debit), 0))
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(Account.code.like("5%"))
    ) or 0))
    exp_cr = Decimal(str(await db.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.credit), 0))
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(Account.code.like("5%"))
    ) or 0))
    current_net_income = (rev_cr - rev_dr) - (exp_dr - exp_cr)

    equity_items = [
        {"code": "3000", "name_ar": capital_name or "رأس المال المدفوع", "amount": float(capital_val)},
        {"code": "RE", "name_ar": "صافي أرباح / خسائر الفترة الحالية", "amount": float(current_net_income)},
    ]
    total_equity = sum((item["amount"] for item in equity_items), 0.0)

    total_liabilities_and_equity = total_liabilities + total_equity
    difference = round(total_assets - total_liabilities_and_equity, 2)

    return {
        "assets": {
            "current_assets": current_assets,
            "total_assets": round(total_assets, 2),
        },
        "liabilities": {
            "current_liabilities": current_liabilities,
            "total_liabilities": round(total_liabilities, 2),
        },
        "equity": {
            "equity_items": equity_items,
            "total_equity": round(total_equity, 2),
        },
        "total_liabilities_and_equity": round(total_liabilities_and_equity, 2),
        "difference": difference,
        "is_balanced": abs(difference) < 0.01,
    }


@router.get("/general-ledger/{account_code}")
async def report_account_ledger(
    account_code: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """كشف حساب دفتر الأستاذ العام بالتفصيل مع الرصيد التراكمي المستمر."""
    account = await db.scalar(select(Account).where(Account.code == account_code.strip()))
    if not account:
        raise HTTPException(404, f"الحساب ذو الكود {account_code} غير موجود.")

    lines_res = await db.execute(
        select(JournalEntryLine, JournalEntry)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.entry_id)
        .where(JournalEntryLine.account_id == account.id)
        .order_by(JournalEntry.entry_date.asc(), JournalEntry.created_at.asc())
    )
    rows = lines_res.all()

    running_balance = Decimal("0.00")
    total_debit = Decimal("0.00")
    total_credit = Decimal("0.00")
    statement_lines = []

    is_debit_nature = account.account_type in ("asset", "expense")

    for line, je in rows:
        dr = Decimal(str(line.debit))
        cr = Decimal(str(line.credit))
        total_debit += dr
        total_credit += cr

        if is_debit_nature:
            running_balance += (dr - cr)
        else:
            running_balance += (cr - dr)

        statement_lines.append({
            "line_id": line.id,
            "entry_number": je.entry_number,
            "entry_date": je.entry_date.isoformat(),
            "reference_type": je.reference_type,
            "reference_id": je.reference_id,
            "description": line.description or je.description,
            "debit": float(dr),
            "credit": float(cr),
            "running_balance": float(running_balance),
        })

    return {
        "account": {
            "id": account.id,
            "code": account.code,
            "name_ar": account.name_ar,
            "account_type": account.account_type,
            "nature": "debit" if is_debit_nature else "credit",
        },
        "summary": {
            "total_debit": float(total_debit),
            "total_credit": float(total_credit),
            "net_balance": float(running_balance),
            "lines_count": len(statement_lines),
        },
        "lines": statement_lines,
    }


@router.get("/accounts-receivable")
async def report_accounts_receivable(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """مديونيات العملاء: المسلم − المرتجع − المحصّل المعتمد (نفس رقم شاشة حساب العميل)."""
    totals_by_customer = await customer_totals(db)
    customers = (await db.scalars(select(Customer).order_by(Customer.name.asc()))).all()
    rows = []
    sums = {"invoiced": Decimal("0.00"), "collected": Decimal("0.00"), "receivable": Decimal("0.00")}
    for cust in customers:
        t = totals_by_customer.get(cust.id)
        if t is None:
            continue
        delivered_net = t.delivered_value - t.returned_value
        sums["invoiced"] += delivered_net
        sums["collected"] += t.paid
        sums["receivable"] += t.balance
        rows.append({
            "customer_id": cust.id,
            "code": cust.code,
            "name": cust.name,
            "phone": cust.phone,
            "orders_count": t.documents_count,
            "total_ordered": float(t.total_value),
            "total_invoiced": float(delivered_net),
            "total_paid": float(t.paid),
            "pending_payments": float(t.pending_payments),
            "balance_due": float(t.balance),
        })
    return {
        "summary": {
            "total_customers": len(rows),
            "total_invoiced": float(sums["invoiced"]),
            "total_collected": float(sums["collected"]),
            "total_receivables": float(sums["receivable"]),
        },
        "customers": rows,
    }


@router.get("/accounts-payable")
async def report_accounts_payable(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """مستحقات الموردين: قيمة المستلم فعلياً − المسدد المعتمد (نفس رقم شاشة فواتير الموردين)."""
    totals_by_supplier = await supplier_totals(db)
    suppliers = (await db.scalars(select(Supplier).order_by(Supplier.name.asc()))).all()
    rows = []
    sums = {"invoiced": Decimal("0.00"), "received": Decimal("0.00"), "paid": Decimal("0.00"), "payable": Decimal("0.00")}
    for sup in suppliers:
        t = totals_by_supplier.get(sup.id)
        if t is None:
            continue
        sums["invoiced"] += t.total_value
        sums["received"] += t.delivered_value
        sums["paid"] += t.paid
        sums["payable"] += t.balance
        rows.append({
            "supplier_id": sup.id,
            "code": sup.code,
            "name": sup.name,
            "phone": sup.phone,
            "invoices_count": t.documents_count,
            "total_invoiced": float(t.total_value),
            "total_received": float(t.delivered_value),
            "total_paid": float(t.paid),
            "pending_payments": float(t.pending_payments),
            "balance_due": float(t.balance),
        })
    return {
        "summary": {
            "total_suppliers": len(rows),
            "total_invoiced": float(sums["invoiced"]),
            "total_received": float(sums["received"]),
            "total_paid": float(sums["paid"]),
            "total_payables": float(sums["payable"]),
        },
        "suppliers": rows,
    }


@router.get("/expense-analysis")
async def report_expense_analysis(
    since_days: int = Query(default=30, ge=1, le=365),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تحليل تفصيلي للمصروفات حسب الحساب والتصنيف."""
    since, until = _since_bounds(since_days, date_from, date_to)

    cash_expenses = (await db.scalars(
        select(CashDocument).where(
            CashDocument.document_type == "expense",
            CashDocument.status == "approved",
            CashDocument.occurred_at >= since,
            CashDocument.occurred_at < until,
        )
    )).all()

    by_category = {}
    total = Decimal("0.00")
    for doc in cash_expenses:
        amt = Decimal(str(doc.amount))
        cat = doc.source_system or "other"
        by_category[cat] = by_category.get(cat, Decimal("0.00")) + amt
        total += amt

    categories_list = [
        {"category": k, "amount": float(v), "percentage": float(round((v / total * 100), 1)) if total > 0 else 0.0}
        for k, v in by_category.items()
    ]
    categories_list.sort(key=lambda x: x["amount"], reverse=True)

    return {
        "period_days": since_days,
        "total_expenses": float(total),
        "categories": categories_list,
        "items_count": len(cash_expenses),
    }


@router.get("/revenue-analysis")
async def report_revenue_analysis(
    since_days: int = Query(default=30, ge=1, le=365),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """
    تحليل الإيرادات حسب العميل (صافي قيمة التسليمات بعد خصم الطلب).

    يستخدم محرك الأرصدة الموحد (balances.py): قيمة كل تسليم = Σ(الكمية × السعر) × نسبة
    صافي البيع للطلب — فتطابق هذه الأرقام أرصدة العملاء وتحليلات المبيعات حتى آخر قرش،
    بدلاً من حساب الإيراد بالسعر الخام متجاهلاً خصم الطلب، ودون استعلام لكل تسليم وبند (N+1).
    """
    since, until = _since_bounds(since_days, date_from, date_to)

    orders = await load_customer_orders(db)
    customer_ids = {order.customer_id for order in orders}
    customer_names: dict[str, str] = {}
    if customer_ids:
        customer_names = dict(
            (await db.execute(select(Customer.id, Customer.name).where(Customer.id.in_(customer_ids)))).all()
        )

    by_customer: dict[str, Decimal] = {}
    total_rev = Decimal("0.00")
    deliveries_count = 0

    for order in orders:
        fin = customer_order_financials(order)
        price_by_line = {line.id: Decimal(str(line.unit_price)) for line in order.lines}
        for delivery in order.deliveries:
            if not delivery.delivered_at or not (since <= delivery.delivered_at < until):
                continue
            deliveries_count += 1
            del_val = document_net_sales_value(
                [
                    (dl.quantity, price_by_line.get(dl.order_line_id, Decimal("0")))
                    for dl in delivery.lines
                ],
                fin.net_ratio,
            )
            cust_name = customer_names.get(order.customer_id, "عميل غير محدد")
            by_customer[cust_name] = by_customer.get(cust_name, Decimal("0.00")) + del_val
            total_rev += del_val

    customers_list = [
        {"customer_name": k, "delivered_revenue": float(v), "percentage": float(round((v / total_rev * 100), 1)) if total_rev > 0 else 0.0}
        for k, v in by_customer.items()
    ]
    customers_list.sort(key=lambda x: x["delivered_revenue"], reverse=True)

    return {
        "period_days": since_days,
        "total_revenue": float(total_rev),
        "by_customer": customers_list,
        "deliveries_count": deliveries_count,
    }



# ═══════════════════════════════════════════════════════════════════════════════
# التحليلات: فترات بالتقويم (توقيت القاهرة) ومقارنة بالفترة السابقة
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/analytics/overview")
async def report_analytics_overview(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """نظرة عامة: مؤشرات الفترة مقارنة بالسابقة، الموقف الحالي، الاتجاه الشهري، وتوزيع المصروفات."""
    return await analytics.overview(db, analytics.resolve_period(date_from, date_to))


@router.get("/analytics/aging")
async def report_analytics_aging(
    party: str = Query(default="customers", pattern="^(customers|suppliers)$"),
    as_of: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """أعمار ديون العملاء أو مستحقات الموردين (0–30، 31–60، 61–90، +90 يوماً)."""
    return await analytics.aging(db, party, as_of)


@router.get("/analytics/sales")
async def report_analytics_sales(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تحليل المبيعات المسلمة حسب العميل والموديل والمقاس، ومتوسط السعر والخصومات."""
    return await analytics.sales_analysis(db, analytics.resolve_period(date_from, date_to))


@router.get("/analytics/model-profitability")
async def report_analytics_model_profitability(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """ربحية الموديلات: صافي المبيعات مقابل تكلفة المنتج التام المسلم."""
    return await analytics.model_profitability(db, analytics.resolve_period(date_from, date_to))


@router.get("/analytics/payroll-cost")
async def report_analytics_payroll_cost(
    months: int = Query(default=12, ge=1, le=24),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تكلفة الرواتب المصروفة شهرياً حسب القسم ونسبتها من المبيعات."""
    return await analytics.payroll_cost(db, months)


@router.get("/analytics/losses")
async def report_analytics_losses(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """الهالك والعجز بقيمته: عجز الجرد، فروق الورشة، تالف التسوية، وعدد العيوب."""
    return await analytics.losses(db, analytics.resolve_period(date_from, date_to))


@router.get("/analytics/stock-health")
async def report_analytics_stock_health(
    idle_days: int = Query(default=60, ge=7, le=365),
    current_user: AuthenticatedUser = Depends(require_any_permission("finance:reports:view", "inventory:view")),
    db: AsyncSession = Depends(get_db),
):
    """المخزون الراكد (بلا حركة منذ عدد أيام) والأصناف تحت حد إعادة الطلب في مخزن الخامات."""
    return await analytics.stock_health(db, idle_days)
