/**
 * واجهة استدعاء خدمات أوامر الإنتاج المؤقتة (Production API Client)
 * ─────────────────────────────────────────────────────────────────────────────
 * تدعم:
 * - استعراض الموديلات والمتغيرات (المقاسات الرقمية 56-64 والمواسم).
 * - استعراض وإنشاء قوالب الإنتاج مع الكميات المرجعية وبنود الخامات.
 * - إنشاء أوامر التشغيل وحساب لقطة الخامات التناسبية.
 * - صرف المواد وتأكيد استلامها بمخزن تحت التشغيل مع تسجيل الفروقات.
 * - التحديث التتابعي لمراحل القص والتشطيب والكبسولة والكي والتعبئة.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { apiClient } from '@/lib/api';

export interface ProductVariant {
  id: string;
  product_id: string;
  numeric_size?: number | null;
  letter_size?: string | null;
  season?: string | null;
  sku?: string | null;
  /** المقاس الموقوف لا يُختار في أوامر تشغيل جديدة */
  is_active?: boolean;
  /** هل للمقاس مستلزمات تصنيع معرّفة (الإصدار النشط) */
  has_bom?: boolean;
  bom_version_number?: number | null;
}

export interface Product {
  id: string;
  code: string;
  name_ar: string;
  style_type: string;
  description: string;
  /** الموديل الموقوف لا يظهر في أوامر التشغيل الجديدة */
  is_active?: boolean;
  variants: ProductVariant[];
}

export interface CatalogItem {
  id: string;
  code: string;
  name_ar: string;
  item_type: string;
  unit_id: string;
  unit_name_ar: string;
  is_consumable: boolean;
  is_active: boolean;
  approval_status?: string;
}

export interface Warehouse {
  id: string;
  code: string;
  name_ar: string;
  is_active: boolean;
}

export interface TemplateLine {
  id: string;
  item_id: string;
  item_name_ar: string;
  item_code: string;
  unit_id: string;
  unit_name_ar: string;
  quantity_per_reference: number;
  notes: string;
}

export interface TemplateVersion {
  id: string;
  version_number: number;
  status: string;
  reference_quantity: number;
  notes: string;
  lines: TemplateLine[];
}

export interface ProductionTemplate {
  id: string;
  code: string;
  name_ar: string;
  product_id: string;
  product_name_ar: string;
  is_active: boolean;
  versions: TemplateVersion[];
}

export interface OrderMaterialSnapshot {
  id: string;
  item_id: string;
  item_name_ar: string;
  item_code: string;
  unit_id: string;
  unit_name_ar: string;
  planned_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  discrepancy_quantity: number;
  status: string;
  notes: string;
}

export interface StageEvent {
  id: string;
  stage_name: string;
  status: string;
  actor_id: string;
  actor_name: string;
  timestamp: string;
  notes: string;
}

export interface StageHistoryEvent {
  id: string;
  stage_name: string;
  from_status: string;
  to_status: string;
  actor_id: string;
  actor_name: string;
  previous_notes: string;
  reason: string;
  timestamp: string;
}

export interface ProductionDefect {
  id: string;
  defect_number: string;
  order_id: string;
  stage_name: string;
  description: string;
  affected_quantity: number;
  responsible: string;
  repair_action: string;
  status: 'reported' | 'repair_in_progress' | 'repaired' | 'closed';
  repair_cost_description: string;
  reported_by: string;
  created_at: string;
  updated_at: string;
}

export async function fetchOrderDefects(orderId: string): Promise<ProductionDefect[]> {
  return apiClient.request<ProductionDefect[]>(`/api/v1/production/orders/${orderId}/defects`);
}

export async function reportOrderDefect(orderId: string, payload: Omit<ProductionDefect, 'id' | 'defect_number' | 'order_id' | 'status' | 'reported_by' | 'created_at' | 'updated_at'>): Promise<ProductionDefect> {
  return apiClient.request<ProductionDefect>(`/api/v1/production/orders/${orderId}/defects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

export async function updateOrderDefect(orderId: string, defectId: string, payload: { status: ProductionDefect['status']; repair_action?: string; repair_cost_description?: string }): Promise<ProductionDefect> {
  return apiClient.request<ProductionDefect>(`/api/v1/production/orders/${orderId}/defects/${defectId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

export interface ProductionOrderItem {
  id: string;
  product_id: string;
  product_name_ar: string;
  variant_id: string;
  variant_info: string;
  product_type: 'factory_brand' | 'private_label';
  customer_id?: string | null;
  customer_name?: string | null;
  target_quantity: number;
  season: string;
  fabric_area: string;
  fabric_name: string;
  fabric_color: string;
  fabric_weight: string;
  notes: string;
  /** الكمية السليمة المستلمة بمخزن التام لهذا البند حتى الآن */
  received_quantity?: number;
  /** الكمية المرفوضة بالفحص لهذا البند حتى الآن */
  rejected_quantity?: number;
  /** نسخة مستلزمات التصنيع المحفوظة في الأمر وقت إنشائه */
  bom_lines?: Array<{ item_id: string; item_name: string; unit_name: string; quantity_per_piece: number; total_quantity: number }>;
  /** رقم إصدار المستلزمات الذي بُني عليه السطر */
  bom_version_number?: number | null;
}

export interface ProductionOrder {
  id: string;
  order_number: string;
  product_id: string;
  product_name_ar: string;
  variant_id: string;
  variant_info: string;
  target_quantity: number;
  season: string;
  status: string;
  created_by: string;
  assigned_to: string;
  created_at: string;
  notes: string;
  /** من صرف تحويل الخامات المعلق؛ الخادم يرفض أن يؤكد استلامه بنفسه */
  pending_transfer_dispatched_by?: string | null;
  /** مرتجعات الورشة بانتظار استلام المخزن / بانتظار تسوية العجز أو المرفوض */
  returns_awaiting_receipt?: number;
  returns_awaiting_resolution?: number;
  returns_pending_declared_by?: string[];
  returns_pending_received_by?: string[];
  items?: ProductionOrderItem[];
  materials: OrderMaterialSnapshot[];
  stage_events: StageEvent[];
  stage_history?: StageHistoryEvent[];
}

export interface WarehouseTransferLine {
  id: string;
  item_id: string;
  item_name_ar: string;
  item_code: string;
  unit_id: string;
  unit_name_ar: string;
  dispatched_quantity: number;
  received_quantity: number;
  discrepancy_quantity: number;
  notes: string;
}

export interface WarehouseTransfer {
  id: string;
  transfer_number: string;
  order_id: string;
  source_warehouse_id: string;
  destination_warehouse_id: string;
  status: string;
  dispatched_at: string;
  dispatched_by: string;
  received_at?: string | null;
  received_by?: string | null;
  notes: string;
  lines: WarehouseTransferLine[];
}

export interface ProductionOrderItemPayload {
  product_id: string;
  variant_id: string;
  target_quantity: number;
  season: string;
  product_type: 'factory_brand' | 'private_label';
  customer_id?: string | null;
  template_version_id?: string | null;
  fabric_area?: string;
  fabric_name?: string;
  fabric_color?: string;
  fabric_weight?: string;
  notes?: string;
}

export interface OrderCreatePayload {
  items?: ProductionOrderItemPayload[];
  product_id?: string;
  variant_id?: string;
  target_quantity?: number;
  season?: string;
  template_version_id?: string;
  custom_materials?: Array<{
    item_id: string;
    unit_id: string;
    planned_quantity: number;
    notes?: string;
  }>;
  assigned_to?: string;
  notes?: string;
}

export interface ReceiptConfirmPayload {
  received_lines: Array<{
    item_id: string;
    received_quantity: number;
    notes?: string;
  }>;
  notes?: string;
}

// ─── بيانات احتياطية بصرية مؤقتة (Fallback / Mock Data) ──────────────────────
export const PROVISIONAL_FALLBACK_PRODUCTS: Product[] = [
  {
    id: 'prod-01',
    code: 'STYLE-HC-CUFF',
    name_ar: 'نصف ياقة مع أساور',
    style_type: 'half_collar_cuffs',
    description: 'جلابية رجالي بنصف ياقة وأساور قميص كلاسيكية',
    variants: [
      { id: 'v-56-s', product_id: 'prod-01', numeric_size: 56, letter_size: 'L', season: 'summer', sku: 'GLB-HC-56-SUM' },
      { id: 'v-58-s', product_id: 'prod-01', numeric_size: 58, letter_size: 'XL', season: 'summer', sku: 'GLB-HC-58-SUM' },
      { id: 'v-60-w', product_id: 'prod-01', numeric_size: 60, letter_size: '2XL', season: 'winter', sku: 'GLB-HC-60-WIN' },
    ],
  },
  {
    id: 'prod-02',
    code: 'STYLE-HC-BALTO',
    name_ar: 'نصف ياقة بالطو',
    style_type: 'half_collar_balto',
    description: 'جلابية بنصف ياقة وتصميم بالطو عصري مفتوح من الصدر',
    variants: [
      { id: 'v-58-a', product_id: 'prod-02', numeric_size: 58, letter_size: 'XL', season: 'autumn', sku: 'GLB-HB-58-AUT' },
      { id: 'v-62-w', product_id: 'prod-02', numeric_size: 62, letter_size: '2XL', season: 'winter', sku: 'GLB-HB-62-WIN' },
    ],
  },
  {
    id: 'prod-03',
    code: 'STYLE-FC-CUFF',
    name_ar: 'ياقة كاملة مع أساور',
    style_type: 'full_collar_cuffs',
    description: 'جلابية بياقة قميص كاملة وأزرار أساور فاخرة',
    variants: [
      { id: 'v-56-fc', product_id: 'prod-03', numeric_size: 56, letter_size: 'M', season: 'summer', sku: 'GLB-FC-56-SUM' },
      { id: 'v-60-fc', product_id: 'prod-03', numeric_size: 60, letter_size: 'XL', season: 'winter', sku: 'GLB-FC-60-WIN' },
    ],
  },
  {
    id: 'prod-04',
    code: 'STYLE-FC-BALTO',
    name_ar: 'ياقة كاملة بالطو',
    style_type: 'full_collar_balto',
    description: 'موديل فاخر يجمع بين الياقة الكاملة وقصة البالطو',
    variants: [
      { id: 'v-58-fb', product_id: 'prod-04', numeric_size: 58, letter_size: 'L', season: 'autumn', sku: 'GLB-FB-58-AUT' },
    ],
  },
  {
    id: 'prod-05',
    code: 'STYLE-SHORT-SLV',
    name_ar: 'جلابية نص كم',
    style_type: 'short_sleeved_galabeya',
    description: 'جلابية صيفية خفيفة بدون ياقة وأكمام قصيرة',
    variants: [
      { id: 'v-56-ss', product_id: 'prod-05', numeric_size: 56, letter_size: 'M', season: 'summer', sku: 'GLB-SS-56-SUM' },
      { id: 'v-64-ss', product_id: 'prod-05', numeric_size: 64, letter_size: '2XL', season: 'summer', sku: 'GLB-SS-64-SUM' },
    ],
  },
  {
    id: 'prod-06',
    code: 'STYLE-SHARWAL',
    name_ar: 'شروال كاجوال',
    style_type: 'sharwal',
    description: 'بنطلون شروال تقليدي قطني مريح',
    variants: [
      { id: 'v-58-sh', product_id: 'prod-06', numeric_size: 58, letter_size: 'L', season: 'summer', sku: 'SHR-58-SUM' },
      { id: 'v-62-sh', product_id: 'prod-06', numeric_size: 62, letter_size: 'XL', season: 'autumn', sku: 'SHR-62-AUT' },
    ],
  },
];

export const PROVISIONAL_FALLBACK_ORDERS: ProductionOrder[] = [
  {
    id: 'ord-demo-01',
    order_number: 'PO-2026-0001',
    product_id: 'prod-01',
    product_name_ar: 'نصف ياقة مع أساور',
    variant_id: 'v-58-s',
    variant_info: 'مقاس رقمي: 58 · حرفي: XL · موسم: summer',
    target_quantity: 150,
    season: 'summer',
    status: 'in_production',
    created_by: 'admin-1',
    assigned_to: 'خط التشغيل الرئيسي ١',
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    notes: 'دفعة صيفية عاجلة لعرض الموسم',
    materials: [
      {
        id: 'mat-1',
        item_id: 'it-fab',
        item_name_ar: 'قماش قطن مصري فاخر',
        item_code: 'FAB-COTTON-01',
        unit_id: 'u-m',
        unit_name_ar: 'متر',
        planned_quantity: 450,
        dispatched_quantity: 450,
        received_quantity: 445,
        discrepancy_quantity: -5,
        status: 'received_with_discrepancy',
        notes: 'عجز ٥ أمتار في نهاية الطوبة',
      },
      {
        id: 'mat-2',
        item_id: 'it-btn',
        item_name_ar: 'أزرار صدفية طبيعية',
        item_code: 'BTN-PEARL-18',
        unit_id: 'u-pcs',
        unit_name_ar: 'قطعة',
        planned_quantity: 1200,
        dispatched_quantity: 1200,
        received_quantity: 1200,
        discrepancy_quantity: 0,
        status: 'received_complete',
        notes: '',
      },
    ],
    stage_events: [
      { id: 's1', stage_name: 'cutting', status: 'completed', actor_id: 'u1', actor_name: 'محمد رضوان', timestamp: new Date(Date.now() - 3600000 * 18).toISOString(), notes: 'تم القص والفرز بدقة' },
      { id: 's2', stage_name: 'finishing', status: 'in_progress', actor_id: 'u1', actor_name: 'سعيد عبد الله', timestamp: new Date(Date.now() - 3600000 * 4).toISOString(), notes: 'جاري تشطيب الأساور والرقبة' },
      { id: 's3', stage_name: 'snap_installation', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: 'بانتظار اكتمال التشطيب' },
      { id: 's4', stage_name: 'ironing', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: 'بانتظار اكتمال الكبسولة' },
      { id: 's5', stage_name: 'packing', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: 'بانتظار اكتمال الكي' },
    ],
  },
  {
    id: 'ord-demo-02',
    order_number: 'PO-2026-0002',
    product_id: 'prod-02',
    product_name_ar: 'نصف ياقة بالطو',
    variant_id: 'v-62-w',
    variant_info: 'مقاس رقمي: 62 · حرفي: 2XL · موسم: winter',
    target_quantity: 80,
    season: 'winter',
    status: 'draft',
    created_by: 'admin-1',
    assigned_to: 'خط التشغيل ٢',
    created_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    notes: 'قيد الصرف المخزني من مخزن الخامات الرئيسي',
    materials: [
      {
        id: 'mat-21',
        item_id: 'it-fab-w',
        item_name_ar: 'قماش صوف شتوي مخلوط',
        item_code: 'FAB-WOOL-02',
        unit_id: 'u-m',
        unit_name_ar: 'متر',
        planned_quantity: 280,
        dispatched_quantity: 0,
        received_quantity: 0,
        discrepancy_quantity: 0,
        status: 'pending',
        notes: '',
      },
    ],
    stage_events: [
      { id: 's21', stage_name: 'cutting', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: 'بانتظار صرف الخامات' },
      { id: 's22', stage_name: 'finishing', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: '' },
      { id: 's23', stage_name: 'snap_installation', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: '' },
      { id: 's24', stage_name: 'ironing', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: '' },
      { id: 's25', stage_name: 'packing', status: 'not_started', actor_id: 'sys', actor_name: 'النظام', timestamp: new Date().toISOString(), notes: '' },
    ],
  },
];

// ─── استدعاءات الـ API مع الحفاظ على العمل الاحتياطي التفاعلي ─────────────────

// لا بيانات بديلة عند الفشل: عرض موديلات أو أوامر وهمية قد يقود الموظف لتسجيل عمليات على بيانات غير موجودة
export async function fetchProducts(): Promise<Product[]> {
  return apiClient.request<Product[]>('/api/v1/production/products');
}

export async function createProductApi(payload: {
  code: string;
  name_ar: string;
  style_type?: string;
  description?: string;
  variants: Array<{ numeric_size: number; letter_size?: string; season: string }>;
}): Promise<Product> {
  return apiClient.request<Product>('/api/v1/production/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function updateProductApi(productId: string, payload: { name_ar?: string; description?: string; is_active?: boolean }): Promise<Product> {
  return apiClient.request<Product>(`/api/v1/production/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** إيقاف مقاس أو إعادة تفعيله، أو تعديل مقاسه الحرفي */
export async function updateProductVariantApi(variantId: string, payload: { is_active?: boolean; letter_size?: string }): Promise<Product> {
  return apiClient.request<Product>(`/api/v1/production/variants/${encodeURIComponent(variantId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function addProductVariantsApi(
  productId: string,
  variants: Array<{ numeric_size: number; letter_size?: string; season: string }>
): Promise<Product> {
  return apiClient.request<Product>(`/api/v1/production/products/${encodeURIComponent(productId)}/variants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(variants),
  });
}

export async function fetchTemplates(productId?: string): Promise<ProductionTemplate[]> {
  const query = productId ? `?product_id=${encodeURIComponent(productId)}` : '';
  return apiClient.request<ProductionTemplate[]>(`/api/v1/production/templates${query}`);
}

export async function fetchCatalogItems(): Promise<CatalogItem[]> {
  return apiClient.request<CatalogItem[]>('/api/v1/production/catalog-items');
}

export async function fetchWarehouses(): Promise<Warehouse[]> {
  return apiClient.request<Warehouse[]>('/api/v1/production/warehouses');
}

export async function fetchOrders(status?: string): Promise<ProductionOrder[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiClient.request<ProductionOrder[]>(`/api/v1/production/orders${query}`);
}

export async function fetchProductionOrderById(orderId: string): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>(`/api/v1/production/orders/${orderId}`);
}

export async function createProductionOrderApi(payload: OrderCreatePayload): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>('/api/v1/production/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function addOrderMaterialApi(orderId: string, payload: { item_id: string; unit_id: string; planned_quantity: number; notes?: string }): Promise<OrderMaterialSnapshot> {
  return apiClient.request<OrderMaterialSnapshot>(`/api/v1/production/orders/${orderId}/materials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function removeOrderMaterialApi(orderId: string, materialId: string): Promise<void> {
  await apiClient.request<void>(`/api/v1/production/orders/${orderId}/materials/${materialId}`, {
    method: 'DELETE',
  });
}

export async function dispatchMaterialsApi(orderId: string, notes: string = ''): Promise<WarehouseTransfer> {
  return apiClient.request<WarehouseTransfer>(`/api/v1/production/orders/${orderId}/dispatch?notes=${encodeURIComponent(notes)}`, {
    method: 'POST',
  });
}

function jsonHeaders(idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}

/** مفتاح منع التكرار يُولَّد مرة واحدة لكل نموذج مفتوح. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function receiveMaterialsApi(
  orderId: string,
  payload: ReceiptConfirmPayload,
  idempotencyKey?: string,
): Promise<WarehouseTransfer> {
  return apiClient.request<WarehouseTransfer>(`/api/v1/production/orders/${orderId}/receive`, {
    method: 'POST',
    headers: jsonHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
}

export async function updateStageApi(orderId: string, stageName: string, status: string, notes: string = ''): Promise<StageEvent> {
  return apiClient.request<StageEvent>(`/api/v1/production/orders/${orderId}/stages/${stageName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, notes }),
  });
}

export async function rollbackStageApi(orderId: string, stageName: string, reason: string): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>(`/api/v1/production/orders/${orderId}/stages/${stageName}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export interface FinishedGoodsReceiptLinePayload {
  order_item_id: string;
  accepted_quantity: number;
  rejected_quantity: number;
}

/**
 * استلام المنتج التام لكل بند في أمر التشغيل.
 * الشكل المختصر (accepted_quantity/rejected_quantity) مقبول خادمياً للأوامر ذات البند الواحد فقط.
 */
export interface FinishedGoodsReceiptPayload {
  lines?: FinishedGoodsReceiptLinePayload[];
  accepted_quantity?: number;
  rejected_quantity?: number;
  notes?: string;
}

export interface FinishedGoodsReceiptLineRead {
  order_item_id: string;
  variant_id: string;
  variant_label: string;
  bucket_reference: string;
  target_quantity: number;
  accepted_quantity: number;
  rejected_quantity: number;
  total_received: number;
  remaining_quantity: number;
}

export interface FinishedGoodsReceipt {
  order_id: string;
  order_number: string;
  target_quantity: number;
  received_quantity: number;
  accepted_quantity: number;
  rejected_quantity: number;
  warehouse_name: string;
  receipt_status: string;
  confirmed_at: string;
  confirmed_by: string;
  notes: string;
  lines?: FinishedGoodsReceiptLineRead[];
}

export async function receiveFinishedGoodsApi(
  orderId: string,
  payload: FinishedGoodsReceiptPayload,
  idempotencyKey?: string,
): Promise<FinishedGoodsReceipt> {
  return apiClient.request<FinishedGoodsReceipt>(`/api/v1/production/orders/${orderId}/finished-receipt`, {
    method: 'POST',
    headers: jsonHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
}

// ─── تسوية خامات الورشة وإغلاق أمر التشغيل ─────────────────────────────────

export interface OrderMaterialWipItem {
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  planned_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  discrepancy_quantity: number;
  in_transit_quantity: number;
  current_wip_balance: number;
  status: string;
}

export interface OrderWipSummary {
  order_id: string;
  order_number: string;
  status: string;
  target_quantity: number;
  total_received_goods: number;
  goods_receipt_status: string;
  stages_completed: boolean;
  pending_transfers_count: number;
  unresolved_discrepancies_count: number;
  net_wip_balance: number;
  can_close: boolean;
  blocking_reasons: string[];
  returns_pending_resolution_count?: number;
  materials: OrderMaterialWipItem[];
}

export async function fetchOrderWipSummary(orderId: string): Promise<OrderWipSummary> {
  return apiClient.request<OrderWipSummary>(`/api/v1/production/orders/${orderId}/wip-summary`);
}

export interface MaterialReconciliationLinePayload {
  item_id: string;
  consumed_quantity: number;
  returned_quantity: number;
  scrapped_quantity: number;
  return_condition?: ReturnCondition;
  notes?: string;
}

export type ReturnCondition = 'good' | 'needs_inspection' | 'damaged';

export interface MaterialReconciliationPayload {
  lines: MaterialReconciliationLinePayload[];
  notes?: string;
}

export interface MaterialReconciliationRead {
  id: string;
  reconciliation_number: string;
  order_id: string;
  created_by: string;
  created_at: string;
  notes: string;
  lines: Array<{
    item_id: string;
    item_name_ar: string;
    unit_name_ar: string;
    consumed_quantity: number;
    returned_quantity: number;
    scrapped_quantity: number;
    remaining_wip_balance: number;
  }>;
  return_transfer_id?: string | null;
  return_transfer_number?: string | null;
}

export interface ReturnLine {
  line_id: string;
  item_id: string;
  item_name_ar: string;
  unit_name_ar: string;
  declared_quantity: number;
  accepted_quantity: number;
  rejected_quantity: number;
  rejected_open_quantity: number;
  rejected_restocked_quantity: number;
  rejected_scrapped_quantity: number;
  shortage_quantity: number;
  shortage_open_quantity: number;
  notes: string;
}

export interface ReturnTransfer {
  id: string;
  transfer_number: string;
  order_id: string;
  status: 'in_transit' | 'pending_resolution' | 'received_confirmed' | string;
  status_ar: string;
  declared_by: string;
  declared_at: string;
  received_by?: string | null;
  received_at?: string | null;
  awaiting_receipt: boolean;
  awaiting_resolution: boolean;
  notes: string;
  lines: ReturnLine[];
}

export interface ReturnReceiptPayload {
  lines: Array<{ item_id: string; accepted_quantity: number; rejected_quantity: number; notes: string }>;
  notes?: string;
}

export interface ReturnResolutionPayload {
  lines: Array<{
    item_id: string;
    kind: 'shortage' | 'rejected';
    disposition: 'write_off' | 'restock' | 'scrap';
    quantity: number;
    reason: string;
  }>;
}

export async function fetchOrderReturns(orderId: string): Promise<ReturnTransfer[]> {
  return apiClient.request<ReturnTransfer[]>(`/api/v1/production/orders/${orderId}/returns`);
}

export async function receiveOrderReturnApi(
  orderId: string, transferId: string, payload: ReturnReceiptPayload, idempotencyKey?: string,
): Promise<ReturnTransfer> {
  return apiClient.request<ReturnTransfer>(`/api/v1/production/orders/${orderId}/returns/${transferId}/receive`, {
    method: 'POST', headers: jsonHeaders(idempotencyKey), body: JSON.stringify(payload),
  });
}

export async function resolveOrderReturnApi(
  orderId: string, transferId: string, payload: ReturnResolutionPayload, idempotencyKey?: string,
): Promise<ReturnTransfer> {
  return apiClient.request<ReturnTransfer>(`/api/v1/production/orders/${orderId}/returns/${transferId}/resolve`, {
    method: 'POST', headers: jsonHeaders(idempotencyKey), body: JSON.stringify(payload),
  });
}

export async function reconcileOrderMaterialsApi(
  orderId: string,
  payload: MaterialReconciliationPayload,
  idempotencyKey?: string,
): Promise<MaterialReconciliationRead> {
  return apiClient.request<MaterialReconciliationRead>(`/api/v1/production/orders/${orderId}/material-reconciliations`, {
    method: 'POST',
    headers: jsonHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
}

export interface OrderClosePayload {
  discrepancy_signoff?: boolean;
  discrepancy_notes?: string;
  under_production_reason?: string | null;
  notes?: string;
}

export interface OrderCloseResponse {
  order_id: string;
  order_number: string;
  status: string;
  closed_at: string;
  closed_by: string;
  target_quantity: number;
  total_received_goods: number;
  remaining_wip_balance: number;
  discrepancy_count: number;
  wip_disposition: string | null;
  notes: string;
}

export async function closeProductionOrderApi(
  orderId: string,
  payload: OrderClosePayload,
  idempotencyKey?: string,
): Promise<OrderCloseResponse> {
  return apiClient.request<OrderCloseResponse>(`/api/v1/production/orders/${orderId}/close`, {
    method: 'POST',
    headers: jsonHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
}
