"""A stated likelihood is only called a probability once the client's own outcomes support it (app/predict/calibration.py)."""
from app.predict.calibration import MIN_PER_BAND, UNCALIBRATED, calibrated_confidence, reliability


def _resolved(likelihood, happened, n_happened, n_not):
    return [(likelihood, True)] * n_happened + [(likelihood, False)] * n_not


def test_with_no_history_the_raw_likelihood_is_kept_and_labelled_uncalibrated():
    assert calibrated_confidence(0.72, []) == (0.72, UNCALIBRATED)


def test_a_band_with_too_few_outcomes_is_not_trusted():
    resolved = _resolved(0.72, True, 3, 4)                    # 7 < MIN_PER_BAND
    assert calibrated_confidence(0.72, resolved) == (0.72, UNCALIBRATED)


def test_a_band_with_enough_outcomes_reports_the_OBSERVED_hit_rate_not_the_models_claim():
    resolved = _resolved(0.72, True, 4, 8)                    # the model said ~72%; it happened 4 of 12 times
    confidence, basis = calibrated_confidence(0.74, resolved)
    assert confidence == round(4 / 12, 3) and basis == "observed_hit_rate:12_resolved_outcomes"


def test_other_bands_are_unaffected_by_a_trusted_band():
    resolved = _resolved(0.72, True, 4, 8)
    assert calibrated_confidence(0.55, resolved) == (0.55, UNCALIBRATED)


def test_reliability_table_counts_per_band_and_marks_which_are_trusted():
    resolved = _resolved(0.55, True, 2, 3) + _resolved(0.72, True, 6, 6)
    table = reliability(resolved)
    by_lo = {b["lo"]: b for b in table["bands"]}
    assert table["n"] == 17 and by_lo[0.5]["n"] == 5 and by_lo[0.5]["trusted"] is False
    assert by_lo[0.7]["n"] == 12 and by_lo[0.7]["hit_rate"] == 0.5 and by_lo[0.7]["trusted"] is (12 >= MIN_PER_BAND)
    assert reliability([])["hit_rate"] is None
