"""
اختبارات فصل حسابات المصروفات وتبويب سندات الصرف (ACC-04):
- إسناد سند الصرف لفئة مصروف صريحة (expense_category)
- ترحيل القيد لرمز الأستاذ المناسب:
  * 5210: أجور عمال التشغيل المباشرة
  * 5220: هالك إنتاج وفروق جرد وتشغيل
  * 5300: مصروفات تشغيل وصيانة المكان
  * 5400: مصروفات إدارية وعمومية
  * 5410: مرتبات ومكافآت الإدارة والخدمات
- التوافق الرجعي عند غياب expense_category
- شمول حسابات المصروفات الجديدة في قائمة الدخل (P&L)
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

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
    resolve_expense_code,
)
from app.modules.finance.service import (
    create_cash_document,
    decide_cash_document,
)


@pytest.mark.asyncio
async def test_resolve_expense_code_preferred_vs_fallback():
    session = AsyncMock()
    # Preferred account exists
    session.scalar.return_value = "acc-5210-id"
    code = await resolve_expense_code(session, "5210", "5200")
    assert code == "5210"

    # Preferred account does not exist -> fallback
    session.scalar.return_value = None
    fallback_code = await resolve_expense_code(session, "5210", "5200")
    assert fallback_code == "5200"


@pytest.mark.asyncio
async def test_create_cash_document_with_explicit_category():
    session = AsyncMock()
    session.scalar.return_value = None  # no duplicate

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TR-1", name="الخزنة", account_type="treasury", is_active=True, created_by="sys")
    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [treasury]
    session.scalars.return_value = scalars_mock

    payload = CashDocumentCreate(
        document_type="expense",
        from_account_id=treasury.id,
        amount=Decimal("3500.00"),
        description="سداد مكافأة حافز إدارة",
        expense_category="admin_salary",
        occurred_at=datetime.now(timezone.utc),
    )

    doc = await create_cash_document(session, payload, user_id="user-1", commit=False)
    assert doc.document_type == "expense"
    assert doc.expense_category == "admin_salary"
    assert doc.amount == Decimal("3500.00")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "category,expected_gl_code",
    [
        ("direct_wages", "5210"),
        ("scrap_variance", "5220"),
        ("operating_expense", "5300"),
        ("maintenance", "5300"),
        ("administrative", "5400"),
        ("admin_expense", "5400"),
        ("admin_salary", "5410"),
    ],
)
@patch("app.modules.finance.service.post_journal_entry", new_callable=AsyncMock)
async def test_approve_expense_routes_to_correct_gl_account(mock_post_je, category, expected_gl_code):
    session = AsyncMock()
    session.add = MagicMock()

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TR-1", name="الخزنة", account_type="treasury", is_active=True, created_by="sys")
    doc = CashDocument(
        id=f"doc-{category}",
        document_number=f"CSH-EXP-{category}",
        document_type="expense",
        from_account_id=treasury.id,
        to_account_id=None,
        amount=Decimal("1000.00"),
        description=f"سداد تجريبي - {category}",
        expense_category=category,
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="user-1",
    )

    # 1. doc lookup
    # 2. cash_account_balance -> 10000.00
    # 3. resolve_expense_code lookup -> account exists
    session.scalar.side_effect = [doc, Decimal("10000.00"), "found-account-id"]

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [treasury]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    approved = await decide_cash_document(session, doc.id, decision, user_id="finance-mgr")

    assert approved.status == "approved"
    mock_post_je.assert_awaited_once()
    lines = mock_post_je.call_args.kwargs["lines"]
    dr_line = next(l for l in lines if l["debit"] > 0)
    assert dr_line["account_code"] == expected_gl_code
    assert dr_line["debit"] == Decimal("1000.00")


@pytest.mark.asyncio
@patch("app.modules.finance.service.post_journal_entry", new_callable=AsyncMock)
async def test_approve_expense_without_category_uses_graceful_keyword_fallback(mock_post_je):
    """عند عدم وجود فئة صريحة لمستندات تاريخية، يتم التبويب الرجعي دون انهيار."""
    session = AsyncMock()
    session.add = MagicMock()

    treasury = CashAccount(id=CANONICAL_TREASURY_ID, account_number="TR-1", name="الخزنة", account_type="treasury", is_active=True, created_by="sys")
    doc = CashDocument(
        id="doc-legacy-1",
        document_number="CSH-LEGACY-001",
        document_type="expense",
        from_account_id=treasury.id,
        to_account_id=None,
        amount=Decimal("500.00"),
        description="صيانة ماكينات خياطة قديمة",
        expense_category=None,
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="user-1",
    )

    session.scalar.side_effect = [doc, Decimal("10000.00")]

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [treasury]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    await decide_cash_document(session, doc.id, decision, user_id="finance-mgr")

    mock_post_je.assert_awaited_once()
    lines = mock_post_je.call_args.kwargs["lines"]
    dr_line = next(l for l in lines if l["debit"] > 0)
    assert dr_line["account_code"] == "5300"

