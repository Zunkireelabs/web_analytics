import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import (
    activity, alerts, ask, benchmarks, breakdown, briefings, business_values, dashboard, health, intelligence,
    investigations, opportunities, recommendations,
)
from app.config import settings
from app.ingestion.scheduler import start_scheduler, stop_scheduler

# Nothing else in this app ever configured logging, so any module-level
# `logger.info(...)` call (e.g. app/ingestion/scheduler.py) was silently
# dropped — Python's root logger defaults to WARNING with no handler.
# uvicorn configures its own "uvicorn"/"uvicorn.error"/"uvicorn.access"
# loggers independently of this, so this only affects our own app code.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


# root_path tells FastAPI (and the /docs Swagger UI it generates) the public
# path prefix this service is reached under when deployed behind the Node
# app's reverse proxy, so self-referencing links like openapi.json resolve
# correctly instead of 404ing under that prefix. Empty for local direct
# access (settings.root_path defaults to "").
app = FastAPI(
    title="Data Analyst Agent",
    description="Admin-only, multi-tenant SEO/growth analytics agent.",
    root_path=settings.root_path,
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(dashboard.router)
app.include_router(breakdown.router)
app.include_router(benchmarks.router)
app.include_router(ask.router)
app.include_router(alerts.router)
app.include_router(recommendations.router)
app.include_router(intelligence.router)
app.include_router(investigations.router)
app.include_router(opportunities.router)
app.include_router(activity.router)
app.include_router(briefings.router)
app.include_router(business_values.router)
