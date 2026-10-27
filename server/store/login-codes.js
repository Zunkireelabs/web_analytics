import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';

// Sign-in codes (migration 206). Pure rules live here so the route only has to say yes or no.
export const CODE_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const MIN_SECONDS_BETWEEN = 60;
export const MAX_PER_HOUR = 5;

const hashCode = (email, code) => createHash('sha256').update(`${email}:${code}`).digest('hex');
export const generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const normalizeCode = (v) => String(v ?? '').replace(/\D/g, '');

// Makes a new code for an address, unless one was sent too recently. Returns { code } or
// { tooSoon: true }. An older live code is NOT cancelled: anyone can ask for a code for any address, so
// cancelling the previous one would let a stranger kill a code the owner is about to type. Every live
// code stays good until it is used, expires or runs out of tries; at most MAX_PER_HOUR exist per hour.
export async function issueLoginCode(email) {
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS lasthour,
            COALESCE(EXTRACT(EPOCH FROM now() - MAX(created_at)), 1e9) AS since
       FROM login_codes WHERE email = $1`, [email]);
  if (rows[0].lasthour >= MAX_PER_HOUR || Number(rows[0].since) < MIN_SECONDS_BETWEEN) return { tooSoon: true };
  const code = generateCode();
  await query(
    `INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [email, hashCode(email, code), String(CODE_MINUTES)]);
  return { code };
}

// Checks a typed code against the address's live codes. Every try is COUNTED FIRST, in one atomic
// statement that only succeeds while the code still has tries left, so parallel guesses cannot all slip
// under the limit; the code is spent at MAX_ATTEMPTS. The counter lives on the row in the database, so it
// holds across app instances. Returns { ok: true } or { ok: false, reason }.
export async function checkLoginCode(email, typed) {
  const code = normalizeCode(typed);
  if (code.length !== 6) return { ok: false, reason: 'invalid' };
  const { rows } = await query(
    `SELECT id, code_hash FROM login_codes
      WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
      ORDER BY created_at DESC LIMIT $3`, [email, MAX_ATTEMPTS, MAX_PER_HOUR]);
  const want = Buffer.from(hashCode(email, code));
  for (const row of rows) {
    // Count the try first, atomically, and only while the code still has tries left.
    const counted = await query(
      `UPDATE login_codes SET attempts = attempts + 1
        WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts`, [row.id, MAX_ATTEMPTS]);
    if (!counted.rowCount) continue; // spent by a parallel try: no more guesses on it
    const have = Buffer.from(row.code_hash);
    if (have.length === want.length && timingSafeEqual(have, want)) {
      // Single use: only the try that actually flips consumed_at wins, so two simultaneous correct
      // submissions cannot both sign in.
      const used = await query(`UPDATE login_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [row.id]);
      return used.rowCount ? { ok: true } : { ok: false, reason: 'invalid' };
    }
    if (counted.rows[0].attempts >= MAX_ATTEMPTS) {
      await query(`UPDATE login_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [row.id]);
    }
  }
  return { ok: false, reason: 'invalid' };
}
