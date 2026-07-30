from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    token_encryption_key: str
    mcp_base_url: str
    admin_api_key: str
    anthropic_api_key: str

    ingest_lookback_days: int = 400
    z_score_threshold: float = 3.0
    iqr_multiplier: float = 1.5
    forecast_horizon_days: int = 14
    min_history_days_for_forecast: int = 30


settings = Settings()
