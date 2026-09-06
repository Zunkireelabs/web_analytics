"""Shared confidence scoring for every Phase 2 intelligence engine. One
call site (compute_confidence) instead of each engine re-deriving its own
weighted-average-with-fallback logic."""
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ConfidenceScore

# The five named factors from the spec, plus one Phase 4 addition. Not
# every engine has signal for every factor (e.g. Effort Estimation has no
# anomaly_strength concept) — callers pass None for any factor that doesn't
# apply to them, or simply omit it from `components` entirely.
CONFIDENCE_FACTORS = (
    "data_completeness",
    "historical_coverage",
    "statistical_significance",
    "model_certainty",
    "anomaly_strength",
    # Phase 4 (prediction -> outcome -> learning loop) — a metric's own real
    # predicted-vs-actual track record (app/forecast/accuracy.py), used only
    # by app/forecast/confidence.py today. Distinct from model_certainty,
    # which is an in-sample backtest error rather than a real-world record.
    "historical_forecast_accuracy",
    # Phase 4 addition, same pattern as historical_forecast_accuracy just
    # above but for approved forecast_risk Investigations rather than raw
    # ForecastPoints (see app/investigations/outcome.py's
    # get_investigation_outcome_reliability and its one caller,
    # app/forecast/confidence.py) — how often THIS client's forecast-risk
    # investigations' predicted declines actually materialized.
    "investigation_outcome_reliability",
)


@dataclass
class ConfidenceResult:
    status: str  # 'ok' | 'insufficient-data'
    score: float | None  # 0.0-1.0, None when status == 'insufficient-data'
    components: dict[str, float | None]


async def compute_confidence(
    session: AsyncSession,
    *,
    client_id: int,
    subject_type: str,
    subject_id: int,
    components: dict[str, float | None],
) -> tuple[int, ConfidenceResult]:
    """Combine named confidence factors into a single 0-1 score, persist it,
    and return (confidence_scores.id, result) for the caller to denormalize
    onto its own row.

    Weight is redistributed only across the PRESENT (non-None) factors — a
    factor an engine has no signal for is never silently treated as 0, which
    would fabricate a penalty the engine didn't actually compute. When every
    factor is None, status is 'insufficient-data' rather than a fabricated
    0.0 — a real 0.0 means "confidently no confidence", which is a different
    claim than "this engine had no signal to judge confidence from"."""
    present = {k: v for k, v in components.items() if v is not None}
    if not present:
        result = ConfidenceResult(status="insufficient-data", score=None, components=components)
    else:
        raw_score = sum(present.values()) / len(present)
        result = ConfidenceResult(status="ok", score=max(0.0, min(1.0, raw_score)), components=components)

    row = ConfidenceScore(
        client_id=client_id,
        subject_type=subject_type,
        subject_id=subject_id,
        status=result.status,
        score=result.score,
        components=components,
    )
    session.add(row)
    await session.flush()
    return row.id, result
