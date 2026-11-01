"""Add append-only warehouse stock ledger for transfers and receipts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0006"
down_revision: Union[str, Sequence[str], None] = "20261030_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "stock_ledger_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("warehouse_id", sa.String(36), sa.ForeignKey("warehouses.id"), nullable=True),
        sa.Column("location_type", sa.String(24), nullable=False),
        sa.Column("bucket_reference", sa.String(64), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=False),
        sa.Column("reference_doc_type", sa.String(64), nullable=False),
        sa.Column("reference_doc_id", sa.String(36), nullable=False),
        sa.Column("transfer_line_id", sa.String(36), sa.ForeignKey("warehouse_transfer_lines.id"), nullable=True),
        sa.Column("entry_type", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.CheckConstraint("location_type in ('warehouse', 'in_transit', 'discrepancy')", name="ck_stock_ledger_location_type"),
        sa.CheckConstraint("quantity <> 0", name="ck_stock_ledger_quantity_nonzero"),
    )
    op.create_index("ix_stock_ledger_entries_item_id", "stock_ledger_entries", ["item_id"])
    op.create_index("ix_stock_ledger_entries_warehouse_id", "stock_ledger_entries", ["warehouse_id"])
    op.create_index("ix_stock_ledger_entries_reference", "stock_ledger_entries", ["reference_doc_type", "reference_doc_id"])


def downgrade() -> None:
    connection = op.get_bind()
    entry_count = connection.execute(sa.text("select count(*) from stock_ledger_entries")).scalar_one()
    if entry_count:
        raise RuntimeError("رفض التراجع: سجل المخزون يحتوي حركات يجب حفظها.")
    op.drop_index("ix_stock_ledger_entries_reference", table_name="stock_ledger_entries")
    op.drop_index("ix_stock_ledger_entries_warehouse_id", table_name="stock_ledger_entries")
    op.drop_index("ix_stock_ledger_entries_item_id", table_name="stock_ledger_entries")
    op.drop_table("stock_ledger_entries")
