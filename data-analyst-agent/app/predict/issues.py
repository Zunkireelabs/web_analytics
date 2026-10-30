"""Page-decline likelihood: a transparent statistical baseline, and learned models that must
beat it on a time-ordered holdout before they are ever used."""
from __future__ import annotations

import io
import math
import pickle

import numpy as np

from app.predict.features import FEATURES

MIN_TRAIN_ROWS = 200
MIN_POSITIVES = 15
MIN_GAIN = 0.03   # a learned model must beat the baseline's log loss by 3% to be used
HOLDOUT_FRACTION = 0.25


def sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def baseline_likelihood(f: dict) -> float:
    """Hand-set logistic score. Weights are deliberately plain: a falling last week, a slipping
    position, a noisy page, a negative recent slope. This is the 'statistics' model and the
    fallback whenever a learned model has not earned its place."""
    decline = min(max(1.0 - f["ratio_last_vs_prev3"], 0.0), 1.0)
    slip = min(max(f["position_delta"] / 3.0, 0.0), 1.0)
    noisy = min(f["cv6"], 1.0)
    falling = min(max(-f["slope_norm"], 0.0), 1.0)
    return sigmoid(-2.2 + 3.2 * decline + 1.6 * slip + 0.8 * noisy + 1.2 * falling)


def to_matrix(rows: list[dict]) -> np.ndarray:
    return np.array([[r[k] for k in FEATURES] for r in rows], dtype=float)


def _logloss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _candidates():
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.neural_network import MLPClassifier
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    return {
        "gradient_boosting": HistGradientBoostingClassifier(max_depth=3, max_iter=80, learning_rate=0.08, random_state=7),
        "neural_network": make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(16, 8), early_stopping=True, max_iter=400, random_state=7)),
    }


def _baseline_only(rows: list[dict], labels: list[int], reason: str) -> dict:
    """The learned models cannot be trained yet, but the statistical baseline can still be scored on every
    labelled row, so the admin view reports a real number instead of nothing."""
    y = np.array(labels, dtype=int)
    metrics = {}
    if len(rows) >= 30 and 0 < int(y.sum()) < len(y):
        p = np.array([baseline_likelihood(r) for r in rows])
        metrics["baseline"] = {"logloss": _logloss(y, p), "errorPct": float(np.mean((p >= 0.5).astype(int) != y) * 100)}
    return {"champion": "baseline", "metrics": metrics, "artifact": None, "samples": len(rows), "reason": reason}


def train_and_select(rows: list[dict], labels: list[int], order: list[int]) -> dict:
    """rows/labels/order: anonymous feature rows with a sortable week key. Trains the candidates on
    the older 75% and scores all three (baseline, gradient boosting, neural network) on the newest
    25%. The champion is the best log loss, and only replaces the baseline when it wins by MIN_GAIN.
    Returns {'champion', 'metrics', 'artifact'(bytes|None), 'samples'}."""
    n = len(rows)
    y = np.array(labels, dtype=int)
    if n < MIN_TRAIN_ROWS or int(y.sum()) < MIN_POSITIVES or int((1 - y).sum()) < MIN_POSITIVES:
        return _baseline_only(rows, labels, f"Needs about {MIN_TRAIN_ROWS} labelled page-weeks with at least {MIN_POSITIVES} declines and {MIN_POSITIVES} non-declines")

    idx = np.argsort(np.array(order), kind="stable")
    X = to_matrix(rows)[idx]
    y = y[idx]
    cut = int(n * (1 - HOLDOUT_FRACTION))
    Xtr, ytr, Xte, yte = X[:cut], y[:cut], X[cut:], y[cut:]
    if len(set(ytr)) < 2 or len(set(yte)) < 2:
        return _baseline_only(rows, labels, "The newest weeks do not yet contain both outcomes to test against")

    base_p = np.array([baseline_likelihood(dict(zip(FEATURES, r))) for r in Xte])
    err = lambda p: float(np.mean((p >= 0.5).astype(int) != yte) * 100)
    metrics = {"baseline": {"logloss": _logloss(yte, base_p), "errorPct": err(base_p)}}
    fitted = {}
    for name, model in _candidates().items():
        try:
            model.fit(Xtr, ytr)
            pp = model.predict_proba(Xte)[:, 1]
            metrics[name] = {"logloss": _logloss(yte, pp), "errorPct": err(pp)}
            fitted[name] = model
        except Exception as e:  # a candidate failing must not stop the others
            metrics[name] = {"error": str(e)[:120]}

    best_name, best_ll = "baseline", metrics["baseline"]["logloss"]
    for name in fitted:
        ll = metrics[name]["logloss"]
        if ll < best_ll * (1 - MIN_GAIN) and ll < best_ll:
            best_name, best_ll = name, ll
    artifact = None
    if best_name != "baseline":
        # refit the winner on everything before storing it
        final = _candidates()[best_name]
        final.fit(X, y)
        buf = io.BytesIO()
        pickle.dump(final, buf)
        artifact = buf.getvalue()
    return {"champion": best_name, "metrics": metrics, "artifact": artifact, "samples": n}


def load_model(artifact: bytes):
    return pickle.loads(artifact)  # noqa: S301 - artifacts are written only by train_and_select in this process


def likelihood(f: dict, model=None) -> float:
    if model is None:
        return baseline_likelihood(f)
    return float(model.predict_proba(to_matrix([f]))[:, 1][0])


def reason_text(f: dict, clicks: np.ndarray, position: np.ndarray) -> str:
    """Plain-words reason built only from the page's own numbers."""
    parts = []
    base = float(np.mean(clicks[-4:-1])) if len(clicks) >= 4 else None
    if base and base > 0 and clicks[-1] < base * 0.9:
        parts.append(f"clicks fell {round((1 - clicks[-1] / base) * 100)}% last week")
    if f["position_delta"] >= 1.0:
        parts.append(f"its Google position slipped about {f['position_delta']:.0f} place{'s' if f['position_delta'] >= 1.5 else ''}")
    if f["slope_norm"] <= -0.1:
        parts.append("it has been trending down for several weeks")
    if f["cv6"] >= 0.6:
        parts.append("its traffic has been very uneven")
    text = "; ".join(parts) or "several of its recent numbers look like pages that lost clicks the following week"
    return text[0].upper() + text[1:] + "."
