"""Runs the analysis pass by hand — the same stages the in-process scheduler
runs nightly at ANALYSIS_SCHEDULE_HOUR_UTC (app/ingestion/scheduler.py).

Use this to backfill forecasts immediately after a deploy rather than waiting
for the next scheduled run, or to reproduce a failure with the traceback in
front of you (the scheduler deliberately swallows exceptions so a bad night
can't kill the process; here they propagate and set a non-zero exit code).

    docker compose exec app python -m scripts.run_analysis_pass

For the full pass including investigations, briefings and draft triggers, use
scripts/run_nightly_pipeline.py instead — this is only the subset the Analyst
page renders.
"""
import asyncio

from app.analysis.run_pass import run_analysis_pass

if __name__ == "__main__":
    asyncio.run(run_analysis_pass())
