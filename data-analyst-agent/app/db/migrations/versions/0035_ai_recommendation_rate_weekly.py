"""Split AI Recommendation Rate out of the monthly_metrics collector into its
own weekly_metrics collector.

0003 enabled three metrics together as one "Phase 2 monthly metrics" batch —
Authority Score, AI Recommendation Rate, Competitor Structural Score — and all
three got cadence='monthly'/collector_id='monthly_metrics'. That's correct for
the other two (genuinely monthly at the source: DataForSEO snapshots,
structural crawls), but AI Recommendation Rate's source (ai_prompt_runs) is
real at near-daily granularity — this site alone has runs on 18 distinct dates
in under a month. The monthly cadence was a rollup choice baked into the query
(server/store/ai-recommendation.js's getMonthlyMentionRate), not a limit of
the underlying data. See app/collectors/weekly_metrics.py.

A separate scale bug found while verifying this — visibility_pct written
straight into a unit='ratio' metric without converting percent to fraction —
is corrected by the next migration (0036), not here, so this migration's own
up/down stay simple collector/cadence flips without a value transform that a
down+up cycle would silently cancel out.

No schema change. Existing metric_observations rows for ai_recommendation_rate
with a monthly-bucketed period_start are left as-is — they simply predate the
switch and sit before the weekly series starts.

Revision ID: 0035
Revises: 0034
Create Date: 2026-08-15

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0035"
down_revision: Union[str, None] = "0034"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_METRIC_KEY = "ai_recommendation_rate"


def upgrade() -> None:
    op.execute(
        f"UPDATE metrics_catalog SET cadence = 'weekly', collector_id = 'weekly_metrics' "
        f"WHERE metric_key = '{_METRIC_KEY}'"
    )
    op.execute(
        f"UPDATE metric_dimension_support SET collector_id = 'weekly_metrics' "
        f"WHERE dimension_type = 'site' AND metric_key = '{_METRIC_KEY}'"
    )


def downgrade() -> None:
    op.execute(
        f"UPDATE metrics_catalog SET cadence = 'monthly', collector_id = 'monthly_metrics' "
        f"WHERE metric_key = '{_METRIC_KEY}'"
    )
    op.execute(
        f"UPDATE metric_dimension_support SET collector_id = 'monthly_metrics' "
        f"WHERE dimension_type = 'site' AND metric_key = '{_METRIC_KEY}'"
    )
