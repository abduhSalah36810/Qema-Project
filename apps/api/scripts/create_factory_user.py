"""
إنشاء حساب موظف في المصنع (Supabase Auth) وإسناد دوره في النظام — يشغّله مسؤول النظام فقط.
─────────────────────────────────────────────────────────────────────────────
لا توجد شاشة لإدارة المستخدمين داخل النظام؛ هذا السكربت هو الطريق المعتمد:
  1. ينشئ الحساب في Supabase Auth بالبريد وكلمة مرور مؤقتة (البريد مؤكد مباشرة، بلا رسائل).
  2. يسند الدور في جدول user_roles بقاعدة المصنع.
  3. إن كان البريد موجوداً بالفعل: يكتفي بإسناد الدور (ويغيّر كلمة المرور فقط مع --reset-password).

المتغيرات المطلوبة في البيئة (لا تُكتب في الأمر ولا تُحفظ في المستودع ولا تُطبع):
  SUPABASE_URL                 عنوان مشروع Supabase
  SUPABASE_SERVICE_ROLE_KEY    مفتاح الخدمة السري (يبقى عند مسؤول النظام فقط، لا يوضع في الواجهة أبداً)
  DATABASE_URL                 رابط قاعدة المصنع (postgresql+asyncpg://...)

الاستخدام:
  python scripts/create_factory_user.py --email ahmed@factory.com --role finance_manager
  python scripts/create_factory_user.py --email ahmed@factory.com --role finance_manager --reset-password
الأدوار: general_manager, warehouse_manager, production_manager, finance_manager
كلمة المرور المؤقتة تُولَّد عشوائياً وتُعرض مرة واحدة؛ سلّمها للموظف يداً بيد.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROLES = {"general_manager", "warehouse_manager", "production_manager", "finance_manager"}


def _temp_password(length: int = 14) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        pwd = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(c.isdigit() for c in pwd) and any(c.isupper() for c in pwd) and any(c.islower() for c in pwd):
            return pwd


def _admin_request(base: str, key: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{base.rstrip('/')}/auth/v1/admin{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise SystemExit(f"رفض Supabase الطلب ({exc.code}): {detail}") from None


def _find_user(base: str, key: str, email: str) -> dict | None:
    page = 1
    while True:
        data = _admin_request(base, key, "GET", f"/users?page={page}&per_page=200")
        users = data.get("users", [])
        for user in users:
            if (user.get("email") or "").lower() == email:
                return user
        if len(users) < 200:
            return None
        page += 1


async def _assign_role(database_url: str, user_id: str, role_name: str) -> str:
    import app.db.base  # noqa: F401  تسجيل كل النماذج
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from app.modules.identity.models import Role, UserRole

    engine = create_async_engine(database_url, pool_pre_ping=True)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)() as db:
            role = await db.scalar(select(Role).where(Role.name == role_name))
            if not role:
                raise SystemExit("الأدوار غير موجودة في القاعدة. شغّل scripts/bootstrap_factory_db.py أولاً.")
            existing = (await db.scalars(select(UserRole).where(UserRole.user_id == user_id))).all()
            if any(link.role_id == role.id for link in existing):
                return f"الدور «{role.display_name_ar}» مسند بالفعل."
            # موظف واحد = دور واحد: يُستبدل أي دور سابق
            for link in existing:
                await db.delete(link)
            db.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role_id=role.id, assigned_by="create_factory_user"))
            await db.commit()
            return f"أُسند الدور «{role.display_name_ar}»" + (" (واستُبدل الدور السابق)" if existing else "") + "."
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="إنشاء حساب موظف وإسناد دوره")
    parser.add_argument("--email", required=True)
    parser.add_argument("--role", required=True, choices=sorted(ROLES))
    parser.add_argument("--reset-password", action="store_true", help="توليد كلمة مرور مؤقتة جديدة لحساب موجود")
    args = parser.parse_args()

    base = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not (base and key and database_url):
        raise SystemExit("حدد SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY و DATABASE_URL في متغيرات البيئة.")
    email = args.email.strip().lower()

    user = _find_user(base, key, email)
    password = None
    if user is None:
        password = _temp_password()
        user = _admin_request(base, key, "POST", "/users", {"email": email, "password": password, "email_confirm": True})
        print(f"تم إنشاء الحساب: {email}")
    else:
        print(f"الحساب موجود بالفعل: {email}")
        if args.reset_password:
            password = _temp_password()
            _admin_request(base, key, "PUT", f"/users/{user['id']}", {"password": password})
            print("تم تعيين كلمة مرور مؤقتة جديدة.")

    print(asyncio.run(_assign_role(database_url, user["id"], args.role)))
    if password:
        print("─" * 40)
        print(f"كلمة المرور المؤقتة (تظهر مرة واحدة): {password}")
        print("سلّمها للموظف يداً بيد، ولا ترسلها في مجموعة أو تحفظها في ملف.")


if __name__ == "__main__":
    main()
