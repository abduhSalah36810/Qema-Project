"""
وحدة تتبع الطلبات ومعرّف الطلب (Request Tracing & Request ID)
─────────────────────────────────────────────────────────────────────────────
توفر:
1. استخراج والتحقق من صحة معرّف الطلب الوارد X-Request-ID أو توليد UUID4 آمن.
2. سياق ContextVar لتخزين معرّف الطلب وتمكين الوصول إليه من السجلات ومعالجات الأخطاء.
3. برمجية وسيطة (Middleware) لحساب مدة الطلب، إضافة الترويسة للاستجابة، وتسجيل بيانات الطلب
   دون تسجيل نصوص الطلبات أو الترويسات الحساسة أو معاملات الاستعلام (Query Parameters)
   ودون تسجيل نصوص الاستثناءات أو معلمات SQL.
─────────────────────────────────────────────────────────────────────────────
"""
import logging
import re
import time
import uuid
from contextvars import ContextVar
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# تعبير نمطي للتحقق من سلامة معرّف الطلب:
# يسمح فقط بالأحرف الأبجدية، الأرقام، والشرطة (-) والشرطة السفلية (_) بطول 1-64 حرفاً.
# يمنع هجمات حقن الترويسات (CRLF Header Injection) والرموز الخاصة والمدخلات الضخمة.
REQUEST_ID_REGEX = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# سياق معرّف الطلب لاستخدامه عبر دورة حياة الطلب غير المتزامنة
request_id_ctx_var: ContextVar[str] = ContextVar("request_id", default="-")

logger = logging.getLogger("qemma.api")


def validate_or_generate_request_id(incoming_id: Optional[str]) -> str:
    """
    التحقق من صحة معرّف الطلب القادم في الترويسة X-Request-ID.
    - إذا كانت القيمة مطابقة للمواصفات والقيود الأمنية، تُعتمد كما هي.
    - إذا كانت غير مطابقة (رموز خاصة، فراغات، تجاوز الطول، فارغة) أو غير متوفرة، يُولّد UUID4 خادمي آمن.
    """
    if incoming_id and isinstance(incoming_id, str):
        cleaned = incoming_id.strip()
        if REQUEST_ID_REGEX.match(cleaned):
            return cleaned
    return str(uuid.uuid4())


def get_request_id(request: Optional[Request] = None) -> str:
    """
    استرجاع معرّف الطلب الحالي:
    1. من كائن request.state إن توفر.
    2. أو من ContextVar.
    3. أو توليد معرّف بديل إذا استُدعي خارج سياق البرمجية الوسيطة.
    """
    if request is not None:
        state_id = getattr(request.state, "request_id", None)
        if state_id:
            return state_id

    ctx_id = request_id_ctx_var.get()
    if ctx_id and ctx_id != "-":
        return ctx_id

    return str(uuid.uuid4())


class RequestTracingMiddleware(BaseHTTPMiddleware):
    """
    برمجية وسيطة لتتبع الطلبات وتسجيل بياناتها بأمان:
    - تدير معرّف الطلب وتضمن وجوده في ترويسة الاستجابة X-Request-ID لجميع المسارات.
    - تسجل وقت الاستجابة، المسار، طريقة HTTP، ورمز الحالة النهائي.
    - تستبعد عمداً: نصوص الطلب/الاستجابة، ترويسات التفويض، الكوكيز، وقيم معلمات الاستعلام.
    - في حال الأخطاء غير المتوقعة، تسجل فقط تصنيف الخطأ (اسم الفئة) دون نصوص الاستثناءات أو SQL.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming_header = request.headers.get("x-request-id")
        request_id = validate_or_generate_request_id(incoming_header)

        # تثبيت المعرّف في حالة الطلب وسياق التنفيذ
        request.state.request_id = request_id
        token = request_id_ctx_var.set(request_id)

        start_time = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            # في حال تسرب استثناء غير معالج خارج موجهات FastAPI (على مستوى البرمجيات الوسيطة)
            duration_ms = (time.perf_counter() - start_time) * 1000
            error_category = exc.__class__.__name__
            logger.error(
                "server_error category=%s method=%s path=%s duration_ms=%.2f request_id=%s",
                error_category,
                request.method,
                request.url.path,
                duration_ms,
                request_id,
            )
            # استيراد دالة إنشاء الاستجابة الآمنة محلياً لتجنب دورات الاستيراد (circular import)
            from app.core.errors import create_error_response

            response = create_error_response(
                status_code=500,
                code="INTERNAL_SERVER_ERROR",
                message="حدث خطأ غير متوقع في الخادم. يرجى تزويد الدعم الفني برمز الطلب للمتابعة.",
                request_id=request_id,
            )
        finally:
            request_id_ctx_var.reset(token)

        duration_ms = (time.perf_counter() - start_time) * 1000

        # ضمان إرجاع ترويسة معرّف الطلب في كل استجابة
        response.headers["X-Request-ID"] = request_id

        # تسجيل البيانات الوصفية الآمنة فقط: المسار (request.url.path) دون قيم الاستعلام
        logger.info(
            "request_completed method=%s path=%s status=%s duration_ms=%.2f request_id=%s",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            request_id,
        )

        return response
