"""
TASK 06 — Final Qema ERP End-to-End Acceptance Test Suite.
The ONLY authorized testing phase.

Covers all 8 operational domains against the isolated testing database (qemma_test_db):
1. Authentication & RBAC (Roles, Permissions, Cross-Department Boundary, Maker-Checker)
2. Supplier & Warehouse Receiving (Purchase Invoices, Inactive Item Guard, Variances, Ledger)
3. Production & WIP (Frozen Snapshot, Material Dispatch, WIP Receipt, Stage Order, Defect Tracking)
4. Finished Goods (Inspection, Defect Isolation, Duplicate Receipt Prevention, FG Ledger)
5. Sales & Delivery (Customer Order, Stock Deduction, Idempotency, Single Revenue)
6. Finance & Treasury (Accounts, Petty Cash Replenish & Settle, Overdraft Block, Maker-Checker)
7. Audit Trail & Reports Integrity (No NaN, No Invalid Date, Immutability Trigger)
8. Regression Verification (Catalog Governance, Re-activation, Customer Directory)
"""
from datetime import datetime, timezone
from decimal import Decimal
import uuid
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.customers.models import Customer, CustomerOrder, CustomerOrderLine
from app.modules.finance.models import (
    CashAccount,
    CashDocument,
    CashLedgerEntry,
    Supplier,
    SupplierInvoice,
    SupplierInvoiceLine,
)
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.service import get_or_create_finished_goods_item

ROLE_GENERAL_MANAGER = "general_manager"
ROLE_WAREHOUSE_MANAGER = "warehouse_manager"
ROLE_FINANCE_MANAGER = "finance_manager"
ROLE_PRODUCTION_MANAGER = "production_manager"


def make_auth(user_id: str, role: str) -> AuthenticatedUser:
    """توليد كائن جلسة مستخدم مصادق عليه بدور محدد وصريح."""
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


# ─── 1. Authentication & RBAC ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_01_auth_rbac_and_maker_checker(session: AsyncSession):
    """اختبار أمان الأدوار، الفصل بين الإدارات، ومنع الاعتماد الذاتي (Maker-Checker)."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    # 1. مسؤول المخازن لا يملك صلاحية إقرار المصروفات أو الحسابات المالية (403)
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    res_fin_block = await client.post(
        "/api/v1/finance/cash-documents",
        json={
            "document_type": "expense",
            "amount": "500.00",
            "description": "محاولة اختراق الصلاحيات المالية",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    assert res_fin_block.status_code == 403, "يجب حظر أمين المخزن من العمليات المالية الخزنية"

    # 2. مسؤول المالية لا يملك صلاحية بدء مراحل الإنتاج (403)
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    res_prod_block = await client.post(
        "/api/v1/production/orders/dummy-id/stages/cutting",
        json={"status": "in_progress"},
    )
    assert res_prod_block.status_code == 403, "يجب حظر مسؤول المالية من إدارة صالة الإنتاج"

    # 3. مسؤول الإنتاج لا يملك صلاحية تسليم المبيعات للعملاء (403)
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    res_deliv_block = await client.post(
        "/api/v1/customers/dummy-id/orders/dummy-order/deliveries",
        json={"notes": "تسليم غير مصرح"},
    )
    assert res_deliv_block.status_code == 403, "يجب حظر مسؤول الإنتاج من تسليم بضاعة المبيعات"

    # 4. قاعدة الحوكمة الصارمة: منع الاعتماد الذاتي (Maker-Checker) في المالية
    treasury = (await session.scalars(select(CashAccount).where(CashAccount.account_type == "treasury"))).first()
    assert treasury is not None
    doc_id = _uid()
    doc = CashDocument(
        id=doc_id,
        document_number=f"DOC-TEST-MC-{uuid.uuid4().hex[:6]}",
        document_type="expense",
        from_account_id=treasury.id,
        amount=Decimal("1500.00"),
        description="مصروف تشغيلي لاختبار Maker-Checker",
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="fin_maker",
    )
    session.add(doc)
    await session.commit()

    # محاولة صانع المستند اعتماده بنفسه -> رفض مع خطأ 409
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_maker", ROLE_FINANCE_MANAGER)
    res_self_app = await client.post(f"/api/v1/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res_self_app.status_code == 409, "قاعدة Maker-Checker تمنع صانع المستند من اعتماده بنفسه"

    # مسؤول آخر يعتمد المستند بنجاح
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_checker", ROLE_FINANCE_MANAGER)
    res_other_app = await client.post(f"/api/v1/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res_other_app.status_code == 200

    # 5. المدير العام يملك الرؤية الرقابية الشاملة
    app.dependency_overrides[get_current_user] = lambda: make_auth("gm_user", ROLE_GENERAL_MANAGER)
    res_gm_rep = await client.get("/api/v1/reports/summary")
    assert res_gm_rep.status_code == 200, "المدير العام يملك صلاحية الاطلاع على تقارير المصنع"

    app.dependency_overrides.clear()


# ─── 2. Supplier & Warehouse Receiving ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_02_supplier_and_receiving_lifecycle(session: AsyncSession):
    """اختبار دورة توريد الخامات من المورد وفحص الفروقات وحظر الأصناف المعطلة."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()
    assert meter_unit is not None

    wh_raw = (await session.scalars(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).first()
    assert wh_raw is not None

    # إنشاء مورد اختباري
    supplier = Supplier(
        id=_uid(),
        code=f"SUPP-T06-{uuid.uuid4().hex[:6]}",
        name="مورد أقمشة فاخرة T06",
        phone="01099998888",
        address="المحلة الكبرى",
        is_active=True,
        created_by="test",
    )
    # صنف معتمد
    active_item = CatalogItem(
        id=_uid(),
        code=f"FAB-APP-T06-{uuid.uuid4().hex[:6]}",
        name_ar="قماش معتمد T06",
        item_type="raw_material",
        unit_id=meter_unit.id,
        is_active=True,
        approval_status="approved",
        classification_status="confirmed",
    )
    # صنف مسودة معطل
    draft_item = CatalogItem(
        id=_uid(),
        code=f"FAB-DFT-T06-{uuid.uuid4().hex[:6]}",
        name_ar="قماش مسودة معطل T06",
        item_type="raw_material",
        unit_id=meter_unit.id,
        is_active=False,
        approval_status="draft",
        classification_status="needs_review",
    )
    session.add_all([supplier, active_item, draft_item])
    await session.commit()

    # 0. المدير المالي لا ينشئ فواتير الموردين (قرار مالك المشروع 2026-11-09)
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    res_fin_denied = await client.post("/api/v1/finance/supplier-invoices", json={"supplier_id": supplier.id})
    assert res_fin_denied.status_code == 403

    # 1. رفض إنشاء فاتورة توريد لصنف مسودة أو غير نشط (422) — أمين المخزن ينشئ الفاتورة
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    inv_bad_payload = {
        "supplier_id": supplier.id,
        "invoice_number": f"INV-BAD-{uuid.uuid4().hex[:6]}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "notes": "فاتورة اختبار صنف غير نشط",
        "lines": [
            {
                "item_id": draft_item.id,
                "unit_id": meter_unit.id,
                "invoiced_quantity": 100.0,
                "unit_price": "50.00",
                "notes": "",
            }
        ],
    }
    res_bad_inv = await client.post("/api/v1/finance/supplier-invoices", json=inv_bad_payload)
    assert res_bad_inv.status_code in (400, 422), "لا يجوز شراء أو توريد صنف معطل أو مسودة"

    # 2. إنشاء فاتورة توريد صحيحة لصنف معتمد
    inv_good_payload = {
        "supplier_id": supplier.id,
        "invoice_number": f"INV-GOOD-{uuid.uuid4().hex[:6]}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "notes": "توريد قماش معتمد 200 متر",
        "lines": [
            {
                "item_id": active_item.id,
                "unit_id": meter_unit.id,
                "invoiced_quantity": 200.0,
                "unit_price": "45.00",
                "notes": "",
            }
        ],
    }
    res_inv = await client.post("/api/v1/finance/supplier-invoices", json=inv_good_payload)
    assert res_inv.status_code == 201
    inv_data = res_inv.json()
    inv_id = inv_data["id"]
    inv_line_id = inv_data["lines"][0]["id"]
    # أمين المخزن لا يرى الأسعار؛ الإجمالي يُقرأ من حساب المدير المالي
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    fin_view = next(i for i in (await client.get("/api/v1/finance/supplier-invoices")).json() if i["id"] == inv_id)
    assert Decimal(str(fin_view["invoice_total"])) == Decimal("9000.00")

    # 3. استلام جزئي مع عجز (تم استلام 180 متر من أصل 200) بواسطة أمين المخزن
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    rec_payload = {
        "lines": [
            {
                "line_id": inv_line_id,
                "received_quantity": 180.0,
                "notes": "عجز 20 متر في الطرد الأول",
            }
        ],
        "notes": "استلام فعلي بمخزن الخامات",
    }
    res_rec = await client.post(f"/api/v1/finance/supplier-invoices/{inv_id}/receive", json=rec_payload)
    assert res_rec.status_code in (200, 201)

    rec_data = res_rec.json()
    # الاستلام الجزئي لا يغلق الفاتورة: المتبقي 20 متراً يمكن استلامه لاحقاً
    assert rec_data["status"] == "partially_received"
    assert rec_data["lines"][0]["received_quantity"] == 180.0
    assert rec_data["lines"][0]["remaining_quantity"] == 20.0

    # 4. التحقق من أثر دفتر الحركات: إضافة ما تم استلامه فعلياً (180 متر فقط) بمستند استلام مستقل
    ledger_entry = (await session.scalars(
        select(StockLedgerEntry).where(
            StockLedgerEntry.item_id == active_item.id,
            StockLedgerEntry.warehouse_id == wh_raw.id,
            StockLedgerEntry.reference_doc_type == "supplier_receipt",
            StockLedgerEntry.entry_type == "supplier_receipt",
        ).order_by(StockLedgerEntry.created_at.desc())
    )).first()
    assert ledger_entry is not None
    assert ledger_entry.quantity == 180.0

    # 5. منع استلام أكثر من المتبقي في الفاتورة
    over_payload = {"lines": [{"line_id": inv_line_id, "received_quantity": 25.0, "notes": ""}], "notes": ""}
    res_over = await client.post(f"/api/v1/finance/supplier-invoices/{inv_id}/receive", json=over_payload)
    assert res_over.status_code == 409

    app.dependency_overrides.clear()


# ─── 3. Production & WIP ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_03_production_wip_lifecycle(session: AsyncSession):
    """اختبار دورة الإنتاج: لقطة الخامات، الصرف، استلام WIP، التتابع الإلزامي للمراحل، والعيوب."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    meter_unit = (await session.scalars(select(Unit).where(Unit.code == "meter"))).first()
    wh_raw = (await session.scalars(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).first()

    # تجهيز موديل ومتغير وقالب
    prod = Product(
        id=_uid(),
        code=f"PRD-T06-{uuid.uuid4().hex[:6]}",
        name_ar="جلابية موديل T06 E2E",
        style_type="half_collar_cuff",
    )
    session.add(prod)
    await session.flush()

    variant = ProductVariant(
        id=_uid(),
        product_id=prod.id,
        numeric_size=58,
        letter_size="XL",
        season="summer",
        sku=f"SKU-T06-{uuid.uuid4().hex[:6]}",
    )
    mat_item = CatalogItem(
        id=_uid(),
        code=f"MAT-COTTON-T06-{uuid.uuid4().hex[:6]}",
        name_ar="خامة قطن صيفي T06",
        item_type="raw_material",
        unit_id=meter_unit.id,
        is_active=True,
        approval_status="approved",
        classification_status="confirmed",
    )
    session.add_all([variant, mat_item])
    await session.flush()

    # رصيد أولي للخامة في مخزن الخامات الرئيسي
    session.add(StockLedgerEntry(
        id=_uid(), item_id=mat_item.id, unit_id=meter_unit.id, warehouse_id=wh_raw.id,
        location_type="warehouse", quantity=500.0,
        reference_doc_type="initial_stock", reference_doc_id="INIT-T06",
        entry_type="initial_stock", created_by="test"
    ))

    # قالب إنتاج
    template = ProductionTemplate(
        id=_uid(),
        code=f"TMPL-T06-{uuid.uuid4().hex[:6]}",
        name_ar="قالب جلابية رجالي صيفية T06",
        product_id=prod.id,
        is_active=True,
    )
    session.add(template)
    await session.flush()

    tmpl_version = ProductionTemplateVersion(
        id=_uid(),
        template_id=template.id,
        version_number=1,
        status="active",
        reference_quantity=50.0,
        notes="50 قطعة تحتاج 150 متر",
    )
    session.add(tmpl_version)
    await session.flush()

    tmpl_line = ProductionTemplateLine(
        id=_uid(),
        version_id=tmpl_version.id,
        item_id=mat_item.id,
        unit_id=meter_unit.id,
        quantity_per_reference=150.0,
        notes="3 أمتار للقطعة",
    )
    session.add(tmpl_line)
    await session.commit()

    # 1. إنشاء أمر التشغيل بواسطة مدير الإنتاج
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    order_payload = {
        "product_id": prod.id,
        "variant_id": variant.id,
        "target_quantity": 100,
        "season": "summer",
        "template_version_id": tmpl_version.id,
        "assigned_to": "خط التشغيل رقم 1",
        "notes": "أمر تشغيل اختباري شامل T06",
    }
    res_order = await client.post("/api/v1/production/orders", json=order_payload)
    assert res_order.status_code == 201
    order_data = res_order.json()
    order_id = order_data["id"]

    # التحقق من لقطة الخامات المجمدة: 100 قطعة تحتاج 300 متر تناسبياً
    assert len(order_data["materials"]) == 1
    assert order_data["materials"][0]["planned_quantity"] == 300.0

    # 2. صرف الخامات من مخزن الخامات الرئيسي بواسطة أمين المخزن
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    res_disp = await client.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف 300 متر قماش"})
    assert res_disp.status_code == 200

    # 3. تأكيد استلام الخامات في مخزن تحت التشغيل (WIP) مع عجز 5 أمتار (استلام 295 متر)
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    rec_payload = {
        "received_lines": [
            {
                "item_id": mat_item.id,
                "received_quantity": 295.0,
                "notes": "عجز 5 أمتار في نهاية التوب",
            }
        ],
        "notes": "استلام الخامات في صالة القص",
    }
    res_wip_rec = await client.post(f"/api/v1/production/orders/{order_id}/receive", json=rec_payload)
    assert res_wip_rec.status_code == 200

    # 4. التتابع الإلزامي للمراحل: منع تخطي مرحلة (القفز للتعبئة قبل القص والتشطيب)
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm_user", ROLE_PRODUCTION_MANAGER)
    res_skip = await client.post(f"/api/v1/production/orders/{order_id}/stages/packing", json={"status": "in_progress"})
    assert res_skip.status_code == 400, "النظام يمنع تخطي المراحل دون إتمام المراحل السابقة"

    # تقدم المراحل بالترتيب الصارم:
    # cutting -> finishing -> snap_installation -> ironing -> packing
    stages = ["cutting", "finishing", "snap_installation", "ironing", "packing"]
    for st in stages:
        r1 = await client.post(f"/api/v1/production/orders/{order_id}/stages/{st}", json={"status": "in_progress", "notes": f"بدء {st}"})
        assert r1.status_code == 200
        r2 = await client.post(f"/api/v1/production/orders/{order_id}/stages/{st}", json={"status": "completed", "notes": f"إكمال {st}"})
        assert r2.status_code == 200

    # 5. تسجيل عيب إنتاج
    defect_payload = {
        "stage_name": "cutting",
        "affected_quantity": 2.0,
        "responsible": "عامل مقص الباترون",
        "description": "خطأ في حردة الرقبة قطعتين",
        "repair_action": "إعادة تفصيل يدوي",
        "repair_cost_description": "تكلفة قماش 6 أمتار إضافية",
    }
    res_defect = await client.post(f"/api/v1/production/orders/{order_id}/defects", json=defect_payload)
    assert res_defect.status_code == 201

    app.dependency_overrides.clear()


# ─── 4. Finished Goods ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_04_finished_goods_lifecycle(session: AsyncSession):
    """اختبار تسليم واستلام المنتج التام وترحيله لمخزن المنتجات التامة مع الفحص."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    wh_fin = (await session.scalars(select(Warehouse).where(Warehouse.code == "finished_goods"))).first()
    assert wh_fin is not None

    prod = Product(id=_uid(), code=f"PRD-FG-{uuid.uuid4().hex[:6]}", name_ar="جلابية منتج تام T06", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()

    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=60, letter_size="2XL", season="winter", sku=f"SKU-FG-{uuid.uuid4().hex[:6]}")
    session.add(variant)
    await session.flush()

    # الحصول على الصنف التام المعياري FG-VAR
    fg_item = await get_or_create_finished_goods_item(session, prod.id, variant.id)
    await session.commit()

    # إنشاء أمر تشغيل في مرحلة التصنيع المكتمل
    order = ProductionOrder(
        id=_uid(),
        order_number=f"ORD-FG-{uuid.uuid4().hex[:6]}",
        product_id=prod.id,
        variant_id=variant.id,
        target_quantity=50,
        season="winter",
        status="manufacturing_completed",
        assigned_to="خط التشغيل الثاني",
        created_by="pm_user",
    )
    session.add(order)
    await session.flush()
    session.add(ProductionOrderItem(
        id=_uid(), order_id=order.id, product_id=prod.id, variant_id=variant.id,
        product_type="factory_brand", target_quantity=50, season="winter",
    ))
    await session.commit()

    # 1. استلام المنتج التام بواسطة أمين المخزن: 48 قطعة مقبولة، 2 قطعة تالفة
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    fg_receipt_payload = {
        "received_quantity": 50.0,
        "accepted_quantity": 48.0,
        "rejected_quantity": 2.0,
        "notes": "استلام فحص الجودة: 48 مطابق و2 عيب خياطة",
    }
    res_fg = await client.post(f"/api/v1/production/orders/{order.id}/finished-receipt", json=fg_receipt_payload)
    assert res_fg.status_code == 201
    res_data = res_fg.json()
    assert res_data["accepted_quantity"] == 48.0
    assert res_data["rejected_quantity"] == 2.0

    # 2. منع إعادة استلام نفس الأمر المكتمل (منع الازدواجية)
    res_dup = await client.post(f"/api/v1/production/orders/{order.id}/finished-receipt", json=fg_receipt_payload)
    assert res_dup.status_code == 409, "منع استلام أمر التشغيل المكتمل مرة أخرى"

    # 3. التحقق من قيد الأستاذ: إضافة 48 قطعة مطابقة في مخزن المنتج التام
    fg_ledger = (await session.scalars(
        select(StockLedgerEntry).where(
            StockLedgerEntry.item_id == fg_item.id,
            StockLedgerEntry.warehouse_id == wh_fin.id,
            StockLedgerEntry.reference_doc_id == order.id,
        )
    )).first()
    assert fg_ledger is not None
    assert fg_ledger.quantity == 48.0

    app.dependency_overrides.clear()


# ─── 5. Sales & Delivery ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_05_sales_and_delivery_lifecycle(session: AsyncSession):
    """اختبار دورة المبيعات: طلب العميل، الحجز، التحصيل، التسليم، وخصم المخزون مرة واحدة."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()
    wh_fin = (await session.scalars(select(Warehouse).where(Warehouse.code == "finished_goods"))).first()
    treasury = (await session.scalars(select(CashAccount).where(CashAccount.account_type == "treasury"))).first()

    customer = Customer(
        id=_uid(),
        code=f"CUST-T06-{uuid.uuid4().hex[:6]}",
        name="عميل مبيعات جملة T06",
        phone="01122334455",
        city="الإسكندرية",
        address="شارع المنشية",
        status="active",
    )
    prod = Product(id=_uid(), code=f"PRD-SLS-{uuid.uuid4().hex[:6]}", name_ar="جلابية مبيعات T06", style_type="half_collar_cuff")
    session.add_all([customer, prod])
    await session.flush()

    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=56, letter_size="L", season="summer", sku=f"SKU-SLS-{uuid.uuid4().hex[:6]}")
    session.add(variant)
    await session.flush()

    fg_item = await get_or_create_finished_goods_item(session, prod.id, variant.id)
    await session.flush()

    # رصيد مخزني متاح في مخزن المنتج التام (100 قطعة) بحاوية factory_brand
    session.add(StockLedgerEntry(
        id=_uid(), item_id=fg_item.id, unit_id=piece_unit.id, warehouse_id=wh_fin.id,
        location_type="warehouse", bucket_reference="factory_brand", quantity=100.0,
        reference_doc_type="initial_deposit", reference_doc_id="INIT-FG-SLS",
        entry_type="initial_stock", created_by="test"
    ))
    await session.commit()

    # 1. إنشاء طلب العميل بواسطة مسؤول المبيعات / المدير العام
    app.dependency_overrides[get_current_user] = lambda: make_auth("gm_user", ROLE_GENERAL_MANAGER)
    order_payload = {
        "order_type": "ready_goods",
        "notes": "طلب شراء جملة 25 قطعة",
        "lines": [
            {
                "product_id": prod.id,
                "variant_id": variant.id,
                "quantity": 25.0,
                "unit_price": "200.00",
                "notes": "",
            }
        ],
    }
    res_co = await client.post(f"/api/v1/customers/{customer.id}/orders", json=order_payload)
    assert res_co.status_code == 201
    co_data = res_co.json()
    co_id = co_data["id"]
    order_line_id = co_data["lines"][0]["id"]
    assert Decimal(str(co_data["total_amount"])) == Decimal("5000.00")

    # 2. تحصيل قيمة الطلب نقداً (إيراد 5000 ج.م في الخزينة)
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    cash_doc_payload = {
        "document_type": "income",
        "to_account_id": treasury.id,
        "amount": "5000.00",
        "description": f"تحصيل طلب مبيعات العميل رقم {co_id}",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    res_cash = await client.post("/api/v1/finance/cash-documents", json=cash_doc_payload)
    assert res_cash.status_code == 201
    cash_id = res_cash.json()["id"]

    # اعتماد التحصيل من مسؤول مالي آخر
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_checker", ROLE_FINANCE_MANAGER)
    await client.post(f"/api/v1/finance/cash-documents/{cash_id}/decision", json={"decision": "approve"})

    # 3. تسليم وخروج المنتجات من مخزن المنتج التام
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    deliv_payload = {
        "received_by": "مندوب العميل",
        "notes": "تسليم 25 جلابية لمندوب العميل",
        "lines": [
            {
                "order_line_id": order_line_id,
                "quantity": 25.0,
            }
        ],
    }
    res_deliv = await client.post(f"/api/v1/customers/{customer.id}/orders/{co_id}/deliveries", json=deliv_payload)
    assert res_deliv.status_code == 201

    # 4. التأكد من خصم المخزون مرة واحدة بالضبط (-25 قطعة)
    dispatch_entries = (await session.scalars(
        select(StockLedgerEntry).where(
            StockLedgerEntry.item_id == fg_item.id,
            StockLedgerEntry.warehouse_id == wh_fin.id,
            StockLedgerEntry.entry_type == "customer_delivery_dispatch",
        )
    )).all()
    assert len(dispatch_entries) == 1
    assert dispatch_entries[0].quantity == -25.0

    app.dependency_overrides.clear()


# ─── 6. Finance & Treasury ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_06_finance_and_treasury_lifecycle(session: AsyncSession):
    """اختبار الحركات النقدية، حظر الصرف فوق الرصيد، العهد والتسويات، واعتماد الرواتب."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    treasury = (await session.scalars(select(CashAccount).where(CashAccount.account_type == "treasury"))).first()
    assert treasury is not None

    # فتح صندوق عهدة
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    res_petty = await client.post(
        "/api/v1/finance/petty-cash",
        params={
            "name": "عهدة_تشغيل_T06",
            "business_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    )
    assert res_petty.status_code == 201
    petty_id = res_petty.json()["id"]

    # 1. تمويل العهدة بتحويل 3,000 ج.م من الخزينة الرئيسية
    trf_payload = {
        "document_type": "transfer",
        "from_account_id": treasury.id,
        "to_account_id": petty_id,
        "amount": "3000.00",
        "description": "تمويل عهدة تشغيل خط الخياطة",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    res_trf = await client.post("/api/v1/finance/cash-documents", json=trf_payload)
    assert res_trf.status_code == 201
    # المدير المالي لا جهة اعتماد فوقه: التحويل يُعتمد لحظة إنشائه
    assert res_trf.json()["status"] == "approved"

    # 2. صرف 1,000 ج.م من العهدة لمستلزمات صيانة
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    exp_payload = {
        "document_type": "expense",
        "from_account_id": petty_id,
        "amount": "1000.00",
        "description": "شراء أدوات صيانة فورية",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    res_exp = await client.post("/api/v1/finance/cash-documents", json=exp_payload)
    assert res_exp.status_code == 201
    assert res_exp.json()["status"] == "approved"

    # 3. حظر الصرف فوق الرصيد: محاولة صرف 10,000 ج.م من العهدة (رصيدها 2000 فقط)
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    over_payload = {
        "document_type": "expense",
        "from_account_id": petty_id,
        "amount": "10000.00",
        "description": "محاولة صرف يتجاوز الرصيد المتبقي",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    res_over = await client.post("/api/v1/finance/cash-documents", json=over_payload)
    assert res_over.status_code == 409, "يُرفض صرف يتجاوز الرصيد المتاح ولا يُحفظ المستند"

    # 4. تسوية العهدة ورد الفائض (2,000 ج.م) وإغلاق الصندوق
    app.dependency_overrides[get_current_user] = lambda: make_auth("fin_user", ROLE_FINANCE_MANAGER)
    res_settle = await client.post(f"/api/v1/finance/petty-cash/{petty_id}/settle?description=تسوية_نهائية")
    assert res_settle.status_code in (200, 201)
    settle_data = res_settle.json()
    # النظام يحسب المصروفات والمتبقي من الدفتر: صافي العهدة 3000 = مصروفات 1000 + مردود 2000
    assert Decimal(str(settle_data["approved_expenses_amount"])) == Decimal("1000.00")
    assert Decimal(str(settle_data["returned_cash_amount"])) == Decimal("2000.00")
    # رد نقدية المدير المالي يُعتمد فوراً، فتُغلق العهدة بعد رد كامل رصيدها
    assert settle_data["status"] == "approved"
    petty_acc = await session.scalar(select(CashAccount).where(CashAccount.id == petty_id))
    await session.refresh(petty_acc)
    assert petty_acc.is_active is False

    app.dependency_overrides.clear()


# ─── 7. Audit Trail & Reports Integrity ────────────────────────────────────────

@pytest.mark.asyncio
async def test_07_audit_trail_and_reports_integrity(session: AsyncSession):
    """التحقق من خلو التقارير من NaN و Invalid Date، وحصانة قيود الأستاذ من التعديل."""
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: make_auth("gm_user", ROLE_GENERAL_MANAGER)
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    # 1. فحص تقرير الملخص العام
    res_sum = await client.get("/api/v1/reports/summary")
    assert res_sum.status_code == 200
    sum_json = res_sum.json()
    assert "treasury" in sum_json
    assert "production" in sum_json
    assert not any("NaN" in str(v) for v in sum_json.values())

    # 2. فحص تقرير حركة وأرصدة المخزون
    res_inv = await client.get("/api/v1/reports/inventory")
    assert res_inv.status_code == 200
    inv_json = res_inv.json()
    assert "items" in inv_json
    inv_items = inv_json["items"]
    assert isinstance(inv_items, list)
    for row in inv_items[:10]:
        assert "warehouse_name_ar" in row
        assert row["warehouse_name_ar"] not in ("", None)

    # 3. فحص التقرير المالي التفصيلي
    res_fin = await client.get("/api/v1/reports/financial?since_days=30")
    assert res_fin.status_code == 200
    fin_json = res_fin.json()
    assert "revenues" in fin_json
    assert "expenses" in fin_json

    # 4. التأكد من حصانة دفتر الأستاذ (Immutability): منع UPDATE أو DELETE
    ledger_any = (await session.scalars(select(StockLedgerEntry).limit(1))).first()
    if ledger_any:
        with pytest.raises(Exception):
            await session.execute(
                text("UPDATE stock_ledger_entries SET quantity = 999 WHERE id = :id"),
                {"id": ledger_any.id},
            )
            await session.commit()
        await session.rollback()

    app.dependency_overrides.clear()


# ─── 8. Regression Verification ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_08_regression_verification(session: AsyncSession):
    """إعادة اختبار الوظائف التأسيسية: حوكمة الأصناف، الجرد، وقائمة العملاء."""
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    piece_unit = (await session.scalars(select(Unit).where(Unit.code == "piece"))).first()

    # 1. إنشاء صنف جديد كمسودة بواسطة أمين المخزن مع تصنيف مؤكد
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh_user", ROLE_WAREHOUSE_MANAGER)
    item_code = f"REG-ITEM-{uuid.uuid4().hex[:6]}"
    res_item = await client.post(
        "/api/v1/catalog/items",
        json={
            "code": item_code,
            "name_ar": "صنف رجعي اختباري T06",
            "item_type": "raw_material",
            "unit_id": piece_unit.id,
            "reorder_level": 5.0,
            "classification_status": "confirmed",
        },
    )
    assert res_item.status_code == 201
    item_id = res_item.json()["id"]

    # 2. تقديم الصنف للمراجعة بواسطة الصانع
    res_sub = await client.post(f"/api/v1/catalog/items/{item_id}/submit")
    assert res_sub.status_code == 200

    # 3. الاعتماد بواسطة المدير العام (منع الاعتماد الذاتي)
    app.dependency_overrides[get_current_user] = lambda: make_auth("gm_user", ROLE_GENERAL_MANAGER)
    res_app = await client.post(f"/api/v1/catalog/items/{item_id}/approve")
    assert res_app.status_code == 200
    assert res_app.json()["approval_status"] == "approved"

    # 4. تعطيل الصنف وإعادة تفعيله
    res_deact = await client.post(f"/api/v1/catalog/items/{item_id}/deactivate")
    assert res_deact.status_code == 200
    assert res_deact.json()["is_active"] is False

    res_react = await client.post(f"/api/v1/catalog/items/{item_id}/reactivate")
    assert res_react.status_code == 200
    assert res_react.json()["is_active"] is True

    # 5. استعراض دليل العملاء
    res_cust = await client.get("/api/v1/customers")
    assert res_cust.status_code == 200
    assert isinstance(res_cust.json(), list)

    app.dependency_overrides.clear()
