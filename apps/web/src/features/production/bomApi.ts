/**
 * مستلزمات التصنيع لكل مقاس (BOM) ومعاينة احتياجات أمر التشغيل.
 * الحسابات النهائية من الخادم؛ المعاينة لا تحجز ولا تصرف أي كمية.
 */
import { apiClient } from '@/lib/api';

export interface BomLine {
  item_id: string;
  item_code: string;
  item_name: string;
  unit_id: string;
  unit_name: string;
  quantity_per_piece: number;
  notes: string;
  item_usable: boolean;
}

export interface VariantBom {
  variant_id: string;
  sku: string;
  numeric_size: number;
  letter_size: string;
  season: string;
  label: string;
  is_active?: boolean;
  has_bom: boolean;
  version_id: string | null;
  version_number: number | null;
  updated_at: string | null;
  lines: BomLine[];
}

export interface ProductBoms {
  product_id: string;
  product_code: string;
  product_name: string;
  variants: VariantBom[];
}

export interface BomLineInput {
  item_id: string;
  quantity_per_piece: string;
  notes?: string;
}

export interface RequirementLineInput {
  product_id: string;
  variant_id: string;
  quantity: number;
}

export interface RequirementLine {
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_label: string;
  quantity: number;
  has_bom: boolean;
  bom_version_number: number | null;
  issue: string;
  materials: Array<{ item_id: string; item_name: string; unit_name: string; quantity_per_piece: number; total_quantity: number }>;
}

export interface RequirementMaterial {
  item_id: string;
  item_code: string;
  item_name: string;
  unit_id: string;
  unit_name: string;
  required_quantity: number;
  available_quantity: number;
  dispatchable_quantity: number;
  shortage_quantity: number;
  item_active: boolean;
}

export interface Requirements {
  lines: RequirementLine[];
  materials: RequirementMaterial[];
  can_create: boolean;
  has_shortage: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function fetchProductBoms(productId: string): Promise<ProductBoms> {
  return apiClient.request<ProductBoms>(`/api/v1/production/products/${encodeURIComponent(productId)}/boms`);
}

export function saveVariantBom(variantId: string, lines: BomLineInput[], notes = ''): Promise<VariantBom> {
  return apiClient.request<VariantBom>(`/api/v1/production/variants/${encodeURIComponent(variantId)}/bom`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ lines, notes }),
  });
}

export function previewOrderRequirements(lines: RequirementLineInput[]): Promise<Requirements> {
  return apiClient.request<Requirements>('/api/v1/production/orders/requirements', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ lines }),
  });
}
