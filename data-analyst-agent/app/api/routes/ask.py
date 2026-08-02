from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.loop import ask as run_ask
from app.api.deps import get_active_client
from app.db.models import Client
from app.db.session import get_session

router = APIRouter()


class AskRequest(BaseModel):
    question: str


@router.post("/ask/{client_id}")
async def ask(
    body: AskRequest,
    client: Client = Depends(get_active_client),
    session: AsyncSession = Depends(get_session),
) -> dict:
    return await run_ask(session, client.id, body.question)
