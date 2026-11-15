import { apiClient } from '@/lib/api';

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  city: string | null;
  address: string | null;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface CustomerInput {
  code: string;
  name: string;
  phone: string;
  city: string;
  address: string;
}

export interface CustomerAccount {
  customer: Customer;
  orders: CustomerOrder[];
}

export interface CustomerOrderLine {
  id: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_info: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  delivered_quantity: number;
  production_orders: Array<{ id: string; order_number: string; status: string; target_quantity: number }>;
  notes: string;
}

export interface CustomerDelivery {
  id: string;
  delivery_number: string;
  delivered_at: string;
  received_by: string;
  notes: string;
  lines: Array<{ order_line_id: string; product_name: string; variant_info: string; quantity: number }>;
}

export interface CustomerPayment {
  id: string;
  receipt_number: string;
  amount: number;
  received_at: string;
  method: 'cash' | 'bank_transfer' | 'other';
  reference: string;
  notes: string;
  recorded_by: string;
  status?: 'pending' | 'approved' | 'rejected';
  cash_document_id?: string | null;
}

export interface CustomerOrder {
  id: string;
  order_number: string;
  order_type: 'ready_goods' | 'custom_manufacturing';
  status: 'open' | 'partially_delivered' | 'delivered' | 'cancelled';
  order_date: string;
  expected_delivery_at: string | null;
  discount_amount: number;
  payment_terms: string;
  notes: string;
  gross_amount: number;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  delivered_value?: number;
  returned_value?: number;
  receivable_amount?: number;
  pending_payments_amount?: number;
  /** مرتجعات الطلب (كميات وحالات) */
  returns?: CustomerReturn[];
  lines: CustomerOrderLine[];
  deliveries: CustomerDelivery[];
  payments: CustomerPayment[];
}

export interface OrderableProduct {
  id: string;
  code: string;
  name_ar: string;
  variants: Array<{ id: string; numeric_size: number | null; letter_size: string | null; season: string | null }>;
}

export interface CustomerProductionOrder {
  id: string;
  order_number: string;
  status: string;
  target_quantity: number;
  product_name: string;
  variant_info: string;
}

export interface CustomerTemplate {
  id: string;
  product_id: string;
  name_ar: string;
  versions: Array<{ id: string; status: string; version_number: number }>;
}

export async function fetchCustomers(search = ''): Promise<Customer[]> {
  const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  return apiClient.request<Customer[]>(`/api/v1/customers${query}`);
}

export async function fetchCustomerAccount(id: string): Promise<CustomerAccount> {
  return apiClient.request<CustomerAccount>(`/api/v1/customers/${encodeURIComponent(id)}/account`);
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  return apiClient.request<Customer>('/api/v1/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateCustomer(id: string, input: Partial<CustomerInput> & { status?: Customer['status'] }): Promise<Customer> {
  return apiClient.request<Customer>(`/api/v1/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function fetchOrderableProducts(): Promise<OrderableProduct[]> {
  return apiClient.request<OrderableProduct[]>('/api/v1/production/products');
}

export async function fetchCustomerTemplates(productId: string): Promise<CustomerTemplate[]> {
  return apiClient.request<CustomerTemplate[]>(`/api/v1/production/templates?product_id=${encodeURIComponent(productId)}`);
}

export async function createCustomerOrder(customerId: string, input: {
  order_type: CustomerOrder['order_type'];
  discount_amount: number;
  expected_delivery_at?: string;
  payment_terms: string;
  notes: string;
  lines: Array<{ product_id: string; variant_id: string; quantity: number; unit_price: number; notes: string }>;
}): Promise<CustomerOrder> {
  return apiClient.request<CustomerOrder>(`/api/v1/customers/${encodeURIComponent(customerId)}/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

export async function recordCustomerDelivery(customerId: string, orderId: string, input: {
  received_by: string; notes: string; lines: Array<{ order_line_id: string; quantity: number }>;
}): Promise<CustomerDelivery> {
  return apiClient.request<CustomerDelivery>(`/api/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/deliveries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

export async function recordCustomerPayment(customerId: string, orderId: string, input: {
  amount: number; method: CustomerPayment['method']; reference: string; notes: string;
}): Promise<CustomerPayment> {
  return apiClient.request<CustomerPayment>(`/api/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/payments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

export interface PendingDeliveryItem {
  customer_id: string;
  customer_name: string;
  customer_code: string;
  order_id: string;
  order_number: string;
  order_date: string;
  order_line_id: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_sku?: string;
  variant_info: string;
  requested_quantity: number;
  delivered_quantity: number;
  remaining_quantity: number;
  available_stock: number;
  status: string;
}

export async function fetchPendingDeliveries(): Promise<PendingDeliveryItem[]> {
  return apiClient.request<PendingDeliveryItem[]>('/api/v1/customers/pending-deliveries');
}

export async function createCustomerProductionOrder(customerId: string, orderId: string, input: {
  customer_order_line_id: string; template_version_id: string; target_quantity?: number;
}): Promise<CustomerProductionOrder> {
  return apiClient.request<CustomerProductionOrder>(`/api/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/production-orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// مرتجعات العملاء: تسجيل على سند تسليم ← تحت الفحص ← فحص مقسم (صالح للبيع / تالف)
// ═════════════════════════════════════════════════════════════════════════════

export type ReturnCondition = 'good' | 'damaged' | 'unknown';
export type ReturnDisposition = 'pending_inspection' | 'restocked' | 'scrapped' | 'partially_restocked';

export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = {
  good: 'سليم ظاهرياً',
  damaged: 'تالف ظاهرياً',
  unknown: 'غير محدد · يحتاج فحص',
};

export const RETURN_DISPOSITION_LABELS: Record<ReturnDisposition, string> = {
  pending_inspection: 'تحت الفحص',
  restocked: 'أُعيد للبيع بالكامل',
  scrapped: 'أُعدم بالكامل كتالف',
  partially_restocked: 'جزء للبيع وجزء تالف',
};

export interface CustomerReturnLine {
  id: string;
  delivery_line_id: string;
  order_line_id: string;
  product_name: string;
  variant_info: string;
  quantity: number;
  notes: string;
  condition: ReturnCondition;
  restocked_quantity: number;
  scrapped_quantity: number;
}

export interface CustomerReturn {
  id: string;
  return_number: string;
  delivery_id: string;
  order_id: string;
  customer_id: string;
  returned_at: string;
  reason: string;
  received_by: string;
  disposition: ReturnDisposition;
  created_by: string;
  inspected_by?: string | null;
  inspected_at?: string | null;
  inspection_notes: string;
  lines: CustomerReturnLine[];
  delivery_number?: string;
  order_number?: string;
  customer_name?: string;
  customer_code?: string;
}

export interface ReturnableDelivery {
  delivery_id: string;
  delivery_number: string;
  delivered_at: string;
  order_id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  lines: Array<{
    delivery_line_id: string;
    product_name: string;
    variant_info: string;
    delivered_quantity: number;
    returned_quantity: number;
    returnable_quantity: number;
  }>;
}

export function fetchCustomerReturns(params: { status?: 'pending' | 'inspected' | 'all'; orderId?: string } = {}): Promise<CustomerReturn[]> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.orderId) query.set('order_id', params.orderId);
  const qs = query.toString();
  return apiClient.request<CustomerReturn[]>(`/api/v1/customers/returns${qs ? `?${qs}` : ''}`);
}

export function fetchReturnableDeliveries(search = ''): Promise<ReturnableDelivery[]> {
  const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  return apiClient.request<ReturnableDelivery[]>(`/api/v1/customers/returnable-deliveries${qs}`);
}

export function recordCustomerReturn(
  customerId: string,
  orderId: string,
  deliveryId: string,
  input: {
    reason: string;
    received_by: string;
    idempotency_key?: string;
    lines: Array<{ delivery_line_id: string; quantity: number; condition: ReturnCondition; notes: string }>;
  },
): Promise<CustomerReturn> {
  return apiClient.request<CustomerReturn>(
    `/api/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/deliveries/${encodeURIComponent(deliveryId)}/return`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
  );
}

export function inspectCustomerReturn(
  customerId: string,
  returnId: string,
  input: { notes: string; lines: Array<{ return_line_id: string; restocked_quantity: number; scrapped_quantity: number }> },
): Promise<CustomerReturn> {
  return apiClient.request<CustomerReturn>(
    `/api/v1/customers/${encodeURIComponent(customerId)}/returns/${encodeURIComponent(returnId)}/inspection`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
  );
}

export interface SoldItemRow {
  delivery_line_id: string;
  delivery_id: string;
  delivery_number: string;
  delivered_at: string;
  order_id: string;
  order_number: string;
  order_type: string;
  order_status: string;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  product_id: string;
  product_code: string;
  product_name: string;
  variant_id: string;
  variant_info: string;
  ordered_quantity: number;
  delivered_quantity: number;
  returned_quantity: number;
  net_sold_quantity: number;
  unit_price: number;
  net_unit_price: number;
  delivered_value: number;
  returned_value: number;
  net_sold_value: number;
}

export interface SoldItemsResponse {
  summary: {
    lines_count: number;
    distinct_products_count: number;
    total_delivered_quantity: number;
    total_returned_quantity: number;
    total_net_sold_quantity: number;
    total_delivered_value: number;
    total_returned_value: number;
    total_net_sold_value: number;
  };
  items: SoldItemRow[];
}

export interface SoldItemsFilter {
  customer_id?: string;
  product_id?: string;
  order_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  limit?: number;
}

export function fetchSoldItems(filters: SoldItemsFilter = {}): Promise<SoldItemsResponse> {
  const params = new URLSearchParams();
  if (filters.customer_id) params.set('customer_id', filters.customer_id);
  if (filters.product_id) params.set('product_id', filters.product_id);
  if (filters.order_type) params.set('order_type', filters.order_type);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  if (filters.search) params.set('search', filters.search);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return apiClient.request<SoldItemsResponse>(`/api/v1/customers/sold-items${qs ? `?${qs}` : ''}`);
}


