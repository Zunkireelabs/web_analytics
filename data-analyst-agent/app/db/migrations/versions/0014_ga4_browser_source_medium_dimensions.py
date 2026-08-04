"""Enable Phase 2 Stage 0 GA4 browser/source_medium dimension ingestion —
data-only, mirrors 0006's device/country pattern. Depends on the companion
Node-app change (server/ingest/ga4.js + server/store/upsert.js) already
populating ga4_breakdown with dim_type='browser'/'source_medium' rows, and
the mcp-server get_ga4_breakdown_daily_series tool's dim enum already
including them. See app/collectors/ga4_browser.py and
app/collectors/ga4_source_medium.py.

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_GA4_METRIC_KEYS = ("ga4_sessions", "ga4_users")
_COLLECTOR_BY_DIM = {"browser": "ga4_browser", "source_medium": "ga4_source_medium"}


def upgrade() -> None:
    values = ", ".join(
        f"('{key}', '{dim}', '{collector_id}', true)"
        for key in _GA4_METRIC_KEYS for dim, collector_id in _COLLECTOR_BY_DIM.items()
    )
    op.execute(
        f"INSERT INTO metric_dimension_support (metric_key, dimension_type, collector_id, enabled) "
        f"VALUES {values} ON CONFLICT (metric_key, dimension_type) DO UPDATE SET "
        f"enabled = true, collector_id = EXCLUDED.collector_id"
    )


def downgrade() -> None:
    ga4_keys = "'" + "','".join(_GA4_METRIC_KEYS) + "'"
    dims = "'" + "','".join(_COLLECTOR_BY_DIM.keys()) + "'"
    op.execute(
        f"DELETE FROM metric_dimension_support WHERE dimension_type IN ({dims}) AND metric_key IN ({ga4_keys})"
    )
