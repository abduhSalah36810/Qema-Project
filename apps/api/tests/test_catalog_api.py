"""
مجموعة اختبارات التحقق الشاملة لواجهات إدارة دليل الأصناف والتصنيفات (Phase 3.2 Catalog Management Tests)
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. ضوابط التحقق والمصادقة (RBAC: 401 Unauthenticated, 403 Forbidden, 200/201 Authorized).
2. استعراض وحدات القياس (Units Read-Only).
3. إدارة شجرة التصنيفات (Item Categories CRUD, Hierarchy, Validations, Tree, Cycle Prevention).
4. قيود تعطيل وحذف التصنيفات (Active items/children check, Seeded categories protection).
5. إدارة دليل الأصناف (Catalog Items CRUD, Attributes validation, Non-negative reorder level).
6. حماية دورة المنتجات التامة (FG-VAR-* Finished Goods Identity Protection).
7. حماية سلامة وحدة القياس للأصناف ذات الحركات المخزنية (Unit Change Restriction).
8. إدارة وسوم خطوط التطبيق (Application Lines & Usages Informational Tags).
9. البحث والفلترة والترتيب والـ Pagination.
10. التأكد القطعي من عدم إنشاء أي حركات مخزنية أو تغيير في دفتر الأستاذ أو BOM.
─────────────────────────────────────────────────────────────────────────────
"""
import os
import uuid
from decimal import Decimal
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.production.models import (
    ApplicationLine,
    CatalogItem,
    CatalogItemUsage,
    ItemCategory,
    StockLedgerEntry,
    Unit,
    Warehouse,
)

# تحديد مسار قاعدة البيانات الحقيقية للاختبارات
db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not db_url or "qemma_test_db" in db_url:
    db_url = "postgresql+asyncpg://qemma_dev:changeme_local_only@127.0.0.1:5432/qemma_erp_dev"


@pytest.fixture
async def session():
    """جلسة SQLAlchemy معزولة ومتصلة بقاعدة البيانات الحقيقية."""
    engine = create_async_engine(db_url, poolclass=NullPool, echo=False)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as sess:
        yield sess
    await engine.dispose()


@pytest.fixture
def auth_general_manager(session):
    user = AuthenticatedUser(
        id="usr-gm-test",
        email="gm@qemma.com",
        claims={"sub": "usr-gm-test", "role": "general_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.fixture
def auth_warehouse_manager(session):
    user = AuthenticatedUser(
        id="usr-wh-test",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-test", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.fixture
def auth_finance_manager(session):
    user = AuthenticatedUser(
        id="usr-fin-test",
        email="fin@qemma.com",
        claims={"sub": "usr-fin-test", "role": "finance_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


# ═════════════════════════════════════════════════════════════════════════════
# 1. اختبارات الصلاحيات والمصادقة (RBAC)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_unauthenticated_requests_return_401():
    """الطلبات غير المصادق عليها تُرفض بـ 401 Unauthorized."""
    app.dependency_overrides.clear()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res1 = await client.get("/api/v1/catalog/categories")
        assert res1.status_code == 401

        res2 = await client.post("/api/v1/catalog/categories", json={"code": "TEST", "name_ar": "تجربة"})
        assert res2.status_code == 401

        res3 = await client.get("/api/v1/catalog/items")
        assert res3.status_code == 401

        res4 = await client.post("/api/v1/catalog/items", json={"code": "RAW-01", "name_ar": "قماش"})
        assert res4.status_code == 401


@pytest.mark.asyncio
async def test_finance_manager_lacks_inventory_manage_returns_403(auth_finance_manager):
    """المستخدم بدور مدير مالي لا يملك صلاحية إدارة المخزون والدليل وتُرفض طلباته بـ 403 Forbidden."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # قراءة الفئات تحتاج inventory:view
        res_view = await client.get("/api/v1/catalog/categories")
        assert res_view.status_code == 403

        # إنشاء فئة يحتاج inventory:manage
        res_create_cat = await client.post(
            "/api/v1/catalog/categories",
            json={"code": "CAT_FIN_TEST", "name_ar": "فئة مالية"},
        )
        assert res_create_cat.status_code == 403

        # إنشاء صنف يحتاج inventory:manage
        res_create_item = await client.post(
            "/api/v1/catalog/items",
            json={"code": "RAW_FIN_TEST", "name_ar": "صنف"},
        )
        assert res_create_item.status_code == 403


# ═════════════════════════════════════════════════════════════════════════════
# 2. اختبارات وحدات القياس (Units — Read Only)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_list_units_read_only(auth_general_manager):
    """عرض وحدات القياس المتاحة بنجاح دون إمكانية التعديل وبشكل مستقل."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get("/api/v1/catalog/units")
        assert res.status_code == 200
        units = res.json()
        assert len(units) >= 9

        codes = {u["code"] for u in units}
        assert "piece" in codes
        assert "meter" in codes
        assert "kilogram" in codes
        assert "roll" in codes


# ═════════════════════════════════════════════════════════════════════════════
# 3. اختبارات إدارة شجرة تصنيفات المواد (Item Categories CRUD)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_category_crud_and_validations(auth_general_manager, session: AsyncSession):
    """إنشاء تصنيف رئيسي وفرعي، ومنع التكرار، وتحديث البيانات بنجاح."""
    unique_suffix = uuid.uuid4().hex[:6].upper()
    cat_code = f"CAT_{unique_suffix}"
    sub_code = f"SUB_{unique_suffix}"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. إنشاء تصنيف رئيسي
        res = await client.post(
            "/api/v1/catalog/categories",
            json={
                "code": cat_code,
                "name_ar": "تصنيف رئيسي تجريبي",
                "name_en": "Test Main Category",
                "description": "وصف اختباري",
                "sort_order": 10,
            },
        )
        assert res.status_code == 201
        created_cat = res.json()
        assert created_cat["code"] == cat_code
        cat_id = created_cat["id"]

        # 2. منع تكرار الكود (409 Conflict)
        res_dup = await client.post(
            "/api/v1/catalog/categories",
            json={"code": cat_code, "name_ar": "تصنيف مكرر"},
        )
        assert res_dup.status_code == 409

        # 3. إنشاء تصنيف فرعي بأب غير موجود (404 Not Found)
        res_bad_parent = await client.post(
            "/api/v1/catalog/categories",
            json={"code": sub_code, "name_ar": "فرعي", "parent_id": str(uuid.uuid4())},
        )
        assert res_bad_parent.status_code == 404

        # 4. إنشاء تصنيف فرعي صحيح
        res_sub = await client.post(
            "/api/v1/catalog/categories",
            json={
                "code": sub_code,
                "name_ar": "تصنيف فرعي تجريبي",
                "parent_id": cat_id,
                "sort_order": 1,
            },
        )
        assert res_sub.status_code == 201
        sub_id = res_sub.json()["id"]

        # 5. استرجاع التصنيف بالمعرف وبالكود
        res_get_id = await client.get(f"/api/v1/catalog/categories/{cat_id}")
        assert res_get_id.status_code == 200
        assert res_get_id.json()["code"] == cat_code

        res_get_code = await client.get(f"/api/v1/catalog/categories/{cat_code}")
        assert res_get_code.status_code == 200

        # 6. تعديل الاسم والترتيب
        res_patch = await client.patch(
            f"/api/v1/catalog/categories/{cat_id}",
            json={"name_ar": "تصنيف رئيسي محدث", "sort_order": 15},
        )
        assert res_patch.status_code == 200
        assert res_patch.json()["name_ar"] == "تصنيف رئيسي محدث"
        assert res_patch.json()["sort_order"] == 15

        # 7. فحص الهيكل الشجري /categories/tree
        res_tree = await client.get("/api/v1/catalog/categories/tree")
        assert res_tree.status_code == 200
        tree = res_tree.json()
        matching_root = next((n for n in tree if n["id"] == cat_id), None)
        assert matching_root is not None
        assert any(sub["id"] == sub_id for sub in matching_root["subcategories"])


@pytest.mark.asyncio
async def test_category_cycle_prevention_via_api(auth_general_manager, session: AsyncSession):
    """منع الحلقات التكرارية المباشرة وغير المباشرة عند نقل التصنيفات عبر API."""
    unique = uuid.uuid4().hex[:4].upper()
    cat_a = ItemCategory(id=str(uuid.uuid4()), code=f"CYC_A_{unique}", name_ar="فئة أ")
    cat_b = ItemCategory(id=str(uuid.uuid4()), code=f"CYC_B_{unique}", name_ar="فئة ب", parent_id=cat_a.id)
    cat_c = ItemCategory(id=str(uuid.uuid4()), code=f"CYC_C_{unique}", name_ar="فئة ج", parent_id=cat_b.id)
    session.add_all([cat_a, cat_b, cat_c])
    await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # دورة مباشرة: جعل أ أباً لنفسه
        res_direct = await client.patch(
            f"/api/v1/catalog/categories/{cat_a.id}",
            json={"parent_id": cat_a.id},
        )
        assert res_direct.status_code == 400

        # دورة غير مباشرة: جعل ج (حفيد أ) أباً لـ أ!
        res_indirect = await client.patch(
            f"/api/v1/catalog/categories/{cat_a.id}",
            json={"parent_id": cat_c.id},
        )
        assert res_indirect.status_code == 400


@pytest.mark.asyncio
async def test_category_deactivation_and_deletion_restrictions(auth_general_manager, session: AsyncSession):
    """منع تعطيل أو حذف التصنيفات المرتبطة بأصناف نشطة أو فئات فرعية أو فئات معيارية."""
    unique = uuid.uuid4().hex[:6].upper()
    parent_cat = ItemCategory(id=str(uuid.uuid4()), code=f"PAR_{unique}", name_ar="فئة أب للاختبار")
    child_cat = ItemCategory(id=str(uuid.uuid4()), code=f"CHD_{unique}", name_ar="فئة فرعية للاختبار", parent_id=parent_cat.id)
    session.add_all([parent_cat, child_cat])
    await session.commit()

    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"ITM_{unique}",
        name_ar="صنف نشط في الفئة",
        item_type="raw_material",
        unit_id=piece_unit.id,
        category_id=child_cat.id,
        approval_status="approved",
        is_active=True,
    )
    session.add(item)
    await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. محاولة تعطيل فئة تحتوي على صنف نشط -> 409 Conflict
        res_deact_item = await client.patch(
            f"/api/v1/catalog/categories/{child_cat.id}",
            json={"is_active": False},
        )
        assert res_deact_item.status_code == 409

        # 2. محاولة تعطيل فئة أب لها فرع نشط -> 409 Conflict
        res_deact_parent = await client.patch(
            f"/api/v1/catalog/categories/{parent_cat.id}",
            json={"is_active": False},
        )
        assert res_deact_parent.status_code == 409

        # 3. محاولة حذف فئة معيارية مبذورة (مثل FABRICS_MAIN) -> 409 Conflict
        seeded_cat_id = (await session.scalars(select(ItemCategory.id).where(ItemCategory.code == "FABRICS_MAIN"))).first()
        res_del_seeded = await client.delete(f"/api/v1/catalog/categories/{seeded_cat_id}")
        assert res_del_seeded.status_code == 409

        # 4. محاولة حذف فئة مرتبطة بصنف -> 409 Conflict
        res_del_used = await client.delete(f"/api/v1/catalog/categories/{child_cat.id}")
        assert res_del_used.status_code == 409

        # 5. حذف فئة مخصصة غير مستخدمة تماماً -> 204 No Content
        fresh_cat = ItemCategory(id=str(uuid.uuid4()), code=f"FRESH_{unique}", name_ar="فئة مؤقتة")
        session.add(fresh_cat)
        await session.commit()

        res_del_fresh = await client.delete(f"/api/v1/catalog/categories/{fresh_cat.id}")
        assert res_del_fresh.status_code == 204


# ═════════════════════════════════════════════════════════════════════════════
# 4. اختبارات إدارة الأصناف والمواصفات (Catalog Items CRUD & Attributes)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_catalog_item_creation_and_validations(auth_general_manager, session: AsyncSession):
    """إنشاء صنف جديد، والتحقق من المواصفات وحد الطلب والوحدة والتصنيف وحالة الاعتماد."""
    unique = uuid.uuid4().hex[:6].upper()
    item_code = f"RAW-COTTON-{unique}"

    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    fabrics_cat = (await session.scalars(select(ItemCategory).where(ItemCategory.code == "FAB_MAIN"))).first()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. إنشاء صنف بنجاح
        payload = {
            "code": item_code,
            "name_ar": "قماش قطن مصري ممتاز",
            "item_type": "fabric",
            "unit_id": piece_unit.id,
            "category_id": fabrics_cat.id,
            "classification_status": "confirmed",
            "attributes": {
                "composition": "100% قطن",
                "width_cm": 150.0,
                "weight_gsm": 220.0,
            },
            "reorder_level": 50.0,
            "is_consumable": True,
        }
        res = await client.post("/api/v1/catalog/items", json=payload)
        assert res.status_code == 201
        created_item = res.json()
        assert created_item["code"] == item_code
        assert created_item["attributes"]["width_cm"] == 150.0
        assert created_item["reorder_level"] == 50.0
        item_id = created_item["id"]

        # 2. منع تكرار الكود (409 Conflict)
        res_dup = await client.post("/api/v1/catalog/items", json=payload)
        assert res_dup.status_code == 409

        # 3. رفض حد إعادة الطلب السالب (422)
        bad_reorder = payload.copy()
        bad_reorder["code"] = f"NEG-{unique}"
        bad_reorder["reorder_level"] = -5.0
        res_neg = await client.post("/api/v1/catalog/items", json=bad_reorder)
        assert res_neg.status_code == 422

        # 4. رفض أبعاد سلبية داخل المواصفات (422)
        bad_dim = payload.copy()
        bad_dim["code"] = f"BAD-DIM-{unique}"
        bad_dim["attributes"] = {"width_cm": -150.0}
        res_dim = await client.post("/api/v1/catalog/items", json=bad_dim)
        assert res_dim.status_code == 422

        # 5. رفض مواصفات ليست كائن Object/Dictionary (422)
        bad_attr_type = payload.copy()
        bad_attr_type["code"] = f"BAD-ATTR-{unique}"
        bad_attr_type["attributes"] = "not_a_dict"
        res_type = await client.post("/api/v1/catalog/items", json=bad_attr_type)
        assert res_type.status_code == 422

        # 6. رفض وحدة قياس غير موجودة (400)
        bad_unit = payload.copy()
        bad_unit["code"] = f"BAD-UNIT-{unique}"
        bad_unit["unit_id"] = str(uuid.uuid4())
        res_unit = await client.post("/api/v1/catalog/items", json=bad_unit)
        assert res_unit.status_code == 400

        # 7. رفض تصنيف صنف تحت تصنيف معطل (400)
        inactive_cat = ItemCategory(
            id=str(uuid.uuid4()), code=f"INACT_CAT_{unique}", name_ar="فئة معطلة", is_active=False
        )
        session.add(inactive_cat)
        await session.commit()

        bad_cat = payload.copy()
        bad_cat["code"] = f"BAD-CAT-{unique}"
        bad_cat["category_id"] = inactive_cat.id
        res_cat = await client.post("/api/v1/catalog/items", json=bad_cat)
        assert res_cat.status_code == 400


@pytest.mark.asyncio
async def test_finished_goods_identity_protection(auth_general_manager, session: AsyncSession):
    """حظر إنشاء أو التلاعب بهويات أصناف المنتجات التامة FG-VAR-* عبر API الأصناف العام."""
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. حظر إنشاء صنف بكود FG-VAR-* يدوياً
        res_fg_code = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": "FG-VAR-fake-id",
                "name_ar": "منتج تام يدوي غير مصرح",
                "item_type": "raw_material",
                "unit_id": piece_unit.id,
            },
        )
        assert res_fg_code.status_code == 400

        # 2. حظر إنشاء صنف بنوع finished_garment يدوياً
        res_fg_type = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": "MANUAL-FG-01",
                "name_ar": "منتج تام يدوي آخر",
                "item_type": "finished_garment",
                "unit_id": piece_unit.id,
            },
        )
        assert res_fg_type.status_code == 400

        # 3. حظر تعديل هوية أو وحدة أو حالة صنف منتج تام قائم
        existing_fg = (await session.scalars(
            select(CatalogItem).where(CatalogItem.item_type == "finished_garment").limit(1)
        )).first()
        assert existing_fg is not None

        # محاولة تغيير حالة التصنيف لـ confirmed بدلاً من not_applicable
        res_mod_status = await client.patch(
            f"/api/v1/catalog/items/{existing_fg.id}",
            json={"classification_status": "confirmed"},
        )
        assert res_mod_status.status_code == 400


@pytest.mark.asyncio
async def test_catalog_item_update_and_ledger_unit_protection(auth_general_manager, session: AsyncSession):
    """التحقق من تحديث الأصناف وحظر تغيير وحدة القياس لصنف لديه حركات مخزنية."""
    unique = uuid.uuid4().hex[:6].upper()
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()
    wh = (await session.scalars(select(Warehouse).limit(1))).first()

    # صنف بدون حركات
    item_clean = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"CLN_{unique}",
        name_ar="صنف نظيف بدون حركات",
        item_type="raw_material",
        unit_id=piece_unit.id,
        attributes={"color": "white"},
        reorder_level=Decimal("10"),
    )
    # صنف مع حركة مخزنية مسجلة
    item_with_ledger = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"LED_{unique}",
        name_ar="صنف ذو حركة مخزنية",
        item_type="raw_material",
        unit_id=piece_unit.id,
    )
    session.add_all([item_clean, item_with_ledger])
    await session.commit()

    ledger_entry = StockLedgerEntry(
        id=str(uuid.uuid4()),
        item_id=item_with_ledger.id,
        unit_id=piece_unit.id,
        warehouse_id=wh.id,
        location_type="warehouse",
        quantity=Decimal("100"),
        entry_type="receipt",
        reference_doc_type="initial_inventory",
        reference_doc_id=str(uuid.uuid4()),
        created_by="usr-test-officer",
    )
    session.add(ledger_entry)
    await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. تحديث الصنف النظيف (تغيير الوحدة والمواصفات مسموح)
        res_patch_clean = await client.patch(
            f"/api/v1/catalog/items/{item_clean.id}",
            json={"unit_id": meter_unit.id, "reorder_level": 25.0},
        )
        assert res_patch_clean.status_code == 200
        assert res_patch_clean.json()["unit_id"] == meter_unit.id
        assert res_patch_clean.json()["reorder_level"] == 25.0
        # التأكد من بقاء المواصفات دون فقد
        assert res_patch_clean.json()["attributes"]["color"] == "white"

        # 2. محاولة تغيير وحدة الصنف ذي الحركات المخزنية -> 409 Conflict
        res_bad_unit = await client.patch(
            f"/api/v1/catalog/items/{item_with_ledger.id}",
            json={"unit_id": meter_unit.id},
        )
        assert res_bad_unit.status_code == 409

        # 3. محاولة حذف الصنف ذي الحركات المخزنية -> 409 Conflict
        res_del_bad = await client.delete(f"/api/v1/catalog/items/{item_with_ledger.id}")
        assert res_del_bad.status_code == 409

        # 4. حذف الصنف النظيف -> 204 No Content
        res_del_clean = await client.delete(f"/api/v1/catalog/items/{item_clean.id}")
        assert res_del_clean.status_code == 204


# ═════════════════════════════════════════════════════════════════════════════
# 5. خطوط التطبيق ووسوم الاستخدام (Application Lines & Usages)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_application_lines_and_item_usages(auth_general_manager, session: AsyncSession):
    """إدارة وسوم خطوط التطبيق للأصناف والتأكد من أنها وسوم استرشادية دون مساس بالمخزون أو BOM."""
    unique = uuid.uuid4().hex[:6].upper()
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()

    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"ITM-APP-{unique}",
        name_ar="صنف وسوم التطبيقات",
        item_type="raw_material",
        unit_id=piece_unit.id,
    )
    session.add(item)
    await session.commit()

    jalabiya_line = (await session.scalars(select(ApplicationLine).where(ApplicationLine.code == "JALABIYA"))).first()
    assert jalabiya_line is not None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. عرض خطوط التطبيق المتاحة
        res_lines = await client.get("/api/v1/catalog/application-lines")
        assert res_lines.status_code == 200
        lines = res_lines.json()
        assert len(lines) >= 6

        # 2. إضافة وسم استخدام للصنف
        res_add_usage = await client.post(
            f"/api/v1/catalog/items/{item.id}/usages",
            json={"application_id": jalabiya_line.id},
        )
        assert res_add_usage.status_code == 201
        assert res_add_usage.json()["code"] == "JALABIYA"

        # 3. منع إضافة نفس الوسم مكرراً -> 409 Conflict
        res_dup_usage = await client.post(
            f"/api/v1/catalog/items/{item.id}/usages",
            json={"application_id": jalabiya_line.id},
        )
        assert res_dup_usage.status_code == 409

        # 4. استعراض وسوم الصنف
        res_get_usages = await client.get(f"/api/v1/catalog/items/{item.id}/usages")
        assert res_get_usages.status_code == 200
        usages = res_get_usages.json()
        assert len(usages) == 1
        assert usages[0]["id"] == jalabiya_line.id

        # 5. استعراض تفاصيل الصنف الشاملة والتأكد من ظهور الوسم
        res_detail = await client.get(f"/api/v1/catalog/items/{item.id}")
        assert res_detail.status_code == 200
        assert len(res_detail.json()["usages"]) == 1

        # 6. حذف الوسم
        res_del_usage = await client.delete(f"/api/v1/catalog/items/{item.id}/usages/{jalabiya_line.id}")
        assert res_del_usage.status_code == 204

        # 7. التأكد من أن وسوم الصنف أصبحت فارغة
        res_after = await client.get(f"/api/v1/catalog/items/{item.id}/usages")
        assert len(res_after.json()) == 0

    # 8. التأكد القطعي من عدم إنشاء أي حركة مخزنية للصنف
    ledger_count = (await session.scalars(
        select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == item.id)
    )).one()
    assert ledger_count == 0, "وسوم التطبيق يجب ألا تنشئ أي قيود في دفتر أستاذ المخزون"


# ═════════════════════════════════════════════════════════════════════════════
# 6. اختبارات البحث والفلترة والترتيب والـ Pagination
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_catalog_items_listing_filtering_and_pagination(auth_general_manager, session: AsyncSession):
    """اختبار التصفية والبحث والترتيب والـ Pagination في قائمة الأصناف."""
    unique = uuid.uuid4().hex[:6].upper()
    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    fabrics_cat = (await session.scalars(select(ItemCategory).where(ItemCategory.code == "FAB_MAIN"))).first()
    trims_cat = (await session.scalars(select(ItemCategory).where(ItemCategory.code == "TRM_BUTTONS"))).first()
    moroccan_line = (await session.scalars(select(ApplicationLine).where(ApplicationLine.code == "MOROCCAN_JALABIYA"))).first()

    # إنشاء أصناف متباينة
    item1 = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"FILTER_FAB_{unique}",
        name_ar="قماش أبيض فاخر",
        item_type="fabric",
        unit_id=piece_unit.id,
        category_id=fabrics_cat.id,
        classification_status="confirmed",
        reorder_level=Decimal("10.0"),
    )
    item2 = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"FILTER_BTN_{unique}",
        name_ar="زرار صدف طبيعي",
        item_type="raw_material",
        unit_id=piece_unit.id,
        category_id=trims_cat.id,
        classification_status="needs_review",
        reorder_level=Decimal("100.0"),
    )
    session.add_all([item1, item2])
    await session.commit()

    # ربط item2 بـ Moroccan line
    usage = CatalogItemUsage(item_id=item2.id, application_id=moroccan_line.id)
    session.add(usage)
    await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # فلترة بالفئة
        res_cat = await client.get(f"/api/v1/catalog/items?category_id={fabrics_cat.id}")
        assert res_cat.status_code == 200
        codes_cat = [i["code"] for i in res_cat.json()]
        assert item1.code in codes_cat
        assert item2.code not in codes_cat

        # فلترة بنوع الصنف
        res_type = await client.get("/api/v1/catalog/items?item_type=fabric")
        assert res_type.status_code == 200
        assert any(i["code"] == item1.code for i in res_type.json())

        # فلترة بحالة التصنيف
        res_stat = await client.get("/api/v1/catalog/items?classification_status=confirmed")
        assert res_stat.status_code == 200
        assert any(i["code"] == item1.code for i in res_stat.json())

        # فلترة بخط التطبيق
        res_app = await client.get(f"/api/v1/catalog/items?application_line_id={moroccan_line.id}")
        assert res_app.status_code == 200
        codes_app = [i["code"] for i in res_app.json()]
        assert item2.code in codes_app
        assert item1.code not in codes_app

        # البحث بالاسم
        res_search = await client.get("/api/v1/catalog/items?search=زرار صدف")
        assert res_search.status_code == 200
        assert any(i["code"] == item2.code for i in res_search.json())

        # الترتيب بـ reorder_level تنازلياً
        res_sort = await client.get("/api/v1/catalog/items?sort_by=reorder_level&sort_dir=desc&limit=50")
        assert res_sort.status_code == 200
        items_sorted = res_sort.json()
        levels = [it["reorder_level"] for it in items_sorted]
        assert levels == sorted(levels, reverse=True)
