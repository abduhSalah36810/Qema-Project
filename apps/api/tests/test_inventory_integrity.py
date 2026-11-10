"""
اختبارات سلامة الحركات المخزنية وحصانة دفاتر الأستاذ (Inventory Ledger Integrity Tests).
─────────────────────────────────────────────────────────────────────────────
تغطي Phase 4.1:
1. منع التعديل والحذف (Append-Only Immutability via PostgreSQL Trigger).
2. عدم تكرار الحركات وعودة النتيجة الأصلية (Idempotency with same key & payload).
3. رفض إعادة استخدام المفتاح مع بيانات مختلفة (Idempotency key reused with different payload -> 409).
4. معالجة الطلبات المتزامنة بنفس المفتاح (Concurrent duplicate requests).
5. حظر التنافس وحماية الأرصدة من الانخفاض تحت الصفر (Concurrent stock depletion).
6. التراجع الشامل عند فشل أي خطوة (Transaction Rollback).
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import DBAPIError, InternalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser, get_current_user
from app.core.idempotency import compute_request_hash, execute_idempotent_operation
from app.db.session import get_db
from app.main import app
from app.modules.production.models import (
    CatalogItem,
    IdempotentRequest,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    StockLedgerEntry,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
    utc_now,
)
from app.modules.production.service import (
    dispatch_order_materials,
    lock_stock_balance,
    seed_provisional_data_if_empty,
)


def _uid() -> str:
    return str(uuid.uuid4())


@pytest.fixture
async def setup_base_data(session: AsyncSession):
    """تهيئة البيانات المرجعية الأساسية للمخازن والوحدات والأصناف."""
    await seed_provisional_data_if_empty(session)
    await session.commit()

    raw_wh = await session.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    wip_wh = await session.scalar(select(Warehouse).where(Warehouse.code == "work_in_progress"))
    fg_wh = await session.scalar(select(Warehouse).where(Warehouse.code == "finished_goods"))
    meter_unit = await session.scalar(select(Unit).where(Unit.code == "meter"))

    # صنف قماش اختباري مخصص
    test_fabric = CatalogItem(
        id=_uid(),
        code=f"FAB-INT-{uuid.uuid4().hex[:6].upper()}",
        name_ar="قماش اختبار الحصانة المخزنية",
        item_type="fabric",
        unit_id=meter_unit.id,
        is_consumable=True,
        is_active=True,
        approval_status="approved",
    )
    session.add(test_fabric)
    await session.commit()
    await session.refresh(test_fabric)

    return {
        "raw_wh": raw_wh,
        "wip_wh": wip_wh,
        "fg_wh": fg_wh,
        "unit": meter_unit,
        "fabric": test_fabric,
    }


# ═════════════════════════════════════════════════════════════════════════════
# 1. اختبار منع التعديل والحذف على stock_ledger_entries (Task 1)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_stock_ledger_entries_immutability_rejects_update_and_delete(session: AsyncSession, setup_base_data):
    """التحقق من أن التريجر يمنع أي UPDATE أو DELETE على stock_ledger_entries مع السماح بالـ INSERT."""
    data = setup_base_data
    fabric = data["fabric"]
    raw_wh = data["raw_wh"]
    unit = data["unit"]

    # 1. إدراج حركة جديدة (يجب أن ينجح INSERT طبيعياً)
    entry_id = _uid()
    entry = StockLedgerEntry(
        id=entry_id,
        item_id=fabric.id,
        unit_id=unit.id,
        warehouse_id=raw_wh.id,
        location_type="warehouse",
        quantity=50.0,
        reference_doc_type="initial_test_stock",
        reference_doc_id=_uid(),
        entry_type="test_deposit",
        created_by="test-admin",
    )
    session.add(entry)
    await session.commit()

    # 2. محاولة تعديل السجل المضاف (UPDATE يجب أن تفشل قطعياً بالتريجر)
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_info:
        await session.execute(
            text("UPDATE stock_ledger_entries SET quantity = 999.0 WHERE id = :id"),
            {"id": entry_id},
        )
        await session.commit()
    await session.rollback()
    assert "stock_ledger_entries is strictly append-only" in str(exc_info.value) or "سجل حركات المخزون غير قابل للتعديل" in str(exc_info.value)

    # 3. محاولة حذف السجل (DELETE يجب أن تفشل قطعياً بالتريجر)
    with pytest.raises((DBAPIError, InternalError, ProgrammingError)) as exc_info:
        await session.execute(
            text("DELETE FROM stock_ledger_entries WHERE id = :id"),
            {"id": entry_id},
        )
        await session.commit()
    await session.rollback()
    assert "stock_ledger_entries is strictly append-only" in str(exc_info.value) or "سجل حركات المخزون غير قابل للتعديل" in str(exc_info.value)

    # 4. التأكد من بقاء السجل دون أي تشويه أو تغيير
    saved_entry = await session.get(StockLedgerEntry, entry_id)
    assert saved_entry is not None
    assert saved_entry.quantity == 50.0


# ═════════════════════════════════════════════════════════════════════════════
# 2. اختبار عدم تكرار الحركات المخزنية (Task 2 - Idempotency Same Key)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_idempotency_duplicate_request_returns_cached_and_prevents_duplicate_entries(session: AsyncSession, setup_base_data):
    """
    إرسال نفس مفتاح Idempotency-Key مع نفس البيانات:
    1. يعيد نفس النتيجة الأولى بدقة.
    2. لا ينشئ أي قيود أستاذ مكررة (Zero duplicate stock ledger entries).
    """
    data = setup_base_data
    fabric = data["fabric"]
    raw_wh = data["raw_wh"]
    unit = data["unit"]

    # إيداع رصيد بالمخزن 200 متر
    deposit_id = _uid()
    session.add(StockLedgerEntry(
        id=deposit_id, item_id=fabric.id, unit_id=unit.id, warehouse_id=raw_wh.id,
        location_type="warehouse", quantity=200.0, reference_doc_type="seed",
        reference_doc_id=_uid(), entry_type="deposit", created_by="admin",
    ))

    # إنشاء أمر تشغيل جاهز للصرف
    order_id = _uid()
    order = ProductionOrder(
        id=order_id,
        order_number=f"ORD-TEST-{uuid.uuid4().hex[:6].upper()}",
        product_id=(await session.scalar(select(Product.id))),
        variant_id=(await session.scalar(select(ProductVariant.id))),
        target_quantity=10.0,
        season="summer",
        status="draft",
        created_by="test-user",
    )
    session.add(order)
    mat = ProductionOrderMaterial(
        id=_uid(),
        order_id=order_id,
        item_id=fabric.id,
        unit_id=unit.id,
        planned_quantity=25.0,
    )
    session.add(mat)
    await session.commit()

    # المستخدم المخول
    user = AuthenticatedUser(
        id="usr-wh-idemp",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-idemp", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session

    idem_key = f"IDEM-KEY-{uuid.uuid4().hex}"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # الطلب الأول: صرف الخامات مع مفتاح عدم التكرار
        resp1 = await client.post(
            f"/api/v1/production/orders/{order_id}/dispatch?notes=FirstDispatchAttempt",
            headers={"Idempotency-Key": idem_key},
        )
        assert resp1.status_code == 200
        transfer_data1 = resp1.json()
        assert transfer_data1["status"] == "in_transit"

        # عد قيود الأستاذ الناتجة عن هذا الأمر
        entries_count_1 = await session.scalar(
            select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == fabric.id)
        )

        # الطلب الثاني: إعادة إرسال نفس الطلب بنفس المفتاح وبنفس البيانات تماماً
        resp2 = await client.post(
            f"/api/v1/production/orders/{order_id}/dispatch?notes=FirstDispatchAttempt",
            headers={"Idempotency-Key": idem_key},
        )
        assert resp2.status_code == 200
        transfer_data2 = resp2.json()

        # التحقق من أن الاستجابة مطابقة تماماً
        assert transfer_data1["id"] == transfer_data2["id"]
        assert transfer_data1["transfer_number"] == transfer_data2["transfer_number"]

        # التحقق الصارم من عدم إضافة أي سطر ليدجر مكرر (Zero duplicate entries)
        entries_count_2 = await session.scalar(
            select(func.count(StockLedgerEntry.id)).where(StockLedgerEntry.item_id == fabric.id)
        )
        assert entries_count_1 == entries_count_2

    app.dependency_overrides.clear()


# ═════════════════════════════════════════════════════════════════════════════
# 3. اختبار رفض إعادة استخدام المفتاح مع بيانات مختلفة (Task 2 - Payload Mismatch)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_idempotency_key_reused_with_different_payload_is_rejected(session: AsyncSession, setup_base_data):
    """إعادة استخدام نفس مفتاح Idempotency-Key مع بيانات مختلفة يجب أن يُرفض فوراً بـ 409 Conflict."""
    data = setup_base_data
    fabric = data["fabric"]
    raw_wh = data["raw_wh"]
    unit = data["unit"]

    # إيداع رصيد
    session.add(StockLedgerEntry(
        id=_uid(), item_id=fabric.id, unit_id=unit.id, warehouse_id=raw_wh.id,
        location_type="warehouse", quantity=100.0, reference_doc_type="seed",
        reference_doc_id=_uid(), entry_type="deposit", created_by="admin",
    ))

    order_id = _uid()
    order = ProductionOrder(
        id=order_id,
        order_number=f"ORD-MISMATCH-{uuid.uuid4().hex[:6].upper()}",
        product_id=(await session.scalar(select(Product.id))),
        variant_id=(await session.scalar(select(ProductVariant.id))),
        target_quantity=5.0,
        season="winter",
        status="draft",
        created_by="test-user",
    )
    session.add(order)
    session.add(ProductionOrderMaterial(
        id=_uid(), order_id=order_id, item_id=fabric.id, unit_id=unit.id, planned_quantity=10.0,
    ))
    await session.commit()

    user = AuthenticatedUser(
        id="usr-wh-mismatch",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-mismatch", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session

    shared_key = f"IDEM-MISMATCH-{uuid.uuid4().hex}"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # الطلب الأول بملاحظات "Note A"
        r1 = await client.post(
            f"/api/v1/production/orders/{order_id}/dispatch?notes=NoteA",
            headers={"Idempotency-Key": shared_key},
        )
        assert r1.status_code == 200

        # الطلب الثاني بنفس المفتاح ولكن بملاحظات مختلفة "Note B"
        r2 = await client.post(
            f"/api/v1/production/orders/{order_id}/dispatch?notes=NoteB_Different",
            headers={"Idempotency-Key": shared_key},
        )
        assert r2.status_code == 409
        # استجابة الأخطاء تعتمد هيكل Safe API Errors (CONFLICT)
        assert r2.json()["code"] == "CONFLICT"

    app.dependency_overrides.clear()


# ═════════════════════════════════════════════════════════════════════════════
# 4. اختبار الطلبات المتزامنة بنفس المفتاح (Task 2 - Concurrent Duplicate Requests)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_concurrent_duplicate_idempotency_requests(test_engine, setup_base_data):
    """
    إرسال طلبين متزامنين في نفس اللحظة بنفس مفتاح Idempotency-Key:
    - تمنع المعمارية التكرار وتعالج التنافس بأمان.
    - لا ينتج عن الطلبين أي تكرار لقيود الأستاذ.
    """
    data = setup_base_data
    fabric = data["fabric"]
    raw_wh = data["raw_wh"]
    unit = data["unit"]

    session_factory = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

    async with session_factory() as sess:
        sess.add(StockLedgerEntry(
            id=_uid(), item_id=fabric.id, unit_id=unit.id, warehouse_id=raw_wh.id,
            location_type="warehouse", quantity=150.0, reference_doc_type="seed",
            reference_doc_id=_uid(), entry_type="deposit", created_by="admin",
        ))
        order_id = _uid()
        sess.add(ProductionOrder(
            id=order_id,
            order_number=f"ORD-CONCUR-IDEM-{uuid.uuid4().hex[:6].upper()}",
            product_id=(await sess.scalar(select(Product.id))),
            variant_id=(await sess.scalar(select(ProductVariant.id))),
            target_quantity=5.0,
            season="spring",
            status="draft",
            created_by="test-user",
        ))
        sess.add(ProductionOrderMaterial(
            id=_uid(), order_id=order_id, item_id=fabric.id, unit_id=unit.id, planned_quantity=15.0,
        ))
        await sess.commit()

    user = AuthenticatedUser(
        id="usr-wh-concur-idem",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-concur-idem", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user

    async def override_get_db_idem():
        async with session_factory() as s:
            yield s

    app.dependency_overrides[get_db] = override_get_db_idem

    shared_key = f"CONCUR-KEY-{uuid.uuid4().hex}"

    async def _send_dispatch():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.post(
                f"/api/v1/production/orders/{order_id}/dispatch?notes=ConcurrentAttempt",
                headers={"Idempotency-Key": shared_key},
            )

    # إطلاق الطلبين في نفس اللحظة
    r1, r2 = await asyncio.gather(_send_dispatch(), _send_dispatch(), return_exceptions=False)

    # يجب أن ينجح أحدهما بـ 200، والآخر إما 200 (حصوله على النتيجة الأصلية) أو 409 (قيد المعالجة)
    statuses = {r1.status_code, r2.status_code}
    assert 200 in statuses

    # التحقق من أن قيود الأستاذ لم تتكرر (تم إنشاء قيد صرف واحد فقط بمبلغ -15 وقيد طريق واحد +15)
    async with session_factory() as verify_sess:
        dispatch_entries = (await verify_sess.scalars(
            select(StockLedgerEntry).where(
                StockLedgerEntry.item_id == fabric.id,
                StockLedgerEntry.entry_type == "dispatch_source",
            )
        )).all()
        assert len(dispatch_entries) == 1
        assert dispatch_entries[0].quantity == -15.0

    app.dependency_overrides.clear()


# ═════════════════════════════════════════════════════════════════════════════
# 5. اختبار حظر التنافس ومنع الرصيد السالب (Task 3 - Concurrent Stock Depletion)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_concurrent_stock_depletion_prevents_negative_balance(test_engine, setup_base_data):
    """
    سيناريو التزامن الحرج المطلوب:
    - رصيد الصنف في المخزن 100 متر بالضبط.
    - معامتان تحاولان صرف 70 متراً لكل منهما في نفس اللحظة (المجموع 140 > 100).
    - بفضل lock_stock_balance(item, warehouse):
      * تنجح معاملة واحدة فقط (HTTP 200).
      * تفشل المعاملة الثانية تماماً بـ HTTP 409 Conflict لعدم كفاية الرصيد.
      * يظل الرصيد المتبقي 30 متراً، ولا يصبح سالباً أبداً.
    """
    data = setup_base_data
    fabric = data["fabric"]
    raw_wh = data["raw_wh"]
    unit = data["unit"]

    session_factory = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

    # 1. إيداع 100 متر بالضبط في مخزن الخامات الرئيسي
    async with session_factory() as sess:
        sess.add(StockLedgerEntry(
            id=_uid(), item_id=fabric.id, unit_id=unit.id, warehouse_id=raw_wh.id,
            location_type="warehouse", quantity=100.0, reference_doc_type="seed_100",
            reference_doc_id=_uid(), entry_type="deposit", created_by="admin",
        ))

        # إنشاء أمرين منفصلين: كل أمر يطلب صرف 70 متراً
        order_a_id = _uid()
        order_b_id = _uid()
        prod_id = await sess.scalar(select(Product.id))
        var_id = await sess.scalar(select(ProductVariant.id))

        sess.add(ProductionOrder(
            id=order_a_id, order_number=f"ORD-A-{uuid.uuid4().hex[:6].upper()}",
            product_id=prod_id, variant_id=var_id, target_quantity=10.0,
            season="summer", status="draft", created_by="test-user",
        ))
        sess.add(ProductionOrderMaterial(
            id=_uid(), order_id=order_a_id, item_id=fabric.id, unit_id=unit.id, planned_quantity=70.0,
        ))

        sess.add(ProductionOrder(
            id=order_b_id, order_number=f"ORD-B-{uuid.uuid4().hex[:6].upper()}",
            product_id=prod_id, variant_id=var_id, target_quantity=10.0,
            season="summer", status="draft", created_by="test-user",
        ))
        sess.add(ProductionOrderMaterial(
            id=_uid(), order_id=order_b_id, item_id=fabric.id, unit_id=unit.id, planned_quantity=70.0,
        ))
        await sess.commit()

    user = AuthenticatedUser(
        id="usr-wh-deplete",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-deplete", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user

    async def override_get_db_deplete():
        async with session_factory() as s:
            yield s

    app.dependency_overrides[get_db] = override_get_db_deplete

    async def _dispatch_order(o_id: str):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.post(f"/api/v1/production/orders/{o_id}/dispatch?notes=ConcurrentDeplete")

    # 2. تشغيل الصرف للأمرين A و B بالتزامن التام
    res_a, res_b = await asyncio.gather(
        _dispatch_order(order_a_id),
        _dispatch_order(order_b_id),
        return_exceptions=False,
    )

    # 3. التحقق: واحدة فقط يجب أن تنجح (200)، والأخرى يجب أن تفشل (409)
    status_codes = sorted([res_a.status_code, res_b.status_code])
    assert status_codes == [200, 409], f"Expected exactly one 200 and one 409, got: {status_codes}"

    failed_res = res_a if res_a.status_code == 409 else res_b
    assert failed_res.json()["code"] == "CONFLICT"

    # 4. التحقق من الرصيد النهائي في قاعدة البيانات (يجب أن يكون 30.0 تماماً، ولا سالب)
    async with session_factory() as verify_sess:
        final_balance = await verify_sess.scalar(
            select(func.sum(StockLedgerEntry.quantity)).where(
                StockLedgerEntry.item_id == fabric.id,
                StockLedgerEntry.warehouse_id == raw_wh.id,
                StockLedgerEntry.location_type == "warehouse",
            )
        )
        assert float(final_balance) == 30.0

    app.dependency_overrides.clear()


# ═════════════════════════════════════════════════════════════════════════════
# 6. اختبار التراجع التام عند فشل المعاملة (Task 3 - Transaction Rollback)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_transaction_rollback_leaves_no_orphaned_ledger_entries(session: AsyncSession, setup_base_data):
    """التحقق من أن حدوث أي استثناء أو خطأ أثناء المعاملة يلغي كافة التغييرات ويمنع قيود الأستاذ اليتيمة."""
    data = setup_base_data
    fabric = data["fabric"]
    raw_wh = data["raw_wh"]
    unit = data["unit"]

    # رصيد 50 متر
    session.add(StockLedgerEntry(
        id=_uid(), item_id=fabric.id, unit_id=unit.id, warehouse_id=raw_wh.id,
        location_type="warehouse", quantity=50.0, reference_doc_type="seed",
        reference_doc_id=_uid(), entry_type="deposit", created_by="admin",
    ))

    # أمر يطلب 80 متراً (أكثر من المتاح 50)
    order_id = _uid()
    session.add(ProductionOrder(
        id=order_id,
        order_number=f"ORD-FAIL-{uuid.uuid4().hex[:6].upper()}",
        product_id=(await session.scalar(select(Product.id))),
        variant_id=(await session.scalar(select(ProductVariant.id))),
        target_quantity=5.0,
        season="autumn",
        status="draft",
        created_by="test-user",
    ))
    session.add(ProductionOrderMaterial(
        id=_uid(), order_id=order_id, item_id=fabric.id, unit_id=unit.id, planned_quantity=80.0,
    ))
    await session.commit()

    user = AuthenticatedUser(
        id="usr-wh-fail",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-fail", "role": "warehouse_manager"},
    )
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(f"/api/v1/production/orders/{order_id}/dispatch")
        assert resp.status_code == 409

    # التحقق من أن حالة الأمر لم تتغير، ولم تُنشأ أي قيود بالطريق أو صرف
    refreshed_order = await session.get(ProductionOrder, order_id)
    assert refreshed_order.status == "draft"

    transit_entries = (await session.scalars(
        select(StockLedgerEntry).where(
            StockLedgerEntry.item_id == fabric.id,
            StockLedgerEntry.location_type == "in_transit",
        )
    )).all()
    assert len(transit_entries) == 0

    app.dependency_overrides.clear()
