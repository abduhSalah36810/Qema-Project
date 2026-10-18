"""
Health check endpoint — GET /api/v1/health
يُستخدم للتحقق من تشغيل الـ API ولاحقًا من اتصال قاعدة البيانات.
لا يكشف معلومات داخلية أو أسرار.
"""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    app: str
    version: str


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """
    فحص صحة الخدمة.
    يعيد status=ok عند تشغيل الـ API بنجاح.
    """
    return HealthResponse(
        status="ok",
        app="qemma-erp",
        version="0.1.0",
    )
