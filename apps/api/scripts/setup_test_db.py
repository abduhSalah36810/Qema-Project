"""
سكربت آمن لتجهيز وتهيئة البيانات المرجعية لقاعدة بيانات الاختبارات (Test DB Seeder & Setup).
─────────────────────────────────────────────────────────────────────────────
ضوابط الأمان:
1. يرفض العمل قطعياً على قواعد التطوير (qemma_erp_dev) أو الإنتاج (qemma_erp_prod).
2. يشترط مستضيفاً مصرحاً في Test Allowlist (localhost / 127.0.0.1 / ::1).
3. يتحقق من خادم PostgreSQL الفعلي عبر SELECT current_database() قبل كتابة أي سجل.
4. لا يقوم بأي عمليات مسح أو حذف جماعي.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import os
import sys

# إضافة apps/api إلى مسار الاستيراد
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
import app.db.base  # noqa: F401 - تهيئة كافة الموديلات
from app.modules.production.service import seed_provisional_data_if_empty
from tests.db_safety import (
    UnsafeTestDatabaseError,
    create_isolated_test_engine,
    get_test_database_url,
    validate_test_database_url,
)


async def setup_and_seed_test_database(target_url: str | None = None) -> None:
    """
    تهيئة البيانات المرجعية في قاعدة الاختبارات بعد التحقق الأمني المزدوج.
    """
    url = target_url or os.environ.get("TEST_DATABASE_URL")
    if not url:
        url = "postgresql+asyncpg://qemma_dev:changeme_local_only@localhost:5432/qemma_test_db"

    # 1. التحقق الصارم من الرابط وقائمة السماح (Allowlist)
    validated_url = validate_test_database_url(url)

    # 2. إنشاء محرك معزول يتحقق من الخادم الحي (Live DB Check)
    engine = await create_isolated_test_engine(validated_url)

    # 3. إدراج البيانات المرجعية فقط بعد ثبوت أمان القاعدة
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        await seed_provisional_data_if_empty(session)
        await session.commit()

    await engine.dispose()
    print("✅ تم تأكيد الأمان وتهيئة البيانات المرجعية لقاعدة الاختبارات بنجاح.")


if __name__ == "__main__":
    try:
        asyncio.run(setup_and_seed_test_database())
    except UnsafeTestDatabaseError as e:
        print(f"❌ تم إيقاف السكربت بحظر أمني: {e}", file=sys.stderr)
        sys.exit(1)

