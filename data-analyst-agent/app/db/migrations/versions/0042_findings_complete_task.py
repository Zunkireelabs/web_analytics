"""Allows two activity rows: `notifying` (the nightly alerts and briefing, sent at most once a day: app/notifications/nightly.py)
and `findings_complete`: the marker a nightly run writes as its LAST step, only after every findings stage
succeeded. The analytics app's daily orchestrator waits for exactly this row and refuses to use the Data Analyst's findings
without it (app/activity/log.py FINDINGS_COMPLETE_TASK). Without this, the insert breaks ai_activity_log_task_type_check.

Additive: the existing five values stay allowed. Downgrade restores the original list (and removes marker rows first so the
narrower constraint can be re-applied).

Revision ID: 0042
Revises: 0041
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0042"
down_revision: Union[str, None] = "0041"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_BASE = ("monitoring", "forecasting", "investigating", "generating_recommendations", "preparing_drafts")


def _check(values) -> str:
    return "task_type IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    op.drop_constraint("ai_activity_log_task_type_check", "ai_activity_log", type_="check")
    op.create_check_constraint("ai_activity_log_task_type_check", "ai_activity_log", _check(_BASE + ("findings_complete", "notifying")))


def downgrade() -> None:
    op.execute("DELETE FROM ai_activity_log WHERE task_type IN ('findings_complete', 'notifying')")
    op.drop_constraint("ai_activity_log_task_type_check", "ai_activity_log", type_="check")
    op.create_check_constraint("ai_activity_log_task_type_check", "ai_activity_log", _check(_BASE))
