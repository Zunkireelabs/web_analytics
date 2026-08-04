from fastapi import FastAPI

from app.api.routes import (
    alerts, ask, benchmarks, breakdown, business_values, dashboard, health, intelligence, investigations,
    recommendations,
)
from app.config import settings

# root_path tells FastAPI (and the /docs Swagger UI it generates) the public
# path prefix this service is reached under when deployed behind the Node
# app's reverse proxy, so self-referencing links like openapi.json resolve
# correctly instead of 404ing under that prefix. Empty for local direct
# access (settings.root_path defaults to "").
app = FastAPI(
    title="Data Analyst Agent",
    description="Admin-only, multi-tenant SEO/growth analytics agent.",
    root_path=settings.root_path,
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
app.include_router(business_values.router)
