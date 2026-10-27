import numpy as np
import pandas as pd

from app.predict.features import DECLINE_FRACTION, decline_label, feature_row, training_rows
from app.predict.issues import MIN_TRAIN_ROWS, baseline_likelihood, reason_text, train_and_select
from app.predict.keywords import expected_ctr, growth_candidate
from app.predict.outlook import forecast_series
from app.predict.series import weekly_rate, weekly_sum


def _weekly(values, start="2026-01-05"):
    return pd.Series(np.array(values, dtype=float), index=pd.date_range(start, periods=len(values), freq="W-MON"))


class TestSeries:
    def test_weekly_sum_drops_incomplete_and_current_week(self):
        idx = pd.date_range("2026-09-28", "2026-10-21")  # Mon 28 Sep .. Wed 21 Oct (current week partial)
        s = pd.Series(1.0, index=idx).drop(pd.Timestamp("2026-10-02"))  # one hole in week 1
        out = weekly_sum(s, as_of=pd.Timestamp("2026-10-21").date())
        assert list(out.index) == [pd.Timestamp("2026-10-05"), pd.Timestamp("2026-10-12")]
        assert (out == 7).all()

    def test_weekly_rate_scales_sampled_weeks_and_needs_min_days(self):
        idx = pd.to_datetime(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",   # 4 days observed
                              "2026-10-12", "2026-10-13"])                                # only 2
        s = pd.Series(10.0, index=idx)
        out = weekly_rate(s, as_of=pd.Timestamp("2026-10-30").date())
        assert list(out.index) == [pd.Timestamp("2026-10-05")]
        assert out.iloc[0] == 70.0


class TestOutlook:
    def test_too_little_history_is_not_a_forecast(self):
        assert forecast_series(_weekly([10, 11, 12]))["status"] == "insufficient-data"

    def test_trending_series_forecasts_upward_with_a_range(self):
        r = forecast_series(_weekly([820, 910, 880, 970, 1010, 1060, 1090, 1120, 1150, 1180]))
        assert r["status"] == "ok" and len(r["points"]) == 3
        p1 = r["points"][0]
        assert 1100 < p1["predicted"] < 1300
        assert p1["low"] < p1["predicted"] < p1["high"]
        assert r["points"][2]["high"] - r["points"][2]["low"] >= p1["high"] - p1["low"]  # wider further out

    def test_flat_series_never_claims_a_razor_thin_range(self):
        r = forecast_series(_weekly([500] * 12))
        p = r["points"][0]
        assert (p["high"] - p["low"]) / p["predicted"] >= 0.02

    def test_never_negative(self):
        r = forecast_series(_weekly([40, 30, 22, 15, 9, 5, 3, 1, 0, 0]))
        assert all(pt["low"] >= 0 and pt["predicted"] >= 0 for pt in r["points"])

    def test_weeks_follow_the_last_observed_week(self):
        s = _weekly([100 + i for i in range(10)])
        r = forecast_series(s)
        assert r["points"][0]["week"] == (s.index[-1] + pd.Timedelta(weeks=1)).date().isoformat()


class TestFeaturesAndIssues:
    def _page(self, clicks):
        n = len(clicks)
        return pd.DataFrame({"clicks": np.array(clicks, dtype=float), "impressions": np.array(clicks, dtype=float) * 12, "position": np.full(n, 5.0)},
                            index=pd.date_range("2026-01-05", periods=n, freq="W-MON"))

    def test_feature_row_needs_six_weeks(self):
        assert feature_row(np.ones(5), np.ones(5), np.ones(5)) is None

    def test_feature_rows_carry_no_identifiers(self):
        f = feature_row(np.array([100, 110, 105, 120, 90, 60.]), np.array([1000.] * 6), np.array([4, 4, 4.5, 4.5, 6, 8.]))
        assert all(isinstance(v, float) for v in f.values())

    def test_label_ignores_tiny_pages_and_flags_a_real_drop(self):
        assert decline_label(np.array([1., 2., 1.]), 0.0) is None
        assert decline_label(np.array([100., 100., 100.]), 100 * DECLINE_FRACTION - 1) == 1
        assert decline_label(np.array([100., 100., 100.]), 100.0) == 0

    def test_training_rows_never_use_the_label_week_as_a_feature(self):
        rows = training_rows(self._page([100] * 8 + [10]))
        wk, feats, y = rows[-1]
        assert y == 1 and feats["ratio_last_vs_prev3"] == 1.0  # features still see the flat history

    def test_baseline_ranks_a_falling_slipping_page_above_a_steady_one(self):
        falling = feature_row(np.array([100, 110, 105, 120, 90, 60.]), np.array([1000.] * 6), np.array([4, 4, 4.5, 4.5, 6, 8.]))
        steady = feature_row(np.array([100, 101, 99, 100, 102, 100.]), np.array([1000.] * 6), np.array([4.] * 6))
        assert baseline_likelihood(falling) > 0.6 > baseline_likelihood(steady)

    def test_reason_is_plain_words_from_the_pages_own_numbers(self):
        c, p = np.array([100, 110, 105, 120, 90, 60.]), np.array([4, 4, 4.5, 4.5, 6, 8.])
        text = reason_text(feature_row(c, np.array([1000.] * 6), p), c, p)
        assert text.startswith("Clicks fell") and "position slipped" in text

    def test_too_little_data_keeps_the_baseline(self):
        rows = [feature_row(np.array([100, 110, 105, 120, 90, 60.]), np.array([1000.] * 6), np.array([4.] * 6))] * 20
        r = train_and_select(rows, [0, 1] * 10, list(range(20)))
        assert r["champion"] == "baseline" and r["artifact"] is None and 20 < MIN_TRAIN_ROWS

    def test_learned_model_only_wins_when_it_beats_the_baseline_on_the_holdout(self):
        rng = np.random.default_rng(3)
        rows, labels, order = [], [], []
        for i in range(600):
            ratio = rng.uniform(0.3, 1.5)
            cv = rng.uniform(0, 1)
            # Ground truth deliberately NOT the baseline's shape: volatility on a high-volume page drives drops.
            drop = int((cv > 0.55 and ratio < 1.1) or rng.random() < 0.05)
            rows.append({"log_volume": rng.uniform(2, 6), "ratio_last_vs_prev3": ratio, "slope_norm": rng.uniform(-1, 1), "cv6": cv,
                         "position_delta": rng.uniform(-3, 3), "impr_ratio": rng.uniform(0.5, 1.5), "weeks_observed": 20.0})
            labels.append(drop); order.append(i)
        r = train_and_select(rows, labels, order)
        assert r["champion"] in {"baseline", "gradient_boosting", "neural_network"}
        assert set(r["metrics"]) >= {"baseline", "gradient_boosting", "neural_network"}
        if r["champion"] != "baseline":
            assert r["metrics"][r["champion"]]["logloss"] < r["metrics"]["baseline"]["logloss"]
            assert r["artifact"]


class TestKeywords:
    def test_ctr_curve_is_monotone_down(self):
        assert expected_ctr(1) > expected_ctr(5) > expected_ctr(10) > expected_ctr(25)

    def test_near_page_one_with_rising_demand_qualifies(self):
        c = growth_candidate(np.array([1, 1, 2, 2, 3., 3]), np.array([300, 320, 340, 380, 420, 460.]), np.array([14, 13.5, 13, 12.5, 12, 11.5]))
        assert c and c["gainClicks"] > 5 and 0 < c["likelihood"] < 1 and 11 <= c["position"] <= 12

    def test_page_one_or_buried_or_tiny_queries_do_not_qualify(self):
        flat = np.array([300.] * 6)
        assert growth_candidate(np.ones(6), flat, np.array([2.] * 6)) is None
        assert growth_candidate(np.ones(6), flat, np.array([45.] * 6)) is None
        assert growth_candidate(np.ones(6), np.array([5.] * 6), np.array([12.] * 6)) is None


class TestIndustry:
    def _field(self, n, growth):
        idx = pd.date_range("2026-04-06", periods=16, freq="W-MON")
        rng = np.random.default_rng(1)
        return {i: pd.Series(1000 * (i + 1) * (1 + growth) ** np.arange(16) * (1 + rng.normal(0, 0.02, 16)), index=idx) for i in range(n)}

    def test_a_field_of_fewer_than_five_projects_says_nothing(self):
        from app.predict.industry import industry_outlook
        assert industry_outlook(self._field(4, 0.03), None, "industry") is None

    def test_a_rising_field_is_reported_as_rising_without_naming_anyone(self):
        from app.predict.industry import industry_outlook
        r = industry_outlook(self._field(6, 0.03), pd.Series(np.arange(1, 17) * 100.0, index=pd.date_range("2026-04-06", periods=16, freq="W-MON")), "industry")
        assert r["projects"] == 6 and r["fieldChangeNext3Pct"] > 0 and r["fieldRecentChangePct"] > 0
        assert set(r) == {"scope", "projects", "fieldChangeNext3Pct", "fieldRecentChangePct", "yourRecentChangePct", "model"}

    def test_big_sites_do_not_drown_small_ones(self):
        from app.predict.industry import demand_index
        f = self._field(5, 0.0)
        idx = pd.date_range("2026-04-06", periods=16, freq="W-MON")
        f[99] = pd.Series(1e9 * (1.05 ** np.arange(16)), index=idx)  # one huge, fast-growing project
        f2 = {k: v for k, v in f.items() if k != 99}
        assert abs(demand_index(f).iloc[-1] - demand_index(f2).iloc[-1]) < 0.35


class TestBaselineOnlyReporting:
    def test_too_little_history_still_scores_the_baseline_and_says_why(self):
        rows = [feature_row(np.array([100, 110, 105, 120, 90, 60.]), np.array([1000.] * 6), np.array([4, 4, 4.5, 4.5, 6, 8.])),
                feature_row(np.array([100, 101, 99, 100, 102, 100.]), np.array([1000.] * 6), np.array([4.] * 6))] * 30
        r = train_and_select(rows, [1, 0] * 30, list(range(60)))
        assert r["champion"] == "baseline" and "errorPct" in r["metrics"]["baseline"] and "Needs about" in r["reason"]
