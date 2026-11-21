"""
اختبارات توقيت مراحل الإنتاج وتقويم الورديات وتخطي المراحل وتحليل الاختناقات (Phase 7).
─────────────────────────────────────────────────────────────────────────────
تغطي القرارات الإدارية المعتمدة:
1. TIME-DEC-01: المدد المعيارية المتوقعة وتجميد اللقطة على أمر التشغيل وإمكانية تعديلها.
2. TIME-DEC-02: تقويم ورديات المصنع والقياس المزدوج (الزمن التقويمي وزمن الوردية الفعلي).
3. TIME-DEC-03: هيكل المراحل الخمس وتخطي المراحل غير المنطبقة مع الحفاظ على سلامة التسلسل.
4. TIME-DEC-04: تسجيل أسباب التأخير وتحليل الاختناقات (Bottlenecks) على مستوى المراحل والمصنع.
─────────────────────────────────────────────────────────────────────────────
"""
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import uuid
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionStageEvent,
    Unit,
    Warehouse,
    utc_now,
)
from app.modules.production.stage_timing import (
    DEFAULT_STAGE_DURATIONS,
    calculate_stage_working_time,
    get_or_create_active_calendar,
)

ROLE_GENERAL_MANAGER = "general_manager"
ROLE_PRODUCTION_MANAGER = "production_manager"


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


@pytest.fixture
async def timing_test_data(session: AsyncSession):
    suffix = _uid()[:8]
    unit_meter = Unit(id=_uid(), code=f"MTR_{suffix}", name_ar="متر طولي")
    unit_piece = Unit(id=_uid(), code=f"PCS_{suffix}", name_ar="قطعة")
    session.add_all([unit_meter, unit_piece])
    await session.flush()

    raw_wh = Warehouse(id=_uid(), code=f"RAW_{suffix}", name_ar="مخزن خامات تجريبي")
    wip_wh = Warehouse(id=_uid(), code=f"WIP_{suffix}", name_ar="ورشة تجريبية")
    fg_wh = Warehouse(id=_uid(), code=f"FG_{suffix}", name_ar="مخزن تام تجريبي")
    session.add_all([raw_wh, wip_wh, fg_wh])
    await session.flush()

    product = Product(id=_uid(), code=f"THOB_{suffix}", name_ar="ثوب قمة كلاسيك", style_type="dishdasha")
    session.add(product)
    await session.flush()

    variant = ProductVariant(
        id=_uid(),
        product_id=product.id,
        sku=f"SKU_{suffix}",
        numeric_size=58,
        letter_size="L",
        season="summer",
    )
    session.add(variant)
    await session.flush()

    fabric = CatalogItem(
        id=_uid(),
        code=f"FAB_{suffix}",
        name_ar="قماش تترون قطن",
        unit_id=unit_meter.id,
        item_type="raw_material",
        is_active=True,
        approval_status="approved",
    )
    session.add(fabric)
    await session.flush()

    # إنشاء أمر تشغيل في حالة قيد الإنتاج مع المراحل الخمس
    order = ProductionOrder(
        id=_uid(),
        order_number=f"WO-TIME-{suffix}",
        product_id=product.id,
        variant_id=variant.id,
        target_quantity=100.0,
        season="صيف 2026",
        status="in_production",
        created_by="gm-user",
        assigned_to="gm-user",
        manufacturing_type="internal",
        notes="أمر تشغيل لفحص التوقيت والاختناقات",
    )
    session.add(order)
    await session.flush()

    stages = ["cutting", "finishing", "snap_installation", "ironing", "packing"]
    for s_name in stages:
        ev = ProductionStageEvent(
            id=_uid(),
            order_id=order.id,
            stage_name=s_name,
            status="not_started",
            actor_id="gm-user",
            actor_name="المدير العام",
            notes=f"مرحلة {s_name} جاهزة",
            expected_duration_minutes=DEFAULT_STAGE_DURATIONS.get(s_name, 60),
            is_working_time_provisional=True,
            is_skipped=False,
            is_bottleneck=False,
        )
        session.add(ev)

    await session.commit()

    return {
        "order": order,
        "stages": stages,
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "fg_wh": fg_wh,
    }


@pytest.mark.asyncio
async def test_time_dec_01_expected_duration_snapshot_and_adjustment(session: AsyncSession, timing_test_data):
    """
    اختبار TIME-DEC-01:
    - حفظ لقطة معيارية للمدد المتوقعة لكل مرحلة عند إنشاء الأمر.
    - إمكانية تعديل المدة المتوقعة لمرحلة في أمر معين وتحديث اللقطة.
    """
    order = timing_test_data["order"]
    gm = make_auth("gm-user", ROLE_GENERAL_MANAGER)

    async def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: gm

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. فحص لقطة المدد المعيارية في تفاصيل الأمر
            res = await client.get(f"/api/v1/production/orders/{order.id}")
            assert res.status_code == 200, res.text
            order_data = res.json()
            stages = order_data["stage_events"]
            cutting = next(s for s in stages if s["stage_name"] == "cutting")
            finishing = next(s for s in stages if s["stage_name"] == "finishing")
            assert cutting["expected_duration_minutes"] == 120
            assert finishing["expected_duration_minutes"] == 360

            # 2. تعديل المدة المعيارية لمرحلة القص في هذا الأمر إلى 180 دقيقة
            adj_res = await client.put(
                f"/api/v1/production/orders/{order.id}/stages/cutting/duration",
                json={"expected_duration_minutes": 180},
            )
            assert adj_res.status_code == 200, adj_res.text
            adj_data = adj_res.json()
            assert adj_data["expected_duration_minutes"] == 180

            # 3. التأكد من حفظ التعديل في تفاصيل الأمر
            res2 = await client.get(f"/api/v1/production/orders/{order.id}")
            updated_cutting = next(s for s in res2.json()["stage_events"] if s["stage_name"] == "cutting")
            assert updated_cutting["expected_duration_minutes"] == 180
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_time_dec_01_duration_adjust_rejects_non_positive_values(session: AsyncSession, timing_test_data):
    """
    بند 8 من تجربة المالك: تعديل المدة المعيارية بقيمة غير موجبة (0 أو سالب) يُرفض 422
    برسالة عربية واضحة، ولا يتغير أي شيء في لقطة المرحلة.
    """
    order = timing_test_data["order"]
    gm = make_auth("gm-user", ROLE_GENERAL_MANAGER)

    async def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: gm

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            before_res = await client.get(f"/api/v1/production/orders/{order.id}")
            before = next(s for s in before_res.json()["stage_events"] if s["stage_name"] == "ironing")

            for bad_value in (0, -30):
                res = await client.put(
                    f"/api/v1/production/orders/{order.id}/stages/ironing/duration",
                    json={"expected_duration_minutes": bad_value},
                )
                assert res.status_code == 422, res.text
                assert "موجباً" in res.json()["detail"]

            after_res = await client.get(f"/api/v1/production/orders/{order.id}")
            after = next(s for s in after_res.json()["stage_events"] if s["stage_name"] == "ironing")
            assert after["expected_duration_minutes"] == before["expected_duration_minutes"]

            # القيمة الصحيحة الموجبة تُقبل
            ok_res = await client.put(
                f"/api/v1/production/orders/{order.id}/stages/ironing/duration",
                json={"expected_duration_minutes": 90},
            )
            assert ok_res.status_code == 200, ok_res.text
            assert ok_res.json()["expected_duration_minutes"] == 90
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_time_dec_02_factory_calendar_and_dual_measurements(session: AsyncSession, timing_test_data):
    """
    اختبار TIME-DEC-02:
    - جلب وتحديث تقويم ورديات المصنع وأيام العمل والعطلات الأسبوعية.
    - احتساب قياسين منفصلين: الزمن التقويمي وزمن الوردية الفعلي.
    - التمييز بين ساعات العمل التقديرية (provisional) والمعتمدة.
    """
    order = timing_test_data["order"]
    gm = make_auth("gm-user", ROLE_GENERAL_MANAGER)

    async def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: gm

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. استعلام تقويم المصنع
            cal_res = await client.get("/api/v1/production/calendar")
            assert cal_res.status_code == 200, cal_res.text
            cal_data = cal_res.json()
            assert "shift_start_time" in cal_data
            assert "shift_end_time" in cal_data

            # 2. اعتماد التقويم وتحديث ساعات الوردية (من 08:00 إلى 17:00)
            update_res = await client.put(
                "/api/v1/production/calendar",
                json={
                    "shift_name": "وردية النهار المعتمدة",
                    "shift_start_time": "08:00",
                    "shift_end_time": "17:00",
                    "working_days": "saturday,sunday,monday,tuesday,wednesday,thursday",
                    "weekly_holidays": "friday",
                    "is_approved": True,
                },
            )
            assert update_res.status_code == 200, update_res.text
            assert update_res.json()["is_approved"] is True

            # 3. بدء مرحلة القص
            start_res = await client.post(
                f"/api/v1/production/orders/{order.id}/stages/cutting",
                json={"status": "in_progress", "notes": "بدء القص على الباترون"},
            )
            assert start_res.status_code == 200, start_res.text
            start_data = start_res.json()
            assert start_data["status"] == "in_progress"
            assert start_data["started_at"] is not None

            # 4. إكمال مرحلة القص والتحقق من القياس المزدوج
            complete_res = await client.post(
                f"/api/v1/production/orders/{order.id}/stages/cutting",
                json={"status": "completed", "notes": "اكتمال القص بنجاح"},
            )
            assert complete_res.status_code == 200, complete_res.text
            comp_data = complete_res.json()
            assert comp_data["status"] == "completed"
            assert comp_data["completed_at"] is not None
            assert comp_data["elapsed_minutes"] >= 0
            assert comp_data["working_minutes"] >= 0
            assert comp_data["is_working_time_provisional"] is False  # معتمد لأن التقويم معتمد
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_time_dec_03_stage_skipping_and_sequence_integrity(session: AsyncSession, timing_test_data):
    """
    اختبار TIME-DEC-03:
    - تخطي مرحلة (snap_installation) لعدم انطباقها على هذا الموديل.
    - استمرار التتابع التسلسلي بسلاسة دون أن تحظر المرحلة المتخطاة المراحل اللاحقة.
    - اكتمال التصنيع عند إتمام المراحل النشطة.
    """
    order = timing_test_data["order"]
    gm = make_auth("gm-user", ROLE_GENERAL_MANAGER)

    async def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: gm

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. إكمال مرحلة القص
            await client.post(f"/api/v1/production/orders/{order.id}/stages/cutting", json={"status": "in_progress", "notes": "بدء"})
            await client.post(f"/api/v1/production/orders/{order.id}/stages/cutting", json={"status": "completed", "notes": "تم القص"})

            # 2. إكمال مرحلة التشطيب والخياطة
            await client.post(f"/api/v1/production/orders/{order.id}/stages/finishing", json={"status": "in_progress", "notes": "بدء"})
            await client.post(f"/api/v1/production/orders/{order.id}/stages/finishing", json={"status": "completed", "notes": "تم التشطيب"})

            # 3. تخطي مرحلة الكبسولة والأزرار لعدم الحاجة إليها في هذا الموديل
            skip_res = await client.post(
                f"/api/v1/production/orders/{order.id}/stages/snap_installation/skip",
                json={"skip_reason": "موديل جلابية بدون أزرار أو كبسول"},
            )
            assert skip_res.status_code == 200, skip_res.text
            skip_data = skip_res.json()
            assert skip_data["status"] == "skipped"
            assert skip_data["is_skipped"] is True
            assert "بدون أزرار" in skip_data["skip_reason"]

            # 4. بدء مرحلة الكي (المرحلة اللاحقة) مباشرة؛ يجب أن تنجح لأن الكبسولة متخطاة رسمياً
            iron_start = await client.post(
                f"/api/v1/production/orders/{order.id}/stages/ironing",
                json={"status": "in_progress", "notes": "بدء الكي"},
            )
            assert iron_start.status_code == 200, iron_start.text

            # 5. إكمال الكي
            await client.post(f"/api/v1/production/orders/{order.id}/stages/ironing", json={"status": "completed", "notes": "تم الكي"})

            # 6. بدء وإكمال التعبئة والتغليف (المرحلة الأخيرة)
            await client.post(f"/api/v1/production/orders/{order.id}/stages/packing", json={"status": "in_progress", "notes": "بدء التعبئة"})
            pack_comp = await client.post(f"/api/v1/production/orders/{order.id}/stages/packing", json={"status": "completed", "notes": "تم التغليف"})
            assert pack_comp.status_code == 200, pack_comp.text

            # 7. التأكد من تحول حالة أمر التشغيل إلى manufacturing_completed
            order_res = await client.get(f"/api/v1/production/orders/{order.id}")
            assert order_res.status_code == 200
            assert order_res.json()["status"] == "manufacturing_completed"

            # 8. فحص ملخص الورشة WIP للتحقق من جاهزية الإغلاق رغم تخطي الكبسولة
            wip_res = await client.get(f"/api/v1/production/orders/{order.id}/wip-summary")
            assert wip_res.status_code == 200
            assert wip_res.json()["stages_completed"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_time_dec_04_delay_reasons_and_bottleneck_analysis(session: AsyncSession, timing_test_data):
    """
    اختبار TIME-DEC-04:
    - تسجيل سبب التأخير الفني والملاحظات عند إكمال مرحلة.
    - تحديد حالة الاختناق (is_bottleneck) ومؤشراته.
    - استعلام تقرير تحليل الاختناقات العام (/api/v1/production/bottleneck-analysis).
    """
    order = timing_test_data["order"]
    gm = make_auth("gm-user", ROLE_GENERAL_MANAGER)

    async def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: gm

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. تعديل المدة المتوقعة للقص لتكون دقيقة واحدة لإثبات كشف الاختناق عند تجاوزه
            await client.put(
                f"/api/v1/production/orders/{order.id}/stages/cutting/duration",
                json={"expected_duration_minutes": 1},
            )

            # 2. بدء وإكمال القص مع محاكاة فارق زمني وسبب تأخير صيانة ماكينات
            await client.post(f"/api/v1/production/orders/{order.id}/stages/cutting", json={"status": "in_progress", "notes": "بدء"})

            # نضبط وقت البدء يدوي في قاعدة البيانات ليكون قبل ساعتين لنضمن تجاوز المدة
            ev_stmt = select(ProductionStageEvent).where(
                ProductionStageEvent.order_id == order.id,
                ProductionStageEvent.stage_name == "cutting",
            )
            ev = (await session.execute(ev_stmt)).scalar_one()
            ev.started_at = utc_now() - timedelta(hours=2)
            await session.commit()

            comp_res = await client.post(
                f"/api/v1/production/orders/{order.id}/stages/cutting",
                json={
                    "status": "completed",
                    "notes": "تم القص بعد إصلاح عطل المقص الكهربائي",
                    "delay_reason": "machine_breakdown",
                    "delay_notes": "عطل مفاجئ في ماكينة مقص الباترون تم إصلاحه",
                },
            )
            assert comp_res.status_code == 200, comp_res.text
            comp_data = comp_res.json()
            assert comp_data["delay_reason"] == "machine_breakdown"
            assert comp_data["is_bottleneck"] is True  # اختناق لتجاوز المدة المتوقعة

            # 3. استعلام تحليل الاختناقات العام للمصنع
            analysis_res = await client.get("/api/v1/production/bottleneck-analysis")
            assert analysis_res.status_code == 200, analysis_res.text
            analysis = analysis_res.json()

            assert "stages" in analysis
            assert len(analysis["stages"]) == 5
            cutting_stat = next(s for s in analysis["stages"] if s["stage_name"] == "cutting")
            assert cutting_stat["bottleneck_count"] >= 1
            assert cutting_stat["stage_name_ar"] == "القص على الباترون"

            # التحقق من إدراج سبب التأخير في أعلى أسباب التأخير
            top_delays = analysis["top_delay_reasons"]
            assert any(d["reason_code"] == "machine_breakdown" for d in top_delays)
            breakdown_delay = next(d for d in top_delays if d["reason_code"] == "machine_breakdown")
            assert breakdown_delay["reason_name_ar"] == "عطل ماكينات / صيانة"
    finally:
        app.dependency_overrides.clear()
