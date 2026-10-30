import { useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldCheck } from 'lucide-react';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import CreateTokenModal, { TOKEN_TIERS } from './CreateTokenModal.jsx';
import { siteInitials } from '../../lib/nav.js';

const TIER_TONE = { read_only: 'outline', ai_actions: 'primary', automation: 'amber', admin: 'red' };
const fmt = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Every project's API tokens in one list: let AI tools such as Claude or ChatGPT
// work with the projects in this workspace.
export default function TokensTab({ projects, workspaceName, tokensApi }) {
  const [tokens, setTokens] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const load = () => tokensApi.list().then(setTokens).catch((e) => setError(e.message || 'Could not load tokens.'));
  useEffect(() => { setTokens(null); load(); }, [projects.map((p) => p.id).join(',')]);

  const revoke = async (t) => {
    if (!confirm(`Revoke “${t.label || 'this token'}”? Anything using it stops working right away.`)) return;
    try { await tokensApi.revoke(t.id); await load(); } catch (err) { setError(err.message || 'Could not revoke the token.'); }
  };
  const visible = (tokens || []).filter((t) => filter === 'all' || String(t.site_id) === filter);

  return (
    <div>
      <SettingsCard icon={KeyRound} title="API tokens" description={projects.length === 1 ? 'Let AI tools such as Claude or ChatGPT work with this project.' : 'Let AI tools such as Claude or ChatGPT work with the projects in this workspace.'}
        action={(
          <div className="flex items-center gap-2">
            {projects.length > 1 && <select aria-label="Filter by project" value={filter} onChange={(e) => setFilter(e.target.value)}
              className="hidden sm:block h-8 rounded-control bg-white text-[13px] font-medium text-fg px-2.5 outline-none" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
              <option value="all">All projects</option>
              {projects.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
            </select>}
            <Button variant="light" onClick={() => setCreateOpen(true)}><Plus size={14} />Create token</Button>
          </div>
        )}>
        {error && <div className="mx-5 my-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
        {!tokens ? (
          [0, 1].map((i) => <div key={i} className="px-5 py-3 border-b border-border last:border-0"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>)
        ) : visible.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-faint">No tokens yet.</div>
        ) : visible.map((t) => {
          const tier = TOKEN_TIERS.find((x) => x.value === t.permission_level);
          return (
            <div key={t.id} className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
              <span className="w-8 h-8 rounded-control bg-muted text-text grid place-items-center shrink-0"><KeyRound size={15} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-fg">{t.label || 'Unnamed token'}</span>
                  <span className="font-mono text-[12px] text-faint">{t.token_prefix}••••••</span>
                  <Badge tone={TIER_TONE[t.permission_level] || 'outline'}>{tier?.short || t.permission_level}</Badge>
                  {t.revoked_at && <Badge tone="red">Revoked</Badge>}
                </div>
                <p className="text-xs text-faint mt-0.5 flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded-[4px] bg-primary text-white text-[6px] font-medium grid place-items-center shrink-0">{siteInitials(t.site_name)}</span>
                  <span className="truncate">{t.site_name}</span> · {t.revoked_at ? 'Revoked' : t.last_used_at ? `Last used ${fmt(t.last_used_at)}` : 'Never used'}
                </p>
              </div>
              {!t.revoked_at && <Button variant="ghost" size="sm" className="hover:text-[#b42318]" onClick={() => revoke(t)}>Revoke</Button>}
            </div>
          );
        })}
      </SettingsCard>
      <div className="mt-3 flex items-start gap-2.5 px-3 text-[13px] leading-5 text-text">
        <ShieldCheck size={15} className="text-faint shrink-0 mt-0.5" />
        <span>A token works like a password for an AI tool. Each one is tied to one project and one permission level, and you can revoke it any time.</span>
      </div>
      <CreateTokenModal projects={projects} where={workspaceName} createToken={tokensApi.create} isOpen={createOpen} onClose={() => setCreateOpen(false)} onCreated={load} />
    </div>
  );
}
