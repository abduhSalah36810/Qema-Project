"""
تحليلات التقارير المالية والتشغيلية (للقراءة فقط).
─────────────────────────────────────────────────────────────────────────────
- الفترات بالتقويم وبتوقيت القاهرة (من/إلى بالتاريخ)، مع مقارنة بالفترة السابقة بنفس الطول.
- كل الأرقام من الدفاتر والمستندات المعتمدة نفسها التي تعتمد عليها الشاشات:
  المبيعات = قيمة المسلم الصافية بعد الخصم − المرتجع (نفس customer_order_financials)،
  التكلفة = قيود صرف المنتج التام للعملاء في دفتر المخزون،
  النقدية = المستندات النقدية المعتمدة (التحويلات الداخلية لا تُحسب قبضاً ولا صرفاً).
- «الصافي التشغيلي» مؤشر تقريبي (مبيعات − تكلفة − مصروفات − رواتب) وليس قائمة دخل رسمية.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.customers.models import CustomerDeliveryReturn
from app.modules.finance.balances import load_customer_orders, money, supplier_invoice_financials
from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry, Supplier, SupplierInvoice
from app.modules.production.models import (
    CatalogItem,
    Customer,
    Employee,
    PayPeriod,
    PayrollRun,
    Product,
    ProductionDefect,
    ProductionMaterialReconciliation,
    ProductionMaterialReconciliationLine,
    ProductionOrderMaterial,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
)

CAIRO = ZoneInfo("Africa/Cairo")
ZERO = Decimal("0.00")
AGING_BUCKETS = (("0_30", "حتى 30 يوماً", 0, 30), ("31_60", "31 – 60 يوماً", 31, 60), ("61_90", "61 – 90 يوماً", 61, 90), ("90_plus", "أكثر من 90 يوماً", 91, None))
SEASON_AR = {"summer": "صيفي", "autumn": "خريفي", "winter": "شتوي"}
EXPENSE_SOURCE_AR = {
    "supplier_payment": "سداد موردين",
    "payroll": "رواتب",
    "daily_expense": "مصروفات العهد اليومية",
    None: "مصروفات أخرى",
}
_CLASSIFICATION = re.compile(r"^\[([^\]]+)\]")


# ─── الفترة ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Period:
    start: datetime  # UTC
    end: datetime    # UTC (حصري)
    date_from: date
    date_to: date

    @property
    def days(self) -> int:
        return (self.date_to - self.date_from).days + 1

    def previous(self) -> "Period":
        prev_to = self.date_from - timedelta(days=1)
        return make_period(prev_to - timedelta(days=self.days - 1), prev_to)


def _cairo_midnight_utc(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=CAIRO).astimezone(timezone.utc)


def make_period(date_from: date, date_to: date) -> Period:
    if date_to < date_from:
        raise HTTPException(422, "تاريخ النهاية قبل تاريخ البداية.")
    if (date_to - date_from).days > 731:
        raise HTTPException(422, "أقصى مدة للتقرير سنتان.")
    return Period(_cairo_midnight_utc(date_from), _cairo_midnight_utc(date_to + timedelta(days=1)), date_from, date_to)


def resolve_period(date_from: date | None, date_to: date | None) -> Period:
    """الافتراضي: الشهر الحالي حتى اليوم (بتوقيت القاهرة)."""
    today = datetime.now(CAIRO).date()
    return make_period(date_from or today.replace(day=1), date_to or today)


def cairo_month(dt: datetime) -> str:
    return dt.astimezone(CAIRO).strftime("%Y-%m")


def last_months(n: int, until: date | None = None) -> list[str]:
    cur = (until or datetime.now(CAIRO).date()).replace(day=1)
    months = []
    for _ in range(n):
        months.append(cur.strftime("%Y-%m"))
        cur = (cur - timedelta(days=1)).replace(day=1)
    return list(reversed(months))


def _f(value: Decimal) -> float:
    return float(money(value))


def _pct(part: Decimal, whole: Decimal) -> float | None:
    return float(round(part / whole * 100, 1)) if whole else None


# ─── المبيعات والتكلفة ───────────────────────────────────────────────────────

@dataclass
class SaleEvent:
    at: datetime
    customer_id: str
    order_id: str
    product_id: str
    variant_id: str
    quantity: Decimal  # سالبة للمرتجع
    net_value: Decimal  # بعد نسبة الخصم، سالبة للمرتجع


async def sale_events(db: AsyncSession, start: datetime | None = None, end: datetime | None = None) -> list[SaleEvent]:
    """كل تسليم ومرتجع على مستوى السطر بقيمته الصافية (نفس نسبة الخصم المستخدمة في الأرصدة)."""
    events: list[SaleEvent] = []
    for order in await load_customer_orders(db):
        gross = sum((Decimal(str(l.quantity)) * Decimal(str(l.unit_price)) for l in order.lines), Decimal("0"))
        ratio = ((gross - money(order.discount_amount)) / gross) if gross > 0 else Decimal("1")
        lines = {l.id: l for l in order.lines}
        for delivery in order.deliveries or []:
            for dl in delivery.lines:
                ol = lines.get(dl.order_line_id)
                if ol is None:
                    continue
                qty = Decimal(str(dl.quantity))
                events.append(SaleEvent(delivery.delivered_at, order.customer_id, order.id, ol.product_id, ol.variant_id,
                                        qty, qty * Decimal(str(ol.unit_price)) * ratio))
        for ret in order.returns or []:
            for rl in ret.lines:
                ol = lines.get(rl.order_line_id)
                if ol is None:
                    continue
                qty = Decimal(str(rl.quantity))
                events.append(SaleEvent(ret.returned_at, order.customer_id, order.id, ol.product_id, ol.variant_id,
                                        -qty, -qty * Decimal(str(ol.unit_price)) * ratio))
    if start is not None:
        events = [e for e in events if e.at >= start and (end is None or e.at < end)]
    return events


async def cogs_by_variant(db: AsyncSession, start: datetime, end: datetime) -> dict[str, Decimal]:
    """تكلفة البضاعة المسلمة (صافي المرتجع) لكل مقاس من دفتر المخزون. كود صنف التام: FG-VAR-{variant_id}."""
    rows = (await db.execute(
        select(CatalogItem.code, func.coalesce(func.sum(StockLedgerEntry.total_cost), 0))
        .join(CatalogItem, CatalogItem.id == StockLedgerEntry.item_id)
        .where(
            StockLedgerEntry.entry_type.in_(("customer_delivery_dispatch", "customer_delivery_return")),
            StockLedgerEntry.created_at >= start, StockLedgerEntry.created_at < end,
        )
        .group_by(CatalogItem.code)
    )).all()
    out: dict[str, Decimal] = {}
    for code, total in rows:
        if code and code.startswith("FG-VAR-"):
            # الصرف للعميل بقيمة سالبة والمرتجع موجب؛ التكلفة = −المجموع
            out[code[len("FG-VAR-"):]] = -Decimal(str(total or 0))
    return out


# ─── النقدية ─────────────────────────────────────────────────────────────────

def expense_category(doc: CashDocument) -> str:
    if doc.source_system in EXPENSE_SOURCE_AR and doc.source_system is not None:
        return EXPENSE_SOURCE_AR[doc.source_system]
    match = _CLASSIFICATION.match(doc.description or "")
    return match.group(1).strip() if match else EXPENSE_SOURCE_AR[None]


async def approved_cash_docs(db: AsyncSession, start: datetime, end: datetime) -> list[CashDocument]:
    return list((await db.scalars(select(CashDocument).where(
        CashDocument.status == "approved", CashDocument.occurred_at >= start, CashDocument.occurred_at < end,
    ))).all())


def cash_figures(docs: list[CashDocument]) -> dict[str, Decimal]:
    f = {k: ZERO for k in ("collections", "other_income", "supplier_payments", "payroll", "operating_expenses")}
    for d in docs:
        amt = money(d.amount)
        if d.document_type == "income":
            f["collections" if d.source_system == "customer_payment" else "other_income"] += amt
        elif d.document_type == "expense":
            if d.source_system == "supplier_payment":
                f["supplier_payments"] += amt
            elif d.source_system == "payroll":
                f["payroll"] += amt
            else:
                f["operating_expenses"] += amt
    f["inflows"] = f["collections"] + f["other_income"]
    f["outflows"] = f["supplier_payments"] + f["payroll"] + f["operating_expenses"]
    f["net_cash"] = f["inflows"] - f["outflows"]
    return f


async def _period_figures(db: AsyncSession, p: Period) -> dict[str, Decimal]:
    cash = cash_figures(await approved_cash_docs(db, p.start, p.end))
    events = await sale_events(db, p.start, p.end)
    sales = sum((e.net_value for e in events), ZERO)
    cogs = sum((await cogs_by_variant(db, p.start, p.end)).values(), ZERO)
    gross_profit = sales - cogs
    return {
        **cash,
        "sales": sales,
        "cogs": cogs,
        "gross_profit": gross_profit,
        "operating_result": gross_profit - cash["operating_expenses"] - cash["payroll"],
    }


async def overview(db: AsyncSession, p: Period) -> dict:
    cur, prev = await _period_figures(db, p), await _period_figures(db, p.previous())
    kpis = []
    labels = {
        "sales": "صافي المبيعات المسلمة", "cogs": "تكلفة البضاعة المسلمة", "gross_profit": "مجمل الربح",
        "operating_expenses": "المصروفات التشغيلية", "payroll": "الرواتب المصروفة",
        "operating_result": "الصافي التشغيلي (تقريبي)", "collections": "تحصيلات العملاء",
        "supplier_payments": "مدفوعات الموردين", "net_cash": "صافي الحركة النقدية",
    }
    for key, label in labels.items():
        c, pv = cur[key], prev[key]
        kpis.append({
            "key": key, "label": label, "value": _f(c), "previous": _f(pv),
            "change_pct": _pct(c - pv, abs(pv)) if pv else None,
        })

    treasury = await db.scalar(select(func.coalesce(func.sum(CashLedgerEntry.amount), 0))
                               .join(CashAccount, CashAccount.id == CashLedgerEntry.account_id)
                               .where(CashAccount.account_type == "treasury"))
    custody = await db.scalar(select(func.coalesce(func.sum(CashLedgerEntry.amount), 0))
                              .join(CashAccount, CashAccount.id == CashLedgerEntry.account_id)
                              .where(CashAccount.account_type == "petty_cash"))
    receivables = await aging(db, "customers")
    payables = await aging(db, "suppliers")

    # الاتجاه الشهري لآخر 12 شهراً
    months = last_months(12, p.date_to)
    first = make_period(date.fromisoformat(months[0] + "-01"), p.date_to)
    monthly = {m: {k: ZERO for k in ("inflows", "outflows", "sales", "cogs", "operating_expenses", "payroll")} for m in months}
    for d in await approved_cash_docs(db, first.start, first.end):
        m = cairo_month(d.occurred_at)
        if m not in monthly:
            continue
        fig = cash_figures([d])
        for k in ("inflows", "outflows", "operating_expenses", "payroll"):
            monthly[m][k] += fig[k]
    for e in await sale_events(db, first.start, first.end):
        m = cairo_month(e.at)
        if m in monthly:
            monthly[m]["sales"] += e.net_value
    cogs_rows = (await db.execute(
        select(StockLedgerEntry.created_at, StockLedgerEntry.total_cost).where(
            StockLedgerEntry.entry_type.in_(("customer_delivery_dispatch", "customer_delivery_return")),
            StockLedgerEntry.created_at >= first.start, StockLedgerEntry.created_at < first.end,
        )
    )).all()
    for at, total in cogs_rows:
        m = cairo_month(at)
        if m in monthly:
            monthly[m]["cogs"] -= Decimal(str(total or 0))
    trend = [{"month": m, **{k: _f(v) for k, v in vals.items()},
              "net_cash": _f(vals["inflows"] - vals["outflows"]),
              "gross_profit": _f(vals["sales"] - vals["cogs"])} for m, vals in monthly.items()]

    by_cat: dict[str, Decimal] = {}
    for d in await approved_cash_docs(db, p.start, p.end):
        if d.document_type == "expense":
            cat = expense_category(d)
            by_cat[cat] = by_cat.get(cat, ZERO) + money(d.amount)
    total_exp = sum(by_cat.values(), ZERO)
    expenses = sorted(({"category": k, "amount": _f(v), "percentage": _pct(v, total_exp) or 0.0} for k, v in by_cat.items()),
                      key=lambda r: -r["amount"])

    return {
        "period": {"date_from": p.date_from.isoformat(), "date_to": p.date_to.isoformat()},
        "previous_period": {"date_from": p.previous().date_from.isoformat(), "date_to": p.previous().date_to.isoformat()},
        "kpis": kpis,
        "position": {
            "treasury_balance": _f(Decimal(str(treasury or 0))),
            "custody_balance": _f(Decimal(str(custody or 0))),
            "receivables": receivables["totals"]["total"],
            "receivables_overdue_90": receivables["totals"]["90_plus"],
            "payables": payables["totals"]["total"],
        },
        "monthly": trend,
        "expense_breakdown": expenses,
        "gross_margin_pct": _pct(cur["gross_profit"], cur["sales"]),
    }


# ─── أعمار الديون ────────────────────────────────────────────────────────────

def _bucket(age_days: int) -> str:
    for key, _, low, high in AGING_BUCKETS:
        if age_days >= low and (high is None or age_days <= high):
            return key
    return "0_30"


def _empty_buckets() -> dict[str, Decimal]:
    return {key: ZERO for key, *_ in AGING_BUCKETS}


async def aging(db: AsyncSession, party: str, as_of: date | None = None) -> dict:
    """
    أعمار الديون في تاريخ معين.
    العملاء: كل تسليم (بعد خصم المرتجع منه) دين بتاريخه، والتحصيلات المعتمدة تُطبق على الأقدم أولاً.
    الموردون: المستحق عن كل فاتورة (قيمة المستلم − المسدد المعتمد) بعمر تاريخ الفاتورة.
    """
    now = _cairo_midnight_utc((as_of or datetime.now(CAIRO).date()) + timedelta(days=1))
    rows = []
    if party == "customers":
        names = {c.id: (c.code, c.name, c.phone) for c in (await db.scalars(select(Customer))).all()}
        by_customer: dict[str, dict] = {}
        for order in await load_customer_orders(db):
            gross = sum((Decimal(str(l.quantity)) * Decimal(str(l.unit_price)) for l in order.lines), Decimal("0"))
            ratio = ((gross - money(order.discount_amount)) / gross) if gross > 0 else Decimal("1")
            prices = {l.id: Decimal(str(l.unit_price)) for l in order.lines}
            acc = by_customer.setdefault(order.customer_id, {"debts": [], "paid": ZERO, "unapplied_returns": ZERO})
            for delivery in order.deliveries or []:
                value = money(sum((Decimal(str(dl.quantity)) * prices.get(dl.order_line_id, Decimal("0")) for dl in delivery.lines), Decimal("0")) * ratio)
                if delivery.delivered_at < now:
                    acc["debts"].append([delivery.delivered_at, value])
            for ret in order.returns or []:
                if ret.returned_at < now:
                    acc["unapplied_returns"] += money(sum((Decimal(str(rl.quantity)) * prices.get(rl.order_line_id, Decimal("0")) for rl in ret.lines), Decimal("0")) * ratio)
            for pay in order.payments or []:
                if (getattr(pay, "status", "approved") or "approved") == "approved" and pay.received_at < now:
                    acc["paid"] += money(pay.amount)
        for cid, acc in by_customer.items():
            credit = acc["paid"] + acc["unapplied_returns"]
            buckets = _empty_buckets()
            oldest = None
            for at, value in sorted(acc["debts"], key=lambda x: x[0]):
                applied = min(value, credit)
                credit -= applied
                remaining = value - applied
                if remaining > 0:
                    buckets[_bucket((now - at).days)] += remaining
                    oldest = oldest or at
            total = sum(buckets.values(), ZERO)
            if total <= 0:
                continue
            code, name, phone = names.get(cid, ("", "عميل غير محدد", ""))
            rows.append({"party_id": cid, "code": code, "name": name, "phone": phone or "",
                         "oldest_days": (now - oldest).days if oldest else 0,
                         **{k: _f(v) for k, v in buckets.items()}, "total": _f(total)})
    elif party == "suppliers":
        names = {s.id: (s.code, s.name, s.phone) for s in (await db.scalars(select(Supplier))).all()}
        by_supplier: dict[str, dict] = {}
        invoices = (await db.scalars(select(SupplierInvoice).where(SupplierInvoice.status != "cancelled",
                                                                    SupplierInvoice.invoice_date < now))).all()
        for inv in invoices:
            fin = await supplier_invoice_financials(db, inv)
            due = fin.received_value - fin.paid_approved
            if due <= 0:
                continue
            acc = by_supplier.setdefault(inv.supplier_id, {"buckets": _empty_buckets(), "oldest": None})
            acc["buckets"][_bucket((now - inv.invoice_date).days)] += due
            acc["oldest"] = min(acc["oldest"], inv.invoice_date) if acc["oldest"] else inv.invoice_date
        for sid, acc in by_supplier.items():
            code, name, phone = names.get(sid, ("", "مورد غير محدد", ""))
            total = sum(acc["buckets"].values(), ZERO)
            rows.append({"party_id": sid, "code": code, "name": name, "phone": phone or "",
                         "oldest_days": (now - acc["oldest"]).days,
                         **{k: _f(v) for k, v in acc["buckets"].items()}, "total": _f(total)})
    else:
        raise HTTPException(422, "نوع الطرف يجب أن يكون customers أو suppliers.")
    rows.sort(key=lambda r: -r["total"])
    totals = {key: sum((Decimal(str(r[key])) for r in rows), ZERO) for key, *_ in AGING_BUCKETS}
    totals["total"] = sum(totals.values(), ZERO)
    return {
        "party": party,
        "as_of": (as_of or datetime.now(CAIRO).date()).isoformat(),
        "buckets": [{"key": k, "label": label} for k, label, *_ in AGING_BUCKETS],
        "rows": rows,
        "totals": {k: _f(v) for k, v in totals.items()},
    }


# ─── تحليل المبيعات وربحية الموديلات ────────────────────────────────────────

async def _variant_labels(db: AsyncSession, variant_ids: set[str]) -> dict[str, str]:
    if not variant_ids:
        return {}
    out = {}
    for v in (await db.scalars(select(ProductVariant).where(ProductVariant.id.in_(variant_ids)))).all():
        parts = [str(v.numeric_size), v.letter_size or "", SEASON_AR.get(v.season or "", v.season or "")]
        out[v.id] = " · ".join(p for p in parts if p)
    return out


async def sales_analysis(db: AsyncSession, p: Period) -> dict:
    events = await sale_events(db, p.start, p.end)
    products = {x.id: (x.code, x.name_ar) for x in (await db.scalars(select(Product))).all()}
    customers = {c.id: (c.code, c.name) for c in (await db.scalars(select(Customer))).all()}
    sizes = await _variant_labels(db, {e.variant_id for e in events})

    def group(key_fn, label_fn):
        acc: dict[str, dict] = {}
        for e in events:
            k = key_fn(e)
            row = acc.setdefault(k, {"key": k, "label": label_fn(e), "quantity": Decimal("0"), "net_sales": ZERO, "orders": set()})
            row["quantity"] += e.quantity
            row["net_sales"] += e.net_value
            row["orders"].add(e.order_id)
        total = sum((r["net_sales"] for r in acc.values()), ZERO)
        out = []
        for r in acc.values():
            qty = r["quantity"]
            out.append({"key": r["key"], "label": r["label"], "quantity": float(qty), "net_sales": _f(r["net_sales"]),
                        "avg_price": _f(r["net_sales"] / qty) if qty else 0.0, "orders_count": len(r["orders"]),
                        "share_pct": _pct(r["net_sales"], total) or 0.0})
        return sorted(out, key=lambda r: -r["net_sales"])

    by_customer = group(lambda e: e.customer_id, lambda e: customers.get(e.customer_id, ("", "عميل غير محدد"))[1])
    by_model = group(lambda e: e.product_id, lambda e: products.get(e.product_id, ("", "موديل غير محدد"))[1])
    by_size = group(lambda e: e.variant_id,
                    lambda e: f"{products.get(e.product_id, ('', ''))[1]} — {sizes.get(e.variant_id, '')}".strip(" —"))
    net = sum((e.net_value for e in events), ZERO)
    qty = sum((e.quantity for e in events), Decimal("0"))
    returns_value = -sum((e.net_value for e in events if e.net_value < 0), ZERO)
    gross_line_value = ZERO
    discount_total = ZERO
    for order in await load_customer_orders(db):
        if p.start <= order.order_date < p.end:
            gross_line_value += sum((money(Decimal(str(l.quantity)) * Decimal(str(l.unit_price))) for l in order.lines), ZERO)
            discount_total += money(order.discount_amount)
    return {
        "period": {"date_from": p.date_from.isoformat(), "date_to": p.date_to.isoformat()},
        "summary": {
            "net_sales": _f(net), "quantity": float(qty), "avg_price": _f(net / qty) if qty else 0.0,
            "returns_value": _f(returns_value), "customers_count": len(by_customer),
            "orders_value": _f(gross_line_value), "discounts": _f(discount_total),
            "discount_pct": _pct(discount_total, gross_line_value) or 0.0,
        },
        "by_customer": by_customer,
        "by_model": by_model,
        "by_size": by_size,
    }


async def model_profitability(db: AsyncSession, p: Period) -> dict:
    events = await sale_events(db, p.start, p.end)
    cogs = await cogs_by_variant(db, p.start, p.end)
    products = {x.id: (x.code, x.name_ar) for x in (await db.scalars(select(Product))).all()}
    variant_product = {v.id: v.product_id for v in (await db.scalars(select(ProductVariant))).all()}
    acc: dict[str, dict] = {}
    for e in events:
        r = acc.setdefault(e.product_id, {"quantity": Decimal("0"), "sales": ZERO, "cogs": ZERO})
        r["quantity"] += e.quantity
        r["sales"] += e.net_value
    for variant_id, cost in cogs.items():
        pid = variant_product.get(variant_id)
        if pid:
            acc.setdefault(pid, {"quantity": Decimal("0"), "sales": ZERO, "cogs": ZERO})["cogs"] += cost
    rows = []
    for pid, r in acc.items():
        qty, sales, cost = r["quantity"], r["sales"], r["cogs"]
        profit = sales - cost
        code, name = products.get(pid, ("", "موديل غير محدد"))
        rows.append({"product_id": pid, "code": code, "name": name, "quantity": float(qty),
                     "net_sales": _f(sales), "cogs": _f(cost), "gross_profit": _f(profit),
                     "margin_pct": _pct(profit, sales),
                     "unit_price": _f(sales / qty) if qty else 0.0, "unit_cost": _f(cost / qty) if qty else 0.0})
    rows.sort(key=lambda r: -r["gross_profit"])
    tot_sales = sum((Decimal(str(r["net_sales"])) for r in rows), ZERO)
    tot_cogs = sum((Decimal(str(r["cogs"])) for r in rows), ZERO)
    return {
        "period": {"date_from": p.date_from.isoformat(), "date_to": p.date_to.isoformat()},
        "rows": rows,
        "totals": {"net_sales": _f(tot_sales), "cogs": _f(tot_cogs), "gross_profit": _f(tot_sales - tot_cogs),
                   "margin_pct": _pct(tot_sales - tot_cogs, tot_sales)},
        "note": "التكلفة = تكلفة المنتج التام المسلم (خامات مستلمة بالورشة)، بلا أجور أو مصروفات غير مباشرة.",
    }


# ─── تكلفة الرواتب ───────────────────────────────────────────────────────────

async def payroll_cost(db: AsyncSession, months: int = 12) -> dict:
    """صافي الرواتب المصروفة شهرياً حسب القسم ونسبتها من صافي المبيعات (الشهر = شهر نهاية الفترة)."""
    month_list = last_months(months)
    start = make_period(date.fromisoformat(month_list[0] + "-01"), datetime.now(CAIRO).date())
    rows = (await db.execute(
        select(PayPeriod.end_date, Employee.department, func.sum(PayrollRun.net_amount), func.count(PayrollRun.id))
        .join(PayPeriod, PayPeriod.id == PayrollRun.period_id)
        .join(Employee, Employee.id == PayrollRun.employee_id)
        .join(CashDocument, CashDocument.id == PayrollRun.cash_document_id)
        .where(CashDocument.status == "approved", PayPeriod.end_date >= start.start, PayPeriod.end_date < start.end)
        .group_by(PayPeriod.end_date, Employee.department)
    )).all()
    by_month = {m: {"total": ZERO, "departments": {}, "headcount": 0} for m in month_list}
    departments: dict[str, Decimal] = {}
    for end_date, dept, total, count in rows:
        m = cairo_month(end_date)
        if m not in by_month:
            continue
        dept = (dept or "غير محدد").strip() or "غير محدد"
        amount = money(Decimal(str(total or 0)))
        by_month[m]["total"] += amount
        by_month[m]["headcount"] += int(count or 0)
        by_month[m]["departments"][dept] = by_month[m]["departments"].get(dept, ZERO) + amount
        departments[dept] = departments.get(dept, ZERO) + amount
    sales_by_month: dict[str, Decimal] = {}
    for e in await sale_events(db, start.start, start.end):
        m = cairo_month(e.at)
        sales_by_month[m] = sales_by_month.get(m, ZERO) + e.net_value
    total_all = sum(departments.values(), ZERO)
    return {
        "monthly": [{"month": m, "total": _f(v["total"]), "headcount": v["headcount"],
                     "sales": _f(sales_by_month.get(m, ZERO)),
                     "ratio_to_sales_pct": _pct(v["total"], sales_by_month.get(m, ZERO)),
                     "departments": {d: _f(a) for d, a in v["departments"].items()}} for m, v in by_month.items()],
        "departments": sorted(({"department": d, "total": _f(a), "share_pct": _pct(a, total_all) or 0.0} for d, a in departments.items()),
                              key=lambda r: -r["total"]),
        "total": _f(total_all),
    }


# ─── الهالك والعجز ───────────────────────────────────────────────────────────

LOSS_TYPES = {
    "stocktake_shortage": "عجز جرد",
    "receipt_discrepancy": "فرق استلام الورشة",
    "return_shortage": "عجز مرتجع الورشة",
    "return_rejected_scrap": "مرتجع ورشة مُعدم",
}


async def losses(db: AsyncSession, p: Period) -> dict:
    items = {}
    rows = (await db.execute(
        select(StockLedgerEntry.entry_type, StockLedgerEntry.item_id, func.sum(StockLedgerEntry.quantity), func.sum(StockLedgerEntry.total_cost))
        .where(StockLedgerEntry.entry_type.in_(tuple(LOSS_TYPES) + ("stocktake_surplus",)),
               StockLedgerEntry.created_at >= p.start, StockLedgerEntry.created_at < p.end)
        .group_by(StockLedgerEntry.entry_type, StockLedgerEntry.item_id)
    )).all()
    item_ids = {r[1] for r in rows}
    scrap_rows = (await db.execute(
        select(ProductionMaterialReconciliationLine.item_id, ProductionMaterialReconciliation.order_id,
               ProductionMaterialReconciliationLine.scrapped_quantity)
        .join(ProductionMaterialReconciliation, ProductionMaterialReconciliation.id == ProductionMaterialReconciliationLine.reconciliation_id)
        .where(ProductionMaterialReconciliation.created_at >= p.start, ProductionMaterialReconciliation.created_at < p.end,
               ProductionMaterialReconciliationLine.scrapped_quantity > 0)
    )).all()
    item_ids |= {r[0] for r in scrap_rows}
    if item_ids:
        for it in (await db.scalars(select(CatalogItem).where(CatalogItem.id.in_(item_ids)))).all():
            items[it.id] = (it.code, it.name_ar, it.unit_id)
    units = {u.id: u.name_ar for u in (await db.scalars(select(Unit))).all()}

    by_type: dict[str, Decimal] = {}
    detail = []
    surplus = ZERO
    for entry_type, item_id, qty, cost in rows:
        value = abs(Decimal(str(cost or 0)))
        if entry_type == "stocktake_surplus":
            surplus += value
            continue
        label = LOSS_TYPES[entry_type]
        by_type[label] = by_type.get(label, ZERO) + value
        code, name, unit_id = items.get(item_id, ("", "صنف غير محدد", None))
        detail.append({"type": label, "item_code": code, "item_name": name, "unit": units.get(unit_id, ""),
                       "quantity": abs(float(qty or 0)), "value": _f(value)})

    unit_costs = {}
    if scrap_rows:
        for order_id, item_id, unit_cost in (await db.execute(
            select(ProductionOrderMaterial.order_id, ProductionOrderMaterial.item_id, ProductionOrderMaterial.unit_cost)
            .where(ProductionOrderMaterial.order_id.in_({r[1] for r in scrap_rows}))
        )).all():
            unit_costs[(order_id, item_id)] = Decimal(str(unit_cost or 0))
    scrap_by_item: dict[str, list] = {}
    for item_id, order_id, qty in scrap_rows:
        value = Decimal(str(qty)) * unit_costs.get((order_id, item_id), Decimal("0"))
        acc = scrap_by_item.setdefault(item_id, [0.0, ZERO])
        acc[0] += float(qty)
        acc[1] += value
    for item_id, (qty, value) in scrap_by_item.items():
        label = "تالف الورشة (تسوية الخامات)"
        by_type[label] = by_type.get(label, ZERO) + money(value)
        code, name, unit_id = items.get(item_id, ("", "صنف غير محدد", None))
        detail.append({"type": label, "item_code": code, "item_name": name, "unit": units.get(unit_id, ""),
                       "quantity": qty, "value": _f(value)})

    defects = await db.scalar(select(func.count()).select_from(ProductionDefect).where(
        ProductionDefect.created_at >= p.start, ProductionDefect.created_at < p.end))
    total = sum(by_type.values(), ZERO)
    detail.sort(key=lambda r: -r["value"])
    return {
        "period": {"date_from": p.date_from.isoformat(), "date_to": p.date_to.isoformat()},
        "total_loss": _f(total),
        "stocktake_surplus": _f(surplus),
        "defects_count": int(defects or 0),
        "by_type": sorted(({"type": k, "value": _f(v), "share_pct": _pct(v, total) or 0.0} for k, v in by_type.items()),
                          key=lambda r: -r["value"]),
        "items": detail,
    }


# ─── صحة المخزون: الراكد وتحت حد الطلب ───────────────────────────────────────

async def stock_health(db: AsyncSession, idle_days: int = 60) -> dict:
    raw = await db.scalar(select(Warehouse.id).where(Warehouse.code == "main_raw_materials"))
    if not raw:
        return {"idle_days": idle_days, "slow_moving": [], "below_reorder": [], "totals": {"slow_value": 0.0, "slow_count": 0, "below_count": 0}}
    rows = (await db.execute(
        select(StockLedgerEntry.item_id, func.sum(StockLedgerEntry.quantity), func.sum(StockLedgerEntry.total_cost),
               func.max(StockLedgerEntry.created_at))
        .where(StockLedgerEntry.warehouse_id == raw, StockLedgerEntry.location_type == "warehouse")
        .group_by(StockLedgerEntry.item_id)
    )).all()
    items = {it.id: it for it in (await db.scalars(select(CatalogItem).where(CatalogItem.id.in_({r[0] for r in rows})))).all()} if rows else {}
    units = {u.id: u.name_ar for u in (await db.scalars(select(Unit))).all()}
    cutoff = datetime.now(timezone.utc) - timedelta(days=idle_days)
    slow, below = [], []
    for item_id, qty, cost, last_at in rows:
        it = items.get(item_id)
        if not it or not it.is_active:
            continue
        qty = float(qty or 0)
        value = max(Decimal(str(cost or 0)), ZERO)
        base = {"item_id": item_id, "code": it.code, "name": it.name_ar, "unit": units.get(it.unit_id, ""),
                "balance": round(qty, 3), "value": _f(value),
                "last_movement": last_at.astimezone(CAIRO).date().isoformat() if last_at else None,
                "idle_days": (datetime.now(timezone.utc) - last_at).days if last_at else None}
        if qty > 0 and last_at and last_at < cutoff:
            slow.append(base)
        reorder = float(it.reorder_level or 0)
        if reorder > 0 and qty < reorder:
            below.append({**base, "reorder_level": reorder, "shortfall": round(reorder - qty, 3)})
    slow.sort(key=lambda r: -r["value"])
    below.sort(key=lambda r: -r["shortfall"])
    return {
        "idle_days": idle_days,
        "slow_moving": slow,
        "below_reorder": below,
        "totals": {"slow_value": _f(sum((Decimal(str(r["value"])) for r in slow), ZERO)),
                   "slow_count": len(slow), "below_count": len(below)},
    }
