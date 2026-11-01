"""
مجموعة اختبارات التحقق الشاملة لحوكمة دليل الأصناف وإدارة المراجعات (Phase 3.5 Governance Tests)
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. دورة حياة الاعتماد (draft -> pending_review -> approved / rejected -> reopen).
2. حظر الاعتماد الذاتي (Anti-Self-Approval / Segregation of Duties).
3. فحص جودة التصنيف عند الاعتماد (Classification Guard: no needs_review approval).
4. الحظر التشغيلي للأصناف غير المعتمدة (Finance Invoices, Production Templates & Orders).
5. حوكمة تعديل الأصناف المعتمدة ومنع التعديل المباشر (Direct PATCH blocked with 409).
6. إدارة طلبات التعديل (Revisions Lifecycle, Atomic Merge, Anti-Self-Approval).
7. منع تعدد طلبات التعديل المفتوحة (Single Open Revision Per Item Partial Unique Index).
8. حماية سجل التدقيق التاريخي بـ Trigger يمنع أي مسح أو تعديل (Strictly Append-Only).
─────────────────────────────────────────────────────────────────────────────
"""
import os
import uuid
from decimal import Decimal
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.finance.models import Supplier, SupplierInvoiceLine
from app.modules.production.models import (
    CatalogApprovalHistory,
    CatalogItem,
    CatalogItemRevision,
    ItemCategory,
    Product,
    ProductionOrder,
    ProductionOrderMaterial,
    StockLedgerEntry,
    Unit,
)

db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not db_url or "qemma_test_db" in db_url:
    db_url = "postgresql+asyncpg://qemma_dev:changeme_local_only@127.0.0.1:5432/qemma_erp_dev"


@pytest.fixture
async def session():
    engine = create_async_engine(db_url, poolclass=NullPool, echo=False)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as sess:
        yield sess
    await engine.dispose()


@pytest.fixture
def auth_general_manager(session):
    user = AuthenticatedUser(
        id="usr-gm-gov-test",
        email="gm_gov@qemma.com",
        claims={"sub": "usr-gm-gov-test", "role": "general_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.fixture
def auth_warehouse_user(session):
    user = AuthenticatedUser(
        id="usr-wh-gov-test",
        email="wh_gov@qemma.com",
        claims={"sub": "usr-wh-gov-test", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_item_creation_defaults_to_draft_with_history(auth_warehouse_user, session: AsyncSession):
    """إنشاء صنف جديد ينتج صنفاً بحالة مسودة (draft) مع توثيق أولي في سجل التدقيق."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": f"DRF-{unique}",
                "name_ar": f"قماش مسودة تجريبي {unique}",
                "item_type": "fabric",
                "unit_id": meter_unit.id,
                "classification_status": "confirmed",
                "attributes": {"color": "raw_white"},
                "reorder_level": 10.0,
            },
        )
        assert res.status_code == 201
        data = res.json()
        assert data["approval_status"] == "draft"
        assert data["is_active"] is False
        assert data["has_pending_revision"] is False

        # التحقق من تسجيل حركة created في catalog_approval_history
        hist_stmt = select(CatalogApprovalHistory).where(CatalogApprovalHistory.item_id == data["id"])
        hist_entry = (await session.scalars(hist_stmt)).first()
        assert hist_entry is not None
        assert hist_entry.event_type == "created"
        assert hist_entry.to_status == "draft"
        assert hist_entry.actor_id == auth_warehouse_user.id


@pytest.mark.asyncio
async def test_submit_and_anti_self_approval_guards(auth_warehouse_user, auth_general_manager, session: AsyncSession):
    """التحقق من دورة التقديم وحظر الاعتماد الذاتي وفحص جودة التصنيف."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    # 1. إنشاء صنف بصفة warehouse_user بحالة needs_review
    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_create = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": f"SUB-{unique}",
                "name_ar": f"صنف تقديم تجريبي {unique}",
                "item_type": "fabric",
                "unit_id": meter_unit.id,
                "classification_status": "needs_review",
            },
        )
        assert res_create.status_code == 201
        item_id = res_create.json()["id"]

        # 2. تقديم الصنف للمراجعة بصفة warehouse_user
        res_submit = await client.post(f"/api/v1/catalog/items/{item_id}/submit")
        assert res_submit.status_code == 200
        assert res_submit.json()["approval_status"] == "pending_review"
        assert res_submit.json()["submitted_by"] == auth_warehouse_user.id

        # 3. محاولة اعتماد الصنف من قبل نفس المستخدم مقدم الطلب (Anti-Self-Approval Guard) -> 403 Forbidden
        res_self_approve = await client.post(f"/api/v1/catalog/items/{item_id}/approve")
        assert res_self_approve.status_code == 403

    # 4. محاولة الاعتماد بواسطة المدير العام والصنف ما زال needs_review -> 400 Bad Request
    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client_gm:
        res_bad_class = await client_gm.post(f"/api/v1/catalog/items/{item_id}/approve")
        assert res_bad_class.status_code == 400

        # تعديل الصنف إلى confirmed عبر DB أو إعادة فتح
        db_item = await session.get(CatalogItem, item_id)
        db_item.classification_status = "confirmed"
        await session.commit()

        # 5. اعتماد الصنف بنجاح بواسطة المدير العام
        res_approve = await client_gm.post(f"/api/v1/catalog/items/{item_id}/approve")
        assert res_approve.status_code == 200
        assert res_approve.json()["approval_status"] == "approved"
        assert res_approve.json()["approved_by"] == auth_general_manager.id


@pytest.mark.asyncio
async def test_rejection_and_reopen_lifecycle(auth_warehouse_user, auth_general_manager, session: AsyncSession):
    """التحقق من رفض الصنف مع اشتراط السبب وإعادة فتحه كمسودة."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_create = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": f"REJ-{unique}",
                "name_ar": f"صنف تجربة رفض {unique}",
                "item_type": "fabric",
                "unit_id": meter_unit.id,
                "classification_status": "suggested",
            },
        )
        item_id = res_create.json()["id"]
        await client.post(f"/api/v1/catalog/items/{item_id}/submit")

    # كمدير عام: رفض الصنف بسبب قصير غير كافٍ (< 10 أحرف) -> 422
    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client_gm:
        res_short = await client_gm.post(
            f"/api/v1/catalog/items/{item_id}/reject",
            json={"rejection_reason": "قصير"},
        )
        assert res_short.status_code == 422

        # رفض الصنف بسبب مفصل وكافٍ
        valid_reason = "يرجى تحديد عرض القماش بالسنتمتر والوزن بالجرام للمتر المربع بدقة."
        res_reject = await client_gm.post(
            f"/api/v1/catalog/items/{item_id}/reject",
            json={"rejection_reason": valid_reason},
        )
        assert res_reject.status_code == 200
        assert res_reject.json()["approval_status"] == "rejected"
        assert res_reject.json()["rejection_reason"] == valid_reason

    # كمسؤول مخزن: إعادة فتح الصنف كمسودة
    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client_wh:
        res_reopen = await client_wh.post(f"/api/v1/catalog/items/{item_id}/reopen")
        assert res_reopen.status_code == 200
        assert res_reopen.json()["approval_status"] == "draft"


@pytest.mark.asyncio
async def test_operational_guards_block_non_approved_items(auth_general_manager, session: AsyncSession):
    """التحقق من حظر استخدام الأصناف غير المعتمدة في فواتير المشتريات وقوالب الإنتاج."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    # إنشاء صنف مسودة غير معتمد
    draft_item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"OPG-{unique}",
        name_ar=f"صنف حماية تشغيلية {unique}",
        item_type="fabric",
        unit_id=meter_unit.id,
        classification_status="confirmed",
        approval_status="draft",
        is_active=False,
    )
    session.add(draft_item)

    # تجهيز مورد
    supplier = (await session.scalars(select(Supplier).limit(1))).first()
    if not supplier:
        supplier = Supplier(
            id=str(uuid.uuid4()),
            code=f"SUP-{unique}",
            name=f"مورد تجريبي للاختبار {unique}",
            created_by="test_admin",
        )
        session.add(supplier)

    product = (await session.scalars(select(Product).limit(1))).first()
    await session.commit()

    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. محاولة إدراج صنف مسودة في فاتورة مورد -> 422
        res_inv = await client.post(
            "/api/v1/finance/supplier-invoices",
            json={
                "supplier_id": supplier.id,
                "invoice_number": f"INV-{unique}",
                "invoice_date": "2026-11-01",
                "invoice_total": 500.0,
                "lines": [
                    {
                        "item_id": draft_item.id,
                        "unit_id": meter_unit.id,
                        "invoiced_quantity": 50.0,
                        "unit_price": 10.0,
                    }
                ],
            },
        )
        assert res_inv.status_code == 422

        # 2. محاولة إدراج صنف مسودة في قالب إنتاج -> 400
        if product:
            res_tmpl = await client.post(
                "/api/v1/production/templates",
                json={
                    "code": f"TMPL-{unique}",
                    "name_ar": f"قالب اختبار {unique}",
                    "product_id": product.id,
                    "reference_quantity": 100,
                    "lines": [
                        {
                            "item_id": draft_item.id,
                            "unit_id": meter_unit.id,
                            "quantity_per_reference": 2.5,
                        }
                    ],
                },
            )
            assert res_tmpl.status_code == 400


@pytest.mark.asyncio
async def test_approved_item_revision_workflow_and_collision_guard(
    auth_warehouse_user, auth_general_manager, session: AsyncSession
):
    """التحقق من حظر التعديل المباشر للأصناف المعتمدة وإدارة طلبات التعديل ومنع التعدد المفتوح."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()
    cat = (await session.scalars(select(ItemCategory).where(ItemCategory.is_active.is_(True)).limit(1))).first()

    # إنشاء صنف معتمد
    approved_item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"REV-{unique}",
        name_ar=f"صنف معتمد أصلي {unique}",
        item_type="fabric",
        unit_id=meter_unit.id,
        category_id=cat.id if cat else None,
        classification_status="confirmed",
        approval_status="approved",
        is_active=True,
        attributes={"width_cm": 150},
        reorder_level=Decimal("20"),
    )
    session.add(approved_item)
    await session.commit()

    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. محاولة تعديل الاسم أو المواصفات مباشرة للصنف المعتمد -> 409 Conflict
        res_direct_patch = await client.patch(
            f"/api/v1/catalog/items/{approved_item.id}",
            json={"name_ar": "تعديل مباشر غير مصرح"},
        )
        assert res_direct_patch.status_code == 409

        # 2. تقديم طلب تعديل (Revision 1)
        res_rev1 = await client.post(
            f"/api/v1/catalog/items/{approved_item.id}/revisions",
            json={
                "proposed_changes": {
                    "name_ar": f"صنف معتمد محدث {unique}",
                    "attributes": {"width_cm": 160, "color": "navy"},
                },
                "change_summary": "تحديث عرض ولون الخامة بناء على فحص التوريد الفعلي بالمصنع",
            },
        )
        assert res_rev1.status_code == 201
        rev1_data = res_rev1.json()
        assert rev1_data["revision_number"] == 1
        assert rev1_data["status"] == "pending_review"
        assert rev1_data["submitted_by"] == auth_warehouse_user.id
        assert rev1_data["base_fingerprint"] is not None

        # 3. محاولة تقديم طلب تعديل ثانٍ بينما الأول قيد المراجعة -> 409 Conflict (Single Open Revision Guard)
        res_rev_dup = await client.post(
            f"/api/v1/catalog/items/{approved_item.id}/revisions",
            json={
                "proposed_changes": {"name_ar": "طلب ثان متزامن"},
                "change_summary": "محاولة إنشاء مراجعة متزامنة",
            },
        )
        assert res_rev_dup.status_code == 409

        # 4. محاولة اعتماد طلب التعديل بواسطة نفس مقدمه -> 403 Forbidden
        res_self_rev_app = await client.post(
            f"/api/v1/catalog/items/{approved_item.id}/revisions/{rev1_data['id']}/approve"
        )
        assert res_self_rev_app.status_code == 403

    # 5. اعتماد وتطبيق المراجعة ذرياً بواسطة المدير العام
    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client_gm:
        res_rev_apply = await client_gm.post(
            f"/api/v1/catalog/items/{approved_item.id}/revisions/{rev1_data['id']}/approve"
        )
        assert res_rev_apply.status_code == 200
        assert res_rev_apply.json()["status"] == "applied"
        assert res_rev_apply.json()["reviewed_by"] == auth_general_manager.id

        # التحقق من تطبيق التغييرات ذرياً على الصنف الحي
        res_item = await client_gm.get(f"/api/v1/catalog/items/{approved_item.id}")
        assert res_item.status_code == 200
        item_data = res_item.json()
        assert item_data["name_ar"] == f"صنف معتمد محدث {unique}"
        assert item_data["attributes"]["width_cm"] == 160
        assert item_data["attributes"]["color"] == "navy"
        assert item_data["has_pending_revision"] is False


@pytest.mark.asyncio
async def test_trigger_strictly_prevents_audit_log_deletion(session: AsyncSession):
    """التحقق من أن Trigger قاعدة البيانات يمنع تماماً مسح أو تعديل سجل التدقيق التاريخي."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    item = CatalogItem(
        id=str(uuid.uuid4()),
        code=f"TRG-{unique}",
        name_ar=f"صنف حماية التدقيق {unique}",
        item_type="fabric",
        unit_id=meter_unit.id,
    )
    session.add(item)
    await session.flush()

    hist = CatalogApprovalHistory(
        id=str(uuid.uuid4()),
        item_id=item.id,
        event_type="test_event",
        from_status="draft",
        to_status="pending_review",
        actor_id="test_actor",
        actor_role="admin",
        reason="حركة اختبار لمنع المسح",
        before_snapshot={},
        after_snapshot={},
    )
    session.add(hist)
    await session.commit()

    test_engine = create_async_engine(db_url, poolclass=NullPool)
    test_session_factory = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

    # محاولة تعديل السجل مباشرة -> يجب أن تفشل من خلال الـ Trigger
    with pytest.raises(Exception) as exc_update:
        async with test_session_factory() as sess_test:
            await sess_test.execute(
                text("UPDATE catalog_approval_history SET reason = 'محاولة تلاعب' WHERE id = :hid"),
                {"hid": hist.id},
            )
            await sess_test.commit()
    assert "سجل التدقيق غير قابل للتعديل أو المسح" in str(exc_update.value)

    # محاولة مسح السجل مباشرة -> يجب أن تفشل من خلال الـ Trigger
    with pytest.raises(Exception) as exc_delete:
        async with test_session_factory() as sess_test:
            await sess_test.execute(
                text("DELETE FROM catalog_approval_history WHERE id = :hid"),
                {"hid": hist.id},
            )
            await sess_test.commit()
    assert "سجل التدقيق غير قابل للتعديل أو المسح" in str(exc_delete.value)
    await test_engine.dispose()
    await session.rollback()


@pytest.mark.asyncio
async def test_is_active_constraint_and_lifecycle(auth_general_manager, auth_warehouse_user, session: AsyncSession):
    """التحقق من قيد NOT is_active OR approval_status = 'approved' ومنع تفعيل غير المعتمد."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    # 1. إنشاء صنف مسودة -> يجب أن يكون is_active = False دائماً
    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_create = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": f"ACT-{unique}",
                "name_ar": f"صنف فحص التفعيل {unique}",
                "item_type": "fabric",
                "unit_id": meter_unit.id,
                "classification_status": "confirmed",
                "is_active": True,  # العميل يحاول تمرير True للمسودة
            },
        )
        assert res_create.status_code == 201
        item_data = res_create.json()
        item_id = item_data["id"]
        assert item_data["approval_status"] == "draft"
        assert item_data["is_active"] is False  # تم إجباره على False

        # 2. محاولة تفعيل المسودة عبر PATCH -> 400 Bad Request
        res_patch = await client.patch(
            f"/api/v1/catalog/items/{item_id}",
            json={"is_active": True},
        )
        assert res_patch.status_code == 400
        assert res_patch.json()["code"] == "BAD_REQUEST"

        # 3. تقديم الصنف للمراجعة -> pending_review
        res_sub = await client.post(f"/api/v1/catalog/items/{item_id}/submit")
        assert res_sub.status_code == 200
        assert res_sub.json()["approval_status"] == "pending_review"
        assert res_sub.json()["is_active"] is False

    # 4. اعتماد الصنف بصفة المدير العام -> approved و is_active = True
    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_app = await client.post(f"/api/v1/catalog/items/{item_id}/approve")
        assert res_app.status_code == 200
        approved_data = res_app.json()
        assert approved_data["approval_status"] == "approved"
        assert approved_data["is_active"] is True

        # 5. تعطيل الصنف المعتمد -> is_active = False
        res_deact = await client.post(f"/api/v1/catalog/items/{item_id}/deactivate")
        assert res_deact.status_code == 200
        assert res_deact.json()["is_active"] is False

        # 6. إعادة تفعيل الصنف المعتمد -> is_active = True
        res_react = await client.post(f"/api/v1/catalog/items/{item_id}/reactivate")
        assert res_react.status_code == 200
        assert res_react.json()["is_active"] is True

    # 7. التحقق من القيد على مستوى SQL مباشرة
    test_engine = create_async_engine(db_url, poolclass=NullPool)
    test_session_factory = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)
    with pytest.raises(Exception) as exc_sql:
        async with test_session_factory() as sess_test:
            bad_item = CatalogItem(
                id=str(uuid.uuid4()),
                code=f"SQL-{unique}",
                name_ar=f"صنف كسر القيد {unique}",
                item_type="fabric",
                unit_id=meter_unit.id,
                approval_status="draft",
                is_active=True,  # غير مسموح بموجب ck_catalog_items_active_consistency
            )
            sess_test.add(bad_item)
            await sess_test.commit()
    assert "ck_catalog_items_active_consistency" in str(exc_sql.value)
    await test_engine.dispose()


@pytest.mark.asyncio
async def test_revision_name_ar_change_blocked_when_item_has_transactions(auth_general_manager, auth_warehouse_user, session: AsyncSession):
    """منع تعديل اسم الصنف name_ar عبر Revision إذا ارتبط الصنف بحركات تاريخية، مع السماح بالمواصفات الأخرى."""
    unique = uuid.uuid4().hex[:6].upper()
    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()

    # 1. إنشاء واعتماد صنف
    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_create = await client.post(
            "/api/v1/catalog/items",
            json={
                "code": f"TRX-{unique}",
                "name_ar": f"قماش تاريخي أصلي {unique}",
                "item_type": "fabric",
                "unit_id": meter_unit.id,
                "classification_status": "confirmed",
            },
        )
        item_id = res_create.json()["id"]
        await client.post(f"/api/v1/catalog/items/{item_id}/submit")

    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post(f"/api/v1/catalog/items/{item_id}/approve")

    # 2. ربط الصنف بحركة تاريخية (حركة في دفتر أستاذ المخزون StockLedgerEntry)
    wh_entry = StockLedgerEntry(
        id=str(uuid.uuid4()),
        item_id=item_id,
        unit_id=meter_unit.id,
        location_type="warehouse",
        quantity=10.0,
        reference_doc_type="manual_adjustment",
        reference_doc_id="doc-test-1",
        entry_type="initial",
        created_by="system_test",
    )
    session.add(wh_entry)
    await session.commit()

    # 3. محاولة تقديم طلب تعديل يتضمن تغيير name_ar -> يجب أن يفشل بـ 409 Conflict
    app.dependency_overrides[get_current_user] = lambda: auth_warehouse_user
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_rev_name = await client.post(
            f"/api/v1/catalog/items/{item_id}/revisions",
            json={
                "change_summary": "محاولة تغيير اسم صنف تاريخي",
                "proposed_changes": {
                    "name_ar": f"اسم معدل جديد {unique}",
                },
            },
        )
        assert res_rev_name.status_code == 409
        assert res_rev_name.json()["code"] == "CONFLICT"

        # 4. تقديم طلب تعديل للمواصفات الفنية الأخرى (attributes و reorder_level) دون المساس بالاسم -> ينجح 201
        res_rev_attrs = await client.post(
            f"/api/v1/catalog/items/{item_id}/revisions",
            json={
                "change_summary": "تحديث حد إعادة الطلب والمواصفات فقط",
                "proposed_changes": {
                    "reorder_level": 25.0,
                    "attributes": {"color": "navy_blue"},
                },
            },
        )
        assert res_rev_attrs.status_code == 201
        rev_id = res_rev_attrs.json()["id"]

    # 5. اعتماد طلب تعديل المواصفات بصفة المدير العام -> ينجح 200
    app.dependency_overrides[get_current_user] = lambda: auth_general_manager
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res_app_rev = await client.post(f"/api/v1/catalog/items/{item_id}/revisions/{rev_id}/approve")
        assert res_app_rev.status_code == 200

    # التأكد من بقاء الاسم التاريخي دون أي تغيير
    refreshed_item = await session.get(CatalogItem, item_id)
    assert refreshed_item.name_ar == f"قماش تاريخي أصلي {unique}"
    assert refreshed_item.reorder_level == Decimal("25.0")
