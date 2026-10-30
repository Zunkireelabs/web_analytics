"""Keywords that can grow: queries sitting just off page one with rising demand.

Gain is an estimate of extra clicks a month if the query reached position 7, using a generic
click-through curve by position (stated as an estimate wherever it is shown); likelihood
comes from the query's own trend, not a promise."""
from __future__ import annotations

import math

import numpy as np

# Rough average click-through rate by Google position. Generic published-style averages, used only
# to size an *estimate*; never presented as a measured value.
CTR_BY_POS = {1: 0.28, 2: 0.15, 3: 0.10, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.018,
              12: 0.012, 15: 0.008, 20: 0.004, 30: 0.0015}
TARGET_POSITION = 7
MIN_WEEKLY_IMPRESSIONS = 20
MIN_WEEKS = 4


def expected_ctr(position: float) -> float:
    keys = sorted(CTR_BY_POS)
    if position <= keys[0]:
        return CTR_BY_POS[keys[0]]
    if position >= keys[-1]:
        return CTR_BY_POS[keys[-1]]
    for lo, hi in zip(keys, keys[1:]):
        if lo <= position <= hi:
            w = (position - lo) / (hi - lo)
            return CTR_BY_POS[lo] * (1 - w) + CTR_BY_POS[hi] * w
    return CTR_BY_POS[keys[-1]]


def growth_candidate(clicks: np.ndarray, impressions: np.ndarray, position: np.ndarray) -> dict | None:
    """One query's weekly arrays -> {position, gainClicks, likelihood} or None when it does not qualify."""
    if len(impressions) < MIN_WEEKS:
        return None
    pos = float(np.mean(position[-2:]))
    impr = float(np.mean(impressions[-2:]))
    if not (4.0 <= pos <= 20.0) or impr < MIN_WEEKLY_IMPRESSIONS:
        return None
    prev = float(np.mean(impressions[-4:-2])) if len(impressions) >= 4 else impr
    impr_trend = (impr - prev) / prev if prev > 0 else 0.0
    pos_trend = float(np.mean(position[-4:-2]) - np.mean(position[-2:])) if len(position) >= 4 else 0.0  # + = improving
    current_ctr = float(np.sum(clicks[-2:]) / max(np.sum(impressions[-2:]), 1.0))
    uplift = max(expected_ctr(TARGET_POSITION) - max(current_ctr, expected_ctr(pos) * 0.5), 0.0)
    gain = impr / 2 * 4.345 * uplift  # weekly impressions (2-week mean) -> per month
    if gain < 5:
        return None
    # Closer to page one, rising demand and an improving position all raise the chance.
    z = -1.0 + 0.9 * math.tanh(impr_trend * 2) + 0.35 * max(min(pos_trend, 4), -4) + 0.12 * (12 - pos)
    return {"position": round(pos, 1), "gainClicks": int(round(gain)), "likelihood": round(1 / (1 + math.exp(-z)), 2)}
