"""Tool JSON schemas for the conversational agent. metric_key's enum is
populated from the CURRENT metrics_catalog at request time — enabling a
future metric automatically extends what the agent can discuss, with no
change to this file. client_id is never a tool parameter: every tool is
closed over the caller's already-validated client_id (see agent/loop.py),
mirroring server/mcp/tools/read-only.js's siteId-closure convention."""


def build_tool_definitions(enabled_metric_keys: list[str]) -> list[dict]:
    metric_enum = {"type": "string", "enum": enabled_metric_keys}
    date_str = {"type": "string", "description": "YYYY-MM-DD"}

    return [
        {
            "name": "get_cached_metrics",
            "description": "Raw daily observed values for one metric over a date range, from the nightly cache.",
            "input_schema": {
                "type": "object",
                "properties": {"metric_key": metric_enum, "start_date": date_str, "end_date": date_str},
                "required": ["metric_key", "start_date", "end_date"],
            },
        },
        {
            "name": "compare_cached_periods",
            "description": "Week-over-week or month-over-month delta for one metric, from the nightly cache.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "metric_key": metric_enum,
                    "period_type": {"type": "string", "enum": ["wow", "mom"]},
                    "period_end": {**date_str, "description": "YYYY-MM-DD, defaults to the latest cached period"},
                },
                "required": ["metric_key", "period_type"],
            },
        },
        {
            "name": "get_cached_anomalies",
            "description": "Anomalies (z-score/IQR) flagged for one or all metrics over a date range, from the nightly cache.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "metric_key": metric_enum,
                    "start_date": date_str, "end_date": date_str,
                    "method": {"type": "string", "enum": ["zscore", "iqr"]},
                },
                "required": ["start_date", "end_date"],
            },
        },
        {
            "name": "get_cached_forecast",
            "description": "The latest statistical forecast for one metric, from the nightly cache.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "metric_key": metric_enum,
                    "horizon_days": {"type": "integer", "description": "defaults to the configured forecast horizon"},
                },
                "required": ["metric_key"],
            },
        },
        {
            "name": "get_cached_insights",
            "description": "Structured insights (anomalies, trend shifts, forecast risks, milestones) and their recommendations, from the nightly cache.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "metric_key": metric_enum,
                    "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                },
            },
        },
    ]
