"""Settings routes for client_business_values (migration 0013) — lets staff
enter real conversion/AOV/lead $ figures per client from a UI instead of
only via scripts/set_business_values.py, so ROI Estimation Mode 2 (see
app/scoring/impact_projection.py) can project a dollar figure instead of
Mode 1's metric-unit-only fallback."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client
from app.db.session import get_session
from app.scoring.business_values import get_business_values, upsert_business_values

router = APIRouter()


@router.get("/clients/{client_id}/business-values")
async def get_client_business_values(
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    values = await get_business_values(session, client.id)
    if values is None:
        return {
            "configured": False, "conversion_value": None, "avg_order_value": None,
            "lead_value": None, "revenue_per_conversion": None, "currency": "USD",
        }
    return {
        "configured": values.is_configured, "conversion_value": values.conversion_value,
        "avg_order_value": values.avg_order_value, "lead_value": values.lead_value,
        "revenue_per_conversion": values.revenue_per_conversion, "currency": values.currency,
    }


class BusinessValuesUpdate(BaseModel):
    conversion_value: float | None = None
    avg_order_value: float | None = None
    lead_value: float | None = None
    revenue_per_conversion: float | None = None
    currency: str = "USD"


@router.put("/clients/{client_id}/business-values")
async def put_client_business_values(
    body: BusinessValuesUpdate, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    await upsert_business_values(
        session, client.id,
        conversion_value=body.conversion_value, avg_order_value=body.avg_order_value,
        lead_value=body.lead_value, revenue_per_conversion=body.revenue_per_conversion,
        currency=body.currency,
    )
    return await get_client_business_values(client=client, session=session)
