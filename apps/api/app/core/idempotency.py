"""
نظام منع التكرار الموحد للعمليات المخزنية والتشغيلية (Unified Idempotency Engine)
─────────────────────────────────────────────────────────────────────────────
يحقق:
1. نفس المفتاح ونفس Payload يعيدان النتيجة الأصلية فورياً دون إعادة تنفيذ أو تكرار قيود الأستاذ.
2. نفس المفتاح وPayload مختلف يؤديان إلى رفض واضح (HTTP 409 Conflict).
3. معالجة الطلبات المتزامنة بنفس المفتاح ومنع التنافس عبر قفل السجل أو كشف In-Progress.
4. ربط الطلب بمعرف المستخدم ونوع العملية.
5. الاحتفاظ بالنتائج بحالة واضحة (in_progress, completed, failed).
─────────────────────────────────────────────────────────────────────────────
"""
import hashlib
import json
import uuid
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.production.models import IdempotentRequest, utc_now


def compute_request_hash(payload: Any) -> str:
    """حساب البصمة الرقمية الموحدة (SHA-256) لحمولة الطلب بعد ترتيب الحقول لضمان التطابق الحسابي."""
    if payload is None:
        raw_dict: dict[str, Any] = {}
    elif hasattr(payload, "model_dump"):
        raw_dict = payload.model_dump(mode="json")
    elif hasattr(payload, "dict"):
        raw_dict = payload.dict()
    elif isinstance(payload, dict):
        raw_dict = payload
    else:
        raw_dict = {"raw": str(payload)}

    canonical_json = json.dumps(raw_dict, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


async def execute_idempotent_operation(
    db: AsyncSession,
    idempotency_key: Optional[str],
    operation_type: str,
    resource_id: str,
    user_id: str,
    payload: Any,
    execute_fn: Callable[[], Awaitable[Any]],
) -> Any:
    """
    تنفيذ عملية محمية بنظام منع التكرار الموحد.
    في حال عدم تمرير idempotency_key، تُنفذ العملية مباشرة.
    """
    if not idempotency_key or not isinstance(idempotency_key, str) or not idempotency_key.strip():
        result = await execute_fn()
        await db.commit()
        return result

    clean_key = idempotency_key.strip()
    req_hash = compute_request_hash(payload)

    # 1. فحص وجود سجل سابق لنفس العملية والمفتاح مع قفل السجل للتحقق
    stmt = (
        select(IdempotentRequest)
        .where(
            IdempotentRequest.operation_type == operation_type,
            IdempotentRequest.idempotency_key == clean_key,
        )
        .with_for_update()
    )
    existing = (await db.execute(stmt)).scalar_one_or_none()

    if existing:
        # فحص تطابق المستخدم
        if existing.user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="مفتاح عدم التكرار (Idempotency-Key) مسجل لمستخدم آخر.",
            )

        # فحص تطابق البيانات (Payload mismatch)
        if existing.request_hash != req_hash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="مفتاح عدم التكرار (Idempotency-Key) مستخدم مسبقاً مع بيانات طلب مختلفة.",
            )

        # إذا كانت العملية اكتملت مسبقاً، أعد نفس النتيجة فوراً دون تكرار أي قيود
        if existing.status == "completed":
            return existing.response_body

        # إذا كانت العملية قيد التنفيذ حالياً في معاملة أخرى
        if existing.status == "in_progress":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="يوجد طلب متزامن قيد المعالجة حالياً بنفس مفتاح عدم التكرار.",
            )

    # 2. إنشاء سجل جديد بحالة in_progress
    record = IdempotentRequest(
        id=str(uuid.uuid4()),
        idempotency_key=clean_key,
        user_id=user_id,
        operation_type=operation_type,
        resource_id=resource_id,
        request_hash=req_hash,
        status="in_progress",
        created_at=utc_now(),
    )
    db.add(record)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="يوجد طلب متزامن قيد المعالجة حالياً بنفس مفتاح عدم التكرار.",
        )

    # 3. تنفيذ الإجراء الفعلي داخل المعاملة
    result = await execute_fn()

    # 4. تسلسل النتيجة وحفظها في سجل عدم التكرار
    if hasattr(result, "model_dump"):
        serialized_result = result.model_dump(mode="json")
    elif isinstance(result, dict):
        serialized_result = result
    else:
        serialized_result = {"result": str(result)}

    record.status = "completed"
    record.response_code = 200
    record.response_body = serialized_result
    record.completed_at = utc_now()

    await db.commit()
    return result
