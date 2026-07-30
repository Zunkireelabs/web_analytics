from app.forecast.base import ForecastModel
from app.forecast.daily import DailyForecaster

# 'weekly'/'monthly' keys get added here later, alongside their own subclass
# in a sibling module — daily.py never changes when that happens.
FORECASTERS: dict[str, ForecastModel] = {
    "daily": DailyForecaster(),
}
