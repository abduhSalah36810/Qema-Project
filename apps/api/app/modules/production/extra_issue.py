"""
صرف خامات إضافي لأمر تشغيل قائم (من مخزن الخامات إلى مخزن تحت التشغيل).
─────────────────────────────────────────────────────────────────────────────
المخازن الثلاثة لكل منها دورة محددة، لذلك لا يوجد تحويل يدوي حر بينها. النقل الوحيد الناقص كان
صرف خامات إضافية لأمر بعد الصرف الأول (مثلاً لإصلاح عيوب)، وهذا الملف يغطيه بنفس آليات الصرف المعتمدة:

1. أمين المخزن ينشئ الصرف ويرحّله مباشرة (قرار المالك): خصم من مخزن الخامات + «بالطريق».
   - الرصيد يُفحص تحت قفل (صنف، مخزن) فلا رصيد سالب ولا سحب متزامن مزدوج.
   - التكلفة = متوسط التكلفة المرجح بمخزن الخامات لحظة الصرف (نفس سياسة الصرف الأول).
2. مسؤول الإنتاج (غير الصارف) يؤكد الاستلام بالورشة: «بالطريق» ← حاوية الأمر، والفرق يُسجل ولا يُمحى.
   - تكلفة المستلم تُضاف لتكلفة خامات الأمر (نفس قاعدة الاستلام الأول) مع قيد يومية في نفس المعاملة.
   - تكلفة الخامة على الأمر تصبح متوسطاً مرجحاً لرصيدها بالورشة حتى تُقيَّم التسوية والمرتجعات به.

القيود: الأمر بعد استلام خاماته الأولى وقبل أي استلام منتج تام (حتى لا تتغير تكلفة القطعة بعد
تحميلها على المنتج التام)، وصرف إضافي واحد بالطريق في كل مرة، وخامات فقط (لا منتجات تامة).
لا يُعدّل ولا يُحذف أي قيد مرحَّل.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.finance.ledger_service import get_weighted_average_cost, post_journal_entry, resolve_expense_code
from app.modules.production.models import (
    CatalogItem,
    ProductionOrder,
    ProductionOrderMaterial,
    StockLedgerEntry,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.modules.production.returns import operational_warehouses
from app.modules.production.schemas import ExtraIssueCreate, ReceiptConfirmRequest
from app.modules.production.service import lock_stock_balance
from app.modules.production.stock import order_wip_bucket

EXTRA_ISSUE_PREFIX = "صرف إضافي"
EXTRA_ISSUE_ORDER_STATUSES = ("in_production", "manufacturing_completed")
FG_RECEIPT_DOC_TYPE = "production_order_finished_receipt"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _has_finished_goods_receipt(db: AsyncSession, order_id: str) -> bool:
    count = await db.scalar(
        select(func.count()).select_from(StockLedgerEntry).where(
            StockLedgerEntry.reference_doc_type == FG_RECEIPT_DOC_TYPE,
            StockLedgerEntry.reference_doc_id == order_id,
        )
    )
    return bool(count)


async def dispatch_transfers(db: AsyncSession, order_id: str, *, lock: bool = False) -> list[WarehouseTransfer]:
    """كل تحويلات الصرف (خامات ← تحت التشغيل) للأمر بترتيب زمني؛ الأول هو الصرف الأصلي."""
    raw_wh, wip_wh = await operational_warehouses(db)
    stmt = (
        select(WarehouseTransfer)
        .options(selectinload(WarehouseTransfer.lines))
        .where(
            WarehouseTransfer.order_id == order_id,
            WarehouseTransfer.source_warehouse_id == raw_wh.id,
            WarehouseTransfer.destination_warehouse_id == wip_wh.id,
        )
        .order_by(WarehouseTransfer.dispatched_at, WarehouseTransfer.transfer_number)
    )
    if lock:
        stmt = stmt.with_for_update(of=WarehouseTransfer)
    return list((await db.execute(stmt)).scalars().all())


async def extra_issue_transfers(db: AsyncSession, order_id: str) -> list[WarehouseTransfer]:
    return (await dispatch_transfers(db, order_id))[1:]


async def pending_extra_issue_orders(db: AsyncSession, order_ids: list[str]) -> dict[str, str]:
    """الأوامر التي عليها صرف إضافي بالطريق: {order_id: من صرفه} (لمهام مسؤول الإنتاج)."""
    if not order_ids:
        return {}
    raw_wh, wip_wh = await operational_warehouses(db)
    first_dispatch = (
        select(WarehouseTransfer.order_id, func.min(WarehouseTransfer.dispatched_at).label("first_at"))
        .where(
            WarehouseTransfer.order_id.in_(order_ids),
            WarehouseTransfer.source_warehouse_id == raw_wh.id,
            WarehouseTransfer.destination_warehouse_id == wip_wh.id,
        )
        .group_by(WarehouseTransfer.order_id)
        .subquery()
    )
    rows = (await db.execute(
        select(WarehouseTransfer.order_id, WarehouseTransfer.dispatched_by)
        .join(first_dispatch, first_dispatch.c.order_id == WarehouseTransfer.order_id)
        .where(
            WarehouseTransfer.status == "in_transit",
            WarehouseTransfer.source_warehouse_id == raw_wh.id,
            WarehouseTransfer.destination_warehouse_id == wip_wh.id,
            WarehouseTransfer.dispatched_at > first_dispatch.c.first_at,
        )
    )).all()
    return {order_id: dispatched_by for order_id, dispatched_by in rows}


async def _load_order_for_extra_issue(db: AsyncSession, order_id: str) -> ProductionOrder:
    order = (await db.execute(
        select(ProductionOrder)
        .options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id)
        .with_for_update(of=ProductionOrder)
    )).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    if order.status not in EXTRA_ISSUE_ORDER_STATUSES:
        raise HTTPException(
            status_code=409,
            detail="الصرف الإضافي متاح فقط لأمر استُلمت خاماته الأولى بالورشة وما زال في التشغيل (قبل استلام المنتج التام وإغلاق الأمر).",
        )
    if await _has_finished_goods_receipt(db, order.id):
        raise HTTPException(
            status_code=409,
            detail="بدأ استلام المنتج التام لهذا الأمر، فلا يمكن صرف خامات إضافية عليه لأن تكلفة القطعة حُمّلت على المنتج. أنشئ أمر تشغيل جديداً.",
        )
    return order


async def create_extra_issue(
    db: AsyncSession, *, order_id: str, data: ExtraIssueCreate, dispatcher_id: str,
) -> WarehouseTransfer:
    order = await _load_order_for_extra_issue(db, order_id)
    raw_wh, wip_wh = await operational_warehouses(db)

    transfers = await dispatch_transfers(db, order.id, lock=True)
    if any(t.status == "in_transit" for t in transfers):
        raise HTTPException(
            status_code=409,
            detail="يوجد صرف خامات لهذا الأمر بالطريق لم يؤكد مسؤول الإنتاج استلامه بعد. أكّد استلامه أولاً ثم اصرف الإضافي.",
        )

    item_ids = [line.item_id for line in data.lines]
    if len(set(item_ids)) != len(item_ids):
        raise HTTPException(status_code=422, detail="كل خامة تُذكر مرة واحدة في الصرف الإضافي؛ اجمع كمياتها في سطر واحد.")

    items = {item.id: item for item in (await db.execute(select(CatalogItem).where(CatalogItem.id.in_(item_ids)))).scalars()}
    for line in data.lines:
        item = items.get(line.item_id)
        if not item:
            raise HTTPException(status_code=404, detail="إحدى الخامات غير موجودة في دليل الأصناف.")
        if item.item_type == "finished_garment" or item.code.startswith("FG-VAR-"):
            raise HTTPException(status_code=422, detail=f"«{item.name_ar}» منتج تام ولا يُصرف كخامة لأمر تشغيل.")
        if not item.is_active or item.approval_status != "approved":
            raise HTTPException(status_code=422, detail=f"الخامة «{item.name_ar}» غير معتمدة أو موقوفة ولا تُصرف.")

    # قفل الأرصدة بترتيب ثابت ثم فحص المتاح تحت القفل
    for item_id in sorted(item_ids):
        await lock_stock_balance(db, item_id, raw_wh.id)
    shortages = []
    for line in data.lines:
        available = float(await db.scalar(
            select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0)).where(
                StockLedgerEntry.item_id == line.item_id,
                StockLedgerEntry.warehouse_id == raw_wh.id,
                StockLedgerEntry.location_type == "warehouse",
            )
        ) or 0.0)
        if available + 1e-9 < line.quantity:
            shortages.append(f"{items[line.item_id].name_ar}: المتاح {available:g} والمطلوب {line.quantity:g}")
    if shortages:
        raise HTTPException(status_code=409, detail="لا يمكن الصرف لعدم كفاية الرصيد بمخزن الخامات: " + "؛ ".join(shortages))

    transfer = WarehouseTransfer(
        id=str(uuid.uuid4()),
        transfer_number=f"TRX-{_now().year}-{uuid.uuid4().hex[:6].upper()}",
        order_id=order.id,
        source_warehouse_id=raw_wh.id,
        destination_warehouse_id=wip_wh.id,
        status="in_transit",
        dispatched_at=_now(),
        dispatched_by=dispatcher_id,
        notes=f"{EXTRA_ISSUE_PREFIX}: {data.reason.strip()}",
    )
    db.add(transfer)

    materials_by_item = {mat.item_id: mat for mat in order.materials}
    posted = []
    for line in data.lines:
        item = items[line.item_id]
        wac = await get_weighted_average_cost(db, line.item_id, raw_wh.id)
        cost = (Decimal(str(line.quantity)) * wac).quantize(Decimal("0.01"))
        tline = WarehouseTransferLine(
            id=str(uuid.uuid4()), transfer_id=transfer.id, item_id=line.item_id, unit_id=item.unit_id,
            dispatched_quantity=line.quantity, received_quantity=0.0, discrepancy_quantity=0.0,
            notes=line.notes.strip(),
        )
        db.add(tline)
        posted.append((tline, wac, cost))

        mat = materials_by_item.get(line.item_id)
        if mat is None:
            # خامة لم تكن في الأمر: تُضاف بكمية مخططة صفر حتى يظهر أنها خارج المستلزمات الأصلية
            mat = ProductionOrderMaterial(
                id=str(uuid.uuid4()), order_id=order.id, item_id=line.item_id, unit_id=item.unit_id,
                planned_quantity=0.0, dispatched_quantity=0.0, received_quantity=0.0, discrepancy_quantity=0.0,
                status="dispatched", notes=EXTRA_ISSUE_PREFIX, item_name_snapshot=item.name_ar,
                unit_cost=wac, total_cost=Decimal("0.00"),
            )
            db.add(mat)
            materials_by_item[line.item_id] = mat
        mat.dispatched_quantity = round(float(mat.dispatched_quantity or 0.0) + line.quantity, 6)

    await db.flush()
    for tline, wac, cost in posted:
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=tline.item_id, unit_id=tline.unit_id,
            warehouse_id=raw_wh.id, location_type="warehouse", quantity=-tline.dispatched_quantity,
            reference_doc_type="warehouse_transfer", reference_doc_id=transfer.id,
            transfer_line_id=tline.id, entry_type="dispatch_source", created_by=dispatcher_id,
            unit_cost=wac, total_cost=-cost,
        ))
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=tline.item_id, unit_id=tline.unit_id,
            warehouse_id=None, location_type="in_transit", bucket_reference=transfer.id,
            quantity=tline.dispatched_quantity, reference_doc_type="warehouse_transfer",
            reference_doc_id=transfer.id, transfer_line_id=tline.id,
            entry_type="dispatch_transit", created_by=dispatcher_id,
            unit_cost=wac, total_cost=cost,
        ))
    await db.flush()
    return transfer


async def receive_extra_issue(
    db: AsyncSession, *, order_id: str, transfer_id: str, data: ReceiptConfirmRequest, receiver_id: str,
) -> WarehouseTransfer:
    order = await _load_order_for_extra_issue(db, order_id)
    _, wip_wh = await operational_warehouses(db)

    transfers = await dispatch_transfers(db, order.id, lock=True)
    transfer = next((t for t in transfers[1:] if t.id == transfer_id), None)
    if transfer is None:
        raise HTTPException(status_code=404, detail="مستند الصرف الإضافي غير موجود لهذا الأمر.")
    if transfer.status != "in_transit":
        raise HTTPException(status_code=409, detail="تم تأكيد استلام هذا الصرف الإضافي مسبقاً.")
    if transfer.dispatched_by == receiver_id:
        raise HTTPException(
            status_code=409,
            detail="لا يجوز لمن صرف الخامات أن يؤكد استلامها بنفسه. يؤكد الاستلام مسؤول الإنتاج أو مستخدم آخر مخوّل.",
        )

    line_ids = {line.item_id for line in transfer.lines}
    if any(entry.item_id not in line_ids for entry in data.received_lines):
        raise HTTPException(status_code=422, detail="أحد أصناف الاستلام ليس ضمن مستند الصرف الإضافي.")
    received_map = {entry.item_id: entry.received_quantity for entry in data.received_lines}
    notes_map = {entry.item_id: entry.notes for entry in data.received_lines}
    materials_by_item = {mat.item_id: mat for mat in order.materials}
    wip_bucket = order_wip_bucket(order.id)

    for line in sorted(transfer.lines, key=lambda entry: entry.item_id):
        await lock_stock_balance(db, line.item_id, wip_wh.id)

    received_cost = Decimal("0.00")
    dispatched_cost = Decimal("0.00")
    for line in transfer.lines:
        rec_qty = round(float(received_map.get(line.item_id, line.dispatched_quantity)), 6)
        if rec_qty < 0 or rec_qty > line.dispatched_quantity + 1e-9:
            raise HTTPException(
                status_code=409,
                detail=f"الكمية المستلمة ({rec_qty:g}) يجب أن تكون بين صفر والكمية المصروفة ({line.dispatched_quantity:g}).",
            )
        disc_qty = round(rec_qty - line.dispatched_quantity, 6)
        # تكلفة الوحدة هي تكلفة الصرف المجمدة في قيد «بالطريق» لهذا السطر
        unit_cost = Decimal(str(await db.scalar(
            select(StockLedgerEntry.unit_cost).where(
                StockLedgerEntry.transfer_line_id == line.id,
                StockLedgerEntry.entry_type == "dispatch_transit",
            )
        ) or 0))
        rec_cost = (Decimal(str(rec_qty)) * unit_cost).quantize(Decimal("0.01"))
        disp_cost = (Decimal(str(line.dispatched_quantity)) * unit_cost).quantize(Decimal("0.01"))

        # رصيد الخامة بالورشة قبل الاستلام (كمية وتكلفة) لحساب المتوسط المرجح الجديد على الأمر
        wip_qty, wip_cost = (await db.execute(
            select(
                func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0),
                func.coalesce(func.sum(StockLedgerEntry.total_cost), 0),
            ).where(
                StockLedgerEntry.item_id == line.item_id,
                StockLedgerEntry.warehouse_id == wip_wh.id,
                StockLedgerEntry.location_type == "warehouse",
                StockLedgerEntry.bucket_reference == wip_bucket,
            )
        )).one()

        received_cost += rec_cost
        dispatched_cost += disp_cost
        line.received_quantity = rec_qty
        line.discrepancy_quantity = disc_qty
        if notes_map.get(line.item_id):
            line.notes = f"{line.notes} | {notes_map[line.item_id]}".strip(" |")

        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
            warehouse_id=None, location_type="in_transit", bucket_reference=transfer.id,
            quantity=-line.dispatched_quantity, reference_doc_type="warehouse_transfer",
            reference_doc_id=transfer.id, transfer_line_id=line.id,
            entry_type="receipt_transit", created_by=receiver_id,
            unit_cost=unit_cost, total_cost=-disp_cost,
        ))
        if rec_qty > 0:
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
                warehouse_id=wip_wh.id, location_type="warehouse", bucket_reference=wip_bucket,
                quantity=rec_qty, reference_doc_type="warehouse_transfer",
                reference_doc_id=transfer.id, transfer_line_id=line.id,
                entry_type="receipt_warehouse", created_by=receiver_id,
                unit_cost=unit_cost, total_cost=rec_cost,
            ))
        if disc_qty != 0:
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
                warehouse_id=None, location_type="discrepancy", bucket_reference=transfer.id,
                quantity=-disc_qty, reference_doc_type="warehouse_transfer",
                reference_doc_id=transfer.id, transfer_line_id=line.id,
                entry_type="receipt_discrepancy", created_by=receiver_id,
                unit_cost=unit_cost, total_cost=(disp_cost - rec_cost),
            ))

        mat = materials_by_item.get(line.item_id)
        if mat is not None:
            new_qty = float(wip_qty or 0.0) + rec_qty
            new_cost = Decimal(str(wip_cost or 0)) + rec_cost
            if new_qty > 1e-9:
                mat.unit_cost = (new_cost / Decimal(str(new_qty))).quantize(Decimal("0.0001"))
            mat.received_quantity = round(float(mat.received_quantity or 0.0) + rec_qty, 6)
            mat.discrepancy_quantity = round(float(mat.discrepancy_quantity or 0.0) + disc_qty, 6)
            mat.total_cost = (Decimal(str(mat.total_cost or 0)) + disp_cost).quantize(Decimal("0.01"))
            if disc_qty != 0:
                mat.status = "received_with_discrepancy"
            elif mat.status in ("pending", "dispatched"):
                mat.status = "received_complete"

    transfer.status = "received_confirmed"
    transfer.received_at = _now()
    transfer.received_by = receiver_id
    if data.notes:
        transfer.notes = f"{transfer.notes} | استلام: {data.notes}".strip(" |")

    order.actual_material_cost = (order.actual_material_cost or Decimal("0.00")) + received_cost
    order.total_actual_cost = (
        order.actual_material_cost + (order.actual_labor_cost or Decimal("0.00")) + (order.actual_overhead_cost or Decimal("0.00"))
    )
    order.wip_balance = (order.wip_balance or Decimal("0.00")) + received_cost
    target_q = Decimal(str(order.target_quantity or 0))
    if target_q > Decimal("0.00"):
        order.unit_manufacturing_cost = (order.total_actual_cost / target_q).quantize(Decimal("0.0001"))

    transit_loss_cost = dispatched_cost - received_cost
    if dispatched_cost > Decimal("0.00"):
        journal_lines = []
        if received_cost > Decimal("0.00"):
            journal_lines.append({"account_code": "1220", "debit": received_cost, "credit": 0, "description": f"خامات إضافية مستلمة بالورشة لأمر {order.order_number}"})
        if transit_loss_cost > Decimal("0.00"):
            loss_acc = await resolve_expense_code(db, "5220", "5200")
            journal_lines.append({"account_code": loss_acc, "debit": transit_loss_cost, "credit": 0, "description": f"عجز خامات إضافية أثناء النقل لأمر {order.order_number}"})
        journal_lines.append({"account_code": "1210", "debit": 0, "credit": dispatched_cost, "description": "صرف خامات إضافية من مخزن الخامات"})
        await post_journal_entry(
            db,
            source_doc_type="production_wip_issue",
            source_doc_id=transfer.id,
            description=f"تحميل تكلفة خامات إضافية على أمر التشغيل {order.order_number}",
            lines=journal_lines,
            user_id=receiver_id,
        )

    await db.flush()
    return transfer
