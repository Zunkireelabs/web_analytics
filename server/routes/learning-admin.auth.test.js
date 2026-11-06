import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import { pool } from '../db.js';
import router from './learning-admin.js';

// The real router with the real auth middleware, but no session: every route must refuse before touching anything.
const app = express();
app.use(express.json());
app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
app.use('/api', router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { server.close(); await pool.end(); });

const routes = [
  ['GET', '/internal/learning/industry'], ['GET', '/internal/learning/industry/1/history'], ['POST', '/internal/learning/industry/1/review'],
  ['GET', '/internal/models'], ['POST', '/internal/models/rollback'], ['POST', '/internal/models/1/promote'], ['POST', '/internal/models/1/reject'],
];
for (const [method, path] of routes) {
  test(`${method} ${path} refuses an unauthenticated caller`, async () => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ state: 'rejected', reason: 'attempt without signing in' }) : undefined });
    assert.ok([401, 403].includes(r.status), `got ${r.status}`);
    const t = await r.text();
    assert.ok(!/review_state|accuracy|model_id/.test(t), 'no data in the refusal');
  });
}
