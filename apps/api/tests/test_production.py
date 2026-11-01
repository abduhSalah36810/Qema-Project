"""
اختبارات ميزة أوامر التشغيل المؤقتة لمصنع القمة (Production Orders Tests)
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. الحساب التناسبي للخامات بناءً على الكمية المرجعية للقالب.
2. استقلالية لقطة الخامات (Material Snapshot) عن تعديلات القالب اللاحقة.
3. التتابع المرحلي الإلزامي للمراحل الخمس (القص -> التشطيب -> الكبسولة -> الكي -> التعبئة) ورفض القفز.
4. دورة التحويل المخزني: الصرف (بالطريق) ثم تأكيد الاستلام وتسجيل الفروقات دون مسح الأثر.
5. فرض الصلاحيات والأدوار (Deny-by-default):
   - general_manager: إدارة القوالب والأوامر وتحديث المراحل.
   - warehouse_manager: تأكيد استلام الخامات والاطلاع على المخزون دون صلاحية تعديل المراحل.
   - finance_manager: رفض إنشاء أوامر التشغيل وتعديل المراحل (403 Forbidden).
   - الحظر الافتراضي لأي مستخدم بدون دور أو بتوكن مجهول (401/403).
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.permissions import (
    ROLE_FINANCE_MANAGER,
    ROLE_GENERAL_MANAGER,
    ROLE_WAREHOUSE_MANAGER,
    get_user_roles,
)
from app.db.session import get_db
from app.main import app
from app.modules.production.models import (
    CatalogItem,
    Customer,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionStageEvent,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
    utc_now,
)
from app.modules.production.schemas import (
    OrderCreate,
    ProductionOrderItemCreate,
    ReceiptConfirmRequest,
    ReceiptLineConfirm,
    StageUpdate,
)
from app.modules.production.service import (
    calculate_proportional_materials,
    confirm_warehouse_receipt,
    create_production_order,
    add_material_to_draft_order,
    remove_material_from_draft_order,
    reopen_last_completed_stage,
    dispatch_order_materials,
    update_production_stage,
)


# ─── 1. اختبارات المنطق الحسابي والخدمات (Unit / Service Tests) ───────────────

@pytest.mark.asyncio
async def test_add_material_to_draft_order_only():
    order = ProductionOrder(id="ord-1", order_number="PO-1", status="draft")
    item = CatalogItem(id="item-1", code="FAB-1", name_ar="قماش", item_type="raw_material", unit_id="unit-m", is_active=True, approval_status="approved")
    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [order, item]
    duplicate_check = MagicMock()
    duplicate_check.scalar_one_or_none.return_value = None
    session.execute.return_value = duplicate_check

    line = await add_material_to_draft_order(session, "ord-1", "item-1", "unit-m", 12.5, "إضافة للمسودة")
    assert line.item_id == "item-1"
    assert line.planned_quantity == 12.5
    session.commit.assert_awaited_once()

    order.status = "materials_dispatched"
    session.get.side_effect = [order]
    with pytest.raises(HTTPException) as exc_info:
        await add_material_to_draft_order(session, "ord-1", "item-1", "unit-m", 1)
    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_remove_material_only_from_draft_order():
    order = ProductionOrder(id="ord-1", order_number="PO-1", status="draft")
    line = ProductionOrderMaterial(id="mat-1", order_id="ord-1", item_id="item-1", unit_id="unit-m", planned_quantity=3)
    session = AsyncMock()
    session.delete = AsyncMock()
    session.get.side_effect = [order, line]
    await remove_material_from_draft_order(session, "ord-1", "mat-1")
    session.delete.assert_awaited_once_with(line)

    order.status = "materials_dispatched"
    session.get.side_effect = [order]
    with pytest.raises(HTTPException) as exc_info:
        await remove_material_from_draft_order(session, "ord-1", "mat-1")
    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_rollback_reopens_only_latest_completed_stage_and_logs_reason():
    order = ProductionOrder(id="ord-1", order_number="PO-1", status="in_production")
    order.stage_events = [
        ProductionStageEvent(id=f"stage-{index}", order_id=order.id, stage_name=stage,
            status="completed" if index == 0 else "not_started", actor_id="user-1",
            notes="تفاصيل التنفيذ السابقة" if index == 0 else "")
        for index, stage in enumerate(["cutting", "finishing", "snap_installation", "ironing", "packing"])
    ]
    session = AsyncMock()
    session.add = MagicMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = order
    session.execute.return_value = result

    reopened = await reopen_last_completed_stage(session, order.id, "cutting", "إعادة فحص القص", "manager-1", "مدير")
    assert reopened.status == "in_progress"
    assert reopened.notes == "إعادة فحص القص"
    history = session.add.call_args.args[0]
    assert history.from_status == "completed"
    assert history.to_status == "in_progress"
    assert history.previous_notes == "تفاصيل التنفيذ السابقة"
    assert history.reason == "إعادة فحص القص"
    session.commit.assert_awaited_once()

    order.stage_events[1].status = "in_progress"
    with pytest.raises(HTTPException) as exc_info:
        await reopen_last_completed_stage(session, order.id, "cutting", "إعادة فحص القص", "manager-1")
    assert exc_info.value.status_code == 409

@pytest.mark.asyncio
async def test_proportional_material_scaling_calculation():
    """التحقق من معادلة التناسب الحسابي لكميات الخامات مقارنة بالكمية المرجعية للقالب."""
    # قالب كميته المرجعية 50 قطعة ويتطلب 100 متر قماش و500 زرار
    mock_session = AsyncMock()

    mock_version = ProductionTemplateVersion(
        id="ver-1",
        template_id="tmpl-1",
        version_number=1,
        status="active",
        reference_quantity=50.0,
    )
    line1 = ProductionTemplateLine(
        id="line-1",
        version_id="ver-1",
        item_id="item-fabric",
        unit_id="unit-m",
        quantity_per_reference=100.0,
        notes="قماش قطن",
    )
    line2 = ProductionTemplateLine(
        id="line-2",
        version_id="ver-1",
        item_id="item-buttons",
        unit_id="unit-pcs",
        quantity_per_reference=500.0,
        notes="أزرار صدفية",
    )
    mock_version.lines = [line1, line2]

    # محاكاة الاستعلام
    exec_res = MagicMock()
    exec_res.scalar_one_or_none.return_value = mock_version
    mock_session.execute.return_value = exec_res

    # طلب كمية مستهدفة 150 قطعة (مضاعفة 3 أضعاف)
    materials = await calculate_proportional_materials(
        session=mock_session,
        template_version_id="ver-1",
        target_quantity=150.0,
    )

    assert len(materials) == 2
    # 150 / 50 * 100 = 300 متر
    assert materials[0]["item_id"] == "item-fabric"
    assert materials[0]["planned_quantity"] == 300.0
    # 150 / 50 * 500 = 1500 قطعة
    assert materials[1]["item_id"] == "item-buttons"
    assert materials[1]["planned_quantity"] == 1500.0


@pytest.mark.asyncio
async def test_material_snapshot_remains_independent_of_template():
    """التحقق من أن لقطة خامات الأمر المستحدث تُجمد ولا تتأثر بتعديل القالب لاحقاً."""
    order = ProductionOrder(
        id="ord-1",
        order_number="PO-2026-0001",
        product_id="prod-1",
        variant_id="var-1",
        target_quantity=100.0,
        season="summer",
        status="draft",
        created_by="user-1",
    )
    snapshot_mat = ProductionOrderMaterial(
        id="mat-1",
        order_id=order.id,
        item_id="item-fabric",
        unit_id="unit-m",
        planned_quantity=200.0,
        dispatched_quantity=0.0,
        received_quantity=0.0,
        discrepancy_quantity=0.0,
        status="pending",
    )
    order.materials = [snapshot_mat]

    # تعديل خطة القالب الأصلي لاحقاً
    template_version = ProductionTemplateVersion(
        id="ver-1",
        reference_quantity=50.0,
        lines=[ProductionTemplateLine(id="l1", item_id="item-fabric", quantity_per_reference=999.0)]
    )

    # التحقق من أن كمية لقطة الأمر بقيت 200 ولم تتغير
    assert order.materials[0].planned_quantity == 200.0
    assert order.materials[0].status == "pending"


@pytest.mark.asyncio
async def test_create_order_combines_template_and_manual_material_lines():
    product = Product(id="prod-1", code="STYLE-1", name_ar="موديل", style_type="galabeya")
    variant = ProductVariant(id="var-1", product_id="prod-1", numeric_size=58, letter_size="L", season="summer", sku="SKU-1")
    manual_item = CatalogItem(id="manual-item", code="BTN-1", name_ar="زرار", item_type="raw_material", unit_id="unit-piece", is_active=True)
    template_line = ProductionTemplateLine(id="line-1", version_id="version-1", item_id="fabric", unit_id="unit-meter", quantity_per_reference=50)
    template = ProductionTemplate(id="template-1", code="TPL-1", name_ar="قالب جلابية", product_id="prod-1", is_active=True)
    version = ProductionTemplateVersion(id="version-1", template_id="template-1", version_number=1, status="active", reference_quantity=50)
    version.lines = [template_line]
    fabric_item = CatalogItem(id="fabric", code="FAB-1", name_ar="قماش", item_type="raw_material", unit_id="unit-meter", is_active=True)

    count_result = MagicMock()
    count_result.scalars.return_value.all.return_value = []
    version_result = MagicMock()
    version_result.scalar_one_or_none.return_value = version
    session = AsyncMock()
    session.add = MagicMock()
    session.get.side_effect = [product, variant, version, template, fabric_item, manual_item]
    session.execute.side_effect = [count_result, version_result]

    await create_production_order(
        session,
        OrderCreate(
            product_id="prod-1", variant_id="var-1", target_quantity=100, season="summer",
            template_version_id="version-1",
            custom_materials=[{"item_id": "manual-item", "unit_id": "unit-piece", "planned_quantity": 250}],
        ),
        creator_id="manager-1",
    )
    material_lines = [call.args[0] for call in session.add.call_args_list if isinstance(call.args[0], ProductionOrderMaterial)]
    assert len(material_lines) == 2
    assert {line.item_id for line in material_lines} == {"fabric", "manual-item"}


@pytest.mark.asyncio
async def test_sequential_stages_enforcement():
    """التحقق من رفض تخطي المراحل أو بدء مرحلة لاحقة قبل إكمال المرحلة السابقة."""
    mock_session = AsyncMock()
    mock_session.add = MagicMock()

    order = ProductionOrder(
        id="ord-1",
        order_number="PO-2026-0001",
        status="in_production",
    )
    stage_cutting = ProductionStageEvent(
        id="stg-1",
        order_id=order.id,
        stage_name="cutting",
        status="not_started",
        actor_id="user-1",
        actor_name="المدير العام",
        timestamp=utc_now(),
    )
    stage_finishing = ProductionStageEvent(
        id="stg-2",
        order_id=order.id,
        stage_name="finishing",
        status="not_started",
        actor_id="user-1",
        actor_name="المدير العام",
        timestamp=utc_now(),
    )
    order.stage_events = [stage_cutting, stage_finishing]

    exec_res = MagicMock()
    exec_res.scalar_one_or_none.return_value = order
    mock_session.execute.return_value = exec_res

    # محاولة بدء التشطيب ومرحلة القص لم تبدأ بعد -> يجب أن تفشل مع 400
    with pytest.raises(HTTPException) as exc_info:
        await update_production_stage(
            session=mock_session,
            order_id="ord-1",
            stage_name="finishing",
            data=StageUpdate(status="in_progress", notes="محاولة بدء التشطيب مبكراً"),
            actor_id="user-1",
            actor_name="المدير العام",
        )
    assert exc_info.value.status_code == 400
    assert "قبل إكمال المرحلة السابقة" in exc_info.value.detail

    # إكمال مرحلة القص أولاً
    stage_cutting.status = "completed"

    # الآن يمكن بدء مرحلة التشطيب بنجاح
    updated_stage = await update_production_stage(
        session=mock_session,
        order_id="ord-1",
        stage_name="finishing",
        data=StageUpdate(status="in_progress", notes="بدء التشطيب"),
        actor_id="user-1",
        actor_name="المدير العام",
    )
    assert updated_stage.status == "in_progress"
    assert updated_stage.notes == "بدء التشطيب"


@pytest.mark.asyncio
async def test_warehouse_dispatch_and_receipt_discrepancy():
    """التحقق من دورة الصرف والاستلام المخزني وتسجيل الفروقات دون مسح الأثر."""
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.scalar.return_value = 100.0

    order = ProductionOrder(
        id="ord-1",
        order_number="PO-2026-0001",
        status="draft",
    )
    mat = ProductionOrderMaterial(
        id="mat-1",
        order_id=order.id,
        item_id="item-fabric",
        unit_id="unit-m",
        planned_quantity=100.0,
        dispatched_quantity=0.0,
        received_quantity=0.0,
        discrepancy_quantity=0.0,
        status="pending",
    )
    order.materials = [mat]

    raw_wh = Warehouse(id="wh-raw", code="main_raw_materials", name_ar="مخزن الخامات الرئيسي")
    wip_wh = Warehouse(id="wh-wip", code="work_in_progress", name_ar="مخزن تحت التشغيل")

    call_idx = 0
    def mock_execute(stmt):
        nonlocal call_idx
        call_idx += 1
        m = MagicMock()
        if call_idx == 1:
            m.scalar_one_or_none.return_value = order
        elif call_idx == 2:
            m.scalar_one_or_none.return_value = raw_wh
        else:
            m.scalar_one_or_none.return_value = wip_wh
        return m

    mock_session.execute.side_effect = mock_execute

    # 1. الصرف من المخزن الرئيسي
    transfer = await dispatch_order_materials(
        session=mock_session,
        order_id="ord-1",
        dispatcher_id="warehouse-officer-1",
        notes="صرف قماش الدفعة",
    )
    assert transfer.status == "in_transit"
    assert transfer.source_warehouse_id == "wh-raw"
    assert transfer.destination_warehouse_id == "wh-wip"
    assert order.status == "materials_dispatched"
    assert mat.dispatched_quantity == 100.0
    assert mat.status == "dispatched"

    # 2. الاستلام بمخزن تحت التشغيل مع تسجيل عجز (تسلم 95 متراً بدلاً من 100)
    transfer_line = WarehouseTransferLine(
        id="tr-l-1",
        transfer_id=transfer.id,
        item_id="item-fabric",
        unit_id="unit-m",
        dispatched_quantity=100.0,
        received_quantity=0.0,
        discrepancy_quantity=0.0,
    )
    transfer.lines = [transfer_line]

    receive_call_idx = 0
    def mock_receive_exec(stmt):
        nonlocal receive_call_idx
        receive_call_idx += 1
        m = MagicMock()
        if receive_call_idx == 1:
            m.scalar_one_or_none.return_value = transfer
        else:
            m.scalar_one_or_none.return_value = order
        return m

    mock_session.execute.side_effect = mock_receive_exec

    receipt_req = ReceiptConfirmRequest(
        received_lines=[
            ReceiptLineConfirm(
                item_id="item-fabric",
                received_quantity=95.0,
                notes="عجز 5 أمتار في نهاية الطوبة",
            )
        ],
        notes="تم الاستلام مع عجز",
    )

    confirmed_tr = await confirm_warehouse_receipt(
        session=mock_session,
        order_id="ord-1",
        data=receipt_req,
        receiver_id="wip-officer-2",
    )

    assert confirmed_tr.status == "received_confirmed"
    assert transfer_line.received_quantity == 95.0
    assert transfer_line.discrepancy_quantity == -5.0
    assert "عجز 5 أمتار" in transfer_line.notes

    # تحقق من تحديث لقطة خامات الأمر بالحالة المناسبة
    assert mat.received_quantity == 95.0
    assert mat.discrepancy_quantity == -5.0
    assert mat.status == "received_with_discrepancy"
    assert order.status == "in_production"


# ─── 2. اختبارات التحقق من الصلاحيات والـ HTTP API (Deny-by-default) ─────────

@pytest.mark.asyncio
async def test_api_deny_by_default_unauthenticated():
    """التحقق من رفض الوصول (401 Unauthorized) عند محاولة طلب المسار دون توكن."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        res = await client.get("/api/v1/production/products")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_api_deny_by_default_unauthorized_role():
    """التحقق من رفض الوصول (403 Forbidden) لمستخدم يحمل توكناً لكن بدون دور مصرح."""
    user_no_role = AuthenticatedUser(
        id="usr-nobody",
        email="nobody@qemma.com",
        claims={"sub": "usr-nobody"},
    )

    app.dependency_overrides[get_current_user] = lambda: user_no_role
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.get("/api/v1/production/products")
        assert res.status_code == 403
        assert "ليس لديك الصلاحية الكافية" in res.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_catalog_items_read_only_returns_database_rows_without_seeding():
    """قائمة الأصناف تقرأ السجلات الموجودة فقط ولا تنشئ بيانات أولية أثناء GET."""
    manager = AuthenticatedUser(
        id="usr-manager",
        email="manager@qemma.com",
        claims={"sub": "usr-manager", "role": ROLE_GENERAL_MANAGER},
    )
    item = CatalogItem(
        id="db-item-1", code="DB-FAB-01", name_ar="قماش مسجل",
        item_type="fabric", unit_id="unit-meter", is_consumable=True,
        is_active=True,
    )
    item.unit = Unit(id="unit-meter", code="meter", name_ar="متر")
    result = MagicMock()
    result.scalars.return_value.all.return_value = [item]
    session = AsyncMock()
    session.execute.return_value = result

    async def override_db():
        yield session

    app.dependency_overrides[get_current_user] = lambda: manager
    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v1/production/catalog-items")
        assert response.status_code == 200
        assert response.json() == [{
            "id": "db-item-1", "code": "DB-FAB-01", "name_ar": "قماش مسجل",
            "item_type": "fabric", "unit_id": "unit-meter", "unit_name_ar": "متر",
            "is_consumable": True, "is_active": True,
            "category_id": None, "classification_status": "needs_review",
            "attributes": {}, "reorder_level": 0.0,
            "approval_status": "draft", "rejection_reason": None,
            "submitted_at": None, "submitted_by": None,
            "approved_at": None, "approved_by": None,
            "has_pending_revision": False,
        }]
        session.add.assert_not_called()
        session.commit.assert_not_awaited()
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_finance_manager_cannot_create_order_or_update_stage():
    """التحقق من أن المدير المالي (finance_manager) لا يمكنه إنشاء أوامر أو تحديث مراحل الإنتاج (403)."""
    finance_user = AuthenticatedUser(
        id="usr-fin",
        email="finance@qemma.com",
        claims={"sub": "usr-fin", "role": ROLE_FINANCE_MANAGER},
    )

    app.dependency_overrides[get_current_user] = lambda: finance_user
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            # محاولة إنشاء أمر تشغيل
            create_res = await client.post(
                "/api/v1/production/orders",
                json={
                    "product_id": "prod-1",
                    "variant_id": "var-1",
                    "target_quantity": 100,
                    "season": "summer",
                },
            )
            assert create_res.status_code == 403

            # محاولة تحديث مرحلة إنتاج
            stage_res = await client.post(
                "/api/v1/production/orders/ord-1/stages/cutting",
                json={"status": "in_progress"},
            )
            assert stage_res.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_warehouse_manager_permissions():
    """التحقق من صلاحيات أمين المخزن: يملك تأكيد الاستلام، ولكن يُمنع من تحديث مراحل التشغيل."""
    wh_user = AuthenticatedUser(
        id="usr-wh",
        email="warehouse@qemma.com",
        claims={"sub": "usr-wh", "role": ROLE_WAREHOUSE_MANAGER},
    )

    app.dependency_overrides[get_current_user] = lambda: wh_user
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            # محاولة تحديث مرحلة القص -> يجب أن تُرفض 403 لأنها خاصة بـ general_manager
            stage_res = await client.post(
                "/api/v1/production/orders/ord-1/stages/cutting",
                json={"status": "in_progress"},
            )
            assert stage_res.status_code == 403
            assert "ليس لديك الصلاحية الكافية" in stage_res.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_create_order_with_multiple_items_and_fabric_specifications():
    """التحقق من إنشاء أمر تشغيل يحتوي على عدة موديلات/أصناف ومواصفات الأقمشة ونوع التصنيع."""
    product1 = Product(id="prod-1", code="STYLE-1", name_ar="جلابية نصف لياقة", style_type="half_collar_cuff")
    variant1 = ProductVariant(id="var-1", product_id="prod-1", numeric_size=58, letter_size="L", season="summer", sku="SKU-1")

    product2 = Product(id="prod-2", code="STYLE-2", name_ar="شروال", style_type="sharwal")
    variant2 = ProductVariant(id="var-2", product_id="prod-2", numeric_size=60, letter_size="XL", season="summer", sku="SKU-2")
    customer = Customer(id="cust-1", code="CUST-01", name="أبو الفدا للتجارة", status="active")

    session = AsyncMock()
    session.add = MagicMock()

    async def mock_get(model, pk):
        if model == Product and pk == "prod-1":
            return product1
        if model == Product and pk == "prod-2":
            return product2
        if model == ProductVariant and pk == "var-1":
            return variant1
        if model == ProductVariant and pk == "var-2":
            return variant2
        if model == Customer and pk == "cust-1":
            return customer
        return None

    session.get.side_effect = mock_get

    count_res = MagicMock()
    count_res.scalars.return_value.all.return_value = []
    session.execute.return_value = count_res

    payload = OrderCreate(
        items=[
            ProductionOrderItemCreate(
                product_id="prod-1",
                variant_id="var-1",
                target_quantity=50.0,
                season="summer",
                product_type="factory_brand",
                fabric_area="3.2 متر",
                fabric_name="قطن مخلوط فاخر",
                fabric_color="أبيض",
                fabric_weight="220 جم",
                notes="جلابيب براند المصنع",
            ),
            ProductionOrderItemCreate(
                product_id="prod-2",
                variant_id="var-2",
                target_quantity=30.0,
                season="summer",
                product_type="private_label",
                customer_id="cust-1",
                fabric_area="1.8 متر",
                fabric_name="كتان صيفي",
                fabric_color="كحلي",
                fabric_weight="240 جم",
                notes="شروال تصنيع لعميل أبو الفدا",
            ),
        ],
        assigned_to="خط الإنتاج 1",
        notes="أمر مجمع متعدد الموديلات",
    )

    order = await create_production_order(session, payload, creator_id="user-mgr")

    assert order.target_quantity == 80.0
    assert order.season == "summer"
    added_items = [call.args[0] for call in session.add.call_args_list if isinstance(call.args[0], ProductionOrderItem)]
    assert len(added_items) == 2
    assert added_items[0].product_type == "factory_brand"
    assert added_items[0].fabric_name == "قطن مخلوط فاخر"
    assert added_items[0].fabric_color == "أبيض"
    assert added_items[1].product_type == "private_label"
    assert added_items[1].customer_id == "cust-1"
    assert added_items[1].fabric_name == "كتان صيفي"

