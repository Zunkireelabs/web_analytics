"""The DB-facing prediction pass. Runs inside the nightly analysis pass (analysis/run_pass.py)
after the insight engine, so the forecast_risk insights it writes flow through the existing
recommendations -> Action Center -> auto-remediation path unchanged.

Per active client, best-effort (one tenant failing never stops the others):
  1. resolve earlier predictions whose week has now fully landed (actual + error)
  2. forecast next 3 weeks of clicks and impressions, log them
  3. score every page's chance of losing clicks next week, keep the likely ones
  4. find queries that can grow
Weekly, across ALL clients: retrain the pooled model on anonymous feature rows only."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Client, Insight, KeywordPrediction, MetricObservation, PageQueryObservation, PredictedIssue, PredictionLog, PredictionModel,
)
from app.db.session import SessionLocal
from app.predict import issues as issue_model
from app.predict.industry import MIN_PROJECTS, industry_outlook
from app.predict.features import DECLINE_FRACTION, MIN_VOLUME, feature_row, training_rows
from app.predict.keywords import growth_candidate
from app.predict.outlook import forecast_series
from app.predict.series import week_start, weekly_mean_weighted, weekly_rate, weekly_sum

logger = logging.getLogger(__name__)

LIKELIHOOD_FLOOR = 0.5       # shown on the page
INSIGHT_FLOOR = 0.6          # feeds Action Center / auto-fix
MAX_ISSUES = 10
MAX_KEYWORDS = 10
HISTORY_WEEKS = 30
SITE_METRICS = ("gsc_clicks", "gsc_impressions")
TASK = "page_decline"


async def site_weekly(session: AsyncSession, client_id: int, metric_key: str, as_of: date) -> pd.Series:
    rows = (await session.execute(
        select(MetricObservation.period_start, MetricObservation.value).where(
            MetricObservation.client_id == client_id, MetricObservation.metric_key == metric_key,
            MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            MetricObservation.period_start >= as_of - timedelta(weeks=HISTORY_WEEKS + 2),
        ).order_by(MetricObservation.period_start)
    )).all()
    df = pd.DataFrame(rows, columns=["d", "v"]).dropna()
    if df.empty:
        return pd.Series(dtype=float)
    return weekly_sum(pd.Series(df["v"].astype(float).values, index=pd.DatetimeIndex(df["d"])), as_of)


async def weekly_frames(session: AsyncSession, client_id: int, dimension_type: str, as_of: date) -> dict[str, pd.DataFrame]:
    """key (page url / query text) -> weekly frame [clicks, impressions, position]. Local to the caller;
    the key never leaves this process (the pooled model only ever sees the numbers)."""
    rows = (await session.execute(
        select(
            PageQueryObservation.dimension_value, PageQueryObservation.period_start, PageQueryObservation.clicks,
            PageQueryObservation.impressions, PageQueryObservation.position,
        ).where(
            PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == dimension_type,
            PageQueryObservation.period_start >= as_of - timedelta(weeks=HISTORY_WEEKS + 2),
        )
    )).all()
    if not rows:
        return {}
    df = pd.DataFrame(rows, columns=["key", "d", "clicks", "impressions", "position"])
    for c in ("clicks", "impressions", "position"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    frames: dict[str, pd.DataFrame] = {}
    for key, g in df.groupby("key"):
        idx = pd.DatetimeIndex(g["d"])
        clicks = weekly_rate(pd.Series(g["clicks"].fillna(0).values, index=idx), as_of)
        impr = weekly_rate(pd.Series(g["impressions"].fillna(0).values, index=idx), as_of)
        pos = weekly_mean_weighted(pd.Series(g["position"].values, index=idx), pd.Series(g["impressions"].fillna(0).values, index=idx), as_of)
        f = pd.DataFrame({"clicks": clicks, "impressions": impr, "position": pos}).dropna().sort_index()
        # Only an unbroken run of weeks is a real series (a gap is a missing sample, not a zero).
        if len(f) >= 2:
            gaps = (pd.Series(f.index).diff().dropna() > pd.Timedelta(days=7)).values
            if gaps.any():
                f = f.iloc[int(np.where(gaps)[0][-1]) + 1:]
        if len(f) >= 6:
            frames[str(key)] = f
    return frames


async def _active_model(session: AsyncSession):
    row = (await session.execute(
        select(PredictionModel).where(PredictionModel.task == TASK, PredictionModel.scope == "pooled", PredictionModel.active.is_(True))
        .order_by(PredictionModel.trained_at.desc()).limit(1)
    )).scalars().first()
    if row is None or row.artifact is None:
        return "baseline", None
    try:
        return row.champion, issue_model.load_model(row.artifact)
    except Exception as e:  # a corrupt artifact must degrade to the baseline, never break the pass
        logger.warning("predict: could not load the %s model (%s); using the baseline", row.champion, e)
        return "baseline", None


async def _resolve_past(session: AsyncSession, client_id: int, as_of: date, frames_by_page: dict[str, pd.DataFrame]) -> None:
    """Fill in actuals for site predictions and outcomes for page predictions once their week has landed."""
    this_monday = week_start(as_of)
    pending = (await session.execute(
        select(PredictionLog).where(PredictionLog.client_id == client_id, PredictionLog.actual.is_(None), PredictionLog.target_week < this_monday)
    )).scalars().all()
    cache: dict[str, pd.Series] = {}
    for p in pending:
        if p.metric_key not in cache:
            cache[p.metric_key] = await site_weekly(session, client_id, p.metric_key, as_of)
        s = cache[p.metric_key]
        ts = pd.Timestamp(p.target_week)
        if ts in s.index:
            actual = float(s.loc[ts])
            p.actual = actual
            p.abs_pct_error = abs(actual - float(p.predicted)) / max(actual, 1.0)
            p.resolved_at = datetime.now(timezone.utc)

    open_issues = (await session.execute(
        select(PredictedIssue).where(PredictedIssue.client_id == client_id, PredictedIssue.outcome.is_(None), PredictedIssue.target_week < this_monday)
    )).scalars().all()
    for i in open_issues:
        f = frames_by_page.get(i.page)
        ts = pd.Timestamp(i.target_week)
        if f is None or ts not in f.index:
            continue
        before = f[f.index < ts]["clicks"].values[-3:]
        if len(before) < 3 or float(np.mean(before)) < MIN_VOLUME:
            continue
        i.outcome = "happened" if float(f.loc[ts, "clicks"]) < DECLINE_FRACTION * float(np.mean(before)) else "did_not_happen"


async def _upsert_forecasts(session: AsyncSession, client_id: int, as_of: date) -> None:
    for metric in SITE_METRICS:
        series = await site_weekly(session, client_id, metric, as_of)
        result = forecast_series(series)
        if result["status"] != "ok":
            continue
        for pt in result["points"]:
            stmt = pg_insert(PredictionLog).values(
                client_id=client_id, metric_key=metric, target_week=date.fromisoformat(pt["week"]), horizon=pt["horizon"],
                predicted=pt["predicted"], low=pt["low"], high=pt["high"], model=result["model"], made_on=as_of,
            ).on_conflict_do_nothing(constraint="prediction_log_unique")
            await session.execute(stmt)


async def _predict_pages(session: AsyncSession, client_id: int, as_of: date, frames: dict[str, pd.DataFrame], model_name: str, model) -> list[dict]:
    target = week_start(as_of)  # the week now starting is the one being predicted
    out = []
    for page, f in frames.items():
        c, i, p = f["clicks"].values, f["impressions"].values, f["position"].values
        row = feature_row(c, i, p)
        if row is None or float(np.mean(c[-3:])) < MIN_VOLUME:
            continue
        try:
            lk = issue_model.likelihood(row, model)
        except Exception:
            lk, model_name_used = issue_model.baseline_likelihood(row), "baseline"
        else:
            model_name_used = model_name if model is not None else "baseline"
        if lk < LIKELIHOOD_FLOOR:
            continue
        base = float(np.mean(c[-4:-1]))
        out.append({
            "page": page, "likelihood": lk, "model": model_name_used,
            "expected_loss": round(base * 0.25 * lk, 1), "reason": issue_model.reason_text(row, c, p),
            "evidence": {"features": row, "weekly_clicks": [round(float(x), 1) for x in c[-6:]]},
            "last": float(c[-1]), "base": base,
        })
    out.sort(key=lambda r: r["expected_loss"], reverse=True)
    out = out[:MAX_ISSUES]

    for r in out:
        insight_id = None
        if r["likelihood"] >= INSIGHT_FLOOR:
            exists = (await session.execute(
                select(Insight.id).where(
                    Insight.client_id == client_id, Insight.metric_key == "gsc_clicks", Insight.dimension_type == "page",
                    Insight.dimension_value == r["page"], Insight.period_start == target, Insight.insight_type == "forecast_risk",
                )
            )).scalars().first()
            if exists is None:
                ins = Insight(
                    client_id=client_id, metric_key="gsc_clicks", dimension_type="page", dimension_value=r["page"],
                    period_start=target, insight_type="forecast_risk", severity="high" if r["likelihood"] >= 0.75 else "medium",
                    evidence={
                        "source": "predict", "model": r["model"], "likelihood": round(r["likelihood"], 3),
                        "last_actual": r["last"], "projected_last_point": r["base"] * (1 - 0.25),
                        "predicted_date": target.isoformat(), "days_until_drop": max((target - as_of).days, 0),
                        "pct_projected_change": -25.0, "horizon_periods": 1, "confidence": round(r["likelihood"], 3),
                    },
                )
                session.add(ins)
                await session.flush()
                insight_id = ins.id
            else:
                insight_id = exists
        stmt = pg_insert(PredictedIssue).values(
            client_id=client_id, kind="page_decline", page=r["page"], target_week=target, likelihood=r["likelihood"],
            expected_loss_clicks=r["expected_loss"], reason=r["reason"], model=r["model"], evidence=r["evidence"], insight_id=insight_id,
        ).on_conflict_do_update(
            constraint="predicted_issues_unique",
            set_={"likelihood": r["likelihood"], "expected_loss_clicks": r["expected_loss"], "reason": r["reason"],
                  "model": r["model"], "evidence": r["evidence"], "insight_id": insight_id},
        )
        await session.execute(stmt)
    return out


async def _predict_keywords(session: AsyncSession, client_id: int, as_of: date) -> None:
    frames = await weekly_frames(session, client_id, "query", as_of)
    target = week_start(as_of)
    found = []
    for q, f in frames.items():
        cand = growth_candidate(f["clicks"].values, f["impressions"].values, f["position"].values)
        if cand:
            found.append((q, cand))
    found.sort(key=lambda t: t[1]["gainClicks"] * t[1]["likelihood"], reverse=True)
    await session.execute(delete(KeywordPrediction).where(KeywordPrediction.client_id == client_id, KeywordPrediction.target_week == target))
    for q, cand in found[:MAX_KEYWORDS]:
        session.add(KeywordPrediction(client_id=client_id, keyword=q, target_week=target, position=cand["position"],
                                      gain_clicks=cand["gainClicks"], likelihood=cand["likelihood"]))


async def run_predictions(as_of: date | None = None) -> None:
    as_of = as_of or date.today()
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        model_name, model = await _active_model(session)
    for client in clients:
        try:
            async with SessionLocal() as session:
                frames = await weekly_frames(session, client.id, "page", as_of)
                await _resolve_past(session, client.id, as_of, frames)
                await _upsert_forecasts(session, client.id, as_of)
                await _predict_pages(session, client.id, as_of, frames, model_name, model)
                await _predict_keywords(session, client.id, as_of)
                await session.commit()
        except Exception as e:
            logger.exception("predict: client %s failed: %s", client.id, e)


async def run_pooled_training(as_of: date | None = None) -> dict:
    """One model for every project, trained on anonymous feature rows only. The registry row records
    which of baseline / gradient boosting / neural network won on a time-ordered holdout."""
    as_of = as_of or date.today()
    rows, labels, order, projects = [], [], [], 0
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        for client in clients:
            frames = await weekly_frames(session, client.id, "page", as_of)
            used = False
            for f in frames.values():
                for wk, feats, y in training_rows(f):
                    rows.append(feats); labels.append(y); order.append(wk); used = True
            projects += int(used)
    result = issue_model.train_and_select(rows, labels, order)
    async with SessionLocal() as session:
        await session.execute(update(PredictionModel).where(PredictionModel.task == TASK, PredictionModel.scope == "pooled").values(active=False))
        metrics = dict(result.get("metrics") or {})
        if result.get("reason"):
            metrics["_reason"] = result["reason"]
        session.add(PredictionModel(task=TASK, scope="pooled", champion=result["champion"], metrics=metrics,
                                    artifact=result["artifact"], samples=result["samples"], projects=projects, active=True))
        await session.commit()
    logger.info("predict: pooled model trained on %s rows from %s project(s); champion=%s", result["samples"], projects, result["champion"])
    return result


async def has_pooled_model() -> bool:
    """True once any training run has been recorded (even one where the baseline stayed champion)."""
    async with SessionLocal() as session:
        return (await session.execute(
            select(PredictionModel.id).where(PredictionModel.task == TASK, PredictionModel.scope == "pooled").limit(1)
        )).first() is not None


_INDUSTRY_TTL = 6 * 3600
_industry_cache: dict[tuple, tuple[float, dict | None]] = {}


async def field_outlook(session: AsyncSession, client: Client, as_of: date) -> dict | None:
    """The field this project sits in: same-industry projects when there are at least MIN_PROJECTS of
    them, otherwise every project on the platform when there are, otherwise nothing. Aggregates only."""
    import time
    key = (client.industry or "", as_of)
    hit = _industry_cache.get(key)
    if hit and time.time() - hit[0] < _INDUSTRY_TTL:
        cached = hit[1]
        return await _with_own(session, client, as_of, cached) if cached else None

    async def weekly_for(industry: str | None) -> dict[int, pd.Series]:
        q = select(Client.id).where(Client.status == "active")
        if industry:
            q = q.where(Client.industry == industry)
        ids = (await session.execute(q)).scalars().all()
        return {cid: await site_weekly(session, cid, "gsc_impressions", as_of) for cid in ids}

    scopes = []
    if client.industry:
        scopes.append(("industry", client.industry))
    scopes.append(("platform", None))
    result = None
    for scope, industry in scopes:
        per = await weekly_for(industry)
        if sum(1 for s in per.values() if len(s) >= 10) >= MIN_PROJECTS:
            result = industry_outlook(per, None, scope)
            if result:
                break
    _industry_cache[key] = (time.time(), result)
    return await _with_own(session, client, as_of, result) if result else None


async def _with_own(session: AsyncSession, client: Client, as_of: date, base: dict) -> dict:
    own = await site_weekly(session, client.id, "gsc_impressions", as_of)
    out = dict(base)
    if len(own) >= 8:
        out["yourRecentChangePct"] = round((float(own.iloc[-4:].mean()) - float(own.iloc[-8:-4].mean())) / max(float(own.iloc[-8:-4].mean()), 1.0) * 100, 1)
    return out
