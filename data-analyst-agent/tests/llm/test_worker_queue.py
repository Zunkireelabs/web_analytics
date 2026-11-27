import json

import pytest

from app.agent import narrator
from app.llm import worker_queue


class _Result:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class FakeDb:
    """A tiny stand-in for the shared database: llm_workers (online or not) and llm_requests (answered after `answer_after` polls)."""

    def __init__(self, online=True, final=("done", '{"headline": "ok"}', None), answer_after=1):
        self.online, self.final, self.answer_after = online, final, answer_after
        self.polls, self.inserted, self.updated = 0, [], []

    def __call__(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def commit(self):
        pass

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        if "FROM llm_workers" in sql:
            return _Result((1,) if self.online else None)
        if sql.startswith("INSERT INTO llm_requests"):
            self.inserted.append(params)
            return _Result((42,))
        if sql.startswith("UPDATE llm_requests"):
            self.updated.append(params)
            return _Result(None)
        self.polls += 1
        return _Result(self.final if self.polls >= self.answer_after else ("pending", None, None))


async def _nosleep(_):
    return None


@pytest.mark.asyncio
async def test_ask_queues_the_request_and_returns_the_workers_text():
    db = FakeDb(answer_after=3)
    out = await worker_queue.ask("sys", "usr", session_factory=db, sleep=_nosleep)
    assert out == '{"headline": "ok"}'
    assert db.inserted[0]["sys"] == "sys" and db.inserted[0]["usr"] == "usr"
    assert json.loads(db.inserted[0]["opts"])["source"] == "data-analyst"


@pytest.mark.asyncio
async def test_ask_with_no_worker_online_does_not_queue_anything():
    db = FakeDb(online=False)
    with pytest.raises(worker_queue.WorkerUnavailable):
        await worker_queue.ask("s", "u", session_factory=db, sleep=_nosleep)
    assert db.inserted == []


@pytest.mark.asyncio
async def test_ask_raises_when_the_worker_fails_or_never_answers():
    with pytest.raises(worker_queue.WorkerUnavailable, match="could not write"):
        await worker_queue.ask("s", "u", session_factory=FakeDb(final=("failed", None, "boom")), sleep=_nosleep)
    never = FakeDb(final=("pending", None, None))
    with pytest.raises(worker_queue.WorkerUnavailable, match="in time"):
        await worker_queue.ask("s", "u", timeout_s=3, poll_s=1, session_factory=never, sleep=_nosleep)
    assert never.updated  # the request was marked expired so a late worker does not write it


def test_modes():
    assert worker_queue.worker_mode_on({"LLM_WORKER_MODE": "on"}) and not worker_queue.worker_mode_on({})
    assert worker_queue.paid_api_fallback({"LLM_WORKER_FALLBACK": "api"}) and not worker_queue.paid_api_fallback({})


def test_parse_tool_json_accepts_fences_and_surrounding_text_but_never_guesses():
    assert narrator.parse_tool_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert narrator.parse_tool_json('Here you go: {"a": 1} done') == {"a": 1}
    with pytest.raises(ValueError):
        narrator.parse_tool_json("no json here")
    with pytest.raises(ValueError):
        narrator.parse_tool_json("[1, 2]")


@pytest.mark.asyncio
async def test_forced_tool_call_goes_to_the_worker_and_comes_back_as_that_tools_input(monkeypatch):
    monkeypatch.setenv("LLM_WORKER_MODE", "on")
    seen = {}

    async def fake_ask(system, user, **kw):
        seen["system"], seen["user"] = system, user
        return '{"headline": "Traffic is up"}'

    monkeypatch.setattr(worker_queue, "ask", fake_ask)
    tool = {"name": "submit_summary", "description": "d", "input_schema": {"type": "object", "properties": {"headline": {"type": "string"}}}}
    resp = await narrator.call_llm([{"role": "user", "content": "facts"}], [tool], tool_choice={"type": "tool", "name": "submit_summary"}, system="Be brief.")
    block = resp.content[0]
    assert block.name == "submit_summary" and block.input == {"headline": "Traffic is up"}
    assert "Be brief." in seen["system"] and "submit_summary" in seen["system"] and seen["user"] == "facts"


@pytest.mark.asyncio
async def test_the_ask_chat_loop_is_not_sent_to_the_worker(monkeypatch):
    monkeypatch.setenv("LLM_WORKER_MODE", "on")

    async def boom(*a, **k):
        raise AssertionError("the chat loop must not use the worker")

    monkeypatch.setattr(worker_queue, "ask", boom)

    class Stop(Exception):
        pass

    async def fake_run(name, fn):
        raise Stop()

    monkeypatch.setattr(narrator.controls, "run", fake_run)
    with pytest.raises(Stop):  # it reached the paid-API path, as chat is allowed to
        await narrator.call_llm([{"role": "user", "content": "q"}], [{"name": "t", "input_schema": {}}])
