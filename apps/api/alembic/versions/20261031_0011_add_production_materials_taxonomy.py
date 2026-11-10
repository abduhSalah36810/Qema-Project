"""Add production materials taxonomy, categories, applications, and attributes.

Revision ID: 20261031_0011
Revises: 20261031_0010
Create Date: 2026-10-31
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "20261031_0011"
down_revision: Union[str, Sequence[str], None] = "20261031_0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Create item_categories table ──────────────────────────────────────
    op.create_table(
        "item_categories",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False, unique=True),
        sa.Column("name_ar", sa.String(128), nullable=False),
        sa.Column("name_en", sa.String(128), nullable=True),
        sa.Column(
            "parent_id",
            sa.String(36),
            sa.ForeignKey("item_categories.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # B-tree index for efficient parent-child tree navigation (code already has a unique index)
    op.create_index("ix_item_categories_parent_id", "item_categories", ["parent_id"])

    # ── 2. Create PostgreSQL trigger to prevent parent/child cycles ───────────
    op.execute(
        sa.text(
            """
        CREATE OR REPLACE FUNCTION check_category_cycle() RETURNS trigger AS $$
        DECLARE
            curr_id VARCHAR(36);
        BEGIN
            IF NEW.parent_id IS NULL THEN
                RETURN NEW;
            END IF;

            -- Direct cycle check
            IF NEW.parent_id = NEW.id THEN
                RAISE EXCEPTION 'Category cannot be its own parent: %', NEW.id;
            END IF;

            -- Indirect cycle check via ancestor traversal
            curr_id := NEW.parent_id;
            WHILE curr_id IS NOT NULL LOOP
                IF curr_id = NEW.id THEN
                    RAISE EXCEPTION 'Cyclic parent-child relationship detected for category %', NEW.id;
                END IF;
                SELECT parent_id INTO curr_id FROM item_categories WHERE id = curr_id;
            END LOOP;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """
        )
    )
    op.execute(
        sa.text(
            """
        CREATE TRIGGER trg_prevent_category_cycle
        BEFORE INSERT OR UPDATE OF parent_id ON item_categories
        FOR EACH ROW EXECUTE FUNCTION check_category_cycle();
    """
        )
    )

    # ── 3. Create application_lines table ────────────────────────────────────
    op.create_table(
        "application_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False, unique=True),
        sa.Column("name_ar", sa.String(128), nullable=False),
        sa.Column("name_en", sa.String(128), nullable=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ── 4. Create catalog_item_usages join table ──────────────────────────────
    op.create_table(
        "catalog_item_usages",
        sa.Column(
            "item_id",
            sa.String(36),
            sa.ForeignKey("catalog_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "application_id",
            sa.String(36),
            sa.ForeignKey("application_lines.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("item_id", "application_id", name="pk_catalog_item_usages"),
    )
    # Index on application_id for fast reverse lookup (items by application)
    op.create_index(
        "ix_catalog_item_usages_application_id",
        "catalog_item_usages",
        ["application_id"],
    )

    # ── 5. Add new columns to catalog_items ──────────────────────────────────
    op.add_column(
        "catalog_items",
        sa.Column(
            "category_id",
            sa.String(36),
            sa.ForeignKey("item_categories.id", ondelete="RESTRICT"),
            nullable=True,
        ),
    )
    op.create_index("ix_catalog_items_category_id", "catalog_items", ["category_id"])

    op.add_column(
        "catalog_items",
        sa.Column(
            "classification_status",
            sa.String(32),
            nullable=False,
            server_default="needs_review",
        ),
    )
    op.create_check_constraint(
        "ck_catalog_items_classification_status",
        "catalog_items",
        "classification_status in ('confirmed', 'suggested', 'needs_review', 'not_applicable')",
    )

    op.add_column(
        "catalog_items",
        sa.Column(
            "attributes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_index(
        "ix_catalog_items_attributes_gin",
        "catalog_items",
        ["attributes"],
        postgresql_using="gin",
    )

    op.add_column(
        "catalog_items",
        sa.Column(
            "reorder_level",
            sa.Numeric(12, 3),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_check_constraint(
        "ck_catalog_items_reorder_level_nonnegative",
        "catalog_items",
        "reorder_level >= 0",
    )

    # ── 6. Migrate existing finished goods items ─────────────────────────────
    # All existing 15 items in dev are finished garments and must be explicitly set to 'not_applicable'
    op.execute(
        sa.text(
            "UPDATE catalog_items SET classification_status = 'not_applicable' WHERE item_type = 'finished_garment'"
        )
    )

    # ── 7. Seed Data (Idempotent) ────────────────────────────────────────────
    _seed_reference_data()


def _seed_reference_data() -> None:
    conn = op.get_bind()

    # 1. Standard Units (preserve existing piece unit, insert missing only)
    units_to_seed = [
        ("meter", "متر طولي"),
        ("kilogram", "كيلوجرام"),
        ("gram", "جرام"),
        ("roll", "لفة / توب"),
        ("box", "علبة"),
        ("pack", "عبوة / باكت"),
        ("carton", "كرتونة"),
        ("pair", "زوج"),
    ]
    for code, name_ar in units_to_seed:
        existing = conn.execute(
            sa.text("SELECT id FROM units WHERE code = :code"), {"code": code}
        ).scalar()
        if not existing:
            conn.execute(
                sa.text(
                    "INSERT INTO units (id, code, name_ar) VALUES (:id, :code, :name_ar)"
                ),
                {"id": str(uuid.uuid4()), "code": code, "name_ar": name_ar},
            )

    # 2. Main Categories (10 categories)
    main_categories = [
        ("FABRICS_MAIN", "الأقمشة والخامات الرئيسية", "Fabrics & Main Materials", 10),
        ("GARMENT_COMPONENTS", "مكونات الملابس", "Garment Components", 20),
        ("SEWING_SUPPLIES", "خيوط ولوازم الحياكة", "Sewing Supplies", 30),
        ("INTERLINING_REINFORCEMENT", "خامات التدعيم والتقوية", "Interlining & Reinforcement", 40),
        ("TRIMS_FASTENERS", "الإكسسوارات ووسائل الإغلاق", "Trims & Fasteners", 50),
        ("CUTTING_SUPPLIES", "مستلزمات القص والفرش", "Cutting Supplies", 60),
        ("FINISHING_PRESSING", "مستلزمات التشطيب والكي", "Finishing & Pressing Supplies", 70),
        ("PACKAGING_MATERIALS", "مواد التعبئة والتغليف", "Packaging Materials", 80),
        ("TOOLS_CONSUMABLES", "الأدوات والمستهلكات العامة", "Tools & General Consumables", 90),
        ("MACHINERY_MAINTENANCE", "صيانة الماكينات وقطع الغيار", "Machinery Maintenance & Spare Parts", 100),
    ]

    cat_id_map = {}
    for code, name_ar, name_en, sort_order in main_categories:
        row = conn.execute(
            sa.text("SELECT id FROM item_categories WHERE code = :code"), {"code": code}
        ).fetchone()
        if row:
            cat_id_map[code] = row[0]
        else:
            cat_id = str(uuid.uuid4())
            conn.execute(
                sa.text(
                    """
                    INSERT INTO item_categories (id, code, name_ar, name_en, parent_id, description, is_active, sort_order)
                    VALUES (:id, :code, :name_ar, :name_en, NULL, '', TRUE, :sort_order)
                """
                ),
                {"id": cat_id, "code": code, "name_ar": name_ar, "name_en": name_en, "sort_order": sort_order},
            )
            cat_id_map[code] = cat_id

    # 3. Subcategories (36 subcategories)
    subcategories = [
        # Fabrics
        ("FAB_MAIN", "أقمشة أساسية", "Main Shell Fabrics", "FABRICS_MAIN", 1),
        ("FAB_CONTRAST", "أقمشة تطعيم وتباين", "Contrast & Trim Fabrics", "FABRICS_MAIN", 2),
        ("FAB_LINING", "بطانات الملابس والجيوب", "Linings & Pocketing", "FABRICS_MAIN", 3),
        # Components
        ("CMP_CUFFS", "أساور وكفوف", "Cuffs", "GARMENT_COMPONENTS", 1),
        ("CMP_COLLARS_MANDARIN", "أنصاف ياقات قائمة", "Mandarin & Band Collars", "GARMENT_COMPONENTS", 2),
        ("CMP_COLLARS_FULL", "ياقات كاملة مطوية", "Full & Turn-down Collars", "GARMENT_COMPONENTS", 3),
        ("CMP_POCKETS", "جيوب مجهزة", "Pockets", "GARMENT_COMPONENTS", 4),
        ("CMP_PLACKETS", "مردات وفتحات أكمام وصدر", "Plackets & Facings", "GARMENT_COMPONENTS", 5),
        # Sewing
        ("SEW_THREAD_SEWING", "خيوط حياكة عادية", "Spun Polyester Threads", "SEWING_SUPPLIES", 1),
        ("SEW_THREAD_OVERLOCK", "خيوط ماكينات أوفرلوك وسلسلة", "Overlock & Looper Threads", "SEWING_SUPPLIES", 2),
        ("SEW_THREAD_EMBROIDERY", "خيوط تطريز", "Embroidery Threads", "SEWING_SUPPLIES", 3),
        # Interlining
        ("INT_ROLLS", "أثواب ورولات حشو لاصق", "Fusible Interlining Rolls", "INTERLINING_REINFORCEMENT", 1),
        ("INT_PRECUT", "حشوات مقصوصة ومجهزة", "Pre-cut Interlinings & Plackets", "INTERLINING_REINFORCEMENT", 2),
        ("INT_STIFFENERS", "مقويات خاصة للياقات والأساور", "Collar & Cuff Stiffeners", "INTERLINING_REINFORCEMENT", 3),
        # Trims
        ("TRM_BUTTONS", "أزرار ملابس", "Buttons", "TRIMS_FASTENERS", 1),
        ("TRM_SNAPS", "كباسين ومثبتات ضغط", "Snap Fasteners", "TRIMS_FASTENERS", 2),
        ("TRM_HOOKS", "شناكل وأقفال جلابية وبنطلون", "Hooks, Eyes & Clasps", "TRIMS_FASTENERS", 3),
        ("TRM_ZIPPERS", "سوست وإغلاقات سحابية", "Zippers", "TRIMS_FASTENERS", 4),
        ("TRM_CORDS_RIBBONS", "أحزمة، شرائط، وحبال شد", "Cords & Ribbons", "TRIMS_FASTENERS", 5),
        # Cutting
        ("CUT_NUMBERING", "أشرطة وبكر ماكينات الترقيم", "Numbering Tapes & Rolls", "CUTTING_SUPPLIES", 1),
        ("CUT_PAPER", "ورق رسم الباترون وفرش القص", "Marker & Underlay Papers", "CUTTING_SUPPLIES", 2),
        ("CUT_MARKING", "طباشير وأقلام تعليم الأقمشة", "Tailor Chalks & Markers", "CUTTING_SUPPLIES", 3),
        # Finishing
        ("FIN_IRONING_COVERS", "أغطية وتلبيسات ومواد عزل الكي", "Pressing Covers & Pads", "FINISHING_PRESSING", 1),
        ("FIN_CHEMICALS", "سوائل تنظيف البقع وتثبيت المظهر", "Spot Removers & Cleaners", "FINISHING_PRESSING", 2),
        # Packaging
        ("PKG_BAGS", "أكياس التعبئة الفردية", "Poly Bags & Sleeves", "PACKAGING_MATERIALS", 1),
        ("PKG_BOXES", "علب العرض الكرتونية والفاخرة", "Presentation Boxes", "PACKAGING_MATERIALS", 2),
        ("PKG_CARTONS", "كراتين التجميع والشحن", "Shipping & Master Cartons", "PACKAGING_MATERIALS", 3),
        ("PKG_COLLAR_SUPPORTS", "دعامات وأطواق حفظ الياقات", "Collar Supports & Bands", "PACKAGING_MATERIALS", 4),
        ("PKG_LABELS_TAGS", "بطاقات الماركة وتيكت الغسيل والأسعار", "Brand Labels & Hang Tags", "PACKAGING_MATERIALS", 5),
        ("PKG_TAPES_TIES", "لواصق التعبئة وأسلاك الغلق", "Packaging Tapes & Twist Ties", "PACKAGING_MATERIALS", 6),
        # Tools
        ("TOL_CUTTING", "مقصات وقصاصات يدوية", "Manual Shears & Snips", "TOOLS_CONSUMABLES", 1),
        ("TOL_MEASURING", "أدوات القياس والرسم", "Measuring Tapes & Rulers", "TOOLS_CONSUMABLES", 2),
        ("TOL_HAND_TOOLS", "عدد يدوية ومفكات ضبط", "Hand Tools & Adjusters", "TOOLS_CONSUMABLES", 3),
        # Maintenance
        ("MNT_NEEDLES", "إبر الماكينات", "Machine Needles", "MACHINERY_MAINTENANCE", 1),
        ("MNT_HOOKS_LOOPERS", "كروشيهات ومكوكات", "Hooks, Loopers & Bobbins", "MACHINERY_MAINTENANCE", 2),
        ("MNT_KNIVES_BLADES", "سكاكين وشفرات الماكينات", "Knives & Trimming Blades", "MACHINERY_MAINTENANCE", 3),
        ("MNT_FEET_PLATES", "دواسات وبلاكات وتغذية", "Presser Feet & Throat Plates", "MACHINERY_MAINTENANCE", 4),
        ("MNT_LUBRICANTS", "زيوت وشحوم الماكينات", "Machine Oils & Lubricants", "MACHINERY_MAINTENANCE", 5),
        ("MNT_PARTS_ELECTRICAL", "مواتير وسيور وقطع كهربائية", "Motors, Belts & Electronics", "MACHINERY_MAINTENANCE", 6),
    ]

    for code, name_ar, name_en, parent_code, sort_order in subcategories:
        existing = conn.execute(
            sa.text("SELECT id FROM item_categories WHERE code = :code"), {"code": code}
        ).fetchone()
        if not existing:
            parent_id = cat_id_map.get(parent_code)
            conn.execute(
                sa.text(
                    """
                    INSERT INTO item_categories (id, code, name_ar, name_en, parent_id, description, is_active, sort_order)
                    VALUES (:id, :code, :name_ar, :name_en, :parent_id, '', TRUE, :sort_order)
                """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "code": code,
                    "name_ar": name_ar,
                    "name_en": name_en,
                    "parent_id": parent_id,
                    "sort_order": sort_order,
                },
            )

    # 4. Application Lines (6 lines)
    app_lines = [
        ("GENERAL", "عام لجميع الملابس", "General Clothing", 1),
        ("JALABIYA", "جلابية رجالي", "Men's Jalabiya", 2),
        ("MOROCCAN_JALABIYA", "جلابية مغربي", "Moroccan Jalabiya", 3),
        ("SHERWAL", "شروال وبنطلون", "Sherwal & Trousers", 4),
        ("THOBE_ARABI", "ثوب عربي / خليجي", "Arab / Gulf Thobe", 5),
        ("BOYS_CLOTHING", "ملابس أولادي وأطفال", "Boys' & Kids' Clothing", 6),
    ]
    for code, name_ar, name_en, sort_order in app_lines:
        existing = conn.execute(
            sa.text("SELECT id FROM application_lines WHERE code = :code"), {"code": code}
        ).fetchone()
        if not existing:
            conn.execute(
                sa.text(
                    """
                    INSERT INTO application_lines (id, code, name_ar, name_en, description, is_active, sort_order)
                    VALUES (:id, :code, :name_ar, :name_en, '', TRUE, :sort_order)
                """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "code": code,
                    "name_ar": name_ar,
                    "name_en": name_en,
                    "sort_order": sort_order,
                },
            )


def downgrade() -> None:
    # ── Safety Check against silent loss of operational taxonomy data ─────────
    conn = op.get_bind()
    active_tax_count = conn.execute(
        sa.text(
            """
            SELECT count(*) FROM catalog_items 
            WHERE category_id IS NOT NULL 
               OR classification_status NOT IN ('needs_review', 'not_applicable')
        """
        )
    ).scalar()
    if active_tax_count and active_tax_count > 0:
        raise RuntimeError(
            f"Downgrade blocked: {active_tax_count} catalog item(s) have assigned categories or confirmed/suggested taxonomy classifications. "
            "Reversing Migration 0011 would permanently destroy operational raw materials classifications. "
            "Unassign or backup taxonomy data before downgrading."
        )

    # ── 1. Drop catalog_items columns, indexes, and constraints ───────────────
    op.drop_index("ix_catalog_items_attributes_gin", table_name="catalog_items")
    op.drop_column("catalog_items", "attributes")

    op.drop_constraint("ck_catalog_items_reorder_level_nonnegative", "catalog_items", type_="check")
    op.drop_column("catalog_items", "reorder_level")

    op.drop_constraint("ck_catalog_items_classification_status", "catalog_items", type_="check")
    op.drop_column("catalog_items", "classification_status")

    op.drop_index("ix_catalog_items_category_id", table_name="catalog_items")
    op.drop_constraint("fk_catalog_items_category_id", "catalog_items", type_="foreignkey")
    op.drop_column("catalog_items", "category_id")

    # ── 2. Drop catalog_item_usages ───────────────────────────────────────────
    op.drop_index("ix_catalog_item_usages_application_id", table_name="catalog_item_usages")
    op.drop_table("catalog_item_usages")

    # ── 3. Drop application_lines ─────────────────────────────────────────────
    op.drop_table("application_lines")

    # ── 4. Drop trigger and function for category cycles ─────────────────────
    op.execute("DROP TRIGGER IF EXISTS trg_prevent_category_cycle ON item_categories;")
    op.execute("DROP FUNCTION IF EXISTS check_category_cycle();")

    # ── 5. Drop item_categories ───────────────────────────────────────────────
    op.drop_index("ix_item_categories_parent_id", table_name="item_categories")
    op.drop_table("item_categories")
