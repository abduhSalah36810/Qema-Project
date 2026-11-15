"""Production Stage Timing, Shift Calendar, Stage Skipping, and Bottleneck Analysis (Phase 7).
─────────────────────────────────────────────────────────────────────────────
Implements approved management decisions:
- TIME-DEC-01: Configurable standard durations & snapshot on stage events.
- TIME-DEC-02: Configurable factory work calendar & dual elapsed measurements (calendar vs shift working minutes).
- TIME-DEC-03: Stage structure & safe stage skipping without breaking sequence integrity.
- TIME-DEC-04: Delay reasons tracking & bottleneck analysis with variance reporting.
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from datetime import datetime, time, timedelta, timezone
from typing import Any, Optional
from fastapi import HTTPException
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.production.models import (
    FactoryCalendarConfig,
    ProductionOrder,
    ProductionStageEvent,
    ProductionStageHistory,
    utc_now,
)
from app.modules.production.schemas import (
    BottleneckAnalysisResponse,
    BottleneckStageMetric,
    FactoryCalendarConfigRead,
    FactoryCalendarConfigUpdate,
)

# المعايير الافتراضية لمدد المراحل (بالدقائق)
DEFAULT_STAGE_DURATIONS: dict[str, int] = {
    "cutting": 120,             # القص (ساعتان)
    "finishing": 360,           # التشطيب / الخياطة (6 ساعات)
    "snap_installation": 60,    # تركيب الكبسولة (ساعة)
    "ironing": 120,             # الكي (ساعتان)
    "packing": 90,              # التعبئة والتغليف (ساعة ونصف)
}

ORDER_STAGES_SEQUENCE = (
    "cutting",
    "finishing",
    "snap_installation",
    "ironing",
    "packing",
)

STAGE_NAMES_AR = {
    "cutting": "القص على الباترون",
    "finishing": "التشطيب والخياطة",
    "snap_installation": "تركيب الكبسولة والأزرار",
    "ironing": "الكي والبخار",
    "packing": "التعبئة والتغليف",
}

VALID_DELAY_REASONS = {
    "material_shortage": "نقص أو تأخر الخامات",
    "machine_breakdown": "عطل ماكينات / صيانة",
    "power_outage": "انقطاع كهرباء / مرافق",
    "worker_absence": "غياب أو نقص عمالة",
    "defect_rework": "إصلاح عيوب وتشغيل تالف",
    "client_change": "تعديل مواصفات من العميل",
    "other": "أسباب تشغيلية أخرى",
}

WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


async def get_or_create_active_calendar(session: AsyncSession) -> FactoryCalendarConfig:
    """جلب إعدادات تقويم ورديات المصنع النشط، أو إنشاء التهيئة الافتراضية إن لم تكن موجودة."""
    stmt = select(FactoryCalendarConfig).where(FactoryCalendarConfig.is_active.is_(True)).order_by(FactoryCalendarConfig.created_at.asc())
    res = await session.execute(stmt)
    calendar = res.scalars().first()
    if not calendar:
        calendar = FactoryCalendarConfig(
            id=str(uuid.uuid4()),
            shift_name="وردية التشغيل الأساسية",
            shift_start_time="08:00",
            shift_end_time="17:00",
            working_days="saturday,sunday,monday,tuesday,wednesday,thursday",
            weekly_holidays="friday",
            is_active=True,
            is_approved=False,  # تقديري حتى يعتمده المدير
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        session.add(calendar)
        await session.commit()
        await session.refresh(calendar)
    return calendar


async def update_calendar_config(session: AsyncSession, data: FactoryCalendarConfigUpdate) -> FactoryCalendarConfig:
    """تحديث إعدادات تقويم المصنع وساعات الورديات."""
    calendar = await get_or_create_active_calendar(session)
    if data.shift_name is not None:
        calendar.shift_name = data.shift_name
    if data.shift_start_time is not None:
        calendar.shift_start_time = data.shift_start_time
    if data.shift_end_time is not None:
        calendar.shift_end_time = data.shift_end_time
    if data.working_days is not None:
        calendar.working_days = data.working_days.lower()
    if data.weekly_holidays is not None:
        calendar.weekly_holidays = data.weekly_holidays.lower()
    if data.is_active is not None:
        calendar.is_active = data.is_active
    if data.is_approved is not None:
        calendar.is_approved = data.is_approved
    calendar.updated_at = utc_now()
    await session.commit()
    await session.refresh(calendar)
    return calendar


def parse_time_str(time_str: str) -> time:
    """تحويل نص الساعة مثل '08:00' إلى كائن datetime.time."""
    parts = time_str.strip().split(":")
    hour = int(parts[0]) if len(parts) > 0 else 8
    minute = int(parts[1]) if len(parts) > 1 else 0
    return time(hour, minute)


def calculate_stage_working_time(
    start_dt: datetime,
    end_dt: datetime,
    calendar: Optional[FactoryCalendarConfig],
) -> tuple[int, int, bool]:
    """
    احتساب قياسين منفصلين لمدة مرحلة الإنتاج (TIME-DEC-02):
    1. elapsed_minutes: الزمن التقويمي الفعلي الكلي.
    2. working_minutes: زمن الوردية المحسوب المصفى حسب تقويم المصنع.
    3. is_provisional: هل ساعات الوردية تقديرية وغير معتمدة بعد من إدارة المصنع.
    """
    if not start_dt:
        start_dt = end_dt or utc_now()
    if not end_dt:
        end_dt = utc_now()
    if end_dt < start_dt:
        end_dt = start_dt

    elapsed_minutes = max(0, int((end_dt - start_dt).total_seconds() // 60))

    if not calendar or not calendar.is_active or not calendar.is_approved:
        return elapsed_minutes, elapsed_minutes, True

    is_provisional = False

    # تجهيز أيام العمل والورديات
    working_days = {d.strip().lower() for d in calendar.working_days.split(",") if d.strip()}
    weekly_holidays = {d.strip().lower() for d in calendar.weekly_holidays.split(",") if d.strip()}
    valid_workdays = working_days - weekly_holidays

    shift_start = parse_time_str(calendar.shift_start_time)
    shift_end = parse_time_str(calendar.shift_end_time)

    # حساب زمن الوردية بالتنقل اليومي
    current_date = start_dt.date()
    end_date = end_dt.date()
    working_minutes = 0

    while current_date <= end_date:
        day_name = WEEKDAY_NAMES[current_date.weekday()]
        if day_name in valid_workdays:
            # بداية ونهاية الوردية في هذا اليوم
            day_shift_start = datetime.combine(current_date, shift_start, tzinfo=start_dt.tzinfo or timezone.utc)
            day_shift_end = datetime.combine(current_date, shift_end, tzinfo=start_dt.tzinfo or timezone.utc)

            if day_shift_end > day_shift_start:
                # نافذة التداخل
                window_start = max(start_dt, day_shift_start)
                window_end = min(end_dt, day_shift_end)
                if window_end > window_start:
                    working_minutes += int((window_end - window_start).total_seconds() // 60)

        current_date += timedelta(days=1)

    return elapsed_minutes, working_minutes, is_provisional


async def skip_production_stage(
    session: AsyncSession,
    order_id: str,
    stage_name: str,
    skip_reason: str,
    actor_id: str,
    actor_name: str = "",
) -> ProductionStageEvent:
    """
    تخطي مرحلة إنتاجية لا تنطبق على هذا الموديل (مثل: تركيب الكبسولة في موديل بدون أزرار)
    مع الحفاظ على سلامة التسلسل الإنتاجي (TIME-DEC-03).
    """
    if stage_name not in ORDER_STAGES_SEQUENCE:
        raise HTTPException(
            status_code=400,
            detail=f"اسم المرحلة غير معتمد. المراحل المعتمدة: {', '.join(ORDER_STAGES_SEQUENCE)}",
        )

    order_stmt = (
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.stage_events))
        .where(ProductionOrder.id == order_id)
    )
    o_res = await session.execute(order_stmt)
    order = o_res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    if order.status not in ("in_production", "assigned", "draft"):
        raise HTTPException(
            status_code=409,
            detail="لا يمكن تخطي مراحل لأمر تم الانتهاء منه أو إغلاقه.",
        )

    events_by_stage = {ev.stage_name: ev for ev in order.stage_events}
    target_event = events_by_stage.get(stage_name)
    if not target_event:
        raise HTTPException(status_code=404, detail="حدث المرحلة غير موجود.")

    if target_event.status == "completed":
        raise HTTPException(status_code=400, detail="المرحلة مكتملة بالفعل، لا يمكن تخطيها.")

    prev_status = target_event.status
    target_event.is_skipped = True
    target_event.skip_reason = skip_reason
    target_event.status = "skipped"
    target_event.actor_id = actor_id
    target_event.actor_name = actor_name or target_event.actor_name
    target_event.timestamp = utc_now()
    target_event.notes = f"تم تخطي المرحلة: {skip_reason}"

    # تسجيل في السجل التاريخي
    session.add(
        ProductionStageHistory(
            id=str(uuid.uuid4()),
            order_id=order.id,
            stage_name=stage_name,
            from_status=prev_status,
            to_status="skipped",
            actor_id=actor_id,
            actor_name=actor_name or "",
            previous_notes=target_event.notes,
            reason=f"تخطي المرحلة (غير مطلوبة للموديل): {skip_reason}",
            timestamp=utc_now(),
        )
    )

    # التحقق هل جميع المراحل غير المتخطاة أصبحت مكتملة
    all_active_completed = all(
        ev.status == "completed" for ev in order.stage_events if not ev.is_skipped and ev.id != target_event.id
    )
    if all_active_completed and order.status == "in_production":
        # إذا كانت جميع المراحل المتبقية مكتملة بالفعل
        order.status = "manufacturing_completed"

    await session.commit()
    await session.refresh(target_event)
    return target_event


async def adjust_stage_expected_duration(
    session: AsyncSession,
    order_id: str,
    stage_name: str,
    expected_duration_minutes: int,
    actor_id: str,
    actor_name: str = "",
) -> ProductionStageEvent:
    """
    تعديل المدة المعيارية المتوقعة لمرحلة في أمر تشغيل وتحديث اللقطة التاريخية (TIME-DEC-01).
    """
    if stage_name not in ORDER_STAGES_SEQUENCE:
        raise HTTPException(status_code=400, detail="اسم المرحلة غير معتمد.")

    order_stmt = (
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.stage_events))
        .where(ProductionOrder.id == order_id)
    )
    o_res = await session.execute(order_stmt)
    order = o_res.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")

    events_by_stage = {ev.stage_name: ev for ev in order.stage_events}
    target_event = events_by_stage.get(stage_name)
    if not target_event:
        raise HTTPException(status_code=404, detail="حدث المرحلة غير موجود.")

    target_event.expected_duration_minutes = expected_duration_minutes

    # إعادة تقييم الاختناق إذا كانت المرحلة مكتملة
    if target_event.status == "completed" and expected_duration_minutes > 0:
        effective_duration = target_event.working_minutes if target_event.working_minutes > 0 else target_event.elapsed_minutes
        target_event.is_bottleneck = effective_duration > expected_duration_minutes

    await session.commit()
    await session.refresh(target_event)
    return target_event


async def get_bottleneck_analysis(session: AsyncSession) -> BottleneckAnalysisResponse:
    """
    تحليل اختناقات مراحل الإنتاج وأزمنة الورديات وأسباب التأخير (TIME-DEC-04).
    """
    calendar = await get_or_create_active_calendar(session)

    # 1. إحصائيات كل مرحلة من المراحل الخمس
    stage_metrics: list[BottleneckStageMetric] = []
    for stage_name in ORDER_STAGES_SEQUENCE:
        # جلب الأحداث المكتملة لهذه المرحلة
        stmt = select(ProductionStageEvent).where(
            ProductionStageEvent.stage_name == stage_name,
            ProductionStageEvent.status == "completed",
            ProductionStageEvent.is_skipped.is_(False),
        )
        res = await session.execute(stmt)
        events = res.scalars().all()

        total_orders = len(events)
        if total_orders > 0:
            avg_expected = sum(ev.expected_duration_minutes for ev in events) / total_orders
            avg_working = sum(ev.working_minutes for ev in events) / total_orders
            avg_elapsed = sum(ev.elapsed_minutes for ev in events) / total_orders
            variance = avg_working - avg_expected
            bottlenecks = sum(1 for ev in events if ev.is_bottleneck)
            bottleneck_pct = round((bottlenecks / total_orders) * 100, 1)
        else:
            avg_expected = float(DEFAULT_STAGE_DURATIONS.get(stage_name, 60))
            avg_working = 0.0
            avg_elapsed = 0.0
            variance = 0.0
            bottlenecks = 0
            bottleneck_pct = 0.0

        stage_metrics.append(
            BottleneckStageMetric(
                stage_name=stage_name,
                stage_name_ar=STAGE_NAMES_AR.get(stage_name, stage_name),
                total_completed_orders=total_orders,
                avg_expected_minutes=round(avg_expected, 1),
                avg_working_minutes=round(avg_working, 1),
                avg_elapsed_minutes=round(avg_elapsed, 1),
                variance_minutes=round(variance, 1),
                bottleneck_count=bottlenecks,
                bottleneck_percentage=bottleneck_pct,
            )
        )

    # 2. أسباب التأخير وتوزيعها
    delay_stmt = (
        select(ProductionStageEvent.delay_reason, func.count(ProductionStageEvent.id))
        .where(
            ProductionStageEvent.delay_reason.isnot(None),
            ProductionStageEvent.delay_reason != "",
        )
        .group_by(ProductionStageEvent.delay_reason)
        .order_by(desc(func.count(ProductionStageEvent.id)))
    )
    delay_res = await session.execute(delay_stmt)
    top_delays: list[dict[str, Any]] = []
    for reason_code, count in delay_res.all():
        top_delays.append({
            "reason_code": reason_code,
            "reason_name_ar": VALID_DELAY_REASONS.get(reason_code, reason_code),
            "count": count,
        })

    # 3. الاختناقات النشطة الحالية (أوامر جارية حالياً تجاوزت المدة المتوقعة)
    active_stmt = (
        select(ProductionStageEvent, ProductionOrder)
        .join(ProductionOrder, ProductionStageEvent.order_id == ProductionOrder.id)
        .where(
            ProductionStageEvent.status == "in_progress",
            ProductionStageEvent.is_skipped.is_(False),
            ProductionOrder.status == "in_production",
        )
    )
    active_res = await session.execute(active_stmt)
    active_bottlenecks: list[dict[str, Any]] = []
    now = utc_now()

    for ev, ord_item in active_res.all():
        if ev.started_at:
            _, cur_working, _ = calculate_stage_working_time(ev.started_at, now, calendar)
            if ev.expected_duration_minutes > 0 and cur_working > ev.expected_duration_minutes:
                active_bottlenecks.append({
                    "order_id": ord_item.id,
                    "order_number": ord_item.order_number,
                    "stage_name": ev.stage_name,
                    "stage_name_ar": STAGE_NAMES_AR.get(ev.stage_name, ev.stage_name),
                    "expected_minutes": ev.expected_duration_minutes,
                    "current_working_minutes": cur_working,
                    "delay_reason": ev.delay_reason or "",
                    "delay_reason_ar": VALID_DELAY_REASONS.get(ev.delay_reason, "") if ev.delay_reason else "",
                })

    return BottleneckAnalysisResponse(
        stages=stage_metrics,
        top_delay_reasons=top_delays,
        active_bottlenecks_count=len(active_bottlenecks),
        active_bottlenecks=active_bottlenecks,
        calendar_configured=calendar.is_active,
        calendar_approved=calendar.is_approved,
    )
