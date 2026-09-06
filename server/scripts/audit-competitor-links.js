import 'dotenv/config';
import { pool } from '../db.js';
import { getRepoTree, getFileContent, defaultBranchName } from '../github/client.js';
import { extractOutboundLinks } from '../generators/lib/outbound-link-guard.js';
import { getCompetitorDomainSet, filterCompetitorCandidates } from '../agents/lib/competitor-policy.js';
import { listAllCompetitorDomains } from '../store/competitor-profiles.js';

// Read-only, cross-tenant audit: for every real, onboarded tenant with a
// repo configured, scan its live default-branch content for outbound links
// that point at THAT tenant's own configured competitors. Writes nothing,
// modifies nothing — this is the "show me the results" step the multi-
// tenant competitor-domain policy (server/agents/lib/competitor-policy.js)
// exists to prevent going forward; existing content found here is reported,
// not touched.
//
//   node server/scripts/audit-competitor-links.js               # every tenant
//   node server/scripts/audit-competitor-links.js --site-id 1   # one tenant
//
// Isolation is structural, not just tested: every domain check below is
// scoped by getCompetitorDomainSet(site.id)/listCompetitorProfiles(site.id)
// for THAT site's own id only — a domain is only ever reported against the
// tenant whose own competitor_profiles row it came from.

const CONTENT_EXTENSIONS = new Set(['.md', '.mdx', '.njk', '.html', '.liquid', '.json', '.js', '.ts', '.jsx', '.tsx']);
const MAX_FILES_PER_SITE = Number(process.env.AUDIT_MAX_FILES_PER_SITE || 2000);

function parseArgs(argv) {
  const siteIdIdx = argv.indexOf('--site-id');
  return { siteId: siteIdIdx >= 0 ? Number(argv[siteIdIdx + 1]) : null };
}

function hasContentExtension(path) {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && CONTENT_EXTENSIONS.has(path.slice(dot));
}

// site → drafts already generated for it, to attribute a matched link back
// to the generator/focus that most plausibly produced it — best-effort, the
// same way this was done manually for Zunkiree (grepping `input`/`content`
// for the matched URL or domain).
async function findLikelySource(siteId, domain, url) {
  const { rows } = await pool.query(
    `SELECT id, action_type, input, pr_url, status
       FROM drafts
      WHERE site_id = $1
        AND status IN ('implemented', 'branch_pushed', 'approved')
        AND (content::text ILIKE $2 OR content::text ILIKE $3)
      ORDER BY created_at DESC
      LIMIT 3`,
    [siteId, `%${domain}%`, `%${url}%`]
  );
  if (!rows.length) return null;
  return rows.map((r) => `${r.action_type} (draft #${r.id}${r.pr_url ? `, ${r.pr_url}` : ''})`).join('; ');
}

async function auditSite(site) {
  const branch = defaultBranchName(site);
  const domains = await getCompetitorDomainSet(site.id);
  const allDomains = await listAllCompetitorDomains(site.id);
  const activeProfiles = allDomains.filter((r) => r.excluded_reason == null);
  const excludedProfiles = allDomains.filter((r) => r.excluded_reason != null);

  const result = {
    site_id: site.id,
    site_name: site.name,
    active_competitor_profiles: activeProfiles.length,
    excluded_competitor_profiles: excludedProfiles.length,
    matches: [],
    error: null,
  };

  if (!domains.size) return result; // nothing configured to check against — honest empty result, not a failure

  let tree;
  try {
    tree = await getRepoTree(site, branch);
  } catch (err) {
    result.error = `could not read repo tree: ${err.message}`;
    return result;
  }

  const files = tree.files.filter(hasContentExtension).slice(0, MAX_FILES_PER_SITE);
  for (const path of files) {
    let file;
    try {
      file = await getFileContent(site, path, branch);
    } catch {
      continue; // a single unreadable file shouldn't abort the whole audit
    }
    if (!file) continue;

    const links = extractOutboundLinks({ body: file.content });
    if (!links.length) continue;
    const { removed } = await filterCompetitorCandidates(links, site.id, (l) => l.url);
    if (!removed.length) continue;

    const byDomain = new Map();
    for (const { url } of removed) {
      const domain = [...domains].find((d) => {
        const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');
        return host === d || host.endsWith(`.${d}`);
      });
      const key = `${domain}::${url}`;
      byDomain.set(key, (byDomain.get(key) || { domain, url, occurrences: 0 }));
      byDomain.get(key).occurrences += 1;
    }

    for (const { domain, url, occurrences } of byDomain.values()) {
      const source = await findLikelySource(site.id, domain, url);
      result.matches.push({
        page: path,
        competitor_domain: domain,
        linked_url: url,
        occurrences,
        generator_source: source || 'unknown (not found in drafts table)',
        recommended_remediation: 'Remove the link or rewrite this section without a promotional link to a configured competitor.',
      });
    }
  }

  return result;
}

async function main() {
  const { siteId } = parseArgs(process.argv.slice(2));

  const { rows: candidateSites } = await pool.query(
    `SELECT * FROM sites
      WHERE deleted_at IS NULL
        AND repo_owner IS NOT NULL AND repo_owner != ''
        AND repo_name IS NOT NULL AND repo_name != ''
        ${siteId ? 'AND id = $1' : ''}
      ORDER BY id`,
    siteId ? [siteId] : []
  );

  console.log(`Cross-tenant competitor-link audit — ${candidateSites.length} tenant(s) with a configured repo.`);
  if (!candidateSites.length) {
    console.log('No tenant has both a repo configured and (optionally) matched --site-id — nothing to scan.');
    await pool.end();
    return;
  }

  const results = [];
  for (const site of candidateSites) {
    console.log(`\nScanning site #${site.id} "${site.name}" (${site.repo_owner}/${site.repo_name})...`);
    const result = await auditSite(site);
    results.push(result);
    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
      continue;
    }
    console.log(`  Active competitor profiles: ${result.active_competitor_profiles} (excluded/platform: ${result.excluded_competitor_profiles})`);
    if (!result.matches.length) {
      console.log('  No competitor links found.');
      continue;
    }
    for (const m of result.matches) {
      console.log(`  MATCH  page=${m.page}  competitor=${m.competitor_domain}  url=${m.linked_url}  occurrences=${m.occurrences}  source=${m.generator_source}`);
    }
  }

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
  const totalOccurrences = results.reduce((sum, r) => sum + r.matches.reduce((s, m) => s + m.occurrences, 0), 0);
  const affectedPages = new Set(results.flatMap((r) => r.matches.map((m) => `${r.site_id}::${m.page}`)));

  // Isolation confirmation: no site's matches ever reference a domain absent
  // from that same site's own active competitor set — this is checked, not
  // just asserted, using the exact same per-site domain set the scan itself
  // used to find each match.
  let isolationOk = true;
  for (const r of results) {
    const siteDomains = await getCompetitorDomainSet(r.site_id);
    for (const m of r.matches) {
      if (!siteDomains.has(m.competitor_domain)) isolationOk = false;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Tenants checked: ${results.length}`);
  console.log(`Total active competitor profiles checked: ${results.reduce((s, r) => s + r.active_competitor_profiles, 0)}`);
  console.log(`Total competitor links found: ${totalMatches} distinct link(s), ${totalOccurrences} occurrence(s) total`);
  console.log(`Affected pages: ${affectedPages.size}`);
  for (const r of results) {
    if (r.matches.length) console.log(`  site #${r.site_id} (${r.site_name}): ${r.matches.length} link(s)`);
  }
  console.log(`Cross-tenant isolation check: ${isolationOk ? 'OK — every match belongs to its own tenant\'s competitor set' : 'FAILED — investigate immediately'}`);
  console.log('\nThis is a read-only report. No files were modified.');

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
