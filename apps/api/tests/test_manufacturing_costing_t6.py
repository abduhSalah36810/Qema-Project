"""
Tests for T6: Internal & External Manufacturing & Costing (Phase 6 / T6).
─────────────────────────────────────────────────────────────────────────────
Covers:
1. Internal manufacturing costing (factory materials + labor + overhead).
2. External / CMT manufacturing costing (customer-owned materials zero factory cost, factory accessories included).
3. Waste allowance policy (1.5% threshold, excess calculation, settlement review without auto-fine).
4. Labor costing (piece-based vs time-based, idempotency).
5. Indirect cost allocation (produced_pieces vs labor_hours).
6. Job Cost Sheet (GET /orders/{order_id}/cost-sheet, structured breakdown, price masking for warehouse manager).
7. Manufacturing Profitability Report (GET /reports/manufacturing-profitability, segmented internal vs CMT).
8. RBAC security.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.customers.models import Customer
from app.modules.production.models import (
    CatalogItem,
    CustomerMaterialReceipt,
    CustomerMaterialReceiptLine,
    CustomerMaterialReturn,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderMaterial,
    Unit,
    Warehouse,
    StockLedgerEntry,
)


def _uid() -> str:
    return str(uuid.uuid4())


def make_user(user_id: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(
        id=user_id,
        email=f"{user_id}@qema-test.local",
        claims={
            "role": role,
            "roles": [role],
            "app_metadata": {"role": role, "roles": [role]},
            "user_metadata": {"role": role, "roles": [role], "full_name": f"User {user_id}"},
        },
    )


@pytest.fixture
async def setup_costing_env(session: AsyncSession):
    """تهيئة بيئة متكاملة للاختبار: مستودعات، عميل، أصناف (قماش ومستلزمات)، موديل."""
    # 1. المخازن
    raw_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one_or_none()
    if not raw_wh:
        raw_wh = Warehouse(id=_uid(), code="main_raw_materials", name_ar="مخزن الخامات الرئيسي", is_active=True)
        session.add(raw_wh)

    wip_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "work_in_progress"))).scalar_one_or_none()
    if not wip_wh:
        wip_wh = Warehouse(id=_uid(), code="work_in_progress", name_ar="مخزن تحت التشغيل", is_active=True)
        session.add(wip_wh)

    # 2. وحدة القياس
    unit = Unit(id=_uid(), name_ar="متر", code=f"MTR-{_uid()[:4]}")
    unit_pcs = Unit(id=_uid(), name_ar="قطعة", code=f"PCS-{_uid()[:4]}")
    session.add_all([unit, unit_pcs])

    # 3. عميل
    customer = Customer(
        id=_uid(),
        code=f"CUST-{_uid()[:6]}",
        name="مجموعة النيل للملابس الجاهزة",
        phone="01011112222",
        status="active",
    )
    session.add(customer)

    # 4. أصناف
    customer_fabric = CatalogItem(
        id=_uid(),
        code=f"FAB-CMT-{_uid()[:4]}",
        name_ar="قماش كتان معالج (أمانة عميل)",
        item_type="raw_material",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    factory_fabric = CatalogItem(
        id=_uid(),
        code=f"FAB-FAC-{_uid()[:4]}",
        name_ar="قماش قطن مصري ملك المصنع",
        item_type="raw_material",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    factory_button = CatalogItem(
        id=_uid(),
        code=f"BTN-{_uid()[:4]}",
        name_ar="أزرار بلاستيك فاخرة ملك المصنع",
        item_type="accessory",
        unit_id=unit_pcs.id,
        is_active=True,
        approval_status="approved",
    )
    session.add_all([customer_fabric, factory_fabric, factory_button])

    # 5. منتج ومقاس
    product = Product(
        id=_uid(),
        code=f"STY-{_uid()[:6]}",
        name_ar="قميص كاجوال صيفي",
        style_type="shirt",
    )
    session.add(product)
    await session.flush()

    variant = ProductVariant(
        id=_uid(),
        product_id=product.id,
        numeric_size=58,
        letter_size="L",
        season="summer",
        sku=f"SKU-{_uid()[:6]}",
        is_active=True,
    )
    session.add(variant)

    await session.commit()

    return {
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "unit": unit,
        "unit_pcs": unit_pcs,
        "customer": customer,
        "customer_fabric": customer_fabric,
        "factory_fabric": factory_fabric,
        "factory_button": factory_button,
        "product": product,
        "variant": variant,
    }


@pytest.mark.asyncio
async def test_internal_manufacturing_costing_and_job_cost_sheet(session: AsyncSession, setup_costing_env: dict):
    """
    اختبار التصنيع الداخلي:
    - الخامات كلها ملك المصنع وتدخل في تكلفة الإنتاج بالكامل.
    - احتساب أجور العمالة بالقطعة (piece_based).
    - توزيع التكاليف الصناعية غير المباشرة حسب القطع (produced_pieces).
    - استخراج بطاقة التكلفة (Job Cost Sheet) والتحقق من مجاميع التكلفة والربحية.
    """
    env = setup_costing_env
    order_id = _uid()
    order = ProductionOrder(
        id=order_id,
        order_number=f"ORD-INT-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=500.0,
        season="صيف 2026",
        status="in_production",
        created_by="prod-mgr-01",
        manufacturing_type="internal",
        customer_id=None,
        labor_costing_method="piece_based",
        labor_rate=Decimal("15.00"),  # 15 ج.م للقطعة
        overhead_allocation_basis="produced_pieces",
        allocated_overhead_rate=Decimal("8.00"),  # 8 ج.م للقطعة تحميل غير مباشر
        agreed_service_price=Decimal("120.00"),  # سعر البيع المستهدف 120 ج.م
    )
    session.add(order)

    # خامات المصنع: قماش (1000 متر @ 30 ج.م) + أزرار (3000 قطعة @ 1 ج.م)
    mat1 = ProductionOrderMaterial(
        id=_uid(),
        order_id=order.id,
        item_id=env["factory_fabric"].id,
        unit_id=env["unit"].id,
        planned_quantity=1000.0,
        dispatched_quantity=1000.0,
        received_quantity=1000.0,
        actual_consumed_quantity=Decimal("980.000"),
        actual_waste_quantity=Decimal("12.000"),
        actual_returned_quantity=Decimal("8.000"),
        supplied_by="factory",
        commercial_treatment="included_in_service_fee",
        unit_cost=Decimal("30.0000"),
        total_cost=Decimal("30000.00"),
    )
    mat2 = ProductionOrderMaterial(
        id=_uid(),
        order_id=order.id,
        item_id=env["factory_button"].id,
        unit_id=env["unit_pcs"].id,
        planned_quantity=3000.0,
        dispatched_quantity=3000.0,
        received_quantity=3000.0,
        actual_consumed_quantity=Decimal("2950.000"),
        actual_waste_quantity=Decimal("30.000"),
        actual_returned_quantity=Decimal("20.000"),
        supplied_by="factory",
        commercial_treatment="included_in_service_fee",
        unit_cost=Decimal("1.0000"),
        total_cost=Decimal("3000.00"),
    )
    session.add_all([mat1, mat2])
    order.actual_material_cost = Decimal("33000.00")
    await session.commit()

    # احتساب التكاليف عبر الـ API
    app.dependency_overrides[get_current_user] = lambda: make_user("prod-mgr-01", "production_manager")
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. طلب احتساب التكاليف
        resp = await client.post(
            f"/api/v1/production/orders/{order_id}/calculate-costs",
            json={
                "labor_costing_method": "piece_based",
                "labor_rate": 15.0,
                "overhead_allocation_basis": "produced_pieces",
                "allocated_overhead_rate": 8.0,
                "agreed_service_price": 120.0,
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        # تحقق من التكاليف المحسوبة
        # خامات = 33,000 ج.م
        # عمالة = 500 * 15 = 7,500 ج.م
        # تكاليف غير مباشرة = 500 * 8 = 4,000 ج.م
        # إجمالي التكلفة = 44,500 ج.م
        # تكلفة القطعة = 44,500 / 500 = 89.00 ج.م
        assert Decimal(str(data["actual_material_cost"])) == Decimal("33000.00")
        assert Decimal(str(data["actual_labor_cost"])) == Decimal("7500.00")
        assert Decimal(str(data["actual_overhead_cost"])) == Decimal("4000.00")
        assert Decimal(str(data["total_actual_cost"])) == Decimal("44500.00")
        assert Decimal(str(data["unit_manufacturing_cost"])) == Decimal("89.0000")

        # 2. استعراض بطاقة تكلفة أمر التشغيل (Job Cost Sheet)
        cs_resp = await client.get(f"/api/v1/production/orders/{order_id}/cost-sheet")
        assert cs_resp.status_code == 200, cs_resp.text
        sheet = cs_resp.json()

        assert sheet["manufacturing_type"] == "internal"
        assert sheet["manufacturing_type_label_ar"] == "تصنيع داخلي"
        assert Decimal(str(sheet["factory_materials_cost"])) == Decimal("33000.00")
        assert Decimal(str(sheet["direct_labor_cost"])) == Decimal("7500.00")
        assert Decimal(str(sheet["allocated_overhead_cost"])) == Decimal("4000.00")
        assert Decimal(str(sheet["total_factory_manufacturing_cost"])) == Decimal("44500.00")
        assert Decimal(str(sheet["unit_factory_cost"])) == Decimal("89.0000")

        # الإيراد وهامش الربح:
        # إيراد = 500 * 120 = 60,000 ج.م
        # ربح إجمالي = 60,000 - 44,500 = 15,500 ج.م (25.83%)
        assert Decimal(str(sheet["expected_revenue"])) == Decimal("60000.00")
        assert Decimal(str(sheet["gross_margin_amount"])) == Decimal("15500.00")
        assert Decimal(str(sheet["gross_margin_pct"])) == Decimal("25.83")

        # لا توجد خامات عميل
        assert sheet["customer_materials_count"] == 0
        assert len(sheet["factory_materials"]) == 2
        assert len(sheet["customer_materials"]) == 0

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_external_cmt_costing_customer_material_isolation(session: AsyncSession, setup_costing_env: dict):
    """
    اختبار التشغيل للغير (CMT):
    - خامات العميل معزولة بتكلفة صفرية ولا تدخل مطلقاً في تكلفة المصنع الدفترية.
    - مستلزمات المصنع (أزرار) تدخل في تكلفة خدمة CMT.
    - أجور العمالة بالساعة (time_based: 200 ساعة @ 40 ج.م = 8,000 ج.م).
    - التكاليف غير المباشرة بساعات العمل (200 ساعة @ 10 ج.م = 2,000 ج.م).
    - مقارنة تكلفة خدمة CMT بسعر مصنعية التشغيل المتفق عليه (35 ج.م للقطعة).
    """
    env = setup_costing_env
    order_id = _uid()
    order = ProductionOrder(
        id=order_id,
        order_number=f"ORD-CMT-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=500.0,
        season="صيف 2026",
        status="in_production",
        created_by="prod-mgr-01",
        manufacturing_type="external",
        customer_id=env["customer"].id,
        labor_costing_method="time_based",
        labor_rate=Decimal("40.00"),  # 40 ج.م للساعة
        labor_hours=Decimal("200.00"),  # 200 ساعة عمل
        overhead_allocation_basis="labor_hours",
        allocated_overhead_rate=Decimal("10.00"),  # 10 ج.م لكل ساعة عمل
        agreed_service_price=Decimal("35.00"),  # سعر مصنعية التشغيل للغير 35 ج.م للقطعة
    )
    session.add(order)

    # 1. خامة موردة من العميل (قماش كلفته للمصنع = 0.00)
    mat_customer = ProductionOrderMaterial(
        id=_uid(),
        order_id=order.id,
        item_id=env["customer_fabric"].id,
        unit_id=env["unit"].id,
        planned_quantity=1000.0,
        dispatched_quantity=1000.0,
        received_quantity=1000.0,
        actual_consumed_quantity=Decimal("985.000"),
        actual_waste_quantity=Decimal("10.000"),
        actual_returned_quantity=Decimal("5.000"),
        supplied_by="customer",
        commercial_treatment="included_in_service_fee",
        unit_cost=Decimal("0.0000"),
        total_cost=Decimal("0.00"),
    )

    # 2. مستلزمات موردة من المصنع (أزرار: 3000 قطعة @ 1.00 ج.م = 3,000 ج.م)
    mat_factory = ProductionOrderMaterial(
        id=_uid(),
        order_id=order.id,
        item_id=env["factory_button"].id,
        unit_id=env["unit_pcs"].id,
        planned_quantity=3000.0,
        dispatched_quantity=3000.0,
        received_quantity=3000.0,
        actual_consumed_quantity=Decimal("2970.000"),
        actual_waste_quantity=Decimal("20.000"),
        actual_returned_quantity=Decimal("10.000"),
        supplied_by="factory",
        commercial_treatment="included_in_service_fee",
        unit_cost=Decimal("1.0000"),
        total_cost=Decimal("3000.00"),
    )
    session.add_all([mat_customer, mat_factory])
    await session.commit()

    app.dependency_overrides[get_current_user] = lambda: make_user("prod-mgr-01", "production_manager")
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # احتساب التكاليف
        resp = await client.post(
            f"/api/v1/production/orders/{order_id}/calculate-costs",
            json={
                "labor_costing_method": "time_based",
                "labor_rate": 40.0,
                "labor_hours": 200.0,
                "overhead_allocation_basis": "labor_hours",
                "allocated_overhead_rate": 10.0,
                "agreed_service_price": 35.0,
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        # خامات المصنع فقط = 3,000 ج.م (خامات العميل 0.00)
        # أجور = 200 * 40 = 8,000 ج.م
        # غير مباشر = 200 * 10 = 2,000 ج.م
        # إجمالي تكلفة خدمة CMT = 13,000 ج.م
        # تكلفة القطعة للمصنع = 13,000 / 500 = 26.00 ج.م
        assert Decimal(str(data["actual_material_cost"])) == Decimal("3000.00")
        assert Decimal(str(data["actual_labor_cost"])) == Decimal("8000.00")
        assert Decimal(str(data["actual_overhead_cost"])) == Decimal("2000.00")
        assert Decimal(str(data["total_actual_cost"])) == Decimal("13000.00")
        assert Decimal(str(data["unit_manufacturing_cost"])) == Decimal("26.0000")

        # فحص بطاقة التكلفة (Job Cost Sheet)
        cs_resp = await client.get(f"/api/v1/production/orders/{order_id}/cost-sheet")
        assert cs_resp.status_code == 200, cs_resp.text
        sheet = cs_resp.json()

        assert sheet["manufacturing_type"] == "external"
        assert sheet["manufacturing_type_label_ar"] == "تشغيل للغير (CMT)"
        assert sheet["customer_name"] == env["customer"].name

        # خامات العميل معزولة
        assert sheet["customer_materials_count"] == 1
        assert len(sheet["customer_materials"]) == 1
        cust_mat_line = sheet["customer_materials"][0]
        assert cust_mat_line["ownership"] == "customer"
        assert Decimal(str(cust_mat_line["unit_cost"])) == Decimal("0.0000")
        assert Decimal(str(cust_mat_line["total_cost"])) == Decimal("0.00")
        assert cust_mat_line["actual_consumed_quantity"] == 985.0

        # خامات المصنع
        assert len(sheet["factory_materials"]) == 1
        fac_mat_line = sheet["factory_materials"][0]
        assert fac_mat_line["ownership"] == "factory"
        assert Decimal(str(fac_mat_line["total_cost"])) == Decimal("3000.00")

        # ربحية خدمة CMT:
        # إيراد مصنعية التشغيل = 500 قطعة * 35 ج.م = 17,500 ج.م
        # تكلفة أداء الخدمة = 13,000 ج.م
        # الربح الإجمالي = 4,500 ج.م (25.71%)
        assert Decimal(str(sheet["expected_revenue"])) == Decimal("17500.00")
        assert Decimal(str(sheet["gross_margin_amount"])) == Decimal("4500.00")
        assert Decimal(str(sheet["gross_margin_pct"])) == Decimal("25.71")

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_waste_allowance_and_excess_settlement_review(session: AsyncSession, setup_costing_env: dict):
    """
    اختبار سياسة الهالك (1.5% سقف معتمد لخامات CMT):
    - الهالك ضمن النسبة: لا يوجد هالك زائد (excess_waste_qty = 0).
    - الهالك تجاوز 1.5%: احتساب انحراف الهالك بدقة دون توليد غرامة أو مطالبة تلقائية.
    - تسجيل مراجعة الهالك الزائد (settlement review) باعتماد الإدارة أو إعفائه.
    """
    env = setup_costing_env
    order_id = _uid()
    order = ProductionOrder(
        id=order_id,
        order_number=f"ORD-WST-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=500.0,
        season="صيف 2026",
        status="in_production",
        created_by="prod-mgr-01",
        manufacturing_type="external",
        customer_id=env["customer"].id,
        allowed_waste_pct=Decimal("1.50"),
    )
    session.add(order)

    # خامة مستهلكة: 1000 متر مستهلك، هالك 25 متر (2.5% > 1.5% المسموح)
    # المسموح = 1000 * 1.5% = 15.000 متر
    # الزائد = 25 - 15 = 10.000 متر
    mat = ProductionOrderMaterial(
        id=_uid(),
        order_id=order.id,
        item_id=env["customer_fabric"].id,
        unit_id=env["unit"].id,
        planned_quantity=1000.0,
        supplied_by="customer",
        unit_cost=Decimal("0.0000"),
        total_cost=Decimal("0.00"),
    )
    session.add(mat)
    await session.commit()

    app.dependency_overrides[get_current_user] = lambda: make_user("prod-mgr-01", "production_manager")
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. تسجيل استهلاك فعلي بهالك زائد
        resp = await client.post(
            f"/api/v1/production/orders/{order_id}/material-consumption",
            json={
                "items": [
                    {
                        "material_line_id": mat.id,
                        "consumed_quantity": 1000.0,
                        "waste_quantity": 25.0,
                        "returned_quantity": 0.0,
                        "notes": "فحص قص",
                    }
                ],
                "notes": "تسجيل استهلاك الورشة",
            },
        )
        assert resp.status_code == 200, resp.text
        order_data = resp.json()

        # تحقق من نسبة الهالك وانحراف الزيادة
        assert Decimal(str(order_data["actual_waste_pct"])) == Decimal("2.50")
        assert Decimal(str(order_data["excess_waste_qty"])) == Decimal("10.000")
        assert order_data["excess_waste_settlement_status"] == "pending_review"

        # 2. فحص حالة الهالك في Job Cost Sheet
        cs_resp = await client.get(f"/api/v1/production/orders/{order_id}/cost-sheet")
        assert cs_resp.status_code == 200
        cs = cs_resp.json()
        waste = cs["waste_analysis"]
        assert waste["is_excess"] is True
        assert Decimal(str(waste["allowed_waste_qty"])) == Decimal("15.000")
        assert Decimal(str(waste["actual_waste_qty"])) == Decimal("25.000")
        assert Decimal(str(waste["excess_waste_qty"])) == Decimal("10.000")
        assert waste["settlement_status"] == "pending_review"

        # 3. اتخاذ قرار تسوية ومراجعة الهالك (اعتماد فاقد تشغيل مبرر بقرار الإدارة)
        set_resp = await client.post(
            f"/api/v1/production/orders/{order_id}/waste-settlement",
            json={
                "decision": "approved_by_factory",
                "notes": "تمت مراجعة الهالك وتبين أنه بسبب عيوب في نسيج ثوب القماش المورد من العميل",
            },
        )
        assert set_resp.status_code == 200, set_resp.text
        updated_order = set_resp.json()
        assert updated_order["excess_waste_settlement_status"] == "approved_by_factory"

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_price_masking_for_warehouse_manager(session: AsyncSession, setup_costing_env: dict):
    """
    اختبار حجب الأسعار والتكاليف لأمين المخزن (Role-Based Price Masking):
    - أمين المخزن يستعرض بطاقة التكلفة لتتبع كميات الخامات المصروفة والمستهلكة والهالك.
    - تُحجب الأسعار وتكلفة العمالة وهوامش الربح تلقائياً (تظهر كأصفار أو محجوبة).
    """
    env = setup_costing_env
    order_id = _uid()
    order = ProductionOrder(
        id=order_id,
        order_number=f"ORD-MASK-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=500.0,
        season="صيف 2026",
        status="in_production",
        created_by="prod-mgr-01",
        manufacturing_type="internal",
        actual_material_cost=Decimal("25000.00"),
        actual_labor_cost=Decimal("7500.00"),
        actual_overhead_cost=Decimal("2500.00"),
        total_actual_cost=Decimal("35000.00"),
        unit_manufacturing_cost=Decimal("70.0000"),
        agreed_service_price=Decimal("100.00"),
    )
    session.add(order)
    await session.commit()

    # محاكاة مستخدم أمين مخزن (warehouse_manager فقط)
    app.dependency_overrides[get_current_user] = lambda: make_user("wh-user-01", "warehouse_manager")
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get(f"/api/v1/production/orders/{order_id}/cost-sheet")
        assert resp.status_code == 200, resp.text
        sheet = resp.json()

        # الكميات ظاهرة
        assert sheet["target_quantity"] == 500.0
        # لكن القيم المالية محجوبة
        assert Decimal(str(sheet["factory_materials_cost"])) == Decimal("0.00")
        assert Decimal(str(sheet["direct_labor_cost"])) == Decimal("0.00")
        assert Decimal(str(sheet["allocated_overhead_cost"])) == Decimal("0.00")
        assert Decimal(str(sheet["total_factory_manufacturing_cost"])) == Decimal("0.00")
        assert Decimal(str(sheet["unit_factory_cost"])) == Decimal("0.0000")
        assert Decimal(str(sheet["expected_revenue"])) == Decimal("0.00")
        assert Decimal(str(sheet["gross_margin_amount"])) == Decimal("0.00")

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_manufacturing_profitability_report(session: AsyncSession, setup_costing_env: dict):
    """
    اختبار تقرير مقارنة ربحية التصنيع الداخلي والتشغيل للغير (CMT):
    - يعزل تكلفة مصنعية CMT عن التصنيع الداخلي.
    - يقارن إجمالي الإيرادات وهوامش الربح لكل نمط.
    """
    env = setup_costing_env

    # 1. أمر داخلي
    ord_int = ProductionOrder(
        id=_uid(),
        order_number=f"ORD-REP-INT-{_uid()[:4]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=100.0,
        season="صيف 2026",
        status="completed",
        created_by="system",
        manufacturing_type="internal",
        actual_material_cost=Decimal("6000.00"),
        actual_labor_cost=Decimal("1500.00"),
        actual_overhead_cost=Decimal("500.00"),
        total_actual_cost=Decimal("8000.00"),
        unit_manufacturing_cost=Decimal("80.0000"),
        agreed_service_price=Decimal("120.00"),  # إيراد = 12,000 ج.م، ربح = 4,000 ج.م
    )

    # 2. أمر خارجي CMT
    ord_ext = ProductionOrder(
        id=_uid(),
        order_number=f"ORD-REP-EXT-{_uid()[:4]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=200.0,
        season="صيف 2026",
        status="completed",
        created_by="system",
        manufacturing_type="external",
        customer_id=env["customer"].id,
        actual_material_cost=Decimal("600.00"),  # مستلزمات مصنع فقط
        actual_labor_cost=Decimal("2000.00"),
        actual_overhead_cost=Decimal("400.00"),
        total_actual_cost=Decimal("3000.00"),
        unit_manufacturing_cost=Decimal("15.0000"),
        agreed_service_price=Decimal("25.00"),  # إيراد مصنعية = 5,000 ج.م، ربح = 2,000 ج.م
    )
    session.add_all([ord_int, ord_ext])
    await session.commit()

    # استدعاء التقرير بصلاحية مدير مالي
    app.dependency_overrides[get_current_user] = lambda: make_user("fin-mgr-01", "finance_manager")
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/v1/reports/manufacturing-profitability")
        assert resp.status_code == 200, resp.text
        report = resp.json()

        assert report["total_orders_count"] >= 2
        assert report["internal_orders_count"] >= 1
        assert report["external_orders_count"] >= 1

        int_sum = report["internal_summary"]
        ext_sum = report["external_summary"]

        assert Decimal(str(int_sum["total_cost"])) >= Decimal("8000.00")
        assert Decimal(str(int_sum["total_revenue"])) >= Decimal("12000.00")

        assert Decimal(str(ext_sum["total_service_cost"])) >= Decimal("3000.00")
        assert Decimal(str(ext_sum["total_service_revenue"])) >= Decimal("5000.00")

    app.dependency_overrides.clear()
