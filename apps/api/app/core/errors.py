"""
معالجة الأخطاء الآمنة والموحدة للواجهة البرمجية (Safe API Errors)
─────────────────────────────────────────────────────────────────────────────
تضمن:
1. إرجاع هيكل استجابة أخطاء موحد ومستقر لجميع أخطاء HTTP وأخطاء التحقق والأخطاء غير المتوقعة.
2. رسائل عربية آمنة وثابتة مستندة إلى رموز الحالة وقوائم سماح محددة، مع منع كشف نصوص detail الاعتباطية.
3. حجب تام لكافة تفاصيل الاستثناءات الداخلية واستعلامات SQL وتتبع الأخطاء (Tracebacks) والأسرار عن العميل وعن السجلات.
4. تنقية أخطاء التحقق (Validation Errors) عبر قائمة سماح للأنواع (Allowlist) واستبعاد المدخلات الخام (Input Values)
   ورسائل المدققات الاعتباطية لمنع تسريب كلمات المرور والتوكنات وأرقام الهواتف.
5. تجنب التكرار في تسجيل الأخطاء للطلب الواحد.
─────────────────────────────────────────────────────────────────────────────
"""
import logging
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.core.tracing import get_request_id

logger = logging.getLogger("qemma.api")

# خريطة رموز الأخطاء الثابتة حسب رمز حالة HTTP
STATUS_CODE_TO_ERROR_CODE: Dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    408: "REQUEST_TIMEOUT",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_SERVER_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}

# الرسائل الآمنة والمستقرة المناسبة للغة العربية بحسب رمز الحالة
DEFAULT_ERROR_MESSAGES: Dict[int, str] = {
    400: "الطلب غير صالح أو تعذر تفسيره.",
    401: "يجب تسجيل الدخول للوصول إلى هذا المورد.",
    403: "ليس لديك الصلاحية الكافية لتنفيذ هذا الإجراء.",
    404: "المورد المطلوب غير موجود أو تم نقله.",
    405: "طريقة الطلب غير مسموح بها لهذا المسار.",
    408: "انتهت مهلة معالجة الطلب.",
    409: "يوجد تعارض مع الحالة الحالية للمورد.",
    422: "بيانات الطلب غير صالحة أو غير مكتملة.",
    429: "تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً.",
    500: "حدث خطأ غير متوقع في الخادم. يرجى تزويد الدعم الفني برمز الطلب للمتابعة.",
    502: "تعذر الاتصال بالخدمة الوسيطة.",
    503: "الخدمة غير متوفرة حالياً بسبب الصيانة أو الضغط المؤقت.",
    504: "انتهت مهلة استجابة الخدمة الوسيطة.",
}

# قائمة سماح بأنواع أخطاء التحقق وأوصافها الآمنة باللغة العربية
# تمنع كشف رسائل المدققات التلقائية (msg) أو القيم المدخلة (input) نهائياً
VALIDATION_TYPE_MESSAGES: Dict[str, str] = {
    "missing": "الحقل مطلوب.",
    "string_type": "يجب أن تكون القيمة نصية.",
    "int_type": "يجب أن تكون القيمة رقماً صحيحاً.",
    "int_parsing": "تعذر تفسير القيمة كرقم صحيح.",
    "float_type": "يجب أن تكون القيمة رقماً عشرياً.",
    "float_parsing": "تعذر تفسير القيمة كرقم عشري.",
    "bool_type": "يجب أن تكون القيمة منطقية (صواب/خطأ).",
    "bool_parsing": "تعذر تفسير القيمة كقيمة منطقية.",
    "list_type": "يجب أن تكون القيمة قائمة.",
    "dict_type": "يجب أن تكون القيمة كائناً مركباً.",
    "json_invalid": "صيغة JSON غير صالحة.",
    "string_too_short": "النص أقصر من الحد الأدنى المسموح.",
    "string_too_long": "النص أطول من الحد الأقصى المسموح.",
    "greater_than": "القيمة يجب أن تكون أكبر من الحد الأدنى.",
    "greater_than_equal": "القيمة يجب أن تكون أكبر من أو تساوي الحد الأدنى.",
    "less_than": "القيمة يجب أن تكون أصغر من الحد الأقصى.",
    "less_than_equal": "القيمة يجب أن تكون أصغر من أو تساوي الحد الأقصى.",
    "value_error": "قيمة الحقل غير مقبولة.",
    "assertion_error": "قيمة الحقل غير صالحة.",
    "extra_forbidden": "الحقل غير مسموح به.",
    "enum": "القيمة المحددة غير موجودة ضمن الخيارات المتاحة.",
    "uuid_parsing": "معرّف UUID غير صالح.",
    "date_parsing": "صيغة التاريخ غير صالحة.",
    "datetime_parsing": "صيغة التاريخ والوقت غير صالحة.",
    "url_parsing": "رابط URL غير صالح.",
    "email_parsing": "صيغة البريد الإلكتروني غير صالحة.",
}


class ErrorResponse(BaseModel):
    """
    نموذج الاستجابة الموحدة للأخطاء (Safe API Error Schema).
    يضمن توثيق بنية أخطاء HTTP الآمنة في OpenAPI دون كشف أي أسرار أو نصوص استثناءات داخلية.
    """
    code: str = Field(..., description="رمز تصنيف الخطأ الثابت (مثل UNAUTHORIZED أو NOT_FOUND)")
    message: str = Field(..., description="رسالة الخطأ الآمنة باللغة العربية")
    detail: str = Field(..., description="نص توضيحي متوافق مع معايير FastAPI العامة")
    request_id: str = Field(..., description="معرّف تتبع الطلب الفريد (X-Request-ID)")
    details: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="تفاصيل إضافية عن الحقول في حال أخطاء التحقق فقط دون كشف قيم حساسة",
    )


def get_status_code_identifier(status_code: int) -> str:
    """استرجاع رمز الخطأ المستقر من رمز حالة HTTP."""
    return STATUS_CODE_TO_ERROR_CODE.get(status_code, f"HTTP_{status_code}")


def create_error_response(
    status_code: int,
    code: str,
    message: str,
    request_id: str,
    details: Optional[List[Dict[str, Any]]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> JSONResponse:
    """
    إنشاء كائن JSONResponse موحد وآمن لجميع الأخطاء البرمجية.
    يحوي:
    - code: رمز الخطأ الثابت (مثل NOT_FOUND, VALIDATION_ERROR).
    - message: رسالة توضيحية موجهة للمستخدم باللغة العربية.
    - detail: حقل متوافق مع نمط FastAPI العام.
    - request_id: معرّف الطلب للمتابعة والتدقيق.
    - details: تفاصيل الحقول (في حال أخطاء التحقق فقط) بعد تنقية القيم الحساسة.
    """
    content: Dict[str, Any] = {
        "code": code,
        "message": message,
        "detail": message,
        "request_id": request_id,
        "details": details,
    }

    response_headers: Dict[str, str] = {"X-Request-ID": request_id}
    if headers:
        for k, v in headers.items():
            if k.lower() != "x-request-id":
                response_headers[k] = v

    return JSONResponse(status_code=status_code, content=content, headers=response_headers)


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """
    معالج استثناءات HTTP الصادرة من FastAPI أو Starlette.
    يضمن عدم تمرير نصوص HTTPException.detail الاعتباطية إلى العميل،
    ويعتمد رسالة عربية آمنة وثابتة مشتقة من رمز الحالة، مع الحفاظ على الترويسات المطلوبة.
    """
    request_id = get_request_id(request)
    code = get_status_code_identifier(exc.status_code)

    # استخدام الرسالة الآمنة المستقرة المقابلة لرمز الحالة دون تمرير exc.detail الاعتباطي
    message = DEFAULT_ERROR_MESSAGES.get(exc.status_code, "حدث خطأ أثناء معالجة الطلب.")

    return create_error_response(
        status_code=exc.status_code,
        code=code,
        message=message,
        request_id=request_id,
        headers=getattr(exc, "headers", None),
    )


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """
    معالج أخطاء التحقق من صحة مدخلات الطلب (Pydantic / FastAPI).
    - يشتق وصف المشكلة حصراً من قائمة سماح ثابتة (VALIDATION_TYPE_MESSAGES).
    - يستبعد تماماً نصوص المدققات الاعتباطية والقيم المدخلة (input values)
      لمنع تسريب كلمات المرور، التوكنات، أرقام الهواتف أو البيانات الشخصية.
    """
    request_id = get_request_id(request)
    sanitized_details: List[Dict[str, Any]] = []

    for err in exc.errors():
        # استخراج مسار الحقل الآمن بدون كلمة 'body'
        raw_loc = err.get("loc", ())
        field_parts = [str(part) for part in raw_loc if part != "body"]
        field_name = ".".join(field_parts) if field_parts else "body"

        # اشتقاق وصف المشكلة من قائمة السماح دون تضمين err.get("msg") أو err.get("input")
        err_type = str(err.get("type", "value_error"))
        safe_issue = VALIDATION_TYPE_MESSAGES.get(err_type, "قيمة الحقل غير صالحة.")

        sanitized_details.append({
            "field": field_name,
            "issue": safe_issue,
            "type": err_type,
        })

    return create_error_response(
        status_code=422,
        code="VALIDATION_ERROR",
        message="بيانات الطلب غير صالحة أو غير مكتملة.",
        request_id=request_id,
        details=sanitized_details,
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    معالج الأخطاء غير المتوقعة (Catch-All 500).
    - يسجل تصنيف الخطأ الآمن (اسم الفئة) ومعرّف الطلب والمسار والطريقة فقط.
    - لا يسجل نص الاستثناء أو معلمات SQL أو التتبع (Traceback) أو نصوص الطلبات أو الترويسات الحساسة.
    - يعيد رداً آمناً وموحداً للعميل برمز خطأ ومعرّف الطلب.
    """
    request_id = get_request_id(request)
    error_category = exc.__class__.__name__

    # تسجيل آمن ومفيد دون تسريب نص الاستثناء أو معلمات الاستعلام أو SQL
    logger.error(
        "server_error category=%s method=%s path=%s request_id=%s",
        error_category,
        request.method,
        request.url.path,
        request_id,
    )

    return create_error_response(
        status_code=500,
        code="INTERNAL_SERVER_ERROR",
        message="حدث خطأ غير متوقع في الخادم. يرجى تزويد الدعم الفني برمز الطلب للمتابعة.",
        request_id=request_id,
    )


def setup_exception_handlers(app: FastAPI) -> None:
    """تسجيل كافة معالجات الأخطاء الموحدة على تطبيق FastAPI."""
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
