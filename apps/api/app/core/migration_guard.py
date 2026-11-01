"""
حارس أمان ترحيلات Alembic وسياسة التحقق متعددة البيئات (Alembic Migration Guard).
─────────────────────────────────────────────────────────────────────────────
يطبق سياسة حماية مركزية صارمة تمنع تطبيق الترحيلات على قواعد خاطئة أو إنتاجية:
1. بيئة الاختبار (test/testing): ترحيلات مسموحة فقط على قاعدة اختبار تجتاز فحص Test Allowlist.
2. بيئة التطوير (dev/development): ترحيلات مسموحة فقط على قاعدة التطوير المعتمدة صراحة (qemma_erp_dev).
3. بيئة الإنتاج (prod/production): ترحيلات ممنوعة افتراضياً؛ تتطلب تحققاً ثنائياً صريحاً:
   ALLOW_PROD_MIGRATIONS=1 مع مطابقة تأكيدية لاسم القاعدة عبر PROD_MIGRATION_CONFIRM_DB.
─────────────────────────────────────────────────────────────────────────────
"""
import os
import re
from typing import Mapping, Optional, Set
from urllib.parse import urlparse


class MigrationSecurityError(Exception):
    """استثناء يُرمى عند انتهاك سياسة أمان ترحيلات قاعدة البيانات."""
    pass


DEFAULT_ALLOWED_DEV_HOSTS = {"localhost", "127.0.0.1", "::1"}
DEFAULT_ALLOWED_TEST_HOSTS = {"localhost", "127.0.0.1", "::1"}
DEFAULT_APPROVED_DEV_DBS = {"qemma_erp_dev"}

FORBIDDEN_KEYWORDS = ["prod", "production", "live", "staging"]


def _normalize_host(host: Optional[str]) -> str:
    if not host or not isinstance(host, str):
        return ""
    cleaned = host.strip().lower()
    if cleaned.startswith("[") and cleaned.endswith("]"):
        cleaned = cleaned[1:-1].strip()
    return cleaned


def extract_migration_target(url: str) -> tuple[str, str]:
    """استخراج المستضيف واسم قاعدة البيانات من رابط الترحيل."""
    if not url or not isinstance(url, str) or not url.strip():
        raise MigrationSecurityError("رابط قاعدة البيانات للترحيل غير محدد (فارغ).")

    clean_url = url.strip()
    if "://" not in clean_url:
        raise MigrationSecurityError(f"رابط قاعدة البيانات غير صالح (Malformed URL): {url}")

    _, remainder = clean_url.split("://", 1)
    if not remainder or remainder.startswith("/"):
        raise MigrationSecurityError(f"رابط قاعدة البيانات يفتقر لاسم المستضيف (Missing host): {url}")

    if "@::1" in remainder and "@[::1]" not in remainder:
        remainder = remainder.replace("@::1", "@[::1]")
    elif remainder.startswith("::1") and not remainder.startswith("[::1]"):
        remainder = remainder.replace("::1", "[::1]", 1)

    parseable_url = f"http://{remainder}"
    try:
        parsed = urlparse(parseable_url)
    except Exception as e:
        raise MigrationSecurityError(f"فشل تحليل رابط قاعدة البيانات: {e}")

    host = _normalize_host(parsed.hostname)
    if not host:
        raise MigrationSecurityError(f"اسم المستضيف غير صالح في رابط الترحيل: {url}")

    db_name = (parsed.path or "").lstrip("/")
    if "?" in db_name:
        db_name = db_name.split("?", 1)[0]
    db_name = db_name.strip()
    if not db_name:
        raise MigrationSecurityError(f"اسم قاعدة البيانات مفقود في رابط الترحيل: {url}")

    return host, db_name


def validate_migration_target(
    database_url: str,
    app_env: str,
    env_vars: Optional[Mapping[str, str]] = None,
) -> tuple[str, str]:
    """
    التحقق الصارم من سياسة الترحيل حسب البيئة (Policy Enforcement).
    يعيد (host, db_name) في حال اجتياز التحقق بنجاح.
    """
    if env_vars is None:
        env_vars = os.environ

    host, db_name = extract_migration_target(database_url)
    normalized_env = (app_env or "development").strip().lower()
    normalized_db = db_name.lower()

    # ─────────────────────────────────────────────────────────────────────────
    # 1. بيئة الاختبارات (Testing / Test)
    # ─────────────────────────────────────────────────────────────────────────
    if normalized_env in ("testing", "test"):
        allowed_hosts = set(DEFAULT_ALLOWED_TEST_HOSTS)
        extra_hosts = env_vars.get("TEST_ALLOWED_HOSTS", "").strip()
        if extra_hosts:
            allowed_hosts.update(_normalize_host(h) for h in extra_hosts.split(",") if _normalize_host(h))

        if host not in allowed_hosts:
            raise MigrationSecurityError(
                f"حظر أمني: ترحيلات بيئة الاختبار مسموحة فقط على السيرفر المحلي {sorted(allowed_hosts)}. "
                f"المستهدف host='{host}' مرفوض قطعياً."
            )

        if "test" not in normalized_db or normalized_db in {"qemma_erp_dev", "qemma_erp_prod", "postgres"}:
            raise MigrationSecurityError(
                f"حظر أمني: ترحيلات بيئة الاختبار مسموحة فقط على قواعد بيانات الاختبار (تحتوي على 'test'). "
                f"المستهدف db='{db_name}' مرفوض."
            )

        return host, db_name

    # ─────────────────────────────────────────────────────────────────────────
    # 2. بيئة التطوير (Development / Dev)
    # ─────────────────────────────────────────────────────────────────────────
    if normalized_env in ("development", "dev"):
        allowed_dev_hosts = set(DEFAULT_ALLOWED_DEV_HOSTS)
        extra_dev_hosts = env_vars.get("DEV_ALLOWED_HOSTS", "").strip()
        if extra_dev_hosts:
            allowed_dev_hosts.update(_normalize_host(h) for h in extra_dev_hosts.split(",") if _normalize_host(h))

        if host not in allowed_dev_hosts:
            raise MigrationSecurityError(
                f"حظر أمني: ترحيلات بيئة التطوير مسموحة فقط على السيرفر المحلي {sorted(allowed_dev_hosts)}. "
                f"المستهدف host='{host}' مرفوض لمنع تشغيل ترحيلات dev على سيرفرات خارجية."
            )

        allowed_dev_dbs = set(DEFAULT_APPROVED_DEV_DBS)
        extra_dev_dbs = env_vars.get("DEV_ALLOWED_DBS", "").strip()
        if extra_dev_dbs:
            allowed_dev_dbs.update(d.strip().lower() for d in extra_dev_dbs.split(",") if d.strip())

        # منع قواعد الإنتاج أو القواعد غير المعروفة
        for kw in FORBIDDEN_KEYWORDS:
            if kw in normalized_db:
                raise MigrationSecurityError(
                    f"حظر أمني: محاولة تشغيل ترحيلات التطوير على قاعدة إنتاجية أو حساسة '{db_name}'."
                )

        if normalized_db not in allowed_dev_dbs:
            raise MigrationSecurityError(
                f"حظر أمني: ترحيلات بيئة التطوير مسموحة فقط على قواعد التطوير المعتمدة {sorted(allowed_dev_dbs)}. "
                f"المستهدف db='{db_name}' غير معتمد."
            )

        return host, db_name

    # ─────────────────────────────────────────────────────────────────────────
    # 3. بيئة الإنتاج (Production / Prod)
    # ─────────────────────────────────────────────────────────────────────────
    if normalized_env in ("production", "prod"):
        raise MigrationSecurityError(
            "حظر أمني قاطع: ترحيلات بيئة الإنتاج محظورة تماماً عبر مسار Alembic المحلي.\n"
            "ممنوع تشغيل ترحيلات الإنتاج محلياً بصرف النظر عن أي متغيرات بيئية "
            "(مثل ALLOW_PROD_MIGRATIONS أو PROD_MIGRATION_CONFIRM_DB).\n"
            "مسار النشر الآمن المخصص للإنتاج (Dedicated Deployment Pipeline) هو المخول فقط مستقبلاً."
        )

    # ─────────────────────────────────────────────────────────────────────────
    # 4. أي بيئة أخرى غير معروفة
    # ─────────────────────────────────────────────────────────────────────────
    raise MigrationSecurityError(
        f"حظر أمني: بيئة التشغيل '{app_env}' غير معتمدة لترحيلات Alembic. الترحيل مقفل افتراضياً."
    )
