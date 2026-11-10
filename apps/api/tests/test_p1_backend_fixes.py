"""
اختبارات إصلاحات ما قبل التسليم (P1) — الخلفية على قاعدة اختبار حقيقية (qemma_test_db):
1. مرتجع العميل المعاد تخزينه لا يُحتسب مرتين في متوسط التكلفة المرجح (WAC):
   حاوية «مرتجع تحت الفحص» تُستثنى من مجاميع WAC، وتبقى الحاوية NULL (مخزن الخامات)
   وباقي حاويات البيع (factory_brand / private_label) داخل الحساب.
2. مفتاح Idempotency-Key على POST /finance/cash-documents:
   نفس المفتاح + نفس الحمولة يعيدان المستند نفسه دون تكرار الحركة النقدية،
   ونفس المفتاح بحمولة مختلفة يُرفض بوضوح (409).
3. توحيد صافي الخصم في GET /reports/revenue-analysis مع محرك الأرصدة (balances.py):
   الإيراد المعروض = القيمة الصافية بعد خصم الطلب ويطابق قيمة التسليم في حساب العميل.

كل اختبار ينشئ بياناته الخاصة بأكواد فريدة حتى لا يعتمد على حالة مشتركة.
"""
from datetime import datetime, timezone
from decimal import Decimal
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID, get_weighted_average_cost
from app.modules.finance.models import CashDocument, CashLedgerEntry
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.service import get_or_create_finished_goods_item
from app.modules.production.stock import RETURN_PENDING_PREFIX, stock_balance

GM, WH, FM = "general_manager", "warehouse_manager", "finance_manager"
API = "/api/v1"


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
        self.client, self.user = client, user

    async def _call(self, method: str, url: str, **kwargs):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kwargs)

    async def get(self, url, **kw):
        return await self._call("GET", url, **kw)

    async def post(self, url, **kw):
        return await self._call("POST", url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    tag = _tag()
    actors = {
        "gm": Actor(client, _user(f"p1fx-gm-{tag}", GM)),
        "wh": Actor(client, _user(f"p1fx-wh-{tag}", WH)),
        "wh2": Actor(client, _user(f"p1fx-wh2-{tag}", WH)),
        "fm": Actor(client, _user(f"p1fx-fm-{tag}", FM)),
        "fm2": Actor(client, _user(f"p1fx-fm2-{tag}", FM)),
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


async def _product_with_variant(session: AsyncSession):
    prod = Product(id=_uid(), code=f"PRD-{_tag()}", name_ar=f"جلابية P1FX {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    session.add(variant)
    await session.commit()
    return prod, variant


def _ledger(session: AsyncSession, item: CatalogItem, warehouse: Warehouse, qty, unit_cost: str, bucket: str | None = None) -> None:
    """قيد مخزني مباشر (رصيد افتتاحي) بحاوية محددة لتجريب مجاميع WAC."""
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item.id, unit_id=item.unit_id, warehouse_id=warehouse.id,
        location_type="warehouse", quantity=float(qty), bucket_reference=bucket,
        reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_tag()}",
        entry_type="opening_balance", created_by="p1fx-test",
        unit_cost=Decimal(unit_cost), total_cost=(Decimal(str(qty)) * Decimal(unit_cost)).quantize(Decimal("0.01")),
    ))


async def _finished_stock(session: AsyncSession, prod: Product, variant: ProductVariant, qty: float, cost: str) -> CatalogItem:
    """رصيد افتتاحي قابل للبيع في مخزن المنتجات التامة (حاوية factory_brand)."""
    fg = await _warehouse(session, "finished_goods")
    item = await get_or_create_finished_goods_item(session, prod.id, variant.id)
    _ledger(session, item, fg, qty, cost, bucket="factory_brand")
    await session.commit()
    return item


async def _cash_balance(session: AsyncSession, account_id: str) -> Decimal:
    value = await session.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account_id)
    )
    return Decimal(str(value or 0))


# ═════════════════════════════════════════════════════════════════════════════
# 1. WAC: حاوية «مرتجع تحت الفحص» لا تُحتسب مرتين
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_wac_bucket_filter_semantics(session: AsyncSession):
    """وحدوي: حاوية الفحص تُستثنى من WAC (موجبة أو سالبة)؛ NULL وباقي الحاويات تبقى داخل الحساب."""
    raw = await _warehouse(session, "main_raw_materials")
    fg = await _warehouse(session, "finished_goods")
    piece = await _unit(session, "piece")

    # مخزن الخامات (حاوية NULL) داخل الحساب: (10×40 + 10×60) / 20 = 50
    # نُجري الفحص داخل معاملة غير مُثبتة (flush ثم rollback) حتى لا تبقى قيود متعددة الحاويات في قاعدة الاختبار
    raw_item = CatalogItem(
        id=_uid(), code=f"P1FX-{_tag()}", name_ar=f"خامة فحص WAC {_tag()}", item_type="raw_material",
        unit_id=piece.id, is_active=True, approval_status="approved", classification_status="confirmed",
    )
    session.add(raw_item)
    await session.flush()
    _ledger(session, raw_item, raw, 10, "40")
    _ledger(session, raw_item, raw, 10, "60")
    # قيود حاوية الفحص على الصنف نفسه لا تدخل الحساب (موجبة وسالبة)
    _ledger(session, raw_item, raw, 5, "80", bucket=f"{RETURN_PENDING_PREFIX}cus-x")
    _ledger(session, raw_item, raw, -3, "90", bucket=f"{RETURN_PENDING_PREFIX}cus-x")
    await session.flush()
    assert await get_weighted_average_cost(session, raw_item.id, raw.id) == Decimal("50.0000")

    # حاويات البيع في مخزن التام (بصنف FG-VAR حقيقي وحالة not_applicable) تبقى داخل الحساب، وحاوية الفحص مستثناة:
    # (4×25 + 3×35) / 7 = 29.2857 — لا تدخل حركة الفحص 2×50 في المقام أو البسط
    prod = Product(id=_uid(), code=f"PRD-{_tag()}", name_ar=f"جلابية فحص WAC {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    session.add(variant)
    await session.flush()
    fg_item = await get_or_create_finished_goods_item(session, prod.id, variant.id)
    _ledger(session, fg_item, fg, 4, "25", bucket="factory_brand")
    _ledger(session, fg_item, fg, 3, "35", bucket="private_label:abc")
    _ledger(session, fg_item, fg, 2, "50", bucket=f"{RETURN_PENDING_PREFIX}cus-x")
    _ledger(session, fg_item, fg, -1, "50", bucket=f"{RETURN_PENDING_PREFIX}cus-x")
    await session.flush()
    assert await get_weighted_average_cost(session, fg_item.id, fg.id) == (Decimal(205) / Decimal(7)).quantize(Decimal("0.0001"))
    await session.rollback()


@pytest.mark.asyncio
async def test_customer_return_restock_not_double_counted_in_wac(ctx):
    """
    تكاملي: مرتجع عميل ثم فحص بإعادة التخزين لا يضاعف الكمية في WAC.
    الدفعة الأولى 10×100، تسليم 4 بتكلفة 100، ثم دفعة أحدث 10×300 قبل المرتجع —
    فيُعاد تخزين المرتجع بتكلفة صرفه الأصلية (100) مرة واحدة في حاوية البيع:
    (1000 + 3000 + 200) / (10 + 10 + 2) = 190.9091 — لا (4400/24 = 183.3333) لو احتُسبت حاوية الفحص مرتين.
    """
    session, a = ctx
    fg = await _warehouse(session, "finished_goods")
    prod, v56 = await _product_with_variant(session)

    fg56 = await _finished_stock(session, prod, v56, 10, "100")
    assert await get_weighted_average_cost(session, fg56.id, fg.id) == Decimal("100.0000")

    res = await a["gm"].post(f"{API}/customers", json={"code": f"CUS-{_tag()}", "name": f"عميل مرتجع WAC {_tag()}"})
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]

    res = await a["gm"].post(f"{API}/customers/{customer_id}/orders", json={
        "order_type": "ready_goods",
        "lines": [{"product_id": prod.id, "variant_id": v56.id, "quantity": "6", "unit_price": "500.00"}],
    })
    assert res.status_code == 201, res.text
    order = res.json()
    line = order["lines"][0]

    # تسليم 4 قطع بتكلفة WAC لحظة التسليم (100)
    res = await a["wh"].post(f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries", json={
        "lines": [{"order_line_id": line["id"], "quantity": "4"}], "received_by": "مندوب العميل",
    })
    assert res.status_code == 201, res.text
    delivery = res.json()

    # دخول دفعة أحدث بتكلفة أعلى بعد التسليم: WAC يصبح (1000 + 3000) / 20 = 200
    await _finished_stock(session, prod, v56, 10, "300")
    assert await get_weighted_average_cost(session, fg56.id, fg.id) == Decimal("200.0000")

    # مرتجع قطعتين: يدخل حاوية «تحت الفحص» بتكلفة صرفه الأصلية (100) دون أن يمس الرصيد القابل للبيع
    account = (await a["gm"].get(f"{API}/customers/{customer_id}/account")).json()
    delivery_full = next(d for d in account["orders"][0]["deliveries"] if d["id"] == delivery["id"])
    delivery_line_id = next(l["id"] for l in delivery_full["lines"] if l["order_line_id"] == line["id"])
    sellable_before = await stock_balance(session, fg56.id, fg.id, bucket_reference="factory_brand")
    res = await a["wh"].post(f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries/{delivery['id']}/return", json={
        "reason": "عيب خياطة", "lines": [{"delivery_line_id": delivery_line_id, "quantity": "2"}],
    })
    assert res.status_code == 201, res.text
    return_doc = res.json()
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference=f"{RETURN_PENDING_PREFIX}{customer_id}") == 2.0
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference="factory_brand") == sellable_before

    # الإصلاح: حاوية الفحص مستثناة من WAC فلا تنجذب القيمة نحو تكلفة المرتجع
    # (قبل الإصلاح كانت ستدخل: 4200/22 = 190.9091)
    assert await get_weighted_average_cost(session, fg56.id, fg.id) == Decimal("200.0000")

    # الفحص بإعادة التخزين: المرتجع يُحتسب مرة واحدة فقط بقيمة تكلفة صرفه
    res = await a["wh2"].post(f"{API}/customers/{customer_id}/returns/{return_doc['id']}/inspection", json={"disposition": "restocked"})
    assert res.status_code == 200, res.text
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference=f"{RETURN_PENDING_PREFIX}{customer_id}") == 0.0
    assert await stock_balance(session, fg56.id, fg.id, bucket_reference="factory_brand") == sellable_before + 2.0
    wac_after = await get_weighted_average_cost(session, fg56.id, fg.id)
    assert wac_after == (Decimal(4200) / Decimal(22)).quantize(Decimal("0.0001"))

    # مرتجع ثانٍ وإعدامه (scrapped): لا يُضاف إلى WAC
    res = await a["wh"].post(f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries/{delivery['id']}/return", json={
        "reason": "تلف أثناء النقل", "lines": [{"delivery_line_id": delivery_line_id, "quantity": "1"}],
    })
    assert res.status_code == 201, res.text
    ret2_id = res.json()["id"]
    res = await a["wh2"].post(f"{API}/customers/{customer_id}/returns/{ret2_id}/inspection", json={"disposition": "scrapped"})
    assert res.status_code == 200, res.text
    assert await get_weighted_average_cost(session, fg56.id, fg.id) == wac_after


# ═════════════════════════════════════════════════════════════════════════════
# 2. Idempotency-Key على POST /finance/cash-documents
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_cash_document_idempotency_key_replays_without_duplicates(ctx):
    session, a = ctx
    key = f"idem-cash-{_tag()}"
    payload = {
        "document_type": "income",
        "to_account_id": CANONICAL_TREASURY_ID,
        "amount": "250.00",
        "description": f"إيداع اختبار عدم التكرار {_tag()}",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }

    # الطلب الأول: مستند المدير المالي يُعتمد ويُرحّل لحظة إنشائه (قرار المصنع 2026-11-10)
    res1 = await a["fm"].post(f"{API}/finance/cash-documents", json=payload, headers={"Idempotency-Key": key})
    assert res1.status_code == 201, res1.text
    doc1 = res1.json()
    assert doc1["status"] == "approved" and doc1["approved_by"] == a["fm"].user.id

    balance_after_first = await _cash_balance(session, CANONICAL_TREASURY_ID)

    # إعادة إرسال الطلب نفسه بعد نجاحه (انقطاع شبكة مثلاً) تعيد المستند نفسه فوراً
    res2 = await a["fm"].post(f"{API}/finance/cash-documents", json=payload, headers={"Idempotency-Key": key})
    assert res2.status_code == 201, res2.text
    doc2 = res2.json()
    assert doc2["id"] == doc1["id"]
    assert doc2["document_number"] == doc1["document_number"]

    # لا تكرار في الرصيد ولا في الحركات النقدية ولا في المستندات
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == balance_after_first
    ledger_rows = await session.scalar(
        select(func.count()).select_from(CashLedgerEntry).where(CashLedgerEntry.document_id == doc1["id"])
    )
    assert ledger_rows == 1
    doc_rows = await session.scalar(
        select(func.count()).select_from(CashDocument).where(CashDocument.description == payload["description"])
    )
    assert doc_rows == 1

    # نفس المفتاح بحمولة مختلفة يُرفض بوضوح دون أي أثر مالي
    res3 = await a["fm"].post(
        f"{API}/finance/cash-documents",
        json={**payload, "amount": "999.00"},
        headers={"Idempotency-Key": key},
    )
    assert res3.status_code == 409, res3.text
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == balance_after_first

    # نفس المفتاح من مستخدم آخر -> 403 Forbidden
    res_other = await a["fm2"].post(f"{API}/finance/cash-documents", json=payload, headers={"Idempotency-Key": key})
    assert res_other.status_code == 403, res_other.text

    # سند صرف للمدير المالي: تكراره لا يخصم الخزنة مرتين
    exp_key = f"idem-exp-{_tag()}"
    exp_payload = {
        "document_type": "expense",
        "from_account_id": CANONICAL_TREASURY_ID,
        "amount": "100.00",
        "description": f"صرف اختبار عدم التكرار {_tag()}",
        "occurred_at": payload["occurred_at"],
    }
    r_exp1 = await a["fm"].post(f"{API}/finance/cash-documents", json=exp_payload, headers={"Idempotency-Key": exp_key})
    assert r_exp1.status_code == 201, r_exp1.text
    r_exp2 = await a["fm"].post(f"{API}/finance/cash-documents", json=exp_payload, headers={"Idempotency-Key": exp_key})
    assert r_exp2.status_code == 201, r_exp2.text
    assert r_exp2.json()["id"] == r_exp1.json()["id"]
    assert await _cash_balance(session, CANONICAL_TREASURY_ID) == balance_after_first - Decimal("100.00")

    # فشل الاعتماد الفوري (رصيد غير كافٍ) يتراجع عن سجل عدم التكرار فيسمح بإعادة المحاولة بعد التمويل
    bal_now = await _cash_balance(session, CANONICAL_TREASURY_ID)
    retry_key = f"idem-retry-{_tag()}"
    retry_payload = {
        "document_type": "expense",
        "from_account_id": CANONICAL_TREASURY_ID,
        "amount": f"{bal_now + Decimal('500.00'):.2f}",
        "description": f"صرف يتجاوز الرصيد مؤقتاً {_tag()}",
        "occurred_at": payload["occurred_at"],
    }
    res_fail = await a["fm"].post(f"{API}/finance/cash-documents", json=retry_payload, headers={"Idempotency-Key": retry_key})
    assert res_fail.status_code == 409, res_fail.text
    res_fund = await a["fm"].post(f"{API}/finance/cash-documents", json={
        "document_type": "income", "to_account_id": CANONICAL_TREASURY_ID, "amount": "1000.00",
        "description": f"تمويل إعادة المحاولة {_tag()}", "occurred_at": payload["occurred_at"],
    })
    assert res_fund.status_code == 201, res_fund.text
    res_retry_ok = await a["fm"].post(f"{API}/finance/cash-documents", json=retry_payload, headers={"Idempotency-Key": retry_key})
    assert res_retry_ok.status_code == 201, res_retry_ok.text
    assert res_retry_ok.json()["status"] == "approved"


# ═════════════════════════════════════════════════════════════════════════════
# 3. توحيد صافي الخصم في تقرير تحليل الإيرادات مع محرك الأرصدة
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_revenue_analysis_net_value_matches_balances_engine(ctx):
    """
    طلب بخصم 1000: (10 × 500 − 1000) = 4000 → نسبة صافي البيع 0.8.
    تسليم 5 قطع: الإيراد الصافي = 5 × 500 × 0.8 = 2000.00 (لا 2500 بالسعر الخام)،
    ويطابق قيمة التسليم المعروضة في حساب العميل (نفس محرك balances.py حتى آخر قرش).
    """
    session, a = ctx
    prod, v56 = await _product_with_variant(session)
    await _finished_stock(session, prod, v56, 10, "120")

    customer_name = f"عميل تحليل إيرادات {_tag()}"
    res = await a["gm"].post(f"{API}/customers", json={"code": f"CUS-{_tag()}", "name": customer_name})
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]

    res = await a["gm"].post(f"{API}/customers/{customer_id}/orders", json={
        "order_type": "ready_goods", "discount_amount": "1000.00",
        "lines": [{"product_id": prod.id, "variant_id": v56.id, "quantity": "10", "unit_price": "500.00"}],
    })
    assert res.status_code == 201, res.text
    order = res.json()
    assert Decimal(str(order["total_amount"])) == Decimal("4000.00")
    line = order["lines"][0]

    # طلب ثانٍ غير مسلّم لنفس العميل: لا يدخل في الإيرادات المسلمة
    res_undelivered = await a["gm"].post(f"{API}/customers/{customer_id}/orders", json={
        "order_type": "ready_goods", "discount_amount": "0.00",
        "lines": [{"product_id": prod.id, "variant_id": v56.id, "quantity": "2", "unit_price": "500.00"}],
    })
    assert res_undelivered.status_code == 201, res_undelivered.text

    res = await a["wh"].post(f"{API}/customers/{customer_id}/orders/{order['id']}/deliveries", json={
        "lines": [{"order_line_id": line["id"], "quantity": "5"}], "received_by": "مندوب العميل",
    })
    assert res.status_code == 201, res.text

    # الحراسة بالصلاحيات: أمين المخزن يُمنع 403
    assert (await a["wh"].get(f"{API}/reports/revenue-analysis")).status_code == 403

    # التقرير يعرض الإيراد الصافي بعد خصم الطلب لا السعر الخام
    report = (await a["gm"].get(f"{API}/reports/revenue-analysis?since_days=365")).json()
    row = next(r for r in report["by_customer"] if r["customer_name"] == customer_name)
    assert row["delivered_revenue"] == 2000.0
    assert sum(r["delivered_revenue"] for r in report["by_customer"]) == pytest.approx(report["total_revenue"], abs=0.05)

    # ويتطابق مع قيمة التسليم في حساب العميل وتقرير تحليلات المبيعات (نفس محرك balances.py)
    account = (await a["gm"].get(f"{API}/customers/{customer_id}/account")).json()
    acc_order = next(o for o in account["orders"] if o["id"] == order["id"])
    assert Decimal(str(acc_order["delivered_value"])) == Decimal("2000.00")
    sales = (await a["fm"].get(f"{API}/reports/analytics/sales")).json()
    sales_row = next(r for r in sales["by_customer"] if r["key"] == customer_id)
    assert sales_row["net_sales"] == 2000.0
