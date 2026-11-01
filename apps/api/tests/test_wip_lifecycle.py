"""
اختبارات دورة حياة خامات تحت التشغيل وعزل الأوامر والإغلاق الآمن (WIP Lifecycle & Safe Order Closure Tests)
─────────────────────────────────────────────────────────────────────────────
تغطي Phase 4.4:
1. عزل رصيد خامات الورشة لكل أمر (WIP Order Isolation عبر bucket_reference = f"order:{order.id}").
2. فك ارتباط اكتمال التصنيع الميداني واستلام المنتج التام عن الإغلاق النهائي:
   - packing -> completed يجعل الحالة manufacturing_completed.
   - التراجع عن packing يعيد الحالة إلى in_production.
   - استلام التام بالكامل يجعل الحالة receipt_completed.
3. استعلام ملخص خامات الورشة وجاهزية الإغلاق (GET /orders/{order_id}/wip-summary).
4. ضوابط وحواجز الإغلاق الآمن (Safe Order Closure Preconditions):
   - حظر الإغلاق مع وجود مراحل إنتاج غير مكتملة.
   - حظر الإغلاق مع وجود تحويلات بالطريق معلقة.
   - حظر الإغلاق مع وجود فروقات استلام غير معتمدة (discrepancy_signoff).
   - حظر الإغلاق مع عجز في كمية المنتج التام دون تبرير معتمد (under_production_reason).
   - حظر الإغلاق مع وجود رصيد خامات بالورشة دون توجيه معتمد (wip_disposition).
5. نجاح الإغلاق الآمن بتوثيق التوجيه المعتمد (order.status = "closed").
6. منع التكرار وحصانة الإغلاق (Idempotency & Safe Retries).
─────────────────────────────────────────────────────────────────────────────
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser
from app.modules.production.models import (
    CatalogItem,
    Product,
    ProductVariant,
    ProductionOrder,
    ProductionOrderItem,
    ProductionOrderMaterial,
    ProductionStageEvent,
    ProductionStageHistory,
    StockLedgerEntry,
    Unit,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
    utc_now,
)
from app.modules.production.schemas import (
    FinishedGoodsReceiptCreate,
    OrderCloseRequest,
    ReceiptConfirmRequest,
    ReceiptLineConfirm,
    StageUpdate,
)
from app.modules.production.service import (
    ORDER_STAGES_SEQUENCE,
    confirm_warehouse_receipt,
    reopen_last_completed_stage,
    update_production_stage,
)
from app.api.v1.endpoints.production import (
    close_production_order,
    get_order_wip_summary,
    receive_finished_goods,
)


@pytest.fixture
def mock_user_gm():
    return AuthenticatedUser(
        id="usr-gm-01",
        email="gm@qemma.com",
        claims={"sub": "usr-gm-01", "role": "general_manager"},
    )


@pytest.fixture
def mock_user_warehouse():
    return AuthenticatedUser(
        id="usr-wh-01",
        email="wh@qemma.com",
        claims={"sub": "usr-wh-01", "role": "warehouse_manager"},
    )


def _build_mock_order(
    order_id: str = "order-wip-100",
    order_number: str = "PO-2026-WIP01",
    status: str = "in_production",
    target_quantity: float = 100.0,
):
    prod = Product(id="prod-1", code="GAL-01", name_ar="جلابية كلاسيك")
    var = ProductVariant(id="var-1", product_id="prod-1", numeric_size=58, season="summer", sku="SKU-WIP-1")
    unit_piece = Unit(id="unit-piece", code="piece", name_ar="قطعة")
    unit_meter = Unit(id="unit-meter", code="meter", name_ar="متر")

    order = ProductionOrder(
        id=order_id,
        order_number=order_number,
        product_id=prod.id,
        variant_id=var.id,
        target_quantity=target_quantity,
        season="summer",
        status=status,
        created_by="usr-gm-01",
        notes="",
    )
    order.product = prod
    order.variant = var

    # Materials
    mat_item = CatalogItem(
        id="item-fab-1",
        code="FAB-COTTON",
        name_ar="قماش قطن مصري",
        unit_id=unit_meter.id,
        item_type="raw_material",
        is_active=True,
    )
    mat = ProductionOrderMaterial(
        id="mat-1",
        order_id=order.id,
        item_id=mat_item.id,
        unit_id=unit_meter.id,
        planned_quantity=300.0,
        dispatched_quantity=300.0,
        received_quantity=300.0,
        discrepancy_quantity=0.0,
        status="in_production",
        item_name_snapshot="قماش قطن مصري",
    )
    mat.item = mat_item
    mat.unit = unit_meter
    order.materials = [mat]

    # Stages (all 5 stages)
    stage_events = []
    for st in ORDER_STAGES_SEQUENCE:
        ev = ProductionStageEvent(
            id=f"stg-{st}-{order_id}",
            order_id=order.id,
            stage_name=st,
            status="completed",
            actor_id="usr-gm-01",
            actor_name="المدير العام",
            timestamp=utc_now(),
        )
        stage_events.append(ev)
    order.stage_events = stage_events
    order.order_items = []
    return order


# ─────────────────────────────────────────────────────────────────────────────
# 1. WIP Order Isolation Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_confirm_warehouse_receipt_sets_wip_order_bucket_reference():
    """التحقق من أن قيد استلام الورشة يعزل الرصيد صراحة بربطه بالأمر bucket_reference = f'order:{order.id}'."""
    session = AsyncMock()
    session.add = MagicMock()

    order = ProductionOrder(
        id="order-iso-99",
        order_number="PO-2026-ISO99",
        status="materials_dispatched",
    )
    order.materials = []

    transfer = WarehouseTransfer(
        id="tr-iso-99",
        transfer_number="TR-2026-99",
        order_id=order.id,
        source_warehouse_id="wh-raw",
        destination_warehouse_id="wh-wip",
        status="in_transit",
    )
    line = WarehouseTransferLine(
        id="line-iso-99",
        transfer_id=transfer.id,
        item_id="item-fabric-99",
        unit_id="unit-m",
        dispatched_quantity=200.0,
        received_quantity=0.0,
        discrepancy_quantity=0.0,
    )
    transfer.lines = [line]

    # Mock DB executions
    transfer_res = MagicMock()
    transfer_res.scalar_one_or_none.return_value = transfer

    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    session.execute.side_effect = [transfer_res, order_res]

    confirm_data = ReceiptConfirmRequest(
        received_lines=[ReceiptLineConfirm(item_id="item-fabric-99", received_quantity=200.0)],
        notes="استلام كامل الخامات بالورشة",
    )

    await confirm_warehouse_receipt(
        session=session,
        order_id=order.id,
        data=confirm_data,
        receiver_id="usr-wh-01",
        commit=False,
    )

    # فحص القيود الدفترية المضافة
    added_entries = [
        call_arg[0][0]
        for call_arg in session.add.call_args_list
        if isinstance(call_arg[0][0], StockLedgerEntry)
    ]
    assert len(added_entries) == 2  # transit receipt (-) and warehouse receipt (+)

    transit_entry = next(e for e in added_entries if e.entry_type == "receipt_transit")
    assert transit_entry.quantity == -200.0
    assert transit_entry.bucket_reference == transfer.id

    wip_entry = next(e for e in added_entries if e.entry_type == "receipt_warehouse")
    assert wip_entry.quantity == 200.0
    assert wip_entry.warehouse_id == "wh-wip"
    # شرط العزل الأساسي:
    assert wip_entry.bucket_reference == f"order:{order.id}"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Production Status Lifecycle Decoupling Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_packing_completion_sets_manufacturing_completed_not_completed():
    """التحقق من أن إكمال التعبئة ينتقل إلى manufacturing_completed وليس completed."""
    session = AsyncMock()
    session.add = MagicMock()

    order = ProductionOrder(
        id="order-stage-01",
        order_number="PO-2026-STG01",
        status="in_production",
    )
    packing_event = ProductionStageEvent(
        id="stg-packing-01",
        order_id=order.id,
        stage_name="packing",
        status="in_progress",
        actor_id="usr-1",
        actor_name="مشرف",
        notes="",
    )
    # كافة المراحل السابقة مكتملة
    events = [
        ProductionStageEvent(id=f"stg-{s}", order_id=order.id, stage_name=s, status="completed", actor_id="usr-1", actor_name="مشرف", notes="")
        for s in ORDER_STAGES_SEQUENCE if s != "packing"
    ]
    events.append(packing_event)
    order.stage_events = events

    exec_res = MagicMock()
    exec_res.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_res

    await update_production_stage(
        session=session,
        order_id=order.id,
        stage_name="packing",
        data=StageUpdate(status="completed", notes="اكتملت التعبئة والتغليف وجاهزة للتسليم"),
        actor_id="usr-1",
        actor_name="مشرف",
    )

    # يجب ألا يتحول الأمر إلى completed بل إلى manufacturing_completed
    assert order.status == "manufacturing_completed"
    assert packing_event.status == "completed"


@pytest.mark.asyncio
async def test_rollback_packing_reverts_order_to_in_production():
    """التحقق من أن التراجع عن مرحلة التعبئة يعيد الأمر إلى in_production."""
    session = AsyncMock()
    session.add = MagicMock()

    order = ProductionOrder(
        id="order-stage-02",
        order_number="PO-2026-STG02",
        status="manufacturing_completed",
    )
    events = [
        ProductionStageEvent(id=f"stg-{s}", order_id=order.id, stage_name=s, status="completed", actor_id="usr-1", actor_name="مشرف", notes="")
        for s in ORDER_STAGES_SEQUENCE
    ]
    order.stage_events = events

    exec_res = MagicMock()
    exec_res.scalar_one_or_none.return_value = order
    session.execute.return_value = exec_res

    await reopen_last_completed_stage(
        session=session,
        order_id=order.id,
        stage_name="packing",
        reason="إعادة فحص تغليف الجلاليب لطلب عميل خاص",
        actor_id="usr-1",
        actor_name="مشرف",
    )

    assert order.status == "in_production"
    packing_event = next(e for e in order.stage_events if e.stage_name == "packing")
    assert packing_event.status == "in_progress"


@pytest.mark.asyncio
async def test_receive_finished_goods_sets_receipt_completed():
    """التحقق من أن استلام المنتج التام كاملاً يحول الحالة إلى receipt_completed."""
    session = AsyncMock()
    session.add = MagicMock()

    order = _build_mock_order(status="manufacturing_completed", target_quantity=100.0)
    session.get.side_effect = [order.variant, order.product]
    fg_wh = Warehouse(id="wh-fg-01", code="finished_goods", name_ar="مخزن المنتج التام")
    fg_item = CatalogItem(id="fg-item-01", code="FG-VAR-1", name_ar="جلابية كلاسيك - مقاس 58", unit_id="unit-piece", item_type="finished_good")

    # Mock order select
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    # Mock warehouse select
    wh_res = MagicMock()
    wh_res.scalar_one_or_none.return_value = fg_wh

    # Mock existing receipts (0 received)
    existing_scalar = 0.0

    # Mock fg item
    item_res = MagicMock()
    item_res.scalar_one_or_none.return_value = fg_item

    session.execute.side_effect = [order_res, wh_res, item_res]
    session.scalar.side_effect = [existing_scalar]

    receipt_data = FinishedGoodsReceiptCreate(
        received_quantity=100.0,
        accepted_quantity=100.0,
        notes="استلام كامل كمية الدفعة بمخزن التام",
    )

    user = AuthenticatedUser(id="usr-wh", email="wh@qemma.com", claims={"sub": "usr-wh", "role": "warehouse_manager"})
    response = await receive_finished_goods(
        order_id=order.id,
        data=receipt_data,
        current_user=user,
        db=session,
    )

    assert response.receipt_status == "complete"
    assert response.accepted_quantity == 100.0
    # الحالة تصبح receipt_completed (وليس completed)
    assert order.status == "receipt_completed"


# ─────────────────────────────────────────────────────────────────────────────
# 3. WIP Summary API Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_order_wip_summary():
    """التحقق من حساب أرصدة خامات الورشة بدقة وعرض أسباب منع الإغلاق إن وجدت."""
    session = AsyncMock()

    order = _build_mock_order(status="receipt_completed", target_quantity=100.0)
    transfer = WarehouseTransfer(
        id="tr-sum-1",
        transfer_number="TR-2026-SUM1",
        order_id=order.id,
        source_warehouse_id="wh-raw",
        destination_warehouse_id="wh-wip",
        status="received_confirmed",
    )
    transfer_line = WarehouseTransferLine(
        id="tr-line-1",
        transfer_id=transfer.id,
        item_id="item-fab-1",
        unit_id="unit-meter",
        dispatched_quantity=300.0,
        received_quantity=295.0,
        discrepancy_quantity=-5.0,  # عجز 5 متر عند الاستلام
    )
    transfer.lines = [transfer_line]

    # Order query
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    # Transfers query
    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = [transfer]

    # Finished goods query: 100 accepted
    session.scalar.return_value = 100.0

    # WIP entries: 295 received
    wip_entry = StockLedgerEntry(
        id="entry-1",
        item_id="item-fab-1",
        unit_id="unit-meter",
        warehouse_id="wh-wip",
        location_type="warehouse",
        bucket_reference=f"order:{order.id}",
        quantity=295.0,
        reference_doc_type="warehouse_transfer",
        reference_doc_id=transfer.id,
        entry_type="receipt_warehouse",
        created_by="usr-wh",
    )
    wip_entries_res = MagicMock()
    wip_entries_res.scalars.return_value.all.return_value = [wip_entry]

    session.execute.side_effect = [order_res, transfers_res, wip_entries_res]

    user = AuthenticatedUser(id="usr-gm", email="gm@qemma.com", claims={"sub": "usr-gm", "role": "general_manager"})
    summary = await get_order_wip_summary(order_id=order.id, current_user=user, db=session)

    assert summary.order_id == order.id
    assert summary.stages_completed is True
    assert summary.goods_receipt_status == "complete"
    assert summary.unresolved_discrepancies_count == 1
    assert summary.net_wip_balance == 295.0
    assert summary.can_close is False
    # أسباب المنع:
    assert any("فروقات استلام" in r for r in summary.blocking_reasons)
    assert any("رصيد خامات معلق" in r for r in summary.blocking_reasons)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Safe Order Closure Validation & Protection Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_close_order_blocks_when_stages_incomplete(mock_user_gm):
    """منع إغلاق الأمر إذا لم تكتمل كافة مراحل الإنتاج الفنية الخمس."""
    session = AsyncMock()

    order = _build_mock_order(status="in_production")
    # جعل مرحلة الكي لم تكتمل
    for ev in order.stage_events:
        if ev.stage_name == "ironing":
            ev.status = "in_progress"

    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order
    session.execute.return_value = order_res

    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "اكتمال كافة مراحل الإنتاج الفنية" in exc_info.value.detail


@pytest.mark.asyncio
async def test_close_order_blocks_when_transfers_in_transit(mock_user_gm):
    """منع إغلاق الأمر إذا كانت هناك شحنات خامات لا تزال بالطريق ولم تُستلم."""
    session = AsyncMock()

    order = _build_mock_order(status="in_production")
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    in_transit_tr = WarehouseTransfer(
        id="tr-transit-1",
        transfer_number="TR-2026-T1",
        order_id=order.id,
        source_warehouse_id="wh-raw",
        destination_warehouse_id="wh-wip",
        status="in_transit",
        lines=[],
    )
    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = [in_transit_tr]

    session.execute.side_effect = [order_res, transfers_res]

    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "قيد النقل بالطريق (in_transit)" in exc_info.value.detail


@pytest.mark.asyncio
async def test_close_order_blocks_unapproved_discrepancies(mock_user_gm):
    """منع إغلاق الأمر عند وجود فروقات استلام بالورشة دون تفعيل إقرار الفروقات."""
    session = AsyncMock()

    order = _build_mock_order(status="receipt_completed")
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    transfer = WarehouseTransfer(
        id="tr-disc-1",
        transfer_number="TR-2026-D1",
        order_id=order.id,
        status="received_confirmed",
    )
    line = WarehouseTransferLine(
        id="line-disc-1",
        transfer_id=transfer.id,
        item_id="item-fab-1",
        unit_id="unit-meter",
        dispatched_quantity=300.0,
        received_quantity=290.0,
        discrepancy_quantity=-10.0,
    )
    transfer.lines = [line]

    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = [transfer]

    session.execute.side_effect = [order_res, transfers_res]

    # محاولة الإغلاق بدون discrepancy_signoff
    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(discrepancy_signoff=False),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "فروقات استلام بالورشة غير معتمدة" in exc_info.value.detail


@pytest.mark.asyncio
async def test_close_order_blocks_unapproved_under_production(mock_user_gm):
    """منع إغلاق الأمر إذا كانت كمية المنتج التام المستلمة أقل من المستهدفة دون تقديم سبب العجز."""
    session = AsyncMock()

    order = _build_mock_order(status="receipt_completed", target_quantity=100.0)
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = []

    # استلام 80 فقط من 100
    session.scalar.return_value = 80.0
    session.execute.side_effect = [order_res, transfers_res]

    # محاولة الإغلاق بدون under_production_reason
    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(under_production_reason=None),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "سبب العجز الإنتاجي (under_production_reason)" in exc_info.value.detail


@pytest.mark.asyncio
async def test_close_order_blocks_non_zero_wip_balance_even_with_disposition(mock_user_gm):
    """منع إغلاق الأمر إذا كان هناك رصيد خامات متبقٍ بالورشة حتى مع تقديم نص wip_disposition."""
    session = AsyncMock()
    session.flush = AsyncMock()

    order = _build_mock_order(status="receipt_completed", target_quantity=100.0)
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = []

    # استلام كامل المنتجات التامة (100) ولكن رصيد الورشة متبقٍ فيه 50.0 متر
    session.scalar.side_effect = [100.0, 50.0]  # total_fg_received=100, remaining_wip=50.0
    session.execute.side_effect = [order_res, transfers_res]

    # محاولة الإغلاق مع تمرير wip_disposition وملاحظاتها
    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(
                wip_disposition="standard_loss_tolerance",
                wip_disposition_notes="محاولة إغلاق بمبرر نصي دون حركة ليدجر",
                discrepancy_signoff=True,
            ),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "لا يمكن إغلاق أمر التشغيل لوجود رصيد خامات معلق بالورشة" in exc_info.value.detail
    assert "تسجيل مصير الخامات نصياً لا يغني عن حركات التسوية الدفترية الفعلية" in exc_info.value.detail
    # التأكد من عدم تغيير الحالة أو إضافة ملاحظات إغلاق
    assert order.status == "receipt_completed"
    assert order.notes == ""
    session.flush.assert_not_called()


@pytest.mark.asyncio
async def test_close_order_blocks_negative_wip_balance(mock_user_gm):
    """منع إغلاق الأمر في حالة وجود رصيد شاذ سالب في خامات الورشة."""
    session = AsyncMock()
    session.flush = AsyncMock()

    order = _build_mock_order(status="receipt_completed", target_quantity=100.0)
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = []

    # رصيد سالب (-3.5)
    session.scalar.side_effect = [100.0, -3.5]
    session.execute.side_effect = [order_res, transfers_res]

    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(discrepancy_signoff=True),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "رصيد خامات معلق بالورشة (-3.5)" in exc_info.value.detail
    assert order.status == "receipt_completed"
    session.flush.assert_not_called()


@pytest.mark.asyncio
async def test_close_order_wip_balance_query_isolation(mock_user_gm):
    """التحقق من أن استعلام رصيد خامات الورشة يعزل سلة الأمر المحدد فقط bucket_reference = f'order:{order_id}'."""
    session = AsyncMock()

    order = _build_mock_order(order_id="ord-iso-spec-123", status="receipt_completed", target_quantity=100.0)
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = []

    scalar_calls = []

    async def _mock_scalar(stmt, *args, **kwargs):
        scalar_calls.append(stmt)
        # Call 1: finished goods receipts -> 100.0
        # Call 2: remaining wip balance -> 0.0
        if len(scalar_calls) == 1:
            return 100.0
        return 0.0

    session.scalar.side_effect = _mock_scalar
    session.execute.side_effect = [order_res, transfers_res]

    await close_production_order(
        order_id="ord-iso-spec-123",
        data=OrderCloseRequest(discrepancy_signoff=True),
        current_user=mock_user_gm,
        db=session,
    )

    assert len(scalar_calls) == 2
    wip_stmt = scalar_calls[1]
    # التحقق من أن الاستعلام يقيد الصياغة بـ bucket_reference = order:ord-iso-spec-123
    stmt_str = str(wip_stmt.compile(compile_kwargs={"literal_binds": True}))
    assert "order:ord-iso-spec-123" in stmt_str
    assert "stock_ledger_entries.location_type = 'warehouse'" in stmt_str


# ─────────────────────────────────────────────────────────────────────────────
# 5. Successful Safe Closure & Idempotency Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_safe_order_closure_success(mock_user_gm):
    """التحقق من نجاح إغلاق أمر التشغيل عند تصفير رصيد WIP بالكامل (0.0) واستيفاء الشروط."""
    session = AsyncMock()

    order = _build_mock_order(status="receipt_completed", target_quantity=100.0)
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order

    transfer = WarehouseTransfer(
        id="tr-ok-1",
        transfer_number="TR-2026-OK1",
        order_id=order.id,
        status="received_confirmed",
    )
    line = WarehouseTransferLine(
        id="line-ok-1",
        transfer_id=transfer.id,
        item_id="item-fab-1",
        unit_id="unit-meter",
        dispatched_quantity=300.0,
        received_quantity=298.0,
        discrepancy_quantity=-2.0,  # فرق 2 متر
    )
    transfer.lines = [line]

    transfers_res = MagicMock()
    transfers_res.scalars.return_value.all.return_value = [transfer]

    # استلام 98 جلابية (عجز 2 قطعة مع تبرير)، ورصيد خامات الورشة مسوّى بالكامل = 0.0
    session.scalar.side_effect = [98.0, 0.0]
    session.execute.side_effect = [order_res, transfers_res]

    close_req = OrderCloseRequest(
        discrepancy_signoff=True,
        discrepancy_notes="اعتماد عجز 2 متر قماش كفرق قياس توب",
        wip_disposition="reconciled_zero",
        wip_disposition_notes="تمت تسوية واستهلاك كامل الخامات في الدفعة",
        under_production_reason="تلف قطعتين أثناء الكبسولة وتوريد 98 قطعة ممتازة",
        notes="إغلاق وتسوية نهائية معتمدة من الإدارة العامة",
    )

    response = await close_production_order(
        order_id=order.id,
        data=close_req,
        current_user=mock_user_gm,
        db=session,
    )

    assert response.status == "closed"
    assert response.order_id == order.id
    assert response.total_received_goods == 98.0
    assert response.remaining_wip_balance == 0.0
    assert order.status == "closed"
    assert "تم الإغلاق النهائي" in order.notes
    session.flush.assert_awaited()


@pytest.mark.asyncio
async def test_close_order_rejects_already_closed_order(mock_user_gm):
    """التحقق من رفض إعادة إغلاق أمر مغلق مسبقاً دون مفتاح idempotency مطابق."""
    session = AsyncMock()

    order = _build_mock_order(status="closed")
    order_res = MagicMock()
    order_res.scalar_one_or_none.return_value = order
    session.execute.return_value = order_res

    with pytest.raises(HTTPException) as exc_info:
        await close_production_order(
            order_id=order.id,
            data=OrderCloseRequest(),
            current_user=mock_user_gm,
            db=session,
        )

    assert exc_info.value.status_code == 409
    assert "مغلق نهائياً مسبقاً" in exc_info.value.detail


@pytest.mark.asyncio
async def test_safe_order_closure_idempotency_retry(mock_user_gm):
    """التحقق من أن إعادة استدعاء إغلاق الأمر بنفس Idempotency-Key تعيد الاستجابة المخزنة دون تكرار العمليات."""
    from app.core.idempotency import compute_request_hash
    from app.modules.production.models import IdempotentRequest

    session = AsyncMock()

    cached_payload = {
        "order_id": "order-wip-idem",
        "order_number": "PO-2026-IDEM",
        "status": "closed",
        "closed_at": datetime.now(timezone.utc).isoformat(),
        "closed_by": "usr-gm-01",
        "target_quantity": 100.0,
        "total_received_goods": 100.0,
        "remaining_wip_balance": 0.0,
        "discrepancy_count": 0,
        "wip_disposition": "completed_clean",
        "notes": "إغلاق ناجح",
    }
    close_req = OrderCloseRequest(
        wip_disposition="completed_clean",
        notes="إغلاق ناجح",
    )
    req_hash = compute_request_hash({"order_id": "order-wip-idem", "data": close_req.model_dump()})

    cached_record = IdempotentRequest(
        id="idem-rec-1",
        idempotency_key="idemp-order-close-test",
        operation_type="production.order_close",
        resource_id="order-wip-idem",
        user_id="usr-gm-01",
        request_hash=req_hash,
        response_code=200,
        response_body=cached_payload,
        status="completed",
    )

    # Mock execute_idempotent_operation query for existing record
    idem_res = MagicMock()
    idem_res.scalar_one_or_none.return_value = cached_record
    session.execute.return_value = idem_res

    response = await close_production_order(
        order_id="order-wip-idem",
        data=close_req,
        current_user=mock_user_gm,
        db=session,
        idempotency_key="idemp-order-close-test",
    )

    resp_dict = response if isinstance(response, dict) else response.model_dump()
    assert resp_dict["status"] == "closed"
    assert resp_dict["order_id"] == "order-wip-idem"
    assert resp_dict["wip_disposition"] == "completed_clean"

