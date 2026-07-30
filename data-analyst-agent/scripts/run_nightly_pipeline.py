"""Single nightly entrypoint chaining the full pipeline in order:
Collectors -> Metric Cache -> Statistics/Forecast/Anomaly Engines ->
Insight Engine -> Recommendation Engine. Each stage reads only what the
previous stage wrote. Run via cron (see docker-compose.yml comment) as:
    docker compose exec app python -m scripts.run_nightly_pipeline
"""
import asyncio

from app.forecast.run import run_forecasts
from app.ingestion.run_nightly import run_nightly
from app.insights.engine import run_insight_engine
from app.insights.recommendations import run_recommendation_engine
from app.stats.anomalies import run_anomaly_detection
from app.stats.deltas import run_stats


async def main() -> None:
    await run_nightly()
    await run_stats()
    await run_anomaly_detection()
    await run_forecasts()
    await run_insight_engine()
    await run_recommendation_engine()


if __name__ == "__main__":
    asyncio.run(main())
