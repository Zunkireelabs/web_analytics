from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date

import pandas as pd


@dataclass
class ForecastPointResult:
    target_period: date
    point_estimate: float
    lower_bound: float
    upper_bound: float


@dataclass
class ForecastResult:
    status: str  # 'ok' | 'insufficient-data' | 'error'
    model: str | None = None
    params: dict | None = None
    error: str | None = None
    points: list[ForecastPointResult] | None = None


class ForecastModel(ABC):
    """One cadence's forecaster. Each cadence registers its own subclass
    in registry.py — never a change to another cadence's module."""

    min_history_periods: int

    @abstractmethod
    def fit_predict(self, series: pd.Series, horizon: int) -> ForecastResult:
        """series: pandas Series indexed by date, sorted ascending, no NaNs."""
        raise NotImplementedError
