"""
سكربت آمن ومعزول لتهيئة حزمة البيانات الاختبارية الاصطناعية (E2E Test Dataset Seeder).
─────────────────────────────────────────────────────────────────────────────
رمز الحزمة: E2E-2026-11-02
المستهدف: قاعدة بيانات الاختبارات المعزولة حصراً (مثل qemma_test_db).
ضوابط الأمان:
1. يرفض السكربت العمل على أي قاعدة بيانات لا تحتوي على 'test' في اسمها.
2. يرفض المستضيفين الخارجيين ويقصر الاتصال على Localhost Allowlist.
3. يتحقق من خادم PostgreSQL الفعلي عبر SELECT current_database().
4. لا يقوم بأي عمليات مسح أو حذف، ويقوم بالإدراج بنمط آمن غير متكرر (Idempotent).
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from decimal import Decimal

# إضافة apps/api لمسار البحث
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.db.base  # noqa: F401
from app.modules.customers.models import Customer
from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry, Supplier
from app.modules.production.models import (
    CatalogItem,
    Employee,
    Product,
    ProductVariant,
    ProductionTemplate,
    ProductionTemplateLine,
    ProductionTemplateVersion,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from tests.db_safety import (
    UnsafeTestDatabaseError,
    create_isolated_test_engine,
    validate_test_database_url,
    verify_active_connection,
)


def _uid() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def seed_e2e_dataset(target_url: str | None = None) -> None:
    url = target_url or os.environ.get("DATABASE_URL") or os.environ.get("TEST_DATABASE_URL")
    if not url:
        url = "postgresql+asyncpg://qemma_dev:changeme_local_only@localhost:5432/qemma_test_db"

    # 1. التحقق الصارم من رابط قاعدة البيانات وقائمة السماح
    validated_url = validate_test_database_url(url)
    print(f"🔍 فحص رابط قاعدة البيانات: تم التحقق من مطابقة ضوابط بيئة الاختبار.")

    # 2. إنشاء محرك معزول والتحقق من الخادم الحي
    engine = await create_isolated_test_engine(validated_url)
    async with engine.connect() as conn:
        active_db = await verify_active_connection(conn)
        print(f"🔒 تم تأكيد الاتصال الحي بخادم PostgreSQL: القاعدة النشطة هي '{active_db}'.")

    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    async with session_factory() as session:
        # ── 1. الوحدات الأساسية ───────────────────────────────────────────────
        units_spec = [
            ("meter", "متر"),
            ("piece", "قطعة"),
            ("roll", "بكرة"),
        ]
        units = {}
        for code, name_ar in units_spec:
            u = (await session.execute(select(Unit).where(Unit.code == code))).scalar_one_or_none()
            if not u:
                u = Unit(id=_uid(), code=code, name_ar=name_ar, is_active=True)
                session.add(u)
            units[code] = u

        # ── 2. المخازن التشغيلية ──────────────────────────────────────────────
        whs_spec = [
            ("main_raw_materials", "مخزن الخامات الرئيسي"),
            ("work_in_progress", "مخزن تحت التشغيل"),
            ("finished_goods", "مخزن المنتجات التامة"),
        ]
        warehouses = {}
        for code, name_ar in whs_spec:
            w = (await session.execute(select(Warehouse).where(Warehouse.code == code))).scalar_one_or_none()
            if not w:
                w = Warehouse(id=_uid(), code=code, name_ar=name_ar, is_active=True)
                session.add(w)
            warehouses[code] = w

        await session.flush()

        # ── 3. أصناف الدليل (Approved + Draft) ─────────────────────────────────
        items_spec = [
            (
                "FAB-E2E-COTTON",
                "قماش قطن أبيض E2E",
                "raw_material",
                "meter",
                True,
                "approved",
                "confirmed",
                100.0,
            ),
            (
                "ACC-E2E-BUTTON",
                "أزرار عاجية كلاسيك E2E",
                "raw_material",
                "piece",
                True,
                "approved",
                "confirmed",
                50.0,
            ),
            (
                "FAB-E2E-DRAFT",
                "قماش صوف كشمير تجريبي E2E",
                "raw_material",
                "meter",
                False,  # draft item is not active
                "draft",
                "needs_review",
                0.0,
            ),
        ]

        items = {}
        for code, name_ar, item_type, unit_code, is_active, app_status, class_status, init_qty in items_spec:
            it = (await session.execute(select(CatalogItem).where(CatalogItem.code == code))).scalar_one_or_none()
            if not it:
                it = CatalogItem(
                    id=_uid(),
                    code=code,
                    name_ar=name_ar,
                    item_type=item_type,
                    unit_id=units[unit_code].id,
                    is_active=is_active,
                    approval_status=app_status,
                    classification_status=class_status,
                    attributes={},
                )
                session.add(it)
                await session.flush()

                # إيداع الرصيد الدفتري الأولي إن وجد
                if init_qty > 0 and warehouses.get("main_raw_materials"):
                    session.add(
                        StockLedgerEntry(
                            id=_uid(),
                            item_id=it.id,
                            unit_id=units[unit_code].id,
                            warehouse_id=warehouses["main_raw_materials"].id,
                            location_type="warehouse",
                            quantity=init_qty,
                            reference_doc_type="synthetic_opening_balance",
                            reference_doc_id="E2E-INIT-BAL",
                            entry_type="initial_stock",
                            created_by="e2e_seeder",
                        )
                    )
            items[code] = it

        # ── 4. العملاء الاصطناعيون ─────────────────────────────────────────────
        customers_spec = [
            ("CUST-E2E-01", "شركة الأفق للملابس الجاهزة", "01011112222", "القاهرة", "سداد نقدي عند الاستلام"),
            ("CUST-E2E-02", "مؤسسة النور للتجارة والتوريدات", "01033334444", "الجيزة", "آجل 15 يوماً"),
        ]
        for code, name, phone, city, notes in customers_spec:
            c = (await session.execute(select(Customer).where(Customer.code == code))).scalar_one_or_none()
            if not c:
                session.add(
                    Customer(
                        id=_uid(),
                        code=code,
                        name=name,
                        phone=phone,
                        city=city,
                        address=f"{city} - المنطقة الصناعية",
                        status="active",
                    )
                )

        # ── 5. الموردون الاصطناعيون ───────────────────────────────────────────
        suppliers_spec = [
            ("SUPP-E2E-01", "مصنع النسيج الحديث للمنسوجات", "01155556666", "المحلة الكبرى"),
            ("SUPP-E2E-02", "الشركة المتحدة للإكسسوارات", "01277778888", "العاشر من رمضان"),
        ]
        for code, name, phone, city in suppliers_spec:
            s = (await session.execute(select(Supplier).where(Supplier.code == code))).scalar_one_or_none()
            if not s:
                session.add(
                    Supplier(
                        id=_uid(),
                        code=code,
                        name=name,
                        phone=phone,
                        address=f"{city} - المنطقة الصناعية",
                        is_active=True,
                        created_by="e2e_seeder",
                    )
                )

        # ── 6. الموظفون الاصطناعيون ───────────────────────────────────────────
        employees_spec = [
            ("EMP-E2E-01", "محمود عبد الرحمن", "الإنتاج", "مشرف صالة القص"),
            ("EMP-E2E-02", "ياسر إبراهيم", "الإنتاج", "فني خياطة وتشطيب"),
            ("EMP-E2E-03", "سامح خليل", "المخازن", "عامل تعبئة وكي"),
        ]
        for code, name, dept, job in employees_spec:
            e = (await session.execute(select(Employee).where(Employee.code == code))).scalar_one_or_none()
            if not e:
                session.add(
                    Employee(
                        id=_uid(),
                        code=code,
                        name=name,
                        department=dept,
                        job_title=job,
                        status="active",
                    )
                )

        # ── 7. الحسابات النقدية والخزنة ──────────────────────────────────────
        treasury = (
            await session.execute(
                select(CashAccount).where(CashAccount.account_number == "MAIN-TREASURY-01")
            )
        ).scalar_one_or_none()
        if not treasury:
            treasury = CashAccount(
                id=_uid(),
                account_number="MAIN-TREASURY-01",
                name="الخزنة الرئيسية",
                account_type="treasury",
                is_active=True,
                created_by="e2e_seeder",
            )
            session.add(treasury)
            await session.flush()

            # إيداع رصيد نقدي أولي معتمد (50,000 ج.م)
            doc_id = _uid()
            session.add(
                CashDocument(
                    id=doc_id,
                    document_number="DOC-E2E-INIT-01",
                    document_type="income",
                    to_account_id=treasury.id,
                    amount=Decimal("50000.00"),
                    description="إيداع رصيد أولي اختباري في الخزنة الرئيسية E2E",
                    occurred_at=utc_now(),
                    status="approved",
                    created_by="e2e_seeder",
                    approved_by="gm_user",
                    approved_at=utc_now(),
                )
            )
            session.add(
                CashLedgerEntry(
                    id=_uid(),
                    document_id=doc_id,
                    account_id=treasury.id,
                    amount=Decimal("50000.00"),
                    created_by="e2e_seeder",
                )
            )

        petty_cash = (
            await session.execute(
                select(CashAccount).where(CashAccount.account_number == "PETTY-CASH-01")
            )
        ).scalar_one_or_none()
        if not petty_cash:
            petty_cash = CashAccount(
                id=_uid(),
                account_number="PETTY-CASH-01",
                name="عهدة المصروفات النثرية",
                account_type="petty_cash",
                parent_account_id=treasury.id,
                is_active=True,
                created_by="e2e_seeder",
            )
            session.add(petty_cash)

        # ── 8. المنتج وقالب الإنتاج التجريبي ──────────────────────────────────
        prod = (
            await session.execute(
                select(Product).where(Product.code == "PROD-E2E-01")
            )
        ).scalar_one_or_none()
        if not prod:
            prod = Product(
                id=_uid(),
                code="PROD-E2E-01",
                name_ar="جلابية كلاسيك نصف لياقة كفتة",
                style_type="classic",
                description="منتج تجريبي لاختبارات قبول E2E",
            )
            session.add(prod)
            await session.flush()

            variant = ProductVariant(
                id=_uid(),
                product_id=prod.id,
                numeric_size=58,
                letter_size="L",
                season="all_season",
                sku="VAR-E2E-01-58",
            )
            session.add(variant)
            await session.flush()

            tpl = ProductionTemplate(
                id=_uid(),
                code="TPL-E2E-01",
                name_ar="جلابية كلاسيك نصف لياقة كفتة E2E",
                product_id=prod.id,
                is_active=True,
            )
            session.add(tpl)
            await session.flush()

            tpl_ver = ProductionTemplateVersion(
                id=_uid(),
                template_id=tpl.id,
                version_number=1,
                status="approved",
                reference_quantity=20.0,
                notes="إصدار معتمد لاختبارات القبول الشاملة E2E",
            )
            session.add(tpl_ver)
            await session.flush()

            # سطور المواد لقالب الإنتاج
            if "FAB-E2E-COTTON" in items and "ACC-E2E-BUTTON" in items:
                session.add(
                    ProductionTemplateLine(
                        id=_uid(),
                        version_id=tpl_ver.id,
                        item_id=items["FAB-E2E-COTTON"].id,
                        unit_id=units["meter"].id,
                        quantity_per_reference=40.0,  # 2 متر لكل قطعة (40 متر لـ 20 قطعة)
                        notes="قماش قطن مصري فاخر",
                    )
                )
                session.add(
                    ProductionTemplateLine(
                        id=_uid(),
                        version_id=tpl_ver.id,
                        item_id=items["ACC-E2E-BUTTON"].id,
                        unit_id=units["piece"].id,
                        quantity_per_reference=40.0,  # زراران لكل قطعة (40 زرار لـ 20 قطعة)
                        notes="أزرار عاجية كلاسيك",
                    )
                )

        await session.commit()
        print("✅ تم بنجاح تهيئة وتثبيت حزمة البيانات الاصطناعية E2E-2026-11-02 في قاعدة الاختبارات المعزولة.")

    await engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(seed_e2e_dataset())
    except UnsafeTestDatabaseError as err:
        print(f"❌ تم الحظر بحارس الأمان: {err}", file=sys.stderr)
        sys.exit(1)
