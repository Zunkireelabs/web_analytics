from fastapi import FastAPI

from app.api.routes import ask, dashboard, health

app = FastAPI(title="Data Analyst Agent", description="Admin-only, multi-tenant SEO/growth analytics agent.")

app.include_router(health.router)
app.include_router(dashboard.router)
app.include_router(ask.router)
