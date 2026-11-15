"""
اختبارات أوامر الشراء وإدارة عجز خامات الإنتاج (Purchase Orders & Shortages Tests - Phase 5 / T5).
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. احتساب عجز الخامات بدقة لأوامر التصنيع الداخلي مع تجميع بنود الصنف المتعددة.
2. العزل الصارم لخامات العملاء في تشغيل الغير (CMT) واستبعادها من مشتريات المصنع.
3. تتبع الكميات المعلقة في أوامر الشراء المعتمدة (pending_po_quantity).
4. توليد مسودات أوامر الشراء مجمعة حسب المورد مع فحص الرصيد اللحظي ومانع التكرار (Idempotency).
5. دورة حياة أمر الشراء (draft -> approved -> partially_received -> received) وعدم تحريك المخزون عند الاعتماد.
6. استلام البضاعة (GRN) في مخزن الخامات كقيود موجبة برصيد حر ورفض الاستلام الزائد.
7. مصفوفة الصلاحيات وحجب الأسعار عن أمين المخزن.
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
from app.modules.finance.models import (
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    SupplierReceipt,
)
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderMaterial,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.stock import stock_balance

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


async def _get_or_create_warehouse(session: AsyncSession, code: str, name_ar: str) -> Warehouse:
    wh = await session.scalar(select(Warehouse).where(Warehouse.code == code))
    if not wh:
        wh = Warehouse(id=_uid(), code=code, name_ar=name_ar, is_active=True)
        session.add(wh)
        await session.flush()
    return wh


async def _setup_po_test_environment(session: AsyncSession):
    """تهيئة المخازن والوحدات والأصناف والموردين وأمر التشغيل."""
    raw_wh = await _get_or_create_warehouse(session, "main_raw_materials", "مخزن الخامات الرئيسي")
    wip_wh = await _get_or_create_warehouse(session, "work_in_progress", "مخزن تحت التشغيل")

    unit_meter = Unit(id=_uid(), name_ar="متر", code=f"MTR-{_uid()[:4]}")
    unit_piece = Unit(id=_uid(), name_ar="قطعة", code=f"PCS-{_uid()[:4]}")
    session.add_all([unit_meter, unit_piece])

    # موردون
    supplier_a = Supplier(id=_uid(), name="مورد الأقمشة الحديثة", code=f"SUP-{_uid()[:5]}", phone="01100000001", is_active=True, created_by="test-user")
    supplier_b = Supplier(id=_uid(), name="مورد الإكسسوارات والأزرار", code=f"SUP-{_uid()[:5]}", phone="01100000002", is_active=True, created_by="test-user")
    session.add_all([supplier_a, supplier_b])

    # عميل
    customer = Customer(id=_uid(), code=f"CST-{_uid()[:5]}", name="عميل التوكيلات", phone="01011111111", status="active")
    session.add(customer)

    # أصناف
    fabric_item = CatalogItem(
        id=_uid(), code=f"FAB-{_uid()[:5]}", name_ar="قماش كتان فاخر", item_type="raw_material",
        unit_id=unit_meter.id, is_active=True, approval_status="approved",
    )
    button_item = CatalogItem(
        id=_uid(), code=f"BTN-{_uid()[:5]}", name_ar="أزرار عاجية", item_type="accessory",
        unit_id=unit_piece.id, is_active=True, approval_status="approved",
    )
    thread_item = CatalogItem(
        id=_uid(), code=f"THD-{_uid()[:5]}", name_ar="خيوط حياكة", item_type="raw_material",
        unit_id=unit_piece.id, is_active=True, approval_status="approved",
    )
    session.add_all([fabric_item, button_item, thread_item])

    # موديل ومقاس
    product = Product(id=_uid(), code=f"STY-{_uid()[:5]}", name_ar="عباية مطرزة", style_type="abaya")
    session.add(product)
    await session.flush()

    variant = ProductVariant(
        id=_uid(), product_id=product.id, numeric_size=58, letter_size="L", season="summer",
        sku=f"SKU-{_uid()[:5]}", is_active=True,
    )
    session.add(variant)
    await session.flush()

    return {
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "unit_meter": unit_meter,
        "unit_piece": unit_piece,
        "supplier_a": supplier_a,
        "supplier_b": supplier_b,
        "customer": customer,
        "fabric_item": fabric_item,
        "button_item": button_item,
        "thread_item": thread_item,
        "product": product,
        "variant": variant,
    }


@pytest.mark.asyncio
async def test_shortage_calculation_internal_manufacturing_groups_multiple_lines(session: AsyncSession):
    """
    1. حساب العجز لأمر تصنيع داخلي:
       - يجمع بنود نفس الصنف إذا تكررت في الـ BOM حتى لا يُحسب رصيد المخزن مرتين.
       - يقارن فقط بالرصيد الحر بمخزن الخامات الرئيسي (bucket_reference=None).
    """
    env = await _setup_po_test_environment(session)

    # إنشاء أمر تشغيل داخلي
    order = ProductionOrder(
        id=_uid(),
        order_number=f"ORD-TEST-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=100.0,
        season="summer",
        status="planned",
        manufacturing_type="internal",
        created_by="test-user",
    )
    session.add(order)
    await session.flush()

    # خامات الأمر: بندان للقماش (100 متر + 20 متر) = 120 متر، وبند للأزرار (200 قطعة)
    mat_fabric_1 = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["fabric_item"].id, unit_id=env["unit_meter"].id,
        planned_quantity=100.0, supplied_by="factory", status="pending",
    )
    mat_fabric_2 = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["fabric_item"].id, unit_id=env["unit_meter"].id,
        planned_quantity=20.0, supplied_by="factory", status="pending",
    )
    mat_button = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["button_item"].id, unit_id=env["unit_piece"].id,
        planned_quantity=200.0, supplied_by="factory", status="pending",
    )
    session.add_all([mat_fabric_1, mat_fabric_2, mat_button])

    # رصيد المخزن الحر: 50 متر قماش فقط (عجز = 70 متر)، و 0 أزرار (عجز = 200 قطعة)
    session.add(StockLedgerEntry(
        id=_uid(), item_id=env["fabric_item"].id, unit_id=env["unit_meter"].id,
        warehouse_id=env["raw_wh"].id, quantity=50.0, location_type="warehouse",
        bucket_reference=None, reference_doc_type="initial_balance", reference_doc_id=_uid(),
        entry_type="in", created_by="test-user",
    ))
    await session.commit()

    # فحص عبر API العجز
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm-1", ROLE_PRODUCTION_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(f"/api/v1/production/orders/{order.id}/material-shortages")
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert data["order_id"] == order.id
        assert data["order_number"] == order.order_number
        assert data["has_any_shortage"] is True
        assert data["can_start_production"] is False
        assert data["total_shortage_items_count"] == 2

        items = {item["item_id"]: item for item in data["materials"]}
        # القماش: مطلوب 120، متاح 50، عجز 70
        fab = items[env["fabric_item"].id]
        assert fab["required_quantity"] == 120.0
        assert fab["available_stock"] == 50.0
        assert fab["shortage_quantity"] == 70.0
        assert fab["has_shortage"] is True
        assert fab["is_cmt_customer_material"] is False

        # الأزرار: مطلوب 200، متاح 0، عجز 200
        btn = items[env["button_item"].id]
        assert btn["required_quantity"] == 200.0
        assert btn["available_stock"] == 0.0
        assert btn["shortage_quantity"] == 200.0
        assert btn["has_shortage"] is True

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_shortage_calculation_strictly_excludes_cmt_customer_materials(session: AsyncSession):
    """
    2. في تشغيل الغير (CMT):
       - الخامات الموردة من العميل (supplied_by="customer") تُستبعد قطعياً من مشتريات المصنع.
       - أمانات العميل لا تُحسب كرصيد حر للمصنع.
       - خامات المصنع فقط (supplied_by="factory") هي التي تخضع لاحتساب العجز والتوريد.
    """
    env = await _setup_po_test_environment(session)

    order = ProductionOrder(
        id=_uid(),
        order_number=f"ORD-CMT-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=50.0,
        season="summer",
        status="planned",
        manufacturing_type="external",
        customer_id=env["customer"].id,
        created_by="test-user",
    )
    session.add(order)
    await session.flush()

    # خامة عميل: قماش (مطلوب 150 متر)
    mat_cust_fabric = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["fabric_item"].id, unit_id=env["unit_meter"].id,
        planned_quantity=150.0, supplied_by="customer", status="pending",
    )
    # مستلزم مصنع: خيط حياكة (مطلوب 10 بكرات)
    mat_factory_thread = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["thread_item"].id, unit_id=env["unit_piece"].id,
        planned_quantity=10.0, supplied_by="factory", status="pending",
    )
    session.add_all([mat_cust_fabric, mat_factory_thread])

    # رصيد أمانات العميل بمخزن الخامات (ليس ملك المصنع)
    session.add(StockLedgerEntry(
        id=_uid(), item_id=env["fabric_item"].id, unit_id=env["unit_meter"].id,
        warehouse_id=env["raw_wh"].id, quantity=150.0, location_type="warehouse",
        bucket_reference=f"customer_deposit:{env['customer'].id}",
        reference_doc_type="customer_receipt", reference_doc_id=_uid(),
        entry_type="in", created_by="test-user",
    ))
    await session.commit()

    app.dependency_overrides[get_current_user] = lambda: make_auth("pm-1", ROLE_PRODUCTION_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(f"/api/v1/production/orders/{order.id}/material-shortages")
        assert resp.status_code == 200, resp.text
        data = resp.json()

        items = {item["item_id"]: item for item in data["materials"]}
        # قماش العميل: تم تمييزه كـ cmt_customer_material، وعجزه على المصنع = 0
        fab = items[env["fabric_item"].id]
        assert fab["is_cmt_customer_material"] is True
        assert fab["shortage_quantity"] == 0.0
        assert fab["has_shortage"] is False

        # خيط المصنع: خامة مصنع، متاح 0، عجز 10
        thd = items[env["thread_item"].id]
        assert thd["is_cmt_customer_material"] is False
        assert thd["required_quantity"] == 10.0
        assert thd["available_stock"] == 0.0
        assert thd["shortage_quantity"] == 10.0
        assert thd["has_shortage"] is True

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_generate_purchase_orders_from_shortage_grouped_by_supplier(session: AsyncSession):
    """
    3. توليد أوامر شراء مسودة من عجز الخامات:
       - تجميع البنود حسب المورد (كل مورد ينتج له أمر شراء منفصل).
       - التحقق من الترقيم المتسلسل والبنود والكميات.
       - مانع التكرار (Idempotency).
    """
    env = await _setup_po_test_environment(session)

    order = ProductionOrder(
        id=_uid(),
        order_number=f"ORD-GEN-{_uid()[:6]}",
        product_id=env["product"].id,
        variant_id=env["variant"].id,
        target_quantity=50.0,
        season="summer",
        status="planned",
        manufacturing_type="internal",
        created_by="test-user",
    )
    session.add(order)
    await session.flush()

    mat_fab = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["fabric_item"].id, unit_id=env["unit_meter"].id,
        planned_quantity=100.0, supplied_by="factory", status="pending",
    )
    mat_btn = ProductionOrderMaterial(
        id=_uid(), order_id=order.id, item_id=env["button_item"].id, unit_id=env["unit_piece"].id,
        planned_quantity=500.0, supplied_by="factory", status="pending",
    )
    session.add_all([mat_fab, mat_btn])
    await session.commit()

    # رصيد حر = 0، إذن عجز القماش = 100، وعجز الأزرار = 500
    app.dependency_overrides[get_current_user] = lambda: make_auth("pm-1", ROLE_PRODUCTION_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    payload = {
        "notes": "توليد أوامر شراء لتغطية أمر التشغيل",
        "lines": [
            {
                "item_id": env["fabric_item"].id,
                "unit_id": env["unit_meter"].id,
                "supplier_id": env["supplier_a"].id,
                "quantity": 100.0,
                "unit_price": 45.50,
                "notes": "شراء قماش",
            },
            {
                "item_id": env["button_item"].id,
                "unit_id": env["unit_piece"].id,
                "supplier_id": env["supplier_b"].id,
                "quantity": 500.0,
                "unit_price": 1.25,
                "notes": "شراء أزرار",
            },
        ],
    }

    transport = ASGITransport(app=app)
    idem_key = f"IDEM-{_uid()}"
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # إرسال طلب التوليد
        resp = await client.post(
            f"/api/v1/production/orders/{order.id}/generate-purchase-orders",
            json=payload,
            headers={"Idempotency-Key": idem_key},
        )
        assert resp.status_code == 201, resp.text
        pos = resp.json()
        assert len(pos) == 2

        # التحقق من تقسيم الأوامر حسب المورد
        by_sup = {po["supplier_id"]: po for po in pos}
        assert env["supplier_a"].id in by_sup
        assert env["supplier_b"].id in by_sup

        po_a = by_sup[env["supplier_a"].id]
        assert po_a["status"] == "draft"
        assert po_a["production_order_id"] == order.id
        assert po_a["order_number"].startswith("PO-")
        assert len(po_a["lines"]) == 1
        assert po_a["lines"][0]["item_id"] == env["fabric_item"].id
        assert po_a["lines"][0]["ordered_quantity"] == 100.0

        po_b = by_sup[env["supplier_b"].id]
        assert po_b["status"] == "draft"
        assert len(po_b["lines"]) == 1
        assert po_b["lines"][0]["item_id"] == env["button_item"].id
        assert po_b["lines"][0]["ordered_quantity"] == 500.0

        # فحص مانع التكرار (Idempotency) بإعادة الإرسال بنفس الـ key
        resp2 = await client.post(
            f"/api/v1/production/orders/{order.id}/generate-purchase-orders",
            json=payload,
            headers={"Idempotency-Key": idem_key},
        )
        assert resp2.status_code == 201
        pos2 = resp2.json()
        assert [p["id"] for p in pos2] == [p["id"] for p in pos]

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_po_lifecycle_and_zero_stock_movement_on_approval(session: AsyncSession):
    """
    4. دورة حياة أمر الشراء:
       - الاعتماد يغير الحالة إلى approved.
       - لا يحدث أي تغيير في أرصدة المخزون إطلاقاً عند الإنشاء أو الاعتماد (Zero Stock Movement).
    """
    env = await _setup_po_test_environment(session)

    # إنشاء أمر شراء مسودة
    po = PurchaseOrder(
        id=_uid(),
        order_number=f"PO-20261115-{_uid()[:4]}",
        supplier_id=env["supplier_a"].id,
        status="draft",
        created_by="fm-user",
    )
    po_line = PurchaseOrderLine(
        id=_uid(),
        purchase_order_id=po.id,
        item_id=env["fabric_item"].id,
        unit_id=env["unit_meter"].id,
        ordered_quantity=100.0,
        unit_price=Decimal("50.00"),
    )
    session.add_all([po, po_line])
    await session.commit()

    initial_stock = await stock_balance(session, env["fabric_item"].id, env["raw_wh"].id, bucket_reference=None)
    assert initial_stock == 0.0

    app.dependency_overrides[get_current_user] = lambda: make_auth("fm-1", ROLE_FINANCE_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # اعتماد أمر الشراء
        resp = await client.post(f"/api/v1/finance/purchase-orders/{po.id}/approve")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "approved"
        assert data["approved_by"] == "fm-1"
        assert data["approved_at"] is not None

        # التحقق الحاسم: رصيد المخزن لم يتغير إطلاقاً!
        post_stock = await stock_balance(session, env["fabric_item"].id, env["raw_wh"].id, bucket_reference=None)
        assert post_stock == 0.0

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_po_goods_receiving_and_stock_ledger_atomicity(session: AsyncSession):
    """
    5. استلام البضاعة (GRN) بناءً على أمر الشراء:
       - تسجيل استلام جزئي ثم استلام المتبقي.
       - إثبات القيود في دفتر أستاذ المخزون (StockLedgerEntry) بالرصيد الحر فقط (bucket_reference=None).
       - تحديث حالة أمر الشراء تتابعياً (partially_received ثم received).
       - منع استلام كمية أكبر من المتبقي.
    """
    env = await _setup_po_test_environment(session)

    po = PurchaseOrder(
        id=_uid(),
        order_number=f"PO-20261115-{_uid()[:4]}",
        supplier_id=env["supplier_a"].id,
        status="approved",
        created_by="fm-user",
        approved_by="fm-user",
        approved_at=datetime.now(timezone.utc),
    )
    po_line = PurchaseOrderLine(
        id=_uid(),
        purchase_order_id=po.id,
        item_id=env["fabric_item"].id,
        unit_id=env["unit_meter"].id,
        ordered_quantity=100.0,
        received_quantity=0.0,
        unit_price=Decimal("50.00"),
    )
    session.add_all([po, po_line])
    await session.commit()

    # أمين المخزن يقوم بالاستلام
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh-1", ROLE_WAREHOUSE_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. استلام جزئي: 40 متر من أصل 100 متر
        receive_payload = {
            "notes": "استلام الدفعة الأولى من القماش",
            "lines": [
                {
                    "line_id": po_line.id,
                    "received_quantity": 40.0,
                    "notes": "40 متر بحالة ممتازة",
                }
            ],
        }
        resp = await client.post(f"/api/v1/finance/purchase-orders/{po.id}/receive", json=receive_payload)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "partially_received"
        assert data["lines"][0]["received_quantity"] == 40.0
        assert data["lines"][0]["remaining_quantity"] == 60.0

        # التحقق من المخزون: زاد بمقدار 40 برصيد حر
        stock_after_partial = await stock_balance(session, env["fabric_item"].id, env["raw_wh"].id, bucket_reference=None)
        assert stock_after_partial == 40.0

        # 2. محاولة استلام زائدة: محاولة استلام 70 متر بينما المتبقي 60 فقط -> رفض 409
        over_receive_payload = {
            "notes": "محاولة استلام زائدة",
            "lines": [
                {
                    "line_id": po_line.id,
                    "received_quantity": 70.0,
                }
            ],
        }
        resp_over = await client.post(f"/api/v1/finance/purchase-orders/{po.id}/receive", json=over_receive_payload)
        assert resp_over.status_code == 409
        assert "تتجاوز المتبقي" in resp_over.json()["detail"]

        # 3. استلام باقي الكمية: 60 متر بالضبط
        remaining_receive_payload = {
            "notes": "استلام باقي الكمية بالكامل",
            "lines": [
                {
                    "line_id": po_line.id,
                    "received_quantity": 60.0,
                }
            ],
        }
        resp_final = await client.post(f"/api/v1/finance/purchase-orders/{po.id}/receive", json=remaining_receive_payload)
        assert resp_final.status_code == 200, resp_final.text
        data_final = resp_final.json()
        assert data_final["status"] == "received"
        assert data_final["lines"][0]["received_quantity"] == 100.0
        assert data_final["lines"][0]["remaining_quantity"] == 0.0

        # التحقق من المخزون النهائي: 100 متر بالتمام
        stock_final = await stock_balance(session, env["fabric_item"].id, env["raw_wh"].id, bucket_reference=None)
        assert stock_final == 100.0

        # التحقق من إنشاء مستندات GRN
        receipts = (await session.scalars(select(SupplierReceipt).where(SupplierReceipt.purchase_order_id == po.id))).all()
        assert len(receipts) == 2
        assert all(r.receipt_number.startswith("GRN-") for r in receipts)

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_rbac_price_masking_for_warehouse_manager(session: AsyncSession):
    """
    6. مصفوفة الصلاحيات وحجب الأسعار:
       - أمين المخزن يستعرض أمر الشراء لكن الأسعار تظهر محجوبة (None).
       - المدير المالي يستعرض نفس أمر الشراء والأسعار تظهر كاملة.
       - أمين المخزن لا يملك صلاحية الاعتماد (403).
    """
    env = await _setup_po_test_environment(session)

    po = PurchaseOrder(
        id=_uid(),
        order_number=f"PO-20261115-{_uid()[:4]}",
        supplier_id=env["supplier_a"].id,
        status="draft",
        total_amount=Decimal("3750.00"),
        created_by="fm-user",
    )
    po_line = PurchaseOrderLine(
        id=_uid(),
        purchase_order_id=po.id,
        item_id=env["fabric_item"].id,
        unit_id=env["unit_meter"].id,
        ordered_quantity=50.0,
        unit_price=Decimal("75.00"),
        total_price=Decimal("3750.00"),
    )
    session.add_all([po, po_line])
    await session.commit()

    # 1. فحص أمين المخزن
    app.dependency_overrides[get_current_user] = lambda: make_auth("wh-1", ROLE_WAREHOUSE_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # استعراض أمر الشراء
        resp = await client.get(f"/api/v1/finance/purchase-orders/{po.id}")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["prices_visible"] is False
        assert data["total_amount"] is None
        assert data["lines"][0]["unit_price"] is None
        assert data["lines"][0]["total_price"] is None

        # محاولة اعتماد من أمين المخزن -> 403 Forbidden
        resp_appr = await client.post(f"/api/v1/finance/purchase-orders/{po.id}/approve")
        assert resp_appr.status_code == 403

    app.dependency_overrides.clear()

    # 2. فحص المدير المالي
    app.dependency_overrides[get_current_user] = lambda: make_auth("fm-1", ROLE_FINANCE_MANAGER)
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(f"/api/v1/finance/purchase-orders/{po.id}")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["prices_visible"] is True
        assert float(data["total_amount"]) == 3750.0
        assert float(data["lines"][0]["unit_price"]) == 75.0
        assert float(data["lines"][0]["total_price"]) == 3750.0

    app.dependency_overrides.clear()
