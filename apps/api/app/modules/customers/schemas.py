from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    returned_quantity: float = 0.0
    remaining_quantity: float = 0.0


class CustomerDeliveryLineRead(BaseModel):
    id: str | None = None
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
    status: str = "approved"
    cash_document_id: str | None = None


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
    delivered_value: float = 0.0
    returned_value: float = 0.0
    receivable_amount: float = 0.0
    pending_payments_amount: float = 0.0
    returns: list["CustomerDeliveryReturnRead"] = []
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


ReturnCondition = Literal["good", "damaged", "unknown"]


class CustomerDeliveryReturnLineCreate(BaseModel):
    delivery_line_id: str
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    notes: str = Field(default="", max_length=1000)
    condition: ReturnCondition = "unknown"


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
    condition: str = "unknown"
    restocked_quantity: float = 0.0
    scrapped_quantity: float = 0.0


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
    created_by: str = ""
    inspected_by: str | None = None
    inspected_at: datetime | None = None
    inspection_notes: str = ""
    lines: list[CustomerDeliveryReturnLineRead]


class PendingDeliveryItemRead(BaseModel):
    order_id: str
    order_number: str
    order_date: datetime
    customer_id: str
    customer_name: str
    customer_code: str
    order_line_id: str
    product_id: str
    variant_id: str
    product_name: str
    variant_info: str
    requested_quantity: float
    delivered_quantity: float
    remaining_quantity: float
    available_stock: float
    status: str


class CustomerReturnInspectionLine(BaseModel):
    return_line_id: str
    restocked_quantity: Decimal = Field(ge=0, max_digits=12, decimal_places=3)
    scrapped_quantity: Decimal = Field(ge=0, max_digits=12, decimal_places=3)


class CustomerReturnInspectionCreate(BaseModel):
    """
    نتيجة فحص المرتجع، إما:
    - lines: لكل سطر الكمية الصالحة للبيع والكمية التالفة (مجموعهما = كمية السطر)، أو
    - disposition: قرار واحد للمستند كله (restocked / scrapped) للتوافق مع الاستخدام السابق.
    """
    disposition: Literal["restocked", "scrapped"] | None = None
    lines: list[CustomerReturnInspectionLine] | None = Field(default=None, min_length=1, max_length=100)
    notes: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def _one_mode(self):
        if (self.disposition is None) == (self.lines is None):
            raise ValueError("حدد نتيجة الفحص لكل سطر (lines) أو قراراً واحداً للمستند (disposition).")
        return self


class ReturnableDeliveryLineRead(BaseModel):
    delivery_line_id: str
    product_name: str
    variant_info: str
    delivered_quantity: float
    returned_quantity: float
    returnable_quantity: float


class ReturnableDeliveryRead(BaseModel):
    """سند تسليم يمكن تسجيل مرتجع عليه (يتبقى فيه كمية لم تُرتجع)."""
    delivery_id: str
    delivery_number: str
    delivered_at: datetime
    order_id: str
    order_number: str
    customer_id: str
    customer_name: str
    customer_code: str
    lines: list[ReturnableDeliveryLineRead]


class CustomerReturnListItemRead(CustomerDeliveryReturnRead):
    delivery_number: str = ""
    order_number: str = ""
    customer_name: str = ""
    customer_code: str = ""


class SoldItemRowRead(BaseModel):
    delivery_line_id: str
    delivery_id: str
    delivery_number: str
    delivered_at: datetime
    order_id: str
    order_number: str
    order_type: str
    order_status: str
    customer_id: str
    customer_code: str
    customer_name: str
    product_id: str
    product_code: str
    product_name: str
    variant_id: str
    variant_info: str
    ordered_quantity: float
    delivered_quantity: float
    returned_quantity: float
    net_sold_quantity: float
    unit_price: float
    net_unit_price: float
    delivered_value: float
    returned_value: float
    net_sold_value: float


class SoldItemsSummaryRead(BaseModel):
    lines_count: int
    distinct_products_count: int
    total_delivered_quantity: float
    total_returned_quantity: float
    total_net_sold_quantity: float
    total_delivered_value: float
    total_returned_value: float
    total_net_sold_value: float


class SoldItemsResponse(BaseModel):
    summary: SoldItemsSummaryRead
    items: list[SoldItemRowRead]


class OpeningCustomerBalanceCreate(BaseModel):
    original_order_number: str
    order_date: datetime
    amount: Decimal = Field(..., gt=0, max_digits=14, decimal_places=2)
    is_advance: bool = False
    notes: str | None = Field(default="", max_length=1000)


CustomerOrderRead.model_rebuild()
