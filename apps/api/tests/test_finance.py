import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

import app.db.base  # noqa: F401 - ensures all SQLAlchemy mappers are configured
from app.core.auth import AuthenticatedUser
from app.modules.finance.models import (
    CashAccount,
    CashDocument,
    CashLedgerEntry,
    Supplier,
    SupplierInvoice,
    SupplierInvoiceLine,
    SupplierPayment,
)
from app.modules.finance.schemas import (
    CashDocumentCreate,
    CashDocumentDecision,
    SupplierCreate,
    SupplierReceiptConfirm,
    SupplierReceiptLine,
)
from app.modules.finance.service import create_cash_document, decide_cash_document
from app.api.v1.endpoints.finance import create_supplier, confirm_supplier_receipt
from app.modules.production.models import CatalogItem, Unit, Warehouse


@pytest.mark.asyncio
async def test_create_cash_document_rejects_duplicate_source_reference():
    session = AsyncMock()
    session.scalar.return_value = "existing-doc-id"
    payload = CashDocumentCreate(
        document_type="income",
        from_account_id=None,
        to_account_id="treasury-id",
        amount=Decimal("1500.00"),
        description="تحصيل عميل",
        occurred_at=datetime.now(timezone.utc),
        source_system="customer_payment",
        source_reference="payment-123",
    )
    with pytest.raises(HTTPException) as exc_info:
        await create_cash_document(session, payload, user_id="user-1")
    assert exc_info.value.status_code == 409
    assert "تسجيل" in exc_info.value.detail


@pytest.mark.asyncio
async def test_decide_cash_document_rejects_insufficient_balance():
    session = AsyncMock()
    doc = CashDocument(
        id="doc-1",
        document_number="CSH-001",
        document_type="expense",
        from_account_id="acc-treasury",
        to_account_id=None,
        amount=Decimal("5000.00"),
        description="صرف مشتريات",
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="user-1",
    )
    account = CashAccount(id="acc-treasury", account_number="TR-01", name="الخزنة", account_type="treasury", is_active=True, created_by="user-1")
    session.scalar.side_effect = [doc, Decimal("1000.00")]  # document, then balance
    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [account]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    with pytest.raises(HTTPException) as exc_info:
        await decide_cash_document(session, "doc-1", decision, user_id="finance-mgr")
    assert exc_info.value.status_code == 409
    assert "الرصيد غير كافٍ" in exc_info.value.detail


@pytest.mark.asyncio
async def test_decide_cash_document_approves_when_balance_sufficient():
    session = AsyncMock()
    session.add = MagicMock()
    doc = CashDocument(
        id="doc-1",
        document_number="CSH-001",
        document_type="expense",
        from_account_id="acc-treasury",
        to_account_id=None,
        amount=Decimal("500.00"),
        description="صرف صيانة",
        occurred_at=datetime.now(timezone.utc),
        status="pending",
        created_by="user-1",
    )
    account = CashAccount(id="acc-treasury", account_number="TR-01", name="الخزنة", account_type="treasury", is_active=True, created_by="user-1")
    session.scalar.side_effect = [doc, Decimal("2000.00")]  # document, then balance
    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [account]
    session.scalars.return_value = scalars_mock

    decision = CashDocumentDecision(decision="approve")
    approved = await decide_cash_document(session, "doc-1", decision, user_id="finance-mgr")
    assert approved.status == "approved"
    assert approved.approved_by == "finance-mgr"
    session.add.assert_called_once()
    ledger_entry = session.add.call_args[0][0]
    assert isinstance(ledger_entry, CashLedgerEntry)
    assert ledger_entry.amount == -Decimal("500.00")
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_supplier_rejects_duplicate_code():
    session = AsyncMock()
    session.scalar.return_value = "existing-supp-id"
    manager = AuthenticatedUser(id="mgr-1", email=None, claims={"sub": "mgr-1"})

    payload = SupplierCreate(code="SUP-01", name="مورد الأقمشة", phone="0123456789", address="العاشر من رمضان")
    with pytest.raises(HTTPException) as exc_info:
        await create_supplier(payload, manager, session)
    assert exc_info.value.status_code == 409
    assert "كود المورد مستخدم" in exc_info.value.detail
