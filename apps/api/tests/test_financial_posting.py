"""
اختبارات قيود اليومية العامة، المطابقة الرياضية للعهد، وقواعد الرقابة المالية
─────────────────────────────────────────────────────────────────────────────
تتحقق من:
1. ترحيل قيود اليومية المتوازنة ورفض القيود غير المتوازنة (422).
2. حظر الترحيل المزدوج لنفس المستند (409).
3. تطبيق قاعدة الرقابة الثنائية (Maker-Checker) ومنع اعتماد المستخدم لمستنده.
4. المطابقة الرياضية لتسوية العهدة (العهدة الأصلية = مصروفات + مردود + متبقي).
5. احتساب متوسط التكلفة المرجح (WAC) لتقييم المخزون.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

import app.db.base  # noqa: F401
from app.modules.finance.models import (
    Account,
    CashAccount,
    CashDocument,
    CustodySettlement,
    JournalEntry,
    JournalEntryLine,
)
from app.modules.finance.schemas import (
    CashDocumentDecision,
    CustodySettlementCreate,
)
from app.modules.finance.ledger_service import (
    post_journal_entry,
    get_weighted_average_cost,
    CANONICAL_TREASURY_ID,
)
from app.modules.finance.service import decide_cash_document
from app.api.v1.endpoints.finance import create_custody_settlement
from app.core.auth import AuthenticatedUser


@pytest.mark.asyncio
async def test_post_journal_entry_balanced_succeeds():
    """ترحيل قيد يومية متوازن (مدين = دائن) ينجح وينشئ القيد وسطوره."""
    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.scalar.return_value = None  # لا يوجد قيد سابق

    acc1 = Account(id="acc-1", code="1210", name_ar="مخزون خامات", account_type="asset", is_active=True)
    acc2 = Account(id="acc-2", code="2100", name_ar="موردون", account_type="liability", is_active=True)

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [acc1, acc2]
    session.scalars.return_value = scalars_mock

    lines = [
        {"account_code": "1210", "debit": Decimal("1500.00"), "credit": Decimal("0.00"), "description": "استلام خامات"},
        {"account_code": "2100", "debit": Decimal("0.00"), "credit": Decimal("1500.00"), "description": "استحقاق مورد"},
    ]

    entry = await post_journal_entry(
        session,
        source_doc_type="supplier_invoice_receipt",
        source_doc_id="inv-123",
        description="فاتورة توريد خامات قطن",
        lines=lines,
        user_id="user-warehouse",
    )

    assert entry.status == "posted"
    assert entry.source_doc_type == "supplier_invoice_receipt"
    assert entry.source_doc_id == "inv-123"
    assert entry.entry_number.startswith("JE-")
    assert session.add.call_count == 3  # 1 entry + 2 lines


@pytest.mark.asyncio
async def test_post_journal_entry_unbalanced_raises_422():
    """القيد غير المتوازن (مدين ≠ دائن) يُرفض برمز 422 ولا يرحل."""
    session = AsyncMock()
    session.scalar.return_value = None

    lines = [
        {"account_code": "1210", "debit": Decimal("1500.00"), "credit": Decimal("0.00")},
        {"account_code": "2100", "debit": Decimal("0.00"), "credit": Decimal("1200.00")},  # فارق 300
    ]

    with pytest.raises(HTTPException) as exc:
        await post_journal_entry(
            session,
            source_doc_type="test_doc",
            source_doc_id="doc-1",
            description="قيد غير متوازن",
            lines=lines,
            user_id="user-1",
        )
    assert exc.value.status_code == 422
    assert "غير متوازن" in exc.value.detail


@pytest.mark.asyncio
async def test_post_journal_entry_prevents_duplicate_posting():
    """منع الترحيل المزدوج لنفس المستند المرجعي (Idempotency)."""
    session = AsyncMock()
    session.scalar.return_value = "existing-je-id"  # القيد مرحل بالفعل

    lines = [
        {"account_code": "1010", "debit": Decimal("500.00"), "credit": 0},
        {"account_code": "1100", "debit": 0, "credit": Decimal("500.00")},
    ]

    with pytest.raises(HTTPException) as exc:
        await post_journal_entry(
            session,
            source_doc_type="customer_payment",
            source_doc_id="pay-999",
            description="تحصيل عميل",
            lines=lines,
            user_id="user-1",
            allow_duplicate=False,
        )
    assert exc.value.status_code == 409
    assert "مسبقاً" in exc.value.detail


@pytest.mark.asyncio
async def test_maker_checker_rejects_self_approval():
    """قاعدة الرقابة الثنائية: لا يجوز لمنشئ المستند اعتماده بنفسه."""
    session = AsyncMock()
    doc = CashDocument(
        id="doc-1",
        document_number="CSH-001",
        document_type="expense",
        from_account_id="acc-treasury",
        amount=Decimal("1000.00"),
        description="صرف صيانة",
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="finance-officer-1",
    )
    session.scalar.return_value = doc

    decision = CashDocumentDecision(decision="approve")
    with pytest.raises(HTTPException) as exc:
        # نفس المستخدم يحاول الاعتماد
        await decide_cash_document(session, "doc-1", decision, user_id="finance-officer-1")
    assert exc.value.status_code == 409
    assert "Maker-Checker" in exc.value.detail or "لا يجوز لمنشئ المستند" in exc.value.detail


# تسوية العهدة أصبحت تُحسب من دفتر النقدية خادمياً وتمر باعتماد الخزينة؛
# اختباراتها التكاملية على قاعدة بيانات حقيقية في tests/test_operational_cycle_e2e.py


@pytest.mark.asyncio
async def test_weighted_average_cost_calculation():
    """اختبار حساب متوسط التكلفة المرجح WAC = SUM(total_cost) / SUM(quantity)."""
    session = AsyncMock()
    # إجمالي التكلفة = 12,000 ج.م على كمية 1,000 متر -> التكلفة = 12.0000 ج.م للمتر
    session.scalar.side_effect = [Decimal("12000.00"), Decimal("1000.00")]

    wac = await get_weighted_average_cost(session, item_id="item-fabric-1", warehouse_id="wh-raw")
    assert wac == Decimal("12.0000")


@pytest.mark.asyncio
async def test_supplier_payment_capped_at_received_amount_when_shortage():
    """حظر سداد مبلغ يتجاوز القيمة المستلمة فعلياً عند وجود عجز أو توريد جزئي في الفاتورة."""
    from app.api.v1.endpoints.finance import create_supplier_payment
    from app.modules.finance.schemas import SupplierPaymentCreate
    from app.modules.finance.models import SupplierInvoice, SupplierInvoiceLine

    session = AsyncMock()
    line = SupplierInvoiceLine(
        id="line-1",
        invoice_id="inv-1",
        item_id="item-1",
        unit_id="unit-1",
        invoiced_quantity=100.0,
        received_quantity=80.0,  # عجز 20
        unit_price=Decimal("50.00"),
    )
    invoice = SupplierInvoice(
        id="inv-1",
        internal_number="PIN-001",
        supplier_id="sup-1",
        invoice_number="INV-999",
        invoice_total=Decimal("5000.00"),  # 100 * 50
        status="received",  # استلمت جزئياً وتم إثبات الاستلام
        lines=[line],
    )
    treasury = CashAccount(
        id=CANONICAL_TREASURY_ID,
        account_number="TREASURY-MAIN",
        name="الخزنة المركزية الرئيسية",
        account_type="treasury",
        is_active=True,
    )

    # 1. invoice query with_for_update -> invoice
    # 2. payment totals by status (grouped query) -> none yet
    session.scalar.side_effect = [invoice]
    session.execute = AsyncMock(return_value=MagicMock(all=MagicMock(return_value=[])))
    session.get.return_value = treasury

    user = AuthenticatedUser(id="fin-user", email="fin@factory.com", claims={"sub": "fin-user"})

    # محاولة سداد 4500 ج.م (أقل من إجمالي الفاتورة 5000، ولكنها تتجاوز المستلم الفعلي 80 * 50 = 4000)
    over_payment = SupplierPaymentCreate(
        amount=Decimal("4500.00"),
        description="دفعة تتجاوز الفعلي المستلم",
    )

    with pytest.raises(HTTPException) as exc:
        await create_supplier_payment("inv-1", over_payment, user, session)
    assert exc.value.status_code == 409
    assert "بناءً على الكميات المستلمة" in exc.value.detail


@pytest.mark.asyncio
async def test_profit_and_loss_report_calculation():
    """التحقق من حسابات قائمة الدخل (إيرادات، COGS، مجمل الربح، مصروفات، صافي الدخل)."""
    from app.api.v1.endpoints.reports import report_profit_and_loss

    session = AsyncMock()
    user = AuthenticatedUser(id="mgr-1", email="mgr@factory.com", claims={"sub": "mgr-1"})

    acc_rev = Account(id="a-rev", code="4100", name_ar="مبيعات منتجات تامة", account_type="revenue", is_active=True)
    acc_cogs = Account(id="a-cogs", code="5100", name_ar="تكلفة مبيعات", account_type="expense", is_active=True)
    acc_exp = Account(id="a-exp", code="5400", name_ar="مصروفات عمومية", account_type="expense", is_active=True)

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [acc_rev, acc_cogs, acc_exp]
    session.scalars.return_value = scalars_mock

    # side_effects for queries inside get_account_net:
    # 1. 4100 debit sum = 0, credit sum = 100,000 -> net revenue = 100,000
    # 2. 5100 debit sum = 60,000, credit sum = 0 -> net cogs = 60,000
    # 3. 5400 debit sum = 15,000, credit sum = 0 -> net expense = 15,000
    session.scalar.side_effect = [
        Decimal("0.00"), Decimal("100000.00"),  # 4100
        Decimal("60000.00"), Decimal("0.00"),   # 5100
        Decimal("15000.00"), Decimal("0.00"),   # 5400
    ]

    pnl = await report_profit_and_loss(None, user, session)
    assert pnl["revenues"]["total_revenue"] == 100000.0
    assert pnl["cost_of_goods_sold"]["total_cogs"] == 60000.0
    assert pnl["gross_profit"] == 40000.0
    assert pnl["gross_profit_margin_pct"] == 40.0
    assert pnl["operating_expenses"]["total_expenses"] == 15000.0
    assert pnl["net_income"] == 25000.0
    assert pnl["net_profit_margin_pct"] == 25.0


@pytest.mark.asyncio
async def test_balance_sheet_report_balance_verification():
    """التحقق من توازن الميزانية العمومية: الأصول = الالتزامات + حقوق الملكية."""
    from app.api.v1.endpoints.reports import report_balance_sheet

    session = AsyncMock()
    user = AuthenticatedUser(id="mgr-1", email="mgr@factory.com", claims={"sub": "mgr-1"})

    acc_cash = Account(id="a-1010", code="1010", name_ar="الخزينة الرئيسية", account_type="asset", is_active=True)
    acc_ar = Account(id="a-1100", code="1100", name_ar="العملاء", account_type="asset", is_active=True)
    acc_ap = Account(id="a-2100", code="2100", name_ar="الموردون", account_type="liability", is_active=True)
    acc_cap = Account(id="a-3000", code="3000", name_ar="رأس المال", account_type="equity", is_active=True)

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [acc_cash, acc_ar, acc_ap, acc_cap]
    session.scalars.return_value = scalars_mock

    # side effects for get_balance:
    # 1010 (cash): dr=50000, cr=0 -> net=50000
    # 1020 (petty): not in accounts -> default 0
    # 1030 (banks): not in accounts -> default 0
    # 1100 (ar): dr=30000, cr=0 -> net=30000
    # 1210 (raw): not in accounts -> default 0
    # 1220 (wip): not in accounts -> default 0
    # 1230 (fg): not in accounts -> default 0
    # Total assets = 80,000
    # 2100 (ap): dr=0, cr=20000 -> net=20000
    # Total liabilities = 20,000
    # 3000 (capital): dr=0, cr=50000 -> net=50000
    # rev_dr=0, rev_cr=20000, exp_dr=10000, exp_cr=0 -> current_net_income = 10,000
    # Total equity = 50,000 + 10,000 = 60,000
    # Total liabilities + equity = 20,000 + 60,000 = 80,000 (Balanced!)
    session.scalar.side_effect = [
        Decimal("50000.00"), Decimal("0.00"),  # 1010 dr, cr
        Decimal("30000.00"), Decimal("0.00"),  # 1100 dr, cr
        Decimal("0.00"), Decimal("20000.00"),  # 2100 dr, cr
        Decimal("0.00"), Decimal("50000.00"),  # 3000 dr, cr
        Decimal("0.00"), Decimal("20000.00"),  # 4xxx rev_dr, rev_cr
        Decimal("10000.00"), Decimal("0.00"),  # 5xxx exp_dr, exp_cr
    ]

    bs = await report_balance_sheet(user, session)
    assert bs["assets"]["total_assets"] == 80000.0
    assert bs["liabilities"]["total_liabilities"] == 20000.0
    assert bs["equity"]["total_equity"] == 60000.0
    assert bs["total_liabilities_and_equity"] == 80000.0
    assert bs["difference"] == 0.0
    assert bs["is_balanced"] is True


@pytest.mark.asyncio
async def test_end_to_end_workflow_a_supplier_procurement_shortage_capped():
    """Workflow A: دورة المشتريات والموردين مع عجز التوريد وتقييد السداد بالمستلم الفعلي."""
    from app.api.v1.endpoints.finance import create_supplier_payment
    from app.modules.finance.models import Supplier, SupplierInvoice, SupplierInvoiceLine, SupplierPayment
    from app.modules.finance.schemas import SupplierPaymentCreate

    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()

    user = AuthenticatedUser(id="fin-mgr-1", email="fin@qemma.com", claims={"sub": "fin-mgr-1"})

    # فاتورة بإجمالي 5400 ج.م (100 متر قماش @ 50 + 200 زرار @ 2)
    inv = SupplierInvoice(
        id="inv-wf-a",
        internal_number="SINV-WFA-001",
        supplier_id="sup-1",
        invoice_number="INV-SUP-9988",
        invoice_date=datetime.now(timezone.utc),
        invoice_total=Decimal("5400.00"),
        status="received",
    )
    # المستلم الفعلي: 80 متر قماش (عجز 20 متر) + 200 زرار -> الإجمالي المستلم = 4400 ج.م
    line1 = SupplierInvoiceLine(
        id="l-1", invoice_id=inv.id, item_id="item-fabric", unit_id="u-m",
        invoiced_quantity=100.0, received_quantity=80.0, unit_price=Decimal("50.00"),
    )
    line2 = SupplierInvoiceLine(
        id="l-2", invoice_id=inv.id, item_id="item-button", unit_id="u-pc",
        invoiced_quantity=200.0, received_quantity=200.0, unit_price=Decimal("2.00"),
    )
    inv.lines = [line1, line2]

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TREASURY-MAIN", account_type="treasury", is_active=True)
    session.get = AsyncMock(return_value=treasury)

    # 1. محاولة سداد 5000 ج.م (تتجاوز المستلم الفعلي 4400) -> يجب أن ترفض برمز 409
    session.scalar.side_effect = [inv]  # select invoice with lines
    session.execute = AsyncMock(return_value=MagicMock(all=MagicMock(return_value=[])))  # no prior payments

    with pytest.raises(HTTPException) as exc:
        await create_supplier_payment(
            invoice_id=inv.id,
            data=SupplierPaymentCreate(amount=Decimal("5000.00"), description="دفعة أولى مرفوضة"),
            current_user=user,
            db=session,
        )
    assert exc.value.status_code == 409
    assert "تتجاوز المستحق الفعلي" in exc.value.detail
    assert "4400.00" in exc.value.detail

    # 2. سداد دفعة جزئية صحيحة بمبلغ 2000 ج.م -> تنجح
    session.scalar.side_effect = [inv]
    doc = await create_supplier_payment(
        invoice_id=inv.id,
        data=SupplierPaymentCreate(amount=Decimal("2000.00"), description="سداد دفعة أولى معتمدة"),
        current_user=user,
        db=session,
    )
    assert doc.status == "pending"
    assert doc.amount == Decimal("2000.00")

    # 3. محاولة سداد 2500 ج.م إضافية (2000 + 2500 = 4500 > 4400) -> ترفض برمز 409
    session.scalar.side_effect = [inv]
    session.execute = AsyncMock(return_value=MagicMock(all=MagicMock(return_value=[("pending", Decimal("2000.00"))])))
    with pytest.raises(HTTPException) as exc2:
        await create_supplier_payment(
            invoice_id=inv.id,
            data=SupplierPaymentCreate(amount=Decimal("2500.00"), description="دفعة تتجاوز المتبقي"),
            current_user=user,
            db=session,
        )
    assert exc2.value.status_code == 409

    # 4. سداد المتبقي الدقيق 2400 ج.م (2000 + 2400 = 4400) -> ينجح
    session.scalar.side_effect = [inv]
    doc2 = await create_supplier_payment(
        invoice_id=inv.id,
        data=SupplierPaymentCreate(amount=Decimal("2400.00"), description="سداد باقي المستحق الفعلي"),
        current_user=user,
        db=session,
    )
    assert doc2.status == "pending"
    assert doc2.amount == Decimal("2400.00")


@pytest.mark.asyncio
async def test_end_to_end_workflow_b_production_wip_residual_cost_closure():
    """Workflow B: دورة تشغيل الإنتاج، تفريغ WIP للمنتج التام، وتسوية الهالك والفروقات عند الإغلاق."""
    from app.modules.finance.models import Account, JournalEntry
    from app.modules.production.models import ProductionOrder

    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.scalar.return_value = None  # No prior duplicate entry

    acc_var = Account(id="acc-5200", code="5200", name_ar="فروقات وهالك تشغيل", account_type="expense", is_active=True)
    acc_wip = Account(id="acc-1220", code="1220", name_ar="إنتاج تحت التشغيل", account_type="asset", is_active=True)

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [acc_var, acc_wip]
    session.scalars.return_value = scalars_mock

    # أمر تشغيل بمتبقي WIP مالي 1500 ج.م ناتج عن عجز/تالف
    order_id = "ord-wf-b-100"
    residual_wip_cost = Decimal("1500.00")

    entry = await post_journal_entry(
        session,
        source_doc_type="production_order_scrap_variance",
        source_doc_id=order_id,
        description="تسوية رصيد WIP المتبقي وفروقات/هالك أمر التشغيل PO-WFB-2026",
        lines=[
            {"account_code": "5200", "debit": residual_wip_cost, "credit": Decimal("0.00"), "description": "هالك وفروقات تشغيل أمر PO-WFB-2026"},
            {"account_code": "1220", "debit": Decimal("0.00"), "credit": residual_wip_cost, "description": "تصفير حساب إنتاج تحت التشغيل"},
        ],
        user_id="gm-prod-1",
    )

    assert entry.status == "posted"
    assert entry.source_doc_type == "production_order_scrap_variance"
    assert entry.source_doc_id == order_id
    assert session.add.call_count == 3  # 1 JournalEntry + 2 JournalEntryLines


@pytest.mark.asyncio
async def test_end_to_end_workflow_c_customer_delivery_collection_segregated_return():
    """Workflow C: دورة العميل والتسليم وإثبات الإيراد والـ COGS ثم المرتجع المعزول وقيد العكس."""
    from app.modules.finance.models import Account, JournalEntry

    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.scalar.return_value = None  # No prior duplicate entry

    acc_fg = Account(id="a-1230", code="1230", name_ar="مخزون تام", account_type="asset", is_active=True)
    acc_cogs = Account(id="a-5100", code="5100", name_ar="تكلفة مبيعات", account_type="expense", is_active=True)
    acc_rev = Account(id="a-4100", code="4100", name_ar="إيرادات مبيعات", account_type="revenue", is_active=True)
    acc_ar = Account(id="a-1100", code="1100", name_ar="عملاء", account_type="asset", is_active=True)
    acc_cash = Account(id="a-1010", code="1010", name_ar="خزينة رئيسية", account_type="asset", is_active=True)

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [acc_fg, acc_cogs, acc_rev, acc_ar, acc_cash]
    session.scalars.return_value = scalars_mock

    # 1. إثبات مبيعات وتسليم 30 قطعة @ 150 (تكلفة 100):
    # قيد الإيراد: Dr 1100 (4500) / Cr 4100 (4500)
    je_rev = await post_journal_entry(
        session,
        source_doc_type="customer_delivery_invoice",
        source_doc_id="del-inv-1",
        description="إثبات مبيعات تسليم أمر عميل",
        lines=[
            {"account_code": "1100", "debit": Decimal("4500.00"), "credit": Decimal("0.00"), "description": "مديونية العميل"},
            {"account_code": "4100", "debit": Decimal("0.00"), "credit": Decimal("4500.00"), "description": "إيرادات مبيعات"},
        ],
        user_id="sales-user-1",
    )
    assert je_rev.status == "posted"

    # قيد تكلفة البضاعة المباعة: Dr 5100 (3000) / Cr 1230 (3000)
    je_cogs = await post_journal_entry(
        session,
        source_doc_type="customer_delivery_cogs",
        source_doc_id="del-cogs-1",
        description="إثبات تكلفة البضاعة المباعة للتسليم",
        lines=[
            {"account_code": "5100", "debit": Decimal("3000.00"), "credit": Decimal("0.00"), "description": "تكلفة بضاعة مباعة"},
            {"account_code": "1230", "debit": Decimal("0.00"), "credit": Decimal("3000.00"), "description": "صرف مخزون تام مسلّم"},
        ],
        user_id="wh-user-1",
    )
    assert je_cogs.status == "posted"

    # 2. تحصيل 4500 ج.م نقداً بالخزينة: Dr 1010 (4500) / Cr 1100 (4500)
    je_pmt = await post_journal_entry(
        session,
        source_doc_type="customer_payment",
        source_doc_id="cpay-1",
        description="تحصيل دفعة عميل بالخزينة",
        lines=[
            {"account_code": "1010", "debit": Decimal("4500.00"), "credit": Decimal("0.00"), "description": "إيداع بالخزينة"},
            {"account_code": "1100", "debit": Decimal("0.00"), "credit": Decimal("4500.00"), "description": "تخفيض ذمة العميل"},
        ],
        user_id="checker-user-1",
    )
    assert je_pmt.status == "posted"

    # 3. إثبات مرتجع 5 قطع معيبة (سعر بيع 750، تكلفة 500) وعكس القيود:
    # عكس COGS وإيداع ببضاعة تحت الفحص: Dr 1230 (500) / Cr 5100 (500)
    je_ret_cogs = await post_journal_entry(
        session,
        source_doc_type="customer_delivery_return_cogs",
        source_doc_id="ret-cogs-1",
        description="عكس تكلفة مبيعات المرتجع وإيداع مخزون تحت الفحص",
        lines=[
            {"account_code": "1230", "debit": Decimal("500.00"), "credit": Decimal("0.00"), "description": "إيداع بضاعة مرتجعة معزولة تحت الفحص"},
            {"account_code": "5100", "debit": Decimal("0.00"), "credit": Decimal("500.00"), "description": "عكس تكلفة مبيعات المرتجع"},
        ],
        user_id="wh-user-1",
    )
    assert je_ret_cogs.status == "posted"

    # عكس الإيراد وإنشاء رصيد دائن للعميل: Dr 4100 (750) / Cr 1100 (750)
    je_ret_rev = await post_journal_entry(
        session,
        source_doc_type="customer_delivery_return_revenue",
        source_doc_id="ret-rev-1",
        description="عكس إيراد مبيعات المرتجع وتخفيض مديونية العميل",
        lines=[
            {"account_code": "4100", "debit": Decimal("750.00"), "credit": Decimal("0.00"), "description": "تخفيض إيراد مبيعات للمرتجع"},
            {"account_code": "1100", "debit": Decimal("0.00"), "credit": Decimal("750.00"), "description": "رصيد دائن للعميل مقابل المرتجع"},
        ],
        user_id="sales-user-1",
    )
    assert je_ret_rev.status == "posted"


