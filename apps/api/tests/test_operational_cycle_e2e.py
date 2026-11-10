"""
اختبار الدورة التشغيلية الكاملة لمصنع القمة على قاعدة اختبار حقيقية (qemma_test_db).
─────────────────────────────────────────────────────────────────────────────
السيناريو يمر عبر واجهات API الفعلية (لا mocks) ويتحقق من الأرصدة الناتجة:

1. المشتريات: مورد ← فاتورة متعددة البنود بخصم ← استلام جزئي ثم كامل ← رصيد الخامات ← مستحق المورد.
2. الإنتاج: أمر بمقاسين ← منع المراحل على أمر مسودة ← صرف ← استلام بالورشة ← مراحل ←
   استلام منتج تام لكل مقاس على حدة ← تسوية خامات الورشة (استهلاك/مرتجع/هالك) ← إغلاق.
3. المبيعات: طلب بخصم ← تسليم جزئي ← تحصيل جزئي عبر الخزينة ← استكمال ← مرتجع ← فحص وإعادة للمخزون.
4. المالية: قبض/صرف/تحويل عبر اعتماد الخزينة، منع الاعتماد الذاتي والمزدوج، العهدة تمويلاً وتسويةً وإغلاقاً،
   سداد مورد.
5. الجرد: جرد مخزن كامل وجرد أصناف محددة وترحيل الفروقات.
6. الصلاحيات: الخادم يفرض الأدوار ولا يثق في user_metadata.

كل اختبار ينشئ بياناته الخاصة بأكواد فريدة حتى لا يعتمد على حالة مشتركة.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID
from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry, JournalEntry, JournalEntryLine, Account
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.service import get_or_create_finished_goods_item
from app.modules.production.stock import stock_balance

GM, WH, PM, FM = "general_manager", "warehouse_manager", "production_manager", "finance_manager"


def _uid() -> str:
    return str(uuid.uuid4())


def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


def _user(user_id: str, role: str) -> AuthenticatedUser:
    # الدور في app_metadata (يتحكم فيه الخادم) — لا نضعه في user_metadata
    return AuthenticatedUser(id=user_id, email=f"{user_id}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    """عميل HTTP يتصرف باسم مستخدم محدد."""

    def __init__(self, client: AsyncClient, user: AuthenticatedUser):
        self.client = client
        self.user = user

    async def _call(self, method: str, url: str, **kwargs):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kwargs)

    async def get(self, url, **kw):
        return await self._call("GET", url, **kw)

    async def post(self, url, **kw):
        return await self._call("POST", url, **kw)

    async def patch(self, url, **kw):
        return await self._call("PATCH", url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    actors = {
        "gm": Actor(client, _user("e2e-gm", GM)),
        "wh": Actor(client, _user("e2e-wh", WH)),
        "wh2": Actor(client, _user("e2e-wh-2", WH)),
        "pm": Actor(client, _user("e2e-pm", PM)),
        "fm": Actor(client, _user("e2e-fm-maker", FM)),
        "fm2": Actor(client, _user("e2e-fm-checker", FM)),
    }
    yield session, actors
    await client.aclose()
    app.dependency_overrides.clear()


async def _warehouse(session: AsyncSession, code: str) -> Warehouse:
    wh = await session.scalar(select(Warehouse).where(Warehouse.code == code))
    assert wh is not None, f"المخزن {code} غير مهيأ في قاعدة الاختبار"
    return wh


async def _unit(session: AsyncSession, code: str) -> Unit:
    unit = await session.scalar(select(Unit).where(Unit.code == code))
    assert unit is not None
    return unit


async def _approved_item(session: AsyncSession, name: str, unit: Unit, item_type: str = "raw_material") -> CatalogItem:
    item = CatalogItem(
        id=_uid(), code=f"E2E-{_tag()}", name_ar=f"{name} {_tag()}", item_type=item_type, unit_id=unit.id,
        is_active=True, approval_status="approved", classification_status="confirmed",
    )
    session.add(item)
    await session.commit()
    return item


async def _cash_balance(session: AsyncSession, account_id: str) -> Decimal:
    value = await session.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account_id)
    )
    return Decimal(str(value or 0))


async def _journal_amount(session: AsyncSession, source_doc_type: str, source_doc_id: str, account_code: str, side: str) -> Decimal:
    column = JournalEntryLine.debit if side == "debit" else JournalEntryLine.credit
    value = await session.scalar(
        select(func.coalesce(func.sum(column), 0))
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.entry_id)
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(
            JournalEntry.source_doc_type == source_doc_type,
            JournalEntry.source_doc_id == source_doc_id,
            Account.code == account_code,
        )
    )
    return Decimal(str(value or 0))


async def _approve(checker: Actor, document_id: str):
    res = await checker.post(f"/api/v1/finance/cash-documents/{document_id}/decision", json={"decision": "approve"})
    assert res.status_code == 200, res.text
    return res.json()


async def _fund_treasury(fm: Actor, fm2: Actor, amount: str) -> None:
    """إيداع من المدير المالي: يُعتمد ويُرحّل لحظة إنشائه (لا جهة اعتماد فوق المدير المالي)."""
    del fm2
    res = await fm.post("/api/v1/finance/cash-documents", json={
        "document_type": "income", "to_account_id": CANONICAL_TREASURY_ID, "amount": amount,
        "description": "إيداع رأس مال تشغيلي لاختبار الدورة", "occurred_at": datetime.now(timezone.utc).isoformat(),
    })
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "approved" and res.json()["approved_by"] == fm.user.id


# ═════════════════════════════════════════════════════════════════════════════
# 1. المشتريات والاستلام
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_purchasing_partial_receipts_and_supplier_balance(ctx):
    session, a = ctx
    raw = await _warehouse(session, "main_raw_materials")
    meter, piece = await _unit(session, "meter"), await _unit(session, "piece")
    fabric = await _approved_item(session, "قماش", meter)
    buttons = await _approved_item(session, "زراير", piece)
    await _fund_treasury(a["fm"], a["fm2"], "50000.00")

    res = await a["wh"].post("/api/v1/finance/suppliers", json={"code": f"SUP-{_tag()}", "name": "مورد أقمشة الاختبار"})
    assert res.status_code == 201
    supplier_id = res.json()["id"]

    # فاتورة متعددة البنود: 100 م × 50 − خصم 200 = 4800 ، 1000 زر × 0.5 = 500 → 5300
    res = await a["wh"].post("/api/v1/finance/supplier-invoices", json={
        "supplier_id": supplier_id, "invoice_number": f"INV-{_tag()}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "lines": [
            {"item_id": fabric.id, "unit_id": meter.id, "invoiced_quantity": 100, "unit_price": "50", "discount_amount": "200"},
            {"item_id": buttons.id, "unit_id": piece.id, "invoiced_quantity": 1000, "unit_price": "0.5"},
        ],
    })
    assert res.status_code == 201, res.text
    invoice = res.json()
    invoice_id = invoice["id"]
    fabric_line = next(l for l in invoice["lines"] if l["item_id"] == fabric.id)
    buttons_line = next(l for l in invoice["lines"] if l["item_id"] == buttons.id)
    # أمين المخزن لا يرى الأسعار
    assert Decimal(str(invoice["invoice_total"])) == Decimal("0")
    fm_view = next(i for i in (await a["fm"].get("/api/v1/finance/supplier-invoices")).json() if i["id"] == invoice_id)
    assert Decimal(str(fm_view["invoice_total"])) == Decimal("5300.00")

    # إجمالي يدوي مخالف للبنود يُرفض
    bad = await a["wh"].post("/api/v1/finance/supplier-invoices", json={
        "supplier_id": supplier_id, "invoice_number": f"INV-{_tag()}", "invoice_date": datetime.now(timezone.utc).isoformat(),
        "invoice_total": "9999.00",
        "lines": [{"item_id": fabric.id, "unit_id": meter.id, "invoiced_quantity": 10, "unit_price": "50"}],
    })
    assert bad.status_code == 422

    # إنشاء الفاتورة لا يغير المخزون
    assert await stock_balance(session, fabric.id, raw.id) == 0.0

    # استلام جزئي: 60 متر فقط
    res = await a["wh"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json={
        "lines": [{"line_id": fabric_line["id"], "received_quantity": 60}],
    })
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "partially_received"
    assert await stock_balance(session, fabric.id, raw.id) == 60.0

    # الاستلام الثاني يستكمل الكميات
    res = await a["wh2"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json={
        "lines": [
            {"line_id": fabric_line["id"], "received_quantity": 40},
            {"line_id": buttons_line["id"], "received_quantity": 1000},
        ],
    })
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "received"
    assert await stock_balance(session, fabric.id, raw.id) == 100.0
    assert await stock_balance(session, buttons.id, raw.id) == 1000.0

    # لا يمكن الاستلام مرة أخرى
    res = await a["wh"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json={
        "lines": [{"line_id": fabric_line["id"], "received_quantity": 1}],
    })
    assert res.status_code == 409

    # المستحق للمورد = قيمة المستلم (5300) ولم يُسدد شيء
    view = next(i for i in (await a["fm"].get("/api/v1/finance/supplier-invoices")).json() if i["id"] == invoice_id)
    assert Decimal(str(view["received_value"])) == Decimal("5300.00")
    assert Decimal(str(view["payable_balance"])) == Decimal("5300.00")

    # سداد دفعة 2000 يطلبها المدير العام: معلقة حتى يعتمدها المدير المالي
    treasury_before = await _cash_balance(session, CANONICAL_TREASURY_ID)
    res = await a["gm"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/payments", json={"amount": "2000.00", "description": "دفعة أولى"})
    assert res.status_code == 201, res.text
    pay_doc = res.json()
    assert pay_doc["status"] == "pending"
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == treasury_before

    # الاعتماد الذاتي لغير المدير المالي ممنوع، واعتماد المدير المالي يخصم الخزنة مرة واحدة
    res = await a["gm"].post(f"/api/v1/finance/cash-documents/{pay_doc['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 409
    await _approve(a["fm"], pay_doc["id"])
    res = await a["fm2"].post(f"/api/v1/finance/cash-documents/{pay_doc['id']}/decision", json={"decision": "approve"})
    assert res.status_code == 409, "الاعتماد المزدوج ممنوع"
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == treasury_before - Decimal("2000.00")

    view = next(i for i in (await a["fm"].get("/api/v1/finance/supplier-invoices")).json() if i["id"] == invoice_id)
    assert Decimal(str(view["paid_total"])) == Decimal("2000.00")
    assert Decimal(str(view["payable_balance"])) == Decimal("3300.00")

    # تقرير الموردين يطابق شاشة الفواتير
    report = (await a["gm"].get(f"/api/v1/reports/supplier-statement/{supplier_id}")).json()
    assert Decimal(str(report["totals"]["balance_due"])) == Decimal("3300.00")

    # لا يمكن سداد أكثر من المستحق بعد اكتمال الاستلام
    res = await a["fm"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/payments", json={"amount": "3300.01", "description": "تجاوز"})
    assert res.status_code == 409


# ═════════════════════════════════════════════════════════════════════════════
# 2. الإنتاج بمقاسين وتسوية الخامات
# ═════════════════════════════════════════════════════════════════════════════

async def _product_with_sizes(session: AsyncSession):
    prod = Product(id=_uid(), code=f"PRD-{_tag()}", name_ar=f"جلابية اختبار {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    v56 = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    v60 = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=60, letter_size="XL", season="summer", sku=f"SKU-{_tag()}")
    session.add_all([v56, v60])
    await session.commit()
    return prod, v56, v60


async def _stock_raw(session: AsyncSession, item: CatalogItem, warehouse: Warehouse, qty: float, unit_cost: str) -> None:
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item.id, unit_id=item.unit_id, warehouse_id=warehouse.id, location_type="warehouse",
        quantity=qty, reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_tag()}",
        entry_type="opening_balance", created_by="e2e", unit_cost=Decimal(unit_cost),
        total_cost=(Decimal(str(qty)) * Decimal(unit_cost)).quantize(Decimal("0.01")),
    ))
    await session.commit()


@pytest.mark.asyncio
async def test_production_multi_size_receipt_reconciliation_and_close(ctx):
    session, a = ctx
    raw = await _warehouse(session, "main_raw_materials")
    wip = await _warehouse(session, "work_in_progress")
    fg = await _warehouse(session, "finished_goods")
    meter, piece = await _unit(session, "meter"), await _unit(session, "piece")
    fabric = await _approved_item(session, "قماش إنتاج", meter)
    buttons = await _approved_item(session, "زراير إنتاج", piece)
    await _stock_raw(session, fabric, raw, 500, "40")
    await _stock_raw(session, buttons, raw, 1000, "0.5")
    prod, v56, v60 = await _product_with_sizes(session)

    res = await a["pm"].post("/api/v1/production/orders", json={
        "items": [
            {"product_id": prod.id, "variant_id": v56.id, "target_quantity": 30, "season": "summer"},
            {"product_id": prod.id, "variant_id": v60.id, "target_quantity": 30, "season": "summer"},
        ],
        "custom_materials": [
            {"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": 120},
            {"item_id": buttons.id, "unit_id": piece.id, "planned_quantity": 240},
        ],
        "notes": "أمر اختبار بمقاسين",
    })
    assert res.status_code == 201, res.text
    order = res.json()
    order_id = order["id"]
    item56 = next(i for i in order["items"] if i["variant_id"] == v56.id)
    item60 = next(i for i in order["items"] if i["variant_id"] == v60.id)

    # لا يمكن إنجاز مراحل أمر مسودة (منع إنتاج منتج تام بلا خامات)
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/stages/cutting", json={"status": "in_progress"})
    assert res.status_code == 409
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 1})
    assert res.status_code in (409, 422)

    # صرف الخامات: ينقص مخزن الخامات
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف"})
    assert res.status_code == 200, res.text
    assert await stock_balance(session, fabric.id, raw.id) == 380.0
    assert await stock_balance(session, buttons.id, raw.id) == 760.0

    # استلام بالورشة مع عجز نقل 2 متر، ولا يُقبل استلام أكثر من المصروف
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 121}], "notes": "",
    })
    assert res.status_code == 409
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": 118}, {"item_id": buttons.id, "received_quantity": 240}],
        "notes": "عجز 2 متر",
    })
    assert res.status_code == 200, res.text
    wip_bucket = f"order:{order_id}"
    assert await stock_balance(session, fabric.id, wip.id, bucket_reference=wip_bucket) == 118.0
    assert await stock_balance(session, buttons.id, wip.id, bucket_reference=wip_bucket) == 240.0

    for stage in ["cutting", "finishing", "snap_installation", "ironing", "packing"]:
        for status_value in ("in_progress", "completed"):
            res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/stages/{stage}", json={"status": status_value})
            assert res.status_code == 200, res.text

    # أمر متعدد المقاسات: يجب تحديد الكمية لكل بند
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={"accepted_quantity": 58})
    assert res.status_code == 422
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [
            {"order_item_id": item56["id"], "accepted_quantity": 30},
            {"order_item_id": item60["id"], "accepted_quantity": 28, "rejected_quantity": 2},
        ],
        "notes": "استلام بالفحص",
    })
    assert res.status_code == 201, res.text

    # كل مقاس في صنفه المستقل — لا تُحمّل الكمية كلها على المقاس الأول
    fg56 = await get_or_create_finished_goods_item(session, prod.id, v56.id)
    fg60 = await get_or_create_finished_goods_item(session, prod.id, v60.id)
    assert fg56.id != fg60.id
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference="factory_brand") == 30.0
    assert await stock_balance(session, fg60.id, fg.id, bucket_reference="factory_brand") == 28.0

    # تجاوز المستهدف للبند يُرفض
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": item56["id"], "accepted_quantity": 1}],
    })
    assert res.status_code == 409

    # لا يمكن الإغلاق قبل تسوية خامات الورشة
    res = await a["gm"].post(f"/api/v1/production/orders/{order_id}/close", json={
        "discrepancy_signoff": True, "under_production_reason": "2 قطعة مرفوضة بالفحص",
    })
    assert res.status_code == 409

    # تسوية أكبر من الرصيد مرفوضة
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/material-reconciliations", json={
        "lines": [{"item_id": fabric.id, "consumed_quantity": 119}],
    })
    assert res.status_code == 409

    # تسوية الخامات: قماش (110 استهلاك + 6 مرتجع + 2 هالك = 118) ، زراير (236 + 4 مرتجع)
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/material-reconciliations", json={
        "lines": [
            {"item_id": fabric.id, "consumed_quantity": 110, "returned_quantity": 6, "scrapped_quantity": 2},
            {"item_id": buttons.id, "consumed_quantity": 236, "returned_quantity": 4},
        ],
        "notes": "تسوية نهاية الأمر",
    })
    assert res.status_code == 201, res.text
    return_transfer_id = res.json()["return_transfer_id"]
    assert return_transfer_id
    assert await stock_balance(session, fabric.id, wip.id, bucket_reference=wip_bucket) == 0.0
    assert await stock_balance(session, buttons.id, wip.id, bucket_reference=wip_bucket) == 0.0
    # المرتجع بالطريق: لا يزيد رصيد الخامات القابل للصرف قبل فحص أمين المخزن
    assert await stock_balance(session, fabric.id, raw.id) == 380.0
    assert await stock_balance(session, buttons.id, raw.id) == 760.0

    # لا إغلاق والمرتجع لم يُستلم
    res = await a["gm"].post(f"/api/v1/production/orders/{order_id}/close", json={
        "discrepancy_signoff": True, "discrepancy_notes": "عجز نقل 2 متر",
        "under_production_reason": "2 قطعة مرفوضة بالفحص",
    })
    assert res.status_code == 409

    # أمين المخزن يفحص ويستلم المرتجع كاملاً
    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/returns/{return_transfer_id}/receive", json={
        "lines": [
            {"item_id": fabric.id, "accepted_quantity": 6},
            {"item_id": buttons.id, "accepted_quantity": 4},
        ],
    })
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "received_confirmed"
    assert await stock_balance(session, fabric.id, raw.id) == 386.0
    assert await stock_balance(session, buttons.id, raw.id) == 764.0

    res = await a["gm"].post(f"/api/v1/production/orders/{order_id}/close", json={
        "discrepancy_signoff": True, "discrepancy_notes": "عجز نقل 2 متر",
        "under_production_reason": "2 قطعة مرفوضة بالفحص",
    })
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "closed"

    # أمر مغلق لا يُعاد فتحه بالتراجع عن مرحلة
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/stages/packing/rollback", json={"reason": "محاولة إعادة فتح"})
    assert res.status_code == 409


# ═════════════════════════════════════════════════════════════════════════════
# 3. المبيعات: خصم، تسليم جزئي، تحصيل عبر الخزينة، مرتجع وفحص
# ═════════════════════════════════════════════════════════════════════════════

async def _finished_stock(session: AsyncSession, prod: Product, variant: ProductVariant, qty: float, cost: str = "100") -> CatalogItem:
    fg = await _warehouse(session, "finished_goods")
    item = await get_or_create_finished_goods_item(session, prod.id, variant.id)
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item.id, unit_id=item.unit_id, warehouse_id=fg.id, location_type="warehouse",
        bucket_reference="factory_brand", quantity=qty, reference_doc_type="opening_balance",
        reference_doc_id=f"OPEN-{_tag()}", entry_type="opening_balance", created_by="e2e",
        unit_cost=Decimal(cost), total_cost=(Decimal(str(qty)) * Decimal(cost)).quantize(Decimal("0.01")),
    ))
    await session.commit()
    return item


@pytest.mark.asyncio
async def test_sales_discount_partial_delivery_collection_and_return(ctx):
    session, a = ctx
    fg = await _warehouse(session, "finished_goods")
    prod, v56, v60 = await _product_with_sizes(session)
    fg56 = await _finished_stock(session, prod, v56, 25)
    fg60 = await _finished_stock(session, prod, v60, 12)

    res = await a["gm"].post("/api/v1/customers", json={"code": f"CUS-{_tag()}", "name": "عميل الاختبار"})
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]

    # 20 × 500 + 10 × 600 = 16000 − خصم 700 = 15300 (نسبة الصافي 0.95625)
    res = await a["gm"].post(f"/api/v1/customers/{customer_id}/orders", json={
        "order_type": "ready_goods", "discount_amount": "700.00",
        "lines": [
            {"product_id": prod.id, "variant_id": v56.id, "quantity": "20", "unit_price": "500.00"},
            {"product_id": prod.id, "variant_id": v60.id, "quantity": "10", "unit_price": "600.00"},
        ],
    })
    assert res.status_code == 201, res.text
    order = res.json()
    order_id = order["id"]
    assert order["total_amount"] == 15300.0
    line56 = next(l for l in order["lines"] if l["variant_id"] == v56.id)
    line60 = next(l for l in order["lines"] if l["variant_id"] == v60.id)

    # تسليم جزئي 10 قطع مقاس 56
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/deliveries", json={
        "lines": [{"order_line_id": line56["id"], "quantity": "10"}], "received_by": "مندوب العميل",
    })
    assert res.status_code == 201, res.text
    delivery1 = res.json()
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference="factory_brand") == 15.0
    # الإيراد بالقيمة الصافية بعد الخصم + تكلفة البضاعة المباعة
    assert await _journal_amount(session, "customer_delivery_invoice", delivery1["id"], "4100", "credit") == Decimal("4781.25")
    assert await _journal_amount(session, "customer_delivery_cogs", delivery1["id"], "5100", "debit") > 0

    # تسليم أكثر من المتبقي ممنوع، وتسليم يتجاوز المخزون ممنوع
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/deliveries", json={
        "lines": [{"order_line_id": line56["id"], "quantity": "11"}],
    })
    assert res.status_code == 409

    # تحصيل جزئي 3000: معلق حتى الاعتماد ولا يغير رصيد العميل
    res = await a["gm"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/payments", json={"amount": "3000.00", "method": "cash"})
    assert res.status_code == 201, res.text
    payment = res.json()
    assert payment["status"] == "pending"
    account = (await a["gm"].get(f"/api/v1/customers/{customer_id}/account")).json()
    acc_order = account["orders"][0]
    assert acc_order["receivable_amount"] == 4781.25
    assert acc_order["pending_payments_amount"] == 3000.0

    treasury_before = await _cash_balance(session, CANONICAL_TREASURY_ID)
    await _approve(a["fm"], payment["cash_document_id"])
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == treasury_before + Decimal("3000.00")
    acc_order = (await a["gm"].get(f"/api/v1/customers/{customer_id}/account")).json()["orders"][0]
    assert acc_order["receivable_amount"] == 1781.25
    assert acc_order["paid_amount"] == 3000.0
    assert acc_order["payments"][0]["status"] == "approved"

    # استكمال التسليم والتحصيل
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/deliveries", json={
        "lines": [{"order_line_id": line56["id"], "quantity": "10"}, {"order_line_id": line60["id"], "quantity": "10"}],
    })
    assert res.status_code == 201, res.text
    delivery2 = res.json()
    res = await a["fm"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/payments", json={"amount": "12300.01", "method": "cash"})
    assert res.status_code == 409, "لا يُقبل تحصيل يتجاوز المتبقي على الطلب"
    res = await a["fm"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/payments", json={"amount": "12300.00", "method": "cash"})
    assert res.status_code == 201
    assert res.json()["status"] == "approved", "تحصيل المدير المالي يُعتمد ويُضاف للخزنة فوراً"
    acc_order = (await a["gm"].get(f"/api/v1/customers/{customer_id}/account")).json()["orders"][0]
    assert acc_order["status"] == "delivered"
    assert acc_order["receivable_amount"] == 0.0
    assert acc_order["balance_amount"] == 0.0

    # تقرير المديونيات يطابق شاشة حساب العميل
    ar = (await a["gm"].get("/api/v1/reports/accounts-receivable")).json()
    row = next(r for r in ar["customers"] if r["customer_id"] == customer_id)
    assert row["balance_due"] == 0.0
    stmt = (await a["gm"].get(f"/api/v1/reports/customer-statement/{customer_id}")).json()
    assert stmt["totals"]["balance_due"] == 0.0

    # مرتجع قطعتين مقاس 60: يدخل حاوية "تحت الفحص" ولا يُتاح للبيع قبل الفحص
    d2_line60 = next(l for l in delivery2["lines"] if l["order_line_id"] == line60["id"])
    account = (await a["gm"].get(f"/api/v1/customers/{customer_id}/account")).json()
    delivery2_full = next(d for d in account["orders"][0]["deliveries"] if d["id"] == delivery2["id"])
    delivery_line_id = next(l["id"] for l in delivery2_full["lines"] if l["order_line_id"] == line60["id"])
    sellable_before = await stock_balance(session, fg60.id, fg.id, bucket_reference="factory_brand")
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/deliveries/{delivery2['id']}/return", json={
        "reason": "عيب خياطة", "lines": [{"delivery_line_id": delivery_line_id, "quantity": "2"}],
    })
    assert res.status_code == 201, res.text
    return_doc = res.json()
    assert d2_line60["quantity"] == 10.0
    assert await stock_balance(session, fg60.id, fg.id, bucket_reference=f"return_pending_inspection:{customer_id}") == 2.0
    assert await stock_balance(session, fg60.id, fg.id, bucket_reference="factory_brand") == sellable_before
    acc_order = (await a["gm"].get(f"/api/v1/customers/{customer_id}/account")).json()["orders"][0]
    # قيمة المرتجع الصافية 2 × 600 × 0.95625 = 1147.50 تصبح رصيداً دائناً للعميل
    assert acc_order["returned_value"] == 1147.5
    assert acc_order["receivable_amount"] == -1147.5
    assert acc_order["status"] == "partially_delivered"

    # الفحص: إعادة للمخزون القابل للبيع
    res = await a["wh2"].post(f"/api/v1/customers/{customer_id}/returns/{return_doc['id']}/inspection", json={"disposition": "restocked"})
    assert res.status_code == 200, res.text
    assert await stock_balance(session, fg60.id, fg.id, bucket_reference=f"return_pending_inspection:{customer_id}") == 0.0
    assert await stock_balance(session, fg60.id, fg.id, bucket_reference="factory_brand") == sellable_before + 2.0
    res = await a["wh2"].post(f"/api/v1/customers/{customer_id}/returns/{return_doc['id']}/inspection", json={"disposition": "scrapped"})
    assert res.status_code == 409

    # إعادة تسليم القطعتين بعد المرتجع مسموحة وتعيد الرصيد للصفر
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/deliveries", json={
        "lines": [{"order_line_id": line60["id"], "quantity": "2"}],
    })
    assert res.status_code == 201, res.text
    acc_order = (await a["gm"].get(f"/api/v1/customers/{customer_id}/account")).json()["orders"][0]
    assert acc_order["receivable_amount"] == 0.0
    assert acc_order["status"] == "delivered"


# ═════════════════════════════════════════════════════════════════════════════
# 4. الخزينة والعهدة
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_treasury_documents_and_custody_lifecycle(ctx):
    session, a = ctx
    await _fund_treasury(a["fm"], a["fm2"], "10000.00")
    now = datetime.now(timezone.utc).isoformat()

    # مستند المدير المالي يُعتمد ويُخصم لحظة إنشائه
    before_fm = await _cash_balance(session, CANONICAL_TREASURY_ID)
    res = await a["fm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "25.00",
        "description": "مصروف بوفيه", "occurred_at": now,
    })
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "approved"
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == before_fm - Decimal("25.00")
    # مستند للمدير المالي يتجاوز الرصيد يُرفض بالكامل ولا يبقى معلقاً
    res = await a["fm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "99999999.00",
        "description": "تجاوز الرصيد", "occurred_at": now,
    })
    assert res.status_code == 409, res.text
    assert await session.scalar(select(func.count()).select_from(CashDocument).where(CashDocument.description == "تجاوز الرصيد")) == 0

    # مصروف يسجله المدير العام: معلق ← يعتمده المدير المالي ← خصم مرة واحدة
    before = await _cash_balance(session, CANONICAL_TREASURY_ID)
    res = await a["gm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "750.00",
        "description": "فاتورة كهرباء", "occurred_at": now,
    })
    assert res.status_code == 201
    expense = res.json()
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == before
    await _approve(a["fm"], expense["id"])
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == before - Decimal("750.00")

    # رفض مستند بدون سبب مرفوض، وبسبب مقبول ولا يغير الرصيد
    res = await a["gm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "50.00",
        "description": "مصروف مرفوض", "occurred_at": now,
    })
    rejected_id = res.json()["id"]
    res = await a["fm"].post(f"/api/v1/finance/cash-documents/{rejected_id}/decision", json={"decision": "reject"})
    assert res.status_code == 422
    res = await a["fm"].post(f"/api/v1/finance/cash-documents/{rejected_id}/decision", json={"decision": "reject", "rejection_reason": "غير معتمد"})
    assert res.status_code == 200
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == before - Decimal("750.00")

    # فتح عهدة وتمويلها 1000 بتحويل معتمد
    res = await a["gm"].post("/api/v1/finance/petty-cash", params={"name": f"عهدة {_tag()}", "business_date": now})
    assert res.status_code == 201
    petty_id = res.json()["id"]
    res = await a["gm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "transfer", "from_account_id": CANONICAL_TREASURY_ID, "to_account_id": petty_id,
        "amount": "1000.00", "description": "تمويل عهدة", "occurred_at": now,
    })
    await _approve(a["fm"], res.json()["id"])
    assert await _cash_balance(session, petty_id) == Decimal("1000.00")
    # التحويل لا يخلق ولا يعدم نقدية
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == before - Decimal("1750.00")

    # مصروف يومي من العهدة 300 عبر الخزينة
    res = await a["gm"].post("/api/v1/finance/daily-expenses", json={
        "document_type": "expense", "from_account_id": petty_id, "amount": "300.00",
        "description": "نقل خامات", "occurred_at": now,
    })
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "pending"
    await _approve(a["fm"], res.json()["id"])
    # المصروف اليومي من الخزنة نفسها مرفوض (يُصرف من عهدة فقط)
    res = await a["gm"].post("/api/v1/finance/daily-expenses", json={
        "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "10.00",
        "description": "محاولة", "occurred_at": now,
    })
    assert res.status_code == 422

    preview = (await a["gm"].get(f"/api/v1/finance/petty-cash/{petty_id}/settlement-preview")).json()
    assert preview["total_expenses_recorded"] == 300.0
    assert preview["current_balance"] == 700.0

    # تسوية جزئية: رد 500 ويبقى 200 مع صاحب العهدة (القيم الأخرى يحسبها الخادم)
    res = await a["gm"].post(f"/api/v1/finance/petty-cash/{petty_id}/settlement", json={
        "returned_cash_amount": "500.00", "approved_expenses_amount": "999.00", "notes": "تسوية أسبوعية",
    })
    assert res.status_code == 201, res.text
    settlement = res.json()
    assert Decimal(str(settlement["approved_expenses_amount"])) == Decimal("300.00")
    assert Decimal(str(settlement["remaining_unsettled_amount"])) == Decimal("200.00")
    assert settlement["is_mathematically_balanced"] is True
    # لا تسوية ثانية أثناء وجود تسوية معلقة
    res = await a["gm"].post(f"/api/v1/finance/petty-cash/{petty_id}/settle")
    assert res.status_code == 409
    await _approve(a["fm"], settlement["cash_document_id"])
    petty = await session.get(CashAccount, petty_id)
    await session.refresh(petty)
    assert petty.is_active is True
    assert await _cash_balance(session, petty_id) == Decimal("200.00")

    # التسوية النهائية ترد المتبقي وتغلق العهدة بعد الاعتماد
    res = await a["gm"].post(f"/api/v1/finance/petty-cash/{petty_id}/settle")
    assert res.status_code == 201, res.text
    final = res.json()
    assert Decimal(str(final["returned_cash_amount"])) == Decimal("200.00")
    await _approve(a["fm"], final["cash_document_id"])
    await session.refresh(petty)
    assert petty.is_active is False
    assert await _cash_balance(session, petty_id) == Decimal("0.00")

    # لا يمكن تحريك نقدية على عهدة مغلقة
    res = await a["gm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense", "from_account_id": petty_id, "amount": "1.00", "description": "بعد الإغلاق", "occurred_at": now,
    })
    assert res.status_code == 404


# ═════════════════════════════════════════════════════════════════════════════
# 5. الجرد: كامل وأصناف محددة
# ═════════════════════════════════════════════════════════════════════════════

async def _run_stocktake(a, warehouse_id: str, counts_by_item: dict[str, float], scope: str, item_ids=None):
    res = await a["wh"].post("/api/v1/inventory/stocktakes", json={
        "warehouse_id": warehouse_id, "scope_type": scope, "item_ids": item_ids, "description": "جرد اختبار",
    })
    assert res.status_code == 201, res.text
    st_id = res.json()["id"]
    assert (await a["wh"].post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")).status_code == 200
    lines = (await a["wh"].get(f"/api/v1/inventory/stocktakes/{st_id}/lines")).json()
    counts = [{"line_id": l["id"], "counted_quantity": counts_by_item[l["item_id"]]} for l in lines if l["item_id"] in counts_by_item]
    assert counts, "أصناف الجرد غير موجودة في الجلسة"
    res = await a["wh"].post(f"/api/v1/inventory/stocktakes/{st_id}/counts", json={"counts": counts})
    assert res.status_code == 200, res.text
    res = await a["wh"].post(f"/api/v1/inventory/stocktakes/{st_id}/submit", json={})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "submitted"
    # من أنشأ الجلسة وعدّها لا يعتمدها
    res = await a["gm"].post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})
    assert res.status_code == 200, res.text
    res = await a["gm"].post(f"/api/v1/inventory/stocktakes/{st_id}/post", json={})
    assert res.status_code == 200, res.text
    return st_id, lines


@pytest.mark.asyncio
async def test_stocktake_full_and_selected_items(ctx):
    session, a = ctx
    raw = await _warehouse(session, "main_raw_materials")
    fg = await _warehouse(session, "finished_goods")
    meter = await _unit(session, "meter")
    thread = await _approved_item(session, "خيط", meter)
    await _stock_raw(session, thread, raw, 50, "2")

    # جرد كامل لمخزن الخامات: عجز 3
    _, lines = await _run_stocktake(a, raw.id, {thread.id: 47}, "full_warehouse")
    assert any(l["item_id"] == thread.id for l in lines)
    assert await stock_balance(session, thread.id, raw.id) == 47.0

    # جرد أصناف محددة في مخزن التام: يُسوى في حاوية الملكية نفسها التي يقرأ منها التسليم
    prod, v56, _ = await _product_with_sizes(session)
    fg56 = await _finished_stock(session, prod, v56, 10)
    _, lines = await _run_stocktake(a, fg.id, {fg56.id: 8}, "specific_items", item_ids=[fg56.id])
    assert lines[0]["bucket_reference"] == "factory_brand"
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference="factory_brand") == 8.0
    # لا رصيد بدون حاوية ملكية في مخزن التام (لا يوجد رصيد "يتيم" غير قابل للتسليم)
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference=None) == 0.0


# ═════════════════════════════════════════════════════════════════════════════
# 6. الصلاحيات
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_backend_enforces_roles_and_ignores_user_metadata(ctx):
    session, a = ctx
    client = a["gm"].client
    now = datetime.now(timezone.utc).isoformat()

    res = await a["gm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense", "from_account_id": CANONICAL_TREASURY_ID, "amount": "1.00",
        "description": "اختبار صلاحيات", "occurred_at": now,
    })
    doc_id = res.json()["id"]

    # أمين المخزن ومدير الإنتاج لا يعتمدان مستندات الخزينة
    for actor in ("wh", "pm"):
        res = await a[actor].post(f"/api/v1/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
        assert res.status_code == 403

    # مستخدم وضع لنفسه دور المدير العام في user_metadata (يمكن تعديله ذاتياً في Supabase) لا يحصل على أي صلاحية
    forged = Actor(client, AuthenticatedUser(id="forged-user", email=None, claims={"user_metadata": {"role": GM, "roles": [GM]}}))
    res = await forged.post(f"/api/v1/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 403
    me = (await forged.get("/api/v1/auth/me")).json()
    assert me["roles"] == [] and me["permissions"] == []

    # /auth/me يعيد الصلاحيات الفعلية للواجهة
    me = (await a["fm"].get("/api/v1/auth/me")).json()
    assert "finance_manager" in me["roles"]
    assert "finance:cash:approve" in me["permissions"]
    assert "warehouse:dispatch" not in me["permissions"]

    # مدير الإنتاج لا يرى أرصدة الخزينة في الملخص
    summary = (await a["pm"].get("/api/v1/reports/summary")).json()
    assert summary["treasury"] is None

    # رسائل قواعد العمل تصل للمستخدم بالعربية (لا رسالة عامة مبهمة)
    res = await a["gm"].post(f"/api/v1/finance/cash-documents/{doc_id}/decision", json={"decision": "approve"})
    assert res.status_code == 409
    assert "منشئ المستند" in res.json()["message"]
