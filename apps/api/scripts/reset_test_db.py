"""
إعادة ضبط قاعدة بيانات الاختبارات لتصبح في حالة أولية نظيفة (Test Database Reset Script).
─────────────────────────────────────────────────────────────────────────────
الاستخدام:
  python scripts/reset_test_db.py

الخطوات:
1. التحقق من أمان الرابط (مستضيف محلي حصراً، واسم قاعدة الاختبار qemma_test_db).
2. تفريغ الـ schema public وإعادة إنشائها.
3. تطبيق كافة الترحيلات حتى أحدث إصدار (alembic upgrade head حتى 0036).
4. تجهيز الحسابات والمخازن والأدوار الأساسية عبر bootstrap_factory_db.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import os
import sys
from pathlib import Path

# إدراج جذر التطبيق في مسار الاستيراد
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

DEFAULT_TEST_DB_URL = "postgresql+asyncpg://qemma_dev:changeme_local_only@localhost:5432/qemma_test_db"
os.environ.setdefault("TEST_DATABASE_URL", DEFAULT_TEST_DB_URL)
os.environ["APP_ENV"] = "testing"

from tests.db_safety import get_test_database_url, validate_test_database_url
from scripts.bootstrap_factory_db import bootstrap


async def reset_schema(database_url: str) -> None:
    validate_test_database_url(database_url)
    engine = create_async_engine(database_url, isolation_level="AUTOCOMMIT")
    async with engine.connect() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE;"))
        await conn.execute(text("CREATE SCHEMA public;"))
    await engine.dispose()


def run_alembic_upgrade(api_dir: Path) -> None:
    ini_path = api_dir / "alembic.ini"
    alembic_cfg = Config(str(ini_path))
    alembic_cfg.set_main_option("script_location", str(api_dir / "alembic"))
    command.upgrade(alembic_cfg, "head")


async def main_async() -> None:
    test_db_url = get_test_database_url()
    validate_test_database_url(test_db_url)

    api_dir = Path(__file__).resolve().parents[1]

    print("[1/3] مسح وإعادة إنشاء schema public...")
    await reset_schema(test_db_url)

    print("[2/3] تطبيق الترحيلات (alembic upgrade head)...")
    # مزامنة DATABASE_URL لـ alembic
    os.environ["DATABASE_URL"] = test_db_url
    await asyncio.to_thread(run_alembic_upgrade, api_dir)

    print("[3/3] تجهيز البنية التحتية الأساسية (bootstrap_factory_db)...")
    await bootstrap(test_db_url, [])

    print("تمت إعادة ضبط قاعدة بيانات الاختبارات بنجاح.")


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
