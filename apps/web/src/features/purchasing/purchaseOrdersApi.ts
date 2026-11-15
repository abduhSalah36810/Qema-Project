import { apiClient } from '@/lib/api';

export type PurchaseOrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export const PO_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'مسودة جديدة',
  pending_approval: 'بانتظار الاعتماد',
  approved: 'معتمد للتوريد',
  partially_received: 'مستلم جزئياً',
  received: 'مكتمل الاستلام',
  cancelled: 'ملغي',
};

export const PO_STATUS_COLORS: Record<PurchaseOrderStatus, { bg: string; text: string; border: string }> = {
  draft: { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' },
  pending_approval: { bg: '#fffbeb', text: '#b45309', border: '#fde68a' },
  approved: { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' },
  partially_received: { bg: '#fef3c7', text: '#d97706', border: '#fcd34d' },
  received: { bg: '#f0fdf4', text: '#15803d', border: '#bbf7d0' },
  cancelled: { bg: '#fef2f2', text: '#b91c1c', border: '#fecaca' },
};

export interface PurchaseOrderLine {
  id: string;
  purchase_order_id: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  ordered_quantity: number;
  received_quantity: number;
  remaining_quantity: number;
  unit_price: number | null;
  total_price: number | null;
  production_order_material_id: string | null;
  notes: string;
}

export interface PurchaseOrderReceiptItem {
  id: string;
  receipt_number: string;
  received_by: string;
  received_at: string;
  total_cost: number | null;
  notes: string;
}

export interface PurchaseOrder {
  id: string;
  order_number: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  production_order_id: string | null;
  production_order_number: string | null;
  status: PurchaseOrderStatus;
  status_label_ar: string;
  expected_delivery_date: string | null;
  total_amount: number | null;
  prices_visible: boolean;
  total_ordered_quantity: number;
  total_received_quantity: number;
  total_remaining_quantity: number;
  notes: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  lines: PurchaseOrderLine[];
  receipts: PurchaseOrderReceiptItem[];
}

export interface MaterialShortageItem {
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  is_cmt_customer_material: boolean;
  required_quantity: number;
  dispatched_quantity: number;
  net_required_quantity: number;
  available_stock: number;
  pending_inbound_quantity: number;
  shortage_quantity: number;
  proposed_purchase_quantity: number;
  has_shortage: boolean;
  suggested_supplier_id: string | null;
  suggested_unit_price: number;
  notes: string;
}

export interface ProductionOrderShortageReport {
  order_id: string;
  order_number: string;
  manufacturing_type: string;
  customer_id: string | null;
  customer_name: string | null;
  has_shortage: boolean;
  has_any_shortage: boolean;
  can_start_production: boolean;
  total_shortage_items_count: number;
  materials: MaterialShortageItem[];
  existing_purchase_orders: PurchaseOrder[];
}

export interface GeneratePurchaseOrdersLinePayload {
  item_id: string;
  unit_id: string;
  supplier_id: string;
  quantity: number;
  unit_price?: number;
  notes?: string;
}

export interface GeneratePurchaseOrdersPayload {
  lines: GeneratePurchaseOrdersLinePayload[];
  expected_delivery_date?: string;
  notes?: string;
}

export interface PurchaseOrderReceiptConfirmPayload {
  lines: Array<{
    line_id: string;
    received_quantity: number;
    notes?: string;
  }>;
  notes?: string;
}

export const purchaseOrdersApi = {
  /** استعراض قائمة أوامر الشراء */
  list: (params?: { supplier_id?: string; status?: string; search?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
    if (params?.status && params.status !== 'all') query.set('status', params.status);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return apiClient.request<PurchaseOrder[]>(`/api/v1/finance/purchase-orders${qs ? `?${qs}` : ''}`);
  },

  /** جلب تفاصيل أمر شراء بالمعرف */
  getById: (id: string) => {
    return apiClient.request<PurchaseOrder>(`/api/v1/finance/purchase-orders/${encodeURIComponent(id)}`);
  },

  /** اعتماد أمر الشراء ليصبح جاهزاً للتوريد */
  approve: (id: string) => {
    return apiClient.request<PurchaseOrder>(`/api/v1/finance/purchase-orders/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
    });
  },

  /** إلغاء أمر الشراء */
  cancel: (id: string, reason?: string) => {
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return apiClient.request<PurchaseOrder>(`/api/v1/finance/purchase-orders/${encodeURIComponent(id)}/cancel${qs}`, {
      method: 'POST',
    });
  },

  /** إثبات استلام بضاعة (GRN) بمخزن الخامات */
  receive: (id: string, payload: PurchaseOrderReceiptConfirmPayload, idempotencyKey?: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return apiClient.request<PurchaseOrder>(`/api/v1/finance/purchase-orders/${encodeURIComponent(id)}/receive`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  },

  /** تقرير عجز خامات أمر التشغيل الفعلي والمقارنة بالرصيد الحر */
  getOrderShortages: (orderId: string) => {
    return apiClient.request<ProductionOrderShortageReport>(
      `/api/v1/production/orders/${encodeURIComponent(orderId)}/material-shortages`
    );
  },

  /** توليد أوامر شراء مسودة من واقع عجز خامات أمر التشغيل */
  generateFromShortage: (orderId: string, payload: GeneratePurchaseOrdersPayload, idempotencyKey?: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return apiClient.request<PurchaseOrder[]>(
      `/api/v1/production/orders/${encodeURIComponent(orderId)}/generate-purchase-orders`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }
    );
  },
};
