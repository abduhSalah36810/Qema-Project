import { apiClient } from '@/lib/api';

export type StockBalance = {
  item_id: string; item_code: string; item_name_ar: string; unit_id: string; unit_name_ar: string;
  warehouse_id: string; warehouse_code: string; warehouse_name_ar: string; balance: number | null; is_established: boolean;
};

export type StockLedgerEntry = {
  id: string; item_id: string; item_code: string; item_name_ar: string; unit_id: string; unit_name_ar: string;
  warehouse_id: string | null; warehouse_name_ar: string | null; location_type: string; bucket_reference: string | null;
  quantity: number; reference_doc_type: string; reference_doc_id: string; transfer_line_id: string | null;
  entry_type: string; created_at: string; created_by: string;
};

export function fetchStockBalances(warehouseId?: string): Promise<StockBalance[]> {
  const query = warehouseId ? `?warehouse_id=${encodeURIComponent(warehouseId)}` : '';
  return apiClient.request<StockBalance[]>(`/api/v1/inventory/stock${query}`);
}

/** رصيد منتج تام لكل موديل/مقاس مقسماً حسب الملكية (نفس قواعد التسليم في الخادم). */
export type FinishedGoodsBalance = {
  item_id: string;
  item_code: string;
  item_name_ar?: string;
  product_id: string | null;
  product_name_ar: string;
  variant_id: string | null;
  numeric_size: number | null;
  letter_size: string | null;
  season: string | null;
  /** متاح للبيع العام (براند المصنع) */
  available_factory_brand: number;
  /** محجوز لعملاء التصنيع الخاص */
  private_label: Array<{ customer_id: string; customer_name: string; quantity: number }>;
  /** مرتجعات تحت الفحص (غير متاحة للبيع) */
  pending_inspection: number;
  /** أرصدة في سلال ملكية أخرى غير مصنفة */
  unassigned: number;
  total: number;
};

export function fetchFinishedGoodsBalances(): Promise<FinishedGoodsBalance[]> {
  return apiClient.request<FinishedGoodsBalance[]>('/api/v1/inventory/finished-goods-balances');
}

export function fetchStockLedger(itemId: string, warehouseId?: string): Promise<StockLedgerEntry[]> {
  const params = new URLSearchParams({ item_id: itemId });
  if (warehouseId) params.set('warehouse_id', warehouseId);
  return apiClient.request<StockLedgerEntry[]>(`/api/v1/inventory/ledger?${params}`);
}
