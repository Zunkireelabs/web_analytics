import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, createClientSite } from '../db.js';
import { getSiteById } from '../store/read.js';
import { getUserByEmail, createUser } from '../store/users.js';

// Provision a client login. Two modes:
//
//   node server/scripts/create-client.js <email> <password> --company "Acme Corp" [--domain acme.com] [--timezone Asia/Kolkata]
//       → creates a NEW site (gsc_property/ga4_property_id left NULL, to be
//         connected later) and a user for it, in one step.
//
//   node server/scripts/create-client.js <email> <password> --site-id <id>
//       → attaches a login to an EXISTING site without touching that site's
//         row at all. Use this once, at rollout, to provision the first
//         login for a site that already exists via getOrCreateSite() (e.g.
//         this instance's real production site) — it must NOT be re-created.

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [email, password] = positional;

  if (!email || !password) {
    throw new Error(
      'Usage: create-client.js <email> <password> --company "Name" [--domain example.com] [--timezone Asia/Kolkata]\n' +
      '   or: create-client.js <email> <password> --site-id <id>'
    );
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  const hasSiteId = flags['site-id'] != null;
  const hasCompany = flags.company != null;
  if (hasSiteId && hasCompany) {
    throw new Error('Pass either --site-id (attach to an existing site) or --company (create a new site), not both.');
  }
  if (!hasSiteId && !hasCompany) {
    throw new Error('Pass --company "Name" to create a new client, or --site-id <id> to attach a login to an existing site.');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await getUserByEmail(normalizedEmail);
  if (existing) {
    throw new Error(`A user with email "${normalizedEmail}" already exists (id ${existing.id}, site ${existing.site_id}).`);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  if (hasSiteId) {
    const siteId = Number(flags['site-id']);
    const site = await getSiteById(siteId);
    if (!site) throw new Error(`No site found with id ${siteId}.`);
    const user = await createUser({ siteId: site.id, email: normalizedEmail, passwordHash });
    console.log(`Attached login "${normalizedEmail}" (user #${user.id}) to existing site #${site.id} "${site.name}".`);
    return;
  }

  // New client: create the site, then the login. If site creation succeeds
  // but user creation fails, the site is left in place (harmless — nothing
  // ingests against it until GSC/GA4 are connected later) and can be
  // attached to a login afterward via the --site-id mode printed below.
  const site = await createClientSite({
    name: flags.company,
    websiteDomain: flags.domain,
    timezone: flags.timezone,
  });
  try {
    const user = await createUser({ siteId: site.id, email: normalizedEmail, passwordHash });
    console.log(`Created site #${site.id} "${site.name}" and user #${user.id} "${normalizedEmail}".`);
    console.log('GSC/GA4 are not connected for this site yet.');
  } catch (err) {
    console.error(`Site #${site.id} "${site.name}" was created, but the login failed: ${err.message}`);
    console.error(`Retry with: node server/scripts/create-client.js ${email} <password> --site-id ${site.id}`);
    throw err;
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('create-client failed:', err.message);
    await pool.end();
    process.exit(1);
  });
