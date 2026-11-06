"""PROPOSED (not in app/db/migrations/versions). One insight per identity: (client, metric, dimension, period, insight type).

WHY. app/insights/engine.py `_replace_insight` looks the insight up by exactly these six columns with `.scalar_one_or_none()`, and
the insight engine is written as "replace the insight with this identity", but nothing in the database enforces one row per
identity, so concurrent runs could create two and every later run would raise. All six columns are NOT NULL, so a plain unique
constraint enforces it (no NULL loophole).

SAFETY. Refuses to run if duplicates exist and lists them; nothing is deleted. Read-only check on production (5 Nov 2026): 0
duplicate identities.

Revision ID: 0044
Revises: 0043
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: Union[str, None] = "0043"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = ["client_id", "metric_key", "dimension_type", "dimension_value", "period_start", "insight_type"]


def upgrade() -> None:
    dupes = op.get_bind().execute(sa.text(
        f"SELECT {', '.join(COLUMNS)}, array_agg(id ORDER BY id) FROM insights GROUP BY {', '.join(COLUMNS)} HAVING count(*) > 1 LIMIT 20"
    )).all()
    if dupes:
        raise RuntimeError(f"insights has {len(dupes)}+ duplicated identities (first: {tuple(dupes[0])}). Resolve them by hand; this "
                           "migration does not delete or choose between them.")
    op.create_unique_constraint("insights_identity_key", "insights", COLUMNS)


def downgrade() -> None:
    op.drop_constraint("insights_identity_key", "insights", type_="unique")
