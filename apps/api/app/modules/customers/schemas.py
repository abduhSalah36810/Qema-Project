from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CustomerCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    phone: str = Field(default="", max_length=32)
    city: str = Field(default="", max_length=64)
    address: str = Field(default="", max_length=4000)

    @field_validator("code", "name", "phone", "city", "address")
    @classmethod
    def trim_text(cls, value: str) -> str:
        return value.strip()


class CustomerUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=128)
    phone: str | None = Field(default=None, max_length=32)
    city: str | None = Field(default=None, max_length=64)
    address: str | None = Field(default=None, max_length=4000)
    status: Literal["active", "inactive"] | None = None

    @field_validator("code", "name", "phone", "city", "address")
    @classmethod
    def trim_text(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class CustomerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    code: str
    name: str
    phone: str | None
    city: str | None
    address: str | None
    status: str
    created_at: datetime


class CustomerOrderLineCreate(BaseModel):
    product_id: str
    variant_id: str
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    unit_price: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    notes: str = Field(default="", max_length=1000)


class CustomerOrderCreate(BaseModel):
    order_type: Literal["ready_goods", "custom_manufacturing"]
    expected_delivery_at: datetime | None = None
    discount_amount: Decimal = Field(default=Decimal("0"), ge=0, max_digits=14, decimal_places=2)
    payment_terms: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=4000)
    lines: list[CustomerOrderLineCreate] = Field(min_length=1, max_length=100)


class CustomerDeliveryLineCreate(BaseModel):
    order_line_id: str
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)


class CustomerDeliveryCreate(BaseModel):
    received_by: str = Field(default="", max_length=128)
    notes: str = Field(default="", max_length=2000)
    lines: list[CustomerDeliveryLineCreate] = Field(min_length=1, max_length=100)


class CustomerPaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    received_at: datetime | None = None
    method: Literal["cash", "bank_transfer", "other"]
    reference: str = Field(default="", max_length=128)
    notes: str = Field(default="", max_length=2000)


class ProductionOrderForCustomerCreate(BaseModel):
    customer_order_line_id: str
    template_version_id: str | None = None
    target_quantity: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=3)
    assigned_to: str = Field(default="", max_length=128)
    notes: str = Field(default="", max_length=2000)


class CustomerLinkedProductionOrderRead(BaseModel):
    id: str
    order_number: str
    status: str
    target_quantity: float


class CustomerOrderLineRead(BaseModel):
    id: str
    product_id: str
    product_name: str
    variant_id: str
    variant_info: str
    quantity: float
    unit_price: float
    line_total: float
    delivered_quantity: float
    production_orders: list["CustomerLinkedProductionOrderRead"]
    notes: str


class CustomerDeliveryLineRead(BaseModel):
    order_line_id: str
    product_name: str
    variant_info: str
    quantity: float


class CustomerDeliveryRead(BaseModel):
    id: str
    delivery_number: str
    delivered_at: datetime
    received_by: str
    notes: str
    lines: list[CustomerDeliveryLineRead]


class CustomerPaymentRead(BaseModel):
    id: str
    receipt_number: str
    amount: float
    received_at: datetime
    method: str
    reference: str
    notes: str
    recorded_by: str


class CustomerOrderRead(BaseModel):
    id: str
    order_number: str
    order_type: str
    status: str
    order_date: datetime
    expected_delivery_at: datetime | None
    discount_amount: float
    payment_terms: str
    notes: str
    gross_amount: float
    total_amount: float
    paid_amount: float
    balance_amount: float
    lines: list[CustomerOrderLineRead]
    deliveries: list[CustomerDeliveryRead]
    payments: list[CustomerPaymentRead]


class CustomerAccountRead(BaseModel):
    customer: CustomerRead
    orders: list[CustomerOrderRead]


class CustomerProductionOrderRead(BaseModel):
    id: str
    order_number: str
    status: str
    target_quantity: float
    product_name: str
    variant_info: str


class CustomerDeliveryReturnLineCreate(BaseModel):
    delivery_line_id: str
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    notes: str = Field(default="", max_length=1000)


class CustomerDeliveryReturnCreate(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)
    received_by: str = Field(default="", max_length=128)
    idempotency_key: str | None = Field(default=None, max_length=64)
    lines: list[CustomerDeliveryReturnLineCreate] = Field(min_length=1, max_length=100)


class CustomerDeliveryReturnLineRead(BaseModel):
    id: str
    delivery_line_id: str
    order_line_id: str
    product_name: str
    variant_info: str
    quantity: float
    notes: str


class CustomerDeliveryReturnRead(BaseModel):
    id: str
    return_number: str
    delivery_id: str
    order_id: str
    customer_id: str
    returned_at: datetime
    reason: str
    received_by: str
    disposition: str
    lines: list[CustomerDeliveryReturnLineRead]
