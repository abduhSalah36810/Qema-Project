"""
حارس أمان وعزل قاعدة بيانات الاختبارات (Test Database Safety Guard).
─────────────────────────────────────────────────────────────────────────────
يضمن بشكل قاطع ومركزي:
1. قائمة سماح حصرية (Strict Host Allowlist) تقصر الاستضافة على localhost / 127.0.0.1 / ::1 افتراضياً.
2. رفض أي hostname أو IP خارجي حتى لو احتوى اسم قاعدة البيانات على 'test'.
3. تطبيع ومطابقة عناوين IPv6 وhostnames بشكل موحد وآمن.
4. منع استخدام أو تسريب قاعدة بيانات التطوير (qemma_erp_dev) أو الإنتاج (qemma_erp_prod).
5. التحقق الحي من خادم PostgreSQL الفعلي (current_database()) لقطع الاتصال قبل أي كتابة.
6. حظر أي fallback تلقائي إلى DATABASE_URL في حال غياب TEST_DATABASE_URL.
─────────────────────────────────────────────────────────────────────────────
"""
import os
import re
from typing import Optional, Set
from urllib.parse import urlparse

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool


class UnsafeTestDatabaseError(Exception):
    """استثناء يُرمى عند اكتشاف محاولة استخدام قاعدة بيانات أو مستضيف غير مخصص للاختبارات."""
    pass


# المستضيفون المصرح لهم صراحة وافتراضياً لقواعد بيانات الاختبارات
DEFAULT_ALLOWED_TEST_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
}

# أسماء قواعد البيانات المحظورة قطعياً في بيئة الاختبار
FORBIDDEN_DB_NAMES = {
    "qemma_erp_dev",
    "qemma_erp_prod",
    "qemma_prod",
    "qemma_erp_production",
    "qemma_production",
    "qemma_dev",
    "postgres",
    "template1",
}

# كلمات مفتاحية في اسم القاعدة تدل على بيئات حساسة
FORBIDDEN_KEYWORDS = ["prod", "production", "live", "staging"]


def normalize_host(host: Optional[str]) -> str:
    """
    توحيد وتطبيع اسم المستضيف:
    - إزالة المسافات الزائدة
    - تحويل إلى حروف صغيرة (lowercase)
    - معالجة أقواس IPv6 المربعة مثل [::1] -> ::1
    """
    if not host or not isinstance(host, str):
        return ""
    cleaned = host.strip().lower()
    if cleaned.startswith("[") and cleaned.endswith("]"):
        cleaned = cleaned[1:-1].strip()
    return cleaned


def get_allowed_test_hosts() -> Set[str]:
    """
    قائمة المستضيفين المصرح لهم صراحة لقواعد بيانات الاختبارات.
    يتم السماح افتراضياً بـ localhost و 127.0.0.1 و ::1 فقط.
    يمكن تحديد مستضيفين إضافيين عبر متغير البيئة TEST_ALLOWED_HOSTS (مفصولين بفاصلة) دون توسيع تلقائي.
    """
    hosts = set(DEFAULT_ALLOWED_TEST_HOSTS)
    extra = os.environ.get("TEST_ALLOWED_HOSTS", "").strip()
    if extra:
        for h in extra.split(","):
            norm = normalize_host(h)
            if norm:
                hosts.add(norm)
    return hosts


def extract_host_and_db_from_url(url: str) -> tuple[str, str]:
    """
    استخراج وتطبيع اسم المستضيف واسم قاعدة البيانات من رابط الاتصال.
    يرفض الروابط المشوهة (Malformed) أو التي تفتقر للمستضيف أو اسم القاعدة.
    """
    if not url or not isinstance(url, str) or not url.strip():
        raise UnsafeTestDatabaseError("رابط قاعدة البيانات غير موجود أو فارغ.")

    clean_url = url.strip()

    # التحقق من وجود البروتوكول وتوحيده للتحليل الآمن
    if "://" not in clean_url:
        raise UnsafeTestDatabaseError(f"تنسيق الرابط غير صالح (Malformed URL - Missing scheme): {url}")

    proto, remainder = clean_url.split("://", 1)
    if not remainder or remainder.startswith("/"):
        raise UnsafeTestDatabaseError(f"تنسيق الرابط يفتقر لاسم المستضيف (Empty or missing host): {url}")

    # دعم صيغ IPv6 المجردة مثل @::1:5432 بتحويلها للصيغة القياسية @[::1]:5432
    if "@::1" in remainder and "@[::1]" not in remainder:
        remainder = remainder.replace("@::1", "@[::1]")
    elif remainder.startswith("::1") and not remainder.startswith("[::1]"):
        remainder = remainder.replace("::1", "[::1]", 1)

    # استبدال البروتوكول مؤقتاً بـ http لتحليله بواسطة urlparse القياسي
    parseable_url = f"http://{remainder}"

    try:
        parsed = urlparse(parseable_url)
    except Exception as e:
        raise UnsafeTestDatabaseError(f"فشل تحليل رابط قاعدة البيانات (Malformed URL): {e}")

    raw_host = parsed.hostname
    host = normalize_host(raw_host)
    if not host:
        raise UnsafeTestDatabaseError(f"تعذر استخراج اسم المستضيف من الرابط المحدد (Empty hostname): {url}")

    db_name = (parsed.path or "").lstrip("/")
    if "?" in db_name:
        db_name = db_name.split("?", 1)[0]
    db_name = db_name.strip()

    if not db_name:
        raise UnsafeTestDatabaseError(f"تعذر استخراج اسم قاعدة البيانات من الرابط المحدد (Empty dbname): {url}")

    return host, db_name


def extract_database_name_from_url(url: str) -> str:
    """استخراج اسم قاعدة البيانات فقط من الرابط للاستخدامات السريعة."""
    _, db_name = extract_host_and_db_from_url(url)
    return db_name


def validate_test_database_url(url: str) -> str:
    """
    التحقق الصارم من أن الرابط يشير حصراً إلى قاعدة بيانات اختبار معتمدة ومستضيف مصرح به.
    يرفض:
    - أي مستضيف غير موجود في Allowlist (مثل أي IP خارجي أو دومين سحابي).
    - غياب اسم القاعدة أو المستضيف.
    - أسماء قواعد التطوير والإنتاج.
    - أي قاعدة لا تحوي كلمة 'test' صراحة في اسمها.
    """
    host, db_name = extract_host_and_db_from_url(url)
    allowed_hosts = get_allowed_test_hosts()

    # 1. التحقق الصارم من قائمة السماح (Strict Host Allowlist)
    if host not in allowed_hosts:
        raise UnsafeTestDatabaseError(
            f"حظر أمني: المستضيف '{host}' غير مصرح به لقواعد بيانات الاختبارات. "
            f"المستضيفون المصرح بهم هم: {sorted(allowed_hosts)}. "
            f"ممنوع الاتصال بأي خوادم خارجية أو إنتاجية حتى لو حملت القاعدة اسم test."
        )

    # 2. فحص اسم قاعدة البيانات
    normalized_db = db_name.lower()
    if normalized_db in FORBIDDEN_DB_NAMES:
        raise UnsafeTestDatabaseError(
            f"حظر أمني: محاولة الاتصال بقاعدة بيانات محظورة '{db_name}'. "
            f"ممنوع استخدام قواعد التطوير أو الإنتاج في الاختبارات."
        )

    for kw in FORBIDDEN_KEYWORDS:
        if kw in normalized_db and "test" not in normalized_db:
            raise UnsafeTestDatabaseError(
                f"حظر أمني: اسم قاعدة البيانات '{db_name}' يحتوي على الكلمة المحظورة '{kw}'."
            )

    # 3. شرط التسمية الصريح لقواعد الاختبار
    if "test" not in normalized_db:
        raise UnsafeTestDatabaseError(
            f"حظر أمني: اسم قاعدة البيانات '{db_name}' لا يحتوي على 'test'. "
            f"يجب أن تكون قاعدة الاختبار مخصصة ومعرّفة صراحة (مثل: qemma_test_db)."
        )

    return url


def get_test_database_url() -> str:
    """
    جلب رابط قاعدة بيانات الاختبار المعتمد حصراً من TEST_DATABASE_URL.
    ممنوع منعاً باتاً الرجوع التلقائي إلى DATABASE_URL تجنباً للاتصال بقاعدة التطوير أو الإنتاج.
    """
    url = os.environ.get("TEST_DATABASE_URL")
    if not url or not url.strip():
        raise UnsafeTestDatabaseError(
            "حظر أمني: المتغير TEST_DATABASE_URL غير محدد في البيئة.\n"
            "تم رفض الرجوع التلقائي إلى DATABASE_URL لحماية قواعد التطوير والإنتاج.\n"
            "يرجى ضبط TEST_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/qemma_test_db"
        )
    return validate_test_database_url(url)


async def verify_active_connection(conn: AsyncConnection) -> str:
    """
    التحقق من الخادم الحي (Live PostgreSQL Server Check).
    يستعلم عن current_database() الفعلية ويتحقق من مطابقتها لضوابط الأمان.
    """
    res = await conn.execute(text("SELECT current_database();"))
    active_db = res.scalar()
    if not active_db:
        raise UnsafeTestDatabaseError("فشل استعلام اسم قاعدة البيانات الحالية من خادم PostgreSQL.")

    normalized_active = active_db.strip().lower()

    if normalized_active in FORBIDDEN_DB_NAMES:
        raise UnsafeTestDatabaseError(
            f"حظر أمني جسيم: الخادم متصل بقاعدة بيانات فعلية محظورة '{active_db}'. "
            f"تم إيقاف الاتصال فوراً قبل تنفيذ أي عملية كتابة."
        )

    if "test" not in normalized_active:
        raise UnsafeTestDatabaseError(
            f"حظر أمني: قاعدة البيانات النشطة على الخادم '{active_db}' لا تحوي 'test'. تم رفض الجلسة."
        )

    return active_db


async def create_isolated_test_engine(url: Optional[str] = None) -> AsyncEngine:
    """
    إنشاء Engine معزول لقاعدة بيانات الاختبار مع التحقق الأمني المزدوج (Strict URL Allowlist + Live Server DB).
    """
    resolved_url = validate_test_database_url(url) if url else get_test_database_url()
    engine = create_async_engine(resolved_url, poolclass=NullPool, echo=False)

    # التحقق الفوري من الخادم الحي قبل السماح باستخدام الـ Engine
    async with engine.connect() as conn:
        await verify_active_connection(conn)

    return engine
