"""Enable Row Level Security on all public schema tables.

Revision ID: 20261116_0037
Revises: 20261116_0036
Create Date: 2026-11-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261116_0037"
down_revision: Union[str, Sequence[str], None] = "20261116_0036"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Enable Row Level Security (RLS) on all public schema tables except alembic_version.
    # No policies are added (Default Deny for PostgREST anon & authenticated roles).
    # The application backend connects as table owner / superuser which automatically bypasses RLS.
    conn = op.get_bind()
    conn.execute(sa.text("""
        DO $$
        DECLARE
            tbl text;
        BEGIN
            FOR tbl IN
                SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'alembic_version'
            LOOP
                EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
            END LOOP;
        END $$;
    """))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("""
        DO $$
        DECLARE
            tbl text;
        BEGIN
            FOR tbl IN
                SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'alembic_version'
            LOOP
                EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', tbl);
            END LOOP;
        END $$;
    """))
