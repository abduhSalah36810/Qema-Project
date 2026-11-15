"""
اختبارات التصنيع الداخلي والتصنيع للغير وخامات العملاء والتكاليف (Phase 6).
─────────────────────────────────────────────────────────────────────────────
تغطي القرارات الإدارية المعتمدة:
1. MFG-DEC-01: نمطا التصنيع (داخلي وخارجي للغير / CMT Tolling) وربط العميل.
2. MFG-DEC-02: سندات استلام خامات العملاء أمانة، عدم تلويث مخزون المصنع، وتتبع الأرصدة والمرتجعات.
3. MFG-DEC-03: ملكية بنود المستلزمات (supplied_by: customer/factory) والمعالجة التجارية.
4. MFG-DEC-04: احتساب تكلفة العمالة (بالقطعة piece_based أو بالزمن/الساعة time_based).
5. MFG-DEC-05: نسبة الهالك المعتمدة (1.5%)، احتساب انحراف الهالك الزائد وقيمته دون غرامة تلقائية.
6. MFG-DEC-06: التوزيع الإداري للتكاليف غير المباشرة (overhead) وحساب تكلفة القطعة التامة.
─────────────────────────────────────────────────────────────────────────────
"""
from datetime import datetime, timezone
from decimal import Decimal
import uuid
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
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    Unit,
    Warehouse,
)

ROLE_GENERAL_MANAGER = "general_manager"
ROLE_WAREHOUSE_MANAGER = "warehouse_manager"
ROLE_PRODUCTION_MANAGER = "production_manager"
ROLE_FINANCE_MANAGER = "finance_manager"


def make_auth(user_id: str, role: str) -> AuthenticatedUser:
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


def _uid() -> str:
    return str(uuid.uuid4())


async def _setup_fixtures(session: AsyncSession):
    """إعداد بيانات الاختبار الأساسية (عميل، صنف، وحدة قياس، موديل، قالب)."""
    # 1. وحدة قياس
    unit = Unit(id=_uid(), name_ar="متر", code=f"MTR-{_uid()[:4]}")
    session.add(unit)

    # 2. عميل
    customer = Customer(
        id=_uid(),
        code=f"CUST-{_uid()[:6]}",
        name="شركة الأناقة للملابس",
        phone="01012345678",
        status="active",
    )
    session.add(customer)

    # 3. أصناف (قماش مورد من العميل + خيط من المصنع)
    fabric_item = CatalogItem(
        id=_uid(),
        code=f"FAB-{_uid()[:6]}",
        name_ar="قماش قطن معالج 100%",
        item_type="raw_material",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    thread_item = CatalogItem(
        id=_uid(),
        code=f"THRD-{_uid()[:6]}",
        name_ar="خيط تطريز بوليستر",
        item_type="accessory",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    session.add_all([fabric_item, thread_item])

    # 4. موديل ومقاس
    product = Product(
        id=_uid(),
        code=f"STY-{_uid()[:6]}",
        name_ar="قميص كاجوال رجالي",
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

    # 5. قالب تصنيع
    template = ProductionTemplate(
        id=_uid(),
        code=f"TPL-{_uid()[:6]}",
        name_ar="قالب قميص صيفي",
        product_id=product.id,
        variant_id=variant.id,
        is_active=True,
    )
    session.add(template)
    await session.flush()

    version = ProductionTemplateVersion(
        id=_uid(),
        template_id=template.id,
        version_number=1,
        status="approved",
        reference_quantity=100.0,
        notes="",
    )
    session.add(version)
    await session.flush()

    line1 = ProductionTemplateLine(
        id=_uid(),
        version_id=version.id,
        item_id=fabric_item.id,
        unit_id=unit.id,
        quantity_per_reference=150.0,  # 1.5 متر لكل قميص
    )
    line2 = ProductionTemplateLine(
        id=_uid(),
        version_id=version.id,
        item_id=thread_item.id,
        unit_id=unit.id,
        quantity_per_reference=20.0,  # خيط من المصنع
    )
    session.add_all([line1, line2])
    await session.commit()

    return {
        "unit": unit,
        "customer": customer,
        "fabric": fabric_item,
        "thread": thread_item,
        "product": product,
        "variant": variant,
        "template_version": version,
    }


# ═════════════════════════════════════════════════════════════════════════════
# 1. اختبار استلام خامات العملاء أمانة وتتبع الأرصدة والمرتجع (MFG-DEC-02)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_customer_material_receipt_and_returns(session: AsyncSession):
    """
    اختبار تسجيل سند استلام خامات عميل أمانة:
    - التحقق من إنشاء السند والأسطر ورقم السند CMR-...
    - التأكد التام من عدم إنشاء أي قيود محاسبية أو إدراج في أصول مخزون المصنع.
    - استعراض الأرصدة التجميعية لخامات العميل.
    - إرجاع جزء من الخامات المتبقية وتحديث الرصيد بدقة.
    - رفض إرجاع كمية تتجاوز الرصيد المتبقي (422).
    """
    fx = await _setup_fixtures(session)
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    # 1. أمين المخزن يسجل سند استلام 500 متر قماش من العميل
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    receipt_payload = {
        "customer_id": fx["customer"].id,
        "lines": [
            {
                "item_id": fx["fabric"].id,
                "unit_id": fx["unit"].id,
                "quantity_received": "500.000",
                "unit_cost_estimate": "120.0000",
                "notes": "قماش قطن وارد لتشغيل دفعة قمصان",
            }
        ],
        "notes": "استلام أمانة بمخزن الخامات لحساب العميل",
    }
    res = await client.post("/api/v1/production/customer-materials/receipts", json=receipt_payload)
    assert res.status_code == 201, res.text
    r_data = res.json()
    assert r_data["receipt_number"].startswith("CMR-")
    assert r_data["status"] == "received"
    assert len(r_data["lines"]) == 1
    line_data = r_data["lines"][0]
    assert Decimal(str(line_data["quantity_received"])) == Decimal("500.000")
    assert Decimal(str(line_data["quantity_remaining"])) == Decimal("500.000")
    receipt_line_id = line_data["id"]

    # 2. تقرير أرصدة خامات العميل
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    bal_res = await client.get(f"/api/v1/production/customer-materials/balance?customer_id={fx['customer'].id}")
    assert bal_res.status_code == 200, bal_res.text
    balances = bal_res.json()
    assert len(balances) >= 1
    fab_bal = next(b for b in balances if b["item_id"] == fx["fabric"].id)
    assert Decimal(str(fab_bal["total_received"])) == Decimal("500.000")
    assert Decimal(str(fab_bal["current_balance"])) == Decimal("500.000")

    # 3. إرجاع 50 متر قماش فائض للعميل
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    ret_payload = {
        "customer_id": fx["customer"].id,
        "receipt_line_id": receipt_line_id,
        "quantity": "50.000",
        "notes": "إرجاع فائض بناءً على طلب العميل",
    }
    ret_res = await client.post("/api/v1/production/customer-materials/returns", json=ret_payload)
    assert ret_res.status_code == 201, ret_res.text
    ret_data = ret_res.json()
    assert ret_data["return_number"].startswith("CRET-")
    assert Decimal(str(ret_data["quantity"])) == Decimal("50.000")

    # التحقق من تحديث الرصيد المتبقي ليصبح 450
    bal_res2 = await client.get(f"/api/v1/production/customer-materials/balance?customer_id={fx['customer'].id}")
    fab_bal2 = next(b for b in bal_res2.json() if b["item_id"] == fx["fabric"].id)
    assert Decimal(str(fab_bal2["total_returned"])) == Decimal("50.000")
    assert Decimal(str(fab_bal2["current_balance"])) == Decimal("450.000")

    # 4. محاولة إرجاع كمية تتجاوز المتبقي (محاولة إرجاع 500 متر والمتبقي 450 -> 422)
    bad_ret = await client.post(
        "/api/v1/production/customer-materials/returns",
        json={
            "customer_id": fx["customer"].id,
            "receipt_line_id": receipt_line_id,
            "quantity": "500.000",
            "notes": "كمية مبالغ فيها",
        },
    )
    assert bad_ret.status_code == 422


# ═════════════════════════════════════════════════════════════════════════════
# 2. إنشاء أمر تشغيل للغير (External / CMT) وتمييز الملكية (MFG-DEC-01 & 03)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_external_manufacturing_order_creation_and_bom_ownership(session: AsyncSession):
    """
    اختبار إنشاء أمر تشغيل خارجي للغير (external):
    - نوع التصنيع external مع ربط العميل الإلزامي.
    - تحديد ملكية الخامات: قماش من العميل (customer) وخيط من المصنع (factory).
    - استرجاع التفاصيل والتأكد من ظهور بيانات نمط التصنيع والعميل وملكية كل خامة.
    """
    fx = await _setup_fixtures(session)
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    order_payload = {
        "product_id": fx["product"].id,
        "variant_id": fx["variant"].id,
        "template_version_id": fx["template_version"].id,
        "target_quantity": 200,
        "season": "summer",
        "manufacturing_type": "external",
        "customer_id": fx["customer"].id,
        "labor_costing_method": "piece_based",
        "labor_rate": "25.00",
        "notes": "تشغيل للغير لحساب شركة الأناقة",
    }
    res = await client.post("/api/v1/production/orders", json=order_payload)
    assert res.status_code == 201, res.text
    order_data = res.json()
    assert order_data["manufacturing_type"] == "external"
    assert order_data["customer_id"] == fx["customer"].id
    assert order_data["labor_costing_method"] == "piece_based"
    assert Decimal(str(order_data["labor_rate"])) == Decimal("25.00")
    order_id = order_data["id"]

    # استعراض تفاصيل الأمر
    det_res = await client.get(f"/api/v1/production/orders/{order_id}")
    assert det_res.status_code == 200
    det = det_res.json()
    assert det["customer_name"] == "شركة الأناقة للملابس"
    assert len(det["materials"]) == 2

    # في التشغيل للغير: أول خامة (قماش) تكون supplied_by=customer
    mats = det["materials"]
    fab_mat = next(m for m in mats if m["item_id"] == fx["fabric"].id)
    assert fab_mat["supplied_by"] == "customer"
    thread_mat = next(m for m in mats if m["item_id"] == fx["thread"].id)
    assert thread_mat["supplied_by"] == "factory"


# ═════════════════════════════════════════════════════════════════════════════
# 3. احتساب تكلفة العمالة وتوزيع التكاليف غير المباشرة (MFG-DEC-04 & 06)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_labor_costing_and_overhead_allocation(session: AsyncSession):
    """
    اختبار طريقتي احتساب العمالة والتوزيع الإداري للتكاليف غير المباشرة:
    1. بالقطعة (piece_based): 200 قطعة × 25 ج = 5,000 ج عمالة.
    2. بالساعة (time_based): 80 ساعة × 60 ج = 4,800 ج عمالة.
    3. توزيع المصروفات غير المباشرة على أساس القطع: 200 × 10 ج = 2,000 ج.
    4. التحقق من إجمالي التكلفة وتكلفة القطعة دون ازدواج محاسبي.
    """
    fx = await _setup_fixtures(session)
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    # إنشاء أمر تشغيل لـ 200 قطعة
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    order_res = await client.post(
        "/api/v1/production/orders",
        json={
            "product_id": fx["product"].id,
            "variant_id": fx["variant"].id,
            "template_version_id": fx["template_version"].id,
            "target_quantity": 200,
            "season": "summer",
            "manufacturing_type": "external",
            "customer_id": fx["customer"].id,
            "labor_costing_method": "piece_based",
            "labor_rate": "25.00",
        },
    )
    order_id = order_res.json()["id"]

    # 1. احتساب التكلفة بالقطعة مع تكلفة غير مباشرة
    calc_res1 = await client.post(
        f"/api/v1/production/orders/{order_id}/calculate-costs",
        json={
            "labor_costing_method": "piece_based",
            "labor_rate": "25.00",
            "overhead_allocation_basis": "produced_pieces",
            "allocated_overhead_rate": "10.00",
        },
    )
    assert calc_res1.status_code == 200, calc_res1.text
    d1 = calc_res1.json()
    # 200 × 25 = 5000 عمالة
    assert Decimal(str(d1["actual_labor_cost"])) == Decimal("5000.00")
    # 200 × 10 = 2000 تكاليف غير مباشرة
    assert Decimal(str(d1["actual_overhead_cost"])) == Decimal("2000.00")
    # إجمالي التكلفة المحسوبة = 7000 (بافتراض خامات العميل مجانية على المصنع)
    assert Decimal(str(d1["total_actual_cost"])) == Decimal("7000.00")
    # تكلفة القطعة = 7000 / 200 = 35.00
    assert Decimal(str(d1["unit_manufacturing_cost"])) == Decimal("35.0000")

    # 2. التبديل إلى طريقة الأجر بالساعة
    calc_res2 = await client.post(
        f"/api/v1/production/orders/{order_id}/calculate-costs",
        json={
            "labor_costing_method": "time_based",
            "labor_rate": "60.00",
            "labor_hours": "80.00",
            "overhead_allocation_basis": "labor_hours",
            "allocated_overhead_rate": "15.00",
        },
    )
    assert calc_res2.status_code == 200
    d2 = calc_res2.json()
    # 80 × 60 = 4800 عمالة
    assert Decimal(str(d2["actual_labor_cost"])) == Decimal("4800.00")
    # 80 × 15 = 1200 تكاليف غير مباشرة
    assert Decimal(str(d2["actual_overhead_cost"])) == Decimal("1200.00")
    assert Decimal(str(d2["total_actual_cost"])) == Decimal("6000.00")
    # تكلفة القطعة = 6000 / 200 = 30.00
    assert Decimal(str(d2["unit_manufacturing_cost"])) == Decimal("30.0000")


# ═════════════════════════════════════════════════════════════════════════════
# 4. نسبة الهالك المعتمدة (1.5%) واحتساب انحراف الهالك الزائد (MFG-DEC-05)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_material_consumption_and_waste_variance(session: AsyncSession):
    """
    اختبار توثيق الاستهلاك والهالك وانحراف الهالك المعتمد (1.5%):
    - مستهلك فعلي = 450 متر.
    - هالك فعلي = 30 متر.
    - الهالك المسموح به = 450 × 1.5% = 6.75 متر.
    - الهالك الزائد = 30 - 6.75 = 23.25 متر.
    - تكلفة الهالك الزائد التقديرية موثقة للمراجعة دون غرامة آلية.
    - رصيد خامات العميل يُخصم منه المستهلك والهالك تلقائياً.
    """
    fx = await _setup_fixtures(session)
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    # 1. استلام 500 متر قماش أمانة للعميل
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    rcv_res = await client.post(
        "/api/v1/production/customer-materials/receipts",
        json={
            "customer_id": fx["customer"].id,
            "lines": [
                {
                    "item_id": fx["fabric"].id,
                    "unit_id": fx["unit"].id,
                    "quantity_received": "500.000",
                    "unit_cost_estimate": "120.0000",
                }
            ],
            "notes": "استلام لتشغيل أمر قمصان",
        },
    )
    assert rcv_res.status_code == 201

    # 2. إنشاء أمر التشغيل
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    order_res = await client.post(
        "/api/v1/production/orders",
        json={
            "product_id": fx["product"].id,
            "variant_id": fx["variant"].id,
            "template_version_id": fx["template_version"].id,
            "target_quantity": 200,
            "season": "summer",
            "manufacturing_type": "external",
            "customer_id": fx["customer"].id,
            "allowed_waste_pct": "1.50",
        },
    )
    assert order_res.status_code == 201
    order_data = order_res.json()
    order_id = order_data["id"]

    fab_mat = next(m for m in order_data["materials"] if m["item_id"] == fx["fabric"].id)
    thread_mat = next(m for m in order_data["materials"] if m["item_id"] == fx["thread"].id)

    # 3. تسجيل الاستهلاك الفعلي والهالك (450 متر مستهلك، 30 متر هالك، 20 متر مرتجع)
    log_payload = {
        "items": [
            {
                "material_line_id": fab_mat["id"],
                "consumed_quantity": "450.000",
                "waste_quantity": "30.000",
                "returned_quantity": "20.000",
                "notes": "تم القص مع وجود ديفوهات بطرف التوب",
            },
            {
                "material_line_id": thread_mat["id"],
                "consumed_quantity": "20.000",
                "waste_quantity": "0.000",
                "returned_quantity": "0.000",
            },
        ],
        "notes": "تسجيل الاستهلاك الفعلي للمرحلة",
    }
    log_res = await client.post(f"/api/v1/production/orders/{order_id}/material-consumption", json=log_payload)
    assert log_res.status_code == 200, log_res.text
    updated_order = log_res.json()

    # فحص انحراف الهالك
    # مجموع المستهلك = 450 + 20 = 470
    # الهالك المسموح = 470 × 1.5% = 7.050
    # الهالك الفعلي = 30
    # الهالك الزائد = 30 - 7.050 = 22.950 متر
    assert Decimal(str(updated_order["excess_waste_qty"])) > Decimal("0.000")
    assert Decimal(str(updated_order["excess_waste_qty"])) == Decimal("22.950")
    assert Decimal(str(updated_order["actual_waste_pct"])) > Decimal("1.50")

    # 4. التحقق من خصم الخامات من رصيد أمانة العميل
    bal_res = await client.get(f"/api/v1/production/customer-materials/balance?customer_id={fx['customer'].id}")
    fab_bal = next(b for b in bal_res.json() if b["item_id"] == fx["fabric"].id)
    # 500 وارد - 450 مستهلك - 30 هالك - 20 مرتجع = 0 رصيد متبقي
    assert Decimal(str(fab_bal["total_consumed"])) == Decimal("450.000")
    assert Decimal(str(fab_bal["total_wasted"])) == Decimal("30.000")
    assert Decimal(str(fab_bal["total_returned"])) == Decimal("20.000")
    assert Decimal(str(fab_bal["current_balance"])) == Decimal("0.000")
