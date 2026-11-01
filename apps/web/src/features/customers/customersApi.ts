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

export async function createCustomerProductionOrder(customerId: string, orderId: string, input: {
  customer_order_line_id: string; template_version_id: string; target_quantity?: number;
}): Promise<CustomerProductionOrder> {
  return apiClient.request<CustomerProductionOrder>(`/api/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}/production-orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}
