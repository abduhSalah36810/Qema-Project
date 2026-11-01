"""
إعدادات بيئة الاختبارات الآلية وحصانة قاعدة البيانات (Pytest Fixtures & Test Isolation).
─────────────────────────────────────────────────────────────────────────────
تضمن:
1. ضبط المتغيرات الأساسية حصراً على قاعدة اختبار معزولة (qemma_test_db).
2. التحقق المركزي من أمان قاعدة البيانات قبل بدء أي جلسة اختبارية.
3. توفير fixtures مركزية (test_engine, session) لكافة ملفات الاختبارات.
─────────────────────────────────────────────────────────────────────────────
"""
import os
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tests.db_safety import create_isolated_test_engine, get_test_database_url

# ضبط المتغيرات الأساسية الصريحة لقاعدة بيانات الاختبارات
DEFAULT_TEST_DB_URL = "postgresql+asyncpg://qemma_dev:changeme_local_only@localhost:5432/qemma_test_db"

os.environ.setdefault("TEST_DATABASE_URL", DEFAULT_TEST_DB_URL)
# مزامنة DATABASE_URL في معالج الاختبارات ليشير دائماً إلى نفس قاعدة الاختبار المعتمدة
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]

os.environ.setdefault("APP_ENV", "testing")
os.environ.setdefault("LOG_LEVEL", "warning")
os.environ.setdefault(
    "CORS_ALLOWED_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
)


@pytest.fixture(scope="session")
async def test_engine():
    """محرك SQLAlchemy معزول ومتحقق منه أمنياً على مستوى جلسة الاختبارات."""
    engine = await create_isolated_test_engine()
    yield engine
    await engine.dispose()


@pytest.fixture
async def session(test_engine):
    """جلسة SQLAlchemy معزولة متصلة بقاعدة بيانات الاختبار الحقيقية."""
    session_factory = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as sess:
        yield sess
