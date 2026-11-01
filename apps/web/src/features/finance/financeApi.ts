import { apiClient } from '@/lib/api';

export type CashAccount = {
  id: string;
  account_number: string;
  name: string;
  account_type: 'treasury' | 'petty_cash';
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
  created_by: string;
  approved_by: string | null;
  rejection_reason: string | null;
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
  invoice_total: string;
  paid_total: string;
  balance_due: string;
  status: string;
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
    unit_price: string;
    notes: string;
  }>;
};

export const financeApi = {
  getAccounts: () => apiClient.request<CashAccount[]>('/api/v1/finance/accounts'),
  getCashDocuments: () => apiClient.request<CashDocument[]>('/api/v1/finance/cash-documents'),
  createCashDocument: (payload: {
    document_type: 'income' | 'expense' | 'transfer';
    from_account_id: string | null;
    to_account_id: string | null;
    amount: string;
    description: string;
    occurred_at: string;
  }) =>
    apiClient.request('/api/v1/finance/cash-documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  createPettyCash: (name: string, businessDate?: string) => {
    const query = new URLSearchParams({
      name,
      business_date: businessDate || new Date().toISOString(),
    });
    return apiClient.request(`/api/v1/finance/petty-cash?${query}`, { method: 'POST' });
  },
  settlePettyCash: (accountId: string, description?: string) => {
    const descParam = encodeURIComponent(description || 'تسوية صندوق العهدة اليومية');
    return apiClient.request(`/api/v1/finance/petty-cash/${accountId}/settle?description=${descParam}`, {
      method: 'POST',
    });
  },
  decideDocument: (id: string, decision: 'approve' | 'reject', rejection_reason?: string) =>
    apiClient.request(`/api/v1/finance/cash-documents/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, rejection_reason }),
    }),
  getSuppliers: () => apiClient.request<Supplier[]>('/api/v1/finance/suppliers'),
  getSupplierInvoices: () => apiClient.request<SupplierInvoice[]>('/api/v1/finance/supplier-invoices'),
};

