"""
إعادة تهيئة قاعدة العرض التجريبي (qemma_pilot_demo) من الصفر.
─────────────────────────────────────────────────────────────────────────────
يحذف قاعدة العرض فقط ثم ينشئها ويرحّلها حتى آخر إصدار ويبذر البيانات المرجعية
(المخازن الثلاثة، الوحدات، الأدوار، الموديلات والمقاسات، الخزنة الرئيسية، دليل الحسابات).

ضوابط الأمان:
1. اسم القاعدة المستهدفة ثابت: qemma_pilot_demo — لا يقبل أي اسم آخر.
2. الخادم يجب أن يكون محلياً (localhost / 127.0.0.1).
3. يستخدم بيانات اتصال قاعدة التطوير من .env للاتصال بالخادم فقط، ولا يلمس قاعدة التطوير.

الاستخدام (أوقف خادم الـ API المتصل بقاعدة العرض أولاً):
    python scripts/reset_pilot_demo_db.py --yes
ثم شغّل الخادم وبعده:
    python scripts/seed_pilot_demo.py --api http://localhost:8010
"""
from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import asyncpg  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.core.config import settings  # noqa: E402

DEMO_DB = "qemma_pilot_demo"


def demo_database_url() -> str:
    url = make_url(settings.database_url)
    if url.host not in {"localhost", "127.0.0.1", "::1"}:
        raise SystemExit(f"حظر: قاعدة العرض تُدار على خادم محلي فقط (المستهدف {url.host}).")
    return url.set(database=DEMO_DB).render_as_string(hide_password=False)


async def recreate() -> None:
    url = make_url(settings.database_url)
    conn = await asyncpg.connect(host=url.host, port=url.port, user=url.username, password=url.password, database=url.database)
    try:
        await conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", DEMO_DB
        )
        await conn.execute(f'DROP DATABASE IF EXISTS "{DEMO_DB}"')
        await conn.execute(f'CREATE DATABASE "{DEMO_DB}"')
    finally:
        await conn.close()


async def seed_reference() -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.db.base  # noqa: F401
    from app.modules.production.service import seed_provisional_data_if_empty

    engine = create_async_engine(demo_database_url())
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            await seed_provisional_data_if_empty(session)
            await session.commit()
    finally:
        await engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description="إعادة تهيئة قاعدة العرض التجريبي qemma_pilot_demo")
    parser.add_argument("--yes", action="store_true", help="تأكيد حذف قاعدة العرض وإعادة إنشائها")
    args = parser.parse_args()
    if not args.yes:
        print(f"سيُحذف كل ما في قاعدة {DEMO_DB}. أعد التشغيل مع --yes للتأكيد.")
        return 1
    target = demo_database_url()
    print(f"① إعادة إنشاء {DEMO_DB} ...")
    asyncio.run(recreate())
    print("② الترحيل حتى آخر إصدار ...")
    env = {**os.environ, "DATABASE_URL": target, "APP_ENV": "development", "DEV_ALLOWED_DBS": DEMO_DB}
    api_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    result = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=api_dir, env=env)
    if result.returncode != 0:
        print("✖ فشل الترحيل.")
        return result.returncode
    print("③ البيانات المرجعية ...")
    asyncio.run(seed_reference())
    print(f"✔ قاعدة {DEMO_DB} جاهزة. شغّل الخادم ثم scripts/seed_pilot_demo.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
