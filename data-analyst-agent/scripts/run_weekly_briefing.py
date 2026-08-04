"""Weekly Executive Briefing (Phase 3 Step 10) — separate entrypoint from
run_nightly_pipeline.py since it runs on its own weekly cadence, not every
night. Reads only already-computed nightly tables (see
app/briefings/generator.py) — never recomputes anything.
Run via cron (see docker-compose.yml comment for the nightly job's own
example) as:
    docker compose exec app python -m scripts.run_weekly_briefing
"""
import asyncio

from app.briefings.generator import generate_weekly_briefing


if __name__ == "__main__":
    asyncio.run(generate_weekly_briefing())
