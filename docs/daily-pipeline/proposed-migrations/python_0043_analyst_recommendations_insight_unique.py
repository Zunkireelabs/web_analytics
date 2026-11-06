"""PROPOSED (not in app/db/migrations/versions, so it does not run at container start). One analyst recommendation per insight.

WHY. app/insights/recommendations.py creates a recommendation only for an insight that has none (check-then-insert, with a slow LLM
call in between), and two queries assume exactly one row per insight: app/insights/engine.py `_replace_insight` and
app/insights/recommendations.py (the dashboard summary), both `.scalar_one_or_none()`. Migration 0001 created the table without the
constraint its siblings got, so the database never enforced it. Two runs at once (which happened: staging's crontab and
production's scheduler wrote the same database) can insert two rows for one insight, after which every later run raises
"Multiple rows were found when one or none was required".

SAFETY. Refuses to run if duplicates already exist and lists them: nothing is deleted or chosen arbitrarily. Read-only check on
production (5 Nov 2026): 231 rows, 0 null insight_id, 0 insights with more than one row. The table is small; adding the constraint
takes a brief exclusive lock.

FOLLOW-UP needed in the engine (not part of this file): with the constraint, a concurrent second insert fails with an
IntegrityError instead of silently duplicating; the engine should treat that as "the other run created it" for that insight.

Revision ID: 0043
Revises: 0042
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0043"
down_revision: Union[str, None] = "0042"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    dupes = op.get_bind().execute(sa.text(
        "SELECT insight_id, array_agg(id ORDER BY id) FROM analyst_recommendations GROUP BY insight_id HAVING count(*) > 1 LIMIT 20"
    )).all()
    if dupes:
        listed = "; ".join(f"insight {i}: rows {list(ids)}" for i, ids in dupes)
        raise RuntimeError(f"analyst_recommendations has more than one row per insight ({listed}). Resolve these by hand; this "
                           "migration does not delete or choose between them.")
    op.create_unique_constraint("analyst_recommendations_insight_id_key", "analyst_recommendations", ["insight_id"])


def downgrade() -> None:
    op.drop_constraint("analyst_recommendations_insight_id_key", "analyst_recommendations", type_="unique")
