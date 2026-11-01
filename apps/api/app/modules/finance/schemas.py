from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CashDocumentCreate(BaseModel):
    document_type: Literal["income", "expense", "transfer"]
    from_account_id: str | None = None
    to_account_id: str | None = None
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    description: str = Field(min_length=1, max_length=2000)
    occurred_at: datetime
    source_system: str | None = Field(default=None, max_length=64)
    source_reference: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def validate_accounts(self):
        if self.document_type == "income" and (self.from_account_id or not self.to_account_id):
            raise ValueError("الإيراد يجب أن يودع في حساب واحد.")
        if self.document_type == "expense" and (not self.from_account_id or self.to_account_id):
            raise ValueError("المصروف يجب أن يصرف من حساب واحد.")
        if self.document_type == "transfer" and (not self.from_account_id or not self.to_account_id or self.from_account_id == self.to_account_id):
            raise ValueError("التحويل يتطلب حساب مصدر ووجهة مختلفين.")
        if bool(self.source_system) != bool(self.source_reference):
            raise ValueError("مرجع المصدر يتطلب اسم النظام والمرجع معاً.")
        return self


class CashDocumentDecision(BaseModel):
    decision: Literal["approve", "reject"]
    rejection_reason: str | None = Field(default=None, min_length=1, max_length=2000)


class CashAccountRead(BaseModel):
    id: str
    account_number: str
    name: str
    account_type: str
    parent_account_id: str | None
    is_active: bool
    balance: Decimal


class CashDocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    document_number: str
    document_type: str
    from_account_id: str | None
    to_account_id: str | None
    amount: Decimal
    description: str
    occurred_at: datetime
    status: str
    source_system: str | None
    source_reference: str | None
    created_by: str
    approved_by: str | None
    approved_at: datetime | None
    rejected_by: str | None
    rejected_at: datetime | None
    rejection_reason: str | None


class SupplierCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    phone: str = Field(default="", max_length=32)
    address: str = Field(default="", max_length=2000)


class SupplierRead(BaseModel):
    id: str
    code: str
    name: str
    phone: str
    address: str
    is_active: bool


class SupplierInvoiceLineCreate(BaseModel):
    item_id: str
    unit_id: str
    invoiced_quantity: float = Field(gt=0)
    unit_price: Decimal = Field(ge=0, max_digits=14, decimal_places=4)
    notes: str = Field(default="", max_length=1000)


class SupplierInvoiceCreate(BaseModel):
    supplier_id: str
    invoice_number: str = Field(min_length=1, max_length=128)
    invoice_date: datetime
    invoice_total: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    notes: str = Field(default="", max_length=2000)
    lines: list[SupplierInvoiceLineCreate] = Field(min_length=1, max_length=200)


class SupplierReceiptLine(BaseModel):
    line_id: str
    received_quantity: float = Field(ge=0)
    notes: str = Field(default="", max_length=1000)


class SupplierReceiptConfirm(BaseModel):
    lines: list[SupplierReceiptLine] = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=2000)


class SupplierInvoiceLineRead(BaseModel):
    id: str
    item_id: str
    item_code: str
    item_name_ar: str
    unit_id: str
    unit_name_ar: str
    invoiced_quantity: float
    received_quantity: float
    unit_price: Decimal
    notes: str


class SupplierInvoiceRead(BaseModel):
    id: str
    internal_number: str
    supplier_id: str
    supplier_name: str
    invoice_number: str
    invoice_date: datetime
    invoice_total: Decimal
    paid_total: Decimal
    balance_due: Decimal
    status: str
    notes: str
    created_by: str
    received_by: str | None
    received_at: datetime | None
    lines: list[SupplierInvoiceLineRead]


class SupplierPaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    description: str = Field(min_length=1, max_length=1000)


class PettyCashSettlementRead(BaseModel):
    account_id: str
    account_name: str
    settlement_amount: Decimal
    treasury_name: str
    transfer_document_id: Optional[str] = None
    settled_at: datetime
    settled_by: str


class DailyExpenseCreate(BaseModel):
    category: str = Field(min_length=1, max_length=64)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    description: str = Field(default="", max_length=2000)
    from_account_id: str
    expense_date: Optional[datetime] = None


class DailyExpenseRead(BaseModel):
    id: str
    category: str
    amount: Decimal
    description: str
    created_by: str
    expense_date: datetime
    status: str
    cash_document_id: Optional[str] = None
