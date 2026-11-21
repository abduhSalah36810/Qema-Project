from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CashDocumentCreate(BaseModel):
    document_type: Literal["income", "expense", "transfer"]
    from_account_id: str | None = None
    to_account_id: str | None = None
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    description: str = Field(min_length=1, max_length=2000)
    expense_category: str | None = Field(default=None, max_length=64)
    occurred_at: datetime
    source_system: str | None = Field(default=None, max_length=64)
    source_reference: str | None = Field(default=None, max_length=128)
    supplier_id: str | None = Field(default=None, max_length=36)
    customer_id: str | None = Field(default=None, max_length=36)

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
        if self.supplier_id and self.customer_id:
            raise ValueError("لا يمكن تحديد مورد وعميل في نفس المستند.")
        if self.document_type == "expense" and self.customer_id:
            raise ValueError("المصروف يرتبط بمورد وليس بعميل.")
        if self.document_type == "income" and self.supplier_id:
            raise ValueError("المقبوض يرتبط بعميل وليس بمورد.")
        if self.document_type == "transfer" and (self.supplier_id or self.customer_id):
            raise ValueError("التحويل بين الحسابات النقدية لا يرتبط بمورد أو عميل.")
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
    expense_category: str | None = None
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
    supplier_id: str | None = None
    customer_id: str | None = None
    supplier_name: str | None = None
    customer_name: str | None = None
    unallocated_amount: Decimal | None = None
    invoice_total: Decimal | None = None
    received_value: Decimal | None = None
    is_prepayment: bool | None = None
    is_auto_posted: bool = False


class PaymentAllocationCreate(BaseModel):
    cash_document_id: str
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    notes: str = Field(default="", max_length=1000)


class PaymentAllocationRead(BaseModel):
    id: str
    allocation_number: str
    cash_document_id: str
    cash_document_number: str | None = None
    supplier_id: str | None = None
    customer_id: str | None = None
    supplier_invoice_id: str | None = None
    customer_order_id: str | None = None
    allocated_amount: Decimal
    allocated_at: datetime
    allocated_by: str
    notes: str


class UnallocatedPaymentRead(BaseModel):
    cash_document_id: str
    document_number: str
    document_type: str
    occurred_at: datetime
    total_amount: Decimal
    allocated_amount: Decimal
    unallocated_amount: Decimal
    description: str


class SupplierCreate(BaseModel):
    code: Optional[str] = Field(default=None, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    phone: str = Field(default="", max_length=32)
    address: str = Field(default="", max_length=2000)


class SupplierUpdate(BaseModel):
    """تعديل بيانات المورد الأساسية. لا يغير الفواتير أو المدفوعات السابقة."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    phone: Optional[str] = Field(default=None, max_length=32)
    address: Optional[str] = Field(default=None, max_length=2000)
    is_active: Optional[bool] = None


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
    discount_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    purchase_order_line_id: str | None = None
    notes: str = Field(default="", max_length=1000)


class SupplierInvoiceCreate(BaseModel):
    supplier_id: str
    purchase_order_id: str | None = None
    invoice_number: str = Field(min_length=1, max_length=128)
    invoice_date: datetime
    invoice_total: Optional[Decimal] = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    notes: str = Field(default="", max_length=2000)
    lines: list[SupplierInvoiceLineCreate] = Field(min_length=1, max_length=200)


class SupplierReceiptLine(BaseModel):
    line_id: str
    received_quantity: float = Field(ge=0, description="الكمية المستلمة في هذه الدفعة فقط (وليس الإجمالي التراكمي)")
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
    discount_amount: Decimal = Decimal("0.00")
    line_total: Decimal = Decimal("0.00")
    remaining_quantity: float = 0.0
    purchase_order_line_id: str | None = None


class SupplierPaymentLineRead(BaseModel):
    id: str
    cash_document_id: str
    amount: Decimal
    status: str
    created_by: str
    created_at: datetime


class SupplierInvoiceRead(BaseModel):
    id: str
    internal_number: str
    supplier_id: str
    supplier_name: str
    purchase_order_id: str | None = None
    purchase_order_number: str | None = None
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
    payments: list[SupplierPaymentLineRead] = Field(default_factory=list)
    received_value: Decimal = Decimal("0.00")
    pending_payments_total: Decimal = Decimal("0.00")
    payable_balance: Decimal = Decimal("0.00")
    # مؤشرات بلا مبالغ (تظهر لكل الأدوار): هل يوجد طلب سداد معلق؟ وهل يمكن طلب سداد كامل المستحق؟
    has_pending_payment_request: bool = False
    can_request_full_balance: bool = False
    is_opening: bool = False
    is_advance: bool = False
    approved_by: str | None = None
    approved_at: datetime | None = None


class SupplierFullBalanceRequest(BaseModel):
    notes: str = Field(default="", max_length=1000)


class SupplierFullBalanceRequestAck(BaseModel):
    """تأكيد طلب سداد كامل المستحق؛ لا يحمل أي مبلغ (المبلغ يظهر للمالية في الخزينة فقط)."""
    invoice_id: str
    invoice_internal_number: str
    supplier_name: str
    payment_request_id: str
    cash_document_number: str
    status: str
    message: str


class SupplierPaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    description: str = Field(min_length=1, max_length=1000)
    from_account_id: Optional[str] = None


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


class CustodySettlementCreate(BaseModel):
    """
    المستخدم يُدخل فقط النقدية التي يردها فعلياً للخزنة.
    المصروفات والمتبقي يحسبهما الخادم من دفتر النقدية؛ القيم المرسلة في الحقول الأخرى
    للتوافق فقط ولا تتجاوز الحساب الخادمي.
    """
    returned_cash_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    approved_expenses_amount: Optional[Decimal] = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    remaining_unsettled_amount: Optional[Decimal] = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    notes: str = Field(default="", max_length=2000)


class CustodySettlementRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    settlement_number: str
    custody_account_id: str
    custody_account_name: str = ""
    original_custody_amount: Decimal
    approved_expenses_amount: Decimal
    returned_cash_amount: Decimal
    remaining_unsettled_amount: Decimal
    status: str
    notes: str
    created_by: str
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    created_at: datetime
    is_mathematically_balanced: bool = True
    cash_document_id: Optional[str] = None


class PurchasedItemHistoryRow(BaseModel):
    line_id: str
    invoice_id: str
    internal_number: str
    invoice_number: str
    invoice_date: datetime
    invoice_status: str
    supplier_id: str
    supplier_code: str
    supplier_name: str
    item_id: str
    item_code: str
    item_name_ar: str
    item_type: str
    category_id: Optional[str] = None
    category_name_ar: Optional[str] = None
    unit_id: str
    unit_name_ar: str
    invoiced_quantity: float
    received_quantity: float
    remaining_quantity: float
    unit_price: Optional[Decimal] = None
    discount_amount: Optional[Decimal] = None
    net_unit_cost: Optional[Decimal] = None
    line_total: Optional[Decimal] = None
    notes: str = ""


class PurchasedItemsSummary(BaseModel):
    lines_count: int
    distinct_items_count: int
    total_invoiced_quantity: float
    total_received_quantity: float
    total_amount: Optional[Decimal] = None
    prices_visible: bool


class PurchasedItemsResponse(BaseModel):
    summary: PurchasedItemsSummary
    items: list[PurchasedItemHistoryRow]


class OpeningBalancesCreate(BaseModel):
    accounting_start_date: date
    treasury_balance: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    bank_balance: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    bank_account_id: Optional[str] = None
    custody_balance: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    accounts_receivable: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    raw_materials_inventory: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    wip_inventory: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    finished_goods_inventory: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    accounts_payable: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    paid_in_capital: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    notes: Optional[str] = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def validate_balance(self):
        disallowed = []
        if self.accounts_receivable > Decimal("0.00"):
            disallowed.append("1100 (ذمم العملاء)")
        if self.raw_materials_inventory > Decimal("0.00"):
            disallowed.append("1210 (مخزون الخامات)")
        if self.wip_inventory > Decimal("0.00"):
            disallowed.append("1220 (إنتاج تحت التشغيل)")
        if self.finished_goods_inventory > Decimal("0.00"):
            disallowed.append("1230 (مخزون التام)")
        if self.accounts_payable > Decimal("0.00"):
            disallowed.append("2100 (ذمم الموردين)")
        if disallowed:
            raise ValueError(
                f"يُحظر إدخال أرصدة للحسابات التالية في القيد الافتتاحي العام: {', '.join(disallowed)}. "
                "أرصدة المخزون والعملاء والموردين تُسجل حصرياً عبر مستنداتها الافتتاحية المخصصة "
                "(الجرد الافتتاحي، فواتير الموردين الافتتاحية، وأرصدة العملاء الافتتاحية) لمنع ازدواجية القيود."
            )

        total_assets = (
            self.treasury_balance
            + self.bank_balance
            + self.custody_balance
            + self.accounts_receivable
            + self.raw_materials_inventory
            + self.wip_inventory
            + self.finished_goods_inventory
        )
        total_liabilities_equity = self.accounts_payable + self.paid_in_capital
        diff = total_assets - total_liabilities_equity
        if abs(diff) != Decimal("0.00"):
            raise ValueError(
                f"القيد الافتتاحي غير متوازن. إجمالي الأصول ({total_assets:.2f}) لا يساوي إجمالي الالتزامات ورأس المال ({total_liabilities_equity:.2f}). الفارق: {abs(diff):.2f} ج.م. لا يجوز ترحيل رصيد افتتاحي غير متوازن أو تسوية الفارق آلياً دون قرار محاسبي معتمد من إدارة المصنع."
            )
        return self


class OpeningSupplierInvoiceCreate(BaseModel):
    supplier_id: str
    invoice_number: str
    invoice_date: datetime
    amount: Decimal = Field(..., gt=0, max_digits=14, decimal_places=2)
    is_advance: bool = False
    notes: Optional[str] = Field(default="", max_length=1000)


class OpeningBalancesRead(BaseModel):
    is_set: bool
    accounting_start_date: Optional[date] = None
    journal_entry_id: Optional[str] = None
    journal_entry_number: Optional[str] = None
    posted_at: Optional[datetime] = None
    posted_by: Optional[str] = None
    total_assets: Decimal = Decimal("0.00")
    total_liabilities_and_equity: Decimal = Decimal("0.00")
    is_balanced: bool = True
    details: dict[str, Decimal] = {}
    message: str = ""


class OpeningBalancesUnlockRequestCreate(BaseModel):
    reason: str = Field(..., min_length=5, max_length=1000, description="سبب إلزامي لطلب فتح قفل الأرصدة الافتتاحية")


class OpeningBalancesUnlockApproveCreate(BaseModel):
    request_id: Optional[str] = Field(default=None, description="معرف طلب فتح القفل المراد اعتماده")
    approval_notes: Optional[str] = Field(default="", max_length=1000)


class OpeningBalancesLockCreate(BaseModel):
    reason: Optional[str] = Field(default="قفل رسمي للأرصدة الافتتاحية من الإدارة العامة", max_length=1000)


class AccountingLockRead(BaseModel):
    id: str
    lock_type: str
    is_locked: bool
    action: str
    reason: str
    performed_by: str
    performed_at: datetime
    requested_by: Optional[str] = None
    unlock_request_id: Optional[str] = None


class AccountingLockStatusRead(BaseModel):
    is_locked: bool
    lock_type: str = "opening_balances"
    current_action: Optional[str] = None
    latest_reason: Optional[str] = None
    latest_performed_by: Optional[str] = None
    latest_performed_at: Optional[datetime] = None
    history: list[AccountingLockRead] = Field(default_factory=list)



# ─── أوامر الشراء وإدارة عجز الإنتاج (Purchase Orders - Phase 5 / T5) ────────

class PurchaseOrderLineCreate(BaseModel):
    item_id: str
    unit_id: str
    ordered_quantity: float = Field(gt=0)
    unit_price: Decimal = Field(default=Decimal("0.0000"), ge=0)
    production_order_material_id: str | None = None
    notes: str = Field(default="", max_length=1000)


class PurchaseOrderCreate(BaseModel):
    supplier_id: str
    production_order_id: str | None = None
    expected_delivery_date: datetime | None = None
    notes: str = Field(default="", max_length=2000)
    lines: list[PurchaseOrderLineCreate] = Field(min_length=1, max_length=200)


class PurchaseOrderUpdate(BaseModel):
    supplier_id: str | None = None
    expected_delivery_date: datetime | None = None
    notes: str | None = Field(default=None, max_length=2000)
    lines: list[PurchaseOrderLineCreate] | None = None


class PurchaseOrderLineRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    purchase_order_id: str
    item_id: str
    item_code: str = ""
    item_name_ar: str = ""
    unit_id: str
    unit_name_ar: str = ""
    ordered_quantity: float
    received_quantity: float = 0.0
    remaining_quantity: float = 0.0
    unit_price: Decimal | None = None
    total_price: Decimal | None = None
    production_order_material_id: str | None = None
    notes: str = ""


class PurchaseOrderReceiptItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    receipt_number: str
    received_by: str
    received_at: datetime
    total_cost: Decimal | None = None
    notes: str = ""


class PurchaseOrderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    order_number: str
    supplier_id: str
    supplier_code: str = ""
    supplier_name: str = ""
    production_order_id: str | None = None
    production_order_number: str | None = None
    status: str
    status_label_ar: str = ""
    expected_delivery_date: datetime | None = None
    total_amount: Decimal | None = None
    prices_visible: bool = True
    total_ordered_quantity: float = 0.0
    total_received_quantity: float = 0.0
    total_remaining_quantity: float = 0.0
    notes: str = ""
    created_by: str
    approved_by: str | None = None
    approved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    lines: list[PurchaseOrderLineRead] = []
    receipts: list[PurchaseOrderReceiptItemRead] = []


class PurchaseOrderReceiptLineInput(BaseModel):
    line_id: str
    received_quantity: float = Field(gt=0)
    notes: str = Field(default="", max_length=500)


class PurchaseOrderReceiptConfirm(BaseModel):
    lines: list[PurchaseOrderReceiptLineInput] = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=2000)


class MaterialShortageItem(BaseModel):
    item_id: str
    item_code: str
    item_name_ar: str
    unit_id: str
    unit_name_ar: str
    is_cmt_customer_material: bool = False
    required_quantity: float
    dispatched_quantity: float
    net_required_quantity: float
    available_stock: float
    pending_inbound_quantity: float
    shortage_quantity: float
    proposed_purchase_quantity: float
    has_shortage: bool = False
    suggested_supplier_id: str | None = None
    suggested_unit_price: Decimal = Decimal("0.0000")
    notes: str = ""


class ProductionOrderShortageReport(BaseModel):
    order_id: str
    order_number: str
    manufacturing_type: str
    customer_id: str | None = None
    customer_name: str | None = None
    has_shortage: bool
    has_any_shortage: bool = False
    can_start_production: bool = True
    total_shortage_items_count: int = 0
    materials: list[MaterialShortageItem]
    existing_purchase_orders: list[PurchaseOrderRead] = []


class GeneratePurchaseOrdersLineInput(BaseModel):
    item_id: str
    unit_id: str
    supplier_id: str
    quantity: float = Field(gt=0)
    unit_price: Decimal = Field(default=Decimal("0.0000"), ge=0)
    notes: str = Field(default="", max_length=1000)


class GeneratePurchaseOrdersRequest(BaseModel):
    lines: list[GeneratePurchaseOrdersLineInput] = Field(min_length=1, max_length=200)
    expected_delivery_date: datetime | None = None
    notes: str = Field(default="", max_length=2000)



