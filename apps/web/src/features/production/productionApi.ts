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
  supplied_by?: 'customer' | 'factory';
  commercial_treatment?: 'included_in_service_fee' | 'billed_separately';
  actual_consumed_quantity?: number;
  actual_waste_quantity?: number;
  actual_returned_quantity?: number;
  unit_cost?: number;
  total_cost?: number;
}

export interface StageEvent {
  id: string;
  stage_name: string;
  status: string;
  actor_id: string;
  actor_name: string;
  timestamp: string;
  notes: string;
  started_at?: string | null;
  completed_at?: string | null;
  expected_duration_minutes?: number;
  elapsed_minutes?: number;
  working_minutes?: number;
  is_working_time_provisional?: boolean;
  is_skipped?: boolean;
  skip_reason?: string | null;
  delay_reason?: string | null;
  delay_notes?: string | null;
  is_bottleneck?: boolean;
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
  /** من صرف صرفاً إضافياً بالطريق؛ لا يؤكد استلامه بنفسه */
  extra_issue_pending_dispatched_by?: string | null;
  /** مرتجعات الورشة بانتظار استلام المخزن / بانتظار تسوية العجز أو المرفوض */
  returns_awaiting_receipt?: number;
  returns_awaiting_resolution?: number;
  returns_pending_declared_by?: string[];
  returns_pending_received_by?: string[];
  manufacturing_type?: 'internal' | 'external';
  customer_id?: string | null;
  customer_name?: string | null;
  labor_costing_method?: 'piece_based' | 'time_based';
  labor_rate?: number;
  labor_hours?: number;
  allowed_waste_pct?: number;
  actual_waste_pct?: number;
  excess_waste_qty?: number;
  excess_waste_cost?: number;
  overhead_allocation_basis?: 'produced_pieces' | 'labor_hours' | 'machine_hours' | null;
  allocated_overhead_rate?: number;
  planned_material_cost?: number;
  actual_material_cost?: number;
  actual_labor_cost?: number;
  actual_overhead_cost?: number;
  total_actual_cost?: number;
  unit_manufacturing_cost?: number;
  agreed_service_price?: number;
  excess_waste_settlement_status?: 'pending_review' | 'approved_by_factory' | 'claimed_from_customer' | 'waived';
  cost_calculated_at?: string | null;
  cost_calculated_by?: string | null;
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
  manufacturing_type?: 'internal' | 'external';
  customer_id?: string | null;
  labor_costing_method?: 'piece_based' | 'time_based';
  labor_rate?: number;
  labor_hours?: number;
  allowed_waste_pct?: number;
  overhead_allocation_basis?: 'produced_pieces' | 'labor_hours' | 'machine_hours' | null;
  allocated_overhead_rate?: number;
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

export async function updateStageApi(
  orderId: string,
  stageName: string,
  status: string,
  notes: string = '',
  delayReason?: string,
  delayNotes?: string
): Promise<StageEvent> {
  return apiClient.request<StageEvent>(`/api/v1/production/orders/${orderId}/stages/${stageName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status,
      notes,
      delay_reason: delayReason || undefined,
      delay_notes: delayNotes || undefined,
    }),
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

/** صرف خامات إضافي لأمر قائم (خامات ← تحت التشغيل). */
export interface ExtraIssuePayload {
  reason: string;
  lines: Array<{ item_id: string; quantity: number; notes?: string }>;
}

export async function fetchOrderExtraIssues(orderId: string): Promise<WarehouseTransfer[]> {
  return apiClient.request<WarehouseTransfer[]>(`/api/v1/production/orders/${orderId}/extra-issues`);
}

export async function createExtraIssueApi(orderId: string, payload: ExtraIssuePayload, idempotencyKey?: string): Promise<WarehouseTransfer> {
  return apiClient.request<WarehouseTransfer>(`/api/v1/production/orders/${orderId}/extra-issues`, {
    method: 'POST', headers: jsonHeaders(idempotencyKey), body: JSON.stringify(payload),
  });
}

export async function receiveExtraIssueApi(
  orderId: string, transferId: string, payload: ReceiptConfirmPayload, idempotencyKey?: string,
): Promise<WarehouseTransfer> {
  return apiClient.request<WarehouseTransfer>(`/api/v1/production/orders/${orderId}/extra-issues/${transferId}/receive`, {
    method: 'POST', headers: jsonHeaders(idempotencyKey), body: JSON.stringify(payload),
  });
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

// ═════════════════════════════════════════════════════════════════════════════
// مطالبات عجز استلام خامات الورشة (Transfer Discrepancy Claims - Phase 3)
// ═════════════════════════════════════════════════════════════════════════════

/** مطالبة عجز استلام — تطابق TransferDiscrepancyClaimRead في apps/api/app/modules/production/schemas.py */
export interface TransferDiscrepancyClaimRead {
  id: string;
  claim_number: string;
  transfer_id: string;
  transfer_number: string;
  transfer_line_id: string;
  order_id: string;
  order_number: string;
  item_id: string;
  item_name_ar: string;
  item_code: string;
  unit_id: string;
  unit_name_ar: string;
  dispatched_quantity: number;
  received_quantity: number;
  discrepancy_quantity: number;
  unit_cost: number | string;
  total_cost: number | string;
  status: string;
  status_ar: string;
  claimed_by: string;
  claimed_at: string;
  claim_notes: string;
  resolved_by?: string | null;
  resolved_at?: string | null;
  resolution_notes: string;
  created_at: string;
}

/** تسميات الحالات — مطابقة لـ DISCREPANCY_CLAIM_STATUS_AR في الخادم (لا حالات أخرى مدعومة) */
export const DISCREPANCY_CLAIM_STATUS_AR: Record<string, string> = {
  pending_investigation: 'معلقة · بانتظار مراجعة وحسم أمين المخزن',
  accepted_transit_loss: 'معتمدة · عجز نقل وفقد مبرر',
  accepted_measurement_error: 'معتمدة · خطأ كيل وقياس عند الصرف',
  rejected_under_carrier_liability: 'مرفوضة · مسؤولية الناقل/المسؤول الميداني',
};

/** شارة مختصرة للحالة */
export const DISCREPANCY_CLAIM_STATUS_BADGE: Record<string, string> = {
  pending_investigation: 'معلقة',
  accepted_transit_loss: 'معتمدة · عجز نقل',
  accepted_measurement_error: 'معتمدة · خطأ قياس',
  rejected_under_carrier_liability: 'مرفوضة',
};

/**
 * القرارات المدعومة فعلياً في الخادم فقط (Literal في TransferDiscrepancyClaimResolveRequest
 * وتحقق valid_decisions في service.resolve_discrepancy_claim) — لا تُعرض غيرها.
 * كل قرار مع أثره المخزني كما ينفذه الخادم (StockLedgerEntry entry_type="claim_settlement").
 */
export const DISCREPANCY_CLAIM_DECISIONS = [
  {
    value: 'accepted_transit_loss',
    label: 'قبول · عجز نقل وفقد مبرر',
    impact: 'يُثبت الفرق كعجز نقل مبرر: يسوّي الخادم رصيد الفرق المفتوح في سجل الحركات ويُحمّل كلفته على مصروف عجز النقل (5200/5220). لا تُعاد الكميات للمخزن.',
  },
  {
    value: 'accepted_measurement_error',
    label: 'قبول · خطأ كيل وقياس عند الصرف',
    impact: 'الكميات المرسلة كانت خاطئة القياس: يسوّي الخادم رصيد الفرق المفتوح في سجل الحركات بلا تعويض من أحد، والرصيد الورشي يبقى كما استُلم فعلياً.',
  },
  {
    value: 'rejected_under_carrier_liability',
    label: 'رفض · مسؤولية الناقل/المسؤول الميداني',
    impact: 'يُسجل القرار بالرفض وتُحمّل مسؤولية الفرق على الناقل أو المسؤول الميداني، ويسوّي الخادم رصيد الفرق المفتوح في سجل الحركات.',
  },
] as const;

export type DiscrepancyClaimDecision = (typeof DISCREPANCY_CLAIM_DECISIONS)[number]['value'];

/** جلب سجل المطالبات مع تصفية اختيارية بالحالة/الأمر (GET /production/discrepancy-claims) */
export async function fetchDiscrepancyClaims(
  filters: { status?: string; order_id?: string; limit?: number; offset?: number } = {},
): Promise<TransferDiscrepancyClaimRead[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.order_id) params.set('order_id', filters.order_id);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  const qs = params.toString();
  return apiClient.request<TransferDiscrepancyClaimRead[]>(`/api/v1/production/discrepancy-claims${qs ? `?${qs}` : ''}`);
}

/** مطالبات أمر تشغيل محدد (GET /production/orders/{id}/discrepancy-claims) */
export async function fetchOrderDiscrepancyClaims(orderId: string): Promise<TransferDiscrepancyClaimRead[]> {
  return apiClient.request<TransferDiscrepancyClaimRead[]>(`/api/v1/production/orders/${orderId}/discrepancy-claims`);
}

/**
 * حسم مطالبة (POST /production/discrepancy-claims/{id}/resolve).
 * الخادم وحده يسجل claim_settlement ويحدّث الأرصدة؛ Maker-Checker مطبق خادمياً:
 * لا يجوز لمن أثبت العجز (claimed_by) الحسم، والقرارات غير الثلاثة تُرفض.
 */
export async function resolveDiscrepancyClaimApi(
  claimId: string,
  payload: { decision: DiscrepancyClaimDecision; resolution_notes: string },
  idempotencyKey?: string,
): Promise<TransferDiscrepancyClaimRead> {
  return apiClient.request<TransferDiscrepancyClaimRead>(`/api/v1/production/discrepancy-claims/${claimId}/resolve`, {
    method: 'POST',
    headers: jsonHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// سلة طلبات العملاء غير المخططة (Demand Pool & Aggregation - Phase 4)
// ═════════════════════════════════════════════════════════════════════════════

/** بند طلب عميل غير مخطط — مطابق لـ DemandPoolItemRead في الخادم */
export interface DemandPoolItemRead {
  customer_order_line_id: string;
  customer_order_id: string;
  customer_order_number: string;
  customer_id: string;
  customer_name: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  numeric_size?: number | null;
  letter_size?: string | null;
  season: string;
  variant_label: string;
  ordered_quantity: number;
  planned_quantity: number;
  unplanned_quantity: number;
  order_date: string;
  expected_delivery_at?: string | null;
}

/** تخصيص بند طلب ضمن أمر مجمع */
export interface DemandAllocationItem {
  customer_order_line_id: string;
  allocated_quantity: number;
}

/** حصة عميل في الأمر المجمع */
export interface DemandCustomerShareItem {
  customer_id: string;
  customer_name: string;
  customer_order_id: string;
  customer_order_number: string;
  customer_order_line_id: string;
  allocated_quantity: number;
  percentage: number;
}

/** احتياج خامة للامر المجمع مقابل الرصيد المتاح بمخزن الخامات */
export interface DemandMaterialRequirementItem {
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  quantity_per_piece: number;
  required_quantity: number;
  available_quantity: number;
  shortage_quantity: number;
  is_sufficient: boolean;
}

/** نتيجة المعاينة — مطابقة لـ DemandMaterialsPreviewResponse في الخادم */
export interface DemandMaterialsPreviewResponse {
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_label: string;
  total_target_quantity: number;
  template_version_id?: string | null;
  customer_shares: DemandCustomerShareItem[];
  materials: DemandMaterialRequirementItem[];
  all_materials_available: boolean;
}

/** تخصيص طلب عميل على أمر تشغيل — مطابق لـ ProductionOrderDemandRead في الخادم */
export interface ProductionOrderDemandRead {
  id: string;
  production_order_id: string;
  customer_order_line_id: string;
  customer_order_id: string;
  customer_order_number: string;
  customer_id: string;
  customer_name: string;
  product_id: string;
  variant_id: string;
  allocated_quantity: number;
  fulfilled_quantity: number;
  remaining_quantity: number;
  fulfillment_pct: number;
  notes: string;
  created_at: string;
}

/** سلة الطلبات غير المخططة مع تصفية اختيارية (GET /production/demand-pool) */
export async function fetchDemandPool(
  filters: { product_id?: string; variant_id?: string; customer_id?: string } = {},
): Promise<DemandPoolItemRead[]> {
  const params = new URLSearchParams();
  if (filters.product_id) params.set('product_id', filters.product_id);
  if (filters.variant_id) params.set('variant_id', filters.variant_id);
  if (filters.customer_id) params.set('customer_id', filters.customer_id);
  const qs = params.toString();
  return apiClient.request<DemandPoolItemRead[]>(`/api/v1/production/demand-pool${qs ? `?${qs}` : ''}`);
}

/** معاينة التجميع: حصص العملاء وصافي احتياج الخامات والعجز (POST /production/demand-pool/preview) */
export async function previewDemandAggregation(items: DemandAllocationItem[]): Promise<DemandMaterialsPreviewResponse> {
  return apiClient.request<DemandMaterialsPreviewResponse>('/api/v1/production/demand-pool/preview', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ items }),
  });
}

/**
 * إنشاء أمر تشغيل مجمع (POST /production/orders/aggregate) — بصلاحية production:orders:create.
 * الخادم يتحقق من توافق الموديل والمقاس ومن عدم تجاوز المتبقي (409) ويحفظ تخصيصات كل عميل.
 */
export async function createAggregatedOrderApi(
  payload: {
    items: DemandAllocationItem[];
    template_version_id?: string | null;
    season?: string | null;
    notes?: string;
  },
  idempotencyKey?: string,
): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>('/api/v1/production/orders/aggregate', {
    method: 'POST',
    headers: jsonHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
}

/** تخصيصات طلبات العملاء المرتبطة بأمر التشغيل (GET /production/orders/{id}/demands) */
export async function fetchOrderDemands(orderId: string): Promise<ProductionOrderDemandRead[]> {
  return apiClient.request<ProductionOrderDemandRead[]>(`/api/v1/production/orders/${orderId}/demands`);
}

// ═════════════════════════════════════════════════════════════════════════════
// خامات العملاء والتكلفة (Customer Materials & Costing - Phase 6)
// ═════════════════════════════════════════════════════════════════════════════

export interface CustomerMaterialReceiptLine {
  id: string;
  receipt_id: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name: string;
  quantity_received: number;
  quantity_consumed: number;
  quantity_wasted: number;
  quantity_returned: number;
  quantity_remaining: number;
  unit_cost_estimate: number;
  order_id?: string | null;
  notes: string;
}

export interface CustomerMaterialReceipt {
  id: string;
  receipt_number: string;
  customer_id: string;
  customer_name: string;
  received_date: string;
  received_by: string;
  status: string;
  notes: string;
  created_at: string;
  lines: CustomerMaterialReceiptLine[];
}

export interface CustomerMaterialReceiptLineCreatePayload {
  item_id: string;
  unit_id: string;
  quantity_received: number;
  unit_cost_estimate?: number;
  order_id?: string | null;
  notes?: string;
}

export interface CustomerMaterialReceiptCreatePayload {
  customer_id: string;
  received_date?: string;
  lines: CustomerMaterialReceiptLineCreatePayload[];
  notes?: string;
}

export interface CustomerMaterialReturn {
  id: string;
  return_number: string;
  customer_id: string;
  customer_name: string;
  receipt_line_id: string;
  item_name_ar: string;
  quantity: number;
  returned_date: string;
  returned_by: string;
  notes: string;
}

export interface CustomerMaterialReturnCreatePayload {
  customer_id: string;
  receipt_line_id: string;
  quantity: number;
  notes?: string;
}

export interface CustomerMaterialBalanceItem {
  customer_id: string;
  customer_name: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_name: string;
  total_received: number;
  total_consumed: number;
  total_wasted: number;
  total_returned: number;
  current_balance: number;
  active_receipt_lines_count: number;
}

export interface OrderMaterialConsumptionPayload {
  items: Array<{
    material_line_id: string;
    consumed_quantity: number;
    waste_quantity: number;
    returned_quantity: number;
    notes?: string;
  }>;
  notes?: string;
}

export interface OrderCostCalculationPayload {
  labor_costing_method?: 'piece_based' | 'time_based';
  labor_rate?: number;
  labor_hours?: number;
  overhead_allocation_basis?: 'produced_pieces' | 'labor_hours' | 'machine_hours' | null;
  allocated_overhead_rate?: number;
  agreed_service_price?: number;
}

export async function fetchCustomerMaterialReceipts(customerId?: string): Promise<CustomerMaterialReceipt[]> {
  const query = customerId ? `?customer_id=${customerId}` : '';
  return apiClient.request<CustomerMaterialReceipt[]>(`/api/v1/production/customer-materials/receipts${query}`);
}

export async function createCustomerMaterialReceipt(payload: CustomerMaterialReceiptCreatePayload): Promise<CustomerMaterialReceipt> {
  return apiClient.request<CustomerMaterialReceipt>('/api/v1/production/customer-materials/receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function fetchCustomerMaterialBalances(customerId?: string): Promise<CustomerMaterialBalanceItem[]> {
  const query = customerId ? `?customer_id=${customerId}` : '';
  return apiClient.request<CustomerMaterialBalanceItem[]>(`/api/v1/production/customer-materials/balance${query}`);
}

export async function createCustomerMaterialReturn(payload: CustomerMaterialReturnCreatePayload): Promise<CustomerMaterialReturn> {
  return apiClient.request<CustomerMaterialReturn>('/api/v1/production/customer-materials/returns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function logOrderMaterialConsumption(orderId: string, payload: OrderMaterialConsumptionPayload): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>(`/api/v1/production/orders/${orderId}/material-consumption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function calculateOrderCosts(orderId: string, payload: OrderCostCalculationPayload): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>(`/api/v1/production/orders/${orderId}/calculate-costs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ─── T6 — بطاقة التكلفة والربحية وتقارير ربحية التشغيل ──────────────────────────────

export interface JobCostSheetMaterialLine {
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_name_ar: string;
  ownership: 'factory' | 'customer';
  commercial_treatment: string;
  planned_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  actual_consumed_quantity: number;
  actual_waste_quantity: number;
  actual_returned_quantity: number;
  unit_cost: number;
  total_cost: number;
  unit_cost_estimate: number;
}

export interface JobCostSheetLaborDetail {
  method: string;
  method_label_ar: string;
  rate: number;
  quantity_basis: number;
  total_cost: number;
}

export interface JobCostSheetOverheadDetail {
  basis: string | null;
  basis_label_ar: string;
  rate: number;
  base_quantity: number;
  total_cost: number;
}

export interface JobCostSheetWasteAnalysis {
  allowed_waste_pct: number;
  allowed_waste_qty: number;
  actual_waste_qty: number;
  actual_waste_pct: number;
  excess_waste_qty: number;
  excess_waste_cost: number;
  is_excess: boolean;
  settlement_status: string;
  settlement_status_ar: string;
}

export interface JobCostSheet {
  order_id: string;
  order_number: string;
  manufacturing_type: 'internal' | 'external';
  manufacturing_type_label_ar: string;
  customer_id?: string | null;
  customer_name?: string | null;
  product_name_ar: string;
  variant_info: string;
  target_quantity: number;
  status: string;
  status_label_ar: string;
  factory_materials: JobCostSheetMaterialLine[];
  customer_materials: JobCostSheetMaterialLine[];
  total_factory_material_cost: number;
  total_customer_material_cost: number;
  labor: JobCostSheetLaborDetail;
  overhead: JobCostSheetOverheadDetail;
  waste_analysis: JobCostSheetWasteAnalysis;
  total_manufacturing_cost: number;
  unit_manufacturing_cost: number;
  agreed_service_price: number;
  expected_revenue: number;
  gross_margin: number;
  gross_margin_pct: number;
  can_view_prices: boolean;
  cost_calculated_at?: string | null;
  cost_calculated_by?: string | null;
}

export interface WasteSettlementPayload {
  decision: 'pending_review' | 'approved_by_factory' | 'claimed_from_customer' | 'waived';
  notes?: string;
}

export interface ManufacturingProfitabilityItem {
  order_id: string;
  order_number: string;
  manufacturing_type: 'internal' | 'external';
  manufacturing_type_ar: string;
  customer_name?: string | null;
  product_name_ar: string;
  variant_info: string;
  target_quantity: number;
  status: string;
  factory_material_cost: number;
  labor_cost: number;
  overhead_cost: number;
  total_cost: number;
  unit_cost: number;
  service_price: number;
  revenue: number;
  gross_margin: number;
  gross_margin_pct: number;
  excess_waste_cost: number;
  waste_settlement_status: string;
}

export interface ManufacturingProfitabilityReport {
  generated_at: string;
  total_orders_count: number;
  internal_orders_count: number;
  cmt_orders_count: number;
  total_factory_cost: number;
  total_revenue: number;
  total_gross_margin: number;
  overall_gross_margin_pct: number;
  cmt_total_service_fee: number;
  cmt_total_cost: number;
  cmt_net_margin: number;
  items: ManufacturingProfitabilityItem[];
}

export async function fetchOrderCostSheet(orderId: string): Promise<JobCostSheet> {
  return apiClient.request<JobCostSheet>(`/api/v1/production/orders/${orderId}/cost-sheet`);
}

export async function updateWasteSettlement(orderId: string, payload: WasteSettlementPayload): Promise<ProductionOrder> {
  return apiClient.request<ProductionOrder>(`/api/v1/production/orders/${orderId}/waste-settlement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function fetchManufacturingProfitability(params?: {
  date_from?: string;
  date_to?: string;
  manufacturing_type?: string;
  customer_id?: string;
}): Promise<ManufacturingProfitabilityReport> {
  const q = new URLSearchParams();
  if (params?.date_from) q.append('date_from', params.date_from);
  if (params?.date_to) q.append('date_to', params.date_to);
  if (params?.manufacturing_type) q.append('manufacturing_type', params.manufacturing_type);
  if (params?.customer_id) q.append('customer_id', params.customer_id);
  const qs = q.toString() ? `?${q.toString()}` : '';
  return apiClient.request<ManufacturingProfitabilityReport>(`/api/v1/reports/manufacturing-profitability${qs}`);
}

// ─── Phase 7 — تقويم المصنع وتوقيت المراحل والاختناقات ──────────────────────────────

export interface FactoryCalendarConfig {
  id: string;
  shift_name: string;
  shift_start_time: string;
  shift_end_time: string;
  working_days: string;
  weekly_holidays: string;
  is_active: boolean;
  is_approved: boolean;
  created_at: string;
  updated_at: string;
}

export interface FactoryCalendarConfigUpdate {
  shift_name?: string;
  shift_start_time?: string;
  shift_end_time?: string;
  working_days?: string;
  weekly_holidays?: string;
  is_active?: boolean;
  is_approved?: boolean;
}

export interface BottleneckStageMetric {
  stage_name: string;
  stage_name_ar: string;
  total_completed_orders: number;
  avg_expected_minutes: number;
  avg_working_minutes: number;
  avg_elapsed_minutes: number;
  variance_minutes: number;
  bottleneck_count: number;
  bottleneck_percentage: number;
}

export interface BottleneckAnalysisResponse {
  stages: BottleneckStageMetric[];
  top_delay_reasons: Array<{ reason_code: string; reason_name_ar: string; count: number }>;
  active_bottlenecks_count: number;
  active_bottlenecks: Array<{
    order_id: string;
    order_number: string;
    stage_name: string;
    stage_name_ar: string;
    expected_minutes: number;
    current_working_minutes: number;
    delay_reason: string;
    delay_reason_ar: string;
  }>;
  calendar_configured: boolean;
  calendar_approved: boolean;
}

export async function fetchFactoryCalendar(): Promise<FactoryCalendarConfig> {
  return apiClient.request<FactoryCalendarConfig>('/api/v1/production/calendar');
}

export async function updateFactoryCalendar(payload: FactoryCalendarConfigUpdate): Promise<FactoryCalendarConfig> {
  return apiClient.request<FactoryCalendarConfig>('/api/v1/production/calendar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function skipProductionStage(
  orderId: string,
  stageName: string,
  skipReason: string
): Promise<StageEvent> {
  return apiClient.request<StageEvent>(`/api/v1/production/orders/${orderId}/stages/${stageName}/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip_reason: skipReason }),
  });
}

export async function adjustStageDuration(
  orderId: string,
  stageName: string,
  expectedDurationMinutes: number
): Promise<StageEvent> {
  return apiClient.request<StageEvent>(`/api/v1/production/orders/${orderId}/stages/${stageName}/duration`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_duration_minutes: expectedDurationMinutes }),
  });
}

export async function fetchBottleneckAnalysis(): Promise<BottleneckAnalysisResponse> {
  return apiClient.request<BottleneckAnalysisResponse>('/api/v1/production/bottleneck-analysis');
}

