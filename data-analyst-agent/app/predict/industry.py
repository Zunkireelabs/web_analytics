"""Where a project's field is heading, learned from every project in it.

The only honest way to say something about an industry from inside this system is to look at how
demand moves across the projects that sit in it. Each project's weekly impressions are turned into
an index (its own recent average = 1.0) so a big site cannot drown out small ones, the indexes are
averaged, and the same backtest-chosen forecaster used for a single site projects the next weeks.

Privacy: this only ever returns aggregate numbers. It needs at least MIN_PROJECTS projects to say
anything at all (a field of one or two would be a single project's own data in disguise), returns
no project, page, query or domain, and reports only how many projects the figure rests on."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.predict.outlook import forecast_series

MIN_PROJECTS = 5
MIN_WEEKS = 10
RECENT = 4


def demand_index(per_project: dict[int, pd.Series]) -> pd.Series:
    """Average of per-project indexes (each project's own last-RECENT-weeks mean = 1.0), over the weeks
    where at least MIN_PROJECTS projects have data. Projects without enough weeks, or with no demand,
    are left out."""
    indexed = []
    for s in per_project.values():
        s = s.astype(float)
        if len(s) < MIN_WEEKS:
            continue
        base = float(s.iloc[-RECENT:].mean())
        if base <= 0:
            continue
        indexed.append(s / base)
    if len(indexed) < MIN_PROJECTS:
        return pd.Series(dtype=float)
    df = pd.concat(indexed, axis=1)
    counts = df.notna().sum(axis=1)
    idx = df.mean(axis=1)[counts >= MIN_PROJECTS].dropna()
    # keep only the unbroken recent run of weeks
    if len(idx) >= 2:
        gaps = (pd.Series(idx.index).diff().dropna() > pd.Timedelta(days=7)).values
        if gaps.any():
            idx = idx.iloc[int(np.where(gaps)[0][-1]) + 1:]
    return idx


def _pct(new: float, old: float) -> float | None:
    return None if old <= 0 else round((new - old) / old * 100, 1)


def industry_outlook(per_project: dict[int, pd.Series], own: pd.Series | None, scope: str) -> dict | None:
    """per_project: weekly impressions per project in the field (the asking project included).
    Returns None when there is not enough to say anything honest."""
    idx = demand_index(per_project)
    if len(idx) < MIN_WEEKS:
        return None
    f = forecast_series(idx)
    if f["status"] != "ok":
        return None
    last4 = float(idx.iloc[-RECENT:].mean())
    prior4 = float(idx.iloc[-2 * RECENT:-RECENT].mean())
    ahead3 = float(np.mean([p["predicted"] for p in f["points"]]))
    out = {
        "scope": scope,
        "projects": sum(1 for s in per_project.values() if len(s) >= MIN_WEEKS),
        "fieldChangeNext3Pct": _pct(ahead3, last4),
        "fieldRecentChangePct": _pct(last4, prior4),
        "yourRecentChangePct": None,
        "model": f["model"],
    }
    if own is not None and len(own) >= 2 * RECENT:
        out["yourRecentChangePct"] = _pct(float(own.iloc[-RECENT:].mean()), float(own.iloc[-2 * RECENT:-RECENT].mean()))
    return out
