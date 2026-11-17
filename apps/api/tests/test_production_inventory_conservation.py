"""
اختبار حفظية قيمة المخزون في دورة الإنتاج (Inventory Conservation - بند 2 من تجربة المالك)
─────────────────────────────────────────────────────────────────────────────────────
ما رصده المالك: صرف 100 متر (25 ج.م = 2,500)، تسوية استهلاك 97 ومرتجع 3، ثم تقرير تقييم
المخزون 25,075 بدلاً من 25,000 — أي أن الـ 3 متر المرتجعة احتُسبت مرتين: داخل تكلفة
المنتج التام وفي مخزن الخامات.

المطلوب والاختبار يثبته:
1. تكلفة الخامات المحمَّلة على المنتج التام = تكلفة المستهلك فعلياً (97 × 25 = 2,425).
2. بعد دورة صرف ← تسوية بمرتجع ← استلام مرتجع ← استلام تام ← إغلاق:
   مجموع قيمة المخزون (خامات + تحت التشغيل + تام) لا يتغير إلا بما يدخل/يخرج من خارج
   المخزون (هالك تُحمَّل تكلفته على مصروفات التصنيع عند الإغلاق).
3. أرصدة 1210 و1220 و1230 في الأستاذ العام مطابقة لتقرير تقييم المخزون.

سيناريو ثانٍ بخصل "التالف" يوثق المعالجة: الهالك يخرج من تكلفة التام ويُحمَّل مصروفًا عند الإغلاق.

ملاحظة على اللقطات: القماش ورصيده الافتتاحي (1,000م × 25 = 25,000) يُنشأ قبل اللقطة الأولى،
لأن الرصيد الافتتاحي لا يُرحَّل أستاذيًا — وبذلك تكون فروقات الأستاذ وفروقات تقرير التقييم
مقارَنةً على نفس الأساس (دورة الصرف/المرتجع/الاستلام فقط).
"""
from decimal import Decimal
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.finance.models import Account, JournalEntry, JournalEntryLine
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    StockLedgerEntry,
    Unit,
    Warehouse,
)
from app.modules.production.service import get_or_create_finished_goods_item

GM, WH, PM, FM = "general_manager", "warehouse_manager", "production_manager", "finance_manager"


def _uid() -> str:
    return str(uuid.uuid4())


def _tag() -> str:
    return uuid.uuid4().hex[:6].upper()


def _user(user_id: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(id=user_id, email=f"{user_id}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
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


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    actors = {
        "gm": Actor(client, _user("cons-gm", GM)),
        "wh": Actor(client, _user("cons-wh", WH)),
        "pm": Actor(client, _user("cons-pm", PM)),
        "fm": Actor(client, _user("cons-fm", FM)),
    }
    yield session, actors
    await client.aclose()
    app.dependency_overrides.clear()


async def _warehouse(session: AsyncSession, code: str) -> Warehouse:
    return (await session.scalar(select(Warehouse).where(Warehouse.code == code)))  # type: ignore[return-value]


async def _unit(session: AsyncSession, code: str) -> Unit:
    return (await session.scalar(select(Unit).where(Unit.code == code)))  # type: ignore[return-value]


async def _snapshot(session: AsyncSession):
    """لقطة لأرصدة حسابات المخزون بالأستاذ العام ومعرّفات قيود استلام التام، لقياس الفروقات."""
    async def balance(code: str) -> Decimal:
        value = await session.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.debit - JournalEntryLine.credit), 0))
            .join(Account, Account.id == JournalEntryLine.account_id)
            .where(Account.code == code)
        )
        return Decimal(str(value or 0))

    async def fg_receipt_je_ids() -> list[str]:
        rows = (await session.scalars(
            select(JournalEntry.id).where(JournalEntry.source_doc_type == "production_finished_receipt")
        )).all()
        return list(rows)

    return {
        "1210": await balance("1210"),
        "1220": await balance("1220"),
        "1230": await balance("1230"),
        "fg_je_ids": await fg_receipt_je_ids(),
    }


async def _valuation_for(session: AsyncSession, a, item_ids: list[str]) -> dict[str, Decimal]:
    """قيمة الأصناف المحددة من تقرير تقييم المخزون حسب المخزن."""
    res = await a["fm"].get("/api/v1/reports/inventory-valuation")
    assert res.status_code == 200, res.text
    data = res.json()
    out = {"main_raw_materials": Decimal("0.00"), "work_in_progress": Decimal("0.00"), "finished_goods": Decimal("0.00")}
    for code, wh in data["warehouses"].items():
        if code not in out:
            continue
        for row in wh["items"]:
            if row["item_id"] in item_ids:
                out[code] += Decimal(str(row["total_valuation"]))
    return out


async def _setup_material_and_product(session: AsyncSession):
    """قماش برصيد افتتاحي 1,000م × 25 ج.م + منتج ومقاس — قبل اللقطات حتى تتطابق أساسات المقارنة."""
    raw = await _warehouse(session, "main_raw_materials")
    meter = await _unit(session, "meter")
    fabric = CatalogItem(
        id=_uid(), code=f"CONS-{_tag()}", name_ar=f"قماش حفظية {_tag()}", item_type="raw_material", unit_id=meter.id,
        is_active=True, approval_status="approved", classification_status="confirmed",
    )
    session.add(fabric)
    await session.flush()
    session.add(StockLedgerEntry(
        id=_uid(), item_id=fabric.id, unit_id=fabric.unit_id, warehouse_id=raw.id, location_type="warehouse",
        quantity=1000.0, reference_doc_type="opening_balance", reference_doc_id=f"OPEN-{_tag()}",
        entry_type="opening_balance", created_by="cons", unit_cost=Decimal("25"),
        total_cost=Decimal("25000.00"),
    ))

    prod = Product(id=_uid(), code=f"PRD-{_tag()}", name_ar=f"منتج حفظية {_tag()}", style_type="full_collar_cuff")
    session.add(prod)
    await session.flush()
    variant = ProductVariant(id=_uid(), product_id=prod.id, numeric_size=56, letter_size="M", season="summer", sku=f"SKU-{_tag()}")
    session.add(variant)
    await session.commit()
    return fabric, prod, variant, meter


async def _run_cycle(session: AsyncSession, a, fabric, prod, variant, meter, consumed: float, returned: float, scrapped: float, target: int = 50, planned: float = 100.0):
    """دورة الأمر: أمر ← صرف ← استلام ورشة ← مراحل ← تسوية ← استلام مرتجع ← استلام تام."""
    res = await a["pm"].post("/api/v1/production/orders", json={
        "items": [{"product_id": prod.id, "variant_id": variant.id, "target_quantity": target, "season": "summer"}],
        "custom_materials": [{"item_id": fabric.id, "unit_id": meter.id, "planned_quantity": planned}],
        "notes": "أمر حفظية المخزون",
    })
    assert res.status_code == 201, res.text
    order = res.json()
    order_id, order_item = order["id"], order["items"][0]

    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/dispatch", json={"notes": "صرف 100 متر"})
    assert res.status_code == 200, res.text
    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/receive", json={
        "received_lines": [{"item_id": fabric.id, "received_quantity": planned}], "notes": "",
    })
    assert res.status_code == 200, res.text
    for stage in ["cutting", "finishing", "snap_installation", "ironing", "packing"]:
        for status_value in ("in_progress", "completed"):
            res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/stages/{stage}", json={"status": status_value})
            assert res.status_code == 200, res.text

    res = await a["pm"].post(f"/api/v1/production/orders/{order_id}/material-reconciliations", json={
        "lines": [{
            "item_id": fabric.id,
            "consumed_quantity": consumed,
            "returned_quantity": returned,
            "scrapped_quantity": scrapped,
        }],
        "notes": "تسوية نهاية الأمر",
    })
    assert res.status_code == 201, res.text
    return_transfer_id = res.json()["return_transfer_id"]

    if returned > 0:
        res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/returns/{return_transfer_id}/receive", json={
            "lines": [{"item_id": fabric.id, "accepted_quantity": returned, "rejected_quantity": 0}],
        })
        assert res.status_code == 200, res.text

    res = await a["wh"].post(f"/api/v1/production/orders/{order_id}/finished-receipt", json={
        "lines": [{"order_item_id": order_item["id"], "accepted_quantity": target, "rejected_quantity": 0}],
        "notes": "استلام كامل",
    })
    assert res.status_code == 201, res.text

    fg_item = await get_or_create_finished_goods_item(session, order_item["product_id"], order_item["variant_id"])
    return order_id, fg_item


@pytest.mark.asyncio
async def test_returned_material_not_double_counted(ctx):
    """سيناريو المالك حرفيًا: صرف 2,500 / استهلاك 97 / مرتجع 3 ← قيمة المخزون تظل 25,000 لا 25,075."""
    session, a = ctx
    fabric, prod, variant, meter = await _setup_material_and_product(session)
    before = await _snapshot(session)
    val_before = await _valuation_for(session, a, [fabric.id])  # القماش كله بالمخزن: 25,000

    order_id, fg_item = await _run_cycle(session, a, fabric, prod, variant, meter, consumed=97.0, returned=3.0, scrapped=0.0)
    after = await _snapshot(session)
    val_after = await _valuation_for(session, a, [fabric.id, fg_item.id])

    order = await session.get(ProductionOrder, order_id)
    await session.refresh(order)
    # تكلفة التام = المستهلك فعلياً (97 × 25 = 2,425) لا المصروف (2,500)
    assert order.actual_material_cost == Decimal("2425.00")
    assert order.total_actual_cost == Decimal("2425.00")
    assert order.unit_manufacturing_cost == Decimal("48.5000")
    # قيد الاستلام: Dr 1230 2,425 / Cr 1220 2,425
    new_je_ids = [j for j in after["fg_je_ids"] if j not in before["fg_je_ids"]]
    assert len(new_je_ids) == 1
    je_line = await session.execute(
        select(JournalEntryLine, Account.code)
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(JournalEntryLine.entry_id == new_je_ids[0])
    )
    lines = je_line.all()
    dr_1230 = sum(Decimal(str(l[0].debit or 0)) for l in lines if l[1] == "1230")
    cr_1220 = sum(Decimal(str(l[0].credit or 0)) for l in lines if l[1] == "1220")
    assert dr_1230 == Decimal("2425.00"), f"قيد الاستلام يجب أن يكون 2425 وليس 2500: {lines}"
    assert cr_1220 == Decimal("2425.00")

    # أرصدة الأستاذ العام: فروقات مطابقة لسطور الدورة (المرتجع يخرج من تكلفة الأمر)
    delta_1210 = after["1210"] - before["1210"]
    delta_1220 = after["1220"] - before["1220"]
    delta_1230 = after["1230"] - before["1230"]
    assert delta_1210 == Decimal("-2425.00"), "1210: -2500 صرف +75 مرتجع"
    assert delta_1220 == Decimal("0.00"), "1220: +2500 صرف -2425 استلام تام -75 مرتجع"
    assert delta_1230 == Decimal("2425.00")
    # حفظية المخزون: لا يتغير مجموع قيمة المخزون إطلاقًا (لا عمالة ولا تحميل ولا هالك في هذه الدورة)
    assert delta_1210 + delta_1220 + delta_1230 == Decimal("0.00")

    # أرصدة الأستاذ العام = تقرير تقييم المخزون (حسب المخزن المقابل لكل حساب)
    assert delta_1210 == val_after["main_raw_materials"] - val_before["main_raw_materials"]
    assert delta_1220 == val_after["work_in_progress"] - val_before["work_in_progress"]
    assert delta_1230 == val_after["finished_goods"] - val_before["finished_goods"]
    # القيمة النهائية 25,000 كما كان يوم القطع (903م قماش × 25 = 22,575 + تام 2,425)
    my_valuation = val_after["main_raw_materials"] + val_after["work_in_progress"] + val_after["finished_goods"]
    assert my_valuation == Decimal("25000.00")


@pytest.mark.asyncio
async def test_scrapped_material_charged_as_expense_at_closure(ctx):
    """تأثير التالف: يخرج من تكلفة التام (94×25=2,350) وتُحمَّل تكلفته مصروفًا عند الإغلاق (3×25=75)."""
    session, a = ctx
    fabric, prod, variant, meter = await _setup_material_and_product(session)
    before = await _snapshot(session)
    val_before = await _valuation_for(session, a, [fabric.id])

    order_id, fg_item = await _run_cycle(session, a, fabric, prod, variant, meter, consumed=94.0, returned=3.0, scrapped=3.0)
    after_receipt = await _snapshot(session)

    # بعد الاستلام وقبل الإغلاق: تكلفة الهالك (75) ما زالت محمولة تحت التشغيل
    delta_1210_r = after_receipt["1210"] - before["1210"]
    delta_1220_r = after_receipt["1220"] - before["1220"]
    delta_1230_r = after_receipt["1230"] - before["1230"]
    assert delta_1210_r == Decimal("-2425.00")
    assert delta_1220_r == Decimal("75.00"), "تكلفة الهالك ما زالت رصيدها تحت التشغيل قبل الإغلاق"
    assert delta_1230_r == Decimal("2350.00")

    # تكلفة التام = المستهلك فقط (94 × 25 = 2,350)
    je_rows = (await session.execute(
        select(JournalEntryLine, Account.code)
        .join(Account, Account.id == JournalEntryLine.account_id)
        .where(JournalEntryLine.entry_id.in_([j for j in after_receipt["fg_je_ids"] if j not in before["fg_je_ids"]]))
    )).all()
    dr_1230 = sum(Decimal(str(l[0].debit or 0)) for l in je_rows if l[1] == "1230")
    assert dr_1230 == Decimal("2350.00"), f"التام يحمل المستهلك فقط: {je_rows}"

    # الإغلاق: الرصيد المتبقي تحت التشغيل = تكلفة الهالك 75 يُرحَّل مصروفًا
    res = await a["gm"].post(f"/api/v1/production/orders/{order_id}/close", json={})
    assert res.status_code == 200, res.text

    order = await session.get(ProductionOrder, order_id)
    await session.refresh(order)
    assert order.actual_material_cost == Decimal("2425.00")  # 2500 − 75 مرتجع (الهالك يبقى على الأمر قابلية حتى الإغلاق)
    assert order.wip_balance == Decimal("0.00")              # صُفّر عند الإغلاق
    assert order.total_actual_cost == Decimal("2425.00")

    # بعد الإغلاق: الهالك خرج من 1220 مصروفًا، والمخزون انخفض بتكلفة الهالك فقط (75)
    final = await _snapshot(session)
    delta_1210 = final["1210"] - before["1210"]
    delta_1220 = final["1220"] - before["1220"]
    delta_1230 = final["1230"] - before["1230"]
    assert delta_1210 == Decimal("-2425.00")
    assert delta_1220 == Decimal("0.00"), "الهالك خرج من 1220 مصروفًا عند الإغلاق"
    assert delta_1230 == Decimal("2350.00")
    assert delta_1210 + delta_1220 + delta_1230 == Decimal("-75.00")

    # قيد الإغلاق (خاص بأمرنا): مصروفات تصنيع 5xxx مدين 75 مقابل 1220 دائن 75
    close_rows = (await session.execute(
        select(JournalEntryLine, Account.code)
        .join(Account, Account.id == JournalEntryLine.account_id)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.entry_id)
        .where(
            JournalEntry.source_doc_type == "production_order_scrap_variance",
            JournalEntry.source_doc_id == order_id,
        )
    )).all()
    assert close_rows, "قيد تسوية رصيد تحت التشغيل المتبقي عند الإغلاق مفقود"
    dr_expense = sum(Decimal(str(l[0].debit or 0)) for l in close_rows if l[1].startswith("5"))
    cr_1220 = sum(Decimal(str(l[0].credit or 0)) for l in close_rows if l[1] == "1220")
    assert dr_expense == Decimal("75.00"), f"تكلفة الهالك تُحمَّل مصروفًا: {close_rows}"
    assert cr_1220 == Decimal("75.00")

    val_after = await _valuation_for(session, a, [fabric.id, fg_item.id])
    assert delta_1230 == val_after["finished_goods"] - val_before["finished_goods"]
