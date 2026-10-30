from __future__ import annotations

from datetime import date, timedelta

import pandas as pd


def week_start(d: date) -> date:
    """Monday of d's ISO week."""
    return d - timedelta(days=d.weekday())


def weekly_sum(daily: pd.Series, as_of: date) -> pd.Series:
    """Daily series (DatetimeIndex) -> weekly sums indexed by Monday, COMPLETE weeks only.

    A week is complete when it has all 7 days and ends before `as_of`'s own week, so a
    partially-ingested current week never reads as a collapse."""
    if daily.empty:
        return pd.Series(dtype=float)
    s = daily.copy()
    s.index = pd.DatetimeIndex(s.index).normalize()
    cutoff = pd.Timestamp(week_start(as_of))
    grouped = s.groupby(s.index.to_period("W-SUN").start_time)
    sums, counts = grouped.sum(), grouped.count()
    out = sums[(counts == 7) & (sums.index < cutoff)]
    return out.astype(float)


def weekly_mean_weighted(values: pd.Series, weights: pd.Series, as_of: date) -> pd.Series:
    """Weighted weekly mean (e.g. position weighted by impressions), complete weeks only."""
    if values.empty:
        return pd.Series(dtype=float)
    df = pd.DataFrame({"v": values, "w": weights.fillna(0)})
    df.index = pd.DatetimeIndex(df.index).normalize()
    wk = df.index.to_period("W-SUN").start_time
    cutoff = pd.Timestamp(week_start(as_of))
    num = (df["v"] * df["w"]).groupby(wk).sum()
    den = df["w"].groupby(wk).sum()
    days = df["v"].groupby(wk).count()
    res = (num / den.where(den > 0))
    return res[(days >= 1) & (res.index < cutoff)].dropna().astype(float)


def weekly_rate(daily: pd.Series, as_of: date, min_days: int = 4) -> pd.Series:
    """For page/query rows, which are a top-N *sample* per day (a missing day is not a real zero):
    the weekly total scaled to 7 days from the days actually observed, kept only for weeks that
    have at least `min_days` observed days and end before `as_of`'s own week."""
    if daily.empty:
        return pd.Series(dtype=float)
    s = daily.copy()
    s.index = pd.DatetimeIndex(s.index).normalize()
    wk = s.index.to_period("W-SUN").start_time
    grouped = s.groupby(wk)
    sums, counts = grouped.sum(), grouped.count()
    out = (sums / counts * 7)[(counts >= min_days) & (sums.index < pd.Timestamp(week_start(as_of)))]
    return out.astype(float)
