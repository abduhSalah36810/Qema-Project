"""
تشغيل خادم الـ API على قاعدة العرض التجريبي qemma_pilot_demo (للعرض أمام المصنع فقط).
─────────────────────────────────────────────────────────────────────────────
- يقرأ بيانات اتصال قاعدة التطوير من .env ويغير اسم القاعدة إلى qemma_pilot_demo (لا يطبع كلمة المرور).
- الخادم يُشغل كعملية مستقلة بمتغيرات البيئة الجديدة، حتى لا تبقى إعدادات قاعدة التطوير محملة.
- المنفذ الافتراضي 8010 والواجهة المسموح لها http://localhost:5180 حتى لا يتعارض مع بيئة التطوير (8000 / 5173).
- الدخول المحلي بالأدوار يعمل لأن البيئة development. لا تستخدم هذا السكربت على خادم مشترك أو إنتاجي.

الاستخدام:
    python scripts/run_pilot_api.py            # http://localhost:8010
ثم الواجهة:
    cd apps/web; $env:VITE_API_BASE_URL="http://localhost:8010"; npm run dev -- --port 5180
"""
from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from reset_pilot_demo_db import DEMO_DB, demo_database_url  # noqa: E402


def main() -> int:
    port = os.environ.get("PILOT_API_PORT", "8010")
    web_port = os.environ.get("PILOT_WEB_PORT", "5180")
    env = {
        **os.environ,
        "DATABASE_URL": demo_database_url(),
        "APP_ENV": "development",
        "DEV_ALLOWED_DBS": DEMO_DB,
        "CORS_ALLOWED_ORIGINS": f"http://localhost:{web_port},http://127.0.0.1:{web_port}",
    }
    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    print(f"تشغيل الـ API على قاعدة {DEMO_DB} — http://localhost:{port}")
    return subprocess.call(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", port],
        cwd=api_dir, env=env,
    )


if __name__ == "__main__":
    sys.exit(main())
