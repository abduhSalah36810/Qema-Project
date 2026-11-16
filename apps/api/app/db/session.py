"""
جلسة قاعدة البيانات — SQLAlchemy async engine + session factory.
لا تُستخدم قاعدة البيانات في هذه المرحلة التأسيسية.
الاتصال الفعلي يبدأ عند تنفيذ أول migration لوحدة عمل.
"""
import os

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

def get_async_database_url(url: str) -> str:
    """تحويل بادئة postgresql:// إلى postgresql+asyncpg:// لدعم محرك asyncpg غير المتزامن."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def get_engine_connect_args() -> dict:
    """إعدادات الاتصال بمحرك قاعدة البيانات.

    عند الاتصال بـ Supabase عبر مجمع الاتصالات Supavisor في وضع transaction
    (Transaction Pooler على المنفذ 6543 عادة)، يجب تعطيل تخزين العبارات المعدة
    (prepared statement cache) في asyncpg لأن الاتصال الأساسي يتغير بين المعاملات.

    يتم تفعيل هذا الوضع عبر:
    - DB_POOL_MODE=transaction
    - أو SUPAVISOR_TRANSACTION_MODE=true
    - أو DB_STATEMENT_CACHE_SIZE=0

    في البيئة المحلية الافتراضية، تبقى connect_args فارغة دون أي تغيير.
    """
    connect_args: dict = {}
    pool_mode = os.environ.get("DB_POOL_MODE", "").strip().lower()
    supavisor_mode = os.environ.get("SUPAVISOR_TRANSACTION_MODE", "").strip().lower()
    cache_size_env = os.environ.get("DB_STATEMENT_CACHE_SIZE", "").strip()

    if pool_mode in ("transaction", "transaction_pool") or supavisor_mode in ("true", "1") or cache_size_env == "0":
        connect_args["statement_cache_size"] = 0
        connect_args["prepared_statement_cache_size"] = 0

    return connect_args


engine = create_async_engine(
    get_async_database_url(settings.database_url),
    # طباعة استعلامات SQL قد تكشف قيم الرواتب والعملاء في السجلات؛ تُفعّل صراحة فقط
    echo=os.environ.get("SQL_ECHO", "").strip().lower() == "true",
    pool_pre_ping=True,
    connect_args=get_engine_connect_args(),
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
