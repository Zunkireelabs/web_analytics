"""Enable Phase 3 channel-dimension ingestion (ga4_sessions/ga4_users x
channel) — data-only, flips the disabled placeholder rows 0001 already
seeded onto the new ga4_channels collector. No schema change; see
app/collectors/ga4_channels.py.

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CHANNEL_METRIC_KEYS = ("ga4_sessions", "ga4_users")


def upgrade() -> None:
    keys = "'" + "','".join(_CHANNEL_METRIC_KEYS) + "'"
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = true, collector_id = 'ga4_channels' "
        f"WHERE dimension_type = 'channel' AND metric_key IN ({keys})"
    )


def downgrade() -> None:
    keys = "'" + "','".join(_CHANNEL_METRIC_KEYS) + "'"
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = false, collector_id = NULL "
        f"WHERE dimension_type = 'channel' AND metric_key IN ({keys})"
    )
