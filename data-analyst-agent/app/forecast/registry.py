from app.forecast.base import ForecastModel
from app.forecast.daily import DailyForecaster
from app.forecast.monthly import MonthlyForecaster
from app.forecast.weekly import WeeklyForecaster

FORECASTERS: dict[str, ForecastModel] = {
    "daily": DailyForecaster(),
    "weekly": WeeklyForecaster(),
    "monthly": MonthlyForecaster(),
}
