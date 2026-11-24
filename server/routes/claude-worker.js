import { Router } from 'express';
import crypto from 'node:crypto';
import * as realStore from '../store/llm-requests.js';
import { workerMode, workerFallback } from '../lib/claude-worker-provider.js';

// The endpoints the Claude Code worker (tools/claude-code-worker/) talks to. The laptop connects OUT to these; nothing connects in to it.
//
// Public in the sense of no session cookie, authenticated with ONE bearer token (LLM_WORKER_TOKEN on the server, in the worker's keychain/env), the same shape as the
// CRM and AI-crawler routes: mount before any router with a blanket requireAuth. With no LLM_WORKER_TOKEN set every route answers 404, so the feature does not exist
// until someone turns it on.
//
// The worker only ever receives a prompt and returns text. It has no access to a repository, to GitHub or to the database.
const router = Router();

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const tokenMatches = (presented, expected) => Boolean(expected && presented) && crypto.timingSafeEqual(digest(presented), digest(expected));
const WORKER_ID = /^[A-Za-z0-9._-]{3,64}$/;
const MAX_WAIT_MS = 25_000;
const POLL_MS = 1000;

export function requireWorkerToken(req, res, next, env = process.env) {
  const expected = env.LLM_WORKER_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found' });
  const header = req.headers?.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!tokenMatches(presented, expected)) return res.status(401).json({ error: 'Invalid or missing worker token.' });
  return next();
}

const bad = (res, error, status = 400) => res.status(status).json({ error });
const workerIdOf = (req) => (WORKER_ID.test(String(req.body?.workerId ?? '')) ? req.body.workerId : null);
const idOf = (req) => (/^\d{1,18}$/.test(String(req.params?.id ?? '')) ? Number(req.params.id) : null);

let lastSweep = 0;

/** The handlers take their collaborators so they can be tested without a server or a database. */
export function makeHandlers({ store = realStore, env = process.env, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return {
    async heartbeat(req, res) {
      const workerId = workerIdOf(req); if (!workerId) return bad(res, 'workerId must be 3-64 letters, digits, dots, dashes or underscores.');
      await store.heartbeat(workerId, { host: String(req.body?.info?.host ?? '').slice(0, 80), version: String(req.body?.info?.version ?? '').slice(0, 20) });
      return res.json({ ok: true, mode: workerMode(env) ? 'on' : 'off', fallback: workerFallback(env) });
    },
    async claim(req, res) {
      const workerId = workerIdOf(req); if (!workerId) return bad(res, 'workerId must be 3-64 letters, digits, dots, dashes or underscores.');
      await store.heartbeat(workerId, { host: String(req.body?.info?.host ?? '').slice(0, 80) });
      if (now() - lastSweep > 30_000) { lastSweep = now(); await store.sweep().catch(() => {}); }
      const limit = Math.max(1, Math.min(Number(req.body?.limit) || 1, 5));
      const deadline = now() + Math.max(0, Math.min(Number(req.body?.waitMs) || 0, MAX_WAIT_MS));
      for (;;) {
        const requests = await store.claimRequests(workerId, limit);
        if (requests.length || now() >= deadline) return res.json({ requests });
        await sleep(POLL_MS);
      }
    },
    async complete(req, res) {
      const workerId = workerIdOf(req); const id = idOf(req);
      if (!workerId || id == null) return bad(res, 'A workerId and a numeric request id are required.');
      const r = await store.completeRequest(id, workerId, req.body?.text);
      if (r.ok) return res.json({ ok: true });
      return r.error ? bad(res, r.error, 413) : bad(res, 'This request is not held by this worker any more (it may have been given to another).', 409);
    },
    async fail(req, res) {
      const workerId = workerIdOf(req); const id = idOf(req);
      if (!workerId || id == null) return bad(res, 'A workerId and a numeric request id are required.');
      const r = await store.failRequest(id, workerId, req.body?.error, { retryable: req.body?.retryable === true });
      return r.ok ? res.json({ ok: true }) : bad(res, 'This request is not held by this worker any more.', 409);
    },
    async release(req, res) {
      const workerId = workerIdOf(req); if (!workerId) return bad(res, 'workerId must be 3-64 letters, digits, dots, dashes or underscores.');
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((n) => Number.isInteger(n)) : null;
      return res.json(await store.releaseRequests(workerId, ids));
    },
    async status(_req, res) { return res.json(await store.queueStatus()); },
  };
}

const h = makeHandlers();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.use('/worker', (req, res, next) => requireWorkerToken(req, res, next));
router.post('/worker/heartbeat', wrap(h.heartbeat));
router.post('/worker/claim', wrap(h.claim));
router.post('/worker/requests/:id/complete', wrap(h.complete));
router.post('/worker/requests/:id/fail', wrap(h.fail));
router.post('/worker/release', wrap(h.release));
router.get('/worker/status', wrap(h.status));

export default router;
