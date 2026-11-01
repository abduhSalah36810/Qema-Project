"""
نماذج الإنتاج والمخازن والمنتجات التأسيسية (Production, Catalog & Stock Models)
─────────────────────────────────────────────────────────────────────────────
توفر تمثيلاً جدولياً كاملاً لقواعد وأبعاد أوامر التشغيل المؤقتة لمصنع القمة:
1. موديلات الجلابيب وأنواع الياقات والبالطو والشروال.
2. المقاسات الرقمية (56-64) والحرفية (S-2XL) والمواسم التشغيلية.
3. التمييز بين الخامات ومستلزمات الصيانة والأدوات المعادة ومواد التغليف.
4. قوالب التشغيل وإصداراتها والكمية المرجعية مع حفظ لقطة خامات مجمدة للأمر.
5. التحويلات المخزنية وتأكيد استلام أمين المخزن مع تسجيل الفروقات.
6. التتبع التتابعي لمراحل القص والتشطيب والكبسولة والكي والتعبئة.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, Numeric, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Warehouse(Base):
    __tablename__ = "warehouses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Unit(Base):
    __tablename__ = "units"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(64), nullable=False)


class ItemCategory(Base):
    __tablename__ = "item_categories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    name_en: Mapped[str | None] = mapped_column(String(128), nullable=True, default=None)
    parent_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("item_categories.id", ondelete="RESTRICT"), nullable=True, default=None)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    parent: Mapped["ItemCategory | None"] = relationship("ItemCategory", remote_side=[id], back_populates="subcategories")
    subcategories: Mapped[list["ItemCategory"]] = relationship("ItemCategory", back_populates="parent")
    items: Mapped[list["CatalogItem"]] = relationship("CatalogItem", back_populates="category")


class ApplicationLine(Base):
    __tablename__ = "application_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    name_en: Mapped[str | None] = mapped_column(String(128), nullable=True, default=None)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class CatalogItemUsage(Base):
    __tablename__ = "catalog_item_usages"

    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id", ondelete="CASCADE"), primary_key=True)
    application_id: Mapped[str] = mapped_column(String(36), ForeignKey("application_lines.id", ondelete="RESTRICT"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    item: Mapped["CatalogItem"] = relationship("CatalogItem", back_populates="usages")
    application: Mapped["ApplicationLine"] = relationship("ApplicationLine")


class CatalogItem(Base):
    __tablename__ = "catalog_items"
    __table_args__ = (
        CheckConstraint("classification_status in ('confirmed', 'suggested', 'needs_review', 'not_applicable')", name="ck_catalog_items_classification_status"),
        CheckConstraint("reorder_level >= 0", name="ck_catalog_items_reorder_level_nonnegative"),
        CheckConstraint("approval_status in ('draft', 'pending_review', 'approved', 'rejected')", name="ck_catalog_items_approval_status"),
        CheckConstraint("NOT is_active OR approval_status = 'approved'", name="ck_catalog_items_active_consistency"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    item_type: Mapped[str] = mapped_column(String(64), nullable=False)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    is_consumable: Mapped[bool] = mapped_column(Boolean, default=True)  # False للأدوات والباترونات
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    category_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("item_categories.id", ondelete="RESTRICT"), nullable=True, default=None)
    classification_status: Mapped[str] = mapped_column(String(32), default="needs_review", nullable=False)
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    reorder_level: Mapped[object] = mapped_column(Numeric(12, 3), default=Decimal("0"), nullable=False)
    approval_status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    submitted_by: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    unit: Mapped["Unit"] = relationship("Unit")
    category: Mapped["ItemCategory | None"] = relationship("ItemCategory", back_populates="items")
    usages: Mapped[list["CatalogItemUsage"]] = relationship("CatalogItemUsage", back_populates="item", cascade="all, delete-orphan")
    revisions: Mapped[list["CatalogItemRevision"]] = relationship("CatalogItemRevision", back_populates="item", cascade="all, delete-orphan")
    approval_history: Mapped[list["CatalogApprovalHistory"]] = relationship("CatalogApprovalHistory", back_populates="item", cascade="all, delete-orphan")


class CatalogItemRevision(Base):
    __tablename__ = "catalog_item_revisions"
    __table_args__ = (
        Index(
            "uq_catalog_item_single_open_revision",
            "item_id",
            unique=True,
            postgresql_where=text("status = 'pending_review'"),
        ),
        CheckConstraint(
            "status IN ('pending_review', 'applied', 'rejected', 'cancelled')",
            name="ck_catalog_item_revisions_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id", ondelete="CASCADE"), nullable=False)
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(32), default="pending_review", nullable=False)
    proposed_changes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    change_summary: Mapped[str] = mapped_column(Text, nullable=False)
    base_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    submitted_by: Mapped[str] = mapped_column(String(64), nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    reviewed_by: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    item: Mapped["CatalogItem"] = relationship("CatalogItem", back_populates="revisions")
    history_entries: Mapped[list["CatalogApprovalHistory"]] = relationship("CatalogApprovalHistory", back_populates="revision")


class CatalogApprovalHistory(Base):
    __tablename__ = "catalog_approval_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id", ondelete="CASCADE"), nullable=False)
    revision_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("catalog_item_revisions.id", ondelete="SET NULL"), nullable=True, default=None)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)
    to_status: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_role: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    before_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    after_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    item: Mapped["CatalogItem"] = relationship("CatalogItem", back_populates="approval_history")
    revision: Mapped["CatalogItemRevision | None"] = relationship("CatalogItemRevision", back_populates="history_entries")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    style_type: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    variants: Mapped[list["ProductVariant"]] = relationship("ProductVariant", back_populates="product", cascade="all, delete-orphan")


class ProductVariant(Base):
    __tablename__ = "product_variants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    numeric_size: Mapped[int] = mapped_column(Integer, nullable=False)  # 56, 58, 60, 62, 64
    letter_size: Mapped[str] = mapped_column(String(16), nullable=False)  # S, M, L, XL, 2XL
    season: Mapped[str] = mapped_column(String(32), nullable=False)  # summer, autumn, winter
    sku: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    product: Mapped["Product"] = relationship("Product", back_populates="variants")


class ProductionTemplate(Base):
    __tablename__ = "production_templates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("products.id"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    product: Mapped["Product"] = relationship("Product")
    versions: Mapped[list["ProductionTemplateVersion"]] = relationship("ProductionTemplateVersion", back_populates="template", cascade="all, delete-orphan")


class ProductionTemplateVersion(Base):
    __tablename__ = "production_template_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    template_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_templates.id", ondelete="CASCADE"), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft, approved, archived
    reference_quantity: Mapped[float] = mapped_column(Float, default=100.0, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    template: Mapped["ProductionTemplate"] = relationship("ProductionTemplate", back_populates="versions")
    lines: Mapped[list["ProductionTemplateLine"]] = relationship("ProductionTemplateLine", back_populates="version", cascade="all, delete-orphan")


class ProductionTemplateLine(Base):
    __tablename__ = "production_template_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    version_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_template_versions.id", ondelete="CASCADE"), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    quantity_per_reference: Mapped[float] = mapped_column(Float, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="")

    version: Mapped["ProductionTemplateVersion"] = relationship("ProductionTemplateVersion", back_populates="lines")
    item: Mapped["CatalogItem"] = relationship("CatalogItem")
    unit: Mapped["Unit"] = relationship("Unit")


class ProductionOrder(Base):
    __tablename__ = "production_orders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("products.id"), nullable=False)
    variant_id: Mapped[str] = mapped_column(String(36), ForeignKey("product_variants.id"), nullable=False)
    template_version_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("production_template_versions.id"), nullable=True)
    customer_order_line_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("customer_order_lines.id"), nullable=True, index=True)
    target_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    season: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft, materials_dispatched, in_production, completed, cancelled
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    assigned_to: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    notes: Mapped[str] = mapped_column(Text, default="")

    product: Mapped["Product"] = relationship("Product")
    variant: Mapped["ProductVariant"] = relationship("ProductVariant")
    template_version: Mapped["ProductionTemplateVersion | None"] = relationship("ProductionTemplateVersion")
    customer_order_line: Mapped["CustomerOrderLine | None"] = relationship(back_populates="production_orders")
    materials: Mapped[list["ProductionOrderMaterial"]] = relationship("ProductionOrderMaterial", back_populates="order", cascade="all, delete-orphan")
    stage_events: Mapped[list["ProductionStageEvent"]] = relationship("ProductionStageEvent", back_populates="order", cascade="all, delete-orphan")
    stage_history: Mapped[list["ProductionStageHistory"]] = relationship("ProductionStageHistory", back_populates="order", cascade="all, delete-orphan")
    defects: Mapped[list["ProductionDefect"]] = relationship("ProductionDefect", back_populates="order")
    order_items: Mapped[list["ProductionOrderItem"]] = relationship("ProductionOrderItem", back_populates="order", cascade="all, delete-orphan")


class ProductionOrderItem(Base):
    __tablename__ = "production_order_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("products.id"), nullable=False)
    variant_id: Mapped[str] = mapped_column(String(36), ForeignKey("product_variants.id"), nullable=False)
    product_type: Mapped[str] = mapped_column(String(32), nullable=False)
    customer_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("customers.id"), nullable=True)
    template_version_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("production_template_versions.id"), nullable=True)
    target_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    season: Mapped[str] = mapped_column(String(32), nullable=False)
    fabric_area: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    fabric_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    fabric_color: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    fabric_weight: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")

    order: Mapped["ProductionOrder"] = relationship("ProductionOrder", back_populates="order_items")
    product: Mapped["Product"] = relationship("Product")
    variant: Mapped["ProductVariant"] = relationship("ProductVariant")
    customer: Mapped["Customer | None"] = relationship("Customer")
    template_version: Mapped["ProductionTemplateVersion | None"] = relationship("ProductionTemplateVersion")


class ProductionDefect(Base):
    __tablename__ = "production_defects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    defect_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_orders.id"), nullable=False, index=True)
    stage_name: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    affected_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    responsible: Mapped[str] = mapped_column(String(128), nullable=False)
    repair_action: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="reported")
    repair_cost_description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reported_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    order: Mapped["ProductionOrder"] = relationship("ProductionOrder", back_populates="defects")


class ProductionOrderMaterial(Base):
    __tablename__ = "production_order_materials"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    planned_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    dispatched_quantity: Mapped[float] = mapped_column(Float, default=0.0)
    received_quantity: Mapped[float] = mapped_column(Float, default=0.0)
    discrepancy_quantity: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending, dispatched, received_with_discrepancy, received_complete
    notes: Mapped[str] = mapped_column(Text, default="")
    item_name_snapshot: Mapped[str | None] = mapped_column(String(128), nullable=True, default=None)

    order: Mapped["ProductionOrder"] = relationship("ProductionOrder", back_populates="materials")
    item: Mapped["CatalogItem"] = relationship("CatalogItem")
    unit: Mapped["Unit"] = relationship("Unit")


class WarehouseTransfer(Base):
    __tablename__ = "warehouse_transfers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    transfer_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_orders.id"), nullable=False)
    source_warehouse_id: Mapped[str] = mapped_column(String(36), ForeignKey("warehouses.id"), nullable=False)
    destination_warehouse_id: Mapped[str] = mapped_column(String(36), ForeignKey("warehouses.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="in_transit")  # in_transit, partially_received, received_confirmed, cancelled
    dispatched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    dispatched_by: Mapped[str] = mapped_column(String(64), nullable=False)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    received_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")

    order: Mapped["ProductionOrder"] = relationship("ProductionOrder")
    source_warehouse: Mapped["Warehouse"] = relationship("Warehouse", foreign_keys=[source_warehouse_id])
    destination_warehouse: Mapped["Warehouse"] = relationship("Warehouse", foreign_keys=[destination_warehouse_id])
    lines: Mapped[list["WarehouseTransferLine"]] = relationship("WarehouseTransferLine", back_populates="transfer", cascade="all, delete-orphan")


class WarehouseTransferLine(Base):
    __tablename__ = "warehouse_transfer_lines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    transfer_id: Mapped[str] = mapped_column(String(36), ForeignKey("warehouse_transfers.id", ondelete="CASCADE"), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    dispatched_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    received_quantity: Mapped[float] = mapped_column(Float, default=0.0)
    discrepancy_quantity: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str] = mapped_column(Text, default="")

    transfer: Mapped["WarehouseTransfer"] = relationship("WarehouseTransfer", back_populates="lines")
    item: Mapped["CatalogItem"] = relationship("CatalogItem")
    unit: Mapped["Unit"] = relationship("Unit")


class StockLedgerEntry(Base):
    __tablename__ = "stock_ledger_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False, index=True)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    warehouse_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("warehouses.id"), nullable=True, index=True)
    location_type: Mapped[str] = mapped_column(String(24), nullable=False)  # warehouse, in_transit, discrepancy
    bucket_reference: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[float] = mapped_column(Float, nullable=False)
    reference_doc_type: Mapped[str] = mapped_column(String(64), nullable=False)
    reference_doc_id: Mapped[str] = mapped_column(String(36), nullable=False)
    transfer_line_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("warehouse_transfer_lines.id"), nullable=True)
    entry_type: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)

    item: Mapped["CatalogItem"] = relationship("CatalogItem")
    unit: Mapped["Unit"] = relationship("Unit")
    warehouse: Mapped["Warehouse | None"] = relationship("Warehouse")


class ProductionStageEvent(Base):
    __tablename__ = "production_stage_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False)
    stage_name: Mapped[str] = mapped_column(String(32), nullable=False)  # cutting, finishing, snap_installation, ironing, packing
    status: Mapped[str] = mapped_column(String(32), nullable=False)  # not_started, in_progress, completed
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_name: Mapped[str] = mapped_column(String(128), default="")
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    notes: Mapped[str] = mapped_column(Text, default="")

    order: Mapped["ProductionOrder"] = relationship("ProductionOrder", back_populates="stage_events")


class ProductionStageHistory(Base):
    __tablename__ = "production_stage_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    stage_name: Mapped[str] = mapped_column(String(32), nullable=False)
    from_status: Mapped[str] = mapped_column(String(32), nullable=False)
    to_status: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_name: Mapped[str] = mapped_column(String(128), default="")
    previous_notes: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    order: Mapped["ProductionOrder"] = relationship("ProductionOrder", back_populates="stage_history")


# ─── الجداول التأسيسية للهيكل العام ──────────────────────────────────────────

class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), default="")
    city: Mapped[str] = mapped_column(String(64), default="")
    address: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    department: Mapped[str] = mapped_column(String(64), default="production")
    job_title: Mapped[str] = mapped_column(String(64), default="")
    base_salary: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active")
    hire_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class EmployeeAttendance(Base):
    __tablename__ = "employee_attendance"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    employee_id: Mapped[str] = mapped_column(String(36), ForeignKey("employees.id"), nullable=False, index=True)
    attendance_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)  # present, late, absent_permitted, absent_unpermitted
    delay_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    overtime_hours: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    recorded_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    employee: Mapped["Employee"] = relationship("Employee")


class PayPeriod(Base):
    __tablename__ = "pay_periods"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    period_name: Mapped[str] = mapped_column(String(64), nullable=False)
    start_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft, approved, paid, closed


class PayrollRun(Base):
    __tablename__ = "payroll_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    period_id: Mapped[str] = mapped_column(String(36), ForeignKey("pay_periods.id"), nullable=False, index=True)
    employee_id: Mapped[str] = mapped_column(String(36), ForeignKey("employees.id"), nullable=False, index=True)
    base_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    overtime_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    bonus_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    deductions_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    advances_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    net_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)  # draft, approved, paid
    cash_document_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cash_documents.id"), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)

    period: Mapped["PayPeriod"] = relationship("PayPeriod")
    employee: Mapped["Employee"] = relationship("Employee")


class DailyExpense(Base):
    __tablename__ = "daily_expenses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    expense_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending")


class IdempotentRequest(Base):
    __tablename__ = "idempotent_requests"
    __table_args__ = (
        Index("uq_idempotent_requests_op_key", "operation_type", "idempotency_key", unique=True),
        Index("ix_idempotent_requests_created_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    operation_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(64), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="in_progress", nullable=False)
    response_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_body: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StocktakeSession(Base):
    __tablename__ = "stocktake_sessions"
    __table_args__ = (
        Index("uq_stocktake_session_number", "session_number", unique=True),
        Index("ix_stocktake_sessions_warehouse_status", "warehouse_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_number: Mapped[str] = mapped_column(String(64), nullable=False)
    warehouse_id: Mapped[str] = mapped_column(String(36), ForeignKey("warehouses.id"), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(32), default="full_warehouse", nullable=False)  # full_warehouse, specific_items
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False, index=True)  # draft, counting, submitted, under_review, approved, posted, cancelled
    description: Mapped[str] = mapped_column(String(255), default="")
    counting_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    snapshot_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    submitted_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approval_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    posted_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancellation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    warehouse: Mapped["Warehouse"] = relationship("Warehouse")
    lines: Mapped[list["StocktakeLine"]] = relationship("StocktakeLine", back_populates="stocktake", cascade="all, delete-orphan", order_by="StocktakeLine.created_at")
    audit_logs: Mapped[list["StocktakeAuditLog"]] = relationship("StocktakeAuditLog", back_populates="stocktake", cascade="all, delete-orphan", order_by="StocktakeAuditLog.timestamp")


class StocktakeLine(Base):
    __tablename__ = "stocktake_lines"
    __table_args__ = (
        Index("uq_stocktake_lines_session_item", "stocktake_id", "item_id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    stocktake_id: Mapped[str] = mapped_column(String(36), ForeignKey("stocktake_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False, index=True)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    book_quantity: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    counted_quantity: Mapped[float | None] = mapped_column(Float, nullable=True)  # None = not counted, 0.0 = zero count!
    variance: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="uncounted", nullable=False)  # uncounted, counted, recount_required, disputed, verified
    counter_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    counted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    stocktake: Mapped["StocktakeSession"] = relationship("StocktakeSession", back_populates="lines")
    item: Mapped["CatalogItem"] = relationship("CatalogItem")
    unit: Mapped["Unit"] = relationship("Unit")
    count_history: Mapped[list["StocktakeCountHistory"]] = relationship("StocktakeCountHistory", back_populates="line", cascade="all, delete-orphan", order_by="StocktakeCountHistory.counted_at")


class StocktakeCountHistory(Base):
    __tablename__ = "stocktake_count_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    line_id: Mapped[str] = mapped_column(String(36), ForeignKey("stocktake_lines.id", ondelete="CASCADE"), nullable=False, index=True)
    stocktake_id: Mapped[str] = mapped_column(String(36), ForeignKey("stocktake_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    counted_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    previous_quantity: Mapped[float | None] = mapped_column(Float, nullable=True)
    counter_id: Mapped[str] = mapped_column(String(64), nullable=False)
    counted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    reason: Mapped[str] = mapped_column(String(255), default="initial_count")
    notes: Mapped[str] = mapped_column(Text, default="")

    line: Mapped["StocktakeLine"] = relationship("StocktakeLine", back_populates="count_history")


class StocktakeAuditLog(Base):
    __tablename__ = "stocktake_audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    stocktake_id: Mapped[str] = mapped_column(String(36), ForeignKey("stocktake_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)  # create, start_counting, record_count, submit, request_recount, approve, reject, post, cancel
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_role: Mapped[str] = mapped_column(String(64), default="")
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")

    stocktake: Mapped["StocktakeSession"] = relationship("StocktakeSession", back_populates="audit_logs")
