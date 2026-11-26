"""What data does each client actually have today, and may analysis run on it?

The nightly analysis used to run on whatever was in the tables. A twelve-day ingestion outage in August 2026 (the lesson recorded
in app/ingestion/run_nightly.py) emptied the predictions while forecasts, anomalies and insights kept publishing confident
output computed from data that had stopped moving. This module is the gate that makes the analyst KNOW what it has:

  - per client, the newest day of each core input (site GSC, site GA4, page/query) and whether it is fresh, stale or missing;
  - per client, the evidence gaps: collectors whose latest run did not produce data and the reason code (no_mcp_token, ...);
  - a yes/no with a reason for every analysis stage that needs particular inputs.

A stage that cannot run for a client because an input it needs is stale or missing does not run for that client and records
why (insufficient_data). It never runs on old data and calls the result current.

Thresholds follow how each source really updates, and match the Node app's server/agents/lib/analyst-freshness.js: Search Console
publishes about three days late, so a newest GSC day four days old on a healthy night is fresh and anything past five is stale;
GA4 is near-live, so past three is stale."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import IngestionRun, MetricObservation, PageQueryObservation

# source -> (label, max age in days)
SOURCE_LIMITS: dict[str, int] = {
    "gsc_site": 5,
    "ga4_site": 3,
    "page_query": 5,
}
GSC_SITE_METRIC = "gsc_clicks"
GA4_SITE_METRIC = "ga4_sessions"
GAP_LOOKBACK_DAYS = 3

FRESH, STALE, MISSING = "fresh", "stale", "missing"
_CODE = re.compile(r"^([a-z][a-z0-9_]*):")


@dataclass(frozen=True)
class SourceState:
    source: str
    latest: date | None
    age_days: int | None
    max_age_days: int
    state: str

    def describe(self) -> str:
        if self.state == MISSING:
            return f"{self.source} has no data"
        return f"{self.source} newest day {self.latest} is {self.age_days} day(s) old (limit {self.max_age_days})"


@dataclass
class ClientFreshness:
    client_id: int
    sources: dict[str, SourceState]
    gaps: list[dict] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        """fresh: every source fresh. degraded: some fresh, some not. stale: none fresh. (Same three words as the Node side.)"""
        states = [s.state for s in self.sources.values()]
        if all(s == FRESH for s in states):
            return "fresh"
        if any(s == FRESH for s in states):
            return "degraded"
        return "stale"

    def usable(self, needs_all: tuple[str, ...] = (), needs_any: tuple[str, ...] = ()) -> tuple[bool, str | None]:
        """May a stage that needs these inputs run for this client? (True, None) or (False, the reason, naming the input)."""
        for name in needs_all:
            state = self.sources.get(name)
            if state is None or state.state != FRESH:
                return False, f"required input not fresh: {state.describe() if state else name + ' unknown'}"
        if needs_any and not any(self.sources.get(n) and self.sources[n].state == FRESH for n in needs_any):
            detail = "; ".join(self.sources[n].describe() for n in needs_any if n in self.sources)
            return False, f"no required input is fresh: {detail}"
        return True, None

    def as_detail(self) -> dict:
        return {
            "verdict": self.verdict,
            "sources": {
                n: {"latest": s.latest.isoformat() if s.latest else None, "age_days": s.age_days, "state": s.state}
                for n, s in self.sources.items()
            },
            "gaps": self.gaps,
        }


def evaluate(client_id: int, latest: dict[str, date | None], today: date, gaps: list[dict] | None = None) -> ClientFreshness:
    """Pure: newest observation day per source -> states. `latest` may omit a source (treated as missing)."""
    states: dict[str, SourceState] = {}
    for source, limit in SOURCE_LIMITS.items():
        newest = latest.get(source)
        if newest is None:
            states[source] = SourceState(source, None, None, limit, MISSING)
            continue
        age = (today - newest).days
        states[source] = SourceState(source, newest, age, limit, FRESH if age <= limit else STALE)
    return ClientFreshness(client_id=client_id, sources=states, gaps=list(gaps or []))


def gap_code(error: str | None) -> str:
    """The reason code at the front of an ingestion_runs.error ("no_mcp_token: ..." -> "no_mcp_token"), else "error"."""
    match = _CODE.match((error or "").strip())
    return match.group(1) if match else "error"


async def load_freshness(session: AsyncSession, client_ids: list[int], today: date | None = None) -> dict[int, ClientFreshness]:
    today = today or date.today()
    latest: dict[int, dict[str, date | None]] = {cid: {} for cid in client_ids}

    metric_rows = (await session.execute(
        select(MetricObservation.client_id, MetricObservation.metric_key, func.max(MetricObservation.period_start))
        .where(
            MetricObservation.client_id.in_(client_ids), MetricObservation.dimension_type == "site",
            MetricObservation.dimension_value == "__site__", MetricObservation.value.is_not(None),
            MetricObservation.metric_key.in_((GSC_SITE_METRIC, GA4_SITE_METRIC)),
        ).group_by(MetricObservation.client_id, MetricObservation.metric_key)
    )).all()
    for cid, key, newest in metric_rows:
        latest[cid]["gsc_site" if key == GSC_SITE_METRIC else "ga4_site"] = newest

    for cid, newest in (await session.execute(
        select(PageQueryObservation.client_id, func.max(PageQueryObservation.period_start))
        .where(PageQueryObservation.client_id.in_(client_ids)).group_by(PageQueryObservation.client_id)
    )).all():
        latest[cid]["page_query"] = newest

    # Evidence gaps: for each collector, the newest run in the last few days, if it did not produce data. A collector that
    # failed last night but succeeded earlier today is not a gap; one whose newest run failed is.
    since = today - timedelta(days=GAP_LOOKBACK_DAYS)
    gaps: dict[int, list[dict]] = {cid: [] for cid in client_ids}
    newest_run = (
        select(IngestionRun.client_id, IngestionRun.collector_id, func.max(IngestionRun.id).label("rid"))
        .where(IngestionRun.client_id.in_(client_ids), IngestionRun.run_date >= since)
        .group_by(IngestionRun.client_id, IngestionRun.collector_id).subquery()
    )
    for run in (await session.execute(
        select(IngestionRun).join(newest_run, IngestionRun.id == newest_run.c.rid).where(IngestionRun.status != "ok")
    )).scalars().all():
        gaps[run.client_id].append({
            "collector": run.collector_id, "status": run.status, "reason": gap_code(run.error), "run_date": run.run_date.isoformat(),
        })

    return {cid: evaluate(cid, latest[cid], today, sorted(gaps[cid], key=lambda g: g["collector"])) for cid in client_ids}
