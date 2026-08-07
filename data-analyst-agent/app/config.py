from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    token_encryption_key: str
    mcp_base_url: str
    admin_api_key: str
    openai_api_key: str

    # Public path prefix this service is reverse-proxied under (e.g.
    # "/data-agent" — see the main Node app's server/routes/data-agent.js).
    # Empty by default so running uvicorn directly for local dev, with no
    # proxy in front, still serves /docs and openapi.json at the root as
    # expected — only set this in the deployed .env, matching the proxy path.
    root_path: str = ""

    ingest_lookback_days: int = 400
    z_score_threshold: float = 3.0
    iqr_multiplier: float = 1.5
    forecast_horizon_days: int = 14
    min_history_days_for_forecast: int = 30
    forecast_horizon_weeks: int = 8
    min_history_weeks_for_forecast: int = 8
    forecast_horizon_months: int = 3
    min_history_months_for_forecast: int = 3

    # In-process nightly ingestion cron (app/ingestion/scheduler.py) — mirrors
    # the main Node app's in-process node-cron pattern (server/cron.js), no
    # separate worker/queue container. Runs after the Node app's own ~01:30 UTC
    # (07:00 Asia/Kolkata) daily GSC/GA4 pull so this service's MCP calls see
    # fresh upstream data rather than racing it.
    ingest_schedule_enabled: bool = True
    ingest_schedule_hour_utc: int = 3


settings = Settings()
