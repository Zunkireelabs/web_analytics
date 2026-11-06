import pytest

from app.investigations.draft_switch import DraftTriggerDisabled, draft_trigger_enabled


@pytest.mark.parametrize("value,expected", [(None, True), ("on", True), ("", True), ("1", True), ("true", True), ("off", False), ("OFF", False), (" off ", False)])
def test_only_off_turns_the_draft_trigger_off(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("ANALYST_DRAFT_TRIGGER", raising=False)
    else:
        monkeypatch.setenv("ANALYST_DRAFT_TRIGGER", value)
    assert draft_trigger_enabled() is expected


@pytest.mark.asyncio
async def test_generate_draft_refuses_when_off(monkeypatch):
    monkeypatch.setenv("ANALYST_DRAFT_TRIGGER", "off")
    from app.mcp_client.tools import generate_draft

    class Boom:
        async def call_tool(self, *a, **k):
            raise AssertionError("must not reach the app when the switch is off")

    with pytest.raises(DraftTriggerDisabled):
        await generate_draft(Boom(), generator_id="meta-title", params={}, finding_id="analyst:x")


@pytest.mark.asyncio
async def test_run_draft_trigger_does_nothing_when_off(monkeypatch):
    monkeypatch.setenv("ANALYST_DRAFT_TRIGGER", "off")
    from app.investigations import drafts

    async def explode(*a, **k):
        raise AssertionError("must not look up clients or call the app when the switch is off")

    monkeypatch.setattr(drafts, "SessionLocal", explode)
    monkeypatch.setattr(drafts, "generate_draft", explode)
    assert await drafts.run_draft_trigger() is None
