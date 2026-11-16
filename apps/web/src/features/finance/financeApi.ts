import { apiClient, ApiError } from '@/lib/api';

/** التقارير أثقل من الشاشات العادية: مهلة أطول من الافتراضي (5 ثوانٍ) */
export const REPORT_OPTIONS = { timeoutMs: 30000 };

/** تحويل قيمة مالية (رقم أو نص عشري أو null) إلى رقم آمن دون NaN */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** تنسيق مبلغ بالجنيه المصري مع معالجة القيم الفارغة */
export function formatMoney(value: unknown): string {
  return `${toNumber(value).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
}

/** استخراج رسالة الخطأ العربية القادمة من الخادم أو نص بديل */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export type CashSourceSystem =
  | 'supplier_payment'
  | 'customer_payment'
  | 'payroll'
  | 'custody_settlement'
  | 'daily_expense';

export const CASH_SOURCE_LABELS: Record<CashSourceSystem | 'manual', string> = {
  supplier_payment: 'دفعة مورد',
  customer_payment: 'تحصيل عميل',
  payroll: 'صرف رواتب',
  custody_settlement: 'تسوية عهدة',
  daily_expense: 'مصروف يومي من عهدة',
  manual: 'مستند يدوي',
};

export function cashSourceLabel(source: string | null | undefined): string {
  if (!source) return CASH_SOURCE_LABELS.manual;
  return CASH_SOURCE_LABELS[source as CashSourceSystem] ?? source;
}

export const CASH_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار اعتماد الخزينة',
  approved: 'معتمد',
  rejected: 'مرفوض',
  reversed: 'معكوس',
};

export function cashStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return CASH_STATUS_LABELS[status] ?? status;
}

export const PENDING_TREASURY_NOTE = 'بانتظار الاعتماد من شاشة الخزينة';

export type CashAccount = {
  id: string;
  account_number: string;
  name: string;
  account_type: 'treasury' | 'petty_cash' | 'bank';
  parent_account_id: string | null;
  is_active: boolean;
  balance: string;
};

export type CashDocument = {
  id: string;
  document_number: string;
  document_type: 'income' | 'expense' | 'transfer';
  from_account_id: string | null;
  to_account_id: string | null;
  amount: string;
  description: string;
  occurred_at: string;
  status: string;
  source_system?: string | null;
  source_reference?: string | null;
  created_by: string;
  approved_by: string | null;
  approved_at?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  rejection_reason: string | null;
  supplier_id?: string | null;
  customer_id?: string | null;
  supplier_name?: string | null;
  customer_name?: string | null;
  unallocated_amount?: string | number | null;
  invoice_total?: string | number | null;
  received_value?: string | number | null;
  is_prepayment?: boolean | null;
  is_auto_posted?: boolean | null;
};

export type UnallocatedPayment = {
  cash_document_id: string;
  document_number: string;
  document_type: string;
  occurred_at: string;
  total_amount: number | string;
  allocated_amount: number | string;
  unallocated_amount: number | string;
  description: string;
};

export type PaymentAllocationCreate = {
  cash_document_id: string;
  amount: number | string;
  notes?: string;
};

export type PaymentAllocationRead = {
  id: string;
  allocation_number: string;
  cash_document_id: string;
  cash_document_number?: string | null;
  supplier_id?: string | null;
  customer_id?: string | null;
  supplier_invoice_id?: string | null;
  customer_order_id?: string | null;
  allocated_amount: number | string;
  allocated_at: string;
  allocated_by: string;
  notes: string;
};

export type Supplier = {
  id: string;
  code: string;
  name: string;
  phone: string;
  address: string;
  is_active: boolean;
};

export type SupplierInvoice = {
  id: string;
  internal_number: string;
  supplier_id: string;
  supplier_name: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total: string | number;
  paid_total: string | number;
  balance_due: string | number;
  received_value?: string | number;
  pending_payments_total?: string | number;
  payable_balance?: string | number;
  status: 'awaiting_receipt' | 'partially_received' | 'received' | 'cancelled' | string;
  notes: string;
  created_by: string;
  received_by: string | null;
  received_at: string | null;
  lines: Array<{
    id: string;
    item_id: string;
    item_code: string;
    item_name_ar: string;
    unit_id: string;
    unit_name_ar: string;
    invoiced_quantity: number;
    received_quantity: number;
    unit_price: string | number;
    discount_amount?: string | number;
    line_total?: string | number;
    remaining_quantity?: number;
    notes: string;
  }>;
  payments?: Array<{
    id: string;
    cash_document_id: string;
    amount: string | number;
    status: string;
    created_by: string;
    created_at: string;
  }>;
};

export const SUPPLIER_INVOICE_STATUS_LABELS: Record<string, string> = {
  awaiting_receipt: 'بانتظار الاستلام',
  partially_received: 'مستلمة جزئياً',
  received: 'مستلمة بالكامل',
  cancelled: 'ملغاة',
};

export type SupplierInvoiceCreatePayload = {
  supplier_id: string;
  invoice_number: string;
  invoice_date: string;
  notes: string;
  lines: Array<{
    item_id: string;
    unit_id: string;
    invoiced_quantity: number;
    unit_price: string;
    discount_amount: string;
    notes: string;
  }>;
};

export type SupplierReceiptPayload = {
  lines: Array<{ line_id: string; received_quantity: number; notes: string }>;
  notes: string;
};

export type CustodySettlementPreview = {
  account_id: string;
  account_name: string;
  account_number: string;
  is_active: boolean;
  original_custody_amount: number;
  total_funded?: number;
  total_expenses_recorded: number;
  previously_returned?: number;
  current_balance: number;
  suggested_returned_cash: number;
  has_pending_settlement?: boolean;
  formula: string;
};

export type CustodySettlementRead = {
  id: string;
  settlement_number: string;
  custody_account_id: string;
  custody_account_name: string;
  original_custody_amount: number | string;
  approved_expenses_amount: number | string;
  returned_cash_amount: number | string;
  remaining_unsettled_amount: number | string;
  status: string;
  notes: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  is_mathematically_balanced: boolean;
  cash_document_id?: string | null;
};
export type AccountsReceivableReport = {
  summary: {
    total_customers: number;
    total_invoiced: number;
    total_collected: number;
    total_receivables: number;
  };
  customers: Array<{
    customer_id: string;
    code: string;
    name: string;
    phone: string | null;
    orders_count: number;
    total_ordered?: number;
    total_invoiced: number;
    total_paid: number;
    pending_payments?: number;
    balance_due: number;
  }>;
};

export type AccountsPayableReport = {
  summary: {
    total_suppliers: number;
    total_invoiced: number;
    total_received: number;
    total_paid: number;
    total_payables: number;
  };
  suppliers: Array<{
    supplier_id: string;
    code: string;
    name: string;
    phone: string | null;
    invoices_count: number;
    total_invoiced: number;
    total_received: number;
    total_paid: number;
    pending_payments?: number;
    balance_due: number;
  }>;
};

export type CustomerStatementReport = {
  customer: { id: string; name: string; code: string; phone: string | null };
  totals: {
    total_ordered: number;
    total_invoiced: number;
    total_returned: number;
    total_paid: number;
    pending_payments: number;
    balance_due: number;
  };
  orders: Array<{
    order_id: string;
    order_number: string;
    order_type: string;
    status: string;
    gross_amount: number;
    discount_amount: number;
    total_amount: number;
    delivered_value: number;
    returned_value: number;
    paid_amount: number;
    pending_payments: number;
    balance_due: number;
    remaining_on_order: number;
    created_at: string | null;
  }>;
};

export type SupplierStatementReport = {
  supplier: { id: string; code: string; name: string; phone: string | null };
  totals: {
    total_invoiced: number;
    total_received: number;
    total_paid: number;
    pending_payments: number;
    balance_due: number;
  };
  invoices: Array<{
    invoice_id: string;
    internal_number: string;
    invoice_number: string;
    invoice_date: string | null;
    status: string;
    invoice_total: number;
    received_value: number;
    paid_total: number;
    pending_payments: number;
    balance_due: number;
    remaining_on_invoice: number;
  }>;
};

export type CashFlowReport = {
  period_days: number;
  since: string;
  summary: {
    total_inflows: number;
    total_outflows: number;
    net_cash_flow: number;
    customer_collections: number;
    supplier_payments: number;
    operating_expenses: number;
  };
  items: Array<{
    id: string;
    number: string;
    type: string;
    amount: number;
    category: string;
    description: string;
    occurred_at: string | null;
  }>;
};

export type CustodyReconciliationReport = {
  totals: {
    original_amount: number;
    approved_expenses: number;
    returned_cash: number;
    remaining_unsettled: number;
  };
  accounts: Array<{
    account_id: string;
    account_number: string;
    name: string;
    is_active: boolean;
    status: string;
    original_amount: number;
    approved_expenses: number;
    returned_to_treasury: number;
    current_balance: number;
    remaining_unsettled: number;
    settlement_number: string | null;
    is_balanced: boolean;
  }>;
};

export type ExpenseAnalysisReport = {
  period_days: number;
  total_expenses: number;
  categories: Array<{ category: string; amount: number; percentage: number }>;
  items_count: number;
};

export type InventoryValuationReport = {
  grand_total_valuation: number;
  warehouses: Record<
    string,
    {
      warehouse_name_ar: string;
      warehouse_code: string;
      total_valuation: number;
      items: Array<{
        item_id: string;
        item_code: string;
        item_name_ar: string;
        unit_name_ar: string;
        quantity: number;
        wac_unit_cost: number;
        total_valuation: number;
      }>;
    }
  >;
};

export type WipValuationReport = {
  totals: {
    total_wip_balance: number;
    total_materials_cost: number;
    total_labor_cost: number;
    total_overhead_cost: number;
    active_orders_count: number;
  };
  orders: Array<{
    order_id: string;
    order_number: string;
    product_name: string;
    season: string | null;
    target_quantity: number;
    status: string;
    material_cost: number;
    total_actual_cost: number;
    wip_balance: number;
    unit_manufacturing_cost: number;
  }>;
};

export type CogsReport = {
  period_days: number;
  total_cogs: number;
  items_count: number;
  entries: Array<{
    delivery_number: string;
    delivered_at: string;
    item_code: string;
    item_name_ar: string;
    quantity: number;
    unit_cost: number;
    total_cogs: number;
  }>;
};

export type ProfitAndLossReport = {
  period_days?: number | null;
  period?: { date_from: string; date_to: string } | null;
  revenues: {
    items: Array<{ code: string; name_ar: string; debit: number; credit: number; net_amount: number }>;
    total_revenue: number;
  };
  cost_of_goods_sold: {
    items: Array<{ code: string; name_ar: string; debit: number; credit: number; net_amount: number }>;
    total_cogs: number;
  };
  gross_profit: number;
  gross_profit_margin_pct: number;
  operating_expenses: {
    items: Array<{ code: string; name_ar: string; debit: number; credit: number; net_amount: number }>;
    total_expenses: number;
  };
  net_income: number;
  net_profit_margin_pct: number;
};

export type ProfitAndLossDrilldownReport = {
  account: {
    id: string;
    code: string;
    name_ar: string;
    account_type: string;
    nature: string;
  };
  period?: { date_from: string; date_to: string } | null;
  summary: {
    total_debit: number;
    total_credit: number;
    net_amount: number;
    lines_count: number;
  };
  lines: Array<{
    line_id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    source_doc_type?: string | null;
    source_doc_id?: string | null;
    debit: number;
    credit: number;
    net_effect: number;
  }>;
};

export type BalanceSheetReport = {
  assets: {
    current_assets: Array<{ code: string; name_ar: string; amount: number }>;
    total_assets: number;
  };
  liabilities: {
    current_liabilities: Array<{ code: string; name_ar: string; amount: number }>;
    total_liabilities: number;
  };
  equity: {
    equity_items: Array<{ code: string; name_ar: string; amount: number }>;
    total_equity: number;
  };
  total_liabilities_and_equity: number;
  difference: number;
  is_balanced: boolean;
  opening_balance: {
    is_set: boolean;
    accounting_start_date?: string | null;
    journal_entry_number?: string | null;
  };
};

export type OpeningBalancesPayload = {
  accounting_start_date: string;
  treasury_balance?: number | string;
  bank_balance?: number | string;
  bank_account_id?: string;
  custody_balance?: number | string;
  accounts_receivable?: number | string;
  raw_materials_inventory?: number | string;
  wip_inventory?: number | string;
  finished_goods_inventory?: number | string;
  accounts_payable?: number | string;
  paid_in_capital?: number | string;
  notes?: string;
};

export type AccountingLockRead = {
  id: string;
  lock_type: string;
  is_locked: boolean;
  action: string;
  reason: string | null;
  performed_by: string;
  performed_at: string;
  requested_by?: string | null;
  unlock_request_id?: string | null;
};

export type AccountingLockStatusRead = {
  is_locked: boolean;
  lock_type: string;
  current_action?: string | null;
  latest_reason?: string | null;
  latest_performed_by?: string | null;
  latest_performed_at?: string | null;
  history: AccountingLockRead[];
};

export type PurchasedItemRow = {
  line_id: string;
  invoice_line_id?: string;
  invoice_id: string;
  invoice_number: string;
  internal_number: string;
  invoice_date: string;
  invoice_status: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  item_type: string;
  category_id?: string | null;
  category_name_ar?: string | null;
  category_name?: string | null;
  unit_id: string;
  unit_name_ar: string;
  invoiced_quantity: number;
  received_quantity: number;
  remaining_quantity: number;
  unit_price?: number | null;
  discount_amount?: number | null;
  net_unit_cost?: number | null;
  line_total?: number | null;
  notes?: string;
};

export type PurchasedItemsResponse = {
  summary: {
    lines_count: number;
    distinct_items_count: number;
    total_invoiced_quantity: number;
    total_received_quantity: number;
    total_amount?: number | null;
    prices_visible: boolean;
  };
  items: PurchasedItemRow[];
};

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const financeApi = {
  getAccounts: () => apiClient.request<CashAccount[]>('/api/v1/finance/accounts'),
  getCashDocuments: (params?: {
    status?: string;
    approvable_by_me?: boolean;
    auto_posted_only?: boolean;
    prepayment_only?: boolean;
  }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.approvable_by_me) query.set('approvable_by_me', 'true');
    if (params?.auto_posted_only) query.set('auto_posted_only', 'true');
    if (params?.prepayment_only) query.set('prepayment_only', 'true');
    const qs = query.toString();
    return apiClient.request<CashDocument[]>(`/api/v1/finance/cash-documents${qs ? `?${qs}` : ''}`);
  },
  /** مستند نقدي يدوي (قبض/صرف/تحويل) — يُنشأ معلقاً ويُعتمد من شاشة الخزينة فقط */
  createCashDocument: (payload: {
    document_type: 'income' | 'expense' | 'transfer';
    from_account_id: string | null;
    to_account_id: string | null;
    amount: string;
    description: string;
    occurred_at: string;
    supplier_id?: string | null;
    customer_id?: string | null;
    expense_category?: string | null;
  }) => apiClient.request<CashDocument>('/api/v1/finance/cash-documents', jsonPost(payload)),
  /** مصروف يومي من صندوق عهدة — يُنشأ معلقاً بانتظار اعتماد الخزينة */
  createDailyExpense: (payload: {
    from_account_id: string;
    amount: string;
    description: string;
    occurred_at: string;
  }) =>
    apiClient.request<CashDocument>(
      '/api/v1/finance/daily-expenses',
      jsonPost({ ...payload, document_type: 'expense', to_account_id: null })
    ),
  getDailyExpenses: (accountId?: string) =>
    apiClient.request<CashDocument[]>(
      `/api/v1/finance/daily-expenses${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''}`
    ),
  createPettyCash: (name: string, businessDate?: string) => {
    const query = new URLSearchParams({
      name,
      business_date: businessDate || new Date().toISOString(),
    });
    return apiClient.request<CashAccount>(`/api/v1/finance/petty-cash?${query}`, { method: 'POST' });
  },
  /** تسوية نهائية برد كامل الرصيد (بانتظار اعتماد الخزينة) */
  settlePettyCash: (accountId: string, description?: string) => {
    const descParam = encodeURIComponent(description || 'تسوية وإغلاق صندوق العهدة');
    return apiClient.request<CustodySettlementRead>(
      `/api/v1/finance/petty-cash/${encodeURIComponent(accountId)}/settle?description=${descParam}`,
      { method: 'POST' }
    );
  },
  previewCustodySettlement: (accountId: string) =>
    apiClient.request<CustodySettlementPreview>(
      `/api/v1/finance/petty-cash/${encodeURIComponent(accountId)}/settlement-preview`
    ),
  /** رفع تسوية عهدة: المستخدم يحدد النقدية المردودة الآن فقط؛ الخادم يحسب المصروفات والمتبقي */
  createCustodySettlement: (accountId: string, payload: { returned_cash_amount: string; notes: string }) =>
    apiClient.request<CustodySettlementRead>(
      `/api/v1/finance/petty-cash/${encodeURIComponent(accountId)}/settlement`,
      jsonPost(payload)
    ),
  getCustodySettlements: () =>
    apiClient.request<CustodySettlementRead[]>('/api/v1/finance/petty-cash/settlements'),
  /** اعتماد/رفض مستند نقدي — مكانه شاشة الخزينة فقط */
  decideDocument: (id: string, decision: 'approve' | 'reject', rejection_reason?: string) =>
    apiClient.request<CashDocument>(
      `/api/v1/finance/cash-documents/${encodeURIComponent(id)}/decision`,
      jsonPost({ decision, rejection_reason })
    ),
  getSuppliers: () => apiClient.request<Supplier[]>('/api/v1/finance/suppliers'),
  createSupplier: (payload: { code: string; name: string; phone: string; address: string }) =>
    apiClient.request<Supplier>('/api/v1/finance/suppliers', jsonPost(payload)),
  updateSupplier: (supplierId: string, payload: { name?: string; phone?: string; address?: string; is_active?: boolean }) =>
    apiClient.request<Supplier>(`/api/v1/finance/suppliers/${encodeURIComponent(supplierId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  getSupplierInvoices: () => apiClient.request<SupplierInvoice[]>('/api/v1/finance/supplier-invoices'),
  createSupplierInvoice: (payload: SupplierInvoiceCreatePayload) =>
    apiClient.request<SupplierInvoice>('/api/v1/finance/supplier-invoices', jsonPost(payload)),
  receiveSupplierInvoice: (invoiceId: string, payload: SupplierReceiptPayload) =>
    apiClient.request<SupplierInvoice>(
      `/api/v1/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/receive`,
      jsonPost(payload)
    ),
  /** طلب سداد لمورد — مستند صرف معلق بانتظار اعتماد الخزينة */
  requestSupplierPayment: (invoiceId: string, payload: { amount: string; description: string }) =>
    apiClient.request<CashDocument>(
      `/api/v1/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/payments`,
      jsonPost(payload)
    ),
  /** الدفعات والمقبوضات المعلقة غير المخصصة لمورد */
  getSupplierUnallocatedPayments: (supplierId: string) =>
    apiClient.request<UnallocatedPayment[]>(
      `/api/v1/finance/suppliers/${encodeURIComponent(supplierId)}/unallocated-payments`
    ),
  /** تخصيص دفعة نقدية معلقة لسداد فاتورة مورد */
  allocateSupplierPayment: (invoiceId: string, payload: PaymentAllocationCreate) =>
    apiClient.request<PaymentAllocationRead>(
      `/api/v1/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/allocate-payment`,
      jsonPost(payload)
    ),
  /** المقبوضات المعلقة غير المخصصة لعميل */
  getCustomerUnallocatedPayments: (customerId: string) =>
    apiClient.request<UnallocatedPayment[]>(
      `/api/v1/customers/${encodeURIComponent(customerId)}/unallocated-payments`
    ),
  /** تخصيص دفعة نقدية معلقة لسداد طلب عميل */
  allocateCustomerPayment: (customerId: string, orderId: string, payload: PaymentAllocationCreate) =>
    apiClient.request<PaymentAllocationRead>(
      `/api/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/allocate-payment`,
      jsonPost(payload)
    ),
  getCashFlowReport: (sinceDays = 30) =>
    apiClient.request<CashFlowReport>(`/api/v1/reports/cash-flow?since_days=${sinceDays}`, REPORT_OPTIONS),
  getCustodyReconciliationReport: () =>
    apiClient.request<CustodyReconciliationReport>('/api/v1/reports/custody-reconciliation', REPORT_OPTIONS),
  getAccountsReceivableReport: () =>
    apiClient.request<AccountsReceivableReport>('/api/v1/reports/accounts-receivable', REPORT_OPTIONS),
  getAccountsPayableReport: () =>
    apiClient.request<AccountsPayableReport>('/api/v1/reports/accounts-payable', REPORT_OPTIONS),
  getCustomerStatement: (customerId: string) =>
    apiClient.request<CustomerStatementReport>(`/api/v1/reports/customer-statement/${encodeURIComponent(customerId)}`, REPORT_OPTIONS),
  getSupplierStatement: (supplierId: string) =>
    apiClient.request<SupplierStatementReport>(`/api/v1/reports/supplier-statement/${encodeURIComponent(supplierId)}`, REPORT_OPTIONS),
  getInventoryValuationReport: (warehouseCode?: string) =>
    apiClient.request<InventoryValuationReport>(
      `/api/v1/reports/inventory-valuation${warehouseCode ? `?warehouse_code=${encodeURIComponent(warehouseCode)}` : ''}`,
      REPORT_OPTIONS,
    ),
  getWipValuationReport: () => apiClient.request<WipValuationReport>('/api/v1/reports/wip-valuation', REPORT_OPTIONS),
  getCogsReport: (sinceDays = 30) =>
    apiClient.request<CogsReport>(`/api/v1/reports/cogs?since_days=${sinceDays}`, REPORT_OPTIONS),
  getExpenseAnalysisReport: (sinceDays = 30) =>
    apiClient.request<ExpenseAnalysisReport>(`/api/v1/reports/expense-analysis?since_days=${sinceDays}`, REPORT_OPTIONS),
  getProfitAndLossReport: (period?: { from?: string; to?: string }, sinceDays?: number) => {
    const params = new URLSearchParams();
    if (period?.from) params.set('date_from', period.from);
    if (period?.to) params.set('date_to', period.to);
    if (sinceDays) params.set('since_days', String(sinceDays));
    const qs = params.toString();
    return apiClient.request<ProfitAndLossReport>(`/api/v1/reports/profit-and-loss${qs ? `?${qs}` : ''}`, REPORT_OPTIONS);
  },
  getProfitAndLossDrilldown: (accountCode: string, period?: { from?: string; to?: string }) => {
    const params = new URLSearchParams({ account_code: accountCode });
    if (period?.from) params.set('date_from', period.from);
    if (period?.to) params.set('date_to', period.to);
    return apiClient.request<ProfitAndLossDrilldownReport>(`/api/v1/reports/profit-and-loss/drilldown?${params.toString()}`, REPORT_OPTIONS);
  },
  getBalanceSheet: () =>
    apiClient.request<BalanceSheetReport>('/api/v1/reports/balance-sheet', REPORT_OPTIONS),
  createOpeningBalances: (payload: OpeningBalancesPayload) =>
    apiClient.request<{
      is_set: boolean;
      accounting_start_date: string;
      total_assets: number;
      total_liabilities_and_equity: number;
      is_balanced: boolean;
      details: Record<string, unknown>;
      message: string;
    }>('/api/v1/finance/opening-balances', jsonPost(payload)),
  getCashAccountStatement: (accountId: string, period?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (period?.from) params.set('date_from', period.from);
    if (period?.to) params.set('date_to', period.to);
    const qs = params.toString();
    return apiClient.request<any>(`/api/v1/reports/cash-account-statement/${encodeURIComponent(accountId)}${qs ? `?${qs}` : ''}`, REPORT_OPTIONS);
  },
  getPurchasedItems: (params?: Record<string, unknown>) => {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
      });
    }
    const qs = query.toString();
    return apiClient.request<PurchasedItemsResponse>(`/api/v1/finance/purchased-items${qs ? `?${qs}` : ''}`);
  },
  createOpeningSupplierInvoice: (payload: {
    supplier_id: string;
    invoice_number: string;
    invoice_date: string;
    amount: number;
    is_advance?: boolean;
    notes?: string;
  }) => apiClient.request<any>('/api/v1/finance/supplier-invoices/opening', jsonPost(payload)),
  approveOpeningSupplierInvoice: (invoiceId: string) =>
    apiClient.request<any>(`/api/v1/finance/supplier-invoices/${encodeURIComponent(invoiceId)}/approve-opening`, jsonPost({})),
  getOpeningBalancesLockStatus: () =>
    apiClient.request<AccountingLockStatusRead>('/api/v1/finance/opening-balances/lock-status'),
  lockOpeningBalances: (payload?: { reason?: string }) =>
    apiClient.request<{ is_locked: boolean; message: string }>('/api/v1/finance/opening-balances/lock', jsonPost(payload || {})),
  requestUnlockOpeningBalances: (payload: { reason: string }) =>
    apiClient.request<{ status: string; request_id: string; message: string }>('/api/v1/finance/opening-balances/request-unlock', jsonPost(payload)),
  approveUnlockOpeningBalances: (payload?: { approval_notes?: string }) =>
    apiClient.request<{ is_locked: boolean; message: string }>('/api/v1/finance/opening-balances/approve-unlock', jsonPost(payload || {})),
};
