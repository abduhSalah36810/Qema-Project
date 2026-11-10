"""
نقطة فحص الجاهزية التشغيلية — GET /api/v1/ready
─────────────────────────────────────────────────────────────────────────────
تتحقق من جاهزية الخادم واتصاله بقاعدة البيانات (PostgreSQL) عبر استعلام خفيف: SELECT 1.
- مستقلة تماماً عن نقطة فحص الصحة العامة /api/v1/health (Liveness Probe).
- في حال نجاح الاتصال: تعيد HTTP 200 مع JSON يوضح الجاهزية.
- في حال تعذر الاتصال: تعيد HTTP 503 مع استجابة آمنة تحوي معرّف الطلب (Request ID)
  دون كشف نصوص الاتصال، استعلامات SQL، أو أسرار الخادم.
─────────────────────────────────────────────────────────────────────────────
"""
import logging

from fastapi import APIRouter, Request, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.errors import create_error_response
from app.core.tracing import get_request_id
from app.db.session import engine

router = APIRouter()
logger = logging.getLogger("qemma.api")


class ReadinessResponse(BaseModel):
    status: str
    database: str


async def check_database_connection() -> None:
    """
    تنفيذ استعلام خفيف (SELECT 1) للتحقق من الاتصال بمحرك قاعدة البيانات.
    """
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    status_code=status.HTTP_200_OK,
    summary="فحص الجاهزية التشغيلية وقاعدة البيانات",
    description="يتحقق من اتصال الخادم بقاعدة البيانات عبر استعلام خفيف (SELECT 1). يعيد 200 عند الجاهزية و 503 عند تعذر الاتصال.",
    responses={
        200: {
            "description": "قاعدة البيانات متصلة والخدمة جاهزة لاستقبال العمليات",
            "model": ReadinessResponse,
        },
        503: {
            "description": "تعذر الاتصال بقاعدة البيانات مع استجابة آمنة تحوي معرّف الطلب",
        },
    },
)
async def readiness_check(request: Request):
    """
    فحص جاهزية الخادم والاتصال بقاعدة البيانات.
    """
    request_id = get_request_id(request)
    try:
        await check_database_connection()

        return ReadinessResponse(
            status="ready",
            database="connected",
        )
    except Exception as exc:
        error_category = exc.__class__.__name__
        logger.error(
            "database_readiness_failed category=%s method=%s path=%s request_id=%s",
            error_category,
            request.method,
            request.url.path,
            request_id,
        )
        return create_error_response(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="SERVICE_UNAVAILABLE",
            message="قاعدة البيانات غير متوفرة حالياً.",
            request_id=request_id,
        )
