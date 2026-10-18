"""
جلسة قاعدة البيانات — SQLAlchemy async engine + session factory.
لا تُستخدم قاعدة البيانات في هذه المرحلة التأسيسية.
الاتصال الفعلي يبدأ عند تنفيذ أول migration لوحدة عمل.
"""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=(settings.app_env == "development"),
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """القاعدة الأساسية لجميع نماذج SQLAlchemy في المشروع."""
    pass


async def get_db() -> AsyncSession:  # type: ignore[override]
    """FastAPI dependency لحقن جلسة قاعدة البيانات."""
    async with AsyncSessionLocal() as session:
        yield session
