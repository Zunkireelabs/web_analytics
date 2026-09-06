"""Enable Phase 2 monthly metrics (Authority Score, AI Recommendation Rate,
Competitor Structural Score) — data-only, flips the disabled placeholder
rows 0001 already seeded onto the new monthly_metrics collector. No schema
change; see app/collectors/monthly_metrics.py.

Revision ID: 0003
Revises: 0001
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MONTHLY_METRIC_KEYS = ("authority_score", "ai_recommendation_rate", "competitor_structural_score")


def upgrade() -> None:
    keys = "'" + "','".join(_MONTHLY_METRIC_KEYS) + "'"
    op.execute(
        f"UPDATE metrics_catalog SET enabled = true, collector_id = 'monthly_metrics' "
        f"WHERE metric_key IN ({keys})"
    )
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = true, collector_id = 'monthly_metrics' "
        f"WHERE dimension_type = 'site' AND metric_key IN ({keys})"
    )


def downgrade() -> None:
    keys = "'" + "','".join(_MONTHLY_METRIC_KEYS) + "'"
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = false, collector_id = NULL "
        f"WHERE dimension_type = 'site' AND metric_key IN ({keys})"
    )
    op.execute(
        f"UPDATE metrics_catalog SET enabled = false, collector_id = NULL "
        f"WHERE metric_key IN ({keys})"
    )
