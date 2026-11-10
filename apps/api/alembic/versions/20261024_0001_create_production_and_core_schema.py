"""create_production_and_core_schema

Revision ID: 20261024_0001
Revises: 
Create Date: 2026-10-24 19:45:00.000000

ترحيل أولي لإنشاء جداول أوامر الإنتاج والمخازن والأدوار والجداول التأسيسية.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20261024_0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ─── 1. الهوية والأدوار والصلاحيات ───────────────────────────────────────
    op.create_table(
        'roles',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('name', sa.String(length=64), nullable=False, unique=True),
        sa.Column('display_name_ar', sa.String(length=128), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_roles_name', 'roles', ['name'])

    op.create_table(
        'permissions',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('module', sa.String(length=64), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
    )
    op.create_index('ix_permissions_code', 'permissions', ['code'])

    op.create_table(
        'role_permissions',
        sa.Column('role_id', sa.String(length=36), sa.ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('permission_id', sa.String(length=36), sa.ForeignKey('permissions.id', ondelete='CASCADE'), primary_key=True),
    )

    op.create_table(
        'user_roles',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('user_id', sa.String(length=64), nullable=False),
        sa.Column('role_id', sa.String(length=36), sa.ForeignKey('roles.id', ondelete='CASCADE'), nullable=False),
        sa.Column('assigned_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('assigned_by', sa.String(length=64), nullable=False),
    )
    op.create_index('ix_user_roles_user_id', 'user_roles', ['user_id'])

    # ─── 2. المخازن والوحدات والدليل ──────────────────────────────────────────
    op.create_table(
        'warehouses',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('name_ar', sa.String(length=128), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, default=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_warehouses_code', 'warehouses', ['code'])

    op.create_table(
        'units',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=32), nullable=False, unique=True),
        sa.Column('name_ar', sa.String(length=64), nullable=False),
    )
    op.create_index('ix_units_code', 'units', ['code'])

    op.create_table(
        'catalog_items',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('name_ar', sa.String(length=128), nullable=False),
        sa.Column('item_type', sa.String(length=64), nullable=False),
        sa.Column('unit_id', sa.String(length=36), sa.ForeignKey('units.id'), nullable=False),
        sa.Column('is_consumable', sa.Boolean(), nullable=False, default=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, default=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_catalog_items_code', 'catalog_items', ['code'])

    # ─── 3. المنتجات والموديلات والمتغيرات ────────────────────────────────────
    op.create_table(
        'products',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('name_ar', sa.String(length=128), nullable=False),
        sa.Column('style_type', sa.String(length=64), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_products_code', 'products', ['code'])

    op.create_table(
        'product_variants',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('products.id', ondelete='CASCADE'), nullable=False),
        sa.Column('numeric_size', sa.Integer(), nullable=False),
        sa.Column('letter_size', sa.String(length=16), nullable=False),
        sa.Column('season', sa.String(length=32), nullable=False),
        sa.Column('sku', sa.String(length=64), nullable=False, unique=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_product_variants_sku', 'product_variants', ['sku'])

    # ─── 4. قوالب الإنتاج ─────────────────────────────────────────────────────
    op.create_table(
        'production_templates',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('name_ar', sa.String(length=128), nullable=False),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('products.id'), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, default=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_production_templates_code', 'production_templates', ['code'])

    op.create_table(
        'production_template_versions',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('template_id', sa.String(length=36), sa.ForeignKey('production_templates.id', ondelete='CASCADE'), nullable=False),
        sa.Column('version_number', sa.Integer(), nullable=False, default=1),
        sa.Column('status', sa.String(length=32), nullable=False, default='draft'),
        sa.Column('reference_quantity', sa.Float(), nullable=False, default=100.0),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'production_template_lines',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('version_id', sa.String(length=36), sa.ForeignKey('production_template_versions.id', ondelete='CASCADE'), nullable=False),
        sa.Column('item_id', sa.String(length=36), sa.ForeignKey('catalog_items.id'), nullable=False),
        sa.Column('unit_id', sa.String(length=36), sa.ForeignKey('units.id'), nullable=False),
        sa.Column('quantity_per_reference', sa.Float(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
    )

    # ─── 5. أوامر التشغيل ولقطة المواد ────────────────────────────────────────
    op.create_table(
        'production_orders',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('order_number', sa.String(length=64), nullable=False, unique=True),
        sa.Column('product_id', sa.String(length=36), sa.ForeignKey('products.id'), nullable=False),
        sa.Column('variant_id', sa.String(length=36), sa.ForeignKey('product_variants.id'), nullable=False),
        sa.Column('template_version_id', sa.String(length=36), sa.ForeignKey('production_template_versions.id'), nullable=True),
        sa.Column('target_quantity', sa.Float(), nullable=False),
        sa.Column('season', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, default='draft'),
        sa.Column('created_by', sa.String(length=64), nullable=False),
        sa.Column('assigned_to', sa.String(length=128), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_index('ix_production_orders_order_number', 'production_orders', ['order_number'])

    op.create_table(
        'production_order_materials',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('order_id', sa.String(length=36), sa.ForeignKey('production_orders.id', ondelete='CASCADE'), nullable=False),
        sa.Column('item_id', sa.String(length=36), sa.ForeignKey('catalog_items.id'), nullable=False),
        sa.Column('unit_id', sa.String(length=36), sa.ForeignKey('units.id'), nullable=False),
        sa.Column('planned_quantity', sa.Float(), nullable=False),
        sa.Column('dispatched_quantity', sa.Float(), nullable=False, default=0.0),
        sa.Column('received_quantity', sa.Float(), nullable=False, default=0.0),
        sa.Column('discrepancy_quantity', sa.Float(), nullable=False, default=0.0),
        sa.Column('status', sa.String(length=32), nullable=False, default='pending'),
        sa.Column('notes', sa.Text(), nullable=True),
    )

    # ─── 6. التحويلات المخزنية ────────────────────────────────────────────────
    op.create_table(
        'warehouse_transfers',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('transfer_number', sa.String(length=64), nullable=False, unique=True),
        sa.Column('order_id', sa.String(length=36), sa.ForeignKey('production_orders.id'), nullable=False),
        sa.Column('source_warehouse_id', sa.String(length=36), sa.ForeignKey('warehouses.id'), nullable=False),
        sa.Column('destination_warehouse_id', sa.String(length=36), sa.ForeignKey('warehouses.id'), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, default='in_transit'),
        sa.Column('dispatched_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('dispatched_by', sa.String(length=64), nullable=False),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('received_by', sa.String(length=64), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_index('ix_warehouse_transfers_transfer_number', 'warehouse_transfers', ['transfer_number'])

    op.create_table(
        'warehouse_transfer_lines',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('transfer_id', sa.String(length=36), sa.ForeignKey('warehouse_transfers.id', ondelete='CASCADE'), nullable=False),
        sa.Column('item_id', sa.String(length=36), sa.ForeignKey('catalog_items.id'), nullable=False),
        sa.Column('unit_id', sa.String(length=36), sa.ForeignKey('units.id'), nullable=False),
        sa.Column('dispatched_quantity', sa.Float(), nullable=False),
        sa.Column('received_quantity', sa.Float(), nullable=False, default=0.0),
        sa.Column('discrepancy_quantity', sa.Float(), nullable=False, default=0.0),
        sa.Column('notes', sa.Text(), nullable=True),
    )

    # ─── 7. تتبع مراحل التشغيل ───────────────────────────────────────────────
    op.create_table(
        'production_stage_events',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('order_id', sa.String(length=36), sa.ForeignKey('production_orders.id', ondelete='CASCADE'), nullable=False),
        sa.Column('stage_name', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('actor_id', sa.String(length=64), nullable=False),
        sa.Column('actor_name', sa.String(length=128), nullable=True),
        sa.Column('timestamp', sa.DateTime(timezone=True), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
    )

    # ─── 8. الجداول التأسيسية للهيكل العام ─────────────────────────────────────
    op.create_table(
        'customers',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('name', sa.String(length=128), nullable=False),
        sa.Column('phone', sa.String(length=32), nullable=True),
        sa.Column('city', sa.String(length=64), nullable=True),
        sa.Column('address', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False, default='active'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'employees',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('code', sa.String(length=64), nullable=False, unique=True),
        sa.Column('name', sa.String(length=128), nullable=False),
        sa.Column('department', sa.String(length=64), nullable=True),
        sa.Column('job_title', sa.String(length=64), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False, default='active'),
        sa.Column('hire_date', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'pay_periods',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('period_name', sa.String(length=64), nullable=False),
        sa.Column('start_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('end_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, default='draft'),
    )

    op.create_table(
        'payroll_runs',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('period_id', sa.String(length=36), sa.ForeignKey('pay_periods.id'), nullable=False),
        sa.Column('employee_id', sa.String(length=36), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('net_amount', sa.Float(), nullable=False, default=0.0),
        sa.Column('notes', sa.Text(), nullable=True),
    )

    op.create_table(
        'daily_expenses',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('expense_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('category', sa.String(length=64), nullable=False),
        sa.Column('amount', sa.Float(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_by', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, default='pending'),
    )


def downgrade() -> None:
    op.drop_table('daily_expenses')
    op.drop_table('payroll_runs')
    op.drop_table('pay_periods')
    op.drop_table('employees')
    op.drop_table('customers')
    op.drop_table('production_stage_events')
    op.drop_table('warehouse_transfer_lines')
    op.drop_table('warehouse_transfers')
    op.drop_table('production_order_materials')
    op.drop_table('production_orders')
    op.drop_table('production_template_lines')
    op.drop_table('production_template_versions')
    op.drop_table('production_templates')
    op.drop_table('product_variants')
    op.drop_table('products')
    op.drop_table('catalog_items')
    op.drop_table('units')
    op.drop_table('warehouses')
    op.drop_table('user_roles')
    op.drop_table('role_permissions')
    op.drop_table('permissions')
    op.drop_table('roles')
