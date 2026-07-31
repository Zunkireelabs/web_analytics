from app.forecast.base import ForecastModel
from app.forecast.daily import DailyForecaster
from app.forecast.monthly import MonthlyForecaster

# 'weekly' key gets added here later, alongside its own subclass in a
# sibling module — daily.py/monthly.py never change when that happens.
FORECASTERS: dict[str, ForecastModel] = {
    "daily": DailyForecaster(),
    "monthly": MonthlyForecaster(),
}
