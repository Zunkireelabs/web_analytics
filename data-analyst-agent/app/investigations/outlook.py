"""An investigation's forecast outlook, as of TODAY.

`Investigation.forecast_outlook` is the forecast_risk insight's evidence copied when the investigation was created, so its
`days_until_drop` is "days from that day". An open investigation keeps the copy for weeks: production had 95 outlooks whose
predicted date was already in the past (89 of them with a negative days_until_drop), one predicting a -93.6% drop for 2026-08-22
shown as if it were still ahead. Nothing was wrong with the number at the time; it was shown long after it stopped being true.

The stored copy stays untouched (it is the record of what was predicted, and outcome evaluation reads its predicted_date). What
is SERVED goes through `current_outlook`: days_until_drop recomputed from the predicted date, and a `state` that says whether the
prediction is still ahead or has passed, so a passed prediction can never be read as a live warning."""
from __future__ import annotations

from datetime import date

UPCOMING, DUE_TODAY, PASSED, UNKNOWN = "upcoming", "due_today", "passed", "unknown"


def current_outlook(outlook: dict | None, today: date | None = None) -> dict | None:
    if outlook is None:
        return None
    today = today or date.today()
    view = dict(outlook)
    raw = outlook.get("predicted_date")
    try:
        predicted = date.fromisoformat(str(raw)[:10])
    except (TypeError, ValueError):
        view.update(state=UNKNOWN, as_of=today.isoformat())
        return view
    days = (predicted - today).days
    view["days_until_drop_when_recorded"] = outlook.get("days_until_drop")
    view["days_until_drop"] = days if days >= 0 else None   # never a negative "days until"
    view["state"] = UPCOMING if days > 0 else DUE_TODAY if days == 0 else PASSED
    view["as_of"] = today.isoformat()
    return view
