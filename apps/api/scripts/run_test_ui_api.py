"""
تشغيل نسخة API محلية لمراجعة الواجهة والتقاط الصور على قاعدة الاختبار المعزولة فقط.
─────────────────────────────────────────────────────────────────────────────
- يرفض التشغيل إلا إذا كانت قاعدة البيانات هي qemma_test_db (لا يلمس قاعدة التطوير أو العرض).
- الدخول المحلي (اختيار الدور) مفعّل لبيئة testing فقط، بمفتاح توقيع عشوائي يُولَّد عند كل تشغيل ولا يُحفظ.
- المنفذ 8020، ويسمح بطلبات الواجهة على 5190 فقط.

الاستخدام (من جذر المستودع):
    apps/api/.venv/Scripts/python apps/api/scripts/run_test_ui_api.py
ثم شغّل الواجهة:  VITE_API_BASE_URL=http://localhost:8020  npm --prefix apps/web run dev -- --port 5190
"""
import os
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

API_DIR = Path(__file__).resolve().parents[1]
TEST_DB_NAME = "qemma_test_db"
DEFAULT_TEST_DB_URL = f"postgresql+asyncpg://qemma_dev:changeme_local_only@localhost:5432/{TEST_DB_NAME}"


def main() -> int:
    db_url = os.environ.get("TEST_DATABASE_URL", DEFAULT_TEST_DB_URL)
    parsed = urlparse(db_url.replace("+asyncpg", ""))
    if parsed.path.lstrip("/") != TEST_DB_NAME or parsed.hostname not in ("localhost", "127.0.0.1"):
        print(f"[رفض] هذا السكربت يعمل على قاعدة الاختبار المحلية {TEST_DB_NAME} فقط.", file=sys.stderr)
        return 1

    env = dict(os.environ)
    env.update({
        "DATABASE_URL": db_url,
        "APP_ENV": "testing",
        "DEV_AUTH_ENABLED": "true",
        "LOCAL_JWT_SECRET": secrets.token_hex(32),  # مؤقت لكل تشغيل؛ لا يُكتب في أي ملف
        "CORS_ALLOWED_ORIGINS": "http://localhost:5190,http://127.0.0.1:5190",
        "LOG_LEVEL": "warning",
    })
    python = Path(sys.executable)
    return subprocess.call(
        [str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8020"],
        cwd=str(API_DIR),
        env=env,
    )


if __name__ == "__main__":
    sys.exit(main())
