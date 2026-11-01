import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry, SupplierPayment
from app.modules.finance.schemas import CashDocumentCreate, CashDocumentDecision


async def create_cash_document(db: AsyncSession, data: CashDocumentCreate, user_id: str) -> CashDocument:
    if data.source_system and data.source_reference:
        existing = await db.scalar(select(CashDocument.id).where(
            CashDocument.source_system == data.source_system,
            CashDocument.source_reference == data.source_reference,
        ))
        if existing:
            raise HTTPException(409, "تم تسجيل العملية المرتبطة بهذا المرجع من قبل.")
    account_ids = [value for value in (data.from_account_id, data.to_account_id) if value]
    accounts = (await db.scalars(select(CashAccount).where(CashAccount.id.in_(account_ids)))).all()
    by_id = {account.id: account for account in accounts}
    if len(by_id) != len(set(account_ids)) or any(not by_id[account_id].is_active for account_id in account_ids):
        raise HTTPException(404, "الحساب النقدي غير موجود أو موقوف.")
    if data.document_type == "transfer":
        source, destination = by_id[data.from_account_id], by_id[data.to_account_id]
        if source.account_type == "petty_cash" and destination.account_type != "treasury":
            raise HTTPException(422, "تسوية العهدة تكون بإرجاع المتبقي إلى الخزنة الرئيسية.")
        if source.account_type == "treasury" and destination.account_type == "petty_cash" and destination.parent_account_id != source.id:
            raise HTTPException(422, "العهدة غير مرتبطة بالخزنة المحددة.")
    elif data.document_type == "expense" and by_id[data.from_account_id].account_type not in ("treasury", "petty_cash"):
        raise HTTPException(422, "مصدر الصرف غير صالح.")
    elif data.document_type == "income" and by_id[data.to_account_id].account_type != "treasury":
        raise HTTPException(422, "تسجل الإيرادات في الخزنة الرئيسية.")
    document = CashDocument(
        id=str(uuid.uuid4()), document_number=f"CSH-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:8].upper()}",
        document_type=data.document_type, from_account_id=data.from_account_id, to_account_id=data.to_account_id,
        amount=data.amount, description=data.description, occurred_at=data.occurred_at,
        source_system=data.source_system, source_reference=data.source_reference, created_by=user_id,
    )
    db.add(document)
    await db.commit()
    await db.refresh(document)
    return document


async def decide_cash_document(db: AsyncSession, document_id: str, data: CashDocumentDecision, user_id: str) -> CashDocument:
    document = await db.scalar(select(CashDocument).where(CashDocument.id == document_id).with_for_update())
    if not document:
        raise HTTPException(404, "المستند النقدي غير موجود.")
    if document.status != "pending":
        raise HTTPException(409, "تمت معالجة هذا المستند ولا يمكن اعتماده أو رفضه مرة أخرى.")
    if data.decision == "reject":
        if not data.rejection_reason:
            raise HTTPException(422, "سبب الرفض مطلوب.")
        document.status = "rejected"
        document.rejected_by = user_id
        document.rejected_at = datetime.now(timezone.utc)
        document.rejection_reason = data.rejection_reason
        if document.source_system == "supplier_payment" and document.source_reference:
            payment = await db.scalar(select(SupplierPayment).where(SupplierPayment.id == document.source_reference).with_for_update())
            if payment and payment.status == "pending":
                payment.status = "rejected"
                payment.decided_by = user_id
                payment.decided_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(document)
        return document
    account_ids = sorted(value for value in (document.from_account_id, document.to_account_id) if value)
    accounts = (await db.scalars(select(CashAccount).where(CashAccount.id.in_(account_ids)).order_by(CashAccount.id).with_for_update())).all()
    if len(accounts) != len(account_ids):
        raise HTTPException(409, "أحد الحسابات المرتبطة بالمستند لم يعد متاحاً.")
    if document.from_account_id:
        balance = await db.scalar(select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == document.from_account_id))
        if Decimal(str(balance)) < document.amount:
            raise HTTPException(409, "الرصيد غير كافٍ لاعتماد الصرف.")
        db.add(CashLedgerEntry(document_id=document.id, account_id=document.from_account_id, amount=-document.amount, created_by=user_id))
    if document.to_account_id:
        db.add(CashLedgerEntry(document_id=document.id, account_id=document.to_account_id, amount=document.amount, created_by=user_id))
    document.status = "approved"
    document.approved_by = user_id
    document.approved_at = datetime.now(timezone.utc)
    if document.source_system == "supplier_payment" and document.source_reference:
        payment = await db.scalar(select(SupplierPayment).where(SupplierPayment.id == document.source_reference).with_for_update())
        if not payment or payment.status != "pending":
            raise HTTPException(409, "حالة دفعة المورد لا تتوافق مع المستند النقدي.")
        payment.status = "approved"
        payment.decided_by = user_id
        payment.decided_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(document)
    return document
