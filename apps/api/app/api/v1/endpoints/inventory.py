from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import require_permission
from app.db.session import get_db
from app.modules.production.models import CatalogItem, StockLedgerEntry, Warehouse
from app.modules.production.schemas import StockBalanceRead, StockLedgerEntryRead

router = APIRouter(prefix="/inventory", tags=["inventory"])


@router.get("/stock", response_model=List[StockBalanceRead])
async def list_stock_balances(
    warehouse_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:view")),
    db: AsyncSession = Depends(get_db),
):
    warehouses_stmt = select(Warehouse).where(Warehouse.is_active.is_(True)).order_by(Warehouse.code)
    if warehouse_id:
        warehouses_stmt = warehouses_stmt.where(Warehouse.id == warehouse_id)
    warehouses = (await db.scalars(warehouses_stmt)).all()
    items = (await db.scalars(select(CatalogItem).options(selectinload(CatalogItem.unit)).where(CatalogItem.is_active.is_(True)).order_by(CatalogItem.code))).all()
    totals = (await db.execute(
        select(StockLedgerEntry.item_id, StockLedgerEntry.warehouse_id,
               func.sum(StockLedgerEntry.quantity), func.count(StockLedgerEntry.id))
        .where(StockLedgerEntry.location_type == "warehouse", StockLedgerEntry.warehouse_id.is_not(None))
        .group_by(StockLedgerEntry.item_id, StockLedgerEntry.warehouse_id)
    )).all()
    total_map = {(item_id, wh_id): (float(quantity), int(count)) for item_id, wh_id, quantity, count in totals}
    return [
        StockBalanceRead(
            item_id=item.id, item_code=item.code, item_name_ar=item.name_ar,
            unit_id=item.unit_id, unit_name_ar=item.unit.name_ar if item.unit else "",
            warehouse_id=warehouse.id, warehouse_code=warehouse.code,
            warehouse_name_ar=warehouse.name_ar,
            balance=total_map.get((item.id, warehouse.id), (None, 0))[0],
            is_established=total_map.get((item.id, warehouse.id), (None, 0))[1] > 0,
        )
        for warehouse in warehouses for item in items
    ]


@router.get("/ledger", response_model=List[StockLedgerEntryRead])
async def list_stock_ledger(
    item_id: Optional[str] = Query(default=None),
    warehouse_id: Optional[str] = Query(default=None),
    reference_doc_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("inventory:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(StockLedgerEntry).options(
        selectinload(StockLedgerEntry.item).selectinload(CatalogItem.unit),
        selectinload(StockLedgerEntry.unit),
        selectinload(StockLedgerEntry.warehouse),
    ).order_by(StockLedgerEntry.created_at.desc())
    if item_id:
        stmt = stmt.where(StockLedgerEntry.item_id == item_id)
    if warehouse_id:
        stmt = stmt.where(StockLedgerEntry.warehouse_id == warehouse_id)
    if reference_doc_id:
        stmt = stmt.where(StockLedgerEntry.reference_doc_id == reference_doc_id)
    entries = (await db.scalars(stmt.limit(500))).all()
    return [StockLedgerEntryRead(
        id=row.id, item_id=row.item_id, item_code=row.item.code, item_name_ar=row.item.name_ar,
        unit_id=row.unit_id, unit_name_ar=row.unit.name_ar,
        warehouse_id=row.warehouse_id, warehouse_name_ar=row.warehouse.name_ar if row.warehouse else None,
        location_type=row.location_type, bucket_reference=row.bucket_reference, quantity=row.quantity,
        reference_doc_type=row.reference_doc_type, reference_doc_id=row.reference_doc_id,
        transfer_line_id=row.transfer_line_id, entry_type=row.entry_type,
        created_at=row.created_at, created_by=row.created_by,
    ) for row in entries]
