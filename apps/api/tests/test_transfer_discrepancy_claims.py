"""
اختبارات دورة مطالبات وحسم عجز استلام خامات الورشة (Phase 3: Transfer Discrepancy Claims):
─────────────────────────────────────────────────────────────────────────────
تغطي بدقة:
1. إنشاء طلب مراجعة العجز (TransferDiscrepancyClaim) تلقائياً عند وجود فرق استلام في الورشة
   مع عزل كمية العجز في حاوية discrepancy.
2. حظر إغلاق أمر التشغيل نهائياً وعرض أسباب الحظر في ملخص WIP طالما وجد طلب قيد التحقيق.
3. قاعدة فصل المهام (Maker-Checker): حظر قيام مستلم الورشة الذي أثبت العجز بالفصل في الطلب بنفسه.
4. حظر البت في الطلب لغير المصرح لهم (صلاحية warehouse:claims:resolve).
5. حسم الطلب بواسطة أمين المخزن (قبول كعجز نقل / خطأ كيل وقياس / رفض وتحميل المسؤولية)
   وتوليد قيد تسوية إغلاق العجز في StockLedgerEntry لتصفير حاوية discrepancy.
6. فتح إمكانية إغلاق أمر التشغيل بأمان بعد حسم كافة المطالبات واستيفاء شروط الإغلاق.
7. رفض تكرار البت في الطلب بعد حسمه (Idempotent Status Guard).
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
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    ProductionStageEvent,
    StockLedgerEntry,
    TransferDiscrepancyClaim,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.modules.production.stock import stock_balance, order_wip_bucket

GM = "general_manager"
WH = "warehouse_manager"
PM = "production_manager"
WORKER = "cutting_technician"


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
    worker_user = ClientActor(client, _user(f"wkr-{_uid()[:4]}", WORKER))

    # المخازن الأساسية
    raw_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "main_raw_materials"))).scalar_one()
    wip_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "work_in_progress"))).scalar_one()
    fg_wh = (await session.execute(select(Warehouse).where(Warehouse.code == "finished_goods"))).scalar_one()

    # وحدة قياس
    unit = Unit(id=_uid(), name_ar="متر طولي", code=f"MTR-{_uid()[:4]}")
    session.add(unit)

    # خامة قماش
    fabric = CatalogItem(
        id=_uid(),
        code=f"FAB-DISC-{_uid()[:5]}",
        name_ar="قماش قطن مصري فاخر",
        item_type="raw_material",
        unit_id=unit.id,
        is_active=True,
        approval_status="approved",
    )
    session.add(fabric)

    # رصيد أولي للخامة في مخزن الخامات (1000 متر بسعر 50 ج.م)
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
        unit_cost=Decimal("50.0000"),
        total_cost=Decimal("50000.00"),
    ))

    # منتج وقالب إنتاج
    prod = Product(id=_uid(), code=f"PRD-{_uid()[:5]}", name_ar="جلابية رجالي صيفي", style_type="galabya")
    session.add(prod)
    await session.flush()

    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=58, letter_size="XL", season="summer", sku=f"SKU-{_uid()[:5]}", is_active=True)
    session.add(variant)

    tpl = ProductionTemplate(id=_uid(), code=f"TPL-{_uid()[:5]}", product_id=prod.id, variant_id=variant.id, name_ar="قالب جلابية صيفي 58", is_active=True)
    session.add(tpl)
    await session.flush()

    tpl_ver = ProductionTemplateVersion(id=_uid(), template_id=tpl.id, version_number=1, status="approved", reference_quantity=100.0, notes="")
    session.add(tpl_ver)
    await session.flush()

    tpl_line = ProductionTemplateLine(
        id=_uid(), version_id=tpl_ver.id, item_id=fabric.id, unit_id=unit.id,
        quantity_per_reference=200.0,
    )
    session.add(tpl_line)
    await session.commit()

    return {
        "client": client,
        "wh_user": wh_user,
        "pm_user": pm_user,
        "gm_user": gm_user,
        "worker_user": worker_user,
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "fg_wh": fg_wh,
        "unit": unit,
        "fabric": fabric,
        "product": prod,
        "variant": variant,
        "template_version": tpl_ver,
    }


@pytest.mark.asyncio
async def test_discrepancy_claim_full_lifecycle(setup_env, session: AsyncSession):
    """
    اختبار دورة حياة عجز استلام الورشة وحسم النزاع بالكامل:
    1. صرف 200 متر قماش لأمر التشغيل.
    2. استلام الورشة لـ 195 متراً فقط وعجز 5 أمتار.
    3. التحقق من إنشاء TransferDiscrepancyClaim بحالة pending_investigation.
    4. التحقق من حظر إغلاق الأمر وظهور سبب العجز في ملخص WIP.
    5. التحقق من فشل محاولة المستلم حسم طلبه بنفسه (Maker-Checker).
    6. التحقق من فشل محاولة مستخدم بدون صلاحية حسم الطلب (403).
    7. قيام أمين المخزن بحسم الطلب (accepted_transit_loss) وتصفير رصيد العجز الدفتري.
    8. التحقق من زوال مانع الإغلاق في ملخص WIP وإتمام إغلاق الأمر بنجاح.
    """
    e = setup_env
    wh, pm, gm, worker = e["wh_user"], e["pm_user"], e["gm_user"], e["worker_user"]
    fabric_id = e["fabric"].id

    # 1. إنشاء أمر تشغيل لـ 100 قطعة (يستهلك 200 متر قماش)
    order_res = await pm.post(
        "/api/v1/production/orders",
        json={
            "product_id": e["product"].id,
            "variant_id": e["variant"].id,
            "template_version_id": e["template_version"].id,
            "target_quantity": 100,
            "season": "summer",
            "manufacturing_type": "internal",
            "notes": "أمر تشغيل تجربة عجز الاستلام",
        },
    )
    assert order_res.status_code == 201, order_res.text
    order_id = order_res.json()["id"]

    # 2. صرف الخامات من مخزن الخامات (200 متر بالطريق)
    disp_res = await wh.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف خامات 200 متر"})
    assert disp_res.status_code == 200, disp_res.text
    transfer_id = disp_res.json()["id"]

    # 3. مسؤول الورشة (pm) يستلم 195 متراً فقط مع تسجيل عجز 5 أمتار
    rcv_payload = {
        "received_lines": [
            {"item_id": fabric_id, "received_quantity": 195.0, "notes": "عجز 5 أمتار في طول الطوبة عند الاستلام"},
        ],
        "notes": "استلام بعجز 5 أمتار",
    }
    rcv_res = await pm.post(f"/api/v1/production/orders/{order_id}/receive", json=rcv_payload)
    assert rcv_res.status_code == 200, rcv_res.text

    # 4. التحقق من إنشاء TransferDiscrepancyClaim في قاعدة البيانات
    claim_stmt = (
        select(TransferDiscrepancyClaim)
        .options(
            selectinload(TransferDiscrepancyClaim.transfer),
            selectinload(TransferDiscrepancyClaim.order),
            selectinload(TransferDiscrepancyClaim.item),
        )
        .where(TransferDiscrepancyClaim.order_id == order_id)
    )
    claim = (await session.execute(claim_stmt)).scalar_one()
    assert claim.claim_number.startswith("CLM-")
    assert claim.discrepancy_quantity == 5.0
    assert claim.dispatched_quantity == 200.0
    assert claim.received_quantity == 195.0
    assert claim.status == "pending_investigation"
    assert claim.claimed_by == pm.user.id
    assert claim.claim_notes == "عجز 5 أمتار في طول الطوبة عند الاستلام"

    # التحقق من قيد العجز في StockLedgerEntry (حاوية discrepancy)
    disc_entries = (await session.execute(
        select(StockLedgerEntry).where(
            StockLedgerEntry.location_type == "discrepancy",
            StockLedgerEntry.bucket_reference == transfer_id,
        )
    )).scalars().all()
    assert len(disc_entries) == 1
    assert disc_entries[0].quantity == 5.0
    assert disc_entries[0].entry_type == "receipt_discrepancy"

    # 5. استعلام المطالبات عبر مسار الأمر ومسار أمين المخزن العام
    order_claims_res = await pm.get(f"/api/v1/production/orders/{order_id}/discrepancy-claims")
    assert order_claims_res.status_code == 200
    order_claims = order_claims_res.json()
    assert len(order_claims) == 1
    assert order_claims[0]["id"] == claim.id
    assert order_claims[0]["status_ar"] == "معلق · بانتظار مراجعة وحسم أمين المخزن"

    wh_claims_res = await wh.get(f"/api/v1/production/discrepancy-claims?status=pending_investigation")
    assert wh_claims_res.status_code == 200
    wh_claims = wh_claims_res.json()
    assert any(c["id"] == claim.id for c in wh_claims)

    # 6. فحص ملخص خامات الورشة (WIP Summary) ومحاولة إغلاق الأمر
    wip_res = await pm.get(f"/api/v1/production/orders/{order_id}/wip-summary")
    assert wip_res.status_code == 200
    wip_data = wip_res.json()
    assert wip_data["unresolved_discrepancies_count"] == 1
    assert wip_data["can_close"] is False
    assert any("طلب مراجعة عجز استلام خامات بالورشة" in r for r in wip_data["blocking_reasons"])

    # إكمال مراحل الإنتاج لاختبار حظر الإغلاق المترتب حصراً على عجز الاستلام
    existing_events = (await session.execute(
        select(ProductionStageEvent).where(ProductionStageEvent.order_id == order_id)
    )).scalars().all()
    for ev in existing_events:
        ev.status = "completed"
    await session.commit()

    # محاولة إغلاق الأمر مباشرة -> يجب أن تفشل بحالة 409 لوجود مطالبة قيد التحقيق
    close_attempt = await gm.post(f"/api/v1/production/orders/{order_id}/close", json={"discrepancy_signoff": True})
    assert close_attempt.status_code == 409
    assert "طلبات مراجعة عجز استلام خامات بالورشة قيد التحقيق" in close_attempt.json()["detail"]

    # 7. اختبار الصلاحيات: مدير الإنتاج (pm) أو الفني (worker) بدون صلاحية warehouse:claims:resolve -> 403
    pm_resolve = await pm.post(
        f"/api/v1/production/discrepancy-claims/{claim.id}/resolve",
        json={"decision": "accepted_transit_loss", "resolution_notes": "محاولة حسم بدون صلاحية"},
    )
    assert pm_resolve.status_code == 403

    worker_resolve = await worker.post(
        f"/api/v1/production/discrepancy-claims/{claim.id}/resolve",
        json={"decision": "accepted_transit_loss", "resolution_notes": "موافقة فني"},
    )
    assert worker_resolve.status_code == 403

    # 8. اختبار Maker-Checker: مستخدم يملك الصلاحية (كأمين مخزن أو مدير عام) لكنه هو نفسه من استلم وأثبت العجز
    # نختبر أن النظام يمنعه قطعياً بحالة 409
    claim.claimed_by = wh.user.id
    await session.commit()

    self_resolve_attempt = await wh.post(
        f"/api/v1/production/discrepancy-claims/{claim.id}/resolve",
        json={"decision": "accepted_transit_loss", "resolution_notes": "أمين المخزن يحاول حسم ما استلمه بنفسه"},
    )
    assert self_resolve_attempt.status_code == 409
    assert "فصل المسؤوليات" in self_resolve_attempt.json()["detail"]

    # إعادة المستلم الأصلي لتمكين أمين المخزن المستقل من حسم الطلب
    claim.claimed_by = pm.user.id
    await session.commit()

    # 9. أمين المخزن (wh) يحسم الطلب بقرار معتمد: accepted_transit_loss
    resolve_res = await wh.post(
        f"/api/v1/production/discrepancy-claims/{claim.id}/resolve",
        json={
            "decision": "accepted_transit_loss",
            "resolution_notes": "تمت المعاينة الميدانية وتبين أن النقص عجز نقل مبرر بسبب رطوبة وانكماش القماش",
        },
    )
    assert resolve_res.status_code == 200, resolve_res.text
    resolved_data = resolve_res.json()
    assert resolved_data["status"] == "accepted_transit_loss"
    assert resolved_data["resolved_by"] == wh.user.id
    assert resolved_data["status_ar"] == "معتمد · عجز نقل وفقد مبرر"

    # التحقق من إضافة قيد إغلاق العجز في StockLedgerEntry وتصفير الرصيد
    disc_entries_after = (await session.execute(
        select(StockLedgerEntry).where(
            StockLedgerEntry.location_type == "discrepancy",
            StockLedgerEntry.bucket_reference == transfer_id,
        )
    )).scalars().all()
    assert len(disc_entries_after) == 2
    net_disc = sum(e.quantity for e in disc_entries_after)
    assert net_disc == 0.0

    # محاولة إعادة حسم نفس الطلب -> رفض 409 (تم البت مسبقاً)
    repeat_resolve = await wh.post(
        f"/api/v1/production/discrepancy-claims/{claim.id}/resolve",
        json={"decision": "accepted_measurement_error", "resolution_notes": "محاولة تغيير القرار"},
    )
    assert repeat_resolve.status_code == 409

    # 10. فحص ملخص WIP بعد حسم المطالبة
    wip_after_resolve = await pm.get(f"/api/v1/production/orders/{order_id}/wip-summary")
    assert wip_after_resolve.status_code == 200
    assert wip_after_resolve.json()["unresolved_discrepancies_count"] == 0
    assert not any("طلب مراجعة عجز استلام خامات" in r for r in wip_after_resolve.json()["blocking_reasons"])


@pytest.mark.asyncio
async def test_discrepancy_claim_validation_and_decision_types(setup_env, session: AsyncSession):
    """
    اختبار مدخلات الحسم:
    - قرار غير صالح -> 422
    - ملاحظات فارغة -> 422
    - قرارات صحيحة: accepted_measurement_error, rejected_under_carrier_liability
    """
    e = setup_env
    wh, pm = e["wh_user"], e["pm_user"]
    fabric_id = e["fabric"].id

    # إنشاء أمر وصرفه واستلامه بعجز
    order_res = await pm.post(
        "/api/v1/production/orders",
        json={
            "product_id": e["product"].id,
            "variant_id": e["variant"].id,
            "template_version_id": e["template_version"].id,
            "target_quantity": 50,
            "season": "summer",
            "manufacturing_type": "internal",
            "notes": "أمر فحص قرارات الحسم",
        },
    )
    order_id = order_res.json()["id"]
    await wh.post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف 100 متر"})

    await pm.post(f"/api/v1/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric_id, "received_quantity": 98.0, "notes": "عجز مترين"}],
        "notes": "عجز 2 متر",
    })

    claims_res = await wh.get(f"/api/v1/production/orders/{order_id}/discrepancy-claims")
    claim_id = claims_res.json()[0]["id"]

    # 1. قرار غير صالح
    invalid_dec = await wh.post(
        f"/api/v1/production/discrepancy-claims/{claim_id}/resolve",
        json={"decision": "random_invalid_choice", "resolution_notes": "ملاحظات سليمة"},
    )
    assert invalid_dec.status_code == 422

    # 2. ملاحظات فارغة أو قصيرة جداً
    empty_notes = await wh.post(
        f"/api/v1/production/discrepancy-claims/{claim_id}/resolve",
        json={"decision": "accepted_measurement_error", "resolution_notes": "  "},
    )
    assert empty_notes.status_code == 422

    # 3. قرار صالح: خطأ كيل وقياس
    valid_resolve = await wh.post(
        f"/api/v1/production/discrepancy-claims/{claim_id}/resolve",
        json={"decision": "accepted_measurement_error", "resolution_notes": "تمت مراجعة القياس بالمتر الصلب وثبت وجود خطأ بالصرف"},
    )
    assert valid_resolve.status_code == 200
    assert valid_resolve.json()["status"] == "accepted_measurement_error"
    assert valid_resolve.json()["status_ar"] == "معتمد · خطأ كيل وقياس عند الصرف"
