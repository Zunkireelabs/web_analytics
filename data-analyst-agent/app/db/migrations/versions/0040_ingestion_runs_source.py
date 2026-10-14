"""Records which source produced each ingestion run.

MCP is no longer the only way a collector can get its data: when the MCP
endpoint is unreachable or rejects the client's token, DataSource
(app/mcp_client/datasource.py) reads the same rows straight out of the shared
database instead, so ingestion keeps moving. That is a real improvement in
availability and a real loss of provenance — without this column a night
served entirely from the database is indistinguishable from a full-fidelity
MCP night, which is precisely the kind of silent degradation the twelve-day
August 2026 outage taught us to refuse.

Nullable with no backfill: every existing row predates the fallback and was
therefore MCP-served, but writing 'mcp' into them would be asserting something
this migration cannot actually verify. Null honestly means "not recorded".

Revision ID: 0040
Revises: 0039
Create Date: 2026-09-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0040"
down_revision: Union[str, None] = "0039"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ingestion_runs", sa.Column("source", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ingestion_runs_source_check",
        "ingestion_runs",
        "source IS NULL OR source IN ('mcp','direct-db','mixed')",
    )


def downgrade() -> None:
    op.drop_constraint("ingestion_runs_source_check", "ingestion_runs", type_="check")
    op.drop_column("ingestion_runs", "source")
