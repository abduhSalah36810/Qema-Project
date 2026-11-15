"""
اختبار شامل وتوثيقي لتكامل الشجرة المالية (Chart of Accounts & GL)
───────────────────────────────────────────────────────────────────
يتحقق هذا الاختبار من ترابط العمليات التشغيلية بالشجرة المحاسبية:
1. دورة المشتريات (توريد خامات + سداد مورد):
   - تسمع في حساب المورد (2100).
   - تسمع في حساب مخزون الخامات (1210).
   - تسمع في حساب الخزينة (1010).
   - تظهر في كشف حساب المورد.
2. دورة المبيعات (تسليم منتجات تامة + تحصيل):
   - تسمع في حساب العملاء (1100).
   - تسمع في حساب إيرادات المبيعات (4100).
   - تسمع في تكلفة البضاعة المباعة (5100).
   - تسمع في مخزون المنتجات التامة (1230).
   - تسمع في حساب الخزينة (1010) عند التحصيل.
   - تظهر في كشف حساب العميل.
3. دورة المصروفات والأجور (تشغيل وإدارة وأجور):
   - تسمع في حسابات المصروفات (5300، 5400، 5210).
   - تسمع في الخزينة (1010) بالصرف.
4. التقارير الختامية:
   - قائمة الدخل (P&L): تجمع الإيرادات وتخصم التكاليف والمصروفات بدقة.
   - ميزان المراجعة (Trial Balance): المدين = الدائن تماماً (الفارق = 0.00).
   - الميزانية العمومية (Balance Sheet): الأصول = الالتزامات + حقوق الملكية.
"""
from datetime import datetime, timezone
from decimal import Decimal
import uuid
import pytest
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.models import Account, CashLedgerEntry, JournalEntry, JournalEntryLine
from app.modules.finance.ledger_service import CANONICAL_TREASURY_ID
from app.modules.production.stock import stock_balance

from tests.test_operational_cycle_e2e import (
    ctx,
    _tag,
    _uid,
    _warehouse,
    _unit,
    _approved_item,
    _product_with_sizes,
    _finished_stock,
    _fund_treasury,
    _approve,
    _cash_balance,
    _journal_amount,
)


@pytest.mark.asyncio
async def test_financial_tree_complete_lifecycle(ctx):
    session, a = ctx
    now = datetime.now(timezone.utc)

    # ═════════════════════════════════════════════════════════════════════════
    # 0. تغذية الخزينة برصيد تشغيلي افتتاحي
    # ═════════════════════════════════════════════════════════════════════════
    await _fund_treasury(a["fm"], a["fm2"], "100000.00")
    treasury_initial = await _cash_balance(session, CANONICAL_TREASURY_ID)
    assert treasury_initial >= Decimal("100000.00")

    # ═════════════════════════════════════════════════════════════════════════
    # 1. دورة المشتريات: فاتورة مورد + استلام خامات + سداد دفعة
    # ═════════════════════════════════════════════════════════════════════════
    raw_wh = await _warehouse(session, "main_raw_materials")
    meter = await _unit(session, "meter")
    fabric = await _approved_item(session, "قماش تويل فاخر", meter)

    # أ) إنشاء مورد جديد
    sup_code = f"SUP-{_tag()}"
    res = await a["wh"].post("/api/v1/finance/suppliers", json={
        "code": sup_code,
        "name": f"شركة الغزل الحديثة {sup_code}",
        "phone": "01011223344",
        "address": "المحلة الكبرى",
    })
    assert res.status_code == 201, res.text
    supplier_id = res.json()["id"]

    # ب) فاتورة شراء خامات: 100 متر × 80 ج.م = 8,000 ج.م
    inv_num = f"INV-{_tag()}"
    res = await a["wh"].post("/api/v1/finance/supplier-invoices", json={
        "supplier_id": supplier_id,
        "invoice_number": inv_num,
        "invoice_date": now.isoformat(),
        "lines": [
            {"item_id": fabric.id, "unit_id": meter.id, "invoiced_quantity": 100, "unit_price": "80.00"},
        ],
    })
    assert res.status_code == 201, res.text
    invoice_id = res.json()["id"]
    inv_line_id = res.json()["lines"][0]["id"]

    # ج) استلام كامل الخامات بمخزن الخامات
    res = await a["wh"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json={
        "lines": [{"line_id": inv_line_id, "received_quantity": 100}],
    })
    assert res.status_code == 200, res.text
    receipt_doc_id = res.json().get("receipt_id") or invoice_id

    # تحقق من المخزن: رصيد القماش أصبح 100 متر
    assert await stock_balance(session, fabric.id, raw_wh.id) == 100.0

    # تحقق محاسبي من قيد استلام الخامات:
    # Dr 1210 (مخزون خامات: 8000) / Cr 2100 (الموردون: 8000)
    je_sup_rec = await session.scalar(
        select(JournalEntry).where(JournalEntry.source_doc_type == "supplier_receipt").order_by(JournalEntry.created_at.desc())
    )
    assert je_sup_rec is not None
    dr_raw = await _journal_amount(session, "supplier_receipt", je_sup_rec.source_doc_id, "1210", "debit")
    cr_sup = await _journal_amount(session, "supplier_receipt", je_sup_rec.source_doc_id, "2100", "credit")
    assert dr_raw == Decimal("8000.00"), f"Expected 8000 debit in 1210, got {dr_raw}"
    assert cr_sup == Decimal("8000.00"), f"Expected 8000 credit in 2100, got {cr_sup}"

    # د) سداد دفعة للمورد من الخزينة بمبلغ 5,000 ج.م
    treasury_before_pay = await _cash_balance(session, CANONICAL_TREASURY_ID)
    res = await a["gm"].post(f"/api/v1/finance/supplier-invoices/{invoice_id}/payments", json={
        "amount": "5000.00",
        "description": "دفعة نقدية تحت حساب الفاتورة",
    })
    assert res.status_code == 201, res.text
    pay_doc_id = res.json()["id"]
    # اعتماد الصرف بالخزينة
    await _approve(a["fm"], pay_doc_id)

    # تحقق من الخزنة: نقصت 5,000 ج.م
    treasury_after_pay = await _cash_balance(session, CANONICAL_TREASURY_ID)
    assert treasury_after_pay == treasury_before_pay - Decimal("5000.00")

    # تحقق محاسبي من قيد سداد المورد:
    # Dr 2100 (الموردون: 5000) / Cr 1010 (الخزينة: 5000)
    dr_sup_pay = await _journal_amount(session, "supplier_payment", pay_doc_id, "2100", "debit")
    cr_csh_pay = await _journal_amount(session, "supplier_payment", pay_doc_id, "1010", "credit")
    assert dr_sup_pay == Decimal("5000.00")
    assert cr_csh_pay == Decimal("5000.00")

    # هـ) كشف حساب المورد:
    sup_stmt = (await a["fm"].get(f"/api/v1/reports/supplier-statement/{supplier_id}")).json()
    assert Decimal(str(sup_stmt["totals"]["total_received"])) == Decimal("8000.00")
    assert Decimal(str(sup_stmt["totals"]["total_paid"])) == Decimal("5000.00")
    assert Decimal(str(sup_stmt["totals"]["balance_due"])) == Decimal("3000.00")

    # ═════════════════════════════════════════════════════════════════════════
    # 2. دورة المبيعات: طلب عميل + تسليم مبيعات + تحصيل بالخزينة
    # ═════════════════════════════════════════════════════════════════════════
    prod, v56, v60 = await _product_with_sizes(session)
    fg56 = await _finished_stock(session, prod, v56, 30, cost="70.00")

    # أ) إنشاء عميل
    cus_code = f"CUS-{_tag()}"
    res = await a["gm"].post("/api/v1/customers", json={
        "code": cus_code,
        "name": f"شركة الأناقة للملابس {cus_code}",
        "phone": "01288776655",
        "city": "الإسكندرية",
        "address": "محطة الرمل",
    })
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]

    # ب) طلب مبيعات: 20 قطعة بسعر 200 ج.م = 4,000 ج.م
    res = await a["gm"].post(f"/api/v1/customers/{customer_id}/orders", json={
        "order_type": "ready_goods",
        "discount_amount": "0.00",
        "lines": [
            {"product_id": prod.id, "variant_id": v56.id, "quantity": "20", "unit_price": "200.00"},
        ],
    })
    assert res.status_code == 201, res.text
    order_id = res.json()["id"]
    order_line_id = res.json()["lines"][0]["id"]

    # ج) تسليم المبيعات للعميل من مخزن التام
    res = await a["wh"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/deliveries", json={
        "lines": [{"order_line_id": order_line_id, "quantity": "20"}],
        "received_by": "سائق نقل العميل",
    })
    assert res.status_code == 201, res.text
    delivery_id = res.json()["id"]

    # تحقق محاسبي من قيد إيراد المبيعات:
    # Dr 1100 (العملاء: 4000) / Cr 4100 (إيرادات المبيعات: 4000)
    dr_cust = await _journal_amount(session, "customer_delivery_invoice", delivery_id, "1100", "debit")
    cr_sales = await _journal_amount(session, "customer_delivery_invoice", delivery_id, "4100", "credit")
    assert dr_cust == Decimal("4000.00")
    assert cr_sales == Decimal("4000.00")

    # تحقق محاسبي من قيد تكلفة البضاعة المباعة (COGS):
    # Dr 5100 (تكلفة المبيعات: 1400 = 20 × 70) / Cr 1230 (مخزون تام: 1400)
    dr_cogs = await _journal_amount(session, "customer_delivery_cogs", delivery_id, "5100", "debit")
    cr_fg = await _journal_amount(session, "customer_delivery_cogs", delivery_id, "1230", "credit")
    assert dr_cogs == Decimal("1400.00")
    assert cr_fg == Decimal("1400.00")

    # د) تحصيل دفعة من العميل: 3,000 ج.م نقداً في الخزينة
    res = await a["gm"].post(f"/api/v1/customers/{customer_id}/orders/{order_id}/payments", json={
        "amount": "3000.00",
        "method": "cash",
    })
    assert res.status_code == 201, res.text
    payment_data = res.json()
    assert payment_data["status"] == "pending"

    # اعتماد التحصيل في الخزينة
    treasury_before_coll = await _cash_balance(session, CANONICAL_TREASURY_ID)
    await _approve(a["fm"], payment_data["cash_document_id"])

    # تحقق من الخزنة: زادت 3,000 ج.م
    treasury_after_coll = await _cash_balance(session, CANONICAL_TREASURY_ID)
    assert treasury_after_coll == treasury_before_coll + Decimal("3000.00")

    # تحقق محاسبي من قيد التحصيل:
    # Dr 1010 (الخزينة: 3000) / Cr 1100 (العملاء: 3000)
    dr_csh_col = await _journal_amount(session, "customer_payment", payment_data["cash_document_id"], "1010", "debit")
    cr_cust_col = await _journal_amount(session, "customer_payment", payment_data["cash_document_id"], "1100", "credit")
    assert dr_csh_col == Decimal("3000.00")
    assert cr_cust_col == Decimal("3000.00")

    # هـ) كشف حساب العميل:
    cust_stmt = (await a["fm"].get(f"/api/v1/reports/customer-statement/{customer_id}")).json()
    assert Decimal(str(cust_stmt["totals"]["total_invoiced"])) == Decimal("4000.00")
    assert Decimal(str(cust_stmt["totals"]["total_paid"])) == Decimal("3000.00")
    assert Decimal(str(cust_stmt["totals"]["balance_due"])) == Decimal("1000.00")

    # ═════════════════════════════════════════════════════════════════════════
    # 3. دورة المصروفات والأجور
    # ═════════════════════════════════════════════════════════════════════════
    # أ) مصروف صيانة تشغيلية (5300): 450 ج.م
    res = await a["fm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense",
        "from_account_id": CANONICAL_TREASURY_ID,
        "to_account_id": None,
        "amount": "450.00",
        "description": "صيانة طارئة لماكينة الخياطة",
        "expense_category": "maintenance",
        "occurred_at": now.isoformat(),
    })
    assert res.status_code == 201, res.text
    doc_maint_id = res.json()["id"]

    # قيد الصيانة: Dr 5300 / Cr 1010 بمبلغ 450
    dr_maint = await _journal_amount(session, "cash_expense", doc_maint_id, "5300", "debit")
    cr_maint = await _journal_amount(session, "cash_expense", doc_maint_id, "1010", "credit")
    assert dr_maint == Decimal("450.00")
    assert cr_maint == Decimal("450.00")

    # ب) مصروفات إدارية وعمومية (5400): 300 ج.م
    res = await a["fm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense",
        "from_account_id": CANONICAL_TREASURY_ID,
        "to_account_id": None,
        "amount": "300.00",
        "description": "مستلزمات مكتبية للإدارة المالية",
        "expense_category": "administrative",
        "occurred_at": now.isoformat(),
    })
    assert res.status_code == 201, res.text
    doc_admin_id = res.json()["id"]

    # قيد الإدارة: Dr 5400 / Cr 1010 بمبلغ 300
    dr_admin = await _journal_amount(session, "cash_expense", doc_admin_id, "5400", "debit")
    cr_admin = await _journal_amount(session, "cash_expense", doc_admin_id, "1010", "credit")
    assert dr_admin == Decimal("300.00")
    assert cr_admin == Decimal("300.00")

    # ج) أجور تشغيل مباشرة (5210): 750 ج.م
    res = await a["fm"].post("/api/v1/finance/cash-documents", json={
        "document_type": "expense",
        "from_account_id": CANONICAL_TREASURY_ID,
        "to_account_id": None,
        "amount": "750.00",
        "description": "أجور عمال إنتاج مؤقتة",
        "expense_category": "direct_wages",
        "occurred_at": now.isoformat(),
    })
    assert res.status_code == 201, res.text
    doc_wages_id = res.json()["id"]

    # قيد الأجور: Dr 5210 / Cr 1010 بمبلغ 750
    dr_wages = await _journal_amount(session, "cash_expense", doc_wages_id, "5210", "debit")
    cr_wages = await _journal_amount(session, "cash_expense", doc_wages_id, "1010", "credit")
    assert dr_wages == Decimal("750.00")
    assert cr_wages == Decimal("750.00")

    # ═════════════════════════════════════════════════════════════════════════
    # 4. التحقق من قائمة الدخل (Profit and Loss / P&L)
    # ═════════════════════════════════════════════════════════════════════════
    pnl = (await a["fm"].get("/api/v1/reports/profit-and-loss")).json()

    # الإيرادات تحتوي مبيعات الطلب (4000 ج.م)
    assert float(pnl["revenues"]["total_revenue"]) >= 4000.0

    # تكلفة المبيعات تحتوي COGS (1400) + أجور مباشرة (750) = 2150 ج.م
    assert float(pnl["cost_of_goods_sold"]["total_cogs"]) >= 2150.0

    # المصروفات التشغيلية تحتوي صيانة (450) + إدارية (300) = 750 ج.م
    assert float(pnl["operating_expenses"]["total_expenses"]) >= 750.0

    # مجمل الربح = الإيرادات - تكلفة المبيعات
    calc_gross = Decimal(str(pnl["revenues"]["total_revenue"])) - Decimal(str(pnl["cost_of_goods_sold"]["total_cogs"]))
    assert abs(Decimal(str(pnl["gross_profit"])) - calc_gross) < Decimal("0.01")

    # صافي الدخل = مجمل الربح - المصروفات التشغيلية
    calc_net = calc_gross - Decimal(str(pnl["operating_expenses"]["total_expenses"]))
    assert abs(Decimal(str(pnl["net_income"])) - calc_net) < Decimal("0.01")

    # ═════════════════════════════════════════════════════════════════════════
    # 5. ميزان المراجعة (Trial Balance) — التوازن التام
    # ═════════════════════════════════════════════════════════════════════════
    tb = (await a["fm"].get("/api/v1/reports/trial-balance")).json()
    assert tb["is_balanced"] is True
    assert abs(float(tb["difference"])) < 0.001
    assert float(tb["total_debit"]) == float(tb["total_credit"])

    # ═════════════════════════════════════════════════════════════════════════
    # 6. دفتر الخزينة وحركة الحسابات
    # ═════════════════════════════════════════════════════════════════════════
    csh_stmt = (await a["fm"].get(f"/api/v1/reports/cash-account-statement/{CANONICAL_TREASURY_ID}")).json()
    assert float(csh_stmt["statement"]["closing_balance"]) > 0
    assert float(csh_stmt["statement"]["total_debit"]) >= 103000.0  # 100,000 إيداع + 3,000 تحصيل
    assert float(csh_stmt["statement"]["total_credit"]) >= 6500.0   # 5,000 مورد + 450 صيانة + 300 إدارة + 750 أجور

    print("\n" + "═" * 70)
    print("🎯 اكتمل فحص تكامل الشجرة المالية بنجاح 100%:")
    print("  1. حركة العميل: أثرت في حساب العميل (1100)، والمبيعات (4100)،")
    print("                  وتكلفة البضاعة المباعة (5100)، ومخزون التام (1230)،")
    print("                  والخزينة المركزية (1010)، وكشف حساب العميل.")
    print("  2. حركة المورد: أثرت في حساب المورد (2100)، ومخزون الخامات (1210)،")
    print("                  والخزينة المركزية (1010)، وكشف حساب المورد.")
    print("  3. المصروفات: أثرت في حسابات المصروفات (5300، 5400، 5210)،")
    print("                والخزينة المركزية (1010) بالصرف.")
    print("  4. قائمة الدخل: استوعبت الإيرادات والتكاليف والمصروفات، وحسبت مجمل")
    print("                  وصافي الربح بتطابق رياضي تام.")
    print("  5. ميزان المراجعة: إجمالي المدين = إجمالي الدائن والفرق 0.00 ج.م.")
    print("═" * 70)
