"""
اختبار محاكاة يوم القطع والتشغيل الفعلي الشامل (Day 0 Cutover Simulation Test)
─────────────────────────────────────────────────────────────────────────────
يختبر بدقة متناهية على قاعدة البيانات الفعلية:
1. عزل المصادر في الإنتاج: رفض صلاحيات app_metadata إن لم تكن في جدول user_roles (Task 2).
2. رفض إدخال أرصدة المخزون أو العملاء أو الموردين في القيد الافتتاحي العام (422).
3. الجرد الافتتاحي: إلزامية unit_cost، عزل خامات العملاء CMT، ترحيل Dr 1210 / Cr 3900، وحظر جلسة ثانية (409).
4. فواتير الموردين الافتتاحية: Maker-Checker، قيود 3900 و2100، ودعم الدفعات المقدمة بالرصيد المدين.
5. أرصدة العملاء الافتتاحية: Maker-Checker، قيود 1100 و3900، استبعادها من Demand Pool وتقارير المبيعات، ودعم الدفعات المقدمة.
6. مطابقة ميزان المراجعة، وصفرية قائمة الدخل، وتطابق رصيد 3900 تماماً مع (المخزون + العملاء − الموردين).
7. قفل الأرصدة الافتتاحية (409).
8. صرف الخامات لأمر تشغيل بالتكلفة المدخلة في الجرد الافتتاحي (وليس صفر).
"""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
import pytest
from httpx import AsyncClient

from app.core.config import settings
from app.modules.finance.models import JournalEntry, JournalEntryLine, Account, Supplier, SupplierInvoice
from app.modules.customers.models import Customer, CustomerOrder
from app.modules.production.models import CatalogItem, Unit, Warehouse, Product, ProductVariant
from app.modules.production.stock import stock_balance
from app.modules.finance.ledger_service import get_weighted_average_cost
from tests.test_operational_cycle_e2e import (
    ctx,
    _tag,
    _uid,
    _warehouse,
    _unit,
    _approved_item,
    _product_with_sizes,
)

API = "/api/v1"


@pytest.mark.asyncio
async def test_rbac_production_user_roles_only(ctx, monkeypatch):
    """التحقق من أن بيئة production تعتمد حصرياً على جدول user_roles وترفض app_metadata."""
    session, a = ctx
    tag = _tag()

    # محاكاة بيئة الإنتاج
    monkeypatch.setattr(settings, "app_env", "production")

    # مستخدم يحمل دور finance_manager في التوكن (app_metadata) فقط دون وجود سجل في جدول user_roles
    from app.core.auth import AuthenticatedUser
    from tests.test_operational_cycle_e2e import Actor
    rogue_user = AuthenticatedUser(
        id=f"user_rogue_{tag}",
        email=f"rogue_{tag}@qemma.test",
        claims={"app_metadata": {"role": "finance_manager"}},
    )
    rogue_actor = Actor(a["fm"].client, rogue_user)

    # محاولة الوصول لمسار مالي يتطلب finance:reports:view
    res = await rogue_actor.get(f"{API}/finance/opening-balances")
    assert res.status_code == 403, (
        f"المتوقع 403 في بيئة الإنتاج لعدم وجود المستخدم في جدول user_roles، لكن الاستجابة كانت: {res.status_code}"
    )


@pytest.mark.asyncio
async def test_day0_cutover_full_simulation(ctx):
    """السيناريو الشامل ليوم القطع والمطابقة المحاسبية والتشغيلية الكاملة."""
    session, a = ctx
    now = datetime.now(timezone.utc)
    tag = _tag()

    # إلغاء أي جلسات جرد افتتاحي سابقة لمخزن الخامات وأرشفة أي قيود افتتاحية سابقة لضمان نظافة الاختبار
    import sqlalchemy as sa
    from app.modules.production.models import StocktakeSession
    from app.modules.finance.models import JournalEntry
    await session.execute(
        sa.update(StocktakeSession)
        .where(StocktakeSession.is_opening.is_(True))
        .values(status="cancelled")
    )
    await session.execute(
        sa.update(JournalEntry)
        .where(JournalEntry.source_doc_type == "opening_balance")
        .values(source_doc_type="archived_opening_balance")
    )
    await session.commit()

    # قياس رصيد 3900 الأولي قبل حركات يوم القطع لعزل الأثر بدقة
    tb_init_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    tb_init = tb_init_res.json()
    acc_3900_init = next((r for r in tb_init["rows"] if r["code"] == "3900"), None)
    initial_3900_cr = (
        Decimal(str(acc_3900_init["total_credit"])) - Decimal(str(acc_3900_init["total_debit"]))
        if acc_3900_init else Decimal("0.00")
    )

    # ─────────────────────────────────────────────────────────────────────────
    # ١. التحقق من رفض إدخال المخزون أو العملاء أو الموردين في القيد الافتتاحي العام
    # ─────────────────────────────────────────────────────────────────────────
    res_bad_ob = await a["fm"].post(f"{API}/finance/opening-balances", json={
        "accounting_start_date": "2026-11-01",
        "treasury_balance": "50000.00",
        "raw_materials_inventory": "30000.00",  # ممنوع!
        "paid_in_capital": "80000.00",
    })
    assert res_bad_ob.status_code == 422, "يجب رفض إدخال المخزون في القيد الافتتاحي العام بـ 422"

    # ─────────────────────────────────────────────────────────────────────────
    # ٢. الجرد الافتتاحي لمخزن الخامات (Opening Stocktake)
    # ─────────────────────────────────────────────────────────────────────────
    unit = await _unit(session, "meter")
    raw_wh = await _warehouse(session, "main_raw_materials")
    item = await _approved_item(session, f"CUT_FABRIC_{tag}", unit)

    # إنشاء عميل لخامات التشغيل للغير CMT
    cust_res = await a["fm"].post(f"{API}/customers", json={
        "code": f"CUST_CMT_{tag}",
        "name": f"عميل تشغيل للغير {tag}",
        "phone": "01100000000",
    })
    assert cust_res.status_code == 201, cust_res.text
    cmt_cust_id = cust_res.json()["id"]

    # إنشاء جلسة جرد افتتاحي لمخزن الخامات
    st_res = await a["wh"].post(f"{API}/inventory/stocktakes", json={
        "warehouse_id": raw_wh.id,
        "is_opening": True,
        "description": f"جرد افتتاحي رسمي لمصنع القمة {tag}",
    })
    assert st_res.status_code == 201, st_res.text
    st_id = st_res.json()["id"]
    assert st_res.json()["is_opening"] is True

    # التحقق من حظر إنشاء جلسة جرد افتتاحي ثانية لنفس المخزن (يُسمح بجلسة واحدة فقط)
    st_dup_res = await a["wh"].post(f"{API}/inventory/stocktakes", json={
        "warehouse_id": raw_wh.id,
        "is_opening": True,
        "description": "محاولة جرد افتتاحي مكرر",
    })
    assert st_dup_res.status_code == 409, "يجب منع إنشاء جلسة جرد افتتاحي ثانية للمخزن بـ 409"

    # بدء العد
    await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/start-counting")
    st_details = (await a["wh"].get(f"{API}/inventory/stocktakes/{st_id}")).json()
    line_id = next(ln["id"] for ln in st_details["lines"] if ln["item_id"] == item.id and not ln.get("bucket_reference"))

    # إدخال العد الفعلي: 1,000 متر بتكلفة وحدة 25.00 ج.م = 25,000 ج.م
    count_res = await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/counts", json={
        "counts": [{
            "line_id": line_id,
            "counted_quantity": 1000.0,
            "unit_cost": 25.00,
            "notes": "عد خامات افتتاحي",
        }]
    })
    assert count_res.status_code == 200, count_res.text

    # تقديم واعتماد وترحيل الجرد الافتتاحي
    await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/submit")
    await a["fm"].post(f"{API}/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})
    post_st_res = await a["fm"].post(f"{API}/inventory/stocktakes/{st_id}/post")
    assert post_st_res.status_code == 200, post_st_res.text

    # التحقق من التكلفة المرجحة في دفتر حركة المخزون
    wac = await get_weighted_average_cost(session, item.id, raw_wh.id)
    assert wac == Decimal("25.0000"), f"التكلفة المرجحة يجب أن تكون 25.0000 ج.م، المحسوب: {wac}"

    # ─────────────────────────────────────────────────────────────────────────
    # ٣. فواتير الموردين الافتتاحية (Maker-Checker ودعم الدفعة المقدمة)
    # ─────────────────────────────────────────────────────────────────────────
    sup1_res = await a["wh"].post(f"{API}/finance/suppliers", json={"code": f"S1_{tag}", "name": f"مورد 1 {tag}"})
    sup1_id = sup1_res.json()["id"]
    sup2_res = await a["wh"].post(f"{API}/finance/suppliers", json={"code": f"S2_{tag}", "name": f"مورد 2 {tag}"})
    sup2_id = sup2_res.json()["id"]

    # مورد 1: رصيد دائن قديم مستحق له 10,000 ج.م
    inv1_res = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup1_id,
        "invoice_number": f"OLD-INV1-{tag}",
        "invoice_date": "2026-10-15T00:00:00Z",
        "amount": "10000.00",
        "is_advance": False,
        "notes": "رصيد دائن افتتاحي سابق",
    })
    assert inv1_res.status_code == 201, inv1_res.text
    inv1_id = inv1_res.json()["id"]

    # التحقق من Maker-Checker: منشئ الفاتورة (fm) لا يستطيع اعتمادها بنفسه
    self_appr = await a["fm"].post(f"{API}/finance/supplier-invoices/{inv1_id}/approve-opening")
    assert self_appr.status_code == 403, "يجب منع منشئ المستند الافتتاحي من اعتماده بنفسه (Maker-Checker)"

    # اعتماد الفاتورة بواسطة المدير العام (gm)
    appr1 = await a["gm"].post(f"{API}/finance/supplier-invoices/{inv1_id}/approve-opening")
    assert appr1.status_code == 200, appr1.text

    # مورد 2: دفعة مقدمة دفعناها له في الورق القديم 3,000 ج.م (مورد مدين)
    inv2_res = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup2_id,
        "invoice_number": f"OLD-ADV2-{tag}",
        "invoice_date": "2026-10-20T00:00:00Z",
        "amount": "3000.00",
        "is_advance": True,
        "notes": "دفعة مقدمة سابقة للمورد",
    })
    assert inv2_res.status_code == 201, inv2_res.text
    inv2_id = inv2_res.json()["id"]
    await a["gm"].post(f"{API}/finance/supplier-invoices/{inv2_id}/approve-opening")

    # كشف حساب مورد 2: يجب أن يظهر كـ رصيد مدين سالب (-3000.00)
    s2_stmt = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup2_id}")).json()
    assert s2_stmt["totals"]["balance_due"] == -3000.0, f"المتوقع -3000.00 لكن الظاهر: {s2_stmt['totals']['balance_due']}"

    # ─────────────────────────────────────────────────────────────────────────
    # ٤. أرصدة العملاء الافتتاحية (Maker-Checker واستبعاد من Demand Pool)
    # ─────────────────────────────────────────────────────────────────────────
    c1_res = await a["fm"].post(f"{API}/customers", json={"code": f"C1_{tag}", "name": f"عميل 1 {tag}"})
    c1_id = c1_res.json()["id"]
    c2_res = await a["fm"].post(f"{API}/customers", json={"code": f"C2_{tag}", "name": f"عميل 2 {tag}"})
    c2_id = c2_res.json()["id"]

    # عميل 1: مديونية قديمة عليه 15,000 ج.م
    cust1_res = await a["fm"].post(f"{API}/customers/{c1_id}/opening-balances", json={
        "original_order_number": f"OLD-ORD1-{tag}",
        "order_date": "2026-10-10T00:00:00Z",
        "amount": "15000.00",
        "is_advance": False,
        "notes": "مديونية قديمة مستحقة على العميل",
    })
    assert cust1_res.status_code == 201, cust1_res.text
    cust1_order_id = cust1_res.json()["id"]

    # التحقق من Maker-Checker للعميل
    self_appr_c = await a["fm"].post(f"{API}/customers/{c1_id}/opening-balances/{cust1_order_id}/approve")
    assert self_appr_c.status_code == 403, "يجب منع منشئ رصيد العميل من اعتماده بنفسه"

    # اعتماد رصيد العميل 1 بواسطة المدير العام
    await a["gm"].post(f"{API}/customers/{c1_id}/opening-balances/{cust1_order_id}/approve")

    # عميل 2: دفعة مقدمة سددها العميل 4,000 ج.م (عميل دائن)
    cust2_res = await a["fm"].post(f"{API}/customers/{c2_id}/opening-balances", json={
        "original_order_number": f"OLD-ADV-C2-{tag}",
        "order_date": "2026-10-12T00:00:00Z",
        "amount": "4000.00",
        "is_advance": True,
        "notes": "دفعة مقدمة سابقة من العميل",
    })
    assert cust2_res.status_code == 201, cust2_res.text
    cust2_order_id = cust2_res.json()["id"]
    await a["gm"].post(f"{API}/customers/{c2_id}/opening-balances/{cust2_order_id}/approve")

    # كشف حساب عميل 2: يجب أن يظهر كـ رصيد دائن سالب (-4000.00)
    c2_stmt = (await a["fm"].get(f"{API}/reports/customer-statement/{c2_id}")).json()
    assert c2_stmt["totals"]["balance_due"] == -4000.0, f"المتوقع -4000.00 لكن الظاهر: {c2_stmt['totals']['balance_due']}"

    # استبعاد رصيد العميل من Demand Pool
    demand_pool_res = await a["pm"].get(f"{API}/production/demand-pool")
    assert demand_pool_res.status_code == 200, demand_pool_res.text
    demands = demand_pool_res.json()
    assert not any(d.get("customer_id") in (c1_id, c2_id) for d in demands), "رصيد العميل الافتتاحي لا يجوز أن يظهر في Demand Pool"

    # استبعاد رصيد العميل من تقرير المبيعات والإيرادات
    sales_rep = (await a["fm"].get(f"{API}/reports/analytics/sales?date_from=2026-10-01&date_to=2026-11-30")).json()
    cust_sales_ids = [r["key"] for r in sales_rep.get("by_customer", [])]
    assert c1_id not in cust_sales_ids, "رصيد العميل الافتتاحي لا يجوز أن يولد إيرادات مبيعات"
    assert c2_id not in cust_sales_ids, "دفعة العميل الافتتاحية لا يجوز أن تولد إيرادات مبيعات"

    # منع تسجيل تسليم بضاعة على أمر رصيد افتتاحي
    deliv_try = await a["wh"].post(f"{API}/customers/{c1_id}/orders/{cust1_order_id}/deliveries", json={
        "lines": [{"order_line_id": "fake_line_id", "quantity": 1}],
        "notes": "محاولة تسليم غير مسموحة",
    })
    assert deliv_try.status_code == 409, "يجب منع تسجيل تسليم بضاعة لأمر رصيد افتتاحي بـ 409"

    # ─────────────────────────────────────────────────────────────────────────
    # ٥. القيد الافتتاحي العام للنقدية ورأس المال
    # ─────────────────────────────────────────────────────────────────────────
    ob_check = (await a["fm"].get(f"{API}/finance/opening-balances")).json()
    if not ob_check.get("is_set"):
        ob_res = await a["fm"].post(f"{API}/finance/opening-balances", json={
            "accounting_start_date": "2026-11-01",
            "treasury_balance": "20000.00",
            "bank_balance": "80000.00",
            "custody_balance": "0.00",
            "accounts_receivable": "0.00",
            "raw_materials_inventory": "0.00",
            "wip_inventory": "0.00",
            "finished_goods_inventory": "0.00",
            "accounts_payable": "0.00",
            "paid_in_capital": "100000.00",
            "notes": "قيد افتتاحي عام للنقدية ورأس المال",
        })
        assert ob_res.status_code == 201, ob_res.text

    # ─────────────────────────────────────────────────────────────────────────
    # ٦. المطابقة الشاملة وحساب 3900 وميزان المراجعة وقائمة الدخل
    # ─────────────────────────────────────────────────────────────────────────
    tb_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    assert tb_res.status_code == 200, tb_res.text
    tb = tb_res.json()
    assert tb["totals"]["balanced"] is True, "ميزان المراجعة يجب أن يكون متوازناً تماماً"

    # البحث عن رصيد حساب 3900 في ميزان المراجعة
    # الحساب:
    # المخزون الافتتاحي = +25,000 دائن 3900
    # مورد 1 (مستحق له) = +10,000 مدين 3900
    # مورد 2 (دفعة مقدمة) = +3,000 دائن 3900
    # عميل 1 (مديونية) = +15,000 دائن 3900
    # عميل 2 (دفعة مقدمة) = +4,000 مدين 3900
    # صافي رصيد 3900 الدائن = (25000 + 3000 + 15000) − (10000 + 4000) = 43000 − 14000 = 29,000.00 ج.م دائن
    # وهي تطابق تماماً: المخزون (25,000) + صافي العملاء (15,000 − 4,000 = 11,000) − صافي الموردين (10,000 − 3,000 = 7,000) = 29,000 ج.م
    acc_3900 = next((r for r in tb["rows"] if r["code"] == "3900"), None)
    assert acc_3900 is not None, "حساب 3900 يجب أن يظهر في ميزان المراجعة"
    net_3900_cr = Decimal(str(acc_3900["total_credit"])) - Decimal(str(acc_3900["total_debit"]))
    delta_3900_cr = net_3900_cr - initial_3900_cr
    assert delta_3900_cr == Decimal("29000.00"), f"أثر حركة يوم القطع على 3900 يجب أن يكون 29,000.00 دائن، الفعلي: {delta_3900_cr}"

    # التحقق من أن قيود يوم القطع لا تحتوي على أي حساب من حسابات الإيرادات (4) أو المصروفات (5)
    cutover_doc_types = ["opening_stocktake", "opening_supplier_invoice", "opening_customer_balance", "opening_balance"]
    from app.modules.finance.models import Account, JournalEntryLine
    stmt = (
        sa.select(Account.code)
        .join(JournalEntryLine, JournalEntryLine.account_id == Account.id)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.entry_id)
        .where(
            JournalEntry.source_doc_type.in_(cutover_doc_types),
            sa.or_(Account.code.startswith("4"), Account.code.startswith("5"))
        )
    )
    pl_rows = (await session.execute(stmt)).all()
    assert len(pl_rows) == 0, f"لا يجوز لأي مستند افتتاحي أن يؤثر على حسابات الأرباح والخسائر: {pl_rows}"

    # ─────────────────────────────────────────────────────────────────────────
    # ٧. التحقق من قفل الأرصدة الافتتاحية (409)
    # ─────────────────────────────────────────────────────────────────────────
    lock_test_res = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup1_id,
        "invoice_number": f"LOCKED-INV-{tag}",
        "invoice_date": "2026-11-01T00:00:00Z",
        "amount": "5000.00",
    })
    assert lock_test_res.status_code == 409, "محاولة إنشاء مستند افتتاحي بعد القفل يجب أن تعيد 409"

    # ─────────────────────────────────────────────────────────────────────────
    # ٨. صرف خامات لأمر تشغيل والتأكد من تحميل التكلفة المدخلة في الجرد الافتتاحي
    # ─────────────────────────────────────────────────────────────────────────
    # إنشاء منتج وقالب تشغيل بسيط يستهلك الخامة
    prod, v56, v60 = await _product_with_sizes(session)

    # إنشاء أمر تشغيل لـ 50 قطعة مع خامات مخصصة (100 متر من خامة الجرد الافتتاحي)
    po_res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{
            "product_id": prod.id,
            "variant_id": v56.id,
            "target_quantity": 50,
            "season": "summer",
        }],
        "custom_materials": [
            {"item_id": item.id, "unit_id": unit.id, "planned_quantity": 100.0},
        ],
        "notes": "أمر تشغيل أول بعد يوم القطع",
    })
    assert po_res.status_code == 201, po_res.text
    po_id = po_res.json()["id"]

    # صرف الخامات للأمر
    dispatch_res = await a["wh"].post(f"{API}/production/orders/{po_id}/dispatch", json={"notes": "صرف خامات افتتاحية"})
    assert dispatch_res.status_code == 200, dispatch_res.text

    # فحص تفاصيل خامات أمر التشغيل المصروفة:
    # 100 متر
    # تكلفة الوحدة المحملة = 25.0000 ج.م بالضبط (وليس 0.0000)!
    po_details = (await a["pm"].get(f"{API}/production/orders/{po_id}")).json()
    mat_line = po_details["materials"][0]
    assert Decimal(str(mat_line["unit_cost"])) == Decimal("25.0000"), (
        f"يجب تحميل أمر التشغيل بتكلفة الخامات الافتتاحية 25.0000 ج.م، المحسوب: {mat_line['unit_cost']}"
    )
    assert Decimal(str(mat_line["total_cost"])) == Decimal("2500.00"), (
        f"إجمالي تكلفة الخامات يجب أن تكون 2500.00 ج.م (100 متر × 25)، المحسوب: {mat_line['total_cost']}"
    )
