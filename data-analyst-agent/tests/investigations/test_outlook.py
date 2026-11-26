"""A forecast outlook is served as of today, so a passed prediction can never read as a live warning (app/investigations/outlook.py)."""
from datetime import date

from app.investigations.outlook import DUE_TODAY, PASSED, UNKNOWN, UPCOMING, current_outlook

TODAY = date(2026, 11, 25)


def test_a_prediction_still_ahead_gets_a_fresh_days_until_drop():
    out = current_outlook({"predicted_date": "2026-12-01", "days_until_drop": 40, "pct_projected_change": -20.0}, TODAY)
    assert out["state"] == UPCOMING and out["days_until_drop"] == 6 and out["days_until_drop_when_recorded"] == 40


def test_the_production_case_a_prediction_for_2026_08_22_is_passed_and_never_a_negative_days_until():
    out = current_outlook({"predicted_date": "2026-08-22", "days_until_drop": 5, "pct_projected_change": -93.6, "last_actual": 1.0}, TODAY)
    assert out["state"] == PASSED and out["days_until_drop"] is None
    assert out["pct_projected_change"] == -93.6                     # what was predicted is still reported, as a record


def test_due_today_and_an_unreadable_date():
    assert current_outlook({"predicted_date": "2026-11-25"}, TODAY)["state"] == DUE_TODAY
    assert current_outlook({"predicted_date": "soon"}, TODAY)["state"] == UNKNOWN
    assert current_outlook({}, TODAY)["state"] == UNKNOWN
    assert current_outlook(None, TODAY) is None


def test_the_stored_record_is_not_modified():
    stored = {"predicted_date": "2026-08-22", "days_until_drop": 5}
    current_outlook(stored, TODAY)
    assert stored == {"predicted_date": "2026-08-22", "days_until_drop": 5}      # outcome evaluation reads the original
