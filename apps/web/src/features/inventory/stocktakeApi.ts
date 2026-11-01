/**
 * عميل الواجهة البرمجية لإدارة الجرد والتسويات المخزنية
 * Stocktake & Inventory Adjustments API Client
 */
import { apiClient } from '@/lib/api';

export interface StocktakeCountHistory {
  id: string;
  line_id: string;
  count_sequence: number;
  counted_quantity: number;
  counter_id: string;
  counter_role: string;
  counter_notes?: string | null;
  recorded_at: string;
}

export interface StocktakeLine {
  id: string;
  session_id: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  book_quantity: number;
  counted_quantity?: number | null;
  variance_quantity?: number | null;
  variance_type: 'pending' | 'exact' | 'shortage' | 'surplus';
  unit_cost: number;
  total_variance_cost: number;
  needs_recount: boolean;
  last_counted_by?: string | null;
  last_counted_at?: string | null;
  notes?: string | null;
  history?: StocktakeCountHistory[];
}

export interface StocktakeSession {
  id: string;
  session_number: string;
  warehouse_id: string;
  warehouse_name_ar: string;
  status: 'draft' | 'counting' | 'under_review' | 'recounting' | 'approved' | 'posted' | 'cancelled';
  scope_type: 'full_warehouse' | 'specific_items';
  description?: string | null;
  total_lines: number;
  counted_lines: number;
  shortage_lines: number;
  surplus_lines: number;
  exact_lines: number;
  net_variance_cost: number;
  created_by: string;
  reviewer_id?: string | null;
  review_decision?: string | null;
  review_notes?: string | null;
  posted_by?: string | null;
  cancelled_by?: string | null;
  cancellation_reason?: string | null;
  created_at: string;
  counting_started_at?: string | null;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  posted_at?: string | null;
  cancelled_at?: string | null;
  lines?: StocktakeLine[];
}

export interface StocktakeAuditLog {
  id: string;
  session_id: string;
  event_type: string;
  event_name_ar: string;
  actor_id: string;
  actor_role: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface StockLedgerEntry {
  id: string;
  item_id: string;
  item_code?: string;
  item_name_ar?: string;
  unit_id: string;
  unit_name_ar?: string;
  warehouse_id?: string | null;
  warehouse_name_ar?: string | null;
  location_type: string;
  bucket_reference?: string | null;
  quantity: number;
  reference_doc_type: string;
  reference_doc_id: string;
  entry_type: string;
  created_at: string;
  created_by: string;
}

export interface StocktakeCreateRequest {
  warehouse_id: string;
  scope_type?: 'full_warehouse' | 'specific_items';
  item_ids?: string[];
  description?: string;
}

export interface LineCountInput {
  line_id: string;
  counted_quantity: number;
  notes?: string;
}

export interface StocktakeCountRequest {
  counts: LineCountInput[];
}

export interface StocktakeSubmitRequest {
  notes?: string;
}

export interface StocktakeReviewRequest {
  decision: 'approve' | 'request_recount' | 'reject';
  notes?: string;
  recount_line_ids?: string[];
}

export interface StocktakePostRequest {
  notes?: string;
}

export interface StocktakePostResponse {
  session_id: string;
  session_number: string;
  status: string;
  adjustments_created: number;
  shortage_count: number;
  surplus_count: number;
  exact_count: number;
  ledger_entry_ids: string[];
  message: string;
}

export interface StocktakeCancelRequest {
  reason: string;
}

// ── API Functions ────────────────────────────────────────────────────────────

export async function fetchStocktakeSessions(params?: {
  warehouse_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<StocktakeSession[]> {
  const query = new URLSearchParams();
  if (params?.warehouse_id && params.warehouse_id !== 'all') {
    query.set('warehouse_id', params.warehouse_id);
  }
  if (params?.status && params.status !== 'all') {
    query.set('status', params.status);
  }
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));

  const qs = query.toString();
  return apiClient.request<StocktakeSession[]>(`/api/v1/inventory/stocktakes${qs ? `?${qs}` : ''}`);
}

export async function fetchStocktakeSession(stocktakeId: string): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(`/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}`);
}

export async function fetchStocktakeLines(stocktakeId: string): Promise<StocktakeLine[]> {
  return apiClient.request<StocktakeLine[]>(`/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/lines`);
}

export async function createStocktakeSession(data: StocktakeCreateRequest): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>('/api/v1/inventory/stocktakes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function startStocktakeCounting(stocktakeId: string): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/start-counting`,
    {
      method: 'POST',
    }
  );
}

export async function recordStocktakeCounts(
  stocktakeId: string,
  data: StocktakeCountRequest
): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/counts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  );
}

export async function submitStocktakeForReview(
  stocktakeId: string,
  notes?: string
): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/submit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notes || '' }),
    }
  );
}

export async function reviewStocktakeSession(
  stocktakeId: string,
  data: StocktakeReviewRequest
): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  );
}

export async function approveStocktakeSession(
  stocktakeId: string,
  notes?: string
): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', notes: notes || '' }),
    }
  );
}

export async function postStocktakeAdjustments(
  stocktakeId: string,
  data: StocktakePostRequest = {},
  idempotencyKey?: string
): Promise<StocktakePostResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  return apiClient.request<StocktakePostResponse>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/post`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    }
  );
}

export async function cancelStocktakeSession(
  stocktakeId: string,
  reason: string
): Promise<StocktakeSession> {
  return apiClient.request<StocktakeSession>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }
  );
}

export async function fetchStocktakeAudit(stocktakeId: string): Promise<StocktakeAuditLog[]> {
  return apiClient.request<StocktakeAuditLog[]>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/audit`
  );
}

export async function fetchStocktakeLedgerEntries(stocktakeId: string): Promise<StockLedgerEntry[]> {
  return apiClient.request<StockLedgerEntry[]>(
    `/api/v1/inventory/stocktakes/${encodeURIComponent(stocktakeId)}/ledger-entries`
  );
}

export const stocktakeApi = {
  fetchStocktakeSessions,
  fetchStocktakeSession,
  fetchStocktakeLines,
  createStocktakeSession,
  startStocktakeCounting,
  recordStocktakeCounts,
  submitStocktakeForReview,
  reviewStocktakeSession,
  approveStocktakeSession,
  postStocktakeAdjustments,
  cancelStocktakeSession,
  fetchStocktakeAudit,
  fetchStocktakeLedgerEntries,
};

