"""Is a stated likelihood honest? Compare what the page-decline model said with what happened.

The page-decline model outputs a likelihood. It was written straight into the insight as `confidence`, though nothing had ever
checked that "0.7" means "happens about 7 times in 10". predicted_issues.outcome is filled in once the week lands
(app/predict/run.py::_resolve_past), so the evidence to check exists. This module turns resolved (likelihood, happened) pairs into
a reliability table and, per likelihood band, an OBSERVED hit rate.

Rules, in the repo's usual style:
  * a band is trusted only with at least MIN_PER_BAND resolved outcomes of that client's own; below that the raw likelihood is
    kept and labelled `uncalibrated_model_likelihood`, never presented as a measured probability;
  * strictly per client: another project's outcomes are never used to describe this one."""
from __future__ import annotations

MIN_PER_BAND = 10
# Half-open bands over the likelihoods the layer ever shows (it only keeps likelihood >= 0.5).
BANDS: tuple[tuple[float, float], ...] = ((0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.0001))

UNCALIBRATED = "uncalibrated_model_likelihood"


def _band(likelihood: float) -> tuple[float, float] | None:
    for lo, hi in BANDS:
        if lo <= likelihood < hi:
            return lo, hi
    return None


def reliability(resolved: list[tuple[float, bool]]) -> dict:
    """resolved: (likelihood, happened). Returns {n, hit_rate, bands: [{lo, hi, n, hits, hit_rate, mean_likelihood, trusted}]}."""
    bands = []
    for lo, hi in BANDS:
        in_band = [(l, h) for l, h in resolved if lo <= l < hi]
        n = len(in_band)
        hits = sum(1 for _, h in in_band if h)
        bands.append({
            "lo": lo, "hi": min(hi, 1.0), "n": n, "hits": hits,
            "hit_rate": round(hits / n, 3) if n else None,
            "mean_likelihood": round(sum(l for l, _ in in_band) / n, 3) if n else None,
            "trusted": n >= MIN_PER_BAND,
        })
    n_all = len(resolved)
    return {"n": n_all, "hit_rate": round(sum(1 for _, h in resolved if h) / n_all, 3) if n_all else None, "bands": bands}


def calibrated_confidence(likelihood: float, resolved: list[tuple[float, bool]]) -> tuple[float, str]:
    """(confidence, basis). The observed hit rate of this likelihood's band when that band has enough resolved outcomes,
    else the raw likelihood labelled uncalibrated."""
    band = _band(likelihood)
    if band is not None:
        in_band = [h for l, h in resolved if band[0] <= l < band[1]]
        if len(in_band) >= MIN_PER_BAND:
            return round(sum(1 for h in in_band if h) / len(in_band), 3), f"observed_hit_rate:{len(in_band)}_resolved_outcomes"
    return round(likelihood, 3), UNCALIBRATED
