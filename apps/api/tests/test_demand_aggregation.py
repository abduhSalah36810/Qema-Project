"""
اختبارات تجميع طلبات العملاء وتخطيط الاحتياجات (Phase 4: Demand Aggregation & Planning):
─────────────────────────────────────────────────────────────────────────────
تغطي معايير القبول الواردة في وثيقة التدقيق بدقة:
1. استعلام مجمع الطلبات غير المخططة (Demand Pool) واحتساب الكميات المتبقية.
2. معاينة تجميع طلبات متعددة لنفس الموديل والمقاس، وحساب نسب العملاء وصافي احتياج الخامات والرصيد المتاح.
3. التحقق من الضوابط: رفض دمج موديلات أو مقاسات غير متطابقة (422)، ورفض تجاوز الكمية المتبقية (409).
4. إنشاء أمر تشغيل موحد مجمع (Aggregated Production Order) يدمج 50 قطعة للعميل (أ) و 70 قطعة للعميل (ب).
5. تفكيك الكميات المستلمة من المنتج التام تلقائياً على سلات التسليم الخاصة بالعميلين:
   - 50 قطعة في سلة العميل (أ) private_label:{customer_a}.
   - 70 قطعة في سلة العميل (ب) private_label:{customer_b}.
6. نجاح تسليم العميل (أ) لحصته من مخزن التام عبر CustomerDelivery دون أي تعارض مع العميل (ب).
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.customers.models import Customer, CustomerOrder, CustomerOrderLine, CustomerDelivery, CustomerDeliveryLine
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderDemand,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.stock import stock_balance
from app.modules.production.service import get_or_create_finished_goods_item

GM = "general_manager"
WH = "warehouse_manager"
PM = "production_manager"


def _uid() -> str:
    return str(uuid.uuid4())


def _user(user_id: str, role: str) -> AuthenticatedUser:
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


class ClientActor:
    def __init__(self, client: AsyncClient, user: AuthenticatedUser):
        self.client, self.user = client, user

    async def _call(self, method: str, url: str, **kwargs):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kwargs)

    async def get(self, url, **kw):
        return await self._call("GET", url, **kw)

    async def post(self, url, **kw):
        return await self._call("POST", url, **kw)


@pytest.fixture
async def setup_env(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    wh_user = ClientActor(client, _user(f"wh-{_uid()[:4]}", WH))
    pm_user = ClientActor(client, _user(f"pm-{_uid()[:4]}", PM))
    gm_user = ClientActor(client, _user(f"gm-{_uid()[:4]}", GM))

    # المخازن الأساسية
    raw_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one()
    wip_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "work_in_progress"))).scalar_one()
    fg_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "finished_goods"))).scalar_one()

    # وحدة قياس
    unit = Unit(id=_uid(), name_ar="متر طولي", code=f"MTR-{_uid()[:4]}")
    unit_pc = Unit(id=_uid(), name_ar="قطعة", code=f"PC-{_uid()[:4]}")
    session.add_all([unit, unit_pc])

    # خامة قماش
    fabric = CatalogItem(
        id=_uid(),
        code=f"FAB-AGG-{_uid()[:5]}",
        name_ar="قماش قطن صيفي ناعم",
        item_type="raw_material",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    session.add(fabric)

    # رصيد أولي للخامة في مخزن الخامات (1000 متر بسعر 40 ج.م)
    session.add(StockLedgerEntry(
        id=_uid(),
        item_id=fabric.id,
        unit_id=unit.id,
        warehouse_id=raw_wh.id,
        location_type="warehouse",
        bucket_reference=None,
        quantity=1000.0,
        reference_doc_type="opening_balance",
        reference_doc_id=f"OPEN-{_uid()[:4]}",
        entry_type="opening_balance",
        created_by="admin",
        unit_cost=Decimal("40.0000"),
        total_cost=Decimal("40000.00"),
    ))

    # منتج جلابية رجالي كلاسيك ومقاس 58
    prod = Product(id=_uid(), code=f"PRD-AGG-{_uid()[:5]}", name_ar="جلابية كلاسيك مطرزة", style_type="galabya")
    session.add(prod)
    await session.flush()

    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=58, letter_size="XL", season="summer", sku=f"SKU-AGG-{_uid()[:5]}", is_active=True)
    # منتج مختلف ومقاس مختلف لاختبار الرفض
    variant_diff = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=60, letter_size="2XL", season="summer", sku=f"SKU-DIFF-{_uid()[:5]}", is_active=True)
    session.add_all([variant, variant_diff])

    # قالب تصنيع للمقاس 58: يستهلك 2 متر قماش لكل جلابية
    tpl = ProductionTemplate(id=_uid(), code=f"TPL-AGG-{_uid()[:5]}", product_id=prod.id, variant_id=variant.id, name_ar="قالب جلابية كلاسيك 58", is_active=True)
    session.add(tpl)
    await session.flush()

    tpl_ver = ProductionTemplateVersion(id=_uid(), template_id=tpl.id, version_number=1, status="active", reference_quantity=100.0, notes="")
    session.add(tpl_ver)
    await session.flush()

    tpl_line = ProductionTemplateLine(
        id=_uid(), version_id=tpl_ver.id, item_id=fabric.id, unit_id=unit.id,
        quantity_per_reference=200.0,  # 200 متر لكل 100 قطعة = 2 متر للقطعة
    )
    session.add(tpl_line)

    # إنشاء عميلين (أ) و (ب)
    cust_a = Customer(id=_uid(), code=f"CST-A-{_uid()[:4]}", name="شركة الهلال للتجارة", status="active")
    cust_b = Customer(id=_uid(), code=f"CST-B-{_uid()[:4]}", name="مؤسسة النجوم للملابس", status="active")
    session.add_all([cust_a, cust_b])
    await session.flush()

    # طلب للعميل (أ) بـ 50 قطعة
    order_a = CustomerOrder(
        id=_uid(), order_number=f"SO-A-{_uid()[:5]}", customer_id=cust_a.id, order_type="custom_manufacturing",
        status="open", payment_terms="نقدي", created_by="sales",
    )
    line_a = CustomerOrderLine(
        id=_uid(), order_id=order_a.id, product_id=prod.id, variant_id=variant.id,
        quantity=Decimal("50.000"), unit_price=Decimal("250.00"),
    )
    order_a.lines = [line_a]

    # طلب للعميل (ب) بـ 70 قطعة
    order_b = CustomerOrder(
        id=_uid(), order_number=f"SO-B-{_uid()[:5]}", customer_id=cust_b.id, order_type="custom_manufacturing",
        status="open", payment_terms="آجل", created_by="sales",
    )
    line_b = CustomerOrderLine(
        id=_uid(), order_id=order_b.id, product_id=prod.id, variant_id=variant.id,
        quantity=Decimal("70.000"), unit_price=Decimal("260.00"),
    )
    order_b.lines = [line_b]

    # طلب مختلف بمقاس 60 لاختبار قيود الدمج
    order_diff = CustomerOrder(
        id=_uid(), order_number=f"SO-DIFF-{_uid()[:5]}", customer_id=cust_a.id, order_type="custom_manufacturing",
        status="open", payment_terms="نقدي", created_by="sales",
    )
    line_diff = CustomerOrderLine(
        id=_uid(), order_id=order_diff.id, product_id=prod.id, variant_id=variant_diff.id,
        quantity=Decimal("30.000"), unit_price=Decimal("270.00"),
    )
    order_diff.lines = [line_diff]

    session.add_all([order_a, order_b, order_diff])
    await session.commit()

    return {
        "client": client,
        "wh_user": wh_user,
        "pm_user": pm_user,
        "gm_user": gm_user,
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "fg_wh": fg_wh,
        "fabric": fabric,
        "product": prod,
        "variant": variant,
        "variant_diff": variant_diff,
        "cust_a": cust_a,
        "cust_b": cust_b,
        "order_a": order_a,
        "order_b": order_b,
        "order_diff": order_diff,
        "line_a": line_a,
        "line_b": line_b,
        "line_diff": line_diff,
        "tpl_ver": tpl_ver,
    }


@pytest.mark.asyncio
async def test_demand_pool_and_validation(setup_env, session: AsyncSession):
    """
    اختبار استعراض مجمع الطلبات غير المخططة وضوابط التحقق من الدمج.
    """
    e = setup_env
    pm = e["pm_user"]
    line_a = e["line_a"]
    line_b = e["line_b"]
    line_diff = e["line_diff"]

    # 1. فحص مجمع الطلبات غير المخططة (Demand Pool)
    pool_res = await pm.get("/api/v1/production/demand-pool")
    assert pool_res.status_code == 200, pool_res.text
    pool = pool_res.json()
    assert len(pool) >= 2
    item_a = next(i for i in pool if i["customer_order_line_id"] == line_a.id)
    item_b = next(i for i in pool if i["customer_order_line_id"] == line_b.id)
    assert item_a["ordered_quantity"] == 50.0
    assert item_a["unplanned_quantity"] == 50.0
    assert item_b["ordered_quantity"] == 70.0
    assert item_b["unplanned_quantity"] == 70.0

    # 2. فحص معاينة تجميع الطلبات (Preview)
    preview_payload = {
        "items": [
            {"customer_order_line_id": line_a.id, "allocated_quantity": 50.0},
            {"customer_order_line_id": line_b.id, "allocated_quantity": 70.0},
        ]
    }
    prev_res = await pm.post("/api/v1/production/demand-pool/preview", json=preview_payload)
    assert prev_res.status_code == 200, prev_res.text
    prev = prev_res.json()
    assert prev["total_target_quantity"] == 120.0
    assert len(prev["customer_shares"]) == 2
    assert prev["customer_shares"][0]["allocated_quantity"] == 50.0
    assert prev["customer_shares"][0]["percentage"] == 41.67
    assert prev["customer_shares"][1]["allocated_quantity"] == 70.0
    assert prev["customer_shares"][1]["percentage"] == 58.33

    # فحص الخامات: 120 قطعة × 2 متر = 240 متر مطلوب
    mat = prev["materials"][0]
    assert mat["item_id"] == e["fabric"].id
    assert mat["required_quantity"] == 240.0
    assert mat["available_quantity"] == 1000.0
    assert mat["shortage_quantity"] == 0.0
    assert mat["is_sufficient"] is True
    assert prev["all_materials_available"] is True

    # 3. اختبار رفض دمج مقاسين مختلفين (مقاس 58 مع مقاس 60) -> 422
    invalid_merge = await pm.post(
        "/api/v1/production/demand-pool/preview",
        json={
            "items": [
                {"customer_order_line_id": line_a.id, "allocated_quantity": 50.0},
                {"customer_order_line_id": line_diff.id, "allocated_quantity": 30.0},
            ]
        },
    )
    assert invalid_merge.status_code == 422
    assert "تطابق الموديل والمقاس" in invalid_merge.json()["detail"]

    # 4. اختبار رفض تخصيص كمية أكبر من المتاح غير المخطط -> 409
    over_alloc = await pm.post(
        "/api/v1/production/demand-pool/preview",
        json={
            "items": [
                {"customer_order_line_id": line_a.id, "allocated_quantity": 60.0},  # المتاح 50 فقط
            ]
        },
    )
    assert over_alloc.status_code == 409
    assert "تتجاوز الكمية المتبقية" in over_alloc.json()["detail"]


@pytest.mark.asyncio
async def test_full_demand_aggregation_and_deaggregation_workflow(setup_env, session: AsyncSession):
    """
    اختبار دورة التجميع والتفكيك الكاملة وفق معيار القبول:
    1. دمج طلب العميل (أ) بـ 50 قطعة وطلب العميل (ب) بـ 70 قطعة في أمر تشغيل موحد بـ 120 قطعة.
    2. صرف الخامات (240 متر) وتأكيد استلامها بالورشة.
    3. استلام المنتج التام (120 قطعة) بمخزن المنتجات التامة.
    4. التحقق من تفكيك الكميات آلياً وإيداع:
       - 50 قطعة في سلة العميل (أ): private_label:{cust_a.id}
       - 70 قطعة في سلة العميل (ب): private_label:{cust_b.id}
    5. تسليم العميل (أ) كامل كميته عبر سند CustomerDelivery بنجاح دون التأثير على رصيد العميل (ب).
    """
    e = setup_env
    wh, pm = e["wh_user"], e["pm_user"]
    cust_a = e["cust_a"]
    cust_b = e["cust_b"]
    line_a = e["line_a"]
    line_b = e["line_b"]
    fabric_id = e["fabric"].id

    # 1. إنشاء أمر التشغيل المجمع بـ 120 قطعة
    aggregate_payload = {
        "items": [
            {"customer_order_line_id": line_a.id, "allocated_quantity": 50.0},
            {"customer_order_line_id": line_b.id, "allocated_quantity": 70.0},
        ],
        "template_version_id": e["tpl_ver"].id,
        "notes": "أمر تشغيل مجمع للعميلين أ و ب",
    }
    agg_res = await pm.post("/api/v1/production/orders/aggregate", json=aggregate_payload)
    assert agg_res.status_code == 201, agg_res.text
    order_data = agg_res.json()
    order_id = order_data["id"]
    assert order_data["target_quantity"] == 120.0
    assert len(order_data["demands"]) == 2

    # التحقق من أن مجمع الطلبات (Demand Pool) يظهر الآن صفر كميات غير مخططة لهذين الطلبين
    pool_after = (await pm.get("/api/v1/production/demand-pool")).json()
    assert not any(i["customer_order_line_id"] == line_a.id for i in pool_after)
    assert not any(i["customer_order_line_id"] == line_b.id for i in pool_after)

    # 2. صرف الخامات من مخزن الخامات الرئيسي (120 × 2 = 240 متر)
    disp_res = await wh.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف خامات 240 متر"})
    assert disp_res.status_code == 200, disp_res.text

    # تأكيد استلام الورشة لكامل الخامات (240 متر)
    rcv_confirm = await pm.post(
        f"/api/v1/production/orders/{order_id}/receive",
        json={
            "received_lines": [{"item_id": fabric_id, "received_quantity": 240.0, "notes": "استلام كامل"}],
            "notes": "استلام بالورشة",
        },
    )
    assert rcv_confirm.status_code == 200, rcv_confirm.text

    # 3. إكمال مراحل الإنتاج الخمس (بدء ثم إكمال)
    for stage_name in ("cutting", "finishing", "snap_installation", "ironing", "packing"):
        stg_start = await pm.post(
            f"/api/v1/production/orders/{order_id}/stages/{stage_name}",
            json={"status": "in_progress", "notes": f"بدء {stage_name}"},
        )
        assert stg_start.status_code == 200, stg_start.text
        stg_res = await pm.post(
            f"/api/v1/production/orders/{order_id}/stages/{stage_name}",
            json={"status": "completed", "notes": f"اكتمال {stage_name}"},
        )
        assert stg_res.status_code == 200, stg_res.text

    # 4. استلام المنتج التام (120 قطعة) بمخزن المنتجات التامة
    fg_rcv_res = await wh.post(
        f"/api/v1/production/orders/{order_id}/finished-receipt",
        json={
            "accepted_quantity": 120.0,
            "rejected_quantity": 0.0,
            "notes": "استلام كامل المنتج التام المفكك",
        },
    )
    assert fg_rcv_res.status_code == 201, fg_rcv_res.text

    # 5. التحقق الحاسم من التفكيك التلقائي (Automatic De-aggregation):
    # رصيد العميل (أ) في سلة التام يجب أن يكون 50 قطعة بالضبط
    fg_wh_id = e["fg_wh"].id
    catalog_fg = await get_or_create_finished_goods_item(session, e["product"].id, e["variant"].id)
    assert catalog_fg is not None

    bal_cust_a = await stock_balance(session, catalog_fg.id, fg_wh_id, bucket_reference=f"private_label:{cust_a.id}")
    bal_cust_b = await stock_balance(session, catalog_fg.id, fg_wh_id, bucket_reference=f"private_label:{cust_b.id}")
    assert bal_cust_a == 50.0, f"رصيد العميل أ المتوقع 50، الفعلي: {bal_cust_a}"
    assert bal_cust_b == 70.0, f"رصيد العميل ب المتوقع 70، الفعلي: {bal_cust_b}"

    # التحقق من تحديث fulfilled_quantity في سجلات Demands
    demands_res = await pm.get(f"/api/v1/production/orders/{order_id}/demands")
    assert demands_res.status_code == 200
    demands_list = demands_res.json()
    dem_a = next(d for d in demands_list if d["customer_id"] == cust_a.id)
    dem_b = next(d for d in demands_list if d["customer_id"] == cust_b.id)
    assert dem_a["allocated_quantity"] == 50.0
    assert dem_a["fulfilled_quantity"] == 50.0
    assert dem_a["fulfillment_pct"] == 100.0
    assert dem_b["allocated_quantity"] == 70.0
    assert dem_b["fulfilled_quantity"] == 70.0
    assert dem_b["fulfillment_pct"] == 100.0

    # 6. تسليم العميل (أ) بضاعته عبر سند CustomerDelivery بـ 50 قطعة
    delivery_payload = {
        "received_by": "مندوب العميل أ",
        "notes": "تسليم كامل حصة العميل أ",
        "lines": [
            {
                "order_line_id": line_a.id,
                "quantity": 50.0,
            }
        ],
    }
    deliv_res = await wh.post(f"/api/v1/customers/{cust_a.id}/orders/{e['order_a'].id}/deliveries", json=delivery_payload)
    assert deliv_res.status_code == 201, deliv_res.text

    # التحقق من أن رصيد سلة العميل (أ) أصبح صفر بعد التسليم
    bal_cust_a_after = await stock_balance(session, catalog_fg.id, fg_wh_id, bucket_reference=f"private_label:{cust_a.id}")
    assert bal_cust_a_after == 0.0

    # والتحقق من أن رصيد سلة العميل (ب) ظل كما هو 70 قطعة ولم يتأثر إطلاقاً
    bal_cust_b_after = await stock_balance(session, catalog_fg.id, fg_wh_id, bucket_reference=f"private_label:{cust_b.id}")
    assert bal_cust_b_after == 70.0
