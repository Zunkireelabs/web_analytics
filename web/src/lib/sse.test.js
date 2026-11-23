import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from './sse.js';

const collect = () => { const events = []; return { events, parser: createSseParser((e) => events.push(e)) }; };

describe('createSseParser', () => {
  test('parses whole events', () => {
    const { events, parser } = collect();
    parser.feed('data: {"type":"delta","text":"Hi"}\n\ndata: {"type":"final","message":"Hi"}\n\n');
    assert.deepEqual(events, [{ type: 'delta', text: 'Hi' }, { type: 'final', message: 'Hi' }]);
  });

  test('an event split across pieces is held until it completes', () => {
    const { events, parser } = collect();
    parser.feed('data: {"type":"del');
    parser.feed('ta","text":"Hel');
    assert.deepEqual(events, []);
    parser.feed('lo"}\n');
    assert.deepEqual(events, []);
    parser.feed('\ndata: {"type":"final"}\n\n');
    assert.deepEqual(events, [{ type: 'delta', text: 'Hello' }, { type: 'final' }]);
  });

  test('keep-alive comments and blank blocks are ignored; a bad event does not stop the next', () => {
    const { events, parser } = collect();
    parser.feed(': keep-alive\n\n\n\ndata: not json\n\ndata: {"type":"status","text":"x"}\n\n');
    assert.deepEqual(events, [{ type: 'status', text: 'x' }]);
  });

  test('handles CRLF line endings and text containing newlines', () => {
    const { events, parser } = collect();
    parser.feed('data: {"type":"delta","text":"a\\nb"}\r\n\r\n');
    assert.deepEqual(events, [{ type: 'delta', text: 'a\nb' }]);
  });
});
