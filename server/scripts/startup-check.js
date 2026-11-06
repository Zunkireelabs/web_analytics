import 'dotenv/config';
import { runStartupChecks } from '../lib/startup-checks.js';

// Fails (exit 1) when anything the growth and learning system needs is blocked. Safe to run anywhere: it only reads.
//   node server/scripts/startup-check.js            # uses whatever DATABASE_URL / environment is set
const report = await runStartupChecks();
const { pool } = await import('../db.js');
await pool.end();
process.exit(report.blocked.length ? 1 : 0);
