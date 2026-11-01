import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.modules.production.models import Customer


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class CustomerOrder(Base):
    __tablename__ = "customer_orders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    customer_id: Mapped[str] = mapped_column(String(36), ForeignKey("customers.id"), nullable=False, index=True)
    order_type: Mapped[str] = mapped_column(String(32), nullable=False)  # ready_goods, custom_manufacturing
    status: Mapped[str] = mapped_column(String(32), default="open", nullable=False)
    order_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    expected_delivery_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    payment_terms: Mapped[str] = mapped_column(Text, default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    customer: Mapped[Customer] = relationship()
    lines: Mapped[list["CustomerOrderLine"]] = relationship(back_populates="order", cascade="all, delete-orphan")
    payments: Mapped[list["CustomerPayment"]] = relationship(back_populates="order", cascade="all, delete-orphan")
    deliveries: Mapped[list["CustomerDelivery"]] = relationship(back_populates="order", cascade="all, delete-orphan")


class CustomerOrderLine(Base):
    __tablename__ = "customer_order_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("products.id"), nullable=False)
    variant_id: Mapped[str] = mapped_column(String(36), ForeignKey("product_variants.id"), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)

    order: Mapped[CustomerOrder] = relationship(back_populates="lines")
    product: Mapped["Product"] = relationship()
    variant: Mapped["ProductVariant"] = relationship()
    production_orders: Mapped[list["ProductionOrder"]] = relationship(back_populates="customer_order_line")


class CustomerDelivery(Base):
    __tablename__ = "customer_deliveries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    delivery_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_orders.id"), nullable=False, index=True)
    delivered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    received_by: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    order: Mapped[CustomerOrder] = relationship(back_populates="deliveries")
    lines: Mapped[list["CustomerDeliveryLine"]] = relationship(back_populates="delivery", cascade="all, delete-orphan")
    returns: Mapped[list["CustomerDeliveryReturn"]] = relationship(back_populates="delivery", cascade="all, delete-orphan")


class CustomerDeliveryLine(Base):
    __tablename__ = "customer_delivery_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    delivery_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_deliveries.id", ondelete="CASCADE"), nullable=False, index=True)
    order_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_order_lines.id"), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)

    delivery: Mapped[CustomerDelivery] = relationship(back_populates="lines")
    order_line: Mapped[CustomerOrderLine] = relationship()


class CustomerDeliveryReturn(Base):
    __tablename__ = "customer_delivery_returns"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    return_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    delivery_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_deliveries.id"), nullable=False, index=True)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_orders.id"), nullable=False, index=True)
    customer_id: Mapped[str] = mapped_column(String(36), ForeignKey("customers.id"), nullable=False, index=True)
    returned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    received_by: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    disposition: Mapped[str] = mapped_column(String(32), default="pending_inspection", nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True, index=True)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    delivery: Mapped[CustomerDelivery] = relationship(back_populates="returns")
    order: Mapped[CustomerOrder] = relationship()
    customer: Mapped[Customer] = relationship()
    lines: Mapped[list["CustomerDeliveryReturnLine"]] = relationship(back_populates="return_doc", cascade="all, delete-orphan")


class CustomerDeliveryReturnLine(Base):
    __tablename__ = "customer_delivery_return_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    return_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_delivery_returns.id", ondelete="CASCADE"), nullable=False, index=True)
    delivery_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_delivery_lines.id"), nullable=False, index=True)
    order_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_order_lines.id"), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)

    return_doc: Mapped[CustomerDeliveryReturn] = relationship(back_populates="lines")
    delivery_line: Mapped[CustomerDeliveryLine] = relationship()
    order_line: Mapped[CustomerOrderLine] = relationship()


class CustomerPayment(Base):
    __tablename__ = "customer_payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    receipt_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("customer_orders.id"), nullable=False, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    method: Mapped[str] = mapped_column(String(32), nullable=False)  # cash, bank_transfer, other
    reference: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    recorded_by: Mapped[str] = mapped_column(String(64), nullable=False)

    order: Mapped[CustomerOrder] = relationship(back_populates="payments")
