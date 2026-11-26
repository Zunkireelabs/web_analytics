"""One definition of prediction error for every table that scores a prediction (app/forecast/error.py)."""
from app.forecast.error import abs_pct_error


def test_error_is_a_percent_of_the_actual():
    assert abs_pct_error(150, 100) == 50.0
    assert abs_pct_error(50, 100) == 50.0
    assert round(abs_pct_error(0.5, 1.0), 6) == 50.0


def test_an_actual_of_zero_has_no_error_rather_than_an_invented_one():
    assert abs_pct_error(7, 0) is None
    assert abs_pct_error(0, 0) is None            # the old weekly code divided by max(actual, 1) and called this a number


def test_the_two_old_definitions_now_agree_for_the_same_miss():
    # forecast_accuracy used percent; prediction_log used a fraction over max(actual, 1). For actual=200, predicted=150 they gave 25.0 and 0.25.
    assert abs_pct_error(150, 200) == 25.0
