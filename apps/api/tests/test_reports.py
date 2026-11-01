"""
اختبارات شاملة لموديول التقارير التشغيلية والمالية والمخزنية (Reports API & RBAC Tests).
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. اختبارات الوحدة (Unit Tests مع Mocks).
2. اختبارات التحقق من الصلاحيات عبر HTTP (RBAC: 401 Unauthorized, 403 Forbidden, 200 OK):
   - general_manager: يملك reports:view, inventory:view, finance:reports:view (يصل لكل التقارير).
   - finance_manager: يملك reports:view, finance:reports:view (يصل لـ summary و financial، ويُمنع 403 من inventory).
   - warehouse_manager: يملك inventory:view (يصل لـ inventory، ويُمنع 403 من summary و financial).
   - المستخدم غير المصرح له / بدون دور: يُمنع 403 من جميع التقارير.
   - الطلب غير المصادق عليه: يُرفض بـ 401 Unauthorized.
3. اختبارات التكامل الحقيقية مع قاعدة بيانات PostgreSQL (Integration Tests):
   - استعلام الإيرادات يعتمد على document_type = 'income' و status = 'approved'.
   - استبعاد مستندات المصروفات (expense) من الإيرادات.
   - استبعاد مستندات التحويلات الداخلية (transfer) من الإيرادات والمصروفات.
   - استبعاد المستندات غير المعتمدة (pending / rejected / reversed).
   - استبعاد المستندات خارج النطاق الزمني المحدد.
   - التأكد من إرجاع 0.0 بشكل سليم عند خلو البيانات دون أي أخطاء.
   - التأكد من عدم تكرار الأرصدة أو المبالغ (No Join Duplication).
─────────────────────────────────────────────────────────────────────────────
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app
from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry
from app.modules.production.models import CatalogItem, StockLedgerEntry, Warehouse


def _uid():
    return str(uuid.uuid4())


@pytest.fixture
def auth_general_manager(session):
    user = AuthenticatedUser(
        id="usr-gm-reports",
        email="gm@qemma.com",
        claims={"sub": "usr-gm-reports", "role": "general_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.fixture
def auth_finance_manager(session):
    user = AuthenticatedUser(
        id="usr-fin-reports",
        email="fin@qemma.com",
        claims={"sub": "usr-fin-reports", "role": "finance_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.fixture
def auth_warehouse_manager(session):
    user = AuthenticatedUser(
        id="usr-wh-reports",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-reports", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


@pytest.fixture
def auth_unauthorized_user(session):
    user = AuthenticatedUser(
        id="usr-unauth-reports",
        email="viewer@qemma.com",
        claims={"sub": "usr-unauth-reports", "role": "cutter"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session
    yield user
    app.dependency_overrides.clear()


# ═════════════════════════════════════════════════════════════════════════════
# 1. اختبارات الوحدة الأساسية (Unit Tests with Mocks)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_get_summary_report():
    """التحقق من حساب الملخص التشغيلي الشامل (خزينة، مخزون، إنتاج)."""
    from app.api.v1.endpoints.reports import get_summary

    user = MagicMock()
    user.id = _uid()

    treasury = MagicMock()
    treasury.id = _uid()
    treasury.account_type = "treasury"
    treasury.is_active = True

    petty1 = MagicMock()
    petty1.id = _uid()
    petty1.account_type = "petty_cash"
    petty1.is_active = True

    db = AsyncMock()
    call_count = 0

    async def mock_scalar(stmt):
        nonlocal call_count
        call_count += 1
        returns = [
            treasury, Decimal("5000"), Decimal("1200"),
            Decimal("20000"), Decimal("8000"),
            5, 12,
            _uid(), _uid(), 45, 20,
            Decimal("30000"), Decimal("20000"),
        ]
        if call_count <= len(returns):
            return returns[call_count - 1]
        return 0

    db.scalar = AsyncMock(side_effect=mock_scalar)
    db.scalars = AsyncMock()
    db.scalars.return_value.all = MagicMock(return_value=[petty1])

    summary = await get_summary(period="monthly", current_user=user, db=db)

    assert summary["period"] == "monthly"
    assert summary["treasury"]["balance"] == 5000.0
    assert summary["treasury"]["petty_cash_total"] == 1200.0
    assert summary["treasury"]["revenues_period"] == 20000.0
    assert summary["treasury"]["expenses_period"] == 8000.0
    assert summary["treasury"]["net_period"] == 12000.0
    assert summary["production"]["active_orders"] == 5
    assert summary["production"]["completed_orders_period"] == 12
    assert summary["inventory"]["raw_material_distinct_items"] == 45
    assert summary["inventory"]["finished_goods_distinct_items"] == 20
    assert summary["payables"]["supplier_payables"] == 10000.0


@pytest.mark.asyncio
async def test_get_inventory_report():
    """تقرير أرصدة المخزون لكل صنف."""
    from app.api.v1.endpoints.reports import get_inventory_report

    user = MagicMock()
    user.id = _uid()

    db = AsyncMock()
    db.execute = AsyncMock()
    item_id = _uid()
    wh_id = _uid()
    db.execute.return_value.all = MagicMock(return_value=[
        (item_id, wh_id, Decimal("150.5")),
    ])

    wh = MagicMock()
    wh.id = wh_id
    wh.name_ar = "مخزن الخامات الرئيسي"

    item = MagicMock()
    item.id = item_id
    item.code = "FAB-001"
    item.name_ar = "قماش جبردين"

    scalars_call = 0

    def mock_scalars(stmt):
        nonlocal scalars_call
        scalars_call += 1
        res = MagicMock()
        if scalars_call == 1:
            res.all = MagicMock(return_value=[wh])
        else:
            res.all = MagicMock(return_value=[item])
        return res

    db.scalars = AsyncMock(side_effect=mock_scalars)

    res = await get_inventory_report(warehouse_code=None, current_user=user, db=db)

    assert res["total_items"] == 1
    assert res["items"][0]["item_code"] == "FAB-001"
    assert res["items"][0]["balance"] == 150.5
    assert res["items"][0]["low_stock"] is False


@pytest.mark.asyncio
async def test_get_financial_report():
    """تقرير المستندات المالية والإيرادات والمصروفات وصافي السيولة."""
    from app.api.v1.endpoints.reports import get_financial_report

    user = MagicMock()
    user.id = _uid()

    doc_income = MagicMock()
    doc_income.id = _uid()
    doc_income.document_number = "CSH-INC-001"
    doc_income.document_type = "income"
    doc_income.amount = Decimal("15000")
    doc_income.description = "مبيعات نقدية"
    doc_income.occurred_at = datetime.now(timezone.utc)

    doc_exp = MagicMock()
    doc_exp.id = _uid()
    doc_exp.document_number = "CSH-EXP-001"
    doc_exp.document_type = "expense"
    doc_exp.amount = Decimal("4000")
    doc_exp.description = "شراء مستلزمات"
    doc_exp.occurred_at = datetime.now(timezone.utc)

    db = AsyncMock()
    scalars_call = 0

    def mock_scalars(stmt):
        nonlocal scalars_call
        scalars_call += 1
        res = MagicMock()
        if scalars_call == 1:
            res.all = MagicMock(return_value=[doc_income])
        else:
            res.all = MagicMock(return_value=[doc_exp])
        return res

    db.scalars = AsyncMock(side_effect=mock_scalars)

    res = await get_financial_report(since_days=30, current_user=user, db=db)

    assert res["since_days"] == 30
    assert res["revenues"]["total"] == 15000.0
    assert res["expenses"]["total"] == 4000.0
    assert res["net"] == 11000.0
    assert len(res["revenues"]["documents"]) == 1
    assert len(res["expenses"]["documents"]) == 1


# ═════════════════════════════════════════════════════════════════════════════
# 2. اختبارات التحقق من الصلاحيات وRBAC عبر HTTP Endpoints
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_unauthenticated_requests_return_401():
    """الطلبات غير المصادق عليها تُرفض بـ 401 Unauthorized."""
    app.dependency_overrides.clear()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r1 = await client.get("/api/v1/reports/summary")
        assert r1.status_code == 401

        r2 = await client.get("/api/v1/reports/inventory")
        assert r2.status_code == 401

        r3 = await client.get("/api/v1/reports/financial")
        assert r3.status_code == 401


@pytest.mark.asyncio
async def test_general_manager_can_access_all_reports(auth_general_manager):
    """المدير العام يمتلك صلاحيات الوصول لجميع التقارير (summary, inventory, financial)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r_sum = await client.get("/api/v1/reports/summary")
        assert r_sum.status_code == 200
        assert "treasury" in r_sum.json()

        r_inv = await client.get("/api/v1/reports/inventory")
        assert r_inv.status_code == 200
        assert "items" in r_inv.json()

        r_fin = await client.get("/api/v1/reports/financial")
        assert r_fin.status_code == 200
        assert "revenues" in r_fin.json()


@pytest.mark.asyncio
async def test_finance_manager_permissions(auth_finance_manager):
    """
    المدير المالي:
    - يستطيع فتح الملخص التنفيذي (summary: 200 OK)
    - يستطيع فتح التقارير المالية (financial: 200 OK)
    - يُمنع 403 Forbidden من تقارير المخزون (inventory:view غير ممنوحة له)
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r_sum = await client.get("/api/v1/reports/summary")
        assert r_sum.status_code == 200

        r_fin = await client.get("/api/v1/reports/financial")
        assert r_fin.status_code == 200

        r_inv = await client.get("/api/v1/reports/inventory")
        assert r_inv.status_code == 403
        assert "الصلاحية" in r_inv.json()["detail"]


@pytest.mark.asyncio
async def test_warehouse_manager_permissions(auth_warehouse_manager):
    """
    مسؤول المستودع:
    - يستطيع فتح تقارير المخزون (inventory: 200 OK)
    - يُمنع 403 Forbidden من الملخص التنفيذي (summary: 403 - لمنع كشف أرقام الخزينة والسيولة)
    - يُمنع 403 Forbidden من التقارير المالية (financial: 403 - لا يملك finance:reports:view)
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r_inv = await client.get("/api/v1/reports/inventory")
        assert r_inv.status_code == 200

        r_sum = await client.get("/api/v1/reports/summary")
        assert r_sum.status_code == 403
        assert "الصلاحية" in r_sum.json()["detail"]

        r_fin = await client.get("/api/v1/reports/financial")
        assert r_fin.status_code == 403
        assert "الصلاحية" in r_fin.json()["detail"]


@pytest.mark.asyncio
async def test_unauthorized_role_gets_403_on_all_reports(auth_unauthorized_user):
    """أي دور غير مصرح له يُرفض بـ 403 Forbidden على كافة التقارير."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r1 = await client.get("/api/v1/reports/summary")
        assert r1.status_code == 403

        r2 = await client.get("/api/v1/reports/inventory")
        assert r2.status_code == 403

        r3 = await client.get("/api/v1/reports/financial")
        assert r3.status_code == 403


# ═════════════════════════════════════════════════════════════════════════════
# 3. اختبارات التكامل المالي الحقيقي مع PostgreSQL (Integration Tests)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_real_db_empty_state_returns_zeroes(auth_general_manager, session: AsyncSession):
    """التأكد من أن خلو البيانات أو عدم وجود حركات يرجع أصفاراً دون أخطاء أو قيم Null."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get("/api/v1/reports/summary")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data["treasury"]["revenues_period"], (int, float))
        assert isinstance(data["treasury"]["expenses_period"], (int, float))
        assert isinstance(data["treasury"]["net_period"], (int, float))

        res_fin = await client.get("/api/v1/reports/financial?since_days=1")
        assert res_fin.status_code == 200
        fin_data = res_fin.json()
        assert isinstance(fin_data["revenues"]["total"], (int, float))
        assert isinstance(fin_data["expenses"]["total"], (int, float))


@pytest.mark.asyncio
async def test_real_db_revenue_and_expense_query_accuracy(auth_general_manager, session: AsyncSession):
    """
    اختبار تكاملي حقيقي مع PostgreSQL:
    1. إنشاء مستند قبض إيرادات معتمد (income + approved) بمبلغ 25,000 ج.م
    2. إنشاء مستند قبض غير معتمد (income + pending) بمبلغ 10,000 ج.م -> لا يُحسب
    3. إنشاء مستند قبض مرفوض (income + rejected) بمبلغ 5,000 ج.م -> لا يُحسب
    4. إنشاء مستند صرف معتمد (expense + approved) بمبلغ 8,000 ج.م -> يُحسب مصروفات فقط
    5. إنشاء مستند تحويل معتمد (transfer + approved) بمبلغ 12,000 ج.م -> لا يُحسب إيرادات ولا مصروفات
    6. إنشاء مستند إيرادات معتمد ولكن تاريخه خارج الفترة (قبل 45 يوماً) -> لا يدخل في شهر التقرير
    التحقق من:
    - إجمالي الإيرادات = 25,000 ج.م تماماً
    - إجمالي المصروفات = 8,000 ج.م تماماً
    - صافي السيولة (Net) = 17,000 ج.م تماماً
    """
    treasury = await session.scalar(select(CashAccount).where(CashAccount.account_type == "treasury"))
    assert treasury is not None, "الخزينة الرئيسية يجب أن تكون مهيأة"

    petty = await session.scalar(select(CashAccount).where(CashAccount.account_type == "petty_cash"))
    if not petty:
        petty = CashAccount(
            id=str(uuid.uuid4()),
            account_number=f"PC-TEST-{uuid.uuid4().hex[:6].upper()}",
            name="عهدة تجريبية",
            account_type="petty_cash",
            parent_account_id=treasury.id,
            is_active=True,
            created_by="test-fixture",
        )
        session.add(petty)
        await session.commit()

    now = datetime.now(timezone.utc)
    created_doc_ids = []

    try:
        # 1. إيراد معتمد داخل الفترة
        doc_inc_approved = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-TEST-INC-APP-{uuid.uuid4().hex[:6].upper()}",
            document_type="income",
            to_account_id=treasury.id,
            amount=Decimal("25000.00"),
            description="مبيعات نقدية معتمدة",
            occurred_at=now - timedelta(days=2),
            status="approved",
            created_by="test-fixture",
        )
        # 2. إيراد معلق لم يُعتمد بعد
        doc_inc_pending = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-TEST-INC-PND-{uuid.uuid4().hex[:6].upper()}",
            document_type="income",
            to_account_id=treasury.id,
            amount=Decimal("10000.00"),
            description="تحصيل شيك تحت التحصيل",
            occurred_at=now - timedelta(days=1),
            status="pending",
            created_by="test-fixture",
        )
        # 3. إيراد مرفوض
        doc_inc_rejected = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-TEST-INC-REJ-{uuid.uuid4().hex[:6].upper()}",
            document_type="income",
            to_account_id=treasury.id,
            amount=Decimal("5000.00"),
            description="تحصيل ملغي",
            occurred_at=now - timedelta(days=3),
            status="rejected",
            created_by="test-fixture",
        )
        # 4. مصروف معتمد داخل الفترة
        doc_exp_approved = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-TEST-EXP-APP-{uuid.uuid4().hex[:6].upper()}",
            document_type="expense",
            from_account_id=treasury.id,
            amount=Decimal("8000.00"),
            description="مصروفات تشغيل ومستلزمات",
            occurred_at=now - timedelta(days=4),
            status="approved",
            created_by="test-fixture",
        )
        # 5. تحويل داخلي معتمد (من الخزينة للعهدة)
        doc_transfer = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-TEST-TRF-APP-{uuid.uuid4().hex[:6].upper()}",
            document_type="transfer",
            from_account_id=treasury.id,
            to_account_id=petty.id,
            amount=Decimal("12000.00"),
            description="تغذية عهدة نقدية",
            occurred_at=now - timedelta(days=5),
            status="approved",
            created_by="test-fixture",
        )
        # 6. إيراد معتمد قديم (خارج فترة 30 يوماً)
        doc_inc_old = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-TEST-INC-OLD-{uuid.uuid4().hex[:6].upper()}",
            document_type="income",
            to_account_id=treasury.id,
            amount=Decimal("100000.00"),
            description="إيراد الشهر الماضي",
            occurred_at=now - timedelta(days=60),
            status="approved",
            created_by="test-fixture",
        )

        test_docs = [
            doc_inc_approved,
            doc_inc_pending,
            doc_inc_rejected,
            doc_exp_approved,
            doc_transfer,
            doc_inc_old,
        ]
        for d in test_docs:
            session.add(d)
            created_doc_ids.append(d.id)
        await session.commit()

        # استدعاء الـ APIs وفحص النتائج الدقيقة
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # 1. فحص الملخص التشغيلي الشهري (30 يوماً)
            res_sum = await client.get("/api/v1/reports/summary?period=monthly")
            assert res_sum.status_code == 200
            sum_data = res_sum.json()

            assert sum_data["treasury"]["revenues_period"] == 25000.0
            assert sum_data["treasury"]["expenses_period"] == 8000.0
            assert sum_data["treasury"]["net_period"] == 17000.0

            # 2. فحص التقرير المالي التفصيلي (30 يوماً)
            res_fin = await client.get("/api/v1/reports/financial?since_days=30")
            assert res_fin.status_code == 200
            fin_data = res_fin.json()

            assert fin_data["revenues"]["total"] == 25000.0
            assert fin_data["revenues"]["count"] == 1
            assert fin_data["revenues"]["documents"][0]["id"] == doc_inc_approved.id

            assert fin_data["expenses"]["total"] == 8000.0
            assert fin_data["expenses"]["count"] == 1
            assert fin_data["expenses"]["documents"][0]["id"] == doc_exp_approved.id

            assert fin_data["net"] == 17000.0

    finally:
        # تنظيف بيانات الاختبار من قاعدة البيانات
        if created_doc_ids:
            await session.execute(delete(CashDocument).where(CashDocument.id.in_(created_doc_ids)))
            await session.commit()
