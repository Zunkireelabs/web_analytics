"""Feature Importance Engine (Phase 2 Stage 1) — determines which metrics
most explain the variance in a target KPI, via permutation importance over
a gradient-boosted regressor. Real ML, not a heuristic: importances are the
model's own measured performance drop when a feature is shuffled, normalized
to sum to 100%. Never invents an importance for a target it couldn't fit —
reports insufficient-data instead."""
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.preprocessing import StandardScaler
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, FeatureImportanceRun, FeatureImportanceScore, MetricCatalog
from app.db.session import SessionLocal
from app.ml.feature_matrix import build_feature_matrix
from app.scoring.confidence import compute_confidence

MIN_OBSERVATIONS_FOR_MODEL = 60
TEST_FRACTION = 0.2
MIN_TEST_OBSERVATIONS = 5
RANDOM_STATE = 42
METHOD = "permutation_importance"
MODEL_TYPE = "gradient_boosting_regressor"


async def run_feature_importance() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        # Forecastable metrics are the plausible target KPIs — same notion
        # of "is this metric a real trend worth explaining" the Forecast
        # Engine already uses (app/forecast/run.py).
        targets = (
            await session.execute(select(MetricCatalog).where(MetricCatalog.is_forecastable.is_(True)))
        ).scalars().all()

    for client in clients:
        for target in targets:
            async with SessionLocal() as session:
                await _run_for_target(session, client.id, target)
                await session.commit()


async def _run_for_target(session: AsyncSession, client_id: int, target: MetricCatalog) -> None:
    matrix = await build_feature_matrix(session, client_id)
    if matrix.empty or target.metric_key not in matrix.columns:
        await _record_insufficient(session, client_id, target.metric_key, "target metric has no observations for this client")
        return

    total_days = len(matrix)
    usable = matrix.dropna(subset=[target.metric_key])
    usable = usable.dropna(axis=1, how="all")  # drop features with zero overlap with the target entirely
    feature_keys = [c for c in usable.columns if c != target.metric_key]
    # Complete-case rows only — a day missing even one remaining feature is
    # dropped rather than imputed, per the "never fabricate a value" rule.
    usable = usable.dropna()

    n = len(usable)
    if n < MIN_OBSERVATIONS_FOR_MODEL or not feature_keys:
        await _record_insufficient(
            session, client_id, target.metric_key,
            f"only {n} complete overlapping days across {len(feature_keys)} candidate features, need >= {MIN_OBSERVATIONS_FOR_MODEL}",
        )
        return

    X = usable[feature_keys].values
    y = usable[target.metric_key].values

    # Time-ordered split, never a random shuffle — this is a time series;
    # shuffling would leak autocorrelated information across the split.
    split = int(n * (1 - TEST_FRACTION))
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    if len(X_test) < MIN_TEST_OBSERVATIONS:
        await _record_insufficient(session, client_id, target.metric_key, "not enough trailing days for a held-out test split")
        return

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    model = GradientBoostingRegressor(random_state=RANDOM_STATE)
    model.fit(X_train_scaled, y_train)
    model_score = float(model.score(X_test_scaled, y_test))  # held-out R^2, can be negative for a bad fit

    perm = permutation_importance(model, X_test_scaled, y_test, n_repeats=20, random_state=RANDOM_STATE)
    # A shuffle can "help" the score by chance on a small held-out set —
    # treat that as zero measured contribution, never a negative one.
    raw_importances = np.clip(perm.importances_mean, a_min=0, a_max=None)
    total = raw_importances.sum()
    if total <= 0:
        await _record_insufficient(session, client_id, target.metric_key, "no feature had positive measured importance")
        return
    importance_pct = raw_importances / total * 100

    run = FeatureImportanceRun(
        client_id=client_id, target_metric_key=target.metric_key,
        method=METHOD, model_type=MODEL_TYPE,
        n_observations=n, model_score=model_score, status="ok",
    )
    session.add(run)
    await session.flush()  # need run.id before inserting scores

    for rank, idx in enumerate(np.argsort(-importance_pct), start=1):
        session.add(FeatureImportanceScore(
            run_id=run.id, feature_metric_key=feature_keys[idx],
            importance_pct=float(importance_pct[idx]), importance_raw=float(raw_importances[idx]), rank=rank,
        ))

    confidence_id, confidence = await compute_confidence(
        session, client_id=client_id, subject_type="feature_importance", subject_id=run.id,
        components={
            "data_completeness": n / total_days,
            "historical_coverage": min(n / MIN_OBSERVATIONS_FOR_MODEL, 1.0),
            "statistical_significance": None,  # no hypothesis test here — see model_certainty instead
            "model_certainty": max(0.0, min(1.0, model_score)),
            "anomaly_strength": None,  # not applicable to this engine
        },
    )
    run.confidence_score_id = confidence_id
    run.confidence = confidence.score


async def _record_insufficient(session: AsyncSession, client_id: int, target_metric_key: str, reason: str) -> None:
    session.add(FeatureImportanceRun(
        client_id=client_id, target_metric_key=target_metric_key,
        method=METHOD, model_type=MODEL_TYPE,
        n_observations=0, model_score=None, status="insufficient-data", error=reason,
    ))
