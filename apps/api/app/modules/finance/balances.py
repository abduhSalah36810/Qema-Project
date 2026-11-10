"""
مصدر الحقيقة الوحيد لأرصدة الموردين والعملاء.
─────────────────────────────────────────────────────────────────────────────
كل الشاشات والتقارير تستدعي هذه الدوال بدلاً من إعادة حساب الأرصدة بطرق مختلفة.

المورد:
    قيمة الفاتورة      = Σ (الكمية × السعر − خصم البند)
    قيمة المستلم       = Σ (الكمية المستلمة × صافي سعر الوحدة)
    المسدد             = Σ دفعات المورد المعتمدة من الخزينة
    المستحق عن المستلم = قيمة المستلم − المسدد   (يطابق رصيد حساب الموردين 2100)
    المتبقي على الفاتورة = قيمة الفاتورة − المسدد

العميل (لكل طلب):
    إجمالي الطلب        = Σ (الكمية × السعر) − خصم الطلب
    نسبة صافي البيع      = إجمالي الطلب ÷ الإجمالي قبل الخصم (يُوزع الخصم نسبياً على البنود)
    قيمة المُسلَّم        = Σ (الكمية المسلمة × السعر) × نسبة صافي البيع
    قيمة المرتجع        = Σ (الكمية المرتجعة × السعر) × نسبة صافي البيع
    المحصّل              = Σ التحصيلات المعتمدة من الخزينة
    مديونية العميل       = قيمة المُسلَّم − قيمة المرتجع − المحصّل   (يطابق رصيد حساب العملاء 1100)
    المتبقي على الطلب    = إجمالي الطلب − قيمة المرتجع − المحصّل
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.models import SupplierInvoice, SupplierInvoiceLine, SupplierPayment

CENT = Decimal("0.01")
ZERO = Decimal("0.00")


def money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass
class SupplierInvoiceFinancials:
    invoice_total: Decimal
    received_value: Decimal
    paid_approved: Decimal
    paid_pending: Decimal
    line_totals: dict[str, Decimal] = field(default_factory=dict)
    net_unit_costs: dict[str, Decimal] = field(default_factory=dict)

    @property
    def balance_due(self) -> Decimal:
        return max(ZERO, self.invoice_total - self.paid_approved)

    @property
    def payable_balance(self) -> Decimal:
        return self.received_value - self.paid_approved


def supplier_line_total(line: SupplierInvoiceLine) -> Decimal:
    gross = money(Decimal(str(line.invoiced_quantity)) * Decimal(str(line.unit_price)))
    return gross - money(line.discount_amount)


def supplier_line_net_unit_cost(line: SupplierInvoiceLine) -> Decimal:
    qty = Decimal(str(line.invoiced_quantity))
    if qty <= 0:
        return Decimal("0.0000")
    return (supplier_line_total(line) / qty).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


async def supplier_invoice_financials(
    db: AsyncSession,
    invoice: SupplierInvoice,
    lines: list[SupplierInvoiceLine] | None = None,
) -> SupplierInvoiceFinancials:
    if lines is None:
        lines = list((await db.scalars(
            select(SupplierInvoiceLine).where(SupplierInvoiceLine.invoice_id == invoice.id)
        )).all())
    line_totals = {line.id: supplier_line_total(line) for line in lines}
    unit_costs = {line.id: supplier_line_net_unit_cost(line) for line in lines}
    received_value = sum(
        (money(Decimal(str(line.received_quantity or 0)) * unit_costs[line.id]) for line in lines), ZERO
    )
    payment_rows = (await db.execute(
        select(SupplierPayment.status, func.coalesce(func.sum(SupplierPayment.amount), 0))
        .where(SupplierPayment.invoice_id == invoice.id)
        .group_by(SupplierPayment.status)
    )).all()
    by_status = {status: money(total) for status, total in payment_rows}
    invoice_total = sum(line_totals.values(), ZERO) if lines else money(invoice.invoice_total)
    return SupplierInvoiceFinancials(
        invoice_total=invoice_total,
        received_value=received_value,
        paid_approved=by_status.get("approved", ZERO),
        paid_pending=by_status.get("pending", ZERO),
        line_totals=line_totals,
        net_unit_costs=unit_costs,
    )


@dataclass
class CustomerOrderFinancials:
    gross_amount: Decimal
    discount_amount: Decimal
    total_amount: Decimal
    delivered_value: Decimal
    returned_value: Decimal
    paid_approved: Decimal
    paid_pending: Decimal
    delivered_qty_by_line: dict[str, Decimal] = field(default_factory=dict)
    returned_qty_by_line: dict[str, Decimal] = field(default_factory=dict)

    @property
    def net_ratio(self) -> Decimal:
        if self.gross_amount <= 0:
            return Decimal("1")
        return self.total_amount / self.gross_amount

    @property
    def receivable(self) -> Decimal:
        """ما يدين به العميل فعلياً عن البضاعة المسلمة (قد يكون سالباً = دفعة مقدمة/رصيد دائن)."""
        return self.delivered_value - self.returned_value - self.paid_approved

    @property
    def remaining_on_order(self) -> Decimal:
        return self.total_amount - self.returned_value - self.paid_approved


def customer_order_financials(order) -> CustomerOrderFinancials:
    """
    يحسب الموقف المالي لطلب عميل من علاقاته المحملة (lines, deliveries.lines, returns.lines, payments).
    """
    gross = sum((money(line.quantity * line.unit_price) for line in order.lines), ZERO)
    discount = money(order.discount_amount)
    total = gross - discount
    ratio = (total / gross) if gross > 0 else Decimal("1")
    price_by_line = {line.id: Decimal(str(line.unit_price)) for line in order.lines}

    delivered: dict[str, Decimal] = {}
    delivered_value = ZERO
    for delivery in getattr(order, "deliveries", []) or []:
        doc_gross = ZERO
        for d_line in delivery.lines:
            qty = Decimal(str(d_line.quantity))
            delivered[d_line.order_line_id] = delivered.get(d_line.order_line_id, ZERO) + qty
            doc_gross += qty * price_by_line.get(d_line.order_line_id, ZERO)
        delivered_value += money(doc_gross * ratio)  # تقريب على مستوى المستند كما يُرحّل
    returned: dict[str, Decimal] = {}
    returned_value = ZERO
    for ret in getattr(order, "returns", []) or []:
        doc_gross = ZERO
        for r_line in ret.lines:
            qty = Decimal(str(r_line.quantity))
            returned[r_line.order_line_id] = returned.get(r_line.order_line_id, ZERO) + qty
            doc_gross += qty * price_by_line.get(r_line.order_line_id, ZERO)
        returned_value += money(doc_gross * ratio)

    paid_approved = ZERO
    paid_pending = ZERO
    for payment in getattr(order, "payments", []) or []:
        status = getattr(payment, "status", "approved") or "approved"
        if status == "approved":
            paid_approved += money(payment.amount)
        elif status == "pending":
            paid_pending += money(payment.amount)

    return CustomerOrderFinancials(
        gross_amount=gross,
        discount_amount=discount,
        total_amount=total,
        delivered_value=delivered_value,
        returned_value=returned_value,
        paid_approved=paid_approved,
        paid_pending=paid_pending,
        delivered_qty_by_line=delivered,
        returned_qty_by_line=returned,
    )


def document_net_sales_value(lines: list[tuple[object, object]], ratio: Decimal) -> Decimal:
    """
    قيمة بيع صافية لمستند تسليم/مرتجع: Σ(الكمية × السعر) × نسبة صافي البيع، مقربة مرة واحدة للمستند.
    نفس القاعدة تُستخدم في الترحيل وفي حساب الرصيد حتى يتطابقا حتى آخر قرش.
    """
    gross = sum((Decimal(str(qty)) * Decimal(str(price)) for qty, price in lines), ZERO)
    return money(gross * ratio)


async def load_customer_orders(db: AsyncSession, customer_id: str | None = None) -> list:
    """تحميل طلبات العملاء بكل العلاقات اللازمة لحساب موقفها المالي."""
    from sqlalchemy.orm import selectinload

    from app.modules.customers.models import (
        CustomerDelivery,
        CustomerDeliveryReturn,
        CustomerOrder,
    )

    stmt = (
        select(CustomerOrder)
        .options(
            selectinload(CustomerOrder.lines),
            selectinload(CustomerOrder.deliveries).selectinload(CustomerDelivery.lines),
            selectinload(CustomerOrder.returns).selectinload(CustomerDeliveryReturn.lines),
            selectinload(CustomerOrder.payments),
        )
        .order_by(CustomerOrder.order_date.desc())
    )
    if customer_id:
        stmt = stmt.where(CustomerOrder.customer_id == customer_id)
    return list((await db.scalars(stmt)).all())


@dataclass
class PartyTotals:
    documents_count: int = 0
    total_value: Decimal = ZERO          # قيمة الطلبات/الفواتير
    delivered_value: Decimal = ZERO      # المسلم للعميل / المستلم من المورد
    returned_value: Decimal = ZERO
    paid: Decimal = ZERO
    pending_payments: Decimal = ZERO

    @property
    def balance(self) -> Decimal:
        """العميل: مديونيته عن المسلم. المورد: المستحق له عن المستلم."""
        return self.delivered_value - self.returned_value - self.paid


async def customer_totals(db: AsyncSession, customer_id: str | None = None) -> dict[str, PartyTotals]:
    totals: dict[str, PartyTotals] = {}
    for order in await load_customer_orders(db, customer_id):
        fin = customer_order_financials(order)
        t = totals.setdefault(order.customer_id, PartyTotals())
        t.documents_count += 1
        t.total_value += fin.total_amount
        t.delivered_value += fin.delivered_value
        t.returned_value += fin.returned_value
        t.paid += fin.paid_approved
        t.pending_payments += fin.paid_pending
    return totals


async def supplier_totals(db: AsyncSession, supplier_id: str | None = None) -> dict[str, PartyTotals]:
    stmt = select(SupplierInvoice).where(SupplierInvoice.status != "cancelled")
    if supplier_id:
        stmt = stmt.where(SupplierInvoice.supplier_id == supplier_id)
    totals: dict[str, PartyTotals] = {}
    for invoice in (await db.scalars(stmt)).all():
        fin = await supplier_invoice_financials(db, invoice)
        t = totals.setdefault(invoice.supplier_id, PartyTotals())
        t.documents_count += 1
        t.total_value += fin.invoice_total
        t.delivered_value += fin.received_value
        t.paid += fin.paid_approved
        t.pending_payments += fin.paid_pending
    return totals
