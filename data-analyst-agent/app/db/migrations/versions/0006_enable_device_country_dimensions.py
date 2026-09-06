"""Enable Phase 4 device/country-dimension ingestion — data-only. Flips the
disabled GSC device/country placeholder rows 0001 already seeded onto the
new gsc_breakdown collector, and INSERTS new ga4_sessions/ga4_users x
device/country rows (0001 never seeded these — GA4 only got a 'channel'
dimension row, not device/country) onto the new ga4_breakdown collector.
No schema change; see app/collectors/gsc_breakdown.py and
app/collectors/ga4_breakdown.py.

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_GSC_METRIC_KEYS = ("gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position")
_GA4_METRIC_KEYS = ("ga4_sessions", "ga4_users")
_DIMENSIONS = ("device", "country")


def upgrade() -> None:
    gsc_keys = "'" + "','".join(_GSC_METRIC_KEYS) + "'"
    dims = "'" + "','".join(_DIMENSIONS) + "'"
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = true, collector_id = 'gsc_breakdown' "
        f"WHERE dimension_type IN ({dims}) AND metric_key IN ({gsc_keys})"
    )

    values = ", ".join(
        f"('{key}', '{dim}', 'ga4_breakdown', true)"
        for key in _GA4_METRIC_KEYS for dim in _DIMENSIONS
    )
    op.execute(
        f"INSERT INTO metric_dimension_support (metric_key, dimension_type, collector_id, enabled) "
        f"VALUES {values} ON CONFLICT (metric_key, dimension_type) DO UPDATE SET "
        f"enabled = true, collector_id = 'ga4_breakdown'"
    )


def downgrade() -> None:
    ga4_keys = "'" + "','".join(_GA4_METRIC_KEYS) + "'"
    gsc_keys = "'" + "','".join(_GSC_METRIC_KEYS) + "'"
    dims = "'" + "','".join(_DIMENSIONS) + "'"
    op.execute(
        f"DELETE FROM metric_dimension_support WHERE dimension_type IN ({dims}) AND metric_key IN ({ga4_keys})"
    )
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = false, collector_id = NULL "
        f"WHERE dimension_type IN ({dims}) AND metric_key IN ({gsc_keys})"
    )
