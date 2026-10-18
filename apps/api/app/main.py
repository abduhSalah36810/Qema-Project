"""
نقطة دخول FastAPI.
يشمل: CORS، مسار health check، وهيكل الوحدات المستقبلية.
لا تُنفَّذ هنا أي قواعد أعمال؛ قواعد الأعمال داخل app/modules/.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.api.v1.router import api_router

logging.basicConfig(level=settings.log_level.upper())
logger = logging.getLogger("qemma.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Qemma ERP API starting — env=%s", settings.app_env)
    yield
    logger.info("🛑 Qemma ERP API shutting down")


app = FastAPI(
    title="Qemma ERP API",
    description="نظام ERP مصنع القمة للملابس — واجهة برمجية",
    version="0.1.0",
    docs_url="/docs" if settings.app_env != "production" else None,
    redoc_url="/redoc" if settings.app_env != "production" else None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")
