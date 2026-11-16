import os
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_engine_connect_args
from scripts.seed_e2e_dataset import seed_e2e_dataset
from scripts.seed_pilot_demo import Demo, DemoError
from scripts.setup_test_db import setup_and_seed_test_database
from scripts.reset_pilot_demo_db import demo_database_url


@pytest.mark.asyncio
async def test_all_public_tables_have_row_level_security_enabled(session: AsyncSession):
    """
    التحقق الصارم من أن Row Level Security (RLS) مفعل على كافة جداول schema public.
    يفشل هذا الاختبار حتماً إذا أُضيف أي جدول جديد في المستقبل دون تفعيل RLS عليه.
    """
    query = text("""
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname != 'alembic_version'
        ORDER BY c.relname;
    """)
    result = await session.execute(query)
    rows = result.fetchall()

    assert len(rows) > 0, "لم يتم العثور على أي جداول في schema public"

    unprotected_tables = [table_name for table_name, is_rls_enabled in rows if not is_rls_enabled]

    assert not unprotected_tables, (
        f"فشل أمني: الجداول التالية في schema public غير محمية بـ Row Level Security (RLS):\n"
        f"{unprotected_tables}\n"
        f"يجب تفعيل RLS على كافة جداول الإنتاج لمنع الوصول المباشر عبر PostgREST."
    )


def test_asyncpg_supavisor_transaction_pooler_connect_args(monkeypatch):
    """
    التحقق من أن إعدادات asyncpg تعطل statement cache عند تفعيل وضع transaction لـ Supavisor
    دون التأثير على السلوك المحلي الافتراضي.
    """
    # 1. السلوك الافتراضي المحلي (فارغ)
    monkeypatch.delenv("DB_POOL_MODE", raising=False)
    monkeypatch.delenv("SUPAVISOR_TRANSACTION_MODE", raising=False)
    monkeypatch.delenv("DB_STATEMENT_CACHE_SIZE", raising=False)
    assert get_engine_connect_args() == {}

    # 2. تفعيل عبر DB_POOL_MODE=transaction
    monkeypatch.setenv("DB_POOL_MODE", "transaction")
    assert get_engine_connect_args() == {
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
    }

    # 3. تفعيل عبر SUPAVISOR_TRANSACTION_MODE=true
    monkeypatch.delenv("DB_POOL_MODE", raising=False)
    monkeypatch.setenv("SUPAVISOR_TRANSACTION_MODE", "true")
    assert get_engine_connect_args() == {
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
    }

    # 4. تفعيل عبر DB_STATEMENT_CACHE_SIZE=0
    monkeypatch.delenv("SUPAVISOR_TRANSACTION_MODE", raising=False)
    monkeypatch.setenv("DB_STATEMENT_CACHE_SIZE", "0")
    assert get_engine_connect_args() == {
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
    }


@pytest.mark.asyncio
async def test_seed_e2e_dataset_refuses_production(monkeypatch):
    """
    التحقق من أن سكربت seed_e2e_dataset يرفض العمل قطعياً عند APP_ENV=production.
    """
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="حظر أمني صارم: يمنع تشغيل سكربت البيانات التجريبية seed_e2e_dataset"):
        await seed_e2e_dataset()


def test_seed_pilot_demo_refuses_production(monkeypatch):
    """
    التحقق من أن سكربت seed_pilot_demo يرفض العمل قطعياً عند APP_ENV=production.
    """
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(DemoError, match="حظر أمني صارم: يمنع تشغيل سكربت العرض التجريبي seed_pilot_demo"):
        Demo("http://localhost:8000")


@pytest.mark.asyncio
async def test_setup_test_db_refuses_production(monkeypatch):
    """
    التحقق من أن سكربت setup_test_db يرفض العمل قطعياً عند APP_ENV=production.
    """
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="حظر أمني: يمنع تشغيل سكربت setup_test_db"):
        await setup_and_seed_test_database()


def test_reset_pilot_demo_db_refuses_production(monkeypatch):
    """
    التحقق من أن سكربت reset_pilot_demo_db يرفض العمل قطعياً عند APP_ENV=production.
    """
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(SystemExit, match="حظر أمني: يمنع إعادة ضبط قاعدة العرض التجريبي"):
        demo_database_url()
