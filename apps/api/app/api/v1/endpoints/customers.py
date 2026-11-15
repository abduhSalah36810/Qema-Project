import hashlib
import uuid
from datetime import date, datetime, time, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import get_user_roles, require_any_permission, require_permission
from app.db.session import get_db
from app.modules.customers.schemas import CustomerCreate, CustomerRead, CustomerUpdate
from app.modules.customers.schemas import (
    CustomerAccountRead,
    CustomerDeliveryCreate,
    CustomerDeliveryLineRead,
    CustomerDeliveryRead,
    CustomerOrderCreate,
    CustomerOrderRead,
    CustomerPaymentCreate,
    CustomerPaymentRead,
    CustomerProductionOrderRead,
    CustomerDeliveryReturnCreate,
    CustomerDeliveryReturnLineRead,
    CustomerDeliveryReturnRead,
    CustomerReturnInspectionCreate,
    CustomerReturnListItemRead,
    PendingDeliveryItemRead,
    ReturnableDeliveryLineRead,
    ReturnableDeliveryRead,
    ProductionOrderForCustomerCreate,
    SoldItemRowRead,
    SoldItemsResponse,
    SoldItemsSummaryRead,
    OpeningCustomerBalanceCreate,
)
from app.modules.customers.models import (
    CustomerDelivery,
    CustomerDeliveryLine,
    CustomerDeliveryReturn,
    CustomerDeliveryReturnLine,
    CustomerOrder,
    CustomerOrderLine,
    CustomerPayment,
)
from app.modules.finance.models import CashDocument, PaymentAllocation
from app.modules.finance.balances import customer_order_financials, document_net_sales_value, money
from app.modules.finance.ledger_service import post_journal_entry, get_weighted_average_cost, resolve_expense_code, is_opening_balances_locked
from app.modules.finance.schemas import (
    CashDocumentCreate,
    PaymentAllocationCreate,
    PaymentAllocationRead,
    UnallocatedPaymentRead,
)
from app.modules.finance.service import (
    allocate_customer_payment,
    create_cash_document,
    finalize_cash_document,
    get_main_treasury,
    get_main_bank,
    get_unallocated_customer_payments,
)
from app.modules.production.stock import (
    FACTORY_BRAND_BUCKET,
    RETURN_PENDING_PREFIX,
    delivery_bucket_for_order,
    stock_balance,
)
from app.modules.production.models import (
    CatalogItem,
    Customer,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionTemplate,
    ProductionTemplateVersion,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.schemas import OrderCreate, ProductionOrderItemCreate
from app.modules.production.service import (
    create_production_order,
    get_or_create_finished_goods_item,
    lock_stock_balance,
)

router = APIRouter(prefix="/customers", tags=["customers"])
CustomerManager = Annotated[AuthenticatedUser, Depends(require_permission("customers:manage"))]
SalesOrderCreator = Annotated[AuthenticatedUser, Depends(require_permission("customers:orders:create"))]
ProductionOrderCreator = Annotated[AuthenticatedUser, Depends(require_permission("production:orders:create"))]
Database = Annotated[AsyncSession, Depends(get_db)]
CustomerViewer = Annotated[AuthenticatedUser, Depends(require_permission("customers:view"))]
DeliveryManager = Annotated[AuthenticatedUser, Depends(require_permission("customers:deliveries:manage"))]
FinanceManager = Annotated[AuthenticatedUser, Depends(require_permission("finance:payments:manage"))]


def _variant_label(variant: ProductVariant) -> str:
    parts = [str(variant.numeric_size) if variant.numeric_size is not None else "", variant.letter_size or "", variant.season or ""]
    return " · ".join(part for part in parts if part)


def _payment_payload(payment: CustomerPayment) -> dict:
    return {
        "id": payment.id,
        "receipt_number": payment.receipt_number,
        "amount": payment.amount,
        "received_at": payment.received_at,
        "method": payment.method,
        "reference": payment.reference,
        "notes": payment.notes,
        "recorded_by": payment.recorded_by,
        "status": payment.status,
        "cash_document_id": payment.cash_document_id,
    }


def _return_payload(return_doc: CustomerDeliveryReturn) -> dict:
    return {
        "id": return_doc.id,
        "return_number": return_doc.return_number,
        "delivery_id": return_doc.delivery_id,
        "order_id": return_doc.order_id,
        "customer_id": return_doc.customer_id,
        "returned_at": return_doc.returned_at,
        "reason": return_doc.reason,
        "received_by": return_doc.received_by,
        "disposition": return_doc.disposition,
        "created_by": return_doc.created_by or "",
        "inspected_by": return_doc.inspected_by,
        "inspected_at": return_doc.inspected_at,
        "inspection_notes": return_doc.inspection_notes or "",
        "lines": [
            {
                "id": line.id,
                "delivery_line_id": line.delivery_line_id,
                "order_line_id": line.order_line_id,
                "product_name": line.order_line.product.name_ar,
                "variant_info": _variant_label(line.order_line.variant),
                "quantity": float(line.quantity),
                "notes": line.notes,
                "condition": line.condition or "unknown",
                "restocked_quantity": float(line.restocked_quantity or 0),
                "scrapped_quantity": float(line.scrapped_quantity or 0),
            }
            for line in return_doc.lines
        ],
    }


def _order_payload(order: CustomerOrder) -> dict:
    """موقف الطلب كما يحسبه مصدر الحقيقة الموحد (finance.balances.customer_order_financials)."""
    fin = customer_order_financials(order)
    deliveries = []
    for delivery in sorted(order.deliveries, key=lambda entry: entry.delivered_at):
        deliveries.append({
            "id": delivery.id,
            "delivery_number": delivery.delivery_number,
            "delivered_at": delivery.delivered_at,
            "received_by": delivery.received_by,
            "notes": delivery.notes,
            "lines": [
                {
                    "id": line.id,
                    "order_line_id": line.order_line_id,
                    "product_name": line.order_line.product.name_ar,
                    "variant_info": _variant_label(line.order_line.variant),
                    "quantity": line.quantity,
                }
                for line in delivery.lines
            ],
        })

    lines = []
    for line in order.lines:
        delivered = fin.delivered_qty_by_line.get(line.id, Decimal("0"))
        returned = fin.returned_qty_by_line.get(line.id, Decimal("0"))
        lines.append({
            "id": line.id,
            "product_id": line.product_id,
            "product_name": line.product.name_ar,
            "variant_id": line.variant_id,
            "variant_info": _variant_label(line.variant),
            "quantity": line.quantity,
            "unit_price": line.unit_price,
            "line_total": money(line.quantity * line.unit_price),
            "delivered_quantity": delivered,
            "returned_quantity": returned,
            "remaining_quantity": max(Decimal("0"), line.quantity - (delivered - returned)),
            "production_orders": [
                {
                    "id": production.id,
                    "order_number": production.order_number,
                    "status": production.status,
                    "target_quantity": Decimal(str(production.target_quantity)),
                }
                for production in sorted(line.production_orders or [], key=lambda entry: entry.created_at)
            ],
            "notes": line.notes,
        })
    payment_rows = [_payment_payload(p) for p in sorted(order.payments, key=lambda entry: entry.received_at)]
    for alloc in getattr(order, "allocations", []) or []:
        cd = getattr(alloc, "cash_document", None)
        payment_rows.append({
            "id": alloc.id,
            "receipt_number": f"تخصيص ({cd.document_number if cd else alloc.id[:8]})",
            "amount": float(alloc.allocated_amount),
            "received_at": alloc.allocated_at,
            "method": "allocation",
            "reference": cd.document_number if cd else "",
            "notes": alloc.notes or "تخصيص من دفعة مسددة مسبقاً",
            "recorded_by": alloc.allocated_by or "",
            "status": "approved",
            "cash_document_id": alloc.cash_document_id,
        })
    return {
        "id": order.id,
        "order_number": order.order_number,
        "order_type": order.order_type,
        "status": order.status,
        "order_date": order.order_date,
        "expected_delivery_at": order.expected_delivery_at,
        "discount_amount": order.discount_amount,
        "payment_terms": order.payment_terms,
        "notes": order.notes,
        "gross_amount": fin.gross_amount,
        "total_amount": fin.total_amount,
        "paid_amount": fin.paid_approved,
        "balance_amount": fin.remaining_on_order,
        "delivered_value": fin.delivered_value,
        "returned_value": fin.returned_value,
        "receivable_amount": fin.receivable,
        "pending_payments_amount": fin.paid_pending,
        "lines": lines,
        "deliveries": deliveries,
        "payments": payment_rows,
        "returns": [_return_payload(r) for r in sorted(order.returns or [], key=lambda entry: entry.returned_at)],
    }


def _order_load_options():
    return (
        selectinload(CustomerOrder.lines).selectinload(CustomerOrderLine.product),
        selectinload(CustomerOrder.lines).selectinload(CustomerOrderLine.variant),
        selectinload(CustomerOrder.lines).selectinload(CustomerOrderLine.production_orders),
        selectinload(CustomerOrder.deliveries)
        .selectinload(CustomerDelivery.lines)
        .selectinload(CustomerDeliveryLine.order_line)
        .selectinload(CustomerOrderLine.product),
        selectinload(CustomerOrder.deliveries)
        .selectinload(CustomerDelivery.lines)
        .selectinload(CustomerDeliveryLine.order_line)
        .selectinload(CustomerOrderLine.variant),
        selectinload(CustomerOrder.payments),
        selectinload(CustomerOrder.allocations).selectinload(PaymentAllocation.cash_document),
        selectinload(CustomerOrder.returns)
        .selectinload(CustomerDeliveryReturn.lines)
        .selectinload(CustomerDeliveryReturnLine.order_line)
        .selectinload(CustomerOrderLine.product),
        selectinload(CustomerOrder.returns)
        .selectinload(CustomerDeliveryReturn.lines)
        .selectinload(CustomerDeliveryReturnLine.order_line)
        .selectinload(CustomerOrderLine.variant),
    )


async def _load_order(db: AsyncSession, order_id: str, customer_id: str | None = None, *, lock: bool = False) -> CustomerOrder:
    # populate_existing: قراءة حالة الطلب ومستنداته الحالية من القاعدة دائماً (لا نسخة قديمة من الذاكرة)
    stmt = (
        select(CustomerOrder)
        .options(*_order_load_options())
        .where(CustomerOrder.id == order_id)
        .execution_options(populate_existing=True)
    )
    if customer_id:
        stmt = stmt.where(CustomerOrder.customer_id == customer_id)
    if lock:
        stmt = stmt.with_for_update(of=CustomerOrder)
    result = await db.execute(stmt)
    order = result.scalar_one_or_none()
    if order is None:
        raise HTTPException(status_code=404, detail="معاملة العميل غير موجودة.")
    return order


@router.get("", response_model=list[CustomerRead])
async def list_customers(
    current_user: CustomerViewer,
    db: Database,
    search: str | None = Query(default=None, max_length=128),
    customer_status: str | None = Query(default=None, alias="status", pattern="^(active|inactive)$"),
    limit: int = Query(default=100, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
):
    del current_user
    stmt = select(Customer).order_by(Customer.name, Customer.code).limit(limit).offset(offset)
    if customer_status:
        stmt = stmt.where(Customer.status == customer_status)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(or_(Customer.name.ilike(term), Customer.code.ilike(term), Customer.phone.ilike(term), Customer.city.ilike(term)))
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/pending-deliveries", response_model=list[PendingDeliveryItemRead])
async def list_pending_deliveries(
    current_user: DeliveryManager,
    db: Database,
):
    del current_user
    fg_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    fg_wh_id = fg_wh.id if fg_wh else None

    # استرجاع طلبات العملاء المفتوحة أو المسلمة جزئياً
    orders_result = await db.execute(
        select(CustomerOrder)
        .options(*_order_load_options())
        .join(Customer, Customer.id == CustomerOrder.customer_id)
        .where(CustomerOrder.status.in_(["open", "partially_delivered"]))
        .order_by(CustomerOrder.order_date.desc(), CustomerOrder.order_number.desc())
    )
    orders = orders_result.scalars().all()

    pending_items: list[PendingDeliveryItemRead] = []

    for order in orders:
        customer = await db.get(Customer, order.customer_id)
        if not customer:
            continue
        fin = customer_order_financials(order)
        bucket_ref = delivery_bucket_for_order(order.order_type, order.customer_id)

        for line in order.lines:
            delivered_qty = fin.delivered_qty_by_line.get(line.id, Decimal("0"))
            returned_qty = fin.returned_qty_by_line.get(line.id, Decimal("0"))
            remaining_qty = line.quantity - (delivered_qty - returned_qty)
            if remaining_qty <= Decimal("0"):
                continue

            # الرصيد القابل للتسليم لهذا الطلب فقط (نفس حاوية الملكية التي يخصم منها التسليم)
            cat_item = await get_or_create_finished_goods_item(db, line.product_id, line.variant_id)
            avail_stock = (
                max(0.0, await stock_balance(db, cat_item.id, fg_wh_id, bucket_reference=bucket_ref))
                if fg_wh_id else 0.0
            )

            pending_items.append(
                PendingDeliveryItemRead(
                    order_id=order.id,
                    order_number=order.order_number,
                    order_date=order.order_date,
                    customer_id=customer.id,
                    customer_name=customer.name,
                    customer_code=customer.code,
                    order_line_id=line.id,
                    product_id=line.product_id,
                    variant_id=line.variant_id,
                    product_name=line.product.name_ar,
                    variant_info=_variant_label(line.variant),
                    requested_quantity=float(line.quantity),
                    delivered_quantity=float(delivered_qty - returned_qty),
                    remaining_quantity=float(remaining_qty),
                    available_stock=avail_stock,
                    status=order.status,
                )
            )

    return pending_items


ReturnsViewer = Annotated[
    AuthenticatedUser, Depends(require_any_permission("customers:deliveries:manage", "customers:view"))
]

_RETURN_LIST_OPTIONS = (
    selectinload(CustomerDeliveryReturn.lines).selectinload(CustomerDeliveryReturnLine.order_line).selectinload(CustomerOrderLine.product),
    selectinload(CustomerDeliveryReturn.lines).selectinload(CustomerDeliveryReturnLine.order_line).selectinload(CustomerOrderLine.variant),
    selectinload(CustomerDeliveryReturn.delivery),
    selectinload(CustomerDeliveryReturn.order),
    selectinload(CustomerDeliveryReturn.customer),
)


@router.get("/returns", response_model=list[CustomerReturnListItemRead])
async def list_customer_returns(
    current_user: ReturnsViewer,
    db: Database,
    status_filter: Literal["pending", "inspected", "all"] = Query("all", alias="status"),
    order_id: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
):
    """سجل مرتجعات العملاء (كميات وحالات فقط، بلا مبالغ) لأمين المخزن ومن يرى العملاء."""
    del current_user
    stmt = select(CustomerDeliveryReturn).options(*_RETURN_LIST_OPTIONS)
    if status_filter == "pending":
        stmt = stmt.where(CustomerDeliveryReturn.disposition == "pending_inspection")
    elif status_filter == "inspected":
        stmt = stmt.where(CustomerDeliveryReturn.disposition != "pending_inspection")
    if order_id:
        stmt = stmt.where(CustomerDeliveryReturn.order_id == order_id)
    stmt = stmt.order_by(CustomerDeliveryReturn.returned_at.desc()).limit(limit)
    rows = (await db.scalars(stmt)).all()
    return [
        CustomerReturnListItemRead(
            **_return_payload(r),
            delivery_number=r.delivery.delivery_number if r.delivery else "",
            order_number=r.order.order_number if r.order else "",
            customer_name=r.customer.name if r.customer else "",
            customer_code=r.customer.code if r.customer else "",
        )
        for r in rows
    ]


@router.get("/returnable-deliveries", response_model=list[ReturnableDeliveryRead])
async def list_returnable_deliveries(
    current_user: DeliveryManager,
    db: Database,
    search: str = Query(default="", max_length=100),
    limit: int = Query(default=30, ge=1, le=100),
):
    """سندات التسليم التي يتبقى فيها كمية يمكن إرجاعها (المسلم − المرتجع سابقاً)، الأحدث أولاً."""
    del current_user
    stmt = (
        select(CustomerDelivery)
        .join(CustomerOrder, CustomerOrder.id == CustomerDelivery.order_id)
        .join(Customer, Customer.id == CustomerOrder.customer_id)
        .options(
            selectinload(CustomerDelivery.lines).selectinload(CustomerDeliveryLine.order_line).selectinload(CustomerOrderLine.product),
            selectinload(CustomerDelivery.lines).selectinload(CustomerDeliveryLine.order_line).selectinload(CustomerOrderLine.variant),
            selectinload(CustomerDelivery.returns).selectinload(CustomerDeliveryReturn.lines),
            selectinload(CustomerDelivery.order).selectinload(CustomerOrder.customer),
        )
        .order_by(CustomerDelivery.delivered_at.desc())
    )
    term = search.strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(
            CustomerDelivery.delivery_number.ilike(like),
            CustomerOrder.order_number.ilike(like),
            Customer.name.ilike(like),
            Customer.code.ilike(like),
        ))
    result: list[ReturnableDeliveryRead] = []
    for delivery in (await db.scalars(stmt.limit(limit * 3))).all():
        returned: dict[str, Decimal] = {}
        for ret in delivery.returns:
            for rl in ret.lines:
                returned[rl.delivery_line_id] = returned.get(rl.delivery_line_id, Decimal("0")) + Decimal(str(rl.quantity))
        lines = []
        for dl in delivery.lines:
            delivered = Decimal(str(dl.quantity))
            done = returned.get(dl.id, Decimal("0"))
            lines.append(ReturnableDeliveryLineRead(
                delivery_line_id=dl.id,
                product_name=dl.order_line.product.name_ar,
                variant_info=_variant_label(dl.order_line.variant),
                delivered_quantity=float(delivered),
                returned_quantity=float(done),
                returnable_quantity=float(max(Decimal("0"), delivered - done)),
            ))
        if not any(line.returnable_quantity > 0 for line in lines):
            continue
        order = delivery.order
        result.append(ReturnableDeliveryRead(
            delivery_id=delivery.id,
            delivery_number=delivery.delivery_number,
            delivered_at=delivery.delivered_at,
            order_id=order.id,
            order_number=order.order_number,
            customer_id=order.customer_id,
            customer_name=order.customer.name if order.customer else "",
            customer_code=order.customer.code if order.customer else "",
            lines=lines,
        ))
        if len(result) >= limit:
            break
    return result


@router.get("/sold-items", response_model=SoldItemsResponse)
async def list_sold_items(
    current_user: CustomerViewer,
    db: Database,
    customer_id: Annotated[str | None, Query()] = None,
    product_id: Annotated[str | None, Query()] = None,
    variant_id: Annotated[str | None, Query()] = None,
    order_type: Annotated[str | None, Query()] = None,
    date_from: Annotated[date | None, Query()] = None,
    date_to: Annotated[date | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
):
    """سجل الأصناف المباعة والمسلمة فعلياً للعملاء مع احتساب صافي الخصم والمرتجعات."""
    del current_user
    stmt = (
        select(CustomerOrder)
        .options(*_order_load_options(), selectinload(CustomerOrder.customer))
        .where(CustomerOrder.status != "cancelled")
        .order_by(CustomerOrder.order_date.desc(), CustomerOrder.order_number.desc())
    )
    if customer_id:
        stmt = stmt.where(CustomerOrder.customer_id == customer_id)
    if order_type:
        stmt = stmt.where(CustomerOrder.order_type == order_type)

    orders = (await db.execute(stmt)).scalars().all()

    start_dt = datetime.combine(date_from, time.min, tzinfo=timezone.utc) if date_from else None
    end_dt = datetime.combine(date_to, time.max, tzinfo=timezone.utc) if date_to else None
    q = search.strip().lower() if search and search.strip() else ""

    rows: list[SoldItemRowRead] = []
    distinct_products: set[str] = set()
    total_delivered_qty = 0.0
    total_returned_qty = 0.0
    total_net_qty = 0.0
    total_delivered_val = Decimal("0.00")
    total_returned_val = Decimal("0.00")
    total_net_val = Decimal("0.00")

    for order in orders:
        customer = order.customer
        if not customer:
            continue
        fin = customer_order_financials(order)
        net_ratio = fin.net_ratio

        returned_by_d_line: dict[str, Decimal] = {}
        for ret in getattr(order, "returns", []) or []:
            for r_line in getattr(ret, "lines", []) or []:
                returned_by_d_line[r_line.delivery_line_id] = (
                    returned_by_d_line.get(r_line.delivery_line_id, Decimal("0")) + Decimal(str(r_line.quantity or 0))
                )

        order_lines_by_id = {ol.id: ol for ol in order.lines}

        for delivery in getattr(order, "deliveries", []) or []:
            delivered_at = delivery.delivered_at
            if delivered_at.tzinfo is None:
                delivered_at = delivered_at.replace(tzinfo=timezone.utc)
            if start_dt and delivered_at < start_dt:
                continue
            if end_dt and delivered_at > end_dt:
                continue

            for d_line in getattr(delivery, "lines", []) or []:
                o_line = d_line.order_line or order_lines_by_id.get(d_line.order_line_id)
                if not o_line:
                    continue
                if product_id and o_line.product_id != product_id:
                    continue
                if variant_id and o_line.variant_id != variant_id:
                    continue

                product = o_line.product
                variant = o_line.variant
                v_info = _variant_label(variant) if variant else ""
                p_name = product.name_ar if product else ""
                p_code = product.code if product else ""

                if q:
                    haystack = " ".join(
                        [
                            customer.name or "",
                            customer.code or "",
                            order.order_number or "",
                            delivery.delivery_number or "",
                            p_name,
                            p_code,
                            v_info,
                        ]
                    ).lower()
                    if q not in haystack:
                        continue

                d_qty = Decimal(str(d_line.quantity or 0))
                r_qty = returned_by_d_line.get(d_line.id, Decimal("0"))
                net_qty = max(Decimal("0"), d_qty - r_qty)
                u_price = Decimal(str(o_line.unit_price or 0))
                net_u_price = (u_price * net_ratio).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

                d_val = money(d_qty * u_price * net_ratio)
                r_val = money(r_qty * u_price * net_ratio)
                n_val = d_val - r_val

                distinct_products.add(o_line.product_id)
                total_delivered_qty += float(d_qty)
                total_returned_qty += float(r_qty)
                total_net_qty += float(net_qty)
                total_delivered_val += d_val
                total_returned_val += r_val
                total_net_val += n_val

                rows.append(
                    SoldItemRowRead(
                        delivery_line_id=d_line.id,
                        delivery_id=delivery.id,
                        delivery_number=delivery.delivery_number,
                        delivered_at=delivery.delivered_at,
                        order_id=order.id,
                        order_number=order.order_number,
                        order_type=order.order_type,
                        order_status=order.status,
                        customer_id=customer.id,
                        customer_code=customer.code,
                        customer_name=customer.name,
                        product_id=o_line.product_id,
                        product_code=p_code,
                        product_name=p_name,
                        variant_id=o_line.variant_id,
                        variant_info=v_info,
                        ordered_quantity=float(o_line.quantity or 0),
                        delivered_quantity=float(d_qty),
                        returned_quantity=float(r_qty),
                        net_sold_quantity=float(net_qty),
                        unit_price=float(u_price),
                        net_unit_price=float(net_u_price),
                        delivered_value=float(d_val),
                        returned_value=float(r_val),
                        net_sold_value=float(n_val),
                    )
                )

    rows.sort(key=lambda r: r.delivered_at, reverse=True)
    limited_rows = rows[:limit]

    return SoldItemsResponse(
        summary=SoldItemsSummaryRead(
            lines_count=len(rows),
            distinct_products_count=len(distinct_products),
            total_delivered_quantity=total_delivered_qty,
            total_returned_quantity=total_returned_qty,
            total_net_sold_quantity=total_net_qty,
            total_delivered_value=float(total_delivered_val),
            total_returned_value=float(total_returned_val),
            total_net_sold_value=float(total_net_val),
        ),
        items=limited_rows,
    )


@router.get("/{customer_id}/account", response_model=CustomerAccountRead)
async def get_customer_account(customer_id: str, current_user: CustomerViewer, db: Database):
    del current_user
    customer = await db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="العميل غير موجود.")
    result = await db.execute(
        select(CustomerOrder)
        .where(CustomerOrder.customer_id == customer_id)
        .options(*_order_load_options())
        .order_by(CustomerOrder.order_date.desc(), CustomerOrder.order_number.desc())
    )
    orders = result.scalars().all()
    return CustomerAccountRead(
        customer=CustomerRead.model_validate(customer),
        orders=[CustomerOrderRead.model_validate(_order_payload(order)) for order in orders],
    )


@router.post("", response_model=CustomerRead, status_code=status.HTTP_201_CREATED)
async def create_customer(data: CustomerCreate, current_user: CustomerManager, db: Database):
    del current_user
    existing = await db.execute(select(Customer.id).where(Customer.code == data.code))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="كود العميل مسجل بالفعل.")
    customer = Customer(**data.model_dump(), status="active")
    db.add(customer)
    await db.commit()
    await db.refresh(customer)
    return customer


@router.patch("/{customer_id}", response_model=CustomerRead)
async def update_customer(customer_id: str, data: CustomerUpdate, current_user: CustomerManager, db: Database):
    del current_user
    customer = await db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="العميل غير موجود.")
    updates = data.model_dump(exclude_unset=True)
    if "code" in updates:
        existing = await db.execute(select(Customer.id).where(Customer.code == updates["code"], Customer.id != customer_id))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="كود العميل مسجل بالفعل.")
    for field, value in updates.items():
        setattr(customer, field, value)
    await db.commit()
    await db.refresh(customer)
    return customer


@router.post(
    "/{customer_id}/orders",
    response_model=CustomerOrderRead,
    status_code=status.HTTP_201_CREATED,
    # كل طلب بيع يحدد سعر الوحدة والخصم؛ لذا يلزم أيضاً تفويض التسعير
    dependencies=[Depends(require_permission("pricing:manage"))],
)
async def create_customer_order(customer_id: str, data: CustomerOrderCreate, current_user: SalesOrderCreator, db: Database):
    customer = await db.get(Customer, customer_id)
    if customer is None or customer.status != "active":
        raise HTTPException(status_code=404, detail="العميل غير موجود أو موقوف.")
    if len({line.variant_id for line in data.lines}) != len(data.lines):
        raise HTTPException(status_code=422, detail="اجمع كمية كل مقاس/موسم في بند واحد داخل الطلب.")

    gross_amount = Decimal("0")
    line_rows = []
    for line in data.lines:
        product = await db.get(Product, line.product_id)
        variant = await db.get(ProductVariant, line.variant_id)
        if product is None or variant is None or variant.product_id != product.id:
            raise HTTPException(status_code=422, detail="المنتج أو المقاس والموسم المحدد غير متطابق.")
        gross_amount += (line.quantity * line.unit_price).quantize(Decimal("0.01"))
        line_rows.append(CustomerOrderLine(
            id=str(uuid.uuid4()), product_id=line.product_id, variant_id=line.variant_id,
            quantity=line.quantity, unit_price=line.unit_price, notes=line.notes.strip(),
        ))
    if data.discount_amount > gross_amount:
        raise HTTPException(status_code=422, detail="الخصم لا يمكن أن يتجاوز إجمالي قيمة الطلب.")

    now = datetime.now(timezone.utc)
    order = CustomerOrder(
        id=str(uuid.uuid4()), order_number=f"CO-{now.year}-{uuid.uuid4().hex[:8].upper()}",
        customer_id=customer_id, order_type=data.order_type, status="open", order_date=now,
        expected_delivery_at=data.expected_delivery_at, discount_amount=data.discount_amount,
        payment_terms=data.payment_terms.strip(), notes=data.notes.strip(),
        created_by=current_user.id, lines=line_rows,
    )
    db.add(order)
    await db.commit()
    saved = await _load_order(db, order.id)
    return CustomerOrderRead.model_validate(_order_payload(saved))


@router.post("/{customer_id}/opening-balances", response_model=CustomerOrderRead, status_code=status.HTTP_201_CREATED)
async def create_opening_customer_balance(
    customer_id: str,
    data: OpeningCustomerBalanceCreate,
    current_user: SalesOrderCreator,
    db: Database,
):
    """تسجيل رصيد افتتاحي لعميل (مديونية قديمة أو دفعة مقدمة) بمبلغ إجمالي دون بنود أو تسليمات."""
    if await is_opening_balances_locked(db):
        raise HTTPException(status_code=409, detail="تم قفل الأرصدة الافتتاحية ولا يمكن إنشاء مستندات افتتاحية جديدة.")

    customer = await db.get(Customer, customer_id)
    if customer is None or customer.status != "active":
        raise HTTPException(status_code=404, detail="العميل غير موجود أو موقوف.")

    now = datetime.now(timezone.utc)
    order = CustomerOrder(
        id=str(uuid.uuid4()),
        order_number=f"CO-OB-{now.year}-{uuid.uuid4().hex[:6].upper()}",
        original_order_number=data.original_order_number.strip(),
        customer_id=customer_id,
        order_type="ready_goods",
        status="open",
        is_opening=True,
        is_advance=data.is_advance,
        opening_amount=data.amount,
        order_date=data.order_date,
        discount_amount=Decimal("0.00"),
        payment_terms="",
        notes=data.notes.strip(),
        created_by=current_user.id,
        lines=[],
    )
    db.add(order)
    await db.commit()
    saved = await _load_order(db, order.id)
    return CustomerOrderRead.model_validate(_order_payload(saved))


@router.post("/{customer_id}/opening-balances/{order_id}/approve", response_model=CustomerOrderRead)
async def approve_opening_customer_balance(
    customer_id: str,
    order_id: str,
    current_user: SalesOrderCreator,
    db: Database,
):
    """اعتماد رصيد العميل الافتتاحي وترحيل قيده المحاسبي لحساب 3900 (Maker-Checker)."""
    order = await _load_order(db, order_id, customer_id, lock=True)
    if not order or not getattr(order, "is_opening", False):
        raise HTTPException(status_code=404, detail="الرصيد الافتتاحي للعميل غير موجود.")
    if getattr(order, "approved_by", None) is not None:
        raise HTTPException(status_code=409, detail="تم اعتماد الرصيد الافتتاحي مسبقاً.")

    if order.created_by == current_user.id:
        raise HTTPException(
            status_code=403,
            detail="لا يمكن لمنشئ المستند الافتتاحي اعتماده بنفسه (Maker-Checker). يلزم اعتماد مستخدم آخر.",
        )

    now = datetime.now(timezone.utc)
    order.approved_by = current_user.id
    order.approved_at = now
    order.status = "delivered"

    amt = Decimal(str(order.opening_amount))
    ref = order.original_order_number or order.order_number
    if not order.is_advance:
        await post_journal_entry(
            db,
            source_doc_type="opening_customer_balance",
            source_doc_id=order.id,
            description=f"إثبات رصيد مدين افتتاحي للعميل عن طلب {ref}",
            lines=[
                {"account_code": "1100", "debit": amt, "credit": 0, "description": f"مديونية عميل افتتاحية عن {ref}"},
                {"account_code": "3900", "debit": 0, "credit": amt, "description": f"رصيد افتتاحي عميل عن {ref}"},
            ],
            user_id=current_user.id,
            entry_date=order.order_date,
        )
    else:
        await post_journal_entry(
            db,
            source_doc_type="opening_customer_balance",
            source_doc_id=order.id,
            description=f"إثبات دفعة مقدمة افتتاحية دائنة للعميل عن طلب {ref}",
            lines=[
                {"account_code": "3900", "debit": amt, "credit": 0, "description": f"رصيد افتتاحي دفعة مقدمة عميل عن {ref}"},
                {"account_code": "1100", "debit": 0, "credit": amt, "description": f"دفعة مقدمة من العميل عن {ref}"},
            ],
            user_id=current_user.id,
            entry_date=order.order_date,
        )

    await db.commit()
    saved = await _load_order(db, order.id)
    return CustomerOrderRead.model_validate(_order_payload(saved))


@router.post("/{customer_id}/orders/{order_id}/deliveries", response_model=CustomerDeliveryRead, status_code=status.HTTP_201_CREATED)
async def record_customer_delivery(
    customer_id: str,
    order_id: str,
    data: CustomerDeliveryCreate,
    current_user: DeliveryManager,
    db: Database,
):
    order = await _load_order(db, order_id, customer_id, lock=True)
    if order.status in {"cancelled", "delivered"} or getattr(order, "is_opening", False):
        raise HTTPException(status_code=409, detail="لا يمكن تسجيل تسليم على معاملة ملغاة أو مكتملة أو رصيد افتتاحي.")
    requested_ids = [line.order_line_id for line in data.lines]
    if len(set(requested_ids)) != len(requested_ids):
        raise HTTPException(status_code=422, detail="لا تكرر البند نفسه في دفعة التسليم.")
    order_lines = {line.id: line for line in order.lines}
    if any(line_id not in order_lines for line_id in requested_ids):
        raise HTTPException(status_code=422, detail="أحد بنود التسليم لا يتبع هذه المعاملة.")

    fin = customer_order_financials(order)
    net_delivered = {
        line_id: fin.delivered_qty_by_line.get(line_id, Decimal("0")) - fin.returned_qty_by_line.get(line_id, Decimal("0"))
        for line_id in order_lines
    }
    for line in data.lines:
        remaining = order_lines[line.order_line_id].quantity - net_delivered.get(line.order_line_id, Decimal("0"))
        if line.quantity > remaining:
            raise HTTPException(
                status_code=409,
                detail=f"كمية التسليم ({line.quantity:g}) تتجاوز الكمية المتبقية في الطلب ({max(Decimal('0'), remaining):g}).",
            )

    fg_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    if not fg_wh:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="مخزن المنتجات التامة غير مهيأ في النظام.")

    now = datetime.now(timezone.utc)
    delivery = CustomerDelivery(
        id=str(uuid.uuid4()), delivery_number=f"DL-{now.year}-{uuid.uuid4().hex[:8].upper()}",
        order_id=order.id, delivered_at=now, received_by=data.received_by.strip(),
        notes=data.notes.strip(), created_by=current_user.id,
        lines=[CustomerDeliveryLine(id=str(uuid.uuid4()), order_line_id=line.order_line_id, quantity=line.quantity) for line in data.lines],
    )
    db.add(delivery)

    bucket_ref = delivery_bucket_for_order(order.order_type, customer_id)
    total_cogs = Decimal("0.00")
    # ترتيب ثابت للأقفال لتجنب الجمود عند التسليم المتزامن
    for line in sorted(data.lines, key=lambda entry: entry.order_line_id):
        order_line = order_lines[line.order_line_id]
        catalog_item = await get_or_create_finished_goods_item(db, order_line.product_id, order_line.variant_id)
        await lock_stock_balance(db, catalog_item.id, fg_wh.id)

        available_stock = await stock_balance(db, catalog_item.id, fg_wh.id, bucket_reference=bucket_ref)
        req_qty = float(line.quantity)
        if req_qty > available_stock + 1e-9:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"الرصيد المتاح من الصنف '{catalog_item.name_ar}' في مخزن التام ({available_stock:g}) لا يكفي لتسليم الكمية المطلوبة ({req_qty:g}).",
            )

        fg_unit_cost = await get_weighted_average_cost(db, catalog_item.id, fg_wh.id)
        line_cogs = (Decimal(str(req_qty)) * fg_unit_cost).quantize(Decimal("0.01"))
        total_cogs += line_cogs
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=catalog_item.id, unit_id=catalog_item.unit_id,
            warehouse_id=fg_wh.id, location_type="warehouse", quantity=-req_qty,
            reference_doc_type="customer_delivery", reference_doc_id=delivery.id,
            entry_type="customer_delivery_dispatch", created_by=current_user.id,
            bucket_reference=bucket_ref, unit_cost=fg_unit_cost, total_cost=-line_cogs,
        ))

    all_delivered = all(
        net_delivered.get(line.id, Decimal("0"))
        + sum((entry.quantity for entry in data.lines if entry.order_line_id == line.id), Decimal("0"))
        >= line.quantity
        for line in order.lines
    )
    order.status = "delivered" if all_delivered else "partially_delivered"

    # ── قيود التسليم في نفس المعاملة (أي فشل يلغي التسليم بالكامل) ──
    # 1. الإيراد بالقيمة الصافية بعد توزيع خصم الطلب نسبياً (نفس قاعدة رصيد العميل)
    sales_value = document_net_sales_value(
        [(entry.quantity, order_lines[entry.order_line_id].unit_price) for entry in data.lines], fin.net_ratio,
    )
    if sales_value > Decimal("0.00"):
        await post_journal_entry(
            db,
            source_doc_type="customer_delivery_invoice",
            source_doc_id=delivery.id,
            description=f"إيراد تسليم مبيعات للعميل بموجب سند تسليم {delivery.delivery_number}",
            lines=[
                {"account_code": "1100", "debit": sales_value, "credit": 0, "description": f"استحقاق مبيعات سند {delivery.delivery_number}"},
                {"account_code": "4100", "debit": 0, "credit": sales_value, "description": "إيرادات مبيعات منتجات تامة"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )
    # 2. تكلفة البضاعة المباعة بنفس تكلفة حركة المخزون المسجلة
    if total_cogs > Decimal("0.00"):
        await post_journal_entry(
            db,
            source_doc_type="customer_delivery_cogs",
            source_doc_id=delivery.id,
            description=f"تكلفة بضاعة مباعة لسند التسليم {delivery.delivery_number}",
            lines=[
                {"account_code": "5100", "debit": total_cogs, "credit": 0, "description": "تكلفة البضاعة المباعة"},
                {"account_code": "1230", "debit": 0, "credit": total_cogs, "description": "صرف منتج تام من المخزن"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )

    await db.commit()
    line_map = {line.id: line for line in order.lines}
    return CustomerDeliveryRead(
        id=delivery.id,
        delivery_number=delivery.delivery_number,
        delivered_at=delivery.delivered_at,
        received_by=delivery.received_by,
        notes=delivery.notes,
        lines=[
            CustomerDeliveryLineRead(
                id=line.id,
                order_line_id=line.order_line_id,
                product_name=line_map[line.order_line_id].product.name_ar,
                variant_info=_variant_label(line_map[line.order_line_id].variant),
                quantity=float(line.quantity),
            )
            for line in delivery.lines
        ],
    )


def _compute_return_fingerprint(
    delivery_id: str,
    reason: str,
    received_by: str,
    lines: list[tuple[str, Decimal, str]],
) -> str:
    """
    Computes a deterministic SHA-256 fingerprint from the influential fields of a customer return.
    """
    canonical_lines = sorted(
        [
            (lid, str(Decimal(str(qty)).quantize(Decimal("0.001"))), (notes or "").strip())
            for lid, qty, notes in lines
        ],
        key=lambda x: x[0],
    )
    raw = f"delivery_id={delivery_id};reason={reason.strip()};received_by={received_by.strip()};lines={canonical_lines}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _validate_return_idempotency_fingerprint(
    existing_return: CustomerDeliveryReturn,
    delivery_id: str,
    data: CustomerDeliveryReturnCreate,
) -> None:
    """
    Validates that an existing return matching the idempotency key has the exact same
    influential payload fields. If any field differs, raises HTTP 409 Conflict.
    """
    if existing_return.delivery_id != delivery_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="مفتاح عدم التكرار مستخدم مسبقاً مع سند تسليم آخر.",
        )

    # Validate reason
    if (existing_return.reason or "").strip() != (data.reason or "").strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="مفتاح عدم التكرار مستخدم مسبقاً مع تفاصيل سبب مرتجع مختلفة.",
        )

    # Validate received_by
    if (existing_return.received_by or "").strip() != (data.received_by or "").strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="مفتاح عدم التكرار مستخدم مسبقاً مع اسم مستلم مختلف.",
        )

    # Validate lines and quantities
    existing_lines_map = {
        line.delivery_line_id: (Decimal(str(line.quantity)), (line.notes or "").strip())
        for line in existing_return.lines
    }
    incoming_lines_map = {
        line.delivery_line_id: (Decimal(str(line.quantity)), (line.notes or "").strip())
        for line in data.lines
    }

    if set(existing_lines_map.keys()) != set(incoming_lines_map.keys()):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="مفتاح عدم التكرار مستخدم مسبقاً مع بنود تسليم مختلفة.",
        )

    for line_id, (ex_qty, ex_notes) in existing_lines_map.items():
        in_qty, in_notes = incoming_lines_map[line_id]
        if ex_qty != in_qty:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"مفتاح عدم التكرار مستخدم مسبقاً بكميات مرتجع مختلفة للبند {line_id}.",
            )
        if ex_notes != in_notes:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"مفتاح عدم التكرار مستخدم مسبقاً بملاحظات بنود مختلفة للبند {line_id}.",
            )


@router.post(
    "/{customer_id}/orders/{order_id}/deliveries/{delivery_id}/return",
    response_model=CustomerDeliveryReturnRead,
    status_code=status.HTTP_201_CREATED,
)
async def record_customer_delivery_return(
    customer_id: str,
    order_id: str,
    delivery_id: str,
    data: CustomerDeliveryReturnCreate,
    current_user: DeliveryManager,
    db: Database,
):
    """
    تسجيل مرتجع تسليم عميل مع إنشاء مستند مرتجع مستقل وقيد عكسي موجب بالدفتر،
    مع حجز البضاعة المرتجعة تحت الفحص لعدم إتاحتها للبيع فوراً دون اعتماد.
    """
    # 1. التحقق من الطلب وقفل السجل
    order = await _load_order(db, order_id, customer_id, lock=True)
    if not order:
        raise HTTPException(status_code=404, detail="طلب العميل غير موجود.")

    # 2. التحقق من سند التسليم
    delivery = await db.scalar(
        select(CustomerDelivery)
        .options(
            selectinload(CustomerDelivery.lines)
            .selectinload(CustomerDeliveryLine.order_line)
            .selectinload(CustomerOrderLine.product),
            selectinload(CustomerDelivery.lines)
            .selectinload(CustomerDeliveryLine.order_line)
            .selectinload(CustomerOrderLine.variant),
            selectinload(CustomerDelivery.returns)
            .selectinload(CustomerDeliveryReturn.lines),
        )
        .where(
            CustomerDelivery.id == delivery_id,
            CustomerDelivery.order_id == order.id,
        )
        .with_for_update()
    )
    if not delivery:
        raise HTTPException(status_code=404, detail="سند التسليم غير موجود أو لا يتبع هذا الطلب.")

    # 3. التحقق من مفتاح التكرار (Idempotency) وبصمة الطلب (Request Fingerprint)
    if data.idempotency_key:
        existing_return = await db.scalar(
            select(CustomerDeliveryReturn)
            .options(
                selectinload(CustomerDeliveryReturn.lines)
                .selectinload(CustomerDeliveryReturnLine.order_line)
                .selectinload(CustomerOrderLine.product),
                selectinload(CustomerDeliveryReturn.lines)
                .selectinload(CustomerDeliveryReturnLine.order_line)
                .selectinload(CustomerOrderLine.variant),
            )
            .where(CustomerDeliveryReturn.idempotency_key == data.idempotency_key)
        )
        if existing_return:
            _validate_return_idempotency_fingerprint(existing_return, delivery.id, data)
            return CustomerDeliveryReturnRead(**_return_payload(existing_return))

    # 4. فحص البنود والكميات المرتجعة التراكمية
    delivery_lines = {l.id: l for l in delivery.lines}
    req_line_ids = [l.delivery_line_id for l in data.lines]
    if len(set(req_line_ids)) != len(req_line_ids):
        raise HTTPException(status_code=422, detail="لا تكرر بند التسليم نفسه في طلب المرتجع.")
    if any(line_id not in delivery_lines for line_id in req_line_ids):
        raise HTTPException(status_code=422, detail="أحد البنود المرتجعة لا يتبع سند التسليم المحدد.")

    prior_returns_res = await db.execute(
        select(
            CustomerDeliveryReturnLine.delivery_line_id,
            func.coalesce(func.sum(CustomerDeliveryReturnLine.quantity), 0),
        )
        .join(CustomerDeliveryReturn, CustomerDeliveryReturn.id == CustomerDeliveryReturnLine.return_id)
        .where(CustomerDeliveryReturn.delivery_id == delivery.id)
        .group_by(CustomerDeliveryReturnLine.delivery_line_id)
    )
    returned_so_far = {line_id: Decimal(str(qty)) for line_id, qty in prior_returns_res.all()}

    for line in data.lines:
        delivered_qty = delivery_lines[line.delivery_line_id].quantity
        prior_qty = returned_so_far.get(line.delivery_line_id, Decimal("0"))
        if prior_qty + line.quantity > delivered_qty:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"الكمية المرتجعة للبند تتجاوز الكمية المسلمة فعلياً (المسلم: {delivered_qty}، المرتجع سابقاً: {prior_qty}، المطلوب حالياً: {line.quantity}).",
            )

    # 5. إنشاء مستند المرتجع والقيد العكسي
    now = datetime.now(timezone.utc)
    return_number = f"RET-{now.year}-{uuid.uuid4().hex[:8].upper()}"
    return_doc = CustomerDeliveryReturn(
        id=str(uuid.uuid4()),
        return_number=return_number,
        delivery_id=delivery.id,
        order_id=order.id,
        customer_id=customer_id,
        returned_at=now,
        reason=data.reason.strip(),
        received_by=data.received_by.strip(),
        disposition="pending_inspection",
        idempotency_key=data.idempotency_key,
        created_by=current_user.id,
    )
    db.add(return_doc)
    await db.flush()

    fg_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    if not fg_wh:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="مخزن المنتجات التامة غير مهيأ في النظام.")
    fin = customer_order_financials(order)

    return_lines_to_add = []
    total_return_cogs = Decimal("0.00")
    pending_bucket = f"{RETURN_PENDING_PREFIX}{customer_id}"

    for line in data.lines:
        del_line = delivery_lines[line.delivery_line_id]
        order_line = del_line.order_line
        ret_line = CustomerDeliveryReturnLine(
            id=str(uuid.uuid4()),
            return_id=return_doc.id,
            delivery_line_id=line.delivery_line_id,
            order_line_id=order_line.id,
            quantity=line.quantity,
            notes=line.notes.strip(),
            condition=line.condition,
        )
        return_lines_to_add.append(ret_line)
        db.add(ret_line)

        # البضاعة المرتجعة تدخل مخزن التام في حاوية "تحت الفحص" بنفس تكلفة صرفها في سند التسليم
        catalog_item = await get_or_create_finished_goods_item(db, order_line.product_id, order_line.variant_id)
        await lock_stock_balance(db, catalog_item.id, fg_wh.id)
        delivered_unit_cost = await db.scalar(
            select(StockLedgerEntry.unit_cost).where(
                StockLedgerEntry.reference_doc_type == "customer_delivery",
                StockLedgerEntry.reference_doc_id == delivery.id,
                StockLedgerEntry.item_id == catalog_item.id,
            )
        )
        unit_cost = Decimal(str(delivered_unit_cost or 0))
        line_cost = (Decimal(str(line.quantity)) * unit_cost).quantize(Decimal("0.01"))
        total_return_cogs += line_cost
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=catalog_item.id, unit_id=catalog_item.unit_id,
            warehouse_id=fg_wh.id, location_type="warehouse", quantity=float(line.quantity),
            unit_cost=unit_cost, total_cost=line_cost,
            reference_doc_type="customer_delivery_return", reference_doc_id=return_doc.id,
            entry_type="customer_delivery_return", created_by=current_user.id,
            bucket_reference=pending_bucket,
        ))

    # 6. تحديث حالة الطلب وفق صافي الكميات المسلمة (المسلم − المرتجع)
    returned_now: dict[str, Decimal] = {}
    for line in data.lines:
        ol_id = delivery_lines[line.delivery_line_id].order_line_id
        returned_now[ol_id] = returned_now.get(ol_id, Decimal("0")) + line.quantity
    net_by_line = {
        l.id: fin.delivered_qty_by_line.get(l.id, Decimal("0"))
        - fin.returned_qty_by_line.get(l.id, Decimal("0"))
        - returned_now.get(l.id, Decimal("0"))
        for l in order.lines
    }
    if all(net_by_line[l.id] >= l.quantity for l in order.lines):
        order.status = "delivered"
    elif any(net_by_line[l.id] > 0 for l in order.lines):
        order.status = "partially_delivered"
    else:
        order.status = "open"

    # 7. القيود في نفس المعاملة: تخفيض الإيراد وذمة العميل بالقيمة الصافية، وإعادة التكلفة للمخزون
    return_value = document_net_sales_value(
        [(line.quantity, delivery_lines[line.delivery_line_id].order_line.unit_price) for line in data.lines],
        fin.net_ratio,
    )
    if return_value > Decimal("0.00"):
        await post_journal_entry(
            db,
            source_doc_type="customer_return_revenue",
            source_doc_id=return_doc.id,
            description=f"مردودات مبيعات {return_number} للطلب {order.order_number}",
            lines=[
                {"account_code": "4100", "debit": return_value, "credit": 0, "description": "مردودات مبيعات منتجات تامة"},
                {"account_code": "1100", "debit": 0, "credit": return_value, "description": "تخفيض حساب العميل"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )
    if total_return_cogs > Decimal("0.00"):
        await post_journal_entry(
            db,
            source_doc_type="customer_return_cogs",
            source_doc_id=return_doc.id,
            description=f"إعادة تكلفة بضاعة مرتجعة {return_number} للمخزون تحت الفحص",
            lines=[
                {"account_code": "1230", "debit": total_return_cogs, "credit": 0, "description": "منتجات تامة مرتجعة تحت الفحص"},
                {"account_code": "5100", "debit": 0, "credit": total_return_cogs, "description": "تخفيض تكلفة البضاعة المباعة بالمرتجع"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if data.idempotency_key:
            existing_return = await db.scalar(
                select(CustomerDeliveryReturn)
                .options(
                    selectinload(CustomerDeliveryReturn.lines)
                    .selectinload(CustomerDeliveryReturnLine.order_line)
                    .selectinload(CustomerOrderLine.product),
                    selectinload(CustomerDeliveryReturn.lines)
                    .selectinload(CustomerDeliveryReturnLine.order_line)
                    .selectinload(CustomerOrderLine.variant),
                )
                .where(CustomerDeliveryReturn.idempotency_key == data.idempotency_key)
            )
            if existing_return:
                _validate_return_idempotency_fingerprint(existing_return, delivery.id, data)
                return CustomerDeliveryReturnRead(**_return_payload(existing_return))
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="تعارض في حفظ مستند المرتجع أو تكرار مفتاح عدم التكرار.",
        )

    return CustomerDeliveryReturnRead(
        id=return_doc.id,
        return_number=return_doc.return_number,
        delivery_id=return_doc.delivery_id,
        order_id=return_doc.order_id,
        customer_id=return_doc.customer_id,
        returned_at=return_doc.returned_at,
        reason=return_doc.reason,
        received_by=return_doc.received_by,
        disposition=return_doc.disposition,
        created_by=return_doc.created_by or "",
        lines=[
            CustomerDeliveryReturnLineRead(
                id=rl.id,
                delivery_line_id=rl.delivery_line_id,
                order_line_id=rl.order_line_id,
                product_name=delivery_lines[rl.delivery_line_id].order_line.product.name_ar,
                variant_info=_variant_label(delivery_lines[rl.delivery_line_id].order_line.variant),
                quantity=float(rl.quantity),
                notes=rl.notes,
                condition=rl.condition,
            )
            for rl in return_lines_to_add
        ],
    )


@router.post("/{customer_id}/orders/{order_id}/payments", response_model=CustomerPaymentRead, status_code=status.HTTP_201_CREATED)
async def record_customer_payment(
    customer_id: str,
    order_id: str,
    data: CustomerPaymentCreate,
    current_user: FinanceManager,
    db: Database,
):
    """
    تسجيل تحصيل من عميل كمستند قبض معلق؛ يدخل الخزنة ويخفض رصيد العميل فقط بعد اعتماده من شاشة الخزينة.
    لا يُسمح بتحصيل يتجاوز المتبقي على الطلب (شاملاً التحصيلات المعلقة).
    """
    order = await _load_order(db, order_id, customer_id, lock=True)
    if order.status == "cancelled":
        raise HTTPException(status_code=409, detail="لا يمكن تسجيل تحصيل على معاملة ملغاة.")
    fin = customer_order_financials(order)
    available = fin.remaining_on_order - fin.paid_pending
    if data.amount > available:
        raise HTTPException(
            status_code=409,
            detail=f"مبلغ التحصيل ({data.amount:.2f}) يتجاوز المتبقي على الطلب ({max(Decimal('0'), available):.2f}) بعد خصم التحصيلات المعلقة.",
        )
    target_account = await get_main_treasury(db)
    if data.method == "bank_transfer":
        bank = await get_main_bank(db)
        if bank and bank.is_active:
            target_account = bank
    now = datetime.now(timezone.utc)
    received_at = data.received_at or now
    payment = CustomerPayment(
        id=str(uuid.uuid4()), receipt_number=f"RC-{now.year}-{uuid.uuid4().hex[:8].upper()}",
        order_id=order.id, amount=data.amount, received_at=received_at,
        method=data.method, reference=data.reference.strip(), notes=data.notes.strip(),
        recorded_by=current_user.id, status="pending",
    )
    db.add(payment)
    await db.flush()
    method_label = {"cash": "نقداً", "bank_transfer": "تحويل بنكي", "other": "أخرى"}.get(data.method, data.method)
    document = await create_cash_document(
        db,
        CashDocumentCreate(
            document_type="income",
            to_account_id=target_account.id,
            amount=data.amount,
            description=f"تحصيل عميل ({method_label}) للطلب {order.order_number} إيصال {payment.receipt_number}",
            occurred_at=received_at,
            source_system="customer_payment",
            source_reference=payment.id,
            customer_id=customer_id,
        ),
        current_user.id,
        allow_system_source=True,
        commit=False,
    )
    payment.cash_document_id = document.id
    # المدير المالي: التحصيل يُعتمد ويُضاف للخزنة فوراً؛ غيره يبقى معلقاً حتى اعتماد الخزينة
    await finalize_cash_document(db, document, current_user.id, await get_user_roles(current_user, db=db))
    await db.refresh(payment)
    return CustomerPaymentRead(**_payment_payload(payment))


@router.post(
    "/{customer_id}/returns/{return_id}/inspection",
    response_model=CustomerDeliveryReturnRead,
)
async def inspect_customer_return(
    customer_id: str,
    return_id: str,
    data: CustomerReturnInspectionCreate,
    current_user: DeliveryManager,
    db: Database,
):
    """
    نتيجة فحص المرتجع لكل سطر:
    - الصالح للبيع: من حاوية "تحت الفحص" إلى الرصيد القابل للبيع لنفس نوع الطلب.
    - التالف: يخرج من المخزون كهالك وتُحمّل تكلفته على 5200، ولا يختلط بالرصيد القابل للبيع.
    لا أثر مالي على حساب العميل هنا؛ تخفيض ذمته تم عند تسجيل المرتجع، والاسترداد النقدي سند صرف منفصل.
    """
    return_doc = await db.scalar(
        select(CustomerDeliveryReturn)
        .options(
            selectinload(CustomerDeliveryReturn.lines).selectinload(CustomerDeliveryReturnLine.order_line).selectinload(CustomerOrderLine.product),
            selectinload(CustomerDeliveryReturn.lines).selectinload(CustomerDeliveryReturnLine.order_line).selectinload(CustomerOrderLine.variant),
        )
        .where(CustomerDeliveryReturn.id == return_id, CustomerDeliveryReturn.customer_id == customer_id)
        .with_for_update(of=CustomerDeliveryReturn)
    )
    if not return_doc:
        raise HTTPException(status_code=404, detail="مستند المرتجع غير موجود.")
    if return_doc.disposition != "pending_inspection":
        raise HTTPException(status_code=409, detail="تم فحص هذا المرتجع واتخاذ قرار بشأنه مسبقاً.")
    order = await db.get(CustomerOrder, return_doc.order_id)
    fg_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    if not order or not fg_wh:
        raise HTTPException(status_code=503, detail="بيانات الطلب أو مخزن التام غير مكتملة.")

    # تحديد الكمية الصالحة والتالفة لكل سطر (أو قرار واحد للمستند كله)
    lines_by_id = {line.id: line for line in return_doc.lines}
    split: dict[str, tuple[Decimal, Decimal]] = {}
    if data.lines is not None:
        ids = [entry.return_line_id for entry in data.lines]
        if len(set(ids)) != len(ids) or set(ids) != set(lines_by_id):
            raise HTTPException(status_code=422, detail="حدد نتيجة الفحص لكل سطر في المرتجع مرة واحدة.")
        for entry in data.lines:
            line = lines_by_id[entry.return_line_id]
            if entry.restocked_quantity + entry.scrapped_quantity != Decimal(str(line.quantity)):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"مجموع الصالح ({entry.restocked_quantity:g}) والتالف ({entry.scrapped_quantity:g}) "
                        f"يجب أن يساوي كمية السطر المرتجعة ({Decimal(str(line.quantity)):g})."
                    ),
                )
            split[line.id] = (entry.restocked_quantity, entry.scrapped_quantity)
    else:
        for line in return_doc.lines:
            qty = Decimal(str(line.quantity))
            split[line.id] = (qty, Decimal("0")) if data.disposition == "restocked" else (Decimal("0"), qty)

    pending_bucket = f"{RETURN_PENDING_PREFIX}{customer_id}"
    sellable_bucket = delivery_bucket_for_order(order.order_type, customer_id)
    now = datetime.now(timezone.utc)
    scrap_cost = Decimal("0.00")
    for line in sorted(return_doc.lines, key=lambda entry: entry.order_line_id):
        catalog_item = await get_or_create_finished_goods_item(db, line.order_line.product_id, line.order_line.variant_id)
        await lock_stock_balance(db, catalog_item.id, fg_wh.id)
        qty = float(line.quantity)
        pending_qty = await stock_balance(db, catalog_item.id, fg_wh.id, bucket_reference=pending_bucket)
        if pending_qty + 1e-9 < qty:
            raise HTTPException(
                status_code=409,
                detail=f"رصيد المرتجع تحت الفحص للصنف '{catalog_item.name_ar}' ({pending_qty:g}) أقل من كمية المستند ({qty:g}).",
            )
        unit_cost = Decimal(str(await db.scalar(
            select(StockLedgerEntry.unit_cost).where(
                StockLedgerEntry.reference_doc_type == "customer_delivery_return",
                StockLedgerEntry.reference_doc_id == return_doc.id,
                StockLedgerEntry.item_id == catalog_item.id,
            )
        ) or 0))
        restock_qty, scrap_qty = split[line.id]
        line_cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))
        restock_cost = (restock_qty * unit_cost).quantize(Decimal("0.01"))
        # الخروج من «تحت الفحص» بالكمية كلها، ثم الصالح فقط إلى الرصيد القابل للبيع
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=catalog_item.id, unit_id=catalog_item.unit_id,
            warehouse_id=fg_wh.id, location_type="warehouse", quantity=-qty,
            unit_cost=unit_cost, total_cost=-line_cost,
            reference_doc_type="customer_return_inspection", reference_doc_id=return_doc.id,
            entry_type="return_inspection_release", created_by=current_user.id,
            bucket_reference=pending_bucket,
        ))
        if restock_qty > 0:
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=catalog_item.id, unit_id=catalog_item.unit_id,
                warehouse_id=fg_wh.id, location_type="warehouse", quantity=float(restock_qty),
                unit_cost=unit_cost, total_cost=restock_cost,
                reference_doc_type="customer_return_inspection", reference_doc_id=return_doc.id,
                entry_type="return_restock", created_by=current_user.id,
                bucket_reference=sellable_bucket,
            ))
        # التالف يخرج من المخزون كهالك ولا يختلط بالرصيد القابل للبيع
        scrap_cost += line_cost - restock_cost
        line.restocked_quantity = restock_qty
        line.scrapped_quantity = scrap_qty

    if scrap_cost > Decimal("0.00"):
        scrap_acc = await resolve_expense_code(db, "5220", "5200")
        await post_journal_entry(
            db,
            source_doc_type="customer_return_scrap",
            source_doc_id=return_doc.id,
            description=f"إعدام مرتجع تالف {return_doc.return_number}",
            lines=[
                {"account_code": scrap_acc, "debit": scrap_cost, "credit": 0, "description": "هالك مرتجعات عملاء"},
                {"account_code": "1230", "debit": 0, "credit": scrap_cost, "description": "إخراج مرتجع تالف من مخزون التام"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )

    total_restock = sum((r for r, _ in split.values()), Decimal("0"))
    total_scrap = sum((d for _, d in split.values()), Decimal("0"))
    if total_scrap == 0:
        return_doc.disposition = "restocked"
    elif total_restock == 0:
        return_doc.disposition = "scrapped"
    else:
        return_doc.disposition = "partially_restocked"
    return_doc.inspected_by = current_user.id
    return_doc.inspected_at = now
    return_doc.inspection_notes = data.notes.strip()
    await db.commit()
    return CustomerDeliveryReturnRead(**_return_payload(return_doc))


@router.post("/{customer_id}/orders/{order_id}/production-orders", response_model=CustomerProductionOrderRead, status_code=status.HTTP_201_CREATED)
async def create_linked_production_order(
    customer_id: str,
    order_id: str,
    data: ProductionOrderForCustomerCreate,
    current_user: ProductionOrderCreator,
    db: Database,
):
    order = await db.get(CustomerOrder, order_id)
    if order is None or order.customer_id != customer_id:
        raise HTTPException(status_code=404, detail="معاملة العميل غير موجودة.")
    if order.order_type != "custom_manufacturing":
        raise HTTPException(status_code=409, detail="أوامر التشغيل المرتبطة متاحة لمعاملات التصنيع الخاص فقط.")
    line_result = await db.execute(
        select(CustomerOrderLine)
        .where(CustomerOrderLine.id == data.customer_order_line_id)
        .with_for_update()
    )
    line = line_result.scalar_one_or_none()
    if line is None or line.order_id != order.id:
        raise HTTPException(status_code=404, detail="بند التصنيع غير موجود ضمن هذه المعاملة.")
    template_version_id = data.template_version_id
    if template_version_id is None:
        # بدون قالب محدد: مستلزمات التصنيع النشطة لمقاس الطلب
        from app.modules.production.bom import active_bom_version

        bom_version = await active_bom_version(db, line.variant_id)
        if not bom_version or not bom_version.lines:
            raise HTTPException(status_code=422, detail="مستلزمات التصنيع غير معرّفة لمقاس هذا البند. عرّفها من «الموديلات والمقاسات» أولاً.")
        template_version_id = bom_version.id
    version = await db.get(ProductionTemplateVersion, template_version_id)
    template = await db.get(ProductionTemplate, version.template_id) if version else None
    if version is None or template is None or template.product_id != line.product_id or version.status != "active":
        raise HTTPException(status_code=422, detail="قالب التشغيل غير نشط أو لا يطابق موديل الطلب.")

    assigned = await db.execute(
        select(func.coalesce(func.sum(ProductionOrder.target_quantity), 0)).where(
            ProductionOrder.customer_order_line_id == line.id,
            ProductionOrder.status != "cancelled",
        )
    )
    already_planned = Decimal(str(assigned.scalar_one() or 0))
    remaining = line.quantity - already_planned
    target = data.target_quantity or remaining
    if target <= 0 or target > remaining:
        raise HTTPException(status_code=409, detail="كمية أمر التشغيل تتجاوز الكمية المتبقية لهذا البند.")
    product = await db.get(Product, line.product_id)
    variant = await db.get(ProductVariant, line.variant_id)
    production = await create_production_order(
        db,
        OrderCreate(
            items=[ProductionOrderItemCreate(
                product_id=line.product_id, variant_id=line.variant_id, target_quantity=float(target),
                season=variant.season, template_version_id=version.id,
                # إنتاج الطلب الخاص يُستلم في حاوية العميل حتى يمكن تسليمه له فقط
                product_type="private_label", customer_id=customer_id,
            )],
            assigned_to=data.assigned_to, notes=data.notes,
        ),
        creator_id=current_user.id,
        customer_order_line_id=line.id,
    )
    return CustomerProductionOrderRead(
        id=production.id, order_number=production.order_number, status=production.status,
        target_quantity=Decimal(str(production.target_quantity)), product_name=product.name_ar,
        variant_info=_variant_label(variant),
    )


@router.get("/{customer_id}/unallocated-payments", response_model=list[UnallocatedPaymentRead])
async def list_customer_unallocated_payments(
    customer_id: str,
    current_user: CustomerViewer,
    db: Database,
):
    """عرض المقبوضات النقدية المحصلة من العميل والتي تملك رصيداً غير مخصص بعد على طلبات بيع."""
    del current_user
    rows = await get_unallocated_customer_payments(db, customer_id)
    return [UnallocatedPaymentRead(**row) for row in rows]


@router.post(
    "/{customer_id}/orders/{order_id}/allocate-payment",
    response_model=PaymentAllocationRead,
)
async def allocate_payment_to_customer_order(
    customer_id: str,
    order_id: str,
    data: PaymentAllocationCreate,
    current_user: FinanceManager,
    db: Database,
):
    """تخصيص وتسوية دفعة تحصيل سابقة ومعتمدة على طلب عميل دون تكرار حركة الخزينة."""
    alloc = await allocate_customer_payment(
        db,
        customer_id=customer_id,
        order_id=order_id,
        cash_document_id=data.cash_document_id,
        amount=data.amount,
        user_id=current_user.id,
        notes=data.notes,
    )
    await db.commit()
    await db.refresh(alloc)
    cd = await db.get(CashDocument, alloc.cash_document_id)
    return PaymentAllocationRead(
        id=alloc.id,
        allocation_number=alloc.allocation_number,
        cash_document_id=alloc.cash_document_id,
        cash_document_number=cd.document_number if cd else None,
        supplier_id=alloc.supplier_id,
        customer_id=alloc.customer_id,
        supplier_invoice_id=alloc.supplier_invoice_id,
        customer_order_id=alloc.customer_order_id,
        allocated_amount=alloc.allocated_amount,
        allocated_at=alloc.allocated_at,
        allocated_by=alloc.allocated_by,
        notes=alloc.notes,
    )
