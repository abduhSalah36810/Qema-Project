"""
مخططات Pydantic لأوامر وتشغيل مصنع القمة (Production Pydantic Schemas)
─────────────────────────────────────────────────────────────────────────────
توفر نماذج التحقق وتوثيق الـ API للـ:
1. المنتجات والموديلات والمتغيرات (المقاسات الرقمية 56-64 والحرفية والمواسم).
2. قوالب الإنتاج وإصداراتها ونسب الخامات.
3. أوامر التشغيل ولقطة الخامات المجمدة (Snapshot).
4. التحويلات المخزنية وإثبات الاستلام والفروقات.
5. التتبع التتابعي للمراحل الخمس الرسمية.
─────────────────────────────────────────────────────────────────────────────
"""
from datetime import datetime
from typing import Any, List, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


# ─── الأصناف والمخازن والوحدات ───────────────────────────────────────────────

class UnitRead(BaseModel):
    id: str
    code: str
    name_ar: str


class ItemCategoryRead(BaseModel):
    id: str
    code: str
    name_ar: str
    name_en: Optional[str] = None
    parent_id: Optional[str] = None
    description: str = ""
    is_active: bool
    sort_order: int = 0


class ItemCategoryCreate(BaseModel):
    code: str = Field(..., min_length=2, max_length=32, description="كود التصنيف الفريد")
    name_ar: str = Field(..., min_length=2, max_length=128, description="الاسم بالعربية")
    name_en: Optional[str] = Field(None, max_length=128, description="الاسم بالإنجليزية")
    parent_id: Optional[str] = Field(None, description="معرف التصنيف الأب")
    description: str = Field("", description="وصف التصنيف")
    is_active: bool = Field(True, description="حالة التفعيل")
    sort_order: int = Field(0, description="ترتيب العرض")


class ItemCategoryUpdate(BaseModel):
    name_ar: Optional[str] = Field(None, min_length=2, max_length=128)
    name_en: Optional[str] = Field(None, max_length=128)
    parent_id: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


class ItemCategoryTreeRead(ItemCategoryRead):
    subcategories: list["ItemCategoryTreeRead"] = Field(default_factory=list)


class ApplicationLineRead(BaseModel):
    id: str
    code: str
    name_ar: str
    name_en: Optional[str] = None
    description: str = ""
    is_active: bool
    sort_order: int = 0


class CatalogItemUsageRead(BaseModel):
    item_id: str
    application_id: str
    created_at: datetime
    application_code: Optional[str] = None
    application_name_ar: Optional[str] = None


class CatalogItemUsageCreate(BaseModel):
    application_id: str = Field(..., description="معرف خط التطبيق المطلوب ربطه بالصنف")


class WarehouseRead(BaseModel):
    id: str
    code: str
    name_ar: str
    is_active: bool


class CatalogItemRead(BaseModel):
    id: str
    code: str
    name_ar: str
    item_type: str
    unit_id: str
    unit_name_ar: Optional[str] = None
    is_consumable: bool
    is_active: bool
    category_id: Optional[str] = None
    classification_status: str = "needs_review"
    attributes: dict = Field(default_factory=dict)
    reorder_level: float = 0.0
    approval_status: str = "draft"
    rejection_reason: Optional[str] = None
    submitted_at: Optional[datetime] = None
    submitted_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    approved_by: Optional[str] = None
    has_pending_revision: bool = False


class CatalogItemRejectRequest(BaseModel):
    rejection_reason: str = Field(..., min_length=10, max_length=1000, description="سبب رفض اعتماد الصنف (إلزامي لا يقل عن 10 أحرف)")


class CatalogItemRevisionCreate(BaseModel):
    proposed_changes: dict[str, Any] = Field(..., description="التغييرات المقترحة على الحقول القابلة للمراجعة")
    change_summary: str = Field(..., min_length=5, max_length=500, description="ملخص التعديلات وسببها التشغيلي")

    @field_validator("proposed_changes")
    @classmethod
    def validate_proposed_changes(cls, v: Any) -> dict[str, Any]:
        if not isinstance(v, dict) or not v:
            raise ValueError("يجب تحديد حقل واحد على الأقل في التعديلات المقترحة (proposed_changes).")
        disallowed = {"id", "code", "unit_id", "item_type", "created_at", "approval_status"}
        intersection = disallowed.intersection(v.keys())
        if intersection:
            raise ValueError(f"لا يمكن تعديل الحقول الجوهرية التالية عبر المراجعات: {', '.join(sorted(intersection))}")
        if "attributes" in v and isinstance(v["attributes"], dict):
            for dim_key in ("width_cm", "length_cm", "diameter_mm", "weight_gsm"):
                if dim_key in v["attributes"] and v["attributes"][dim_key] is not None:
                    try:
                        val = float(v["attributes"][dim_key])
                        if val <= 0:
                            raise ValueError(f"قيمة {dim_key} يجب أن تكون رقماً موجباً أكبر من الصفر.")
                    except (ValueError, TypeError):
                        raise ValueError(f"قيمة {dim_key} يجب أن تكون رقماً صالحاً أكبر من الصفر.")
        return v


class CatalogItemRevisionRejectRequest(BaseModel):
    rejection_reason: str = Field(..., min_length=10, max_length=1000, description="سبب رفض التعديل المقترح (إلزامي لا يقل عن 10 أحرف)")


class CatalogItemRevisionRead(BaseModel):
    id: str
    item_id: str
    revision_number: int
    status: str
    proposed_changes: dict[str, Any]
    change_summary: str
    base_fingerprint: Optional[str] = None
    submitted_by: str
    submitted_at: datetime
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    created_at: datetime


class CatalogApprovalHistoryRead(BaseModel):
    id: str
    item_id: str
    revision_id: Optional[str] = None
    event_type: str
    from_status: Optional[str] = None
    to_status: str
    actor_id: str
    actor_role: str
    reason: Optional[str] = None
    before_snapshot: dict[str, Any] = Field(default_factory=dict)
    after_snapshot: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class CatalogItemCreate(BaseModel):
    code: str = Field(..., min_length=2, max_length=64, description="كود الصنف الفريد")
    name_ar: str = Field(..., min_length=2, max_length=128, description="اسم الصنف بالعربية")
    item_type: str = Field(..., min_length=2, max_length=64, description="نوع الصنف التشغيلي")
    unit_id: str = Field(..., description="معرف وحدة القياس")
    category_id: Optional[str] = Field(None, description="معرف التصنيف")
    classification_status: str = Field("needs_review", description="حالة التصنيف")
    attributes: dict[str, Any] = Field(default_factory=dict, description="المواصفات الفنية ككائن JSON")
    reorder_level: float = Field(0.0, ge=0.0, description="حد إعادة الطلب (غير سالب)")
    is_consumable: bool = Field(True, description="هل الصنف مستهلك")
    is_active: bool = Field(False, description="حالة التفعيل (المسودات تبدأ دائماً غير مفعلة حتى اعتمادها)")
    application_line_ids: Optional[list[str]] = Field(None, description="معرفات خطوط التطبيق المبدئية")

    @field_validator("attributes")
    @classmethod
    def validate_attributes_dict(cls, v: Any) -> dict:
        if not isinstance(v, dict):
            raise ValueError("حقل attributes يجب أن يكون كائن JSON صالح (Dictionary).")
        for dim_key in ("width_cm", "length_cm", "diameter_mm", "weight_gsm"):
            if dim_key in v and v[dim_key] is not None:
                try:
                    val = float(v[dim_key])
                    if val <= 0:
                        raise ValueError(f"قيمة {dim_key} يجب أن تكون رقماً موجباً أكبر من الصفر.")
                except (ValueError, TypeError):
                    raise ValueError(f"قيمة {dim_key} يجب أن تكون رقماً صالحاً أكبر من الصفر.")
        return v

    @field_validator("classification_status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        allowed = {"confirmed", "suggested", "needs_review", "not_applicable"}
        if v not in allowed:
            raise ValueError(f"حالة التصنيف غير صالحة. الحالات المسموحة: {', '.join(sorted(allowed))}")
        return v


class CatalogItemUpdate(BaseModel):
    name_ar: Optional[str] = Field(None, min_length=2, max_length=128)
    item_type: Optional[str] = Field(None, min_length=2, max_length=64)
    unit_id: Optional[str] = None
    category_id: Optional[str] = None
    classification_status: Optional[str] = None
    attributes: Optional[dict[str, Any]] = None
    reorder_level: Optional[float] = Field(None, ge=0.0)
    is_consumable: Optional[bool] = None
    is_active: Optional[bool] = None

    @field_validator("attributes")
    @classmethod
    def validate_attributes_dict(cls, v: Any) -> Optional[dict]:
        if v is not None:
            if not isinstance(v, dict):
                raise ValueError("حقل attributes يجب أن يكون كائن JSON صالح (Dictionary).")
            for dim_key in ("width_cm", "length_cm", "diameter_mm", "weight_gsm"):
                if dim_key in v and v[dim_key] is not None:
                    try:
                        val = float(v[dim_key])
                        if val <= 0:
                            raise ValueError(f"قيمة {dim_key} يجب أن تكون رقماً موجباً أكبر من الصفر.")
                    except (ValueError, TypeError):
                        raise ValueError(f"قيمة {dim_key} يجب أن تكون رقماً صالحاً أكبر من الصفر.")
        return v

    @field_validator("classification_status")
    @classmethod
    def validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            allowed = {"confirmed", "suggested", "needs_review", "not_applicable"}
            if v not in allowed:
                raise ValueError(f"حالة التصنيف غير صالحة. الحالات المسموحة: {', '.join(sorted(allowed))}")
        return v


class CatalogItemDetailRead(CatalogItemRead):
    category: Optional[ItemCategoryRead] = None
    unit: Optional[UnitRead] = None
    usages: list[ApplicationLineRead] = Field(default_factory=list)
    pending_revision: Optional[CatalogItemRevisionRead] = None


class StockBalanceRead(BaseModel):
    item_id: str
    item_code: str
    item_name_ar: str
    unit_id: str
    unit_name_ar: str
    warehouse_id: str
    warehouse_code: str
    warehouse_name_ar: str
    balance: Optional[float] = None
    is_established: bool


class StockLedgerEntryRead(BaseModel):
    id: str
    item_id: str
    item_code: str
    item_name_ar: str
    unit_id: str
    unit_name_ar: str
    warehouse_id: Optional[str] = None
    warehouse_name_ar: Optional[str] = None
    location_type: str
    bucket_reference: Optional[str] = None
    quantity: float
    reference_doc_type: str
    reference_doc_id: str
    transfer_line_id: Optional[str] = None
    entry_type: str
    created_at: datetime
    created_by: str


# ─── المنتجات والموديلات ───────────────────────────────────────────────────

class ProductVariantRead(BaseModel):
    id: str
    product_id: str
    numeric_size: int = Field(..., description="المقاس الرقمي المعتمد: 56, 58, 60, 62, 64")
    letter_size: str = Field(..., description="المقاس الحرفي كبُعد منفصل: S, M, L, XL, 2XL")
    season: str = Field(..., description="الموسم: summer, autumn, winter")
    sku: str


class ProductRead(BaseModel):
    id: str
    code: str
    name_ar: str
    style_type: str = Field(..., description="نوع الموديل (مثل: half_collar_cuff, sharwal)")
    description: str = ""
    variants: List[ProductVariantRead] = []


# ─── قوالب الإنتاج ─────────────────────────────────────────────────────────

class TemplateLineCreate(BaseModel):
    item_id: str
    unit_id: str
    quantity_per_reference: float = Field(..., gt=0, description="الكمية المطلوبة للكمية المرجعية للقالب")
    notes: str = ""


class TemplateLineRead(BaseModel):
    id: str
    item_id: str
    item_name_ar: str = ""
    item_code: str = ""
    unit_id: str
    unit_name_ar: str = ""
    quantity_per_reference: float
    notes: str = ""


class TemplateVersionRead(BaseModel):
    id: str
    version_number: int
    status: str
    reference_quantity: float = Field(..., description="الكمية المرجعية التي حُسبت على أساسها الخامات (مثلاً 100)")
    notes: str = ""
    lines: List[TemplateLineRead] = []


class TemplateCreate(BaseModel):
    code: str
    name_ar: str
    product_id: str
    reference_quantity: float = Field(default=100.0, gt=0)
    lines: List[TemplateLineCreate] = []
    notes: str = ""


class TemplateRead(BaseModel):
    id: str
    code: str
    name_ar: str
    product_id: str
    product_name_ar: str = ""
    is_active: bool
    versions: List[TemplateVersionRead] = []


# ─── أوامر التشغيل واللقطة المجمدة ─────────────────────────────────────────

class OrderMaterialCreate(BaseModel):
    item_id: str
    unit_id: str
    planned_quantity: float = Field(..., gt=0)
    notes: str = ""


class OrderMaterialSnapshotRead(BaseModel):
    id: str
    item_id: str
    item_name_ar: str = ""
    item_code: str = ""
    unit_id: str
    unit_name_ar: str = ""
    planned_quantity: float = Field(..., description="الكمية المخططة المحسوبة نسبياً والمجمدة كلقطة")
    dispatched_quantity: float = 0.0
    received_quantity: float = 0.0
    discrepancy_quantity: float = 0.0
    status: str
    notes: str = ""


class ProductionStageEventRead(BaseModel):
    id: str
    stage_name: str
    status: str
    actor_id: str
    actor_name: str = ""
    timestamp: datetime
    notes: str = ""


class ProductionStageHistoryRead(BaseModel):
    id: str
    stage_name: str
    from_status: str
    to_status: str
    actor_id: str
    actor_name: str = ""
    previous_notes: str = ""
    reason: str
    timestamp: datetime


class StageRollbackRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)


class ProductionOrderItemCreate(BaseModel):
    product_id: str
    variant_id: str
    target_quantity: float = Field(..., gt=0)
    season: str
    product_type: Literal["factory_brand", "private_label"] = "factory_brand"
    customer_id: Optional[str] = None
    template_version_id: Optional[str] = None
    fabric_area: str = Field(default="", max_length=128)
    fabric_name: str = Field(default="", max_length=128)
    fabric_color: str = Field(default="", max_length=64)
    fabric_weight: str = Field(default="", max_length=64)
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_private_label_customer(self):
        if self.product_type == "private_label" and not self.customer_id:
            raise ValueError("يجب تحديد العميل عند التصنيع للغير.")
        if self.product_type == "factory_brand" and self.customer_id:
            raise ValueError("يرتبط العميل ببند التصنيع للغير فقط.")
        return self


class OrderCreate(BaseModel):
    items: Optional[List[ProductionOrderItemCreate]] = Field(default=None, min_length=1, max_length=100)
    product_id: Optional[str] = None
    variant_id: Optional[str] = None
    target_quantity: Optional[float] = Field(default=None, gt=0, description="الكمية المستهدفة لدفعة الإنتاج")
    season: Optional[str] = None
    template_version_id: Optional[str] = Field(default=None, description="معرف إصدار القالب لحساب الخامات ونسبتها")
    custom_materials: Optional[List[OrderMaterialCreate]] = Field(default=None, description="خامات مخصصة عند الإنشاء من الصفر")
    assigned_to: str = ""
    notes: str = ""

    @model_validator(mode="after")
    def validate_legacy_or_items(self):
        if self.items:
            if self.product_id or self.variant_id or self.target_quantity or self.season:
                raise ValueError("استخدم البنود المتعددة أو حقول المنتج المفرد فقط.")
        elif not (self.product_id and self.variant_id and self.target_quantity and self.season):
            raise ValueError("يجب إدخال بند منتج واحد على الأقل أو بيانات المنتج المفرد كاملة.")
        return self


class ProductionOrderItemRead(BaseModel):
    id: str
    product_id: str
    product_name_ar: str
    variant_id: str
    variant_info: str
    product_type: str
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    target_quantity: float
    season: str
    fabric_area: str
    fabric_name: str
    fabric_color: str
    fabric_weight: str
    notes: str


class OrderRead(BaseModel):
    id: str
    order_number: str
    product_id: str
    product_name_ar: str = ""
    variant_id: str
    variant_info: str = ""
    target_quantity: float
    season: str
    status: str
    created_by: str
    assigned_to: str
    created_at: datetime
    notes: str
    items: List[ProductionOrderItemRead] = []
    materials: List[OrderMaterialSnapshotRead] = []
    stage_events: List[ProductionStageEventRead] = []
    stage_history: List[ProductionStageHistoryRead] = []
    defects: List["ProductionDefectRead"] = []


class ProductionDefectCreate(BaseModel):
    stage_name: str = Field(..., min_length=1, max_length=32)
    description: str = Field(..., min_length=1, max_length=4000)
    affected_quantity: float = Field(..., gt=0)
    responsible: str = Field(..., min_length=1, max_length=128)
    repair_action: str = Field(..., min_length=1, max_length=4000)
    repair_cost_description: str = Field(default="", max_length=2000)


class ProductionDefectUpdate(BaseModel):
    status: str = Field(..., pattern="^(reported|repair_in_progress|repaired|closed)$")
    repair_action: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    repair_cost_description: Optional[str] = Field(default=None, max_length=2000)


class ProductionDefectRead(BaseModel):
    id: str
    defect_number: str
    order_id: str
    stage_name: str
    description: str
    affected_quantity: float
    responsible: str
    repair_action: str
    status: str
    repair_cost_description: str
    reported_by: str
    created_at: datetime
    updated_at: datetime


OrderRead.model_rebuild()


# ─── التحويلات المخزنية وتأكيد الاستلام ─────────────────────────────────────

class ReceiptLineConfirm(BaseModel):
    item_id: str
    received_quantity: float = Field(..., ge=0)
    notes: str = ""


class ReceiptConfirmRequest(BaseModel):
    received_lines: List[ReceiptLineConfirm]
    notes: str = ""


class WarehouseTransferLineRead(BaseModel):
    id: str
    item_id: str
    item_name_ar: str = ""
    item_code: str = ""
    unit_id: str
    unit_name_ar: str = ""
    dispatched_quantity: float
    received_quantity: float
    discrepancy_quantity: float
    notes: str = ""


class WarehouseTransferRead(BaseModel):
    id: str
    transfer_number: str
    order_id: str
    source_warehouse_id: str
    destination_warehouse_id: str
    status: str
    dispatched_at: datetime
    dispatched_by: str
    received_at: Optional[datetime] = None
    received_by: Optional[str] = None
    notes: str = ""
    lines: List[WarehouseTransferLineRead] = []


# ─── مراحل التشغيل ────────────────────────────────────────────────────────

class StageUpdate(BaseModel):
    status: str = Field(..., description="حالة المرحلة: not_started, in_progress, completed")
    notes: str = ""


# ─── فحص وتحليل النواقص ───────────────────────────────────────────────────

class MaterialShortageItem(BaseModel):
    item_id: str
    item_code: str
    item_name_ar: str
    unit_id: str
    unit_name_ar: str
    required_quantity: float
    available_quantity: float
    shortage_quantity: float
    has_shortage: bool


class OrderShortagesReport(BaseModel):
    order_id: str
    order_number: str
    has_any_shortage: bool
    can_dispatch: bool
    materials: List[MaterialShortageItem]


# ─── استلام المنتج التام ───────────────────────────────────────────────────

class FinishedGoodsReceiptCreate(BaseModel):
    received_quantity: float = Field(..., gt=0)
    accepted_quantity: float = Field(..., gt=0)
    rejected_quantity: float = Field(default=0.0, ge=0)
    notes: str = Field(default="", max_length=2000)


class FinishedGoodsReceiptRead(BaseModel):
    order_id: str
    order_number: str
    target_quantity: float
    received_quantity: float
    accepted_quantity: float
    rejected_quantity: float
    warehouse_name: str
    receipt_status: str
    confirmed_at: datetime
    confirmed_by: str
    notes: str


# ─── أداء مراحل الإنتاج ───────────────────────────────────────────────────

class StagePerformanceItem(BaseModel):
    stage_name: str
    stage_name_ar: str
    total_events: int
    completed_orders: int
    avg_duration_minutes: float
    standard_duration_minutes: float
    delayed_orders_count: int
    on_time_rate: float


class ProductionPerformanceSummary(BaseModel):
    total_active_orders: int
    total_completed_orders: int
    overall_cycle_avg_hours: float
    stages: List[StagePerformanceItem]
    delayed_orders: List[dict]
