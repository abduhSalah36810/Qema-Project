"""
تجهيز قاعدة بيانات المصنع الفعلية (نظيفة، بلا بيانات تجريبية).
─────────────────────────────────────────────────────────────────────────────
يُشغَّل مرة واحدة على قاعدة جديدة بعد تطبيق الترحيلات (alembic upgrade head) عليها.

ما تنشئه الترحيلات نفسها: الخزنة الرئيسية، دليل الحسابات، أغلب وحدات القياس، تصنيفات الأصناف، خطوط الاستخدام.
ما يضيفه هذا السكربت فقط (إن لم يكن موجوداً):
  1. الأدوار الأربعة: المدير العام، أمين المخزن، مسؤول الإنتاج، المدير المالي.
  2. المخازن الثلاثة: الخامات، تحت التشغيل، المنتج التام.
  3. وحدة «قطعة» (piece) التي يحتاجها المنتج التام.
  4. (اختياري) إسناد الأدوار لحسابات المستخدمين: --assign USER_ID=ROLE

لا يضيف أي صنف أو موديل أو مورد أو عميل أو حركة أو رصيد. لا يحذف ولا يعدّل أي سجل قائم.
الأصناف والموديلات والمستلزمات يدخلها المصنع من الشاشات، والأرصدة الافتتاحية بالجرد وسند القبض.

الاستخدام (DATABASE_URL لا يُكتب في الكود ولا يُطبع):
  DATABASE_URL=postgresql+asyncpg://... python scripts/bootstrap_factory_db.py --confirm-db <اسم_القاعدة>
  DATABASE_URL=... python scripts/bootstrap_factory_db.py --confirm-db <اسم_القاعدة> \\
      --assign <supabase-user-id>=general_manager --assign <id>=finance_manager
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select, text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

ROLES = [
    ("general_manager", "المدير العام", "إدارة شاملة واعتماد الجرد والأصناف ومتابعة التقارير"),
    ("warehouse_manager", "أمين المخزن", "المشتريات والاستلام وصرف الخامات واستلام التام والتسليم والجرد"),
    ("production_manager", "مسؤول الإنتاج", "الموديلات ومستلزمات التصنيع وأوامر التشغيل ومراحلها والتسوية والإغلاق"),
    ("finance_manager", "المدير المالي", "الخزينة والسندات والعهد والتحصيلات وسداد الموردين والرواتب"),
]
WAREHOUSES = [
    ("main_raw_materials", "مخزن الخامات الرئيسي"),
    ("work_in_progress", "مخزن تحت التشغيل ودفعات الإنتاج"),
    ("finished_goods", "مخزن المنتج التام"),
]
UNITS = [("piece", "قطعة")]
# قواعد التطوير/الاختبار/العرض المحلية: لا تُجهَّز كقاعدة مصنع بالخطأ
LOCAL_NON_FACTORY_DBS = {"qemma_erp_dev", "qemma_test_db", "qemma_pilot_demo"}


def _db_name(url: str) -> str:
    return (urlparse(url).path or "").lstrip("/").split("?", 1)[0]


async def bootstrap(database_url: str, assignments: list[tuple[str, str]]) -> None:
    import app.db.base  # noqa: F401  تسجيل كل النماذج (نفس ما يستخدمه alembic)
    from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID
    from app.modules.finance.models import Account, CashAccount, CashDocument
    from app.modules.identity.models import Role, UserRole
    from app.modules.production.models import CatalogItem, Product, ProductionOrder, Unit, Warehouse

    engine = create_async_engine(database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    try:
        async with session_factory() as db:
            version = await db.scalar(text("SELECT version_num FROM alembic_version"))
            if not version:
                raise SystemExit("القاعدة لم تُطبق عليها الترحيلات بعد. طبّق alembic upgrade head أولاً.")
            if not await db.get(CashAccount, CANONICAL_TREASURY_ID):
                raise SystemExit("الخزنة الرئيسية غير موجودة؛ الترحيلات غير مكتملة على هذه القاعدة.")
            if not await db.scalar(select(func.count()).select_from(Account)):
                raise SystemExit("دليل الحسابات غير موجود؛ الترحيلات غير مكتملة على هذه القاعدة.")

            added: list[str] = []
            roles_by_name = {r.name: r for r in (await db.scalars(select(Role))).all()}
            for name, name_ar, desc in ROLES:
                if name not in roles_by_name:
                    role = Role(id=str(uuid.uuid4()), name=name, display_name_ar=name_ar, description=desc)
                    db.add(role)
                    roles_by_name[name] = role
                    added.append(f"دور: {name_ar}")
            for code, name_ar in WAREHOUSES:
                if not await db.scalar(select(Warehouse.id).where(Warehouse.code == code)):
                    db.add(Warehouse(id=str(uuid.uuid4()), code=code, name_ar=name_ar, is_active=True))
                    added.append(f"مخزن: {name_ar}")
            for code, name_ar in UNITS:
                if not await db.scalar(select(Unit.id).where(Unit.code == code)):
                    db.add(Unit(id=str(uuid.uuid4()), code=code, name_ar=name_ar))
                    added.append(f"وحدة: {name_ar}")
            await db.flush()

            for user_id, role_name in assignments:
                role = roles_by_name.get(role_name)
                if not role:
                    raise SystemExit(f"دور غير معروف: {role_name}. الأدوار المتاحة: {', '.join(n for n, *_ in ROLES)}")
                exists = await db.scalar(select(UserRole.id).where(UserRole.user_id == user_id, UserRole.role_id == role.id))
                if not exists:
                    db.add(UserRole(id=str(uuid.uuid4()), user_id=user_id, role_id=role.id, assigned_by="bootstrap_factory_db"))
                    added.append(f"إسناد دور {role.display_name_ar} للمستخدم {user_id[:8]}…")

            await db.commit()

            counts = {
                "أصناف الدليل": await db.scalar(select(func.count()).select_from(CatalogItem)),
                "الموديلات": await db.scalar(select(func.count()).select_from(Product)),
                "أوامر التشغيل": await db.scalar(select(func.count()).select_from(ProductionOrder)),
                "المستندات النقدية": await db.scalar(select(func.count()).select_from(CashDocument)),
                "مستخدمون لهم أدوار": await db.scalar(select(func.count(func.distinct(UserRole.user_id)))),
            }
        print(f"إصدار القاعدة: {version}")
        print("أُضيف:" if added else "لا شيء جديد؛ البيانات الأساسية موجودة بالفعل.")
        for line in added:
            print(f"  - {line}")
        print("الوضع الحالي:")
        for label, value in counts.items():
            print(f"  - {label}: {value}")
        if counts["أصناف الدليل"] or counts["الموديلات"] or counts["أوامر التشغيل"] or counts["المستندات النقدية"]:
            print("تنبيه: القاعدة تحتوي بيانات تشغيلية بالفعل؛ لم يُحذف أو يُعدّل شيء منها.")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="تجهيز قاعدة المصنع النظيفة (بلا بيانات تجريبية)")
    parser.add_argument("--confirm-db", required=True, help="اسم قاعدة البيانات المستهدفة للتأكيد")
    parser.add_argument("--assign", action="append", default=[], metavar="USER_ID=ROLE",
                        help="إسناد دور لمستخدم Supabase (المعرّف sub)؛ يمكن تكراره")
    parser.add_argument("--allow-local-db", action="store_true", help="السماح بقواعد التطوير/الاختبار المحلية (للتجربة فقط)")
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("حدد DATABASE_URL في متغيرات البيئة (لا يُكتب في الأمر أو الكود).")
    db_name = _db_name(database_url)
    if db_name != args.confirm_db:
        raise SystemExit(f"اسم القاعدة في DATABASE_URL ({db_name}) لا يطابق --confirm-db ({args.confirm_db}).")
    if db_name in LOCAL_NON_FACTORY_DBS and not args.allow_local_db:
        raise SystemExit(f"{db_name} قاعدة تطوير/اختبار/عرض محلية وليست قاعدة المصنع.")

    assignments = []
    for item in args.assign:
        user_id, sep, role = item.partition("=")
        if not sep or not user_id.strip() or not role.strip():
            raise SystemExit(f"صيغة الإسناد غير صحيحة: {item}. المطلوب USER_ID=ROLE")
        assignments.append((user_id.strip(), role.strip().lower()))

    asyncio.run(bootstrap(database_url, assignments))


if __name__ == "__main__":
    main()
