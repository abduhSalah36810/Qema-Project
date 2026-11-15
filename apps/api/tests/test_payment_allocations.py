"""
اختبارات محرك تخصيص وتسوية المدفوعات والربط المالي (Phase 1: Payment Allocations Engine):
1. توجيه قيود اليومية تلقائياً:
   - سند صرف نقدي مع تحديد مورد (supplier_id) يُرحل مدين لحساب 2100 (الموردون) بدلاً من المصروفات العامة.
   - سند قبض نقدي مع تحديد عميل (customer_id) يُرحل دائن لحساب 1100 (العملاء) بدلاً من الإيرادات المتنوعة.
2. استعراض الدفعات غير المخصصة للمورد والعميل (Unallocated Payments).
3. تخصيص دفعة نقدية سابقة ومعتمدة على فاتورة مورد دون تكرار حركة الخزينة.
4. تخصيص دفعة تحصيل سابقة ومعتمدة على طلب عميل دون تكرار حركة الخزينة.
5. التحقق من كشف حساب المورد والعميل وتطابق الأرصدة.
"""
from datetime import datetime, timezone
from decimal import Decimal
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.core.auth import get_current_user
from app.core.permissions import ROLE_FINANCE_MANAGER, ROLE_GENERAL_MANAGER, ROLE_WAREHOUSE_MANAGER
from app.db.session import get_db
from app.main import app
from app.modules.customers.models import Customer, CustomerOrder, CustomerOrderLine, CustomerDelivery, CustomerDeliveryLine
from app.modules.finance.models import (
    Account, CashAccount, CashDocument, CashLedgerEntry, JournalEntry, JournalEntryLine,
    PaymentAllocation, Supplier, SupplierInvoice, SupplierInvoiceLine, SupplierPayment, SupplierReceipt,
)
from app.modules.finance.balances import customer_order_financials, supplier_invoice_financials
from app.modules.production.models import CatalogItem, Product, ProductVariant, Unit, Warehouse
from tests.test_stocktake import make_auth_user


def _as(user_id: str, role: str) -> None:
    app.dependency_overrides[get_current_user] = lambda: make_auth_user(user_id, role)


@pytest.fixture
async def client(session):
    app.dependency_overrides[get_db] = lambda: session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_direct_cash_documents_party_journal_routing(client, session):
    """
    سند صرف لمورد يُرحل إلى 2100 (موردون) وسند قبض لعميل يُرحل إلى 1100 (عملاء).
    """
    treasury = await session.scalar(select(CashAccount).where(CashAccount.account_type == "treasury"))
    assert treasury is not None, "الخزنة الرئيسية غير مهيأة"

    # إنشاء مورد وعميل للاختبار
    supplier_code = f"SUP-ALLOC-{uuid.uuid4().hex[:6]}"
    supplier = Supplier(
        id=str(uuid.uuid4()), code=supplier_code, name="شركة التوريدات المتحدة", phone="01011111111", created_by="sys",
    )
    customer_code = f"CUST-ALLOC-{uuid.uuid4().hex[:6]}"
    customer = Customer(
        id=str(uuid.uuid4()), code=customer_code, name="عميل التوزيع الذهبي", phone="01022222222",
    )
    session.add(supplier)
    session.add(customer)
    await session.commit()

    _as("fm_user", ROLE_FINANCE_MANAGER)
    now_iso = datetime.now(timezone.utc).isoformat()

    # تغذية الخزينة برصيد كافٍ للاختبار
    await client.post("/api/v1/finance/cash-documents", json={
        "document_type": "income",
        "to_account_id": treasury.id,
        "amount": "50000.00",
        "description": "تغذية خزينة للاختبار",
        "occurred_at": now_iso,
    })

    # 1. سند صرف نقدي موجه للمورد
    disbursement_resp = await client.post("/api/v1/finance/cash-documents", json={
        "document_type": "expense",
        "from_account_id": treasury.id,
        "amount": "5500.00",
        "description": "دفعة مقدمة تحت الحساب للمورد شركة التوريدات",
        "supplier_id": supplier.id,
        "occurred_at": now_iso,
    })
    assert disbursement_resp.status_code == 201, disbursement_resp.text
    disb_data = disbursement_resp.json()
    assert disb_data["supplier_id"] == supplier.id
    assert disb_data["status"] == "approved"  # المدير المالي يعتمد فوراً

    # التحقق من قيد اليومية: Dr 2100 / Cr 1110
    je_disb = await session.scalar(
        select(JournalEntry).where(JournalEntry.source_doc_id == disb_data["id"])
    )
    assert je_disb is not None
    lines_disb = (await session.scalars(
        select(JournalEntryLine).where(JournalEntryLine.entry_id == je_disb.id)
    )).all()
    accounts_by_code = {
        (await session.get(Account, l.account_id)).code: l for l in lines_disb
    }
    assert "2100" in accounts_by_code, "يجب أن يكون القيد مديناً لحساب الموردين 2100"
    assert accounts_by_code["2100"].debit == Decimal("5500.00")
    assert "1010" in accounts_by_code, "يجب أن يكون القيد دائناً للخزينة 1010"
    assert accounts_by_code["1010"].credit == Decimal("5500.00")

    # 2. سند قبض نقدي موجه للعميل
    receipt_resp = await client.post("/api/v1/finance/cash-documents", json={
        "document_type": "income",
        "to_account_id": treasury.id,
        "amount": "3200.00",
        "description": "تحصيل مقدم تحت الحساب من عميل التوزيع",
        "customer_id": customer.id,
        "occurred_at": now_iso,
    })
    assert receipt_resp.status_code == 201, receipt_resp.text
    rec_data = receipt_resp.json()
    assert rec_data["customer_id"] == customer.id
    assert rec_data["status"] == "approved"

    # التحقق من قيد اليومية: Dr 1010 / Cr 1100
    je_rec = await session.scalar(
        select(JournalEntry).where(JournalEntry.source_doc_id == rec_data["id"])
    )
    assert je_rec is not None
    lines_rec = (await session.scalars(
        select(JournalEntryLine).where(JournalEntryLine.entry_id == je_rec.id)
    )).all()
    accounts_by_code_rec = {
        (await session.get(Account, l.account_id)).code: l for l in lines_rec
    }
    assert "1010" in accounts_by_code_rec, "يجب أن يكون القيد مديناً للخزينة 1010"
    assert accounts_by_code_rec["1010"].debit == Decimal("3200.00")
    assert "1100" in accounts_by_code_rec, "يجب أن يكون القيد دائناً لحساب العملاء 1100"
    assert accounts_by_code_rec["1100"].credit == Decimal("3200.00")


@pytest.mark.asyncio
async def test_supplier_payment_allocation_lifecycle(client, session):
    """
    دورة سيناريو شركة الأمل:
    - صرف دفعة 5,500 ج.م في الخزينة لحساب المورد كدفعة معلقة / مقدمة.
    - استلام فاتورة شراء بقيمة 5,000 ج.م وبضاعة مستلمة بالكامل.
    - استعراض الدفعات غير المخصصة للمورد.
    - تخصيص 5,000 ج.م للفاتورة وتسويتها بالكامل دون تكرار حركة الخزينة.
    - بقاء 500 ج.م رصيد دفعة مقدمة غير مخصصة.
    """
    treasury = await session.scalar(select(CashAccount).where(CashAccount.account_type == "treasury"))
    unit = await session.scalar(select(Unit).where(Unit.code == "meter"))
    raw_wh = await session.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    assert treasury and unit and raw_wh

    _as("fm_user", ROLE_FINANCE_MANAGER)
    now_iso = datetime.now(timezone.utc).isoformat()

    # تغذية الخزينة برصيد كافٍ للاختبار
    await client.post("/api/v1/finance/cash-documents", json={
        "document_type": "income",
        "to_account_id": treasury.id,
        "amount": "50000.00",
        "description": "تغذية خزينة للاختبار",
        "occurred_at": now_iso,
    })

    supplier = Supplier(
        id=str(uuid.uuid4()), code=f"SUP-AML-{uuid.uuid4().hex[:6]}", name="شركة الأمل للغزل", phone="01033333333", created_by="sys",
    )
    item = CatalogItem(
        id=str(uuid.uuid4()), code=f"RAW-AML-{uuid.uuid4().hex[:6]}", name_ar="قماش قطن الأمل",
        item_type="fabric", unit_id=unit.id, classification_status="confirmed", approval_status="approved",
        is_active=True,
    )
    session.add(supplier)
    session.add(item)
    await session.commit()

    _as("fm_user", ROLE_FINANCE_MANAGER)
    now_iso = datetime.now(timezone.utc).isoformat()

    # 1. صرف دفعة نقدية معتمدة 5,500 ج.م من الخزينة لحساب شركة الأمل
    csh_resp = await client.post("/api/v1/finance/cash-documents", json={
        "document_type": "expense",
        "from_account_id": treasury.id,
        "amount": "5500.00",
        "description": "دفعة نقدية مسددة لشركة الأمل للغزل",
        "supplier_id": supplier.id,
        "occurred_at": now_iso,
    })
    assert csh_resp.status_code == 201
    cash_doc_id = csh_resp.json()["id"]

    # 2. إنشاء فاتورة شراء بقيمة 5,000 ج.م (50 متراً × 100 ج.م)
    inv_resp = await client.post("/api/v1/finance/supplier-invoices", json={
        "supplier_id": supplier.id,
        "invoice_number": f"INV-{uuid.uuid4().hex[:6]}",
        "invoice_date": datetime.now(timezone.utc).isoformat(),
        "lines": [{
            "item_id": item.id,
            "unit_id": unit.id,
            "invoiced_quantity": 50.0,
            "unit_price": "100.00",
            "discount_amount": "0.00",
            "notes": "توريد قماش",
        }],
        "notes": "فاتورة توريد قماش الأمل",
    })
    assert inv_resp.status_code == 201, inv_resp.text
    invoice_id = inv_resp.json()["id"]

    # إثبات استلام كامل الكمية بواسطة أمين المخزن
    _as("wh_user", ROLE_WAREHOUSE_MANAGER)
    line_id = inv_resp.json()["lines"][0]["id"]
    rcv_resp = await client.post(f"/api/v1/finance/supplier-invoices/{invoice_id}/receive", json={
        "lines": [{"line_id": line_id, "received_quantity": 50.0}],
        "notes": "استلام كامل خامات الأمل",
    })
    assert rcv_resp.status_code == 200, rcv_resp.text
    assert rcv_resp.json()["status"] == "received"

    # التحقق من البيانات المالية بواسطة المدير المالي
    _as("fm_user", ROLE_FINANCE_MANAGER)
    inv_check_before = await client.get(f"/api/v1/finance/supplier-invoices/{invoice_id}")
    assert inv_check_before.status_code == 200
    assert Decimal(str(inv_check_before.json()["received_value"])) == Decimal("5000.00")
    assert Decimal(str(inv_check_before.json()["payable_balance"])) == Decimal("5000.00")
    assert Decimal(str(inv_check_before.json()["paid_total"])) == Decimal("0.00")

    # 3. فحص الدفعات غير المخصصة للمورد
    unallocated_resp = await client.get(f"/api/v1/finance/suppliers/{supplier.id}/unallocated-payments")
    assert unallocated_resp.status_code == 200
    unalloc_list = unallocated_resp.json()
    assert len(unalloc_list) == 1
    assert unalloc_list[0]["cash_document_id"] == cash_doc_id
    assert Decimal(str(unalloc_list[0]["total_amount"])) == Decimal("5500.00")
    assert Decimal(str(unalloc_list[0]["allocated_amount"])) == Decimal("0.00")
    assert Decimal(str(unalloc_list[0]["unallocated_amount"])) == Decimal("5500.00")

    # فحص عدد حركات الخزينة قبل التخصيص
    ledger_count_before = await session.scalar(
        select(func.count(CashLedgerEntry.id)).where(CashLedgerEntry.document_id == cash_doc_id)
    )

    # 4. محاولة تخصيص مبلغ أكبر من المستحق على الفاتورة (5,000) يجب أن تُرفض
    over_resp = await client.post(f"/api/v1/finance/supplier-invoices/{invoice_id}/allocate-payment", json={
        "cash_document_id": cash_doc_id,
        "amount": "5500.00",
        "notes": "محاولة تخصيص زائد",
    })
    assert over_resp.status_code == 409

    # 5. تخصيص المستحق الفعلي 5,000 ج.م على الفاتورة
    alloc_resp = await client.post(f"/api/v1/finance/supplier-invoices/{invoice_id}/allocate-payment", json={
        "cash_document_id": cash_doc_id,
        "amount": "5000.00",
        "notes": "تسوية وسداد من الدفعة النقدية المسددة مسبقاً",
    })
    assert alloc_resp.status_code == 200, alloc_resp.text
    alloc_data = alloc_resp.json()
    assert alloc_data["supplier_invoice_id"] == invoice_id
    assert Decimal(str(alloc_data["allocated_amount"])) == Decimal("5000.00")

    # 6. التحقق من عدم تكرار حركة الخزينة (Zero duplicate deduction)
    ledger_count_after = await session.scalar(
        select(func.count(CashLedgerEntry.id)).where(CashLedgerEntry.document_id == cash_doc_id)
    )
    assert ledger_count_after == ledger_count_before, "لا يجوز إنشاء حركة جديدة في دفتر النقدية عند التخصيص"

    # 7. التحقق من تحديث الفاتورة لتصبح مسددة بالكامل
    inv_check = await client.get(f"/api/v1/finance/supplier-invoices/{invoice_id}")
    assert inv_check.status_code == 200
    inv_data = inv_check.json()
    assert Decimal(str(inv_data["paid_total"])) == Decimal("5000.00")
    assert Decimal(str(inv_data["payable_balance"])) == Decimal("0.00")
    assert Decimal(str(inv_data["balance_due"])) == Decimal("0.00")

    # 8. التحقق من تحديث رصيد الدفعة غير المخصصة للمورد (باقٍ 500 ج.م)
    unalloc_check = await client.get(f"/api/v1/finance/suppliers/{supplier.id}/unallocated-payments")
    assert unalloc_check.status_code == 200
    unalloc_list_after = unalloc_check.json()
    assert len(unalloc_list_after) == 1
    assert Decimal(str(unalloc_list_after[0]["allocated_amount"])) == Decimal("5000.00")
    assert Decimal(str(unalloc_list_after[0]["unallocated_amount"])) == Decimal("500.00")

    # 9. فحص كشف حساب المورد
    stmt_resp = await client.get(f"/api/v1/reports/supplier-statement/{supplier.id}")
    assert stmt_resp.status_code == 200
    stmt_data = stmt_resp.json()
    assert Decimal(str(stmt_data["totals"]["total_received"])) == Decimal("5000.00")
    assert Decimal(str(stmt_data["totals"]["total_paid"])) == Decimal("5500.00")
    # رصيد المورد: 5000 مستلم − 5500 مدفوع = −500 (دفعة مقدمة لصالح المصنع)
    assert Decimal(str(stmt_data["totals"]["balance_due"])) == Decimal("-500.00")


@pytest.mark.asyncio
async def test_customer_payment_allocation_lifecycle(client, session):
    """
    دورة تحصيل وتخصيص دفعات العملاء:
    - تحصيل دفعة مقدمة 4,000 ج.م من العميل في الخزينة.
    - إنشاء طلب بيع بقيمة 3,000 ج.م وتسليمه.
    - استعراض تحصيلات العميل غير المخصصة.
    - تخصيص 3,000 ج.م على الطلب وتسويته دون تكرار حركة الخزينة.
    - بقاء 1,000 ج.م رصيد تحصيل غير مخصص.
    """
    treasury = await session.scalar(select(CashAccount).where(CashAccount.account_type == "treasury"))
    unit = await session.scalar(select(Unit).where(Unit.code == "piece"))
    fg_wh = await session.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    assert treasury and unit and fg_wh

    customer = Customer(
        id=str(uuid.uuid4()), code=f"CUST-ALC-{uuid.uuid4().hex[:6]}", name="مؤسسة النور للتجارة", phone="01044444444",
    )
    product = Product(
        id=str(uuid.uuid4()), code=f"PRD-ALC-{uuid.uuid4().hex[:6]}", name_ar="قميص كلاسيك النور", style_type="standard",
    )
    session.add(customer)
    session.add(product)
    await session.flush()

    variant = ProductVariant(
        id=str(uuid.uuid4()), product_id=product.id, numeric_size=42, letter_size="L", season="صيفي",
        sku=f"SKU-{uuid.uuid4().hex[:6]}",
    )
    session.add(variant)
    await session.commit()

    _as("fm_user", ROLE_FINANCE_MANAGER)
    now_iso = datetime.now(timezone.utc).isoformat()

    # 1. تحصيل دفعة نقدية معتمدة 4,000 ج.م في الخزينة لحساب مؤسسة النور
    csh_resp = await client.post("/api/v1/finance/cash-documents", json={
        "document_type": "income",
        "to_account_id": treasury.id,
        "amount": "4000.00",
        "description": "تحصيل مقدم تحت الحساب من مؤسسة النور",
        "customer_id": customer.id,
        "occurred_at": now_iso,
    })
    assert csh_resp.status_code == 201
    cash_doc_id = csh_resp.json()["id"]

    # 2. إنشاء طلب بيع بقيمة 3,000 ج.م (10 قطع × 300 ج.م)
    order_resp = await client.post(f"/api/v1/customers/{customer.id}/orders", json={
        "order_type": "ready_goods",
        "discount_amount": "0.00",
        "payment_terms": "نقداً عند الاستلام",
        "notes": "طلب تجريبي للتخصيص",
        "lines": [{
            "product_id": product.id,
            "variant_id": variant.id,
            "quantity": 10.0,
            "unit_price": "300.00",
            "notes": "مقاس L",
        }],
    })
    assert order_resp.status_code == 201, order_resp.text
    order_id = order_resp.json()["id"]

    # 3. فحص التحصيلات غير المخصصة للعميل
    unalloc_resp = await client.get(f"/api/v1/customers/{customer.id}/unallocated-payments")
    assert unalloc_resp.status_code == 200
    unalloc_list = unalloc_resp.json()
    assert len(unalloc_list) == 1
    assert unalloc_list[0]["cash_document_id"] == cash_doc_id
    assert Decimal(str(unalloc_list[0]["unallocated_amount"])) == Decimal("4000.00")

    # 4. محاولة تخصيص أكثر من قيمة الطلب (4,000 > 3,000) يجب أن تُرفض
    over_resp = await client.post(f"/api/v1/customers/{customer.id}/orders/{order_id}/allocate-payment", json={
        "cash_document_id": cash_doc_id,
        "amount": "4000.00",
        "notes": "محاولة تخصيص زائد",
    })
    assert over_resp.status_code == 409

    # 5. تخصيص 3,000 ج.م للطلب
    alloc_resp = await client.post(f"/api/v1/customers/{customer.id}/orders/{order_id}/allocate-payment", json={
        "cash_document_id": cash_doc_id,
        "amount": "3000.00",
        "notes": "تخصيص من التحصيل المقدم المسجل في الخزينة",
    })
    assert alloc_resp.status_code == 200, alloc_resp.text
    alloc_data = alloc_resp.json()
    assert alloc_data["customer_order_id"] == order_id
    assert Decimal(str(alloc_data["allocated_amount"])) == Decimal("3000.00")

    # 6. التحقق من كشف حساب العميل ورصيد الطلب
    unalloc_check = await client.get(f"/api/v1/customers/{customer.id}/unallocated-payments")
    assert unalloc_check.status_code == 200
    assert Decimal(str(unalloc_check.json()[0]["unallocated_amount"])) == Decimal("1000.00")

    # فحص شاشة حساب العميل (Customer Account)
    acc_resp = await client.get(f"/api/v1/customers/{customer.id}/account")
    assert acc_resp.status_code == 200
    orders = acc_resp.json()["orders"]
    assert len(orders) == 1
    assert Decimal(str(orders[0]["paid_amount"])) == Decimal("3000.00")
    assert Decimal(str(orders[0]["balance_amount"])) == Decimal("0.00")
    # قائمة الدفعات بالطلب تحتوي التخصيص
    payments = orders[0]["payments"]
    assert any(p["method"] == "allocation" and Decimal(str(p["amount"])) == Decimal("3000.00") for p in payments)
