import hashlib
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import get_user_roles, require_permission
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
    PendingDeliveryItemRead,
    ProductionOrderForCustomerCreate,
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
from app.modules.finance.balances import customer_order_financials, document_net_sales_value, money
from app.modules.finance.ledger_service import post_journal_entry, get_weighted_average_cost
from app.modules.finance.schemas import CashDocumentCreate
from app.modules.finance.service import create_cash_document, finalize_cash_document, get_main_treasury
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
        "lines": [
            {
                "id": line.id,
                "delivery_line_id": line.delivery_line_id,
                "order_line_id": line.order_line_id,
                "product_name": line.order_line.product.name_ar,
                "variant_info": _variant_label(line.order_line.variant),
                "quantity": float(line.quantity),
                "notes": line.notes,
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
        "payments": [_payment_payload(p) for p in sorted(order.payments, key=lambda entry: entry.received_at)],
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


@router.post("/{customer_id}/orders/{order_id}/deliveries", response_model=CustomerDeliveryRead, status_code=status.HTTP_201_CREATED)
async def record_customer_delivery(
    customer_id: str,
    order_id: str,
    data: CustomerDeliveryCreate,
    current_user: DeliveryManager,
    db: Database,
):
    order = await _load_order(db, order_id, customer_id, lock=True)
    if order.status in {"cancelled", "delivered"}:
        raise HTTPException(status_code=409, detail="لا يمكن تسجيل تسليم على معاملة ملغاة أو مكتملة.")
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
            return CustomerDeliveryReturnRead(
                id=existing_return.id,
                return_number=existing_return.return_number,
                delivery_id=existing_return.delivery_id,
                order_id=existing_return.order_id,
                customer_id=existing_return.customer_id,
                returned_at=existing_return.returned_at,
                reason=existing_return.reason,
                received_by=existing_return.received_by,
                disposition=existing_return.disposition,
                lines=[
                    CustomerDeliveryReturnLineRead(
                        id=line.id,
                        delivery_line_id=line.delivery_line_id,
                        order_line_id=line.order_line_id,
                        product_name=line.order_line.product.name_ar,
                        variant_info=_variant_label(line.order_line.variant),
                        quantity=float(line.quantity),
                        notes=line.notes,
                    )
                    for line in existing_return.lines
                ],
            )

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
                return CustomerDeliveryReturnRead(
                    id=existing_return.id,
                    return_number=existing_return.return_number,
                    delivery_id=existing_return.delivery_id,
                    order_id=existing_return.order_id,
                    customer_id=existing_return.customer_id,
                    returned_at=existing_return.returned_at,
                    reason=existing_return.reason,
                    received_by=existing_return.received_by,
                    disposition=existing_return.disposition,
                    lines=[
                        CustomerDeliveryReturnLineRead(
                            id=line.id,
                            delivery_line_id=line.delivery_line_id,
                            order_line_id=line.order_line_id,
                            product_name=line.order_line.product.name_ar,
                            variant_info=_variant_label(line.order_line.variant),
                            quantity=float(line.quantity),
                            notes=line.notes,
                        )
                        for line in existing_return.lines
                    ],
                )
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
        lines=[
            CustomerDeliveryReturnLineRead(
                id=rl.id,
                delivery_line_id=rl.delivery_line_id,
                order_line_id=rl.order_line_id,
                product_name=delivery_lines[rl.delivery_line_id].order_line.product.name_ar,
                variant_info=_variant_label(delivery_lines[rl.delivery_line_id].order_line.variant),
                quantity=float(rl.quantity),
                notes=rl.notes,
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
    treasury = await get_main_treasury(db)
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
            to_account_id=treasury.id,
            amount=data.amount,
            description=f"تحصيل عميل ({method_label}) للطلب {order.order_number} إيصال {payment.receipt_number}",
            occurred_at=received_at,
            source_system="customer_payment",
            source_reference=payment.id,
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
    نتيجة فحص المرتجع:
    - restocked: نقل الكمية من حاوية "تحت الفحص" إلى الرصيد القابل للبيع لنفس نوع الطلب.
    - scrapped : إخراج الكمية من المخزون كهالك مع تحميل تكلفتها على مصروفات الإنتاج (5200).
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
        line_cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=catalog_item.id, unit_id=catalog_item.unit_id,
            warehouse_id=fg_wh.id, location_type="warehouse", quantity=-qty,
            unit_cost=unit_cost, total_cost=-line_cost,
            reference_doc_type="customer_return_inspection", reference_doc_id=return_doc.id,
            entry_type="return_inspection_release", created_by=current_user.id,
            bucket_reference=pending_bucket,
        ))
        if data.disposition == "restocked":
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=catalog_item.id, unit_id=catalog_item.unit_id,
                warehouse_id=fg_wh.id, location_type="warehouse", quantity=qty,
                unit_cost=unit_cost, total_cost=line_cost,
                reference_doc_type="customer_return_inspection", reference_doc_id=return_doc.id,
                entry_type="return_restock", created_by=current_user.id,
                bucket_reference=sellable_bucket,
            ))
        else:
            scrap_cost += line_cost

    if scrap_cost > Decimal("0.00"):
        await post_journal_entry(
            db,
            source_doc_type="customer_return_scrap",
            source_doc_id=return_doc.id,
            description=f"إعدام مرتجع تالف {return_doc.return_number}",
            lines=[
                {"account_code": "5200", "debit": scrap_cost, "credit": 0, "description": "هالك مرتجعات عملاء"},
                {"account_code": "1230", "debit": 0, "credit": scrap_cost, "description": "إخراج مرتجع تالف من مخزون التام"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )

    return_doc.disposition = data.disposition
    if data.notes.strip():
        return_doc.reason = f"{return_doc.reason} | الفحص: {data.notes.strip()}".strip(" |")
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
