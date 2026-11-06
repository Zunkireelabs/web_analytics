"""Search position: a HIGHER number is a WORSE ranking. 3 -> 2 improved, 3 -> 3 unchanged, 3 -> 8 declined, 8 -> 15 declined.
Every decline decision goes through app/metrics/direction.py; these tests pin each path that uses it."""
import pytest

from app.metrics.direction import anomaly_is_worsening, forecast_breaches, is_worsening, lower_is_better


def pct(prior, current):
    return (current - prior) / prior * 100


CASES = [  # (prior position, current position, is it a decline?)
    (3, 2, False),   # improved
    (3, 3, False),   # unchanged
    (3, 8, True),    # declined
    (8, 15, True),   # declined
]


@pytest.mark.parametrize("prior,current,declined", CASES)
def test_position_changes_use_the_ranking_direction(prior, current, declined):
    assert is_worsening("gsc_position", pct(prior, current)) is declined
    assert is_worsening("gsc_position", current - prior) is declined


@pytest.mark.parametrize("prior,current,declined", [(100, 120, False), (100, 100, False), (100, 80, True)])
def test_every_other_metric_keeps_falling_is_worse(prior, current, declined):
    assert is_worsening("gsc_clicks", pct(prior, current)) is declined


def test_unknown_change_is_never_a_decline():
    assert is_worsening("gsc_position", None) is False
    assert is_worsening("gsc_position", "8") is False


def test_anomaly_direction_a_high_position_is_the_bad_one():
    assert anomaly_is_worsening("gsc_position", "high") is True
    assert anomaly_is_worsening("gsc_position", "low") is False
    assert anomaly_is_worsening("gsc_clicks", "low") is True
    assert anomaly_is_worsening("gsc_clicks", "high") is False


def test_forecast_risk_fires_on_a_projected_RISE_in_position_and_never_on_an_improvement():
    assert forecast_breaches("gsc_position", pct(3, 8), 10.0) is True     # projected 3 -> 8
    assert forecast_breaches("gsc_position", pct(3, 2), 10.0) is False    # projected 3 -> 2 (better): no risk
    assert forecast_breaches("gsc_position", 5.0, 10.0) is False          # under the threshold
    assert forecast_breaches("gsc_clicks", -12.0, 10.0) is True
    assert forecast_breaches("gsc_clicks", 12.0, 10.0) is False


def test_only_position_is_lower_is_better():
    assert lower_is_better("gsc_position") and not lower_is_better("gsc_ctr") and not lower_is_better("health_score")


class _Insight:
    def __init__(self, metric_key, insight_type, evidence):
        self.metric_key, self.insight_type, self.evidence = metric_key, insight_type, evidence


@pytest.mark.parametrize("prior,current,declined", CASES)
def test_the_findings_path_is_decline_agrees(prior, current, declined):
    from app.investigations.drafts import _is_decline
    assert _is_decline(_Insight("gsc_position", "trend_shift", {"pct_change": pct(prior, current)})) is declined


def test_the_findings_path_anomaly_and_other_metrics():
    from app.investigations.drafts import _is_decline
    assert _is_decline(_Insight("gsc_position", "anomaly", {"direction": "high"})) is True
    assert _is_decline(_Insight("gsc_position", "anomaly", {"direction": "low"})) is False
    assert _is_decline(_Insight("gsc_clicks", "trend_shift", {"pct_change": -30})) is True
    assert _is_decline(_Insight("gsc_clicks", "anomaly", {"direction": "low"})) is True


def test_the_alert_wording_for_a_ranking_says_it_worsens_and_other_metrics_are_unchanged():
    import inspect
    from app.alerts import deliver
    src = inspect.getsource(deliver._active_alerts)
    assert "Forecast to worsen by" in src and "a higher position number is a lower ranking" in src
    assert "Forecast to decline" in src
