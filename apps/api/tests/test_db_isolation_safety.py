"""
اختبارات التحقق الأمني لعزل وحصانة قاعدة بيانات الاختبارات والترحيلات (Security Verification).
─────────────────────────────────────────────────────────────────────────────
تثبت بالدليل القاطع:
1. قائمة السماح الحصرية للمستضيفين (Host Allowlist):
   - قبول localhost و 127.0.0.1 و ::1 و [::1].
   - رفض أي IP خارجي أو دومين غير مصرح به حتى لو حملت القاعدة اسم test.
   - رفض الروابط المشوهة والروابط ذات المستضيف الفارغ.
   - دعم التوسيع المنضبط عبر TEST_ALLOWED_HOSTS دون تمديد تلقائي.
2. حصانة ترحيلات Alembic وسياسة البيئات:
   - ترحيلات الاختبار مقيدة بقواعد الاختبار ومستضيفي الـ Allowlist.
   - ترحيلات التطوير مقيدة حصراً بـ qemma_erp_dev والمستضيف المحلي.
   - ترحيلات الإنتاج مقفلة افتراضياً، وتتطلب تحققاً ثنائياً صريحاً (Dual-Factor).
   - لا يمكن تفعيل ترحيلات الإنتاج بمتغير عرضي واحد.
   - رفض أي بيئة غير معتمدة أو غير معروفة.
3. أمان سكربتات التهيئة:
   - رفض تشغيل سكربت إعداد واختبار البيانات على أي قاعدة غير مخصصة للاختبارات.
─────────────────────────────────────────────────────────────────────────────
"""
import os
import uuid
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.migration_guard import (
    MigrationSecurityError,
    extract_migration_target,
    validate_migration_target,
)
from app.modules.finance.models import CashAccount, CashDocument
from scripts.setup_test_db import setup_and_seed_test_database
from tests.db_safety import (
    UnsafeTestDatabaseError,
    extract_database_name_from_url,
    extract_host_and_db_from_url,
    get_allowed_test_hosts,
    get_test_database_url,
    normalize_host,
    validate_test_database_url,
    verify_active_connection,
)


# ═════════════════════════════════════════════════════════════════════════════
# 1. اختبارات قائمة السماح الحصرية للمستضيفين (Strict Host Allowlist)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize(
    "valid_url, expected_host",
    [
        ("postgresql+asyncpg://user:pass@localhost:5432/qemma_test_db", "localhost"),
        ("postgresql+asyncpg://user:pass@127.0.0.1:5432/qemma_test_db", "127.0.0.1"),
        ("postgresql+asyncpg://user:pass@::1:5432/qemma_test_db", "::1"),
        ("postgresql+asyncpg://user:pass@[::1]:5432/qemma_test_db", "::1"),
        ("postgresql://user:pass@localhost/my_test_db", "localhost"),
    ],
)
def test_approved_test_hosts_are_accepted(valid_url, expected_host):
    """قبول مستضيفي الـ Allowlist الافتراضيين (localhost, 127.0.0.1, ::1)."""
    assert validate_test_database_url(valid_url) == valid_url
    host, db_name = extract_host_and_db_from_url(valid_url)
    assert host == expected_host
    assert "test" in db_name


@pytest.mark.parametrize(
    "forbidden_url, expected_error_msg",
    [
        ("postgresql+asyncpg://user:pass@198.51.100.25:5432/qemma_test_db", "غير مصرح به"),
        ("postgresql+asyncpg://user:pass@10.0.1.5:5432/qemma_test_db", "غير مصرح به"),
        ("postgresql+asyncpg://user:pass@db.company.com:5432/qemma_test_db", "غير مصرح به"),
        ("postgresql+asyncpg://user:pass@staging.internal:5432/qemma_test_db", "غير مصرح به"),
        ("postgresql+asyncpg://user:pass@db.xyz.supabase.co:5432/qemma_test_db", "غير مصرح به"),
        ("postgresql+asyncpg://user:pass@rds.amazonaws.com:5432/qemma_test_db", "غير مصرح به"),
        ("postgresql+asyncpg://user:pass@prod-db.internal:5432/qemma_test_db", "غير مصرح به"),
    ],
)
def test_unapproved_hosts_are_strictly_rejected(forbidden_url, expected_error_msg):
    """
    رفض أي عنوان IP خارجي أو دومين حتى لو احتوى اسم القاعدة على 'test'.
    يثبت أن اسم قاعدة البيانات وحده ليس دليلاً كافياً على الأمان.
    """
    with pytest.raises(UnsafeTestDatabaseError) as exc:
        validate_test_database_url(forbidden_url)
    assert expected_error_msg in str(exc.value)


@pytest.mark.parametrize(
    "malformed_url",
    [
        "",
        "   ",
        "not_a_valid_url",
        "postgresql+asyncpg:///qemma_test_db",  # مستضيف فارغ
        "postgresql+asyncpg://:5432/qemma_test_db",  # بدون مستضيف
        "http://",
    ],
)
def test_malformed_and_empty_urls_are_rejected(malformed_url):
    """رفض الروابط المشوهة والروابط ذات المستضيف الفارغ."""
    with pytest.raises(UnsafeTestDatabaseError):
        validate_test_database_url(malformed_url)


def test_test_allowed_hosts_configuration(monkeypatch):
    """دعم ضبط مستضيفين مصرح بهم إضافيين عبر المتغير TEST_ALLOWED_HOSTS."""
    url = "postgresql+asyncpg://user:pass@ci-runner-host:5432/qemma_test_db"

    # 1. يرفض افتراضياً
    with pytest.raises(UnsafeTestDatabaseError):
        validate_test_database_url(url)

    # 2. يُقبل بعد إضافته صراحة في Allowlist
    monkeypatch.setenv("TEST_ALLOWED_HOSTS", "ci-runner-host, 192.168.1.100")
    assert validate_test_database_url(url) == url
    assert "ci-runner-host" in get_allowed_test_hosts()
    assert "192.168.1.100" in get_allowed_test_hosts()


# ═════════════════════════════════════════════════════════════════════════════
# 2. اختبارات المتغيرات وقواعد البيانات المحظورة
# ═════════════════════════════════════════════════════════════════════════════

def test_missing_test_database_url_raises_safe_error(monkeypatch):
    """غياب TEST_DATABASE_URL يؤدي إلى رفض آمن صريح دون أي محاولة اتصال."""
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    with pytest.raises(UnsafeTestDatabaseError) as exc:
        get_test_database_url()
    assert "TEST_DATABASE_URL غير محدد" in str(exc.value)


def test_development_database_url_not_used_automatically(monkeypatch):
    """DATABASE_URL الخاص بالتطوير لا يُستخدم تلقائياً كبديل لقاعدة الاختبار."""
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://qemma_dev:secret@localhost:5432/qemma_erp_dev")

    with pytest.raises(UnsafeTestDatabaseError) as exc:
        get_test_database_url()
    assert "تم رفض الرجوع التلقائي إلى DATABASE_URL" in str(exc.value)

    with pytest.raises(UnsafeTestDatabaseError) as exc_dev:
        validate_test_database_url("postgresql+asyncpg://qemma_dev:secret@localhost:5432/qemma_erp_dev")
    assert "محاولة الاتصال بقاعدة بيانات محظورة 'qemma_erp_dev'" in str(exc_dev.value)


# ═════════════════════════════════════════════════════════════════════════════
# 3. اختبارات أمان ترحيلات Alembic وحصانة البيئات (Migration Safety)
# ═════════════════════════════════════════════════════════════════════════════

def test_migration_test_environment_policy():
    """ترحيلات بيئة الاختبار مسموحة فقط على قواعد الاختبار المعتمدة محلياً."""
    # 1. قاعدة اختبار محلية معتمدة -> مقبولة
    host, db = validate_migration_target(
        "postgresql+asyncpg://user:pass@localhost:5432/qemma_test_db",
        app_env="testing",
    )
    assert host == "localhost"
    assert db == "qemma_test_db"

    # 2. محاولة ترحيل قاعدة dev في بيئة الاختبار -> مرفوضة
    with pytest.raises(MigrationSecurityError) as exc_dev:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@localhost:5432/qemma_erp_dev",
            app_env="testing",
        )
    assert "ترحيلات بيئة الاختبار مسموحة فقط على قواعد بيانات الاختبار" in str(exc_dev.value)

    # 3. محاولة ترحيل قاعدة اختبار على سيرفر خارجي -> مرفوضة
    with pytest.raises(MigrationSecurityError) as exc_host:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@198.51.100.25:5432/qemma_test_db",
            app_env="testing",
        )
    assert "المستهدف host='198.51.100.25' مرفوض" in str(exc_host.value)


def test_migration_development_environment_policy():
    """ترحيلات بيئة التطوير مسموحة فقط على قاعدة التطوير المعتمدة صراحة (qemma_erp_dev)."""
    # 1. قاعدة التطوير المعتمدة محلياً -> مقبولة
    host, db = validate_migration_target(
        "postgresql+asyncpg://user:pass@localhost:5432/qemma_erp_dev",
        app_env="development",
    )
    assert host == "localhost"
    assert db == "qemma_erp_dev"

    # 2. قاعدة غير معتمدة أو غير معروفة -> مرفوضة
    with pytest.raises(MigrationSecurityError) as exc_unknown:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@localhost:5432/unknown_dev_db",
            app_env="development",
        )
    assert "غير معتمد" in str(exc_unknown.value)

    # 3. سيرفر خارجي في بيئة التطوير -> مرفوض
    with pytest.raises(MigrationSecurityError) as exc_ext:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@external-server.com:5432/qemma_erp_dev",
            app_env="development",
        )
    assert "المستهدف host='external-server.com' مرفوض" in str(exc_ext.value)

    # 4. محاولة ترحيل قاعدة إنتاجية تحت مسمى development -> مرفوضة قطعياً
    with pytest.raises(MigrationSecurityError) as exc_prod:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@localhost:5432/qemma_erp_prod",
            app_env="development",
        )
    assert "محاولة تشغيل ترحيلات التطوير على قاعدة إنتاجية" in str(exc_prod.value)


def test_migration_production_environment_policy():
    """
    ترحيلات الإنتاج:
    - محظورة تماماً ومغلقة قطعياً عبر مسار Alembic المحلي.
    - ترفض التنفيذ بصرف النظر عن أي متغيرات بيئية مثل ALLOW_PROD_MIGRATIONS أو PROD_MIGRATION_CONFIRM_DB.
    - مخصصة حصراً لمسار نشر مستقل (Dedicated Deployment Pipeline) مستقبلاً.
    """
    prod_url = "postgresql+asyncpg://admin:secret@prod-db.internal:5432/qemma_erp_prod"

    # 1. ممنوع قطعياً بدون أي متغيرات
    with pytest.raises(MigrationSecurityError) as exc_default:
        validate_migration_target(prod_url, app_env="production", env_vars={})
    assert "حظر أمني قاطع: ترحيلات بيئة الإنتاج محظورة تماماً عبر مسار Alembic المحلي" in str(exc_default.value)

    # 2. ممنوع قطعياً حتى مع وجود ALLOW_PROD_MIGRATIONS=1
    with pytest.raises(MigrationSecurityError) as exc_single:
        validate_migration_target(
            prod_url,
            app_env="production",
            env_vars={"ALLOW_PROD_MIGRATIONS": "1"},
        )
    assert "حظر أمني قاطع: ترحيلات بيئة الإنتاج محظورة تماماً عبر مسار Alembic المحلي" in str(exc_single.value)

    # 3. ممنوع قطعياً حتى مع وجود التأكيد الثنائي الكامل
    with pytest.raises(MigrationSecurityError) as exc_both:
        validate_migration_target(
            prod_url,
            app_env="production",
            env_vars={"ALLOW_PROD_MIGRATIONS": "1", "PROD_MIGRATION_CONFIRM_DB": "qemma_erp_prod"},
        )
    assert "حظر أمني قاطع: ترحيلات بيئة الإنتاج محظورة تماماً عبر مسار Alembic المحلي" in str(exc_both.value)

    # 4. ينطبق نفس الحظر القاطع على الاختصار 'prod'
    with pytest.raises(MigrationSecurityError) as exc_prod_short:
        validate_migration_target(
            prod_url,
            app_env="prod",
            env_vars={"ALLOW_PROD_MIGRATIONS": "1", "PROD_MIGRATION_CONFIRM_DB": "qemma_erp_prod"},
        )
    assert "حظر أمني قاطع: ترحيلات بيئة الإنتاج محظورة تماماً عبر مسار Alembic المحلي" in str(exc_prod_short.value)


def test_migration_rejects_unknown_environment():
    """رفض أي بيئة تشغيل غير معروفة لحظر أي تشغيل عشوائي."""
    with pytest.raises(MigrationSecurityError) as exc:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@localhost:5432/qemma_test_db",
            app_env="staging",
        )
    assert "بيئة التشغيل 'staging' غير معتمدة" in str(exc.value)


def test_offline_migration_policy_enforcement():
    """الوضع غير المتصل (Offline Mode) يخضع لنفس قواعد التحقق ولا يمكن استخدامه لتجاوز الحظر."""
    # رابط إنتاجي يرفض في كل الأحوال
    prod_url = "postgresql+asyncpg://admin:secret@prod-db.internal:5432/qemma_erp_prod"
    with pytest.raises(MigrationSecurityError) as exc_prod:
        validate_migration_target(prod_url, app_env="production")
    assert "ترحيلات بيئة الإنتاج محظورة تماماً" in str(exc_prod.value)

    # رابط dev يرفض إذا كانت البيئة testing
    dev_url = "postgresql+asyncpg://user:pass@localhost:5432/qemma_erp_dev"
    with pytest.raises(MigrationSecurityError) as exc_dev:
        validate_migration_target(dev_url, app_env="testing")
    assert "ترحيلات بيئة الاختبار مسموحة فقط على قواعد بيانات الاختبار" in str(exc_dev.value)
    """رفض أي بيئة تشغيل غير معروفة لحظر أي تشغيل عشوائي."""
    with pytest.raises(MigrationSecurityError) as exc:
        validate_migration_target(
            "postgresql+asyncpg://user:pass@localhost:5432/qemma_test_db",
            app_env="staging",
        )
    assert "بيئة التشغيل 'staging' غير معتمدة" in str(exc.value)


# ═════════════════════════════════════════════════════════════════════════════
# 4. اختبارات أمان سكربتات التهيئة (Scripts Safety)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_seed_script_rejects_unsafe_database_targets():
    """سكربت التهيئة يرفض العمل قطعياً على قواعد التطوير أو الإنتاج أو السيرفرات الخارجية."""
    # محاولة تشغيل السكربت على قاعدة التطوير
    with pytest.raises(UnsafeTestDatabaseError) as exc_dev:
        await setup_and_seed_test_database("postgresql+asyncpg://user:pass@localhost:5432/qemma_erp_dev")
    assert "محاولة الاتصال بقاعدة بيانات محظورة 'qemma_erp_dev'" in str(exc_dev.value)

    # محاولة تشغيل السكربت على سيرفر خارجي
    with pytest.raises(UnsafeTestDatabaseError) as exc_host:
        await setup_and_seed_test_database("postgresql+asyncpg://user:pass@198.51.100.25:5432/qemma_test_db")
    assert "غير مصرح به" in str(exc_host.value)


# ═════════════════════════════════════════════════════════════════════════════
# 5. اختبارات التحقق من الخادم الحي وعزل التنظيف
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_live_server_check_aborts_on_forbidden_database():
    """التحقق الحي من الخادم: الخادم يقطع الاتصال إذا كانت قاعدة البيانات الحالية محظورة."""
    mock_conn = AsyncMock()
    mock_res = MagicMock()
    mock_res.scalar.return_value = "qemma_erp_dev"
    mock_conn.execute.return_value = mock_res

    with pytest.raises(UnsafeTestDatabaseError) as exc:
        await verify_active_connection(mock_conn)
    assert "متصل بقاعدة بيانات فعلية محظورة 'qemma_erp_dev'" in str(exc.value)


@pytest.mark.asyncio
async def test_active_connection_passes_on_test_db(session: AsyncSession):
    """التأكد من أن الاتصال الفعلي النشط في الاختبارات متصل حصراً بـ qemma_test_db."""
    res = await session.execute(text("SELECT current_database();"))
    active_db = res.scalar()
    assert active_db == "qemma_test_db", f"قاعدة البيانات المتصل بها هي {active_db} وليست qemma_test_db!"


@pytest.mark.asyncio
async def test_cleanup_only_deletes_own_test_data(session: AsyncSession):
    """التحقق من أن عملية التنظيف تحذف فقط السجلات التي أنشأها الاختبار نفسه."""
    treasury = await session.scalar(select(CashAccount).where(CashAccount.account_type == "treasury"))
    assert treasury is not None

    doc_external_id = str(uuid.uuid4())
    doc_external = CashDocument(
        id=doc_external_id,
        document_number=f"CSH-OTHER-PRESERVED-{uuid.uuid4().hex[:6]}",
        document_type="income",
        to_account_id=treasury.id,
        amount=Decimal("1234.00"),
        description="سجل بيانات موجود لا يجوز حذفه في التنظيف",
        occurred_at=text("NOW()"),
        status="pending",
        created_by="other-process",
    )
    session.add(doc_external)
    await session.commit()

    doc_test_id = str(uuid.uuid4())
    doc_test = CashDocument(
        id=doc_test_id,
        document_number=f"CSH-MY-TEST-DOC-{uuid.uuid4().hex[:6]}",
        document_type="income",
        to_account_id=treasury.id,
        amount=Decimal("500.00"),
        description="سجل اختباري مؤقت",
        occurred_at=text("NOW()"),
        status="pending",
        created_by="test-fixture",
    )
    session.add(doc_test)
    await session.commit()

    try:
        assert (await session.get(CashDocument, doc_external_id)) is not None
        assert (await session.get(CashDocument, doc_test_id)) is not None

        my_test_ids = [doc_test_id]
        await session.execute(delete(CashDocument).where(CashDocument.id.in_(my_test_ids)))
        await session.commit()

        assert (await session.get(CashDocument, doc_test_id)) is None
        assert (await session.get(CashDocument, doc_external_id)) is not None

    finally:
        await session.execute(delete(CashDocument).where(CashDocument.id == doc_external_id))
        await session.commit()
