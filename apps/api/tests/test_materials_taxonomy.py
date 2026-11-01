"""Test suite for Phase 3.1 Materials Taxonomy, Categories, Applications & DB Integrity.

Covers:
1. Preservation of existing finished goods (all 15 have classification_status='not_applicable', category_id=None).
2. New finished goods creation explicitly gets classification_status='not_applicable' and category_id=None.
3. Unit seed idempotency and preservation of 'piece' unit ID.
4. Category hierarchy and FK restrictions (ON DELETE RESTRICT on categories with items or children).
5. Prevention of parent/child cycles in categories (direct and indirect).
6. Application usage uniqueness (compound PK) and deletion restrictions (RESTRICT).
7. JSONB attributes storage, retrieval, and containment queries.
8. Non-negative reorder_level check constraint (reorder_level >= 0).
"""
import os
import uuid
from decimal import Decimal
import pytest
from sqlalchemy import text, select, func
from sqlalchemy.exc import IntegrityError, DBAPIError
from sqlalchemy.pool import NullPool
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

import app.db.base  # noqa: F401 - ensures all ORM mappers and relationships are registered

from app.modules.production.models import (
    CatalogItem,
    ItemCategory,
    ApplicationLine,
    CatalogItemUsage,
    Unit,
    Product,
    ProductVariant,
)
from app.modules.production.service import get_or_create_finished_goods_item


@pytest.mark.asyncio
async def test_existing_finished_goods_preserved_as_not_applicable(session: AsyncSession):
    """Verify that all existing finished goods catalog items have classification_status='not_applicable' and category_id=None."""
    items = (await session.scalars(
        select(CatalogItem).where(CatalogItem.item_type == "finished_garment")
    )).all()

    assert len(items) == 15, f"Expected 15 finished goods items, found {len(items)}"
    for item in items:
        assert item.classification_status == "not_applicable", (
            f"Item {item.code} has unexpected status: {item.classification_status}"
        )
        assert item.category_id is None, f"Item {item.code} has unexpected category_id: {item.category_id}"
        assert item.code.startswith("FG-VAR-"), f"Item {item.code} does not match FG-VAR-* pattern"


@pytest.mark.asyncio
async def test_get_or_create_finished_goods_item_sets_not_applicable(session: AsyncSession):
    """Verify that get_or_create_finished_goods_item explicitly creates items with not_applicable and category_id=None."""
    # Create a test product and variant
    prod_id = str(uuid.uuid4())
    var_id = str(uuid.uuid4())
    prod = Product(
        id=prod_id,
        code=f"PRD-TEST-{uuid.uuid4().hex[:6]}",
        name_ar="جلابية اختبارية للمنتج التام",
        style_type="half_collar_cuff",
    )
    session.add(prod)
    await session.flush()

    variant = ProductVariant(
        id=var_id,
        product_id=prod.id,
        numeric_size=58,
        letter_size="L",
        season="summer",
        sku=f"SKU-TEST-{uuid.uuid4().hex[:6]}",
    )
    session.add(variant)
    await session.flush()

    fg_item = await get_or_create_finished_goods_item(session, prod.id, variant.id)
    assert fg_item.code == f"FG-VAR-{variant.id}"
    assert fg_item.classification_status == "not_applicable"
    assert fg_item.category_id is None
    assert fg_item.item_type == "finished_garment"
    assert fg_item.is_consumable is False

    await session.rollback()


@pytest.mark.asyncio
async def test_unit_seed_idempotency_and_piece_preservation(session: AsyncSession):
    """Verify that the standard unit seeds are present and 'piece' unit is preserved with its exact code."""
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    assert piece_unit is not None
    assert piece_unit.name_ar == "قطعة"

    # Check seeded units exist
    seeded_codes = ["meter", "kilogram", "gram", "roll", "box", "pack", "carton", "pair"]
    for code in seeded_codes:
        u = (await session.scalars(select(Unit).where(Unit.code == code))).first()
        assert u is not None, f"Unit '{code}' was not found in units table"

    # Test idempotency: re-inserting existing units with ON CONFLICT DO NOTHING must not fail
    for code in seeded_codes:
        await session.execute(
            text("""
                INSERT INTO units (id, code, name_ar)
                VALUES (:id, :code, :name_ar)
                ON CONFLICT (code) DO NOTHING
            """),
            {"id": str(uuid.uuid4()), "code": code, "name_ar": "تجربة"}
        )
    await session.commit()


@pytest.mark.asyncio
async def test_category_fk_restrictions_prevent_deleting_used_category(session: AsyncSession):
    """Verify that ON DELETE RESTRICT prevents deleting a category when catalog items reference it."""
    # Create a test category
    cat_id = str(uuid.uuid4())
    cat = ItemCategory(
        id=cat_id,
        code=f"CAT_TEST_{uuid.uuid4().hex[:6]}",
        name_ar="فئة تجريبية للاختبار",
    )
    session.add(cat)
    await session.flush()

    # Get existing piece unit
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()

    # Create an item referencing this category
    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"RAW-TEST-{uuid.uuid4().hex[:6]}",
        name_ar="خامة تجريبية مرتبطة بالفئة",
        item_type="raw_material",
        unit_id=piece_unit.id,
        category_id=cat.id,
        classification_status="needs_review",
        attributes={"color": "blue"},
        reorder_level=Decimal("10.0"),
    )
    session.add(item)
    await session.flush()

    # Attempt to delete the category directly via SQL
    with pytest.raises((IntegrityError, DBAPIError)):
        await session.execute(text("DELETE FROM item_categories WHERE id = :id"), {"id": cat.id})
        await session.flush()

    await session.rollback()


@pytest.mark.asyncio
async def test_category_fk_restrictions_prevent_deleting_parent_with_children(session: AsyncSession):
    """Verify that ON DELETE RESTRICT prevents deleting a parent category when child categories exist."""
    parent_id = str(uuid.uuid4())
    child_id = str(uuid.uuid4())

    parent = ItemCategory(
        id=parent_id,
        code=f"PAR_TEST_{uuid.uuid4().hex[:6]}",
        name_ar="فئة أب للاختبار",
    )
    session.add(parent)
    await session.flush()

    child = ItemCategory(
        id=child_id,
        code=f"CHD_TEST_{uuid.uuid4().hex[:6]}",
        name_ar="فئة ابن للاختبار",
        parent_id=parent.id,
    )
    session.add(child)
    await session.flush()

    # Attempt to delete parent
    with pytest.raises((IntegrityError, DBAPIError)):
        await session.execute(text("DELETE FROM item_categories WHERE id = :id"), {"id": parent.id})
        await session.flush()

    await session.rollback()


@pytest.mark.asyncio
async def test_category_cycle_prevention_direct_cycle(session: AsyncSession):
    """Verify that a category cannot be its own parent (direct cycle)."""
    cat_id = str(uuid.uuid4())
    cat = ItemCategory(
        id=cat_id,
        code=f"CYC_TEST_{uuid.uuid4().hex[:6]}",
        name_ar="فئة اختبار الدورة المباشرة",
    )
    session.add(cat)
    await session.flush()

    # Attempt direct cycle: set parent_id = id
    with pytest.raises((IntegrityError, DBAPIError)) as exc_info:
        await session.execute(
            text("UPDATE item_categories SET parent_id = :id WHERE id = :id"),
            {"id": cat.id}
        )
        await session.flush()

    assert "Category cannot be its own parent" in str(exc_info.value)
    await session.rollback()


@pytest.mark.asyncio
async def test_category_cycle_prevention_indirect_cycle(session: AsyncSession):
    """Verify that an indirect ancestor-descendant cycle (A -> B -> C -> A) is rejected by trigger."""
    id_a = str(uuid.uuid4())
    id_b = str(uuid.uuid4())
    id_c = str(uuid.uuid4())

    # A (root)
    cat_a = ItemCategory(id=id_a, code=f"CYC_A_{uuid.uuid4().hex[:4]}", name_ar="فئة أ")
    session.add(cat_a)
    await session.flush()

    # B (child of A)
    cat_b = ItemCategory(id=id_b, code=f"CYC_B_{uuid.uuid4().hex[:4]}", name_ar="فئة ب", parent_id=id_a)
    session.add(cat_b)
    await session.flush()

    # C (child of B)
    cat_c = ItemCategory(id=id_c, code=f"CYC_C_{uuid.uuid4().hex[:4]}", name_ar="فئة ج", parent_id=id_b)
    session.add(cat_c)
    await session.flush()

    # Now attempt indirect cycle: set A's parent to C!
    with pytest.raises((IntegrityError, DBAPIError)) as exc_info:
        await session.execute(
            text("UPDATE item_categories SET parent_id = :parent_id WHERE id = :id"),
            {"id": id_a, "parent_id": id_c}
        )
        await session.flush()

    assert "Cyclic parent-child relationship detected" in str(exc_info.value)
    await session.rollback()


@pytest.mark.asyncio
async def test_application_usage_uniqueness_and_deletion_restriction(session: AsyncSession):
    """Verify that duplicate application usage tags are rejected and application lines with tags cannot be deleted."""
    # Get piece unit
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    piece_unit_id = piece_unit.id

    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"ITM-APP-{uuid.uuid4().hex[:6]}",
        name_ar="صنف لاختبار التطبيقات",
        item_type="raw_material",
        unit_id=piece_unit_id,
        classification_status="needs_review",
    )
    session.add(item)

    app_line = ApplicationLine(
        id=str(uuid.uuid4()),
        code=f"APP_TEST_{uuid.uuid4().hex[:6]}",
        name_ar="تطبيق اختباري",
    )
    session.add(app_line)
    await session.flush()

    usage = CatalogItemUsage(item_id=item.id, application_id=app_line.id)
    session.add(usage)
    await session.flush()

    # Duplicate insert must fail with compound PK violation
    with pytest.raises((IntegrityError, DBAPIError)):
        await session.execute(
            text("INSERT INTO catalog_item_usages (item_id, application_id) VALUES (:item_id, :app_id)"),
            {"item_id": item.id, "app_id": app_line.id}
        )
        await session.flush()

    await session.rollback()

    # Now test that deleting an application line referenced by usage is restricted (ON DELETE RESTRICT)
    item2 = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"ITM-APP2-{uuid.uuid4().hex[:6]}",
        name_ar="صنف لاختبار الحذف",
        item_type="raw_material",
        unit_id=piece_unit_id,
        classification_status="needs_review",
    )
    app_line2 = ApplicationLine(
        id=str(uuid.uuid4()),
        code=f"APP_TEST2_{uuid.uuid4().hex[:6]}",
        name_ar="تطبيق اختباري 2",
    )
    session.add(item2)
    session.add(app_line2)
    await session.flush()
    usage2 = CatalogItemUsage(item_id=item2.id, application_id=app_line2.id)
    session.add(usage2)
    await session.flush()

    with pytest.raises((IntegrityError, DBAPIError)):
        await session.execute(text("DELETE FROM application_lines WHERE id = :id"), {"id": app_line2.id})
        await session.flush()

    await session.rollback()


@pytest.mark.asyncio
async def test_jsonb_attributes_storage_and_gin_containment_query(session: AsyncSession):
    """Verify that JSONB attributes are stored accurately and can be queried using containment @>."""
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    unique_mark = uuid.uuid4().hex[:8]

    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"JSONB-{unique_mark}",
        name_ar="صنف مواصفات JSONB",
        item_type="raw_material",
        unit_id=piece_unit.id,
        classification_status="confirmed",
        attributes={
            "composition": "100% قطن مصري",
            "width_cm": 150.0,
            "weight_gsm": 220.0,
            "batch_mark": unique_mark,
            "compatible_machines": ["Juki DDL-8700", "Siruba 747K"],
        },
        reorder_level=Decimal("25.500"),
    )
    session.add(item)
    await session.commit()

    # Query using JSONB containment @> operator with explicit jsonb cast
    queried = (await session.scalars(
        select(CatalogItem).where(
            text("attributes @> CAST(:criteria AS jsonb)").bindparams(criteria=f'{{"batch_mark": "{unique_mark}"}}')
        )
    )).first()

    assert queried is not None
    assert queried.attributes["width_cm"] == 150.0
    assert queried.attributes["weight_gsm"] == 220.0
    assert "Juki DDL-8700" in queried.attributes["compatible_machines"]
    assert queried.reorder_level == Decimal("25.500")

    # Cleanup
    await session.delete(queried)
    await session.commit()


@pytest.mark.asyncio
async def test_reorder_level_non_negative_check_constraint(session: AsyncSession):
    """Verify that negative reorder_level is rejected by CheckConstraint."""
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()

    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"NEG-REORDER-{uuid.uuid4().hex[:6]}",
        name_ar="صنف رصيد سالب غير مسموح",
        item_type="raw_material",
        unit_id=piece_unit.id,
        reorder_level=Decimal("-5.000"),
    )
    session.add(item)

    with pytest.raises((IntegrityError, DBAPIError)):
        await session.flush()

    await session.rollback()
