"""Set or update a client's business-value inputs for ROI Estimation Mode 2
(a later Phase 2 stage). Backend-only for now, no settings UI — run this
once real conversion/AOV/lead values are known for a client. Any flag left
unset stays null (Mode 1 fallback stays in effect for that field, never
silently defaulted to 0/1).

Usage:
  python -m scripts.set_business_values --client-id 42 --conversion-value 49.99 --currency USD
"""
import argparse
import asyncio

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.models import ClientBusinessValue
from app.db.session import SessionLocal


async def set_business_values(
    client_id: int,
    conversion_value: float | None,
    avg_order_value: float | None,
    lead_value: float | None,
    revenue_per_conversion: float | None,
    currency: str,
) -> None:
    stmt = pg_insert(ClientBusinessValue).values(
        client_id=client_id,
        conversion_value=conversion_value,
        avg_order_value=avg_order_value,
        lead_value=lead_value,
        revenue_per_conversion=revenue_per_conversion,
        currency=currency,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["client_id"],
        set_={
            # Only overwrite a field if this run actually passed a value —
            # re-running to update one field must not silently null the rest.
            "conversion_value": stmt.excluded.conversion_value if conversion_value is not None else ClientBusinessValue.conversion_value,
            "avg_order_value": stmt.excluded.avg_order_value if avg_order_value is not None else ClientBusinessValue.avg_order_value,
            "lead_value": stmt.excluded.lead_value if lead_value is not None else ClientBusinessValue.lead_value,
            "revenue_per_conversion": stmt.excluded.revenue_per_conversion if revenue_per_conversion is not None else ClientBusinessValue.revenue_per_conversion,
            "currency": stmt.excluded.currency,
        },
    )
    async with SessionLocal() as session:
        await session.execute(stmt)
        await session.commit()
    print(f"Set business values for client {client_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-id", type=int, required=True)
    parser.add_argument("--conversion-value", type=float, default=None, help="Revenue per conversion event, e.g. a lead form submit")
    parser.add_argument("--avg-order-value", type=float, default=None)
    parser.add_argument("--lead-value", type=float, default=None)
    parser.add_argument("--revenue-per-conversion", type=float, default=None)
    parser.add_argument("--currency", default="USD")
    args = parser.parse_args()
    asyncio.run(set_business_values(
        args.client_id, args.conversion_value, args.avg_order_value,
        args.lead_value, args.revenue_per_conversion, args.currency,
    ))


if __name__ == "__main__":
    main()
