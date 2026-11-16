"""
اختبار محاكاة يوم القطع والتشغيل الفعلي الشامل (Day 0 Cutover Simulation Test)
─────────────────────────────────────────────────────────────────────────────
يختبر بدقة متناهية على قاعدة البيانات الفعلية:
1. عزل المصادر في الإنتاج والضابط المقابل خارج الإنتاج (RBAC Environment Enforcement).
2. حظر الحسابات الفرعية الخمسة في القيد الافتتاحي العام (422) على مستوى Schema والـ Endpoint.
3. الجرد الافتتاحي: إلزامية unit_cost ورفض الجرد بلا تكلفة (422)، عزل خامات أمانات العملاء CMT بصفر تكلفة، ترحيل Dr 1210 / Cr 3900، وحظر جلسة ثانية (409).
4. فواتير الموردين الافتتاحية: Maker-Checker، قيود 3900 و2100، كشوف الحسابات، السداد الجزئي مع التخصيص، ومطابقة رصيد 2100.
5. أرصدة العملاء الافتتاحية: Maker-Checker، قيود 1100 و3900، كشوف الحسابات، التحصيل الجزئي مع التخصيص، استبعادها من Demand Pool وتقارير المبيعات، ومطابقة رصيد 1100.
6. الضابط المقابل للعملاء: عميل ثالث بطلب حقيقي يظهر في Demand Pool وتقرير المبيعات.
7. القيد الافتتاحي العام للنقدية ورأس المال وتوازن ميزان المراجعة، وصفرية قائمة الدخل، وتطابق 3900.
8. قفل الأرصدة الافتتاحية (409) عبر جدول accounting_locks.
9. دورة إعادة الفتح والاعتماد (Maker-Checker)، إدخال رصيد منسي، وإعادة القفل مع حفظ سجل التدقيق غير القابل للحذف.
10. حصانة دفاتر اليومية والمخزون بالتريجرات (Append-Only Triggers).
11. صرف الخامات لأمر تشغيل بالتكلفة المدخلة في الجرد الافتتاحي والقفل التلقائي عند أول صرف.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import DBAPIError, InternalError, ProgrammingError
from pydantic import ValidationError

from app.core.auth import AuthenticatedUser
from app.core.config import settings
from app.modules.customers.models import Customer, CustomerOrder
from app.modules.finance.models import (
    Account,
    AccountingLock,
    CashAccount,
    CashDocument,
    CashLedgerEntry,
    JournalEntry,
    JournalEntryLine,
    Supplier,
    SupplierInvoice,
)
from app.modules.finance.ledger_service import CANONICAL_BANK_ID, CANONICAL_TREASURY_ID, get_weighted_average_cost
from app.modules.finance.schemas import OpeningBalancesCreate
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    StockLedgerEntry,
    StocktakeSession,
    Unit,
    Warehouse,
)
from app.modules.production.stock import stock_balance
from tests.test_operational_cycle_e2e import (
    Actor,
    _approved_item,
    _finished_stock,
    _product_with_sizes,
    _tag,
    _uid,
    _unit,
    _warehouse,
    ctx,
)

API = "/api/v1"


async def _get_treasury_balance(actor) -> Decimal:
    res = await actor.get(f"{API}/finance/accounts")
    assert res.status_code == 200, res.text
    tr = next(acc for acc in res.json() if acc["id"] == CANONICAL_TREASURY_ID)
    return Decimal(str(tr["balance"]))


@pytest.mark.asyncio
async def test_rbac_production_user_roles_only(ctx, monkeypatch):
    """
    التحقق من أن بيئة production تعتمد حصرياً على جدول user_roles وترفض app_metadata (403)،
    مع فحص الضابط المقابل: خارج الإنتاج (testing/development) يمر الطلب بـ 200.
    """
    session, a = ctx
    tag = _tag()

    # 1. حالة الإنتاج: رفض مستخدم app_metadata فقط
    monkeypatch.setattr(settings, "app_env", "production")
    rogue_user_prod = AuthenticatedUser(
        id=f"user_rogue_prod_{tag}",
        email=f"rogue_prod_{tag}@qemma.test",
        claims={"app_metadata": {"role": "finance_manager"}},
    )
    rogue_actor_prod = Actor(a["fm"].client, rogue_user_prod)
    res_prod = await rogue_actor_prod.get(f"{API}/finance/opening-balances")
    assert res_prod.status_code == 403, (
        f"المتوقع 403 في بيئة الإنتاج لعدم وجود المستخدم في جدول user_roles، لكن الاستجابة كانت: {res_prod.status_code}"
    )

    # 2. الضابط المقابل: خارج الإنتاج (testing) يُقبل الدور من التوكن
    monkeypatch.setattr(settings, "app_env", "testing")
    rogue_user_test = AuthenticatedUser(
        id=f"user_rogue_test_{tag}",
        email=f"rogue_test_{tag}@qemma.test",
        claims={"app_metadata": {"role": "finance_manager"}},
    )
    rogue_actor_test = Actor(a["fm"].client, rogue_user_test)
    res_test = await rogue_actor_test.get(f"{API}/finance/opening-balances")
    assert res_test.status_code == 200, (
        f"المتوقع 200 خارج الإنتاج للاختبارات السريعة، لكن الاستجابة كانت: {res_test.status_code}"
    )


@pytest.mark.asyncio
async def test_day0_cutover_full_simulation(ctx):
    """السيناريو الشامل ليوم القطع والمطابقة المحاسبية والتشغيلية الكاملة."""
    session, a = ctx
    now = datetime.now(timezone.utc)
    tag = _tag()
    cutover_date = date(2026, 1, 1) + timedelta(days=int(tag, 16) % 1000)

    # ضمان فتح القفل عبر دورة Maker-Checker الرسمية إن كان مقفلاً من اختبار سابق في الطقم الكامل
    lock_init_status = (await a["fm"].get(f"{API}/finance/opening-balances/lock-status")).json()
    if lock_init_status.get("is_locked"):
        req_res = await a["fm"].post(f"{API}/finance/opening-balances/request-unlock", json={
            "reason": f"فتح القفل لتهيئة سيناريو يوم القطع {tag}",
        })
        assert req_res.status_code == 201, req_res.text
        appr_res = await a["gm"].post(f"{API}/finance/opening-balances/approve-unlock", json={
            "approval_notes": f"معتمد للبدء {tag}",
        })
        assert appr_res.status_code == 200, appr_res.text

    # قياس الأرصدة الأولية قبل حركات يوم القطع لعزل الأثر بدقة
    tb_init_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    assert tb_init_res.status_code == 200, tb_init_res.text
    tb_init = tb_init_res.json()

    acc_3900_init = next((r for r in tb_init["rows"] if r["code"] == "3900"), None)
    initial_3900_cr = (
        Decimal(str(acc_3900_init["total_credit"])) - Decimal(str(acc_3900_init["total_debit"]))
        if acc_3900_init else Decimal("0.00")
    )

    acc_1210_init = next((r for r in tb_init["rows"] if r["code"] == "1210"), None)
    initial_1210_dr = (
        Decimal(str(acc_1210_init["total_debit"])) - Decimal(str(acc_1210_init["total_credit"]))
        if acc_1210_init else Decimal("0.00")
    )

    acc_2100_init = next((r for r in tb_init["rows"] if r["code"] == "2100"), None)
    initial_2100_cr = (
        Decimal(str(acc_2100_init["total_credit"])) - Decimal(str(acc_2100_init["total_debit"]))
        if acc_2100_init else Decimal("0.00")
    )

    acc_1100_init = next((r for r in tb_init["rows"] if r["code"] == "1100"), None)
    initial_1100_dr = (
        Decimal(str(acc_1100_init["total_debit"])) - Decimal(str(acc_1100_init["total_credit"]))
        if acc_1100_init else Decimal("0.00")
    )

    # رصيد الخزينة الأولي
    init_treasury_bal = await _get_treasury_balance(a["fm"])

    # ─────────────────────────────────────────────────────────────────────────
    # ١. التحقق من رفض إدخال أي من الحسابات الخمسة الممنوعة في القيد الافتتاحي العام (422)
    # ─────────────────────────────────────────────────────────────────────────
    prohibited_cases = [
        ("accounts_receivable", "1100 (ذمم العملاء)"),
        ("raw_materials_inventory", "1210 (مخزون الخامات)"),
        ("wip_inventory", "1220 (إنتاج تحت التشغيل)"),
        ("finished_goods_inventory", "1230 (مخزون التام)"),
        ("accounts_payable", "2100 (ذمم الموردين)"),
    ]
    for field_name, label_ar in prohibited_cases:
        bad_payload = {
            "accounting_start_date": cutover_date.isoformat(),
            "treasury_balance": "50000.00",
            "paid_in_capital": "50000.00",
            field_name: "10000.00",
        }
        if field_name != "accounts_payable":
            bad_payload["paid_in_capital"] = "60000.00"
        else:
            bad_payload["treasury_balance"] = "60000.00"

        res_bad = await a["fm"].post(f"{API}/finance/opening-balances", json=bad_payload)
        assert res_bad.status_code == 422, f"يجب رفض {label_ar} في القيد الافتتاحي العام بـ 422"
        assert res_bad.json()["code"] == "VALIDATION_ERROR"

    # ─────────────────────────────────────────────────────────────────────────
    # ٢. الجرد الافتتاحي لمخزن الخامات (Opening Stocktake)
    # ─────────────────────────────────────────────────────────────────────────
    unit = await _unit(session, "meter")
    unit_id = unit.id
    raw_wh = await _warehouse(session, "main_raw_materials")
    raw_wh_id = raw_wh.id
    item_factory = await _approved_item(session, f"FABRIC_FAC_{tag}", unit)
    item_factory_id = item_factory.id

    # عميل تشغيل للغير CMT وصنف خامة أمانة
    cust_cmt_res = await a["fm"].post(f"{API}/customers", json={
        "code": f"CUST_CMT_{tag}",
        "name": f"عميل تشغيل للغير {tag}",
        "phone": "01100000000",
    })
    assert cust_cmt_res.status_code == 201, cust_cmt_res.text
    cmt_cust_id = cust_cmt_res.json()["id"]

    # إنشاء جلسة جرد افتتاحي للمخزن
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
        "description": "محاولة جرد افتتاحي مكرر للمخزن",
    })
    assert st_dup_res.status_code == 409, "يجب منع إنشاء جلسة جرد افتتاحي ثانية للمخزن بـ 409"

    # بدء العد
    start_cnt_res = await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/start-counting")
    assert start_cnt_res.status_code == 200, start_cnt_res.text
    st_details = (await a["wh"].get(f"{API}/inventory/stocktakes/{st_id}")).json()
    line_fac_id = next(ln["id"] for ln in st_details["lines"] if ln["item_id"] == item_factory.id)

    # (ح) التحقق من رفض الجرد بلا تكلفة unit_cost (أو صفر) لخامات المصنع
    bad_count_res = await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/counts", json={
        "counts": [{
            "line_id": line_fac_id,
            "counted_quantity": 1000.0,
            "unit_cost": 0.0,  # ممنوع لخامات المصنع!
            "notes": "محاولة إدخال بدون تكلفة وحدة",
        }]
    })
    assert bad_count_res.status_code == 200, bad_count_res.text
    await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/submit")
    await a["fm"].post(f"{API}/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})
    post_bad_cost = await a["fm"].post(f"{API}/inventory/stocktakes/{st_id}/post")
    assert post_bad_cost.status_code == 422, "يجب رفض ترحيل الجرد الافتتاحي لخامة مصنع بتكلفة صفر بـ 422"
    assert "unit_cost" in post_bad_cost.text or "إلزامية" in post_bad_cost.text

    # إلغاء جلسة الجرد غير الصالحة عبر الـ API
    cancel_bad_res = await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/cancel", json={
        "reason": "إلغاء جلسة عد فاشلة بلا تكلفة صالحة",
    })
    assert cancel_bad_res.status_code == 200, cancel_bad_res.text

    # إنشاء جلسة جرد افتتاحي صالحة لمخزن الخامات
    st_valid_res = await a["wh"].post(f"{API}/inventory/stocktakes", json={
        "warehouse_id": raw_wh.id,
        "is_opening": True,
        "description": f"جرد افتتاحي رسمي معتمد {tag}",
    })
    assert st_valid_res.status_code == 201, st_valid_res.text
    st_id = st_valid_res.json()["id"]

    # بدء العد الصحيح: 1,000 متر بتكلفة وحدة 25.00 ج.م = 25,000.00 ج.م
    await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/start-counting")
    st_details2 = (await a["wh"].get(f"{API}/inventory/stocktakes/{st_id}")).json()
    line_fac_id2 = next(ln["id"] for ln in st_details2["lines"] if ln["item_id"] == item_factory.id)

    good_count_res = await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/counts", json={
        "counts": [{
            "line_id": line_fac_id2,
            "counted_quantity": 1000.0,
            "unit_cost": 25.00,
            "notes": "عد خامات المصنع بالتكلفة الصحيحة",
        }]
    })
    assert good_count_res.status_code == 200, good_count_res.text

    # إضافة سطر خامة CMT للعميل بتكلفة 0.00 ج.م
    cmt_item = await _approved_item(session, f"CMT_FABRIC_{tag}", unit)
    cmt_stock_entry_id = str(uuid.uuid4())
    cmt_stock_entry = StockLedgerEntry(
        id=cmt_stock_entry_id,
        item_id=cmt_item.id,
        unit_id=unit.id,
        warehouse_id=raw_wh.id,
        location_type="warehouse",
        bucket_reference=f"customer_deposit:{cmt_cust_id}",
        quantity=500.0,
        reference_doc_type="initial_cmt_deposit",
        reference_doc_id=str(uuid.uuid4()),
        entry_type="deposit",
        created_by="test-admin",
        unit_cost=Decimal("0.0000"),
        total_cost=Decimal("0.00"),
    )
    session.add(cmt_stock_entry)
    await session.commit()

    # تقديم واعتماد وترحيل الجرد الافتتاحي الصحيح
    await a["wh"].post(f"{API}/inventory/stocktakes/{st_id}/submit")
    await a["fm"].post(f"{API}/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})
    post_st_res = await a["fm"].post(f"{API}/inventory/stocktakes/{st_id}/post")
    assert post_st_res.status_code == 200, post_st_res.text

    # التحقق من التكلفة المرجحة لخامة المصنع = 25.0000 ج.م وخامة CMT = 0.0000 ج.م
    wac_fac = await get_weighted_average_cost(session, item_factory.id, raw_wh.id)
    assert wac_fac == Decimal("25.0000"), f"التكلفة المرجحة لخامة المصنع يجب أن تكون 25.0000 ج.م، الفعلي: {wac_fac}"
    wac_cmt = await get_weighted_average_cost(session, cmt_item.id, raw_wh.id)
    assert wac_cmt == Decimal("0.0000"), f"التكلفة المرجحة لخامة CMT يجب أن تكون 0.0000 ج.م، الفعلي: {wac_cmt}"

    # (و) التحقق من أن حساب 1210 زاد بمقدار 25,000.00 ج.م بالضبط دون مساس بـ 5200 أو 5220
    tb_st_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    assert tb_st_res.status_code == 200
    tb_st = tb_st_res.json()
    acc_1210_after = next((r for r in tb_st["rows"] if r["code"] == "1210"), None)
    current_1210_dr = (
        Decimal(str(acc_1210_after["total_debit"])) - Decimal(str(acc_1210_after["total_credit"]))
        if acc_1210_after else Decimal("0.00")
    )
    assert current_1210_dr - initial_1210_dr == Decimal("25000.00"), (
        f"أثر الجرد الافتتاحي على 1210 يجب أن يكون +25,000.00 بالضبط، الفعلي: {current_1210_dr - initial_1210_dr}"
    )

    # ─────────────────────────────────────────────────────────────────────────
    # ٣. فواتير الموردين الافتتاحية: Maker-Checker، السداد الجزئي مع التخصيص
    # ─────────────────────────────────────────────────────────────────────────
    sup1_res = await a["wh"].post(f"{API}/finance/suppliers", json={"code": f"S1_{tag}", "name": f"مورد 1 {tag}"})
    assert sup1_res.status_code == 201, sup1_res.text
    sup1_id = sup1_res.json()["id"]

    sup2_res = await a["wh"].post(f"{API}/finance/suppliers", json={"code": f"S2_{tag}", "name": f"مورد 2 {tag}"})
    assert sup2_res.status_code == 201, sup2_res.text
    sup2_id = sup2_res.json()["id"]

    # مورد 1: رصيد دائن قديم مستحق له 10,000 ج.م
    inv1_res = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup1_id,
        "invoice_number": f"OLD-INV1-{tag}",
        "invoice_date": "2026-10-15T00:00:00Z",
        "amount": "10000.00",
        "is_advance": False,
        "notes": "رصيد دائن افتتاحي سابق للمورد 1",
    })
    assert inv1_res.status_code == 201, inv1_res.text
    inv1_id = inv1_res.json()["id"]

    # Maker-Checker: منشئ الفاتورة (fm) يمنع من اعتمادها بنفسه (403)
    self_appr_sup = await a["fm"].post(f"{API}/finance/supplier-invoices/{inv1_id}/approve-opening")
    assert self_appr_sup.status_code == 403, "يجب منع منشئ المستند الافتتاحي من اعتماده بنفسه (Maker-Checker)"

    # اعتماد الفاتورة بواسطة المدير العام (gm)
    appr1 = await a["gm"].post(f"{API}/finance/supplier-invoices/{inv1_id}/approve-opening")
    assert appr1.status_code == 200, appr1.text

    # (أ) كشف حساب مورد 1: رصيد مستحق 10,000.00 ج.م
    s1_stmt_before = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup1_id}")).json()
    assert s1_stmt_before["totals"]["balance_due"] == 10000.0, (
        f"المتوقع 10000.00 ج.م لمورد 1 قبل السداد، الفعلي: {s1_stmt_before['totals']['balance_due']}"
    )

    # مورد 2: دفعة مقدمة 3,000 ج.م (مورد مدين)
    inv2_res = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup2_id,
        "invoice_number": f"OLD-ADV2-{tag}",
        "invoice_date": "2026-10-20T00:00:00Z",
        "amount": "3000.00",
        "is_advance": True,
        "notes": "دفعة مقدمة سابقة للمورد 2",
    })
    assert inv2_res.status_code == 201, inv2_res.text
    inv2_id = inv2_res.json()["id"]
    await a["gm"].post(f"{API}/finance/supplier-invoices/{inv2_id}/approve-opening")

    # كشف حساب مورد 2: رصيد مدين سالب (-3000.00)
    s2_stmt = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup2_id}")).json()
    assert s2_stmt["totals"]["balance_due"] == -3000.0, f"المتوقع -3000.00 لمورد 2، الفعلي: {s2_stmt['totals']['balance_due']}"

    # ─────────────────────────────────────────────────────────────────────────
    # ٤. أرصدة العملاء الافتتاحية: Maker-Checker واستبعاد من الطلب والتسليم
    # ─────────────────────────────────────────────────────────────────────────
    c1_res = await a["fm"].post(f"{API}/customers", json={"code": f"C1_{tag}", "name": f"عميل 1 {tag}"})
    assert c1_res.status_code == 201, c1_res.text
    c1_id = c1_res.json()["id"]

    c2_res = await a["fm"].post(f"{API}/customers", json={"code": f"C2_{tag}", "name": f"عميل 2 {tag}"})
    assert c2_res.status_code == 201, c2_res.text
    c2_id = c2_res.json()["id"]

    # عميل 1: مديونية قديمة عليه 15,000 ج.م
    cust1_res = await a["fm"].post(f"{API}/customers/{c1_id}/opening-balances", json={
        "original_order_number": f"OLD-ORD1-{tag}",
        "order_date": "2026-10-10T00:00:00Z",
        "amount": "15000.00",
        "is_advance": False,
        "notes": "مديونية قديمة مستحقة على العميل 1",
    })
    assert cust1_res.status_code == 201, cust1_res.text
    cust1_order_id = cust1_res.json()["id"]

    # Maker-Checker لعميل 1: رفض الاعتماد الذاتي
    self_appr_c = await a["fm"].post(f"{API}/customers/{c1_id}/opening-balances/{cust1_order_id}/approve")
    assert self_appr_c.status_code == 403, "يجب منع منشئ رصيد العميل من اعتماده بنفسه (403)"

    # اعتماد رصيد العميل 1 بواسطة المدير العام
    appr_c1 = await a["gm"].post(f"{API}/customers/{c1_id}/opening-balances/{cust1_order_id}/approve")
    assert appr_c1.status_code == 200, appr_c1.text

    # (ب) كشف حساب عميل 1: رصيد مستحق 15,000.00 ج.م
    c1_stmt_before = (await a["fm"].get(f"{API}/reports/customer-statement/{c1_id}")).json()
    assert c1_stmt_before["totals"]["balance_due"] == 15000.0, (
        f"المتوقع 15000.00 ج.م لعميل 1 قبل التحصيل، الفعلي: {c1_stmt_before['totals']['balance_due']}"
    )

    # عميل 2: دفعة مقدمة 4,000 ج.م (عميل دائن)
    cust2_res = await a["fm"].post(f"{API}/customers/{c2_id}/opening-balances", json={
        "original_order_number": f"OLD-ADV-C2-{tag}",
        "order_date": "2026-10-12T00:00:00Z",
        "amount": "4000.00",
        "is_advance": True,
        "notes": "دفعة مقدمة سابقة من العميل 2",
    })
    assert cust2_res.status_code == 201, cust2_res.text
    cust2_order_id = cust2_res.json()["id"]
    await a["gm"].post(f"{API}/customers/{c2_id}/opening-balances/{cust2_order_id}/approve")

    # كشف حساب عميل 2: رصيد دائن سالب (-4000.00)
    c2_stmt = (await a["fm"].get(f"{API}/reports/customer-statement/{c2_id}")).json()
    assert c2_stmt["totals"]["balance_due"] == -4000.0, f"المتوقع -4000.00 لعميل 2، الفعلي: {c2_stmt['totals']['balance_due']}"

    # استبعاد رصيد العميل 1 و2 من Demand Pool
    demand_pool_res = await a["pm"].get(f"{API}/production/demand-pool")
    assert demand_pool_res.status_code == 200, demand_pool_res.text
    demands = demand_pool_res.json()
    assert not any(d.get("customer_id") in (c1_id, c2_id) for d in demands), "رصيد العميل الافتتاحي محظور في Demand Pool"

    # استبعاد رصيد العميل 1 و2 من تقرير المبيعات
    sales_rep = (await a["fm"].get(f"{API}/reports/analytics/sales?date_from=2026-10-01&date_to=2026-11-30")).json()
    cust_sales_ids = [r["key"] for r in sales_rep.get("by_customer", [])]
    assert c1_id not in cust_sales_ids, "رصيد العميل الافتتاحي لا يولد مبيعات"
    assert c2_id not in cust_sales_ids, "دفعة العميل الافتتاحية لا تولد مبيعات"

    # (ط) منع تسجيل تسليم بضاعة لأمر رصيد افتتاحي (409)
    deliv_try = await a["wh"].post(f"{API}/customers/{c1_id}/orders/{cust1_order_id}/deliveries", json={
        "lines": [{"order_line_id": "dummy_order_line_id", "quantity": 1}],
        "notes": "محاولة تسليم غير مشروعة لأمر افتتاحي",
    })
    assert deliv_try.status_code == 409, "يجب منع تسجيل تسليم بضاعة لأمر رصيد افتتاحي بـ 409"

    # ─────────────────────────────────────────────────────────────────────────
    # ٥. القيد الافتتاحي العام للنقدية ورأس المال (فيُقفل النظام تلقائياً)
    # ─────────────────────────────────────────────────────────────────────────
    # التحقق من رفض أي قيمة غير صفرية للعهد بـ 422
    custody_rej_res = await a["fm"].post(f"{API}/finance/opening-balances", json={
        "accounting_start_date": cutover_date.isoformat(),
        "treasury_balance": "20000.00",
        "bank_balance": "80000.00",
        "custody_balance": "5000.00",
        "paid_in_capital": "105000.00",
        "notes": "محاولة مرفوضة لقيد رصيد عهدة",
    })
    assert custody_rej_res.status_code == 422, custody_rej_res.text
    assert "أرصدة العهد تُسجَّل بعد يوم القطع بتحويل من الخزينة إلى حساب العهدة" in custody_rej_res.text

    ob_res = await a["fm"].post(f"{API}/finance/opening-balances", json={
        "accounting_start_date": cutover_date.isoformat(),
        "treasury_balance": "20000.00",
        "bank_balance": "80000.00",
        "custody_balance": "0.00",
        "accounts_receivable": "0.00",
        "raw_materials_inventory": "0.00",
        "wip_inventory": "0.00",
        "finished_goods_inventory": "0.00",
        "accounts_payable": "0.00",
        "paid_in_capital": "100000.00",
        "notes": f"قيد افتتاحي عام للنقدية ورأس المال {tag}",
    })
    assert ob_res.status_code == 201, ob_res.text
    ob_data = ob_res.json()
    assert ob_data["is_set"] is True
    assert ob_data["is_balanced"] is True
    je_ob_id = ob_data["journal_entry_id"]

    # محاولة ترحيل قيد افتتاحي عام ثانٍ فوراً بتاريخ مختلف
    dup_ob_res = await a["fm"].post(f"{API}/finance/opening-balances", json={
        "accounting_start_date": "2026-10-31",
        "treasury_balance": "5000.00",
        "bank_balance": "5000.00",
        "paid_in_capital": "10000.00",
        "notes": "محاولة قيد عام مكرر فوراً",
    })
    assert dup_ob_res.status_code == 409, "يجب رفض محاولة قيد افتتاحي عام مكرر برمز 409"

    # التحقق من أن جدول accounting_locks تم قفله تلقائياً
    lock_status_res = await a["fm"].get(f"{API}/finance/opening-balances/lock-status")
    assert lock_status_res.status_code == 200, lock_status_res.text
    assert lock_status_res.json()["is_locked"] is True, "يجب أن تكون الأرصدة الافتتاحية مقفلة بعد ترحيل القيد العام"

    # ─────────────────────────────────────────────────────────────────────────
    # ٦. المطابقة المبدئية قبل العمليات: ميزان المراجعة، حساب 3900، وصفرية الأرباح والخسائر
    # ─────────────────────────────────────────────────────────────────────────
    tb_pre_ops_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    assert tb_pre_ops_res.status_code == 200, tb_pre_ops_res.text
    tb_pre = tb_pre_ops_res.json()
    assert tb_pre["totals"]["balanced"] is True, "ميزان المراجعة قبل العمليات يجب أن يكون متوازناً تماماً"

    # رصيد الخزينة والبنك الأوليين في دفتر الأستاذ العام (GL):
    acc_1010_pre = next((r for r in tb_pre["rows"] if r["code"] == "1010"), None)
    assert acc_1010_pre is not None and Decimal(str(acc_1010_pre["total_debit"])) == Decimal("20000.00"), "رصيد 1010 في الأستاذ العام يجب أن يكون 20,000.00 ج.م"
    acc_1030_pre = next((r for r in tb_pre["rows"] if r["code"] == "1030"), None)
    assert acc_1030_pre is not None and Decimal(str(acc_1030_pre["total_debit"])) == Decimal("80000.00"), "رصيد 1030 في الأستاذ العام يجب أن يكون 80,000.00 ج.م"

    # فحص دفتر النقدية المساعد (Cash Ledger Subledger):
    # بعد القيد الافتتاحي العام، يتم إنشاء حركات افتتاحية ذرّية في cash_ledger_entries:
    # رصيد دفتر الخزينة = 20,000 ج.م ورصيد دفتر البنك = 80,000 ج.م
    treasury_pre_ops = await _get_treasury_balance(a["fm"])
    assert treasury_pre_ops == Decimal("20000.00"), (
        f"رصيد الخزينة في دفتر النقدية المساعد يجب أن يكون 20,000.00 ج.م، الفعلي: {treasury_pre_ops}"
    )
    bank_pre_ops = await session.scalar(
        sa.select(sa.func.coalesce(sa.func.sum(CashLedgerEntry.amount), 0)).where(
            CashLedgerEntry.account_id == CANONICAL_BANK_ID
        )
    )
    assert Decimal(str(bank_pre_ops)) == Decimal("80000.00"), (
        f"رصيد البنك في دفتر النقدية المساعد يجب أن يكون 80,000.00 ج.م، الفعلي: {bank_pre_ops}"
    )

    # التحقق من أن كشف حساب النقدية يعرض الرصيد الافتتاحي كأول سطر بأرصدة تراكمية صحيحة
    tr_stmt_res = await a["fm"].get(f"{API}/reports/cash-account-statement/{CANONICAL_TREASURY_ID}")
    assert tr_stmt_res.status_code == 200, tr_stmt_res.text
    tr_stmt = tr_stmt_res.json()["statement"]
    assert len(tr_stmt["transactions"]) > 0, "يجب أن يحتوي كشف حساب الخزينة على حركات"
    first_tx = tr_stmt["transactions"][0]
    assert first_tx["type"] == "رصيد افتتاحي"
    assert first_tx["debit"] == 20000.0
    assert first_tx["running_balance"] == 20000.0

    # مطابقة حساب 3900:
    # المخزون الافتتاحي = +25,000 دائن 3900
    # مورد 1 (مستحق له) = +10,000 مدين 3900
    # مورد 2 (دفعة مقدمة) = +3,000 دائن 3900
    # عميل 1 (مديونية) = +15,000 دائن 3900
    # عميل 2 (دفعة مقدمة) = +4,000 مدين 3900
    # صافي رصيد 3900 = 29,000.00 دائن
    acc_3900_pre = next((r for r in tb_pre["rows"] if r["code"] == "3900"), None)
    assert acc_3900_pre is not None, "حساب 3900 يجب أن يظهر في ميزان المراجعة"
    net_3900_pre_cr = Decimal(str(acc_3900_pre["total_credit"])) - Decimal(str(acc_3900_pre["total_debit"]))
    delta_3900_pre_cr = net_3900_pre_cr - initial_3900_cr
    assert delta_3900_pre_cr == Decimal("29000.00"), f"أثر حركة يوم القطع على 3900 يجب أن يكون 29,000.00 دائن، الفعلي: {delta_3900_pre_cr}"

    # صفرية حسابات الأرباح والخسائر لمستندات يوم القطع
    cutover_doc_types = ["opening_stocktake", "opening_supplier_invoice", "opening_customer_balance", "opening_balance"]
    stmt_pl = (
        sa.select(Account.code)
        .join(JournalEntryLine, JournalEntryLine.account_id == Account.id)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.entry_id)
        .where(
            JournalEntry.source_doc_type.in_(cutover_doc_types),
            sa.or_(Account.code.startswith("4"), Account.code.startswith("5"))
        )
    )
    pl_rows = (await session.execute(stmt_pl)).all()
    assert len(pl_rows) == 0, f"لا يجوز لأي مستند افتتاحي أن يؤثر على حسابات الأرباح والخسائر: {pl_rows}"

    # ─────────────────────────────────────────────────────────────────────────
    # ٧. العمليات التشغيلية بعد القفل (Post-Lock Operations): سداد، تحصيل، تسليم C3، صرف خامات
    # ─────────────────────────────────────────────────────────────────────────
    # (ج1) سداد جزئي 6,000 ج.م لمورد 1 من رصيد الخزينة الافتتاحي بعد القفل وقبل أي تحصيل:
    # ينجح السداد والتخصيص ويُعتمد تلقائياً للمدير المالي (FIN-DEC-01) نظراً لتوفر الرصيد الافتتاحي في الخزينة
    pay_res = await a["fm"].post(f"{API}/finance/supplier-invoices/{inv1_id}/payments", json={
        "amount": "6000.00",
        "description": f"سداد جزئي لمورد 1 من الرصيد الافتتاحي {tag}",
    })
    assert pay_res.status_code == 201, pay_res.text
    csh_doc = pay_res.json()
    assert csh_doc["status"] == "approved", "سند الصرف المنشأ بواسطة المدير المالي يُعتمد تلقائياً (FIN-DEC-01)"

    # كشف حساب مورد 1 أصبح 4,000.00 ج.م (10,000 - 6,000)
    s1_stmt_after = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup1_id}")).json()
    assert s1_stmt_after["totals"]["balance_due"] == 4000.0, (
        f"المتوقع 4000.00 ج.م لمورد 1 بعد السداد الجزئي، الفعلي: {s1_stmt_after['totals']['balance_due']}"
    )

    # رصيد الخزينة المساعد بعد السداد (20,000 - 6,000 = 14,000.00 ج.م)
    treasury_after_pay = await _get_treasury_balance(a["fm"])
    assert treasury_after_pay == Decimal("14000.00"), f"الخزينة يجب أن تكون 14000.00 ج.م بعد السداد، الفعلي: {treasury_after_pay}"

    # (ج2) تحصيل جزئي 10,000 ج.م من عميل 1 مع التخصيص (سند قبض يغذي دفتر النقدية المساعد)
    coll_res = await a["fm"].post(f"{API}/customers/{c1_id}/orders/{cust1_order_id}/payments", json={
        "amount": "10000.00",
        "method": "cash",
        "reference": f"RCP-{tag}",
        "notes": "تحصيل نقدي جزئي من مديونية عميل 1",
    })
    assert coll_res.status_code == 201, coll_res.text

    # كشف حساب عميل 1 بعد التحصيل: 5,000.00 ج.م
    c1_stmt_after = (await a["fm"].get(f"{API}/reports/customer-statement/{c1_id}")).json()
    assert c1_stmt_after["totals"]["balance_due"] == 5000.0, (
        f"المتوقع 5000.00 ج.م لعميل 1 بعد التحصيل، الفعلي: {c1_stmt_after['totals']['balance_due']}"
    )

    # رصيد الخزينة المساعد بعد التحصيل أصبح 24,000.00 ج.م (14,000 + 10,000)
    treasury_after_coll = await _get_treasury_balance(a["fm"])
    assert treasury_after_coll == Decimal("24000.00"), f"رصيد الخزينة بعد التحصيل يجب أن يكون 24,000.00 ج.م، الفعلي: {treasury_after_coll}"

    # عميل ثالث (C3) بطلب بيع حقيقي وتسليم بضاعة تامة
    c3_res = await a["fm"].post(f"{API}/customers", json={"code": f"C3_REAL_{tag}", "name": f"عميل حقيقي {tag}"})
    assert c3_res.status_code == 201, c3_res.text
    c3_id = c3_res.json()["id"]

    prod, v56, v60 = await _product_with_sizes(session)
    prod_id = prod.id
    v56_id = v56.id
    real_order_res = await a["gm"].post(f"{API}/customers/{c3_id}/orders", json={
        "order_type": "ready_goods",
        "notes": "طلب بيع حقيقي لعميل C3",
        "lines": [
            {"product_id": prod_id, "variant_id": v56_id, "quantity": 30, "unit_price": "200.00"},
        ],
    })
    assert real_order_res.status_code == 201, real_order_res.text
    real_order_id = real_order_res.json()["id"]

    # طلب C3 يظهر في Demand Pool
    demands_after_c3 = (await a["pm"].get(f"{API}/production/demand-pool")).json()
    assert any(d.get("customer_id") == c3_id for d in demands_after_c3), "طلب العميل C3 الحقيقي يجب أن يظهر في Demand Pool"

    # تسليم 10 قطع لعميل C3
    await _finished_stock(session, prod, v56, 30, cost="100")
    order_details = real_order_res.json()
    c3_line_id = order_details["lines"][0]["id"]
    c3_deliv = await a["wh"].post(f"{API}/customers/{c3_id}/orders/{real_order_id}/deliveries", json={
        "lines": [{"order_line_id": c3_line_id, "quantity": 10}],
        "received_by": "مندوب العميل 3",
        "notes": "تسليم حقيقي لعميل C3",
    })
    assert c3_deliv.status_code == 201, c3_deliv.text

    # مبيعات C3 في تقرير المبيعات التحليلي واستبعاد C1 وC2 الافتتاحيين
    sales_rep_after = (await a["fm"].get(f"{API}/reports/analytics/sales?date_from=2026-10-01&date_to=2026-11-30")).json()
    cust_sales_ids_after = [r["key"] for r in sales_rep_after.get("by_customer", [])]
    assert c3_id in cust_sales_ids_after, "العميل C3 الحقيقي يجب أن يولد مبيعات ويظهر في تقرير المبيعات"
    assert c1_id not in cust_sales_ids_after, "رصيد العميل الافتتاحي محظور في تقرير المبيعات"
    assert c2_id not in cust_sales_ids_after, "دفعة العميل الافتتاحية محظورة في تقرير المبيعات"

    # أمر تشغيل وصرف خاماته الافتتاحية (100 متر @ 25.0000 = 2500.00 ج.م)
    po_res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{
            "product_id": prod_id,
            "variant_id": v56_id,
            "target_quantity": 50,
            "season": "summer",
        }],
        "custom_materials": [
            {"item_id": item_factory_id, "unit_id": unit_id, "planned_quantity": 100.0},
        ],
        "notes": f"أمر تشغيل أول بعد يوم القطع {tag}",
    })
    assert po_res.status_code == 201, po_res.text
    po_id = po_res.json()["id"]

    dispatch_res = await a["wh"].post(f"{API}/production/orders/{po_id}/dispatch", json={"notes": "صرف خامات افتتاحية"})
    assert dispatch_res.status_code == 200, dispatch_res.text

    po_details = (await a["pm"].get(f"{API}/production/orders/{po_id}")).json()
    mat_line = po_details["materials"][0]
    assert Decimal(str(mat_line["unit_cost"])) == Decimal("25.0000"), (
        f"يجب تحميل أمر التشغيل بتكلفة الخامات الافتتاحية 25.0000 ج.م، المحسوب: {mat_line['unit_cost']}"
    )
    assert Decimal(str(mat_line["total_cost"])) == Decimal("2500.00"), (
        f"إجمالي تكلفة الخامات يجب أن تكون 2500.00 ج.م (100 متر × 25)، المحسوب: {mat_line['total_cost']}"
    )

    # ─────────────────────────────────────────────────────────────────────────
    # ٨. إعادة المطابقة بعد العمليات التشغيلية (Post-Operations Reconciliations)
    # ─────────────────────────────────────────────────────────────────────────
    tb_post_ops_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    assert tb_post_ops_res.status_code == 200, tb_post_ops_res.text
    tb_post = tb_post_ops_res.json()
    assert tb_post["totals"]["balanced"] is True, "ميزان المراجعة بعد العمليات يجب أن يكون متوازناً تماماً"

    # مطابقة ذمم الموردين (2100): مورد 1 (متبقي 4,000 دائن) + مورد 2 (-3,000 مدين) = صافي 1,000.00 دائن
    acc_2100 = next((r for r in tb_post["rows"] if r["code"] == "2100"), None)
    current_2100_cr = (
        Decimal(str(acc_2100["total_credit"])) - Decimal(str(acc_2100["total_debit"]))
        if acc_2100 else Decimal("0.00")
    )
    delta_2100 = current_2100_cr - initial_2100_cr
    assert delta_2100 == Decimal("1000.00"), f"أثر حركة الموردين على 2100 يجب أن يكون +1000.00، الفعلي: {delta_2100}"

    # مطابقة ذمم العملاء (1100): عميل 1 (متبقي 5,000 مدين) + عميل 2 (-4,000 دائن) + عميل 3 تسليم حقيقي (2,000 مدين) = صافي 3,000.00 مدين
    acc_1100 = next((r for r in tb_post["rows"] if r["code"] == "1100"), None)
    current_1100_dr = (
        Decimal(str(acc_1100["total_debit"])) - Decimal(str(acc_1100["total_credit"]))
        if acc_1100 else Decimal("0.00")
    )
    delta_1100 = current_1100_dr - initial_1100_dr
    c3_stmt = (await a["fm"].get(f"{API}/reports/customer-statement/{c3_id}")).json()
    assert c3_stmt["totals"]["balance_due"] == 2000.0, f"المتوقع 2000.00 لعميل C3 بعد التسليم، الفعلي: {c3_stmt['totals']['balance_due']}"
    sum_cust_stmts = (
        Decimal(str(c1_stmt_after["totals"]["balance_due"]))
        + Decimal(str(c2_stmt["totals"]["balance_due"]))
        + Decimal(str(c3_stmt["totals"]["balance_due"]))
    )
    assert sum_cust_stmts == Decimal("3000.00"), f"مجموع كشوف حسابات العملاء يجب أن يكون 3000.00، الفعلي: {sum_cust_stmts}"
    assert delta_1100 == sum_cust_stmts, (
        f"أثر حركة العملاء على 1100 ({delta_1100}) يجب أن يطابق مجموع كشوف حسابات العملاء ({sum_cust_stmts})"
    )

    # استقرار حساب 3900 عند 29,000.00 دائن تماماً دون مساس من العمليات اللاحقة
    acc_3900_post = next((r for r in tb_post["rows"] if r["code"] == "3900"), None)
    assert acc_3900_post is not None, "حساب 3900 يجب أن يظهر في ميزان المراجعة"
    net_3900_post_cr = Decimal(str(acc_3900_post["total_credit"])) - Decimal(str(acc_3900_post["total_debit"]))
    delta_3900_post_cr = net_3900_post_cr - initial_3900_cr
    assert delta_3900_post_cr == Decimal("29000.00"), (
        f"أثر حركة يوم القطع على 3900 يجب أن يستقر عند 29,000.00 دائن، الفعلي: {delta_3900_post_cr}"
    )

    # ─────────────────────────────────────────────────────────────────────────
    # ٩. التحقق من قفل الأرصدة الافتتاحية (409)
    # ─────────────────────────────────────────────────────────────────────────
    # 1. رفض فاتورة مورد افتتاحية بعد القفل
    lock_sup_try = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup1_id,
        "invoice_number": f"LOCKED-INV-{tag}",
        "invoice_date": "2026-11-01T00:00:00Z",
        "amount": "5000.00",
    })
    assert lock_sup_try.status_code == 409, "محاولة إنشاء فاتورة مورد افتتاحية بعد القفل يجب أن تعيد 409"

    # 2. رفض رصيد عميل افتتاحي بعد القفل
    lock_cust_try = await a["fm"].post(f"{API}/customers/{c1_id}/opening-balances", json={
        "original_order_number": f"LOCKED-ORD-{tag}",
        "order_date": "2026-11-01T00:00:00Z",
        "amount": "5000.00",
    })
    assert lock_cust_try.status_code == 409, "محاولة إنشاء رصيد عميل افتتاحي بعد القفل يجب أن تعيد 409"

    # 3. رفض جلسة جرد افتتاحي بعد القفل
    lock_st_try = await a["wh"].post(f"{API}/inventory/stocktakes", json={
        "warehouse_id": raw_wh.id,
        "is_opening": True,
        "description": "محاولة جرد بعد القفل",
    })
    assert lock_st_try.status_code == 409, "محاولة إنشاء جرد افتتاحي بعد القفل يجب أن تعيد 409"

    # 4. رفض قيد افتتاحي عام بعد القفل
    lock_ob_try = await a["fm"].post(f"{API}/finance/opening-balances", json={
        "accounting_start_date": cutover_date.isoformat(),
        "treasury_balance": "1000.00",
        "paid_in_capital": "1000.00",
    })
    assert lock_ob_try.status_code == 409, "محاولة إنشاء قيد افتتاحي عام بعد القفل يجب أن تعيد 409"

    # ─────────────────────────────────────────────────────────────────────────
    # ١٠. فحص حصانة دفاتر الأستاذ بالتريجرات (Append-Only Triggers)
    # ─────────────────────────────────────────────────────────────────────────
    # 1. محاولة تعديل بيانات جوهرية في journal_entries (تفشل بالتريجر trg_journal_entries_protect_core)
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_je_upd:
        await session.execute(
            sa.text("UPDATE journal_entries SET source_doc_type = 'tampered' WHERE id = :id"),
            {"id": je_ob_id},
        )
        await session.commit()
    await session.rollback()
    assert "لا يجوز تعديل البيانات الجوهرية لقيد اليومية" in str(exc_je_upd.value) or "journal_entries" in str(exc_je_upd.value)

    # 2. محاولة حذف قيد من journal_entries (تفشل بالتريجر)
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_je_del:
        await session.execute(
            sa.text("DELETE FROM journal_entries WHERE id = :id"),
            {"id": je_ob_id},
        )
        await session.commit()
    await session.rollback()
    assert "قيود اليومية غير قابلة للحذف نهائياً" in str(exc_je_del.value) or "append-only" in str(exc_je_del.value)

    # 3. محاولة تعديل أو حذف في stock_ledger_entries (تفشل بالتريجر trg_stock_ledger_entries_prevent_update_delete)
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_sle_upd:
        await session.execute(
            sa.text("UPDATE stock_ledger_entries SET quantity = 9999.0 WHERE id = :id"),
            {"id": cmt_stock_entry_id},
        )
        await session.commit()
    await session.rollback()
    assert "سجل حركات المخزون غير قابل للتعديل" in str(exc_sle_upd.value) or "append-only" in str(exc_sle_upd.value)

    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_sle_del:
        await session.execute(
            sa.text("DELETE FROM stock_ledger_entries WHERE id = :id"),
            {"id": cmt_stock_entry_id},
        )
        await session.commit()
    await session.rollback()
    assert "سجل حركات المخزون غير قابل للتعديل" in str(exc_sle_del.value) or "append-only" in str(exc_sle_del.value)

    # 4. محاولة تعديل أو حذف في accounting_locks (تفشل بالتريجر trg_accounting_locks_prevent_update_delete من Migration 0035)
    lock_record = await session.scalar(sa.select(AccountingLock).limit(1))
    assert lock_record is not None, "يجب وجود سجل قفل لاختبار حصانته بالتريجر"
    target_lock_id = str(lock_record.id)

    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_al_upd:
        await session.execute(
            sa.text("UPDATE accounting_locks SET reason = 'tampered' WHERE id = :id"),
            {"id": target_lock_id},
        )
        await session.commit()
    await session.rollback()
    assert "accounting_locks is append-only" in str(exc_al_upd.value) or "غير قابل للتعديل" in str(exc_al_upd.value)

    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_al_del:
        await session.execute(
            sa.text("DELETE FROM accounting_locks WHERE id = :id"),
            {"id": target_lock_id},
        )
        await session.commit()
    await session.rollback()
    assert "accounting_locks is append-only" in str(exc_al_del.value) or "غير قابل للحذف" in str(exc_al_del.value)

    # ─────────────────────────────────────────────────────────────────────────
    # ٩. دورة إعادة الفتح والاعتماد (Maker-Checker) وإدخال رصيد منسي وإعادة القفل
    # ─────────────────────────────────────────────────────────────────────────
    # 1. طلب الفتح من المدير المالي بسبب مكتوب إلزامي
    req_unlock = await a["fm"].post(f"{API}/finance/opening-balances/request-unlock", json={
        "reason": f"نسيان فاتورة مورد خامات افتتاحية رقم S3-{tag}",
    })
    assert req_unlock.status_code == 201, req_unlock.text
    assert req_unlock.json()["status"] == "pending_approval"

    # 2. التحقق من Maker-Checker: مقدم الطلب (fm) لا يستطيع اعتماده بنفسه (403)
    self_appr_unlock = await a["fm"].post(f"{API}/finance/opening-balances/approve-unlock", json={})
    assert self_appr_unlock.status_code == 403, "يجب منع مقدم طلب فتح القفل من اعتماده بنفسه (Maker-Checker)"

    # 3. اعتماد فتح القفل بواسطة المدير العام (gm)
    appr_unlock = await a["gm"].post(f"{API}/finance/opening-balances/approve-unlock", json={
        "approval_notes": "معتمد لتسجيل فاتورة المورد المنسية",
    })
    assert appr_unlock.status_code == 200, appr_unlock.text
    assert appr_unlock.json()["is_locked"] is False

    # محاولة ترحيل قيد افتتاحي عام ثانٍ أثناء فتح القفل بتاريخ مختلف (مرفوض 409 صراحة لوجود قيد عام مسبق)
    dup_unlocked_ob = await a["fm"].post(f"{API}/finance/opening-balances", json={
        "accounting_start_date": "2026-10-28",
        "treasury_balance": "1000.00",
        "bank_balance": "1000.00",
        "paid_in_capital": "2000.00",
        "notes": "محاولة قيد عام مكرر والقفل مفتوح",
    })
    assert dup_unlocked_ob.status_code == 409, "يجب رفض تكرار القيد الافتتاحي العام حتى بعد فتح القفل"
    assert "مسبقاً" in dup_unlocked_ob.text

    # 4. إدخال الرصيد المنسي: فاتورة مورد 3 بمبلغ 2,000 ج.م
    sup3_res = await a["wh"].post(f"{API}/finance/suppliers", json={"code": f"S3_{tag}", "name": f"مورد 3 {tag}"})
    assert sup3_res.status_code == 201, sup3_res.text
    sup3_id = sup3_res.json()["id"]

    inv3_res = await a["fm"].post(f"{API}/finance/supplier-invoices/opening", json={
        "supplier_id": sup3_id,
        "invoice_number": f"MISSED-INV3-{tag}",
        "invoice_date": "2026-10-25T00:00:00Z",
        "amount": "2000.00",
        "is_advance": False,
        "notes": "فاتورة مورد افتتاحية منسية",
    })
    assert inv3_res.status_code == 201, inv3_res.text
    inv3_id = inv3_res.json()["id"]
    await a["gm"].post(f"{API}/finance/supplier-invoices/{inv3_id}/approve-opening")

    # 5. إعادة القفل بواسطة المدير العام
    relock_res = await a["gm"].post(f"{API}/finance/opening-balances/lock", json={
        "reason": "إعادة القفل بعد اكتمال إدخال فاتورة المورد المنسية",
    })
    assert relock_res.status_code == 200, relock_res.text
    assert relock_res.json()["is_locked"] is True

    # 6. فحص سجل التدقيق التاريخي: يجب أن يحتوي الأسطر الأربعة كاملة دون مسح أي أثر
    final_lock_status = (await a["fm"].get(f"{API}/finance/opening-balances/lock-status")).json()
    assert final_lock_status["is_locked"] is True
    history = final_lock_status["history"]
    actions = [h["action"] for h in history]
    assert "locked" in actions
    assert "unlock_requested" in actions
    assert "unlocked" in actions
    assert len(history) >= 4, "سجل التدقيق يجب أن يحتفظ بكافة حركات القفل والفتح"

    # التحقق من أن سجل accounting_locks يحتوي أسطر (طلب الفتح، اعتماد الفتح، إعادة القفل) بالمستخدمين والأسباب
    req_row = next(h for h in history if h["action"] == "unlock_requested")
    assert req_row["performed_by"] == a["fm"].user.id
    assert "فاتورة مورد" in req_row["reason"]

    appr_row = next(h for h in history if h["action"] == "unlocked")
    assert appr_row["performed_by"] == a["gm"].user.id
    assert appr_row["requested_by"] == a["fm"].user.id

    relock_row = next(h for h in history if h["action"] == "locked" and "إعادة القفل" in (h.get("reason") or ""))
    assert relock_row["performed_by"] == a["gm"].user.id

    # التحقق من أن فاتورة المورد المنسية أضيفت لكشف حسابه
    s3_stmt = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup3_id}")).json()
    assert s3_stmt["totals"]["balance_due"] == 2000.0, f"المتوقع 2000.00 لمورد 3، الفعلي: {s3_stmt['totals']['balance_due']}"

    # إعادة التحقق بعد إضافة الفاتورة المنسية:
    # 1. أثر حساب 3900: كان 29,000 دائن، زاد مديناً بـ 2,000 لفاتورة مورد 3، فأصبح صافيه 27,000.00 دائن
    tb_post_relock = (await a["fm"].get(f"{API}/finance/gl/trial-balance")).json()
    acc_3900_relock = next((r for r in tb_post_relock["rows"] if r["code"] == "3900"), None)
    net_3900_relock_cr = Decimal(str(acc_3900_relock["total_credit"])) - Decimal(str(acc_3900_relock["total_debit"]))
    assert net_3900_relock_cr - initial_3900_cr == Decimal("27000.00"), (
        f"أثر 3900 بعد إدخال الفاتورة المنسية يجب أن يكون 27,000.00 دائن، الفعلي: {net_3900_relock_cr - initial_3900_cr}"
    )

    # 2. مطابقة 2100 مع مجموع كشوف الموردين:
    # مورد 1 (4,000 دائن) + مورد 2 (-3,000 مدين) + مورد 3 (2,000 دائن) = صافي 3,000.00 دائن
    s1_stmt_re = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup1_id}")).json()
    s2_stmt_re = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup2_id}")).json()
    sum_sup_stmts = (
        Decimal(str(s1_stmt_re["totals"]["balance_due"]))
        + Decimal(str(s2_stmt_re["totals"]["balance_due"]))
        + Decimal(str(s3_stmt["totals"]["balance_due"]))
    )
    assert sum_sup_stmts == Decimal("3000.00"), f"مجموع كشوف الموردين يجب أن يكون 3000.00، الفعلي: {sum_sup_stmts}"

    acc_2100_relock = next((r for r in tb_post_relock["rows"] if r["code"] == "2100"), None)
    net_2100_relock_cr = Decimal(str(acc_2100_relock["total_credit"])) - Decimal(str(acc_2100_relock["total_debit"]))
    delta_2100_relock = net_2100_relock_cr - initial_2100_cr
    assert delta_2100_relock == sum_sup_stmts, (
        f"رصيد 2100 في الأستاذ العام ({delta_2100_relock}) يجب أن يطابق مجموع كشوف حسابات الموردين ({sum_sup_stmts})"
    )

    # 3. ثابت مطابقة في نهاية السيناريو: رصيد دفتر النقدية لكل حساب = رصيد حسابه في الأستاذ العام (1010 و 1030)
    acc_1010_relock = next((r for r in tb_post_relock["rows"] if r["code"] == "1010"), None)
    assert acc_1010_relock is not None, "حساب 1010 يجب أن يظهر في ميزان المراجعة"
    gl_1010_bal = Decimal(str(acc_1010_relock["total_debit"])) - Decimal(str(acc_1010_relock["total_credit"]))
    cash_ledger_1010 = await _get_treasury_balance(a["fm"])
    assert cash_ledger_1010 == gl_1010_bal, (
        f"رصيد دفتر الخزينة المساعد ({cash_ledger_1010}) يجب أن يطابق تماماً رصيد حساب 1010 في الأستاذ العام ({gl_1010_bal})"
    )

    acc_1030_relock = next((r for r in tb_post_relock["rows"] if r["code"] == "1030"), None)
    assert acc_1030_relock is not None, "حساب 1030 يجب أن يظهر في ميزان المراجعة"
    gl_1030_bal = Decimal(str(acc_1030_relock["total_debit"])) - Decimal(str(acc_1030_relock["total_credit"]))
    bank_cash_bal = await session.scalar(
        sa.select(sa.func.coalesce(sa.func.sum(CashLedgerEntry.amount), 0)).where(
            CashLedgerEntry.account_id == CANONICAL_BANK_ID
        )
    )
    assert Decimal(str(bank_cash_bal)) == gl_1030_bal, (
        f"رصيد دفتر البنك المساعد ({bank_cash_bal}) يجب أن يطابق تماماً رصيد حساب 1030 في الأستاذ العام ({gl_1030_bal})"
    )

@pytest.mark.asyncio
async def test_auto_lock_on_first_dispatch_if_unset(ctx):
    """التحقق من أن أول صرف خامات لأمر تشغيل يقفل الأرصدة الافتتاحية تلقائياً إن لم تكن مقفلة."""
    session, a = ctx
    tag = _tag()
    unit = await _unit(session, "meter")
    unit_id = unit.id
    wh = await _warehouse(session, "main_raw_materials")
    wh_id = wh.id
    item = await _approved_item(session, f"DISP_FAB_{tag}", unit)
    item_id = item.id
    prod, v56, v60 = await _product_with_sizes(session)
    prod_id = prod.id
    v56_id = v56.id

    # التأكد من أن الأرصدة الافتتاحية غير مقفلة حالياً (فتح القفل نظامياً عبر Maker-Checker إن كان مقفلاً)
    status_before = (await a["fm"].get(f"{API}/finance/opening-balances/lock-status")).json()
    if status_before["is_locked"]:
        req = await a["fm"].post(f"{API}/finance/opening-balances/request-unlock", json={"reason": f"فتح لاختبار القفل التلقائي {tag}"})
        assert req.status_code == 201
        appr = await a["gm"].post(f"{API}/finance/opening-balances/approve-unlock", json={"approval_notes": "معتمد للاختبار"})
        assert appr.status_code == 200
        status_before = (await a["fm"].get(f"{API}/finance/opening-balances/lock-status")).json()
    assert status_before["is_locked"] is False

    # رصيد أولي للخامة في المخزن
    sle = StockLedgerEntry(
        id=str(uuid.uuid4()),
        item_id=item_id,
        unit_id=unit_id,
        warehouse_id=wh_id,
        location_type="warehouse",
        quantity=500.0,
        reference_doc_type="test_receipt",
        reference_doc_id=str(uuid.uuid4()),
        entry_type="deposit",
        created_by="test-admin",
        unit_cost=Decimal("20.0000"),
        total_cost=Decimal("10000.00"),
    )
    session.add(sle)
    await session.commit()

    # التأكد من استمرار حالة عدم القفل
    assert status_before["is_locked"] is False

    # إنشاء أمر تشغيل وصرف خاماته
    po_res = await a["pm"].post(f"{API}/production/orders", json={
        "items": [{
            "product_id": prod_id,
            "variant_id": v56_id,
            "target_quantity": 10,
            "season": "summer",
        }],
        "custom_materials": [
            {"item_id": item_id, "unit_id": unit_id, "planned_quantity": 50.0},
        ],
        "notes": f"أمر اختبار القفل التلقائي {tag}",
    })
    assert po_res.status_code == 201, po_res.text
    po_id = po_res.json()["id"]

    # صرف الخامات
    disp_res = await a["wh"].post(f"{API}/production/orders/{po_id}/dispatch", json={"notes": "صرف خامات"})
    assert disp_res.status_code == 200, disp_res.text

    # التحقق من أن حالة الأرصدة الافتتاحية أصبحت مقفلة تلقائياً
    status_after = (await a["fm"].get(f"{API}/finance/opening-balances/lock-status")).json()
    assert status_after["is_locked"] is True, "يجب قفل الأرصدة الافتتاحية تلقائياً عند أول صرف خامات"
    assert "صرف خامات" in status_after["latest_reason"]


@pytest.mark.asyncio
async def test_advance_supplier_payment_lifecycle(ctx):
    """
    اختبار دورة حياة الدفعة المقدمة للمورد قبل الاستلام وبعده (PUR-DEC-02 و FIN-DEC-01):
    1. إنشاء فاتورة مورد عادية بمبلغ 10,000 ج.م بانتظار الاستلام.
    2. المدير المالي يُنشئ دفعة مقدمة بمبلغ 8,000 ج.م:
       - ترحيل واعتماد فوري (FIN-DEC-01).
       - الحقل المهيكل is_prepayment == True وقيمة المستلم == 0.00 وإجمالي الفاتورة == 10,000.00.
    3. محاولة سداد دفعة ثانية بـ 3,000 ج.م تتجاوز إجمالي الفاتورة (8,000 + 3,000 = 11,000 > 10,000):
       - ترفض برمز 409 Conflict.
    4. مطابقة كشف حساب المورد (-8,000.00 مدين للمصنع) مع حساب 2100 في الأستاذ العام (مدين 8,000.00).
    5. أمين المخزن يؤكد استلام كامل بضاعة الفاتورة (10,000.00 ج.م).
    6. الاستعلام عن سند الصرف عبر GET /finance/cash-documents:
       - تحول is_prepayment إلى False تلقائياً لأن المستلم أصبح يغطي المدفوع.
       - قيمة received_value أصبحت 10,000.00 ج.م.
    7. استقرار كشف حساب المورد عند 2,000.00 دائن ومطابقته التامة مع صافي حساب 2100.
    """
    session, a = ctx
    tag = _tag()

    # التأكد من كفاية رصيد الخزينة الرئيسية للصرف
    tr_bal = await _get_treasury_balance(a["fm"])
    if tr_bal < Decimal("20000.00"):
        fund_res = await a["fm"].post(f"{API}/finance/cash-documents", json={
            "document_type": "income",
            "to_account_id": CANONICAL_TREASURY_ID,
            "amount": "50000.00",
            "description": f"تمويل تجريبي للخزينة لاختبار الدفع المقدم {tag}",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        })
        assert fund_res.status_code == 201, fund_res.text

    # قراءة رصيد 2100 المبدئي في الأستاذ العام لحساب الفارق الصافي
    tb_init = (await a["fm"].get(f"{API}/finance/gl/trial-balance")).json()
    acc_2100_init = next((r for r in tb_init["rows"] if r["code"] == "2100"), None)
    initial_2100_cr = (
        Decimal(str(acc_2100_init["total_credit"])) - Decimal(str(acc_2100_init["total_debit"]))
        if acc_2100_init else Decimal("0.00")
    )

    # 1. إنشاء مورد وخامة معتمدة
    sup_res = await a["wh"].post(f"{API}/finance/suppliers", json={
        "code": f"SUP_ADV_{tag}",
        "name": f"مورد دفعة مقدمة {tag}",
    })
    assert sup_res.status_code == 201, sup_res.text
    sup_id = sup_res.json()["id"]

    unit = await _unit(session, "meter")
    item = await _approved_item(session, f"ITEM_ADV_{tag}", unit)

    # 2. إنشاء فاتورة مورد عادية بقيمة 10,000 ج.م (100 متر × 100 ج.م) بواسطة المدير المالي لرؤية الأسعار
    inv_res = await a["fm"].post(f"{API}/finance/supplier-invoices", json={
        "supplier_id": sup_id,
        "invoice_number": f"INV-ADV-{tag}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "notes": "فاتورة بانتظار الاستلام لاختبار السداد المقدم",
        "lines": [{
            "item_id": item.id,
            "unit_id": unit.id,
            "invoiced_quantity": 100.0,
            "unit_price": "100.00",
            "discount_amount": "0.00",
            "notes": "100 متر قماش بسعر 100 ج.م",
        }],
    })
    assert inv_res.status_code == 201, inv_res.text
    inv_data = inv_res.json()
    inv_id = inv_data["id"]
    line_id = inv_data["lines"][0]["id"]
    assert inv_data["status"] == "awaiting_receipt"
    assert Decimal(str(inv_data["invoice_total"])) == Decimal("10000.00")

    # كشف حساب المورد قبل أي سداد أو استلام = 0
    stmt_init = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup_id}")).json()
    assert Decimal(str(stmt_init["totals"]["balance_due"])) == Decimal("0.00")

    # 3. سداد دفعة مقدمة بمبلغ 8,000 ج.م بواسطة المدير المالي
    pay_res = await a["fm"].post(f"{API}/finance/supplier-invoices/{inv_id}/payments", json={
        "amount": "8000.00",
        "description": f"سداد دفعة مقدمة قبل الاستلام {tag}",
    })
    assert pay_res.status_code == 201, pay_res.text
    pay_doc = pay_res.json()
    pay_doc_id = pay_doc["id"]

    # فحص الترحيل الفوري بقرار FIN-DEC-01 والحقول المهيكلة للدفعة المقدمة
    assert pay_doc["status"] == "approved", "مستند سداد المدير المالي يجب أن يُرحل ويُعتمد فوراً (FIN-DEC-01)"
    assert pay_doc["approved_by"] == a["fm"].user.id
    assert pay_doc["is_prepayment"] is True, "يجب تحديد is_prepayment = True لأن المسدد يتجاوز المستلم الفعلي (0)"
    assert Decimal(str(pay_doc["invoice_total"])) == Decimal("10000.00")
    assert Decimal(str(pay_doc["received_value"])) == Decimal("0.00")

    # 4. محاولة سداد دفعة ثانية بـ 3,000 ج.م (8000 + 3000 = 11000 > 10000)
    overpay_res = await a["fm"].post(f"{API}/finance/supplier-invoices/{inv_id}/payments", json={
        "amount": "3000.00",
        "description": "دفعة تتجاوز إجمالي الفاتورة",
    })
    assert overpay_res.status_code == 409, "يجب رفض الدفعة برمز 409 لتجاوزها الحد الأقصى المتاح للفاتورة"
    assert "تتجاوز المستحق الفعلي" in overpay_res.text

    # 5. مطابقة كشف الحساب والأستاذ العام 2100 بعد سداد الدفعة المقدمة
    stmt_step1 = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup_id}")).json()
    assert Decimal(str(stmt_step1["totals"]["balance_due"])) == Decimal("-8000.00"), (
        f"رصيد المورد في كشف الحساب يجب أن يكون -8000.00 (مدين للمصنع)، الفعلي: {stmt_step1['totals']['balance_due']}"
    )

    tb_step1 = (await a["fm"].get(f"{API}/finance/gl/trial-balance")).json()
    acc_2100_step1 = next((r for r in tb_step1["rows"] if r["code"] == "2100"), None)
    net_2100_step1_cr = (
        Decimal(str(acc_2100_step1["total_credit"])) - Decimal(str(acc_2100_step1["total_debit"]))
        if acc_2100_step1 else Decimal("0.00")
    )
    delta_2100_step1 = net_2100_step1_cr - initial_2100_cr
    assert delta_2100_step1 == Decimal("-8000.00"), (
        f"الأثر الصافي على 2100 يجب أن يكون -8000.00 (مدين)، الفعلي: {delta_2100_step1}"
    )
    assert delta_2100_step1 == Decimal(str(stmt_step1["totals"]["balance_due"])), (
        "رصيد 2100 في الأستاذ العام يجب أن يطابق تماماً كشف حساب المورد بعد السداد المقدم"
    )

    # 6. أمين المخزن يؤكد استلام البضاعة بالكامل (100 متر = 10,000 ج.م)
    rcv_res = await a["wh"].post(f"{API}/finance/supplier-invoices/{inv_id}/receive", json={
        "lines": [{
            "line_id": line_id,
            "received_quantity": 100.0,
            "notes": "استلام كامل الكمية 100 متر",
        }],
        "notes": f"إذن استلام بضاعة {tag}",
    })
    assert rcv_res.status_code == 200, rcv_res.text
    rcv_data = rcv_res.json()
    assert rcv_data["status"] == "received"

    # 7. الاستعلام عن سندات الصرف والتأكد من تحديث حالة الدفعة المقدمة عند القراءة
    cash_docs_res = await a["fm"].get(f"{API}/finance/cash-documents")
    assert cash_docs_res.status_code == 200, cash_docs_res.text
    target_doc = next(d for d in cash_docs_res.json() if d["id"] == pay_doc_id)
    assert target_doc["is_prepayment"] is False, (
        "يجب أن تصبح is_prepayment = False بعد استلام بضاعة تغطي قيمة الدفعة المسددة"
    )
    assert Decimal(str(target_doc["received_value"])) == Decimal("10000.00"), (
        f"قيمة المستلم الفعلي يجب أن تكون 10000.00، الفعلي: {target_doc['received_value']}"
    )
    assert Decimal(str(target_doc["invoice_total"])) == Decimal("10000.00")

    # 8. استقرار كشف حساب المورد عند 2,000.00 دائن ومطابقته للأستاذ العام 2100
    stmt_step2 = (await a["fm"].get(f"{API}/reports/supplier-statement/{sup_id}")).json()
    assert Decimal(str(stmt_step2["totals"]["balance_due"])) == Decimal("2000.00"), (
        f"رصيد المورد بعد الاستلام يجب أن يصبح 2000.00 دائن (10000 استلام - 8000 سداد)، الفعلي: {stmt_step2['totals']['balance_due']}"
    )

    tb_step2 = (await a["fm"].get(f"{API}/finance/gl/trial-balance")).json()
    acc_2100_step2 = next((r for r in tb_step2["rows"] if r["code"] == "2100"), None)
    net_2100_step2_cr = (
        Decimal(str(acc_2100_step2["total_credit"])) - Decimal(str(acc_2100_step2["total_debit"]))
        if acc_2100_step2 else Decimal("0.00")
    )
    delta_2100_step2 = net_2100_step2_cr - initial_2100_cr
    assert delta_2100_step2 == Decimal("2000.00"), (
        f"الأثر الصافي على 2100 بعد الاستلام يجب أن يكون +2000.00 دائن، الفعلي: {delta_2100_step2}"
    )
    assert delta_2100_step2 == Decimal(str(stmt_step2["totals"]["balance_due"])), (
        "رصيد 2100 في الأستاذ العام يجب أن يطابق تماماً كشف حساب المورد بعد استلام البضاعة"
    )


@pytest.mark.asyncio
async def test_migration_0035_accounting_locks_immutability(ctx):
    """
    التحقق الصريح والمستقل من Migration 0035:
    تريجر trg_accounting_locks_prevent_update_delete يمنع UPDATE و DELETE منعاً باتاً على accounting_locks.
    """
    session, _ = ctx
    tag = _tag()
    lock = AccountingLock(
        lock_type="opening_balances",
        is_locked=True,
        action="locked",
        performed_by=f"user_{tag}",
        reason=f"اختبار حصانة التريجر {tag}",
    )
    session.add(lock)
    await session.commit()
    await session.refresh(lock)
    lock_id = str(lock.id)

    # محاولة UPDATE تفشل بالـ trigger
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_upd:
        await session.execute(
            sa.text("UPDATE accounting_locks SET reason = 'tampered' WHERE id = :id"),
            {"id": lock_id},
        )
        await session.commit()
    await session.rollback()
    assert "accounting_locks is append-only" in str(exc_upd.value) or "غير قابل للتعديل" in str(exc_upd.value)

    # محاولة DELETE تفشل بالـ trigger
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_del:
        await session.execute(
            sa.text("DELETE FROM accounting_locks WHERE id = :id"),
            {"id": lock_id},
        )
        await session.commit()
    await session.rollback()
    assert "accounting_locks is append-only" in str(exc_del.value) or "غير قابل للحذف" in str(exc_del.value)

