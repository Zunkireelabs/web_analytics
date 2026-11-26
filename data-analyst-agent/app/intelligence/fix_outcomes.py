"""Measured outcomes of shipped fixes, per client, and what they are allowed to say about a prediction.

The Node app measures every merged fix (clicks before vs after, 31 days on) and sends the result here (POST /clients/{id}/fix-outcomes).
This module stores it and turns it into ONE honest number: how often a fix of this category has actually improved clicks for THIS
client, as the lower bound of a 95% Wilson interval, so a handful of lucky results can never read as a track record.

Below MIN_MEASURED_FOR_CONFIDENCE measured outcomes in a category there is no number at all (None): "too early" is reported as such.
Never reads another client's rows."""
from math import sqrt

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FixOutcome

MIN_MEASURED_FOR_CONFIDENCE = 5
_Z95 = 1.96

# The Node app names a fix by its generator; the prediction engines name it by fix category (category_rules.py). A generator not
# listed has NO category: its outcome is stored but never counted toward a category's confidence (never guessed).
CATEGORY_BY_GENERATOR: dict[str, str] = {
    "meta-title": "metadata", "open-graph": "metadata", "schema": "metadata", "schema-repair": "metadata", "faq": "metadata",
    "expand-content": "content", "refresh-content": "content", "qa-content": "content", "direct-answer": "content",
    "internal-links": "content", "alt-text": "content", "blog": "content",
    "canonical": "technical", "robots-fix": "technical", "robots-bootstrap": "technical", "sitemap": "technical",
    "viewport": "technical", "html-lang": "technical", "security-headers": "technical", "breadcrumbs": "technical",
    "llms-txt": "technical",
}


def category_for_generator(generator_id: str | None) -> str | None:
    return CATEGORY_BY_GENERATOR.get(generator_id or "")


def wilson_lower_bound(successes: int, n: int, z: float = _Z95) -> float | None:
    """Lower end of the 95% interval for a success rate. None when n == 0."""
    if n <= 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return max(0.0, (centre - margin) / denom)


async def record_fix_outcome(
    session: AsyncSession, client_id: int, *, external_ref: str, generator_id: str, improved: bool,
    clicks_delta: float | None, delta: dict, measured_at,
) -> FixOutcome:
    """Idempotent on (client, external_ref): a retried send updates the same row, never adds a second."""
    values = dict(
        client_id=client_id, external_ref=external_ref, generator_id=generator_id, category=category_for_generator(generator_id),
        improved=improved, clicks_delta=clicks_delta, delta=delta or {}, measured_at=measured_at,
    )
    stmt = insert(FixOutcome).values(**values).on_conflict_do_update(
        constraint="fix_outcomes_unique_ref",
        set_={k: v for k, v in values.items() if k not in ("client_id", "external_ref")},
    ).returning(FixOutcome.id)
    row_id = (await session.execute(stmt)).scalar_one()
    return await session.get(FixOutcome, row_id, populate_existing=True)


async def measured_evidence(session: AsyncSession, client_id: int, category: str) -> dict:
    """What this client's own measured fixes in `category` say. `confidence` is None until there are enough of them."""
    n, improved = (await session.execute(
        select(func.count(), func.count().filter(FixOutcome.improved.is_(True)))
        .where(FixOutcome.client_id == client_id, FixOutcome.category == category)
    )).one()
    n, improved = int(n or 0), int(improved or 0)
    enough = n >= MIN_MEASURED_FOR_CONFIDENCE
    return {
        "measured": n, "improved": improved, "needed": MIN_MEASURED_FOR_CONFIDENCE, "enough": enough,
        "confidence": round(wilson_lower_bound(improved, n), 3) if enough else None,
    }
