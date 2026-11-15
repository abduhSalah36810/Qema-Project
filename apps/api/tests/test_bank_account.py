"""
اختبارات حساب البنك (ACC-03):
- نوع الحساب bank وربطه برمز دفتر الأستاذ 1030
- التحويلات الداخلية بين الخزنة (1010) والبنك (1030) دون الاعتراف بإيراد أو مصروف
- الفصل بين النقدية الفعلية (1010) ورصيد البنك (1030)
- صرف المصروفات والمدفوعات من حساب البنك مباشرة
- رفض التحويل غير المسموح به بين العهدة والبنك مباشرة
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
    CashLedgerEntry,
)
from app.modules.finance.schemas import (
    CashDocumentCreate,
    CashDocumentDecision,
)
from app.modules.finance.ledger_service import (
    CANONICAL_TREASURY_ID,
    CANONICAL_BANK_ID,
)
from app.modules.finance.service import (
    create_cash_document,
    decide_cash_document,
    _cash_gl_code,
    get_main_bank,
)


@pytest.mark.asyncio
async def test_cash_gl_code_mapping():
    """التحقق من ربط نوع الحساب برمز الأستاذ الصحيح (1010 للخزنة، 1020 للعهدة، 1030 للبنك)."""
    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TREASURY-MAIN", name="الخزنة", account_type="treasury", is_active=True, created_by="sys")
    petty = CashAccount(id="petty-1", account_number="PETTY-1", name="عهدة", account_type="petty_cash", is_active=True, created_by="sys")
    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="حساب بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    assert _cash_gl_code(treasury) == "1010"
    assert _cash_gl_code(petty) == "1020"
    assert _cash_gl_code(bank) == "1030"


@pytest.mark.asyncio
async def test_create_transfer_treasury_to_bank_succeeds():
    """إنشاء طلب تحويل من الخزنة إلى البنك (إيداع بنكي) يمر بنجاح."""
    session = AsyncMock()
    session.scalar.return_value = None  # no duplicate

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TREASURY-MAIN", name="الخزنة", account_type="treasury", is_active=True, created_by="sys")
    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [treasury, bank]
    session.scalars.return_value = scalars_mock

    payload = CashDocumentCreate(
        document_type="transfer",
        from_account_id=treasury.id,
        to_account_id=bank.id,
        amount=Decimal("25000.00"),
        description="إيداع نقدي في حساب البنك التجاري",
        occurred_at=datetime.now(timezone.utc),
    )

    doc = await create_cash_document(session, payload, user_id="user-1", commit=False)
    assert doc.document_type == "transfer"
    assert doc.from_account_id == treasury.id
    assert doc.to_account_id == bank.id
    assert doc.amount == Decimal("25000.00")
    assert doc.status == "pending"


@pytest.mark.asyncio
async def test_create_transfer_bank_to_treasury_succeeds():
    """إنشاء طلب تحويل من البنك إلى الخزنة (سحب نقدي من البنك) يمر بنجاح."""
    session = AsyncMock()
    session.scalar.return_value = None

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TREASURY-MAIN", name="الخزنة", account_type="treasury", is_active=True, created_by="sys")
    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [treasury, bank]
    session.scalars.return_value = scalars_mock

    payload = CashDocumentCreate(
        document_type="transfer",
        from_account_id=bank.id,
        to_account_id=treasury.id,
        amount=Decimal("10000.00"),
        description="سحب نقدي من البنك لتغذية الخزنة",
        occurred_at=datetime.now(timezone.utc),
    )

    doc = await create_cash_document(session, payload, user_id="user-1", commit=False)
    assert doc.document_type == "transfer"
    assert doc.from_account_id == bank.id
    assert doc.to_account_id == treasury.id


@pytest.mark.asyncio
async def test_create_transfer_petty_cash_to_bank_rejected():
    """حظر التحويل المباشر من صندوق العهدة إلى البنك (العهدة تُسوّى مع الخزنة الرئيسية فقط)."""
    session = AsyncMock()
    session.scalar.return_value = None

    petty = CashAccount(id="petty-1", account_number="PETTY-1", name="عهدة", account_type="petty_cash", is_active=True, created_by="sys")
    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [petty, bank]
    session.scalars.return_value = scalars_mock

    payload = CashDocumentCreate(
        document_type="transfer",
        from_account_id=petty.id,
        to_account_id=bank.id,
        amount=Decimal("500.00"),
        description="محاولة تحويل متبقي العهدة للبنك",
        occurred_at=datetime.now(timezone.utc),
    )

    with pytest.raises(HTTPException) as exc_info:
        await create_cash_document(session, payload, user_id="user-1")
    assert exc_info.value.status_code == 422
    assert "تسوية العهدة تكون بإرجاع المتبقي إلى الخزنة" in exc_info.value.detail


@pytest.mark.asyncio
@patch("app.modules.finance.service.post_journal_entry", new_callable=AsyncMock)
async def test_approve_transfer_treasury_to_bank_posts_correct_gl_lines(mock_post_je):
    """
    اعتماد تحويل من الخزنة إلى البنك:
    - يرحل قيد: مدين 1030 (حساب بنك المصنع)، دائن 1010 (الخزنة المركزية).
    - يدرج حركتي دفتر نقدية: -25000 للخزنة و+25000 للبنك.
    - لا يمس أي حساب إيراد أو مصروف.
    """
    session = AsyncMock()
    session.add = MagicMock()

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TREASURY-MAIN", name="الخزنة الرئيسية", account_type="treasury", is_active=True, created_by="sys")
    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="حساب بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    doc = CashDocument(
        id="doc-transfer-1",
        document_number="CSH-TR-001",
        document_type="transfer",
        from_account_id=treasury.id,
        to_account_id=bank.id,
        amount=Decimal("25000.00"),
        description="إيداع نقدي في حساب البنك",
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="user-1",
    )

    # Mock side effects:
    # 1. db.scalar for doc lookup
    # 2. cash_account_balance for treasury -> 30000.00
    session.scalar.side_effect = [doc, Decimal("30000.00")]

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [treasury, bank]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    approved = await decide_cash_document(session, doc.id, decision, user_id="finance-mgr")

    assert approved.status == "approved"

    # التحقق من سطور دفتر النقدية
    assert session.add.call_count == 2
    entries = [call[0][0] for call in session.add.call_args_list if isinstance(call[0][0], CashLedgerEntry)]
    assert len(entries) == 2
    from_entry = next(e for e in entries if e.account_id == treasury.id)
    to_entry = next(e for e in entries if e.account_id == bank.id)
    assert from_entry.amount == -Decimal("25000.00")
    assert to_entry.amount == Decimal("25000.00")

    # التحقق من قيد اليومية
    mock_post_je.assert_awaited_once()
    je_kwargs = mock_post_je.call_args.kwargs
    assert je_kwargs["source_doc_type"] == "cash_transfer"
    assert je_kwargs["source_doc_id"] == doc.id
    lines = je_kwargs["lines"]
    assert len(lines) == 2
    # مدين 1030 (البنك)
    assert lines[0]["account_code"] == "1030"
    assert lines[0]["debit"] == Decimal("25000.00")
    assert lines[0]["credit"] == 0
    # دائن 1010 (الخزنة)
    assert lines[1]["account_code"] == "1010"
    assert lines[1]["debit"] == 0
    assert lines[1]["credit"] == Decimal("25000.00")


@pytest.mark.asyncio
@patch("app.modules.finance.service.post_journal_entry", new_callable=AsyncMock)
async def test_approve_bank_expense_posts_to_1030(mock_post_je):
    """
    صرف مصروف من حساب البنك مباشرة (مثل تحويل مصاريف بنكية أو إدارية):
    - يرحل قيد: مدين 5400 (مصروف)، دائن 1030 (البنك).
    - الخزنة 1010 لا تتأثر تماماً.
    """
    session = AsyncMock()
    session.add = MagicMock()

    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="حساب بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    doc = CashDocument(
        id="doc-exp-1",
        document_number="CSH-EXP-001",
        document_type="expense",
        from_account_id=bank.id,
        to_account_id=None,
        amount=Decimal("1200.00"),
        description="مصاريف بنكية وإدارية",
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="user-1",
    )

    session.scalar.side_effect = [doc, Decimal("50000.00")]  # doc, then balance
    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [bank]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    approved = await decide_cash_document(session, doc.id, decision, user_id="finance-mgr")

    assert approved.status == "approved"
    mock_post_je.assert_awaited_once()
    lines = mock_post_je.call_args.kwargs["lines"]
    # Credit line must be bank account 1030, NOT physical treasury 1010
    cr_line = next(l for l in lines if l["credit"] > 0)
    assert cr_line["account_code"] == "1030"
    assert cr_line["credit"] == Decimal("1200.00")


@pytest.mark.asyncio
@patch("app.modules.finance.service.post_journal_entry", new_callable=AsyncMock)
async def test_approve_bank_income_customer_payment_posts_to_1030(mock_post_je):
    """
    تحصيل عميل عبر تحويل بنكي:
    - يودع في حساب البنك (to_account_id = CANONICAL_BANK_ID)
    - يرحل قيد: مدين 1030 (البنك)، دائن 1100 (العملاء).
    - الخزنة 1010 لا تتأثر تماماً.
    """
    session = AsyncMock()
    session.add = MagicMock()

    bank = CashAccount(id=CANONICAL_BANK_ID, account_number="BANK-MAIN", name="حساب بنك المصنع", account_type="bank", is_active=True, created_by="sys")

    doc = CashDocument(
        id="doc-inc-1",
        document_number="CSH-INC-001",
        document_type="income",
        from_account_id=None,
        to_account_id=bank.id,
        amount=Decimal("15000.00"),
        description="تحصيل عميل (تحويل بنكي)",
        occurred_at=datetime.now(timezone.utc),
        source_system="customer_payment",
        source_reference="payment-1",
        status="pending",
        created_by="user-1",
    )

    cust_payment = MagicMock()
    cust_payment.status = "pending"
    session.scalar.side_effect = [doc, cust_payment]  # doc lookup, then CustomerPayment lookup
    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [bank]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    approved = await decide_cash_document(session, doc.id, decision, user_id="finance-mgr")

    assert approved.status == "approved"
    mock_post_je.assert_awaited_once()
    lines = mock_post_je.call_args.kwargs["lines"]
    dr_line = next(l for l in lines if l["debit"] > 0)
    assert dr_line["account_code"] == "1030"
    assert dr_line["debit"] == Decimal("15000.00")
    cr_line = next(l for l in lines if l["credit"] > 0)
    assert cr_line["account_code"] == "1100"
    assert cr_line["credit"] == Decimal("15000.00")

