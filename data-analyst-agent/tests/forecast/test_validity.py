"""Forecasts must be possible values from a real series (app/forecast/validity.py).

Reproduces the production defect: a daily series with ONE missing day, left unfilled on purpose, made statsmodels fail with
"No supported index is available." ~13,800 times. And the impossible forecast: a predicted engagement time below zero."""
import numpy as np
import pandas as pd

from app.forecast.base import ForecastPointResult, ForecastResult
from app.forecast.daily import DailyForecaster
from app.forecast.validity import RANGE_BY_UNIT, clip_result, gap_reason, trailing_contiguous_daily


def _gapped_series():
    rng = np.random.default_rng(1)
    idx = pd.date_range("2026-09-01", periods=80, freq="D")
    values = 100 + 5 * np.sin(np.arange(80) * 2 * np.pi / 7) + rng.normal(0, 2, 80)
    s = pd.Series(values, index=idx).drop(idx[40])
    s.index = pd.DatetimeIndex(s.index)
    return s


def test_the_old_behaviour_reproduced_one_missing_day_breaks_the_daily_model():
    r = DailyForecaster().fit_predict(_gapped_series(), 14)
    assert r.status == "error" and r.error == "No supported index is available."


def test_the_latest_unbroken_run_forecasts_fine_and_the_earlier_data_is_reported_as_set_aside():
    run, set_aside = trailing_contiguous_daily(_gapped_series())
    assert set_aside == 41 and len(run) == 38 and run.index.freq is not None
    r = DailyForecaster().fit_predict(run, 14)
    assert r.status == "ok" and len(r.points) == 14


def test_no_value_is_invented_to_bridge_the_gap():
    s = _gapped_series()
    run, _ = trailing_contiguous_daily(s)
    assert set(run.index).issubset(set(s.index))                     # every point of the run is a real observation
    assert run.isna().sum() == 0


def test_a_contiguous_or_empty_series_is_untouched():
    idx = pd.date_range("2026-10-01", periods=40, freq="D")
    s = pd.Series(np.arange(40, dtype=float), index=idx)
    run, aside = trailing_contiguous_daily(s)
    assert aside == 0 and len(run) == 40
    assert trailing_contiguous_daily(pd.Series(dtype=float))[1] == 0


def test_gap_reason_names_the_real_numbers():
    assert gap_reason(79, 38, 30) == "the daily series has gaps; its latest unbroken run is 38 day(s) of 79 observed and a forecast needs 30"


def _result(points):
    return ForecastResult(status="ok", model="ets", params={"seasonal": True},
                          points=[ForecastPointResult(target_period=None, point_estimate=e, lower_bound=lo, upper_bound=hi) for e, lo, hi in points])


def test_an_engagement_time_below_zero_is_clipped_and_counted():
    r = clip_result(_result([(-0.12, -1.34, 1.1), (2.0, 0.5, 3.5)]), "seconds")
    assert [p.point_estimate for p in r.points] == [0.0, 2.0]
    assert [p.lower_bound for p in r.points] == [0.0, 0.5]
    assert r.params["clipped_points"] == 1 and r.params["clipped_bounds"] == 1 and r.params["valid_range"] == [0.0, None]
    assert r.params["seasonal"] is True                                # existing params kept


def test_ratios_stay_within_zero_and_one_scores_within_zero_and_a_hundred_positions_never_beat_first():
    ratio = clip_result(_result([(1.07, 0.9, 1.3), (-0.02, -0.1, 0.05)]), "ratio")
    assert [(p.point_estimate, p.lower_bound, p.upper_bound) for p in ratio.points] == [(1.0, 0.9, 1.0), (0.0, 0.0, 0.05)]
    score = clip_result(_result([(104.0, 90.0, 120.0)]), "score_0_100")
    assert (score.points[0].point_estimate, score.points[0].upper_bound) == (100.0, 100.0)
    rank = clip_result(_result([(0.4, 0.1, 2.0)]), "rank")
    assert (rank.points[0].point_estimate, rank.points[0].lower_bound) == (1.0, 1.0)


def test_the_interval_always_contains_the_estimate_even_when_it_was_entirely_out_of_range():
    r = clip_result(_result([(-3.0, -5.0, -1.0)]), "count")             # a whole interval below zero
    p = r.points[0]
    assert p.lower_bound <= p.point_estimate <= p.upper_bound and p.point_estimate == 0.0


def test_an_in_range_forecast_is_not_touched_and_an_unknown_unit_gets_no_invented_range():
    r = clip_result(_result([(10.0, 8.0, 12.0)]), "count")
    assert r.params["clipped_points"] == 0 and r.params["clipped_bounds"] == 0
    untouched = clip_result(_result([(-5.0, -9.0, -1.0)]), "mystery_unit")
    assert untouched.points[0].point_estimate == -5.0 and untouched.params == {"seasonal": True}


def test_every_forecastable_catalog_unit_has_a_range():
    for unit in ("count", "seconds", "ratio", "score_0_100", "rank"):      # the units the catalog actually uses
        assert unit in RANGE_BY_UNIT
