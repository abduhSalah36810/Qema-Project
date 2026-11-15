"""
اختبارات تكامل خامات التصنيع للغير (CMT) مع دفاتر المخزون وقيود التكلفة (Phase 2).
─────────────────────────────────────────────────────────────────────────────
تغطي بدقة:
1. سندات استلام خامات العملاء (CMR) وتوليد قيود StockLedgerEntry في مخزن الخامات الرئيسي
   بحاوية أمانة العميل customer_deposit:{customer_id} بتكلفة مالية صفرية (MFG-DEC-02).
2. حماية متوسط التكلفة المرجح للمصنع (WAC) وعدم تخفيفه أو تلويثه بخامات أمانة العملاء.
3. فصل الأرصدة ومنع صرف خامات العميل إلا من حاوية أمانته، ومنع صرف خامات المصنع إلا من رصيد المصنع العام.
4. دورة التحويل والصرف للورشة (dispatch_order_materials): خصم حاوية العميل وصفرية قيود الترانزيت.
5. استلام الورشة (confirm_warehouse_receipt): قصر القيود المحاسبية (1220/1210) على مستلزمات المصنع فقط
   دون تحميل أي قيود دفترية على خامات العميل.
6. تسوية الورشة (reconcile_order_materials) وانحراف الهالك (1.5%): تحديث استهلاك وهالك سطر CMR
   واحتساب انحراف الهالك الزائد دون غرامة تلقائية.
7. استلام مرتجع الخامات بالمخزن (receive_return): عودة خامات العميل إلى حاوية أمانته customer_deposit:{customer_id}.
8. إرجاع الخامات للعميل (CRET): التحقق من توفر الرصيد الفعلي بمخزن الخامات، وتصفير رصيد الأمانة في الدفتر وسطر CMR.
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
from app.modules.customers.models import Customer
from app.modules.finance.models import JournalEntry, JournalEntryLine
from app.modules.finance.ledger_service import get_weighted_average_cost
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
    StockLedgerEntry,
    Unit,
    Warehouse,
    WarehouseTransfer,
)
from app.modules.production.stock import stock_balance, customer_deposit_bucket

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

    # التأكد من وجود المخازن الأساسية
    raw_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one()
    wip_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "work_in_progress"))).scalar_one()
    fg_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "finished_goods"))).scalar_one()

    # إنشاء وحدة قياس
    unit = Unit(id=_uid(), name_ar="متر طولي", code=f"MTR-{_uid()[:4]}")
    session.add(unit)

    # إنشاء عميل تصنيع للغير
    customer = Customer(
        id=_uid(),
        code=f"CST-{_uid()[:5]}",
        name="مجموعة النور للتوريدات",
        phone="01122334455",
        status="active",
    )
    session.add(customer)

    # إنشاء خامة قماش العميل (raw_material)
    fabric = CatalogItem(
        id=_uid(),
        code=f"CM-FAB-{_uid()[:5]}",
        name_ar="قماش جبردين عسكري قطن 100%",
        item_type="raw_material",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    # إنشاء مستلزم خيط للمصنع (accessory)
    thread = CatalogItem(
        id=_uid(),
        code=f"FM-THRD-{_uid()[:5]}",
        name_ar="بكرة خيط نايلون معالج 40/2",
        item_type="accessory",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    session.add_all([fabric, thread])

    # إنشاء موديل وقالب تصنيع
    product = Product(id=_uid(), code=f"PRD-{_uid()[:5]}", name_ar="بدلة عمل صيفية", style_type="coverall")
    session.add(product)
    await session.flush()

    variant = ProductVariant(
        id=_uid(), product_id=product.id, numeric_size=52, letter_size="XL", season="summer", sku=f"SKU-{_uid()[:5]}", is_active=True
    )
    session.add(variant)

    template = ProductionTemplate(
        id=_uid(), code=f"TPL-{_uid()[:5]}", name_ar="قالب بدلة عمل", product_id=product.id, variant_id=variant.id, is_active=True
    )
    session.add(template)
    await session.flush()

    version = ProductionTemplateVersion(
        id=_uid(), template_id=template.id, version_number=1, status="approved", reference_quantity=100.0, notes=""
    )
    session.add(version)
    await session.flush()

    # القالب: 1.5 متر قماش لكل بدلة (150 متر لكل 100 بدلة) + 0.1 بكرة خيط لكل بدلة (10 بكر لكل 100 بدلة)
    line1 = ProductionTemplateLine(
        id=_uid(), version_id=version.id, item_id=fabric.id, unit_id=unit.id, quantity_per_reference=150.0
    )
    line2 = ProductionTemplateLine(
        id=_uid(), version_id=version.id, item_id=thread.id, unit_id=unit.id, quantity_per_reference=10.0
    )
    session.add_all([line1, line2])
    await session.commit()

    env = {
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "fg_wh": fg_wh,
        "unit": unit,
        "customer": customer,
        "fabric": fabric,
        "thread": thread,
        "product": product,
        "variant": variant,
        "template_version": version,
        "wh_user": wh_user,
        "pm_user": pm_user,
        "gm_user": gm_user,
    }
    yield env
    await client.aclose()
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_full_external_manufacturing_customer_material_lifecycle(session: AsyncSession, setup_env: dict):
    """
    اختبار دورة كاملة وشاملة لخامات التصنيع للغير (Phase 2):
    1. استلام خامة العميل أمانة (CMR) والتأكد من القيد المخزني وحاوية الأمانة.
    2. عزل رصيد المصنع وتأكيد عدم تأثر WAC.
    3. صرف الخامات للأمر مع التحقق من الرصيد والمنع عند عدم الكفاية.
    4. استلام الورشة والتحقق من قصر القيود المحاسبية على مستلزمات المصنع فقط.
    5. تسوية الورشة وتطبيق قاعدة الـ 1.5% للهالك الزائد وتحديث CMR.
    6. استلام المرتجع لمخزن الخامات وإعادته لحاوية أمانة العميل.
    7. إرجاع المتبقي للعميل (CRET) والتحقق من تصفير الرصيد المخزني والدفتري.
    """
    e = setup_env
    wh, pm = e["wh_user"], e["pm_user"]
    customer_id = e["customer"].id
    fabric_id = e["fabric"].id
    thread_id = e["thread"].id
    cust_bucket = customer_deposit_bucket(customer_id)

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 1: استلام 500 متر قماش أمانة من العميل (CMR)
    # ─────────────────────────────────────────────────────────────────────────
    cmr_payload = {
        "customer_id": customer_id,
        "lines": [
            {
                "item_id": fabric_id,
                "unit_id": e["unit"].id,
                "quantity_received": "500.000",
                "unit_cost_estimate": "150.0000",
                "notes": "قماش مورد لتشغيل 200 بدلة عمل",
            }
        ],
        "notes": "استلام أمانة بمخزن الخامات",
    }
    res = await wh.post("/api/v1/production/customer-materials/receipts", json=cmr_payload)
    assert res.status_code == 201, res.text
    cmr_data = res.json()
    receipt_id = cmr_data["id"]
    receipt_line_id = cmr_data["lines"][0]["id"]
    assert cmr_data["receipt_number"].startswith("CMR-")

    # التحقق من وجود قيد StockLedgerEntry في مخزن الخامات بحاوية الأمانة
    fabric_deposit_bal = await stock_balance(session, fabric_id, e["raw_wh"].id, bucket_reference=cust_bucket)
    assert fabric_deposit_bal == 500.0

    # التحقق من أن رصيد المصنع العام للقماش (حاوية None) = 0.0
    fabric_factory_bal = await stock_balance(session, fabric_id, e["raw_wh"].id, bucket_reference=None)
    assert fabric_factory_bal == 0.0

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 2: إضافة خامات ومستلزمات مملوكة للمصنع والتحقق من عزل WAC
    # ─────────────────────────────────────────────────────────────────────────
    # إضافة 100 متر قماش مملوكة للمصنع بسعر 80 ج.م
    session.add(StockLedgerEntry(
        id=_uid(), item_id=fabric_id, unit_id=e["unit"].id, warehouse_id=e["raw_wh"].id,
        location_type="warehouse", bucket_reference=None, quantity=100.0,
        reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_uid()[:4]}",
        entry_type="opening_balance", created_by="admin",
        unit_cost=Decimal("80.0000"), total_cost=Decimal("8000.00"),
    ))
    # إضافة 50 بكرة خيط للمصنع بسعر 25 ج.م
    session.add(StockLedgerEntry(
        id=_uid(), item_id=thread_id, unit_id=e["unit"].id, warehouse_id=e["raw_wh"].id,
        location_type="warehouse", bucket_reference=None, quantity=50.0,
        reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_uid()[:4]}",
        entry_type="opening_balance", created_by="admin",
        unit_cost=Decimal("25.0000"), total_cost=Decimal("1250.00"),
    ))
    await session.commit()

    # التحقق من أن متوسط التكلفة المرجح لقماش المصنع هو 80.0000 ج.م ولم يتأثر بالـ 500 متر الصفرية
    wac_fabric = await get_weighted_average_cost(session, fabric_id, e["raw_wh"].id)
    assert wac_fabric == Decimal("80.0000")

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 3: إنشاء أمر تصنيع للغير (200 بدلة) ومحاولة الصرف
    # ─────────────────────────────────────────────────────────────────────────
    # المطلوب: 200 بدلة × 1.5 متر قماش = 300 متر (خامة عميل)
    # المطلوب: 200 بدلة × 0.1 خيط = 20 بكرة خيط (مستلزم مصنع)
    order_res = await pm.post(
        "/api/v1/production/orders",
        json={
            "product_id": e["product"].id,
            "variant_id": e["variant"].id,
            "template_version_id": e["template_version"].id,
            "target_quantity": 200,
            "season": "summer",
            "manufacturing_type": "external",
            "customer_id": customer_id,
            "allowed_waste_pct": "1.50",
            "notes": "أمر تشغيل بدلات للغير",
        },
    )
    assert order_res.status_code == 201, order_res.text
    order_data = order_res.json()
    order_id = order_data["id"]

    # التحقق من تحديد ملكية المواد تلقائياً: القماش = customer، الخيط = factory
    fab_ord_mat = next(m for m in order_data["materials"] if m["item_id"] == fabric_id)
    thread_ord_mat = next(m for m in order_data["materials"] if m["item_id"] == thread_id)
    assert fab_ord_mat["supplied_by"] == "customer"
    assert thread_ord_mat["supplied_by"] == "factory"
    assert fab_ord_mat["planned_quantity"] == 300.0
    assert thread_ord_mat["planned_quantity"] == 20.0

    # صرف الخامات للأمر بواسطة أمين المخزن
    dispatch_res = await wh.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف خامات أمر 200 بدلة"})
    assert dispatch_res.status_code == 200, dispatch_res.text
    dispatch_data = dispatch_res.json()
    assert dispatch_data["status"] == "in_transit"
    transfer_id = dispatch_data["id"]

    # التحقق من أن حاوية أمانة العميل خُصم منها 300 متر، والرصيد المتبقي بمخزن الخامات أصبح 200 متر
    fabric_deposit_bal_after = await stock_balance(session, fabric_id, e["raw_wh"].id, bucket_reference=cust_bucket)
    assert fabric_deposit_bal_after == 200.0

    # التحقق من أن رصيد قماش المصنع لم يُمَس إطلاقاً (ما زال 100 متر)
    fabric_factory_bal_after = await stock_balance(session, fabric_id, e["raw_wh"].id, bucket_reference=None)
    assert fabric_factory_bal_after == 100.0

    # التحقق من أن خيط المصنع خُصم من الرصيد العام للمصنع (50 - 20 = 30)
    thread_factory_bal_after = await stock_balance(session, thread_id, e["raw_wh"].id, bucket_reference=None)
    assert thread_factory_bal_after == 30.0

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 4: تأكيد استلام الورشة (WIP) والتحقق من قيود اليومية
    # ─────────────────────────────────────────────────────────────────────────
    # مسؤول الإنتاج يؤكد استلام 300 متر قماش و 20 خيط بالورشة
    confirm_payload = {
        "received_lines": [
            {"item_id": fabric_id, "received_quantity": 300.0, "notes": "استلام كامل"},
            {"item_id": thread_id, "received_quantity": 20.0, "notes": "استلام كامل"},
        ],
        "notes": "استلام كامل بالورشة",
    }
    rcv_confirm_res = await pm.post(f"/api/v1/production/orders/{order_id}/receive", json=confirm_payload)
    assert rcv_confirm_res.status_code == 200, rcv_confirm_res.text

    # التحقق من أن رصيد الورشة (WIP) بحاوية الأمر أصبح 300 قماش و 20 خيط
    wip_bucket = f"order:{order_id}"
    wip_fab = await stock_balance(session, fabric_id, e["wip_wh"].id, bucket_reference=wip_bucket)
    wip_thread = await stock_balance(session, thread_id, e["wip_wh"].id, bucket_reference=wip_bucket)
    assert wip_fab == 300.0
    assert wip_thread == 20.0

    # التحقق من القيود المحاسبية للتحويل:
    # القماش (خامة عميل): تكلفته 0، لا يوجد قيد محاسبي يخصه.
    # الخيط (مصنع): 20 بكرة × 25 ج.م = 500 ج.م -> Dr 1220 (500) / Cr 1210 (500)
    je_stmt = select(JournalEntry).options(selectinload(JournalEntry.lines)).where(JournalEntry.source_doc_id == transfer_id)
    je = (await session.execute(je_stmt)).scalar_one_or_none()
    assert je is not None
    total_debit = sum(line.debit for line in je.lines)
    total_credit = sum(line.credit for line in je.lines)
    assert total_debit == Decimal("500.00")
    assert total_credit == Decimal("500.00")

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 5: تسوية خامات الورشة (Reconciliation) وتطبيق سقف الهالك 1.5%
    # ─────────────────────────────────────────────────────────────────────────
    # التشغيل الفعلي لـ 200 بدلة:
    # القماش: 285 متر مستهلك فعلياً + 5 أمتار هالك + 10 أمتار مرتجع لمخزن الخامات (المجموع 300)
    # الخيط: 20 بكرة مستهلك بالكامل
    recon_payload = {
        "lines": [
            {
                "item_id": fabric_id,
                "consumed_quantity": 285.0,
                "scrapped_quantity": 5.0,
                "returned_quantity": 10.0,
                "return_condition": "good",
                "notes": "فائض توب قماش سليم يعاد للخامات",
            },
            {
                "item_id": thread_id,
                "consumed_quantity": 20.0,
                "scrapped_quantity": 0.0,
                "returned_quantity": 0.0,
                "return_condition": "good",
                "notes": "استهلاك الخيط بالكامل",
            },
        ],
        "notes": "تسوية نهاية التشغيل",
    }
    recon_res = await pm.post(f"/api/v1/production/orders/{order_id}/material-reconciliations", json=recon_payload)
    assert recon_res.status_code == 201, recon_res.text
    recon_data = recon_res.json()
    assert recon_data["return_transfer_id"] is not None
    return_transfer_id = recon_data["return_transfer_id"]

    # فحص انحراف الهالك على الأمر:
    # إجمالي المستهلك = 285 (قماش) + 20 (خيط) = 305
    # الهالك المسموح به (1.5%) = 305 × 0.015 = 4.575
    # الهالك الفعلي = 5.000
    # الهالك الزائد = 5.000 - 4.575 = 0.425
    ord_check = await session.get(ProductionOrder, order_id)
    assert ord_check.excess_waste_qty == Decimal("0.425")
    assert ord_check.actual_waste_pct > Decimal("1.50")

    # فحص سطر سند استلام العميل (CMR Line):
    # خُصم منه 285 مستهلك و 5 هالك = 290
    # الرصيد المتبقي لصالح العميل من السند = 500 - 290 = 210 أمتار
    cmr_line_check = await session.get(CustomerMaterialReceiptLine, receipt_line_id)
    assert cmr_line_check.quantity_consumed == Decimal("285.000")
    assert cmr_line_check.quantity_wasted == Decimal("5.000")
    assert cmr_line_check.quantity_remaining == Decimal("210.000")

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 6: استلام المرتجع بمخزن الخامات (receive_return)
    # ─────────────────────────────────────────────────────────────────────────
    # أمين المخزن يستلم الـ 10 أمتار المرتجعة من الورشة بالكامل
    ret_rcv_payload = {
        "lines": [
            {
                "item_id": fabric_id,
                "accepted_quantity": 10.0,
                "rejected_quantity": 0.0,
                "notes": "قماش سليم ومطابق",
            }
        ],
        "notes": "استلام مرتجع الورشة",
    }
    ret_rcv_res = await wh.post(
        f"/api/v1/production/orders/{order_id}/returns/{return_transfer_id}/receive",
        json=ret_rcv_payload,
    )
    assert ret_rcv_res.status_code == 200, ret_rcv_res.text

    # التحقق من أن الـ 10 أمتار دخلت حاوية أمانة العميل customer_deposit:{customer_id}
    # الرصيد السابق كان 200 + 10 مرتجع = 210 متر!
    fabric_deposit_bal_after_ret = await stock_balance(session, fabric_id, e["raw_wh"].id, bucket_reference=cust_bucket)
    assert fabric_deposit_bal_after_ret == 210.0

    # التحقق من عدم إنشاء أي قيود محاسبية على مرتجع خامة العميل (لأن تكلفتها 0)
    ret_je = (await session.execute(
        select(JournalEntry).where(JournalEntry.source_doc_id == return_transfer_id)
    )).scalar_one_or_none()
    assert ret_je is None

    # ─────────────────────────────────────────────────────────────────────────
    # خطوة 7: إرجاع الخامات المتبقية للعميل (Customer Material Return - CRET)
    # ─────────────────────────────────────────────────────────────────────────
    # محاولة إرجاع كمية أكبر من المتاح بمخزن الخامات أو سطر الاستلام (250 متر والمتاح 210) -> رفض 422
    bad_ret = await wh.post(
        "/api/v1/production/customer-materials/returns",
        json={
            "customer_id": customer_id,
            "receipt_line_id": receipt_line_id,
            "quantity": "250.000",
            "notes": "محاولة إرجاع كمية أكبر من المتبقي",
        },
    )
    assert bad_ret.status_code == 422

    # إرجاع كامل الرصيد المتبقي (210 أمتار) للعميل
    good_ret = await wh.post(
        "/api/v1/production/customer-materials/returns",
        json={
            "customer_id": customer_id,
            "receipt_line_id": receipt_line_id,
            "quantity": "210.000",
            "notes": "إرجاع كامل رصيد القماش المتبقي للعميل بعد اكتمال التشغيل",
        },
    )
    assert good_ret.status_code == 201, good_ret.text
    cret_data = good_ret.json()
    assert cret_data["return_number"].startswith("CRET-")
    assert Decimal(str(cret_data["quantity"])) == Decimal("210.000")

    # التحقق من تصفير رصيد حاوية أمانة العميل في مخزن الخامات تماماً (0.0 متر)
    final_cust_bal = await stock_balance(session, fabric_id, e["raw_wh"].id, bucket_reference=cust_bucket)
    assert final_cust_bal == 0.0

    # التحقق من أن سطر سند الاستلام (CMR Line) تصفّر بالكامل
    await session.refresh(cmr_line_check)
    assert cmr_line_check.quantity_returned == Decimal("210.000")
    assert cmr_line_check.quantity_remaining == Decimal("0.000")

    # التحقق من تقرير أرصدة خامات العميل النهائي
    final_report_res = await pm.get(f"/api/v1/production/customer-materials/balance?customer_id={customer_id}")
    assert final_report_res.status_code == 200
    report_items = final_report_res.json()
    fab_rep = next(r for r in report_items if r["item_id"] == fabric_id)
    assert Decimal(str(fab_rep["total_received"])) == Decimal("500.000")
    assert Decimal(str(fab_rep["total_consumed"])) == Decimal("285.000")
    assert Decimal(str(fab_rep["total_wasted"])) == Decimal("5.000")
    assert Decimal(str(fab_rep["total_returned"])) == Decimal("210.000")
    assert Decimal(str(fab_rep["current_balance"])) == Decimal("0.000")
    assert fab_rep["active_receipt_lines_count"] == 0


@pytest.mark.asyncio
async def test_dispatch_fails_when_customer_deposit_insufficient(session: AsyncSession, setup_env: dict):
    """
    اختبار منع صرف خامات العميل إذا كان رصيد أمانته غير كافٍ،
    حتى لو كان رصيد المصنع العام لنفس الخامة وافرًا (منع السطو على خامات المصنع أو الخلط).
    """
    e = setup_env
    wh, pm = e["wh_user"], e["pm_user"]
    customer_id = e["customer"].id
    fabric_id = e["fabric"].id
    thread_id = e["thread"].id

    # 1. المصنع يمتلك 10,000 متر قماش
    session.add(StockLedgerEntry(
        id=_uid(), item_id=fabric_id, unit_id=e["unit"].id, warehouse_id=e["raw_wh"].id,
        location_type="warehouse", bucket_reference=None, quantity=10000.0,
        reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_uid()[:4]}",
        entry_type="opening_balance", created_by="admin",
        unit_cost=Decimal("100.0000"), total_cost=Decimal("1000000.00"),
    ))
    # المصنع يمتلك 100 خيط
    session.add(StockLedgerEntry(
        id=_uid(), item_id=thread_id, unit_id=e["unit"].id, warehouse_id=e["raw_wh"].id,
        location_type="warehouse", bucket_reference=None, quantity=100.0,
        reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_uid()[:4]}",
        entry_type="opening_balance", created_by="admin",
        unit_cost=Decimal("20.0000"), total_cost=Decimal("2000.00"),
    ))
    # العميل أودع فقط 50 مترًا أمانة
    cmr_res = await wh.post(
        "/api/v1/production/customer-materials/receipts",
        json={
            "customer_id": customer_id,
            "lines": [
                {
                    "item_id": fabric_id,
                    "unit_id": e["unit"].id,
                    "quantity_received": "50.000",
                    "unit_cost_estimate": "120.0000",
                }
            ],
            "notes": "إيداع جزئي",
        },
    )
    assert cmr_res.status_code == 201

    # 2. إنشاء أمر تشغيل خارجي يطلب 150 متر قماش (أكبر من أمانة العميل 50 مترًا)
    order_res = await pm.post(
        "/api/v1/production/orders",
        json={
            "product_id": e["product"].id,
            "variant_id": e["variant"].id,
            "template_version_id": e["template_version"].id,
            "target_quantity": 100,  # 100 × 1.5 = 150 متر قماش
            "season": "summer",
            "manufacturing_type": "external",
            "customer_id": customer_id,
        },
    )
    assert order_res.status_code == 201
    order_id = order_res.json()["id"]

    # 3. محاولة صرف الخامات: يجب أن تفشل بحالة 409 وتذكر عجز أمانة العميل صراحة
    # رغم وجود 10,000 متر في رصيد المصنع!
    disp_res = await wh.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "محاولة صرف"})
    assert disp_res.status_code == 409
    err = disp_res.json()["detail"]
    assert "أمانة العميل" in err
    assert "المتاح 50" in err or "50" in err


@pytest.mark.asyncio
async def test_factory_internal_order_never_consumes_customer_deposits(session: AsyncSession, setup_env: dict):
    """
    اختبار منع أوامر التصنيع الداخلي (internal) من صرف أي خامات مودعة كأمانة لعميل،
    حتى لو كان رصيد المصنع العام صفرًا (منع استيلاء المصنع على خامات العملاء).
    """
    e = setup_env
    wh, pm = e["wh_user"], e["pm_user"]
    customer_id = e["customer"].id
    fabric_id = e["fabric"].id
    thread_id = e["thread"].id

    # 1. العميل يودع 2,000 متر قماش أمانة
    cmr_res = await wh.post(
        "/api/v1/production/customer-materials/receipts",
        json={
            "customer_id": customer_id,
            "lines": [
                {
                    "item_id": fabric_id,
                    "unit_id": e["unit"].id,
                    "quantity_received": "2000.000",
                    "unit_cost_estimate": "120.0000",
                }
            ],
            "notes": "أمانة عميل كبيرة",
        },
    )
    assert cmr_res.status_code == 201

    # المصنع يمتلك 100 خيط فقط، ورصيد المصنع من القماش = 0.0
    session.add(StockLedgerEntry(
        id=_uid(), item_id=thread_id, unit_id=e["unit"].id, warehouse_id=e["raw_wh"].id,
        location_type="warehouse", bucket_reference=None, quantity=100.0,
        reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_uid()[:4]}",
        entry_type="opening_balance", created_by="admin",
        unit_cost=Decimal("20.0000"), total_cost=Decimal("2000.00"),
    ))
    await session.commit()

    # 2. إنشاء أمر تشغيل داخلي لحساب المصنع (manufacturing_type = "internal")
    order_res = await pm.post(
        "/api/v1/production/orders",
        json={
            "product_id": e["product"].id,
            "variant_id": e["variant"].id,
            "template_version_id": e["template_version"].id,
            "target_quantity": 50,  # يتطلب 75 متر قماش
            "season": "summer",
            "manufacturing_type": "internal",
        },
    )
    assert order_res.status_code == 201
    order_id = order_res.json()["id"]

    # 3. محاولة صرف الخامات: يجب أن تفشل بحالة 409 وتذكر مخزون المصنع صراحة
    # ولا تمس الـ 2,000 متر الخاصة بالعميل!
    disp_res = await wh.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "محاولة صرف لأمر داخلي"})
    assert disp_res.status_code == 409
    err = disp_res.json()["detail"]
    assert "مخزون المصنع" in err
    assert "المتاح 0" in err or "0" in err
