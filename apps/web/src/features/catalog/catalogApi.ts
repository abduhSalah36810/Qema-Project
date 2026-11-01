/**
 * واجهة اتصال خدمات إدارة دليل الأصناف والتصنيفات (Catalog Management API Client)
 * ─────────────────────────────────────────────────────────────────────────────
 * توفر استدعاءات الـ APIs المعتمدة في Phase 3.2:
 * 1. استعراض شجرة وقائمة التصنيفات (Item Categories) وإدارتها.
 * 2. استعراض دليل الأصناف والمواد مع الفلترة والبحث والتفاصيل.
 * 3. استعراض خطوط الاستخدام (Application Lines) وإدارة وسوم الصنف.
 * 4. استعراض قائمة وحدات القياس المرجعية (Units Reference).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { apiClient } from '@/lib/api';

export type ClassificationStatus =
  | 'confirmed'
  | 'suggested'
  | 'needs_review'
  | 'not_applicable';

export type ApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';

export type RevisionStatus = 'pending_review' | 'applied' | 'rejected' | 'cancelled';

export interface CatalogItemRevision {
  id: string;
  item_id: string;
  revision_number: number;
  status: RevisionStatus;
  proposed_changes: Record<string, unknown>;
  change_summary: string;
  base_fingerprint: string | null;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface CatalogApprovalHistory {
  id: string;
  item_id: string;
  revision_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor_id: string;
  actor_role: string;
  reason: string | null;
  before_snapshot: Record<string, unknown>;
  after_snapshot: Record<string, unknown>;
  created_at: string;
}

export interface CatalogItemRevisionCreateInput {
  proposed_changes: Record<string, unknown>;
  change_summary: string;
}

export interface ItemCategory {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  parent_id: string | null;
  description: string;
  is_active: boolean;
  sort_order: number;
}

export interface ItemCategoryTree extends ItemCategory {
  subcategories: ItemCategoryTree[];
}

export interface ItemCategoryInput {
  code: string;
  name_ar: string;
  name_en?: string | null;
  parent_id?: string | null;
  description?: string;
  is_active?: boolean;
  sort_order?: number;
}

export interface ApplicationLine {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  description: string;
  is_active: boolean;
  sort_order: number;
}

export interface Unit {
  id: string;
  code: string;
  name_ar: string;
}

export interface CatalogItem {
  id: string;
  code: string;
  name_ar: string;
  item_type: string;
  unit_id: string;
  unit_name_ar?: string | null;
  is_consumable: boolean;
  is_active: boolean;
  category_id?: string | null;
  classification_status: ClassificationStatus;
  attributes: Record<string, unknown>;
  reorder_level: number;
  approval_status: ApprovalStatus;
  rejection_reason?: string | null;
  submitted_at?: string | null;
  submitted_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  has_pending_revision: boolean;
}

export interface CatalogItemDetail extends CatalogItem {
  category: ItemCategory | null;
  unit: Unit | null;
  usages: ApplicationLine[];
  pending_revision: CatalogItemRevision | null;
}

export interface CatalogItemCreateInput {
  code: string;
  name_ar: string;
  item_type: string;
  unit_id: string;
  category_id?: string | null;
  classification_status?: ClassificationStatus;
  attributes?: Record<string, unknown>;
  reorder_level?: number;
  is_consumable?: boolean;
  is_active?: boolean;
  application_line_ids?: string[];
}

export interface CatalogItemUpdateInput {
  name_ar?: string;
  item_type?: string;
  unit_id?: string;
  category_id?: string | null;
  classification_status?: ClassificationStatus;
  attributes?: Record<string, unknown>;
  reorder_level?: number;
  is_consumable?: boolean;
  is_active?: boolean;
}

export interface CatalogFilterParams {
  search?: string;
  item_type?: string;
  category_id?: string;
  unit_id?: string;
  classification_status?: string;
  approval_status?: string;
  is_active?: boolean;
  application_line_id?: string;
  limit?: number;
  offset?: number;
  sort_by?: 'code' | 'name_ar' | 'created_at' | 'reorder_level';
  sort_dir?: 'asc' | 'desc';
}

export async function fetchCategories(params?: {
  is_active?: boolean;
  parent_id?: string;
  search?: string;
}): Promise<ItemCategory[]> {
  const query = new URLSearchParams();
  if (params?.is_active !== undefined) query.set('is_active', String(params.is_active));
  if (params?.parent_id !== undefined) query.set('parent_id', params.parent_id);
  if (params?.search) query.set('search', params.search);
  const qs = query.toString() ? `?${query.toString()}` : '';
  return apiClient.request<ItemCategory[]>(`/api/v1/catalog/categories${qs}`);
}

export async function fetchCategoriesTree(is_active?: boolean): Promise<ItemCategoryTree[]> {
  const qs = is_active !== undefined ? `?is_active=${is_active}` : '';
  return apiClient.request<ItemCategoryTree[]>(`/api/v1/catalog/categories/tree${qs}`);
}

export async function getCategory(id: string): Promise<ItemCategory> {
  return apiClient.request<ItemCategory>(`/api/v1/catalog/categories/${encodeURIComponent(id)}`);
}

export async function createCategory(input: ItemCategoryInput): Promise<ItemCategory> {
  return apiClient.request<ItemCategory>('/api/v1/catalog/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateCategory(
  id: string,
  input: Partial<ItemCategoryInput>
): Promise<ItemCategory> {
  return apiClient.request<ItemCategory>(`/api/v1/catalog/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteCategory(id: string): Promise<void> {
  await apiClient.request<void>(`/api/v1/catalog/categories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchCatalogItems(params?: CatalogFilterParams): Promise<CatalogItem[]> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search.trim());
  if (params?.item_type && params.item_type !== 'all') query.set('item_type', params.item_type);
  if (params?.category_id && params.category_id !== 'all') query.set('category_id', params.category_id);
  if (params?.unit_id && params.unit_id !== 'all') query.set('unit_id', params.unit_id);
  if (params?.classification_status && params.classification_status !== 'all') {
    query.set('classification_status', params.classification_status);
  }
  if (params?.approval_status && params.approval_status !== 'all') {
    query.set('approval_status', params.approval_status);
  }
  if (params?.is_active !== undefined) query.set('is_active', String(params.is_active));
  if (params?.application_line_id && params.application_line_id !== 'all') {
    query.set('application_line_id', params.application_line_id);
  }
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset !== undefined) query.set('offset', String(params.offset));
  if (params?.sort_by) query.set('sort_by', params.sort_by);
  if (params?.sort_dir) query.set('sort_dir', params.sort_dir);

  const qs = query.toString() ? `?${query.toString()}` : '';
  return apiClient.request<CatalogItem[]>(`/api/v1/catalog/items${qs}`);
}

export async function getCatalogItem(id: string): Promise<CatalogItemDetail> {
  return apiClient.request<CatalogItemDetail>(`/api/v1/catalog/items/${encodeURIComponent(id)}`);
}

export async function createCatalogItem(input: CatalogItemCreateInput): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>('/api/v1/catalog/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateCatalogItem(
  id: string,
  input: CatalogItemUpdateInput
): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteCatalogItem(id: string): Promise<void> {
  await apiClient.request<void>(`/api/v1/catalog/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchApplicationLines(is_active?: boolean): Promise<ApplicationLine[]> {
  const qs = is_active !== undefined ? `?is_active=${is_active}` : '';
  return apiClient.request<ApplicationLine[]>(`/api/v1/catalog/application-lines${qs}`);
}

export async function fetchItemUsages(itemId: string): Promise<ApplicationLine[]> {
  const raw = await apiClient.request<Array<{
    item_id: string;
    application_id: string;
    application_code?: string;
    application_name_ar?: string;
  }>>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/usages`);

  return raw.map((u) => ({
    id: u.application_id,
    code: u.application_code ?? '',
    name_ar: u.application_name_ar ?? '',
    name_en: null,
    description: '',
    is_active: true,
    sort_order: 0,
  }));
}

export async function addItemUsage(itemId: string, applicationId: string): Promise<void> {
  await apiClient.request(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/usages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ application_id: applicationId }),
  });
}

export async function removeItemUsage(itemId: string, applicationId: string): Promise<void> {
  await apiClient.request(
    `/api/v1/catalog/items/${encodeURIComponent(itemId)}/usages/${encodeURIComponent(applicationId)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function fetchUnits(): Promise<Unit[]> {
  return apiClient.request<Unit[]>('/api/v1/catalog/units');
}

// ═════════════════════════════════════════════════════════════════════════════
// حوكمة دورة الاعتماد وإدارة المراجعات (Catalog Governance & Revisions API)
// ═════════════════════════════════════════════════════════════════════════════

export async function submitItemForReview(itemId: string): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/submit`, {
    method: 'POST',
  });
}

export async function approveCatalogItem(itemId: string): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/approve`, {
    method: 'POST',
  });
}

export async function rejectCatalogItem(itemId: string, rejectionReason: string): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rejection_reason: rejectionReason }),
  });
}

export async function reopenCatalogItem(itemId: string): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/reopen`, {
    method: 'POST',
  });
}

export async function deactivateCatalogItem(itemId: string): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/deactivate`, {
    method: 'POST',
  });
}

export async function reactivateCatalogItem(itemId: string): Promise<CatalogItem> {
  return apiClient.request<CatalogItem>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/reactivate`, {
    method: 'POST',
  });
}

export async function createItemRevision(
  itemId: string,
  input: CatalogItemRevisionCreateInput
): Promise<CatalogItemRevision> {
  return apiClient.request<CatalogItemRevision>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function approveItemRevision(itemId: string, revisionId: string): Promise<CatalogItemRevision> {
  return apiClient.request<CatalogItemRevision>(
    `/api/v1/catalog/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(revisionId)}/approve`,
    {
      method: 'POST',
    }
  );
}

export async function rejectItemRevision(
  itemId: string,
  revisionId: string,
  rejectionReason: string
): Promise<CatalogItemRevision> {
  return apiClient.request<CatalogItemRevision>(
    `/api/v1/catalog/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(revisionId)}/reject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejection_reason: rejectionReason }),
    }
  );
}

export async function cancelItemRevision(itemId: string, revisionId: string): Promise<CatalogItemRevision> {
  return apiClient.request<CatalogItemRevision>(
    `/api/v1/catalog/items/${encodeURIComponent(itemId)}/revisions/${encodeURIComponent(revisionId)}/cancel`,
    {
      method: 'POST',
    }
  );
}

export async function fetchItemRevisions(itemId: string): Promise<CatalogItemRevision[]> {
  return apiClient.request<CatalogItemRevision[]>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/revisions`);
}

export async function fetchItemHistory(itemId: string): Promise<CatalogApprovalHistory[]> {
  return apiClient.request<CatalogApprovalHistory[]>(`/api/v1/catalog/items/${encodeURIComponent(itemId)}/history`);
}

export async function fetchPendingReviews(): Promise<CatalogItem[]> {
  return apiClient.request<CatalogItem[]>('/api/v1/catalog/pending-reviews');
}

export async function fetchPendingRevisions(): Promise<CatalogItemRevision[]> {
  return apiClient.request<CatalogItemRevision[]>('/api/v1/catalog/pending-revisions');
}

