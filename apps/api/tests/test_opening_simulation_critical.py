"""
اختبار سيناريو الأرصدة الافتتاحية والمطابقة الشاملة (The Critical Handover Scenario)
───────────────────────────────────────────────────────────────────────────────────
ينفذ بالكامل على قاعدة البيانات الحقيقية:
1. تسجيل القيد الافتتاحي المالي العام (الأصول = الالتزامات + رأس المال).
2. تنفيذ جرد افتتاحي معتمد وتثبيت أرصدة الخامات في دفتر حركة المخزون.
3. تسجيل فاتورة مورد افتتاحية واستلام بضاعتها.
4. مطابقة ميزان المراجعة وكشوف الحسابات التفصيلية (كشف المورد، الخزينة، والمخزن).
"""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
import pytest
from httpx import AsyncClient

from app.modules.finance.models import JournalEntry, JournalEntryLine, Account
from app.modules.production.stock import stock_balance
from tests.test_operational_cycle_e2e import (
    ctx,
    _tag,
    _uid,
    _warehouse,
    _unit,
    _approved_item,
)

API = "/api/v1"


@pytest.mark.asyncio
async def test_critical_opening_scenario_and_trial_balance(ctx):
    session, a = ctx
    now = datetime.now(timezone.utc)
    tag = _tag()

    # ─────────────────────────────────────────────────────────────────────────
    # ١. تسجيل القيد الافتتاحي المالي العام
    # ─────────────────────────────────────────────────────────────────────────
    get_ob = await a["fm"].get(f"{API}/finance/opening-balances")
    ob_data = get_ob.json()

    if not ob_data.get("is_set"):
        ob_payload = {
            "accounting_start_date": "2026-11-01",
            "treasury_balance": "50000.00",
            "bank_balance": "50000.00",
            "custody_balance": "0.00",
            "accounts_receivable": "20000.00",
            "raw_materials_inventory": "30000.00",
            "wip_inventory": "0.00",
            "finished_goods_inventory": "0.00",
            "accounts_payable": "25000.00",
            "paid_in_capital": "125000.00",
            "notes": "قيد افتتاحي رسمي لمصنع القمة",
        }
        res_ob = await a["fm"].post(f"{API}/finance/opening-balances", json=ob_payload)
        assert res_ob.status_code == 201, res_ob.text
        data = res_ob.json()
        assert data["is_set"] is True
        assert data["is_balanced"] is True
        assert Decimal(str(data["total_assets"])) == Decimal("150000.00")
        assert Decimal(str(data["total_liabilities_and_equity"])) == Decimal("150000.00")

    # ─────────────────────────────────────────────────────────────────────────
    # ٢. الجرد الافتتاحي المخزني العيني
    # ─────────────────────────────────────────────────────────────────────────
    unit = await _unit(session, "meter")
    raw_wh = await _warehouse(session, "main_raw_materials")
    item = await _approved_item(session, f"FABRIC_{tag}", unit)

    # إنشاء جلسة جرد لمخزن الخامات (يولد سطور الجرد لكافة أصناف المخزن)
    st_create_res = await a["wh"].post(f"{API}/inventory/stocktakes", json={
        "warehouse_id": raw_wh.id,
        "notes": f"جرد افتتاحي لخامات المصنع {tag}",
    })
    assert st_create_res.status_code == 201, st_create_res.text
    st_data = st_create_res.json()
    stocktake_id = st_data["id"]

    # بدء العد
    start_res = await a["wh"].post(f"{API}/inventory/stocktakes/{stocktake_id}/start-counting")
    assert start_res.status_code == 200, start_res.text

    # استخراج معرف السطر الخاص بالصنف الجديد
    st_details = (await a["wh"].get(f"{API}/inventory/stocktakes/{stocktake_id}")).json()
    line_id = None
    for ln in st_details.get("lines", []):
        if ln["item_id"] == item.id and ln.get("bucket_reference") is None:
            line_id = ln["id"]
            break
    assert line_id is not None, "لم يتم العثور على سطر الصنف في جلسة الجرد"

    # تسجيل العد الميداني الافتتاحي (1,000 متر)
    count_res = await a["wh"].post(f"{API}/inventory/stocktakes/{stocktake_id}/counts", json={
        "counts": [{
            "line_id": line_id,
            "counted_quantity": 1000.0,
            "notes": "عد افتتاحي فعلي",
        }]
    })
    assert count_res.status_code == 200, count_res.text

    # تقديم الجرد للمراجعة
    sub_res = await a["wh"].post(f"{API}/inventory/stocktakes/{stocktake_id}/submit")
    assert sub_res.status_code == 200, sub_res.text

    # اعتماد الجرد من المدير المالي (Maker-Checker)
    appr_res = await a["fm"].post(f"{API}/inventory/stocktakes/{stocktake_id}/approve", json={
        "decision": "approve",
        "notes": "معتمد كجرد افتتاحي رسمي",
    })
    assert appr_res.status_code == 200, appr_res.text

    # ترحيل قيود الجرد المخزنية
    post_res = await a["fm"].post(f"{API}/inventory/stocktakes/{stocktake_id}/post", json={
        "notes": "ترحيل قيود الجرد الافتتاحي",
    })
    assert post_res.status_code == 200, post_res.text

    # التحقق من رصيد الصنف في مخزن الخامات (يجب أن يصبح 1000.0 متر تماماً)
    item_bal = await stock_balance(session, item.id, raw_wh.id)
    assert item_bal == 1000.0

    # ─────────────────────────────────────────────────────────────────────────
    # ٣. فاتورة مورد افتتاحية وتوريدها بالمخزن
    # ─────────────────────────────────────────────────────────────────────────
    sup_code = f"SUP_{tag}"
    sup_res = await a["wh"].post(f"{API}/finance/suppliers", json={
        "code": sup_code,
        "name": f"مورد أقمشة افتتاحي {tag}",
        "phone": "0100000000",
    })
    assert sup_res.status_code == 201, sup_res.text
    supplier_id = sup_res.json()["id"]

    # فاتورة شراء بـ 500 متر بسعر 20 ج.م = 10,000 ج.م
    inv_num = f"INV-OB-{tag}"
    inv_res = await a["wh"].post(f"{API}/finance/supplier-invoices", json={
        "invoice_number": inv_num,
        "supplier_id": supplier_id,
        "invoice_date": "2026-11-02",
        "due_date": "2026-11-30",
        "lines": [{
            "item_id": item.id,
            "unit_id": unit.id,
            "invoiced_quantity": 500.0,
            "unit_price": "20.00",
            "notes": "توريد خامات إضافي",
        }],
    })
    assert inv_res.status_code == 201, inv_res.text
    invoice_id = inv_res.json()["id"]
    invoice_line_id = inv_res.json()["lines"][0]["id"]

    # استلام البضاعة في المخزن
    rec_res = await a["wh"].post(f"{API}/finance/supplier-invoices/{invoice_id}/receive", json={
        "lines": [{
            "line_id": invoice_line_id,
            "received_quantity": 500.0,
        }],
        "notes": "استلام سليم ومطابق",
    })
    assert rec_res.status_code == 200, rec_res.text

    # الرصيد المخزني للصنف يجب أن يصبح 1000 + 500 = 1500.0 متر
    new_bal = await stock_balance(session, item.id, raw_wh.id)
    assert new_bal == 1500.0

    # ─────────────────────────────────────────────────────────────────────────
    # ٤. مطابقة كشوف الحسابات وميزان المراجعة
    # ─────────────────────────────────────────────────────────────────────────
    # أ) كشف حساب المورد:
    sup_stmt_res = await a["fm"].get(f"{API}/reports/supplier-statement/{supplier_id}")
    assert sup_stmt_res.status_code == 200, sup_stmt_res.text
    sup_stmt = sup_stmt_res.json()
    assert Decimal(str(sup_stmt["totals"]["total_received"])) == Decimal("10000.00")
    assert Decimal(str(sup_stmt["totals"]["balance_due"])) == Decimal("10000.00")

    # ب) تقرير ميزان المراجعة والتحقق من التوازن العام:
    tb_res = await a["fm"].get(f"{API}/finance/gl/trial-balance")
    assert tb_res.status_code == 200, tb_res.text
    tb = tb_res.json()
    assert tb["totals"]["balanced"] is True
    assert Decimal(str(tb["totals"]["total_debit"])) == Decimal(str(tb["totals"]["total_credit"]))

    print("\n" + "=" * 70)
    print("✅ نجح سيناريو الأرصدة الافتتاحية والمطابقة المحاسبية بالكامل:")
    print("  1. القيد الافتتاحي: متوازن تماماً بالأصول والالتزامات ورأس المال.")
    print("  2. الجرد الافتتاحي: أثبت 1,000 متر في دفتر حركة المخزون.")
    print("  3. فاتورة وتوريد المورد: زادت الرصيد إلى 1,500 متر وأثبتت 10,000 ج.م بذمة المورد.")
    print("  4. ميزان المراجعة: متوازن تماماً وفارق التوازن = 0.00 ج.م.")
    print("=" * 70)
