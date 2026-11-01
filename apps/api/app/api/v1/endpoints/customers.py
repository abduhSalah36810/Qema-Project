import hashlib
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import require_permission
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
from app.modules.finance.models import CashAccount, CashDocument
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
from app.modules.production.schemas import OrderCreate
from app.modules.production.service import (
    create_production_order,
    get_or_create_finished_goods_item,
)

router = APIRouter(prefix="/customers", tags=["customers"])
CustomerManager = Annotated[AuthenticatedUser, Depends(require_permission("customers:manage"))]
Database = Annotated[AsyncSession, Depends(get_db)]
CustomerViewer = Annotated[AuthenticatedUser, Depends(require_permission("customers:view"))]
DeliveryManager = Annotated[AuthenticatedUser, Depends(require_permission("customers:deliveries:manage"))]
FinanceManager = Annotated[AuthenticatedUser, Depends(require_permission("finance:payments:manage"))]


def _variant_label(variant: ProductVariant) -> str:
    parts = [str(variant.numeric_size) if variant.numeric_size is not None else "", variant.letter_size or "", variant.season or ""]
    return " · ".join(part for part in parts if part)


def _order_payload(order: CustomerOrder) -> dict:
    delivered_by_line: dict[str, Decimal] = {}
    deliveries = []
    for delivery in sorted(order.deliveries, key=lambda entry: entry.delivered_at):
        delivery_lines = []
        for line in delivery.lines:
            delivered_by_line[line.order_line_id] = delivered_by_line.get(line.order_line_id, Decimal("0")) + line.quantity
            order_line = line.order_line
            delivery_lines.append({
                "order_line_id": line.order_line_id,
                "product_name": order_line.product.name_ar,
                "variant_info": _variant_label(order_line.variant),
                "quantity": line.quantity,
            })
        deliveries.append({
            "id": delivery.id,
            "delivery_number": delivery.delivery_number,
            "delivered_at": delivery.delivered_at,
            "received_by": delivery.received_by,
            "notes": delivery.notes,
            "lines": delivery_lines,
        })

    lines = []
    gross_amount = Decimal("0")
    for line in order.lines:
        line_total = (line.quantity * line.unit_price).quantize(Decimal("0.01"))
        gross_amount += line_total
        lines.append({
            "id": line.id,
            "product_id": line.product_id,
            "product_name": line.product.name_ar,
            "variant_id": line.variant_id,
            "variant_info": _variant_label(line.variant),
            "quantity": line.quantity,
            "unit_price": line.unit_price,
            "line_total": line_total,
            "delivered_quantity": delivered_by_line.get(line.id, Decimal("0")),
            "production_orders": [
                {
                    "id": production.id,
                    "order_number": production.order_number,
                    "status": production.status,
                    "target_quantity": Decimal(str(production.target_quantity)),
                }
                for production in sorted(production_orders, key=lambda entry: entry.created_at)
            ] if (production_orders := line.production_orders) else [],
            "notes": line.notes,
        })
    total_amount = gross_amount - order.discount_amount
    paid_amount = sum((payment.amount for payment in order.payments), Decimal("0"))
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
        "gross_amount": gross_amount,
        "total_amount": total_amount,
        "paid_amount": paid_amount,
        "balance_amount": total_amount - paid_amount,
        "lines": lines,
        "deliveries": deliveries,
        "payments": [
            {
                "id": payment.id,
                "receipt_number": payment.receipt_number,
                "amount": payment.amount,
                "received_at": payment.received_at,
                "method": payment.method,
                "reference": payment.reference,
                "notes": payment.notes,
                "recorded_by": payment.recorded_by,
            }
            for payment in sorted(order.payments, key=lambda entry: entry.received_at)
        ],
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
    )


async def _load_order(db: AsyncSession, order_id: str, customer_id: str | None = None, *, lock: bool = False) -> CustomerOrder:
    stmt = select(CustomerOrder).options(*_order_load_options()).where(CustomerOrder.id == order_id)
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


@router.post("/{customer_id}/orders", response_model=CustomerOrderRead, status_code=status.HTTP_201_CREATED)
async def create_customer_order(customer_id: str, data: CustomerOrderCreate, current_user: CustomerManager, db: Database):
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

    delivered_result = await db.execute(
        select(CustomerDeliveryLine.order_line_id, func.sum(CustomerDeliveryLine.quantity))
        .join(CustomerDelivery, CustomerDelivery.id == CustomerDeliveryLine.delivery_id)
        .where(CustomerDelivery.order_id == order.id)
        .group_by(CustomerDeliveryLine.order_line_id)
    )
    delivered_so_far = {line_id: quantity or Decimal("0") for line_id, quantity in delivered_result.all()}
    for line in data.lines:
        remaining = order_lines[line.order_line_id].quantity - delivered_so_far.get(line.order_line_id, Decimal("0"))
        if line.quantity > remaining:
            raise HTTPException(status_code=409, detail="كمية التسليم تتجاوز الكمية المتبقية في الطلب.")

    now = datetime.now(timezone.utc)
    delivery = CustomerDelivery(
        id=str(uuid.uuid4()), delivery_number=f"DL-{now.year}-{uuid.uuid4().hex[:8].upper()}",
        order_id=order.id, delivered_at=now, received_by=data.received_by.strip(),
        notes=data.notes.strip(), created_by=current_user.id,
        lines=[CustomerDeliveryLine(id=str(uuid.uuid4()), order_line_id=line.order_line_id, quantity=line.quantity) for line in data.lines],
    )
    db.add(delivery)

    # خصم رصيد المنتج التام من مخزن المنتج التام مع حظر الرصيد السالب بشكل صارم
    fg_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    if not fg_wh:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="مخزن المنتجات التامة غير مهيأ في النظام.")

    for line in data.lines:
        order_line = order_lines[line.order_line_id]
        catalog_item = await get_or_create_finished_goods_item(db, order_line.product_id, order_line.variant_id)

        # قفل سجل الصنف المعياري لضمان تسلسل عمليات الخصم وحظر الرصيد السالب في بيئة التزامن
        await db.scalar(
            select(CatalogItem.id)
            .where(CatalogItem.id == catalog_item.id)
            .with_for_update()
        )

        bucket_ref = f"private_label:{customer_id}" if order.order_type == "custom_manufacturing" else "factory_brand"

        # فحص الرصيد الفعلي المتاح في مخزن التام قبل التسليم لمنع الرصيد السالب
        stock_stmt = (
            select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0))
            .where(
                StockLedgerEntry.item_id == catalog_item.id,
                StockLedgerEntry.warehouse_id == fg_wh.id,
                StockLedgerEntry.location_type == "warehouse",
                StockLedgerEntry.bucket_reference == bucket_ref,
            )
        )
        available_stock = float((await db.scalar(stock_stmt)) or 0.0)
        req_qty = float(line.quantity)
        if req_qty > available_stock:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"الرصيد المتاح من الصنف '{catalog_item.name_ar}' في مخزن التام ({available_stock}) لا يكفي لتسليم الكمية المطلوبة ({req_qty}).",
            )

        db.add(
            StockLedgerEntry(
                id=str(uuid.uuid4()),
                item_id=catalog_item.id,
                unit_id=catalog_item.unit_id,
                warehouse_id=fg_wh.id,
                location_type="warehouse",
                quantity=-req_qty,
                reference_doc_type="customer_delivery",
                reference_doc_id=delivery.id,
                entry_type="customer_delivery_dispatch",
                created_by=current_user.id,
                bucket_reference=bucket_ref,
            )
        )

    all_delivered = all(
        delivered_so_far.get(line.id, Decimal("0"))
        + sum((entry.quantity for entry in data.lines if entry.order_line_id == line.id), Decimal("0"))
        >= line.quantity
        for line in order.lines
    )
    order.status = "delivered" if all_delivered else "partially_delivered"
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

    return_lines_to_add = []
    fg_wh = await db.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))

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

        # إضافة قيد عكسي موجب بالدفتر مع عزله في bucket فحص المرتجع لعدم بيعه تلقائياً
        if fg_wh:
            catalog_item = await get_or_create_finished_goods_item(db, order_line.product_id, order_line.variant_id)
            db.add(
                StockLedgerEntry(
                    id=str(uuid.uuid4()),
                    item_id=catalog_item.id,
                    unit_id=catalog_item.unit_id,
                    warehouse_id=fg_wh.id,
                    location_type="warehouse",
                    quantity=float(line.quantity),
                    reference_doc_type="customer_delivery_return",
                    reference_doc_id=return_doc.id,
                    entry_type="customer_delivery_return",
                    created_by=current_user.id,
                    bucket_reference=f"return_pending_inspection:{customer_id}",
                )
            )

    # 6. تحديث حالة الطلب وفق صافي الكميات المسلمة
    all_deliveries_res = await db.execute(
        select(CustomerDeliveryLine.order_line_id, func.sum(CustomerDeliveryLine.quantity))
        .join(CustomerDelivery, CustomerDelivery.id == CustomerDeliveryLine.delivery_id)
        .where(CustomerDelivery.order_id == order.id)
        .group_by(CustomerDeliveryLine.order_line_id)
    )
    total_delivered_by_line = {line_id: Decimal(str(qty or 0)) for line_id, qty in all_deliveries_res.all()}

    all_returns_res = await db.execute(
        select(CustomerDeliveryReturnLine.order_line_id, func.sum(CustomerDeliveryReturnLine.quantity))
        .join(CustomerDeliveryReturn, CustomerDeliveryReturn.id == CustomerDeliveryReturnLine.return_id)
        .where(CustomerDeliveryReturn.order_id == order.id)
        .group_by(CustomerDeliveryReturnLine.order_line_id)
    )
    total_returned_by_line = {line_id: Decimal(str(qty or 0)) for line_id, qty in all_returns_res.all()}
    for line in data.lines:
        ol_id = delivery_lines[line.delivery_line_id].order_line_id
        total_returned_by_line[ol_id] = total_returned_by_line.get(ol_id, Decimal("0")) + line.quantity

    any_delivered = any(
        (total_delivered_by_line.get(l.id, Decimal("0")) - total_returned_by_line.get(l.id, Decimal("0"))) > 0
        for l in order.lines
    )
    all_satisfied = all(
        (total_delivered_by_line.get(l.id, Decimal("0")) - total_returned_by_line.get(l.id, Decimal("0"))) >= l.quantity
        for l in order.lines
    )

    if all_satisfied:
        order.status = "delivered"
    elif any_delivered:
        order.status = "partially_delivered"
    else:
        order.status = "open"

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
    order = await db.get(CustomerOrder, order_id)
    if order is None or order.customer_id != customer_id:
        raise HTTPException(status_code=404, detail="معاملة العميل غير موجودة.")
    if order.status == "cancelled":
        raise HTTPException(status_code=409, detail="لا يمكن تسجيل تحصيل على معاملة ملغاة.")
    treasury = await db.scalar(select(CashAccount).where(
        CashAccount.account_type == "treasury", CashAccount.is_active.is_(True),
    ))
    if treasury is None:
        raise HTTPException(status_code=503, detail="الخزنة الرئيسية غير مهيأة لتسجيل التحصيل.")
    now = datetime.now(timezone.utc)
    payment = CustomerPayment(
        id=str(uuid.uuid4()), receipt_number=f"RC-{now.year}-{uuid.uuid4().hex[:8].upper()}",
        order_id=order.id, amount=data.amount, received_at=data.received_at or now,
        method=data.method, reference=data.reference.strip(), notes=data.notes.strip(), recorded_by=current_user.id,
    )
    db.add(payment)
    db.add(CashDocument(
        id=str(uuid.uuid4()),
        document_number=f"CSH-RC-{uuid.uuid4().hex[:10].upper()}",
        document_type="income", from_account_id=None, to_account_id=treasury.id,
        amount=data.amount, description=f"تحصيل عميل مرتبط بإيصال {payment.receipt_number}",
        occurred_at=payment.received_at, source_system="customer_payment",
        source_reference=payment.id, status="pending", created_by=current_user.id,
    ))
    await db.commit()
    return CustomerPaymentRead(
        id=payment.id, receipt_number=payment.receipt_number, amount=payment.amount,
        received_at=payment.received_at, method=payment.method, reference=payment.reference,
        notes=payment.notes, recorded_by=payment.recorded_by,
    )


@router.post("/{customer_id}/orders/{order_id}/production-orders", response_model=CustomerProductionOrderRead, status_code=status.HTTP_201_CREATED)
async def create_linked_production_order(
    customer_id: str,
    order_id: str,
    data: ProductionOrderForCustomerCreate,
    current_user: CustomerManager,
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
    if data.template_version_id is None:
        raise HTTPException(status_code=422, detail="اختر إصدار قالب معتمدًا لإنشاء أمر التشغيل.")
    version = await db.get(ProductionTemplateVersion, data.template_version_id)
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
            product_id=line.product_id, variant_id=line.variant_id, target_quantity=float(target),
            season=variant.season, template_version_id=version.id,
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
