"""Read side of the next-week prediction layer (app/predict/). Reads what the nightly pass already
persisted; never trains or predicts at request time."""
from datetime import date

import pandas as pd
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, KeywordPrediction, PredictedIssue, PredictionLog, PredictionModel
from app.db.session import get_session
from app.predict.issues import MIN_TRAIN_ROWS
from app.predict.run import SITE_METRICS, TASK, field_outlook, site_weekly
from app.predict.series import week_start
from app.security.auth import require_admin_key

router = APIRouter()
HISTORY_SHOWN = 8
ACCURACY_WEEKS = 8


def _num(v):
    return None if v is None else float(v)


@router.get("/clients/{client_id}/outlook")
async def get_outlook(client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session)) -> dict:
    as_of = date.today()
    weekly = {m: await site_weekly(session, client.id, m, as_of) for m in SITE_METRICS}
    clicks, impr = weekly["gsc_clicks"], weekly["gsc_impressions"]
    if len(clicks) < 8:
        return {"status": "not-ready", "weeksOfHistory": int(len(clicks)),
                "message": "We need at least 8 full weeks of Search Console data before we can predict next week."}

    # The newest forecast per metric: the latest day predictions were made, horizons 1..3.
    forecast: dict = {"history": [], "future": []}
    latest: dict[str, list] = {}
    for m in SITE_METRICS:
        made_on = await session.scalar(select(func.max(PredictionLog.made_on)).where(PredictionLog.client_id == client.id, PredictionLog.metric_key == m))
        if made_on is None:
            continue
        latest[m] = (await session.execute(
            select(PredictionLog).where(PredictionLog.client_id == client.id, PredictionLog.metric_key == m, PredictionLog.made_on == made_on)
            .order_by(PredictionLog.horizon)
        )).scalars().all()
    if "gsc_clicks" not in latest:
        return {"status": "not-ready", "weeksOfHistory": int(len(clicks)), "message": "The first prediction is being prepared. Check back tomorrow."}

    def pack(metric: str, series: pd.Series) -> dict:
        h1 = latest[metric][0]
        this_week = float(series.iloc[-1])
        return {"predicted": _num(h1.predicted), "low": _num(h1.low), "high": _num(h1.high), "thisWeek": this_week,
                "changePct": round((float(h1.predicted) - this_week) / this_week * 100, 1) if this_week else None}

    forecast["nextWeek"] = latest["gsc_clicks"][0].target_week.isoformat()
    forecast["model"] = latest["gsc_clicks"][0].model
    forecast["clicks"] = pack("gsc_clicks", clicks)
    if "gsc_impressions" in latest:
        forecast["impressions"] = pack("gsc_impressions", impr)
    for ts in clicks.index[-HISTORY_SHOWN:]:
        forecast["history"].append({"week": ts.date().isoformat(), "clicks": float(clicks.loc[ts]),
                                    "impressions": float(impr.loc[ts]) if ts in impr.index else None})
    imp_by_h = {p.horizon: p for p in latest.get("gsc_impressions", [])}
    for p in latest["gsc_clicks"]:
        ip = imp_by_h.get(p.horizon)
        forecast["future"].append({
            "week": p.target_week.isoformat(),
            "clicks": {"predicted": _num(p.predicted), "low": _num(p.low), "high": _num(p.high)},
            "impressions": {"predicted": _num(ip.predicted), "low": _num(ip.low), "high": _num(ip.high)} if ip else None,
        })

    errs = (await session.execute(
        select(PredictionLog.abs_pct_error).where(
            PredictionLog.client_id == client.id, PredictionLog.metric_key == "gsc_clicks", PredictionLog.horizon == 1,
            PredictionLog.abs_pct_error.is_not(None),
        ).order_by(PredictionLog.target_week.desc()).limit(ACCURACY_WEEKS)
    )).scalars().all()
    forecast["accuracy"] = {"withinPct": round(sum(float(e) for e in errs) / len(errs) * 100, 1), "weeksChecked": len(errs)} if errs else None

    # Last week: what was predicted vs what happened.
    last_week = clicks.index[-1].date()
    last_rows = []
    for m, label in (("gsc_clicks", "Clicks"), ("gsc_impressions", "Impressions")):
        row = (await session.execute(
            select(PredictionLog).where(PredictionLog.client_id == client.id, PredictionLog.metric_key == m, PredictionLog.target_week == last_week,
                                        PredictionLog.horizon == 1, PredictionLog.actual.is_not(None)).order_by(PredictionLog.made_on.desc()).limit(1)
        )).scalars().first()
        if row:
            last_rows.append({"label": label, "predicted": _num(row.predicted), "actual": _num(row.actual), "errorPct": round(float(row.abs_pct_error) * 100, 1)})
    issues_last = (await session.execute(
        select(PredictedIssue).where(PredictedIssue.client_id == client.id, PredictedIssue.target_week == last_week)
    )).scalars().all()
    if issues_last and any(i.outcome for i in issues_last):
        resolved = [i for i in issues_last if i.outcome]
        last_rows.append({"label": "Problems predicted", "predicted": len(issues_last), "actual": sum(1 for i in resolved if i.outcome == "happened"),
                          "note": f"{sum(1 for i in resolved if i.outcome == 'happened')} of {len(resolved)} checked happened"})

    target = week_start(as_of)
    issues = (await session.execute(
        select(PredictedIssue).where(PredictedIssue.client_id == client.id, PredictedIssue.target_week == target)
        .order_by(PredictedIssue.expected_loss_clicks.desc())
    )).scalars().all()
    kws = (await session.execute(
        select(KeywordPrediction).where(KeywordPrediction.client_id == client.id, KeywordPrediction.target_week == target)
        .order_by((KeywordPrediction.gain_clicks * KeywordPrediction.likelihood).desc())
    )).scalars().all()

    return {
        "status": "ok", "forecast": forecast, "lastWeek": last_rows or None,
        "issues": [{"id": i.id, "page": i.page, "likelihood": _num(i.likelihood), "expectedLossClicks": _num(i.expected_loss_clicks),
                    "reason": i.reason, "model": i.model, "insightId": i.insight_id, "targetWeek": i.target_week.isoformat()} for i in issues],
        "industry": await field_outlook(session, client, as_of),
        "keywords": [{"keyword": k.keyword, "position": _num(k.position), "gainClicks": k.gain_clicks, "likelihoodPct": round(float(k.likelihood) * 100)} for k in kws],
    }


@router.get("/admin/learning")
async def get_learning(session: AsyncSession = Depends(get_session), _admin: None = Depends(require_admin_key)) -> dict:
    """Platform-wide: which model wins and on how much data. Numbers only (never a project's data);
    the Node route that exposes this is platform-admin only."""
    m = (await session.execute(
        select(PredictionModel).where(PredictionModel.task == TASK, PredictionModel.scope == "pooled").order_by(PredictionModel.trained_at.desc()).limit(1)
    )).scalars().first()
    forecast_err = await session.scalar(select(func.avg(PredictionLog.abs_pct_error)).where(PredictionLog.abs_pct_error.is_not(None), PredictionLog.horizon == 1))
    names = {"baseline": "Statistics only", "gradient_boosting": "Machine learning (gradient boosting)", "neural_network": "Deep learning (neural network)"}
    metrics = (m.metrics or {}) if m else {}
    reason = metrics.get("_reason")
    models = []
    for key, label in names.items():
        met = metrics.get(key) or {}
        has = "errorPct" in met
        if has:
            status, note = "ready", None
        elif key == "baseline":
            status, note = "waiting", "Scored as soon as there is a first training run" if m is None else (reason or "Needs both outcomes in the history to score")
        else:
            status, note = "waiting", reason or "Starts learning once there is enough history across projects"
        models.append({"name": label, "key": key, "missPct": round(met["errorPct"], 1) if has else None, "status": status, "note": note,
                       "usedWhereWins": bool(m) and m.champion == key})
    return {
        "trainedAt": m.trained_at.isoformat() if m else None, "samples": m.samples if m else 0, "projects": m.projects if m else 0,
        "champion": m.champion if m else None, "models": models, "needsRows": MIN_TRAIN_ROWS,
        "forecastMissPct": round(float(forecast_err) * 100, 1) if forecast_err is not None else None,
    }


@router.get("/clients/{client_id}/predicted-issues")
async def get_predicted_issues(weeks: int = 3, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session)) -> dict:
    """Predicted page issues from the last `weeks` target weeks (newest week wins per page), so the
    Fixes page can follow a problem from predicted to fixed across several nights."""
    weeks = max(1, min(weeks, 8))
    since = week_start(date.today()) - pd.Timedelta(weeks=weeks - 1).to_pytimedelta()
    rows = (await session.execute(
        select(PredictedIssue).where(PredictedIssue.client_id == client.id, PredictedIssue.target_week >= since)
        .order_by(PredictedIssue.target_week.desc(), PredictedIssue.expected_loss_clicks.desc())
    )).scalars().all()
    seen, out = set(), []
    for i in rows:
        if i.page in seen:
            continue
        seen.add(i.page)
        out.append({"id": i.id, "page": i.page, "likelihood": _num(i.likelihood), "expectedLossClicks": _num(i.expected_loss_clicks),
                    "reason": i.reason, "model": i.model, "insightId": i.insight_id, "targetWeek": i.target_week.isoformat(),
                    "createdAt": i.created_at.isoformat() if i.created_at else None, "outcome": i.outcome})
    return {"issues": out}
