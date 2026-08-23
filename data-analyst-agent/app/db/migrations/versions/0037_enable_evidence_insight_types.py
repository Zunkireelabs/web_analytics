"""Enable three new evidence-graded insight_type values on the existing
insights table — content_decay (a stricter classification of an existing
page-dimension trend_shift/forecast_risk pair, see app/insights/engine.py's
_content_decay_insights), target_keyword_evidence (app/intelligence/
target_keyword_evidence.py), and cannibalization (app/intelligence/
cannibalization.py). No new table, no new pipeline — these flow through the
exact same Insight -> AnalystRecommendations -> opportunity scoring ->
prioritizer -> draft trigger path every other insight_type already uses.

Revision ID: 0037
Revises: 0036
Create Date: 2026-08-22

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0037"
down_revision: Union[str, None] = "0036"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("insights_type_check", "insights", type_="check")
    op.create_check_constraint(
        "insights_type_check", "insights",
        "insight_type IN ('anomaly','trend_shift','forecast_risk','milestone','content_decay','target_keyword_evidence','cannibalization')",
    )


def downgrade() -> None:
    op.drop_constraint("insights_type_check", "insights", type_="check")
    op.create_check_constraint(
        "insights_type_check", "insights",
        "insight_type IN ('anomaly','trend_shift','forecast_risk','milestone')",
    )
