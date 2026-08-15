"""Fix a 100x scale bug in ai_recommendation_rate's stored values.

The old monthly collector (removed in 0035) wrote visibility_pct — a genuine
0-100 percentage, the same convention server/agents/ai-recommendation.js uses
for aiVisibilityPct everywhere else in this codebase — straight into a
unit='ratio' metric. Every OTHER ratio metric (gsc_ctr, engagement_rate, ...)
stores a 0-1 fraction, and the frontend's formatByUnit multiplies a ratio by
100 to render it. So a real 0.86% AI-mention rate was stored as 0.86 and
displayed as "86.0%" — a 100x inflation, not a rounding quirk.

app/collectors/weekly_metrics.py (0035) already divides by 100 at write time
going forward. This migration corrects the observations already in the
database. Unconditional (not `WHERE value > 1`): this site's real mention rate
is itself under 1% some months, so the buggy value can land <= 1, which makes
it indistinguishable from an already-correct ratio by magnitude alone. That is
still safe here because every metric_observations row for this metric_key
that exists as of this migration was written by the one buggy code path 0035
removed — there is no earlier code path that could have written an
already-correct ratio for this metric to accidentally double-correct.

Kept as its own migration rather than folded into 0035: editing an
already-applied migration's up/down and re-running it via downgrade+upgrade
is a no-op for a pure value transform (multiply and divide are exact
inverses), which is how this bug was first caught by hand while verifying
0035 — a follow-up migration is the only way to apply a value correction
exactly once.

Revision ID: 0036
Revises: 0035
Create Date: 2026-08-15

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0036"
down_revision: Union[str, None] = "0035"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_METRIC_KEY = "ai_recommendation_rate"


def upgrade() -> None:
    op.execute(
        f"UPDATE metric_observations SET value = value / 100 "
        f"WHERE metric_key = '{_METRIC_KEY}'"
    )


def downgrade() -> None:
    op.execute(
        f"UPDATE metric_observations SET value = value * 100 "
        f"WHERE metric_key = '{_METRIC_KEY}'"
    )
