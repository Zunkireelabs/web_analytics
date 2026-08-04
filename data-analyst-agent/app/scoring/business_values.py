"""Read-side helper for client_business_values — every ROI Estimation Mode-2
call site uses this rather than duplicating the "is Mode 2 configured for
this client" null-check. See scripts/set_business_values.py for the
original CLI write side (its None-means-"leave field unchanged" upsert
semantics are for a scripted single-field update; upsert_business_values
below is a plain overwrite-all, for the settings-form PUT route, which
naturally submits full state including an intentionally-cleared field)."""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ClientBusinessValue


@dataclass
class BusinessValues:
    conversion_value: float | None
    avg_order_value: float | None
    lead_value: float | None
    revenue_per_conversion: float | None
    currency: str

    @property
    def is_configured(self) -> bool:
        """True only if at least one monetary field is actually set — a row
        that exists but is all-null is still 'not configured' for Mode 2
        purposes, same as no row at all."""
        return any([self.conversion_value, self.avg_order_value, self.lead_value, self.revenue_per_conversion])


async def get_business_values(session: AsyncSession, client_id: int) -> BusinessValues | None:
    row = (
        await session.execute(select(ClientBusinessValue).where(ClientBusinessValue.client_id == client_id))
    ).scalar_one_or_none()
    if row is None:
        return None
    return BusinessValues(
        conversion_value=float(row.conversion_value) if row.conversion_value is not None else None,
        avg_order_value=float(row.avg_order_value) if row.avg_order_value is not None else None,
        lead_value=float(row.lead_value) if row.lead_value is not None else None,
        revenue_per_conversion=float(row.revenue_per_conversion) if row.revenue_per_conversion is not None else None,
        currency=row.currency,
    )


async def upsert_business_values(
    session: AsyncSession, client_id: int, *,
    conversion_value: float | None, avg_order_value: float | None,
    lead_value: float | None, revenue_per_conversion: float | None, currency: str,
) -> None:
    """Full-state overwrite (unlike scripts/set_business_values.py's
    None-skips-the-field CLI semantics) — a settings form submits every
    field on every save, so a field the user cleared should actually be
    nulled, not silently preserved."""
    stmt = pg_insert(ClientBusinessValue).values(
        client_id=client_id, conversion_value=conversion_value, avg_order_value=avg_order_value,
        lead_value=lead_value, revenue_per_conversion=revenue_per_conversion, currency=currency,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["client_id"],
        set_={
            "conversion_value": stmt.excluded.conversion_value, "avg_order_value": stmt.excluded.avg_order_value,
            "lead_value": stmt.excluded.lead_value, "revenue_per_conversion": stmt.excluded.revenue_per_conversion,
            "currency": stmt.excluded.currency,
        },
    )
    await session.execute(stmt)
    await session.commit()
