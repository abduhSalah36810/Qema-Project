"""
مرتجعات خامات الورشة إلى مخزن الخامات (WIP → Raw) بمسار مضبوط.
─────────────────────────────────────────────────────────────────────────────
يعيد استخدام نموذج التحويل الحالي (warehouse_transfers + موقع in_transit) دون أي تغيير بنيوي:

1. مسؤول الإنتاج يسجل المرتجع ضمن تسوية الورشة ← يخرج من رصيد الورشة إلى "بالطريق"
   (تحويل اتجاهه: مصدره مخزن تحت التشغيل ووجهته مخزن الخامات). لا يزيد رصيد الخامات القابل للصرف.
2. أمين المخزن يفحص فعلياً ويؤكد: المقبول يدخل مخزن الخامات، والمرفوض (تالف/غير صالح) يُعزل
   في موقع discrepancy بحاوية return_rejected:{transfer_id}، والعجز يُثبت فرقاً في discrepancy بحاوية
   التحويل. المرفوض والعجز يتطلبان تفسيراً، ولا يُحمَّل أي موظف مسؤولية مالية تلقائياً.
3. مسؤول الإنتاج أو المدير العام (غير مؤكد الاستلام) يقرر التسوية النهائية بسبب مكتوب:
   العجز ← إثبات فقد، والمرفوض ← إعادة للمخزن القابل للصرف أو هالك للأمر.
4. لا يُغلق أمر التشغيل ومرتجع له غير مستلم أو غير مُسوّى.

السجل الدفتري append-only: كل خطوة تضيف قيوداً جديدة ولا تعدل السابقة.
التكلفة: تبقى تكلفة المرتجع على حساب تحت التشغيل (1220) حتى استلامه؛ المقبول والمُعاد للمخزن فقط
يُرد إلى 1210، وما يُثبت فقداً أو هالكاً يبقى على الأمر ويُحمّل على 5200 عند الإغلاق (القاعدة القائمة).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.finance.ledger_service import post_journal_entry
from app.modules.production.models import (
    ProductionOrder,
    ProductionOrderMaterial,
    StockLedgerEntry,
    Warehouse,
    WarehouseTransfer,
    WarehouseTransferLine,
)
from app.modules.production.service import lock_stock_balance

RAW_CODE = "main_raw_materials"
WIP_CODE = "work_in_progress"

RETURN_STATUS_IN_TRANSIT = "in_transit"
RETURN_STATUS_PENDING_RESOLUTION = "pending_resolution"
RETURN_STATUS_COMPLETE = "received_confirmed"

RETURN_CONDITIONS = {"good": "سليمة", "needs_inspection": "تحتاج فحص", "damaged": "تالفة"}
OPEN_ORDER_STATUSES = ("in_production", "manufacturing_completed", "receipt_completed")


def rejected_bucket(transfer_id: str) -> str:
    return f"return_rejected:{transfer_id}"


async def operational_warehouses(db: AsyncSession) -> tuple[Warehouse, Warehouse]:
    raw_wh = await db.scalar(select(Warehouse).where(Warehouse.code == RAW_CODE))
    wip_wh = await db.scalar(select(Warehouse).where(Warehouse.code == WIP_CODE))
    if not raw_wh or not wip_wh:
        raise HTTPException(status_code=503, detail="بيانات المخازن التشغيلية غير مكتملة.")
    return raw_wh, wip_wh


def is_return_transfer(transfer: WarehouseTransfer, raw_id: str, wip_id: str) -> bool:
    return transfer.source_warehouse_id == wip_id and transfer.destination_warehouse_id == raw_id


def is_dispatch_transfer(transfer: WarehouseTransfer, raw_id: str, wip_id: str) -> bool:
    return transfer.source_warehouse_id == raw_id and transfer.destination_warehouse_id == wip_id


def transfer_is_return(transfer: WarehouseTransfer) -> bool:
    """اتجاه المرتجع من علاقات المخازن المحمّلة مسبقاً (selectinload) دون استعلام إضافي."""
    src = transfer.__dict__.get("source_warehouse")
    dst = transfer.__dict__.get("destination_warehouse")
    return bool(src is not None and dst is not None and src.code == WIP_CODE and dst.code == RAW_CODE)


def transfer_is_dispatch(transfer: WarehouseTransfer) -> bool:
    return not transfer_is_return(transfer)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _append(text: str | None, addition: str) -> str:
    return f"{text} | {addition}".strip(" |") if text else addition


# ─── 1. تسجيل المرتجع بالطريق (يُستدعى من تسوية الورشة) ─────────────────────

async def create_return_transfer(
    db: AsyncSession,
    *,
    order: ProductionOrder,
    raw_wh: Warehouse,
    wip_wh: Warehouse,
    reconciliation_id: str,
    reconciliation_number: str,
    returned_lines: list[tuple[ProductionOrderMaterial, float, str, str]],
    user_id: str,
) -> WarehouseTransfer:
    """
    returned_lines: (خامة الأمر، الكمية المرتجعة، الحالة، الملاحظات).
    يخرج المرتجع من حاوية الأمر بالورشة إلى موقع in_transit بحاوية التحويل؛ لا يدخل مخزن الخامات بعد.
    """
    transfer = WarehouseTransfer(
        id=str(uuid.uuid4()),
        transfer_number=f"RT-{_now().year}-{uuid.uuid4().hex[:6].upper()}",
        order_id=order.id,
        source_warehouse_id=wip_wh.id,
        destination_warehouse_id=raw_wh.id,
        status=RETURN_STATUS_IN_TRANSIT,
        dispatched_at=_now(),
        dispatched_by=user_id,
        notes=f"مرتجع خامات من الورشة بموجب تسوية {reconciliation_number}",
    )
    db.add(transfer)
    await db.flush()

    wip_bucket = f"order:{order.id}"
    for mat, qty, condition, notes in returned_lines:
        unit_cost = Decimal(str(mat.unit_cost or 0))
        cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))
        condition_label = RETURN_CONDITIONS.get(condition, condition)
        line = WarehouseTransferLine(
            id=str(uuid.uuid4()), transfer_id=transfer.id, item_id=mat.item_id, unit_id=mat.unit_id,
            dispatched_quantity=qty, received_quantity=0.0, discrepancy_quantity=0.0,
            notes=_append(f"حالة المرتجع: {condition_label}", notes.strip()) if notes.strip() else f"حالة المرتجع: {condition_label}",
        )
        db.add(line)
        await db.flush()
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=mat.item_id, unit_id=mat.unit_id,
            warehouse_id=wip_wh.id, location_type="warehouse", bucket_reference=wip_bucket,
            quantity=-qty, reference_doc_type="production_material_reconciliation",
            reference_doc_id=reconciliation_id, transfer_line_id=line.id,
            entry_type="material_return_out", created_by=user_id,
            unit_cost=unit_cost, total_cost=-cost,
        ))
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=mat.item_id, unit_id=mat.unit_id,
            warehouse_id=None, location_type="in_transit", bucket_reference=transfer.id,
            quantity=qty, reference_doc_type="warehouse_transfer",
            reference_doc_id=transfer.id, transfer_line_id=line.id,
            entry_type="return_transit", created_by=user_id,
            unit_cost=unit_cost, total_cost=cost,
        ))
    return transfer


# ─── 2. حالة المرتجعات المحسوبة من الدفتر ──────────────────────────────────

@dataclass
class ReturnLineState:
    line: WarehouseTransferLine
    declared: float
    accepted: float
    rejected_total: float = 0.0
    rejected_open: float = 0.0
    rejected_restocked: float = 0.0
    rejected_scrapped: float = 0.0
    shortage_total: float = 0.0
    shortage_open: float = 0.0


@dataclass
class ReturnState:
    transfer: WarehouseTransfer
    lines: list[ReturnLineState] = field(default_factory=list)

    @property
    def awaiting_receipt(self) -> bool:
        return self.transfer.status == RETURN_STATUS_IN_TRANSIT

    @property
    def awaiting_resolution(self) -> bool:
        return any(l.rejected_open > 1e-9 or l.shortage_open > 1e-9 for l in self.lines)


async def _sum_by_line(db: AsyncSession, transfer_id: str, **filters) -> dict[str, float]:
    stmt = select(StockLedgerEntry.transfer_line_id, func.coalesce(func.sum(StockLedgerEntry.quantity), 0.0)).join(
        WarehouseTransferLine, WarehouseTransferLine.id == StockLedgerEntry.transfer_line_id
    ).where(WarehouseTransferLine.transfer_id == transfer_id)
    for column, value in filters.items():
        stmt = stmt.where(getattr(StockLedgerEntry, column) == value)
    rows = (await db.execute(stmt.group_by(StockLedgerEntry.transfer_line_id))).all()
    return {line_id: round(float(qty or 0.0), 6) for line_id, qty in rows}


async def return_state(db: AsyncSession, transfer: WarehouseTransfer) -> ReturnState:
    disc = "discrepancy"
    rejected_in = await _sum_by_line(db, transfer.id, location_type=disc, entry_type="return_rejected")
    rejected_open = await _sum_by_line(db, transfer.id, location_type=disc, bucket_reference=rejected_bucket(transfer.id))
    restocked = await _sum_by_line(db, transfer.id, entry_type="return_rejected_restock")
    scrapped = await _sum_by_line(db, transfer.id, entry_type="return_rejected_scrap")
    shortage_in = await _sum_by_line(db, transfer.id, location_type=disc, entry_type="return_shortage")
    shortage_open = await _sum_by_line(db, transfer.id, location_type=disc, bucket_reference=transfer.id)
    state = ReturnState(transfer=transfer)
    for line in sorted(transfer.lines, key=lambda l: l.item_id):
        state.lines.append(ReturnLineState(
            line=line,
            declared=line.dispatched_quantity,
            accepted=line.received_quantity or 0.0,
            rejected_total=rejected_in.get(line.id, 0.0),
            rejected_open=rejected_open.get(line.id, 0.0),
            rejected_restocked=restocked.get(line.id, 0.0),
            rejected_scrapped=-scrapped.get(line.id, 0.0),
            shortage_total=shortage_in.get(line.id, 0.0),
            shortage_open=shortage_open.get(line.id, 0.0),
        ))
    return state


async def order_return_transfers(db: AsyncSession, order_id: str) -> list[WarehouseTransfer]:
    raw_wh, wip_wh = await operational_warehouses(db)
    rows = (await db.execute(
        select(WarehouseTransfer)
        .options(selectinload(WarehouseTransfer.lines))
        .where(
            WarehouseTransfer.order_id == order_id,
            WarehouseTransfer.source_warehouse_id == wip_wh.id,
            WarehouseTransfer.destination_warehouse_id == raw_wh.id,
        )
        .order_by(WarehouseTransfer.dispatched_at)
    )).scalars().all()
    return list(rows)


@dataclass
class PendingReturns:
    awaiting_receipt: int = 0
    awaiting_resolution: int = 0
    # من سجّل المرتجعات المنتظرة للاستلام / من استلم المرتجعات المنتظرة للتسوية (لا ينفذ أي منهما الخطوة التالية)
    declared_by: list[str] = field(default_factory=list)
    received_by: list[str] = field(default_factory=list)


async def unresolved_return_counts(db: AsyncSession, order_ids: list[str]) -> dict[str, PendingReturns]:
    """لكل أمر: المرتجعات بانتظار استلام المخزن وبانتظار التسوية، ومن لا يجوز له تنفيذ الخطوة التالية."""
    if not order_ids:
        return {}
    raw_wh, wip_wh = await operational_warehouses(db)
    rows = (await db.execute(
        select(WarehouseTransfer.order_id, WarehouseTransfer.status, WarehouseTransfer.dispatched_by, WarehouseTransfer.received_by)
        .where(
            WarehouseTransfer.order_id.in_(order_ids),
            WarehouseTransfer.source_warehouse_id == wip_wh.id,
            WarehouseTransfer.destination_warehouse_id == raw_wh.id,
            WarehouseTransfer.status.in_((RETURN_STATUS_IN_TRANSIT, RETURN_STATUS_PENDING_RESOLUTION)),
        )
    )).all()
    result: dict[str, PendingReturns] = {}
    for order_id, status, declared_by, received_by in rows:
        entry = result.setdefault(order_id, PendingReturns())
        if status == RETURN_STATUS_IN_TRANSIT:
            entry.awaiting_receipt += 1
            if declared_by and declared_by not in entry.declared_by:
                entry.declared_by.append(declared_by)
        else:
            entry.awaiting_resolution += 1
            if received_by and received_by not in entry.received_by:
                entry.received_by.append(received_by)
    return result


async def _load_return(db: AsyncSession, order_id: str, transfer_id: str) -> tuple[ProductionOrder, WarehouseTransfer, Warehouse, Warehouse]:
    raw_wh, wip_wh = await operational_warehouses(db)
    order = await db.scalar(
        select(ProductionOrder).options(selectinload(ProductionOrder.materials))
        .where(ProductionOrder.id == order_id).with_for_update(of=ProductionOrder)
    )
    if not order:
        raise HTTPException(status_code=404, detail="أمر التشغيل غير موجود.")
    transfer = await db.scalar(
        select(WarehouseTransfer).options(selectinload(WarehouseTransfer.lines))
        .where(WarehouseTransfer.id == transfer_id, WarehouseTransfer.order_id == order_id)
        .with_for_update(of=WarehouseTransfer)
    )
    if not transfer or not is_return_transfer(transfer, raw_wh.id, wip_wh.id):
        raise HTTPException(status_code=404, detail="مستند مرتجع الورشة غير موجود لهذا الأمر.")
    if order.status not in OPEN_ORDER_STATUSES:
        raise HTTPException(status_code=409, detail="لا يمكن معالجة مرتجع لأمر تشغيل مغلق أو لم يبدأ تشغيله.")
    return order, transfer, raw_wh, wip_wh


def _reduce_order_cost(order: ProductionOrder, amount: Decimal) -> None:
    order.wip_balance = (order.wip_balance or Decimal("0.00")) - amount
    order.actual_material_cost = (order.actual_material_cost or Decimal("0.00")) - amount
    order.total_actual_cost = (
        order.actual_material_cost + (order.actual_labor_cost or Decimal("0.00")) + (order.actual_overhead_cost or Decimal("0.00"))
    )


# ─── 3. تأكيد أمين المخزن للاستلام الفعلي ──────────────────────────────────

async def receive_return(db: AsyncSession, *, order_id: str, transfer_id: str, data, receiver_id: str) -> WarehouseTransfer:
    order, transfer, raw_wh, _ = await _load_return(db, order_id, transfer_id)
    if transfer.status != RETURN_STATUS_IN_TRANSIT:
        raise HTTPException(status_code=409, detail="تم تأكيد استلام هذا المرتجع مسبقاً.")
    if transfer.dispatched_by and transfer.dispatched_by == receiver_id:
        raise HTTPException(
            status_code=409,
            detail="لا يجوز لمن سجّل المرتجع أن يؤكد استلامه بنفسه. يؤكده أمين المخزن أو مستخدم آخر مخوّل.",
        )

    lines_by_item = {line.item_id: line for line in transfer.lines}
    given = {entry.item_id: entry for entry in data.lines}
    if set(given) != set(lines_by_item):
        raise HTTPException(status_code=422, detail="يجب تأكيد كل خامات المرتجع صراحة (المقبول والمرفوض) دون إغفال أي خامة.")
    materials = {mat.item_id: mat for mat in order.materials}

    accepted_cost = Decimal("0.00")
    for item_id in sorted(lines_by_item):
        line, entry = lines_by_item[item_id], given[item_id]
        accepted, rejected = round(entry.accepted_quantity, 6), round(entry.rejected_quantity, 6)
        shortage = round(line.dispatched_quantity - accepted - rejected, 6)
        if shortage < -1e-9:
            raise HTTPException(
                status_code=409,
                detail=f"مجموع المقبول والمرفوض ({accepted + rejected:g}) يتجاوز الكمية المرتجعة المسجلة ({line.dispatched_quantity:g}).",
            )
        shortage = max(shortage, 0.0)
        if (shortage > 1e-9 or rejected > 1e-9) and not entry.notes.strip():
            raise HTTPException(status_code=422, detail="يلزم تفسير مكتوب لأي عجز أو كمية مرفوضة في المرتجع.")

        await lock_stock_balance(db, item_id, raw_wh.id)
        mat = materials.get(item_id)
        unit_cost = Decimal(str(mat.unit_cost if mat and mat.unit_cost is not None else 0))

        def entry_for(location: str, warehouse_id, bucket, qty: float, entry_type: str) -> None:
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=item_id, unit_id=line.unit_id,
                warehouse_id=warehouse_id, location_type=location, bucket_reference=bucket,
                quantity=qty, reference_doc_type="warehouse_transfer", reference_doc_id=transfer.id,
                transfer_line_id=line.id, entry_type=entry_type, created_by=receiver_id,
                unit_cost=unit_cost, total_cost=(Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01")),
            ))

        entry_for("in_transit", None, transfer.id, -line.dispatched_quantity, "return_receipt_transit")
        if accepted > 1e-9:
            entry_for("warehouse", raw_wh.id, None, accepted, "return_receipt")
            accepted_cost += (Decimal(str(accepted)) * unit_cost).quantize(Decimal("0.01"))
        if rejected > 1e-9:
            entry_for("discrepancy", None, rejected_bucket(transfer.id), rejected, "return_rejected")
        if shortage > 1e-9:
            entry_for("discrepancy", None, transfer.id, shortage, "return_shortage")

        line.received_quantity = accepted
        line.discrepancy_quantity = -shortage
        parts = [f"استلام المخزن: مقبول {accepted:g}"]
        if rejected > 1e-9:
            parts.append(f"مرفوض/تالف معزول {rejected:g}")
        if shortage > 1e-9:
            parts.append(f"عجز {shortage:g}")
        if entry.notes.strip():
            parts.append(f"التفسير: {entry.notes.strip()}")
        line.notes = _append(line.notes, "، ".join(parts))

    if accepted_cost > Decimal("0.00"):
        _reduce_order_cost(order, accepted_cost)
        await post_journal_entry(
            db,
            source_doc_type="production_material_return",
            source_doc_id=transfer.id,
            description=f"استلام خامات مرتجعة من الورشة لأمر {order.order_number} بمخزن الخامات ({transfer.transfer_number})",
            lines=[
                {"account_code": "1210", "debit": accepted_cost, "credit": 0, "description": "خامات مرتجعة مقبولة بمخزن الخامات"},
                {"account_code": "1220", "debit": 0, "credit": accepted_cost, "description": f"تخفيض تحت التشغيل لأمر {order.order_number}"},
            ],
            user_id=receiver_id,
        )

    state = await _state_after_flush(db, transfer)
    transfer.status = RETURN_STATUS_PENDING_RESOLUTION if state.awaiting_resolution else RETURN_STATUS_COMPLETE
    transfer.received_at = _now()
    transfer.received_by = receiver_id
    if data.notes.strip():
        transfer.notes = _append(transfer.notes, f"استلام: {data.notes.strip()}")
    await db.flush()
    return transfer


async def _state_after_flush(db: AsyncSession, transfer: WarehouseTransfer) -> ReturnState:
    await db.flush()
    return await return_state(db, transfer)


# ─── 4. التسوية النهائية للعجز والمرفوض بقرار مخوّل ─────────────────────────

async def resolve_return(db: AsyncSession, *, order_id: str, transfer_id: str, data, resolver_id: str) -> WarehouseTransfer:
    order, transfer, raw_wh, _ = await _load_return(db, order_id, transfer_id)
    if transfer.status != RETURN_STATUS_PENDING_RESOLUTION:
        raise HTTPException(status_code=409, detail="لا توجد كميات مرفوضة أو عجز معلق للتسوية في هذا المرتجع.")
    if transfer.received_by and transfer.received_by == resolver_id:
        raise HTTPException(
            status_code=409,
            detail="لا يجوز لمن أكد استلام المرتجع وأثبت العجز أو الرفض أن يسوّيه بنفسه. يسوّيه مسؤول الإنتاج أو المدير العام.",
        )

    state = await return_state(db, transfer)
    by_item = {ls.line.item_id: ls for ls in state.lines}
    materials = {mat.item_id: mat for mat in order.materials}
    resolution_id = str(uuid.uuid4())
    restock_cost = Decimal("0.00")

    for entry in sorted(data.lines, key=lambda e: (e.item_id, e.kind)):
        ls = by_item.get(entry.item_id)
        if not ls:
            raise HTTPException(status_code=422, detail="إحدى الخامات ليست ضمن هذا المرتجع.")
        line = ls.line
        qty = round(entry.quantity, 6)
        mat = materials.get(entry.item_id)
        unit_cost = Decimal(str(mat.unit_cost if mat and mat.unit_cost is not None else 0))
        cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))

        def add(location: str, warehouse_id, bucket, quantity: float, entry_type: str, total: Decimal) -> None:
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=entry.item_id, unit_id=line.unit_id,
                warehouse_id=warehouse_id, location_type=location, bucket_reference=bucket,
                quantity=quantity, reference_doc_type="warehouse_return_resolution", reference_doc_id=resolution_id,
                transfer_line_id=line.id, entry_type=entry_type, created_by=resolver_id,
                unit_cost=unit_cost, total_cost=total,
            ))

        if entry.kind == "shortage":
            if qty > ls.shortage_open + 1e-9:
                raise HTTPException(status_code=409, detail=f"كمية تسوية العجز ({qty:g}) تتجاوز العجز المعلق ({ls.shortage_open:g}).")
            # إثبات الفقد فقط؛ تكلفته تبقى على الأمر وتُحمّل على 5200 عند الإغلاق دون تحميل موظف بعينه
            add("discrepancy", None, transfer.id, -qty, "return_shortage_closed", -cost)
            ls.shortage_open -= qty
            label = f"تسوية عجز {qty:g}: إثبات فقد"
        else:
            if qty > ls.rejected_open + 1e-9:
                raise HTTPException(status_code=409, detail=f"كمية التسوية ({qty:g}) تتجاوز المرفوض المعزول ({ls.rejected_open:g}).")
            if entry.disposition == "restock":
                await lock_stock_balance(db, entry.item_id, raw_wh.id)
                add("discrepancy", None, rejected_bucket(transfer.id), -qty, "return_rejected_out", -cost)
                add("warehouse", raw_wh.id, None, qty, "return_rejected_restock", cost)
                restock_cost += cost
                label = f"قرار في المرفوض {qty:g}: إعادة للمخزن القابل للصرف"
            else:
                add("discrepancy", None, rejected_bucket(transfer.id), -qty, "return_rejected_scrap", -cost)
                label = f"قرار في المرفوض {qty:g}: هالك على الأمر"
            ls.rejected_open -= qty
        line.notes = _append(line.notes, f"{label} — بواسطة {resolver_id}، السبب: {entry.reason.strip()}")

    if restock_cost > Decimal("0.00"):
        _reduce_order_cost(order, restock_cost)
        await post_journal_entry(
            db,
            source_doc_type="production_material_return_restock",
            source_doc_id=resolution_id,
            description=f"إعادة خامات مرتجعة بعد الفحص لمخزن الخامات من أمر {order.order_number} ({transfer.transfer_number})",
            lines=[
                {"account_code": "1210", "debit": restock_cost, "credit": 0, "description": "خامات مرتجعة أعيدت للمخزن بقرار"},
                {"account_code": "1220", "debit": 0, "credit": restock_cost, "description": f"تخفيض تحت التشغيل لأمر {order.order_number}"},
            ],
            user_id=resolver_id,
        )

    transfer.notes = _append(transfer.notes, f"تسوية بواسطة {resolver_id} في {_now():%Y-%m-%d %H:%M}")
    state = await _state_after_flush(db, transfer)
    transfer.status = RETURN_STATUS_PENDING_RESOLUTION if state.awaiting_resolution else RETURN_STATUS_COMPLETE
    await db.flush()
    return transfer
