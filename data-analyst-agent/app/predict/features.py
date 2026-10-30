"""Anonymous feature rows. Nothing here carries a domain, page URL, query text or client id:
a feature row is a handful of numbers, which is exactly what the pooled cross-project model
may see (see pooled.py)."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

FEATURES = ["log_volume", "ratio_last_vs_prev3", "slope_norm", "cv6", "position_delta", "impr_ratio", "weeks_observed"]
MIN_WEEKS_PAGE = 6
MIN_VOLUME = 5.0          # mean weekly clicks below this is noise, never a "decline"
DECLINE_FRACTION = 0.8    # label: next week < 80% of the recent average


def _slope_norm(y: np.ndarray) -> float:
    if len(y) < 3 or np.mean(y) == 0:
        return 0.0
    x = np.arange(len(y))
    return float(np.polyfit(x, y, 1)[0] / max(np.mean(y), 1.0))


def feature_row(clicks: np.ndarray, impressions: np.ndarray, position: np.ndarray) -> dict | None:
    """Features describing a page as of its LAST week in the arrays (needs >= MIN_WEEKS_PAGE)."""
    n = len(clicks)
    if n < MIN_WEEKS_PAGE:
        return None
    last = float(clicks[-1])
    prev3 = float(np.mean(clicks[-4:-1]))
    recent = clicks[-6:]
    ratio = last / prev3 if prev3 > 0 else 1.0
    cv = float(np.std(recent) / np.mean(recent)) if np.mean(recent) > 0 else 0.0
    pos_delta = float(position[-1] - np.mean(position[-4:-1])) if len(position) >= 4 else 0.0
    impr_prev = float(np.mean(impressions[-4:-1]))
    impr_ratio = float(impressions[-1]) / impr_prev if impr_prev > 0 else 1.0
    return {
        "log_volume": math.log1p(float(np.mean(clicks[-4:]))),
        "ratio_last_vs_prev3": min(ratio, 3.0),
        "slope_norm": float(np.clip(_slope_norm(clicks[-5:]), -1.5, 1.5)),
        "cv6": min(cv, 2.0),
        "position_delta": float(np.clip(pos_delta, -10, 10)),
        "impr_ratio": min(impr_ratio, 3.0),
        "weeks_observed": float(min(n, 52)),
    }


def decline_label(clicks_window: np.ndarray, next_clicks: float) -> int | None:
    """1 when next week falls below DECLINE_FRACTION of the recent 3-week average; None when the
    page is too small for the label to mean anything."""
    base = float(np.mean(clicks_window[-3:]))
    if base < MIN_VOLUME:
        return None
    return int(next_clicks < DECLINE_FRACTION * base)


def training_rows(frame: pd.DataFrame) -> list[tuple[int, dict, int]]:
    """frame: weekly rows for ONE page, columns clicks/impressions/position, index = week start.
    Returns [(week_index, features, label)] for every week that has a following week."""
    c, i, p = frame["clicks"].values, frame["impressions"].values, frame["position"].values
    out = []
    for t in range(MIN_WEEKS_PAGE, len(frame)):
        f = feature_row(c[:t], i[:t], p[:t])
        if f is None:
            continue
        y = decline_label(c[:t], float(c[t]))
        if y is None:
            continue
        out.append((int(pd.Timestamp(frame.index[t]).strftime("%G%V")), f, y))
    return out
