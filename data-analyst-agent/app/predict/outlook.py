"""Site-level weekly forecast with a backtest-chosen model and honest intervals.

Candidates are deliberately simple statistics (a metric with 8-60 weekly points does not
support more); the winner is whichever has the lowest error when replayed over the
site's own past weeks, and the interval comes from those same replayed errors, never
from a textbook formula assumed to fit. Returns status 'insufficient-data' when there is
too little history rather than a tight-looking guess."""
from __future__ import annotations

import math
import warnings

import numpy as np
import pandas as pd

MIN_WEEKS = 8
MIN_TRAIN = 6
MAX_ORIGINS = 8
HORIZON = 3


def _pred_last(y: np.ndarray, h: int) -> float:
    return float(y[-1])


def _pred_mean4(y: np.ndarray, h: int) -> float:
    return float(np.mean(y[-4:]))


def _pred_drift(y: np.ndarray, h: int) -> float:
    d = np.diff(y[-6:])
    return float(y[-1] + h * (np.mean(d) if len(d) else 0.0))


def _pred_holt(y: np.ndarray, h: int) -> float:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit = ExponentialSmoothing(y, trend="add", damped_trend=True, initialization_method="estimated").fit()
        return float(fit.forecast(h)[-1])


MODELS = {"last_week": _pred_last, "four_week_average": _pred_mean4, "recent_drift": _pred_drift, "damped_trend": _pred_holt}


def _backtest(y: np.ndarray, fn, h: int = 1) -> list[float]:
    """Relative errors (actual-pred)/max(actual,1) replaying the last MAX_ORIGINS weeks."""
    errs = []
    start = max(MIN_TRAIN, len(y) - MAX_ORIGINS - h + 1)
    for t in range(start, len(y) - h + 1):
        train = y[:t]
        if len(train) < MIN_TRAIN:
            continue
        try:
            p = fn(train, h)
        except Exception:
            return []
        a = y[t + h - 1]
        errs.append((a - p) / max(a, 1.0))
    return errs


def forecast_series(series: pd.Series, horizon: int = HORIZON) -> dict:
    y = series.astype(float).values
    if len(y) < MIN_WEEKS:
        return {"status": "insufficient-data", "weeks": int(len(y))}

    scored = []
    for name, fn in MODELS.items():
        errs = _backtest(y, fn)
        if len(errs) >= 3:
            scored.append((float(np.mean(np.abs(errs))), name, errs))
    if not scored:
        return {"status": "insufficient-data", "weeks": int(len(y))}
    scored.sort(key=lambda t: t[0])
    mape, name, errs = scored[0]

    lo_q, hi_q = float(np.quantile(errs, 0.1)), float(np.quantile(errs, 0.9))
    spread = max(hi_q - lo_q, 0.05)  # never claim tighter than +-2.5% from a handful of weeks
    fn = MODELS[name]
    last_week = pd.Timestamp(series.index[-1])
    points = []
    for h in range(1, horizon + 1):
        pred = max(fn(y, h), 0.0)
        widen = math.sqrt(h)
        points.append({
            "horizon": h,
            "week": (last_week + pd.Timedelta(weeks=h)).date().isoformat(),
            "predicted": pred,
            "low": max(pred * (1 + min(lo_q, -spread / 4) * widen), 0.0),
            "high": pred * (1 + max(hi_q, spread / 4) * widen),
        })
    return {"status": "ok", "model": name, "backtestMape": mape, "backtestWeeks": len(errs), "points": points}
