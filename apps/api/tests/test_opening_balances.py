"""
اختبارات الأرصدة الافتتاحية وتاريخ بدء الدورة المحاسبية (ACC-01 / ACC-02):
- التحقق الصارم من توازن القيد الافتتاحي (المدين = الدائن).
- رفض ترحيل قيد افتتاحي غير متوازن ومنع التسوية الآلية في 3000.
- ترحيل القيد الافتتاحي المتوازن بحسابات الأصول والالتزامات وحقوق الملكية.
- منع تسجيل قيد افتتاحي مكرر (409).
- فحص العمليات السابقة (Pre-migration audit).
"""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError
from fastapi import HTTPException

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser
from app.modules.finance.models import (
    Account,
    JournalEntry,
    JournalEntryLine,
)
from app.modules.finance.schemas import (
    OpeningBalancesCreate,
)
from app.api.v1.endpoints.finance import (
    create_opening_balances,
    get_opening_balances,
    get_pre_migration_audit,
)


def test_opening_balances_schema_rejects_unbalanced_entry():
    """التحقق من رفض أي قيد افتتاحي غير متوازن برفع خطأ تحقق يمنع الحفظ."""
    with pytest.raises(ValidationError) as exc_info:
        OpeningBalancesCreate(
            accounting_start_date=date(2026, 11, 1),
            treasury_balance=Decimal("50000.00"),
            bank_balance=Decimal("100000.00"),
            accounts_receivable=Decimal("20000.00"),
            # Total Assets = 170,000
            accounts_payable=Decimal("30000.00"),
            paid_in_capital=Decimal("120000.00"),
            # Total Liab + Capital = 150,000 (Difference = 20,000)
        )
    assert "القيد الافتتاحي غير متوازن" in str(exc_info.value)
    assert "الفارق: 20000.00" in str(exc_info.value)


def test_opening_balances_schema_accepts_balanced_entry():
    """قبول القيد الافتتاحي المتوازن تماماً (الأصول = الالتزامات + رأس المال)."""
    ob = OpeningBalancesCreate(
        accounting_start_date=date(2026, 11, 1),
        treasury_balance=Decimal("50000.00"),
        bank_balance=Decimal("100000.00"),
        custody_balance=Decimal("10000.00"),
        accounts_receivable=Decimal("40000.00"),
        raw_materials_inventory=Decimal("80000.00"),
        wip_inventory=Decimal("20000.00"),
        finished_goods_inventory=Decimal("50000.00"),
        # Total Assets = 350,000.00
        accounts_payable=Decimal("70000.00"),
        paid_in_capital=Decimal("280000.00"),
        # Total Liabilities + Equity = 350,000.00
    )
    assert ob.accounting_start_date == date(2026, 11, 1)


@pytest.mark.asyncio
@patch("app.api.v1.endpoints.finance.post_journal_entry", new_callable=AsyncMock)
async def test_create_opening_balances_posts_balanced_je(mock_post_je):
    """ترحيل القيد الافتتاحي ينشئ قيد يومية برمز source_doc_type='opening_balance' وسطوره كاملة."""
    session = AsyncMock()
    session.scalar.return_value = None  # No prior opening balance
    user = AuthenticatedUser(id="fm-1", email="fm@factory.com", claims={"sub": "fm-1"})

    mock_je = MagicMock(spec=JournalEntry)
    mock_je.id = "je-ob-1"
    mock_je.entry_number = "JE-OB-20261101"
    mock_je.posted_at = datetime.now(timezone.utc)
    mock_je.created_at = datetime.now(timezone.utc)
    mock_post_je.return_value = mock_je

    payload = OpeningBalancesCreate(
        accounting_start_date=date(2026, 11, 1),
        treasury_balance=Decimal("50000.00"),
        bank_balance=Decimal("50000.00"),
        paid_in_capital=Decimal("100000.00"),
    )

    res = await create_opening_balances(payload, user, session)
    assert res.is_set is True
    assert res.is_balanced is True
    assert res.total_assets == Decimal("100000.00")
    assert res.total_liabilities_and_equity == Decimal("100000.00")
    assert res.journal_entry_number == "JE-OB-20261101"

    mock_post_je.assert_awaited_once()
    kwargs = mock_post_je.call_args.kwargs
    assert kwargs["source_doc_type"] == "opening_balance"
    assert kwargs["source_doc_id"] == "OB-2026-11-01"
    lines = kwargs["lines"]
    assert len(lines) == 3
    # Dr 1010, Dr 1030, Cr 3000
    codes = {l["account_code"] for l in lines}
    assert codes == {"1010", "1030", "3000"}


@pytest.mark.asyncio
async def test_create_opening_balances_rejects_duplicate():
    """منع تسجيل أكثر من قيد افتتاحي في نفس النظام دون تسوية أو إلغاء رسمي."""
    session = AsyncMock()
    session.scalar.return_value = "existing-ob-id"
    user = AuthenticatedUser(id="fm-1", email="fm@factory.com", claims={"sub": "fm-1"})

    payload = OpeningBalancesCreate(
        accounting_start_date=date(2026, 11, 1),
        treasury_balance=Decimal("10000.00"),
        paid_in_capital=Decimal("10000.00"),
    )

    with pytest.raises(HTTPException) as exc_info:
        await create_opening_balances(payload, user, session)
    assert exc_info.value.status_code == 409
    assert "مسبقاً" in exc_info.value.detail


@pytest.mark.asyncio
async def test_get_opening_balances_when_not_set():
    session = AsyncMock()
    session.scalar.return_value = None
    user = AuthenticatedUser(id="fm-1", email="fm@factory.com", claims={"sub": "fm-1"})

    res = await get_opening_balances(user, session)
    assert res.is_set is False
    assert "لم يتم تسجيل" in res.message


@pytest.mark.asyncio
async def test_get_pre_migration_audit():
    session = AsyncMock()
    session.scalar.side_effect = [
        Decimal("45000.00"),  # cash_total
        500.0,               # raw_qty
        150.0,               # fg_qty
        12,                  # je_count
        None,                # ob_entry
    ]
    user = AuthenticatedUser(id="fm-1", email="fm@factory.com", claims={"sub": "fm-1"})

    res = await get_pre_migration_audit(user, session)
    assert res["cash_ledger_total"] == 45000.0
    assert res["raw_materials_ledger_quantity"] == 500.0
    assert res["finished_goods_ledger_quantity"] == 150.0
    assert res["total_journal_entries"] == 12
    assert res["has_opening_balance"] is False

