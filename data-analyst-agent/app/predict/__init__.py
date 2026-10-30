"""Next-week prediction layer (statistics, gradient boosting, a small neural net).

Everything numeric in here is pure (no DB), so it is unit-testable and so the pooled
cross-project model can be trained on anonymous feature rows only: no domains, no query
text, no client ids ever reach a model (see features.py / pooled.py). The DB-facing
pass lives in run.py."""
