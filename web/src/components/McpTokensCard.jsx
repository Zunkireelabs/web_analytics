import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { KeyRound, Copy, Check, Info, Plus, ChevronDown } from 'lucide-react';
import Modal from './Modal.jsx';
import RichSelect from './RichSelect.jsx';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import Field from './Field.jsx';
import SettingsCard from './settings/SettingsCard.jsx';
import { fmtDay } from '../lib/format.js';

// Kept in sync by hand with mcp-server/permissions.js's PERMISSION_LEVELS —
// no shared frontend/backend constants module exists in this repo to
// import this from directly.
const TIERS = [
  { value: 'read_only', label: 'Read Only', hint: 'View reports, analytics, and drafts. Cannot change anything.', highTier: false },
  { value: 'ai_actions', label: 'AI Actions', hint: 'Read Only, plus run agents and generate/edit drafts. No GitHub access.', highTier: false },
  { value: 'automation', label: 'Automation', hint: 'AI Actions, plus push branches and open PRs. Never merges automatically — review stays manual.', highTier: true },
  { value: 'admin', label: 'Admin', hint: 'Automation, plus creating and revoking API tokens for this site. An AI client with an Admin token can create more tokens — including more Admin tokens — on its own, with no one confirming each one.', highTier: true },
];

function connectSnippet(token) {
  // POST /api/mcp now lives on its own subdomain (mcp-server/index.js, see
  // the plan: "Split the MCP server onto its own subdomain") — VITE_MCP_ORIGIN
  // is baked in at build time (Dockerfile ARG/ENV). Falls back to this app's
  // own origin if unset, so local dev (npm run dev:web) is unaffected.
  const origin = import.meta.env.VITE_MCP_ORIGIN || (typeof window !== 'undefined' ? window.location.origin : '');
  return `claude mcp add --transport http superrank ${origin}/api/mcp \\\n  --header "Authorization: Bearer ${token}"`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="light"
      size="sm"
      className="shrink-0"
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// "21 Oct 2026" from an ISO timestamp.
const fmtDate = (iso) => `${fmtDay(String(iso).slice(0, 10))} ${String(iso).slice(0, 4)}`;

export default function McpTokensCard({ projectDomain }) {
  const [tokens, setTokens] = useState(null);
  const [error, setError] = useState(null);
  const [label, setLabel] = useState('');
  const [tier, setTier] = useState('read_only');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null); // { token, label } — shown once
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  // Automation/Admin require re-entering the account password first — a
  // speed bump against an accidental high-blast-radius grant, not a hard
  // access-control boundary (the same session can already do this via the
  // API directly). See server/routes/login.js's /verify-password.
  const [confirmingPassword, setConfirmingPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);

  const load = () => api.mcpTokens.list().then(setTokens).catch((e) => setError(e.message || 'Could not load tokens.'));

  useEffect(() => { load(); }, []);

  const closeModal = () => {
    setModalOpen(false);
    setJustCreated(null);
    setLabel('');
    setTier('read_only');
    setConfirmingPassword(false);
    setPassword('');
    setError(null);
  };

  const doCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await api.mcpTokens.create(label.trim() || null, tier);
      setJustCreated(created);
      setLabel('');
      setTier('read_only');
      setConfirmingPassword(false);
      setPassword('');
      await load();
    } catch (err) {
      setError(err.message || 'Could not create token.');
    } finally {
      setCreating(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const selected = TIERS.find((t) => t.value === tier);
    if (selected?.highTier && !confirmingPassword) {
      setError(null);
      setConfirmingPassword(true);
      return;
    }
    doCreate();
  };

  const confirmPasswordAndCreate = async (e) => {
    e.preventDefault();
    setVerifying(true);
    setError(null);
    try {
      await api.verifyPassword(password);
      setPassword('');
      await doCreate();
    } catch (err) {
      setError(err.message || 'Incorrect password.');
    } finally {
      setVerifying(false);
    }
  };

  const revoke = async (id) => {
    if (!confirm('Revoke this token? Any client using it will immediately lose access.')) return;
    try {
      await api.mcpTokens.revoke(id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not revoke token.');
    }
  };

  const ring = { boxShadow: '0 0 0 1px var(--input)' };

  return (
    <SettingsCard icon={KeyRound} title="API tokens"
      description="Connect Claude, ChatGPT, or any MCP-capable AI client to this project"
      action={<Button variant="light" onClick={() => setModalOpen(true)}><Plus size={14} />Create token</Button>}>
      {error && !modalOpen && (
        <div className="mx-5 my-3 rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">
          {error}
        </div>
      )}

      {!tokens ? (
        <div>
          {[0, 1].map((i) => (
            <div key={i} className="px-5 py-3 border-b border-border last:border-0"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>
          ))}
        </div>
      ) : tokens.length === 0 ? (
        <div className="px-5 py-8 text-center text-[13px] text-faint">No tokens yet.</div>
      ) : (
        <div>
          {tokens.map((t) => {
            const tierInfo = TIERS.find((tier) => tier.value === t.permission_level);
            const isOpen = expandedId === t.id;
            return (
              <div key={t.id} className="border-b border-border last:border-0">
                <div className="flex items-center gap-3 px-5 py-3">
                  <button type="button" onClick={() => setExpandedId(isOpen ? null : t.id)}
                    aria-expanded={isOpen}
                    className="flex items-start gap-2 flex-1 min-w-0 text-left">
                    <ChevronDown size={12} className={`text-faint mt-1 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-fg">{t.label || 'Unnamed token'}</span>
                        <span className="font-mono text-[12px] text-faint">{t.token_prefix}••••••</span>
                        <Badge tone="outline">{tierInfo?.label || t.permission_level}</Badge>
                        {t.revoked_at && <Badge tone="red">Revoked</Badge>}
                      </div>
                      <p className="text-xs text-faint mt-0.5">
                        {t.revoked_at ? 'Revoked' : t.last_used_at ? `Last used ${fmtDate(t.last_used_at)}` : 'Never used'}
                        {' · '}Created {fmtDate(t.created_at)}
                      </p>
                    </div>
                  </button>
                  {!t.revoked_at && (
                    <Button variant="ghost" size="sm" className="hover:text-[#b42318]" onClick={() => revoke(t.id)} title="Revoke token">
                      Revoke
                    </Button>
                  )}
                </div>
                {isOpen && (
                  <div className="px-5 pb-3 pl-10 -mt-1 text-[13px] text-text">
                    {tierInfo?.hint}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal isOpen={modalOpen} onClose={closeModal} icon={KeyRound} title="Create API token"
        subtitle={<>Issue a scoped token for an AI client on <span className="text-fg font-medium">{projectDomain || 'this project'}</span></>}
        maxWidth="max-w-[520px]"
        footer={justCreated ? (
          <Button variant="primary" onClick={closeModal}>Done</Button>
        ) : !confirmingPassword ? (
          <>
            <Button variant="light" onClick={closeModal}>Cancel</Button>
            <Button type="submit" form="token-form" variant="primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create token'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="light" onClick={() => { setConfirmingPassword(false); setPassword(''); setError(null); }}>Cancel</Button>
            <Button type="submit" form="confirm-form" variant="primary" disabled={verifying || creating}>
              {verifying || creating ? 'Confirming…' : 'Confirm & create'}
            </Button>
          </>
        )}>
        {error && (
          <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">
            {error}
          </div>
        )}

        {justCreated ? (
          <div className="rounded-card px-4 py-4 space-y-3" style={{ background: 'var(--green-tint)', boxShadow: '0 0 0 1px #c6ebd5' }}>
            <p className="text-sm font-medium text-green">
              Token created — shown once, copy it now
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-[12px] text-fg bg-white rounded-control px-3 py-2 overflow-x-auto whitespace-nowrap" style={ring}>
                {justCreated.token}
              </code>
              <CopyButton text={justCreated.token} />
            </div>
            <p className="text-[13px] font-medium text-fg pt-1">Connect with Claude Code</p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 font-mono text-[12px] text-fg bg-white rounded-control px-3 py-2 overflow-x-auto whitespace-pre" style={ring}>
{connectSnippet(justCreated.token)}
              </pre>
              <CopyButton text={connectSnippet(justCreated.token)} />
            </div>
          </div>
        ) : !confirmingPassword ? (
          <form id="token-form" onSubmit={submit} className="space-y-4">
            <Field label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Claude Desktop" maxLength={100} />

            <div>
              <span className="block text-xs font-medium text-fg mb-1.5">Permission level</span>
              <RichSelect block align="left" label="Permission level" value={tier} onChange={setTier}
                options={TIERS.map((t) => ({ value: t.value, label: t.label, description: t.hint }))} />
              <p className="text-xs text-faint mt-1.5">{TIERS.find((t) => t.value === tier)?.hint}</p>
            </div>

            <div className="flex items-start gap-2.5 rounded-control bg-muted px-3.5 py-3 text-[13px] leading-5 text-text">
              <Info size={15} className="shrink-0 text-faint mt-0.5" />
              <span>
                Even a Read Only token sends your analytics data to whichever AI client
                or provider you connect it to — that's inherent to how MCP works, not
                something this app can prevent. Only issue tokens to AI tools you trust
                with this data.
              </span>
            </div>
          </form>
        ) : (
          <form id="confirm-form" onSubmit={confirmPasswordAndCreate} className="rounded-card px-4 py-4 space-y-3" style={{ background: '#fdf3e1', boxShadow: '0 0 0 1px #f3ddb0' }}>
            <p className="text-sm font-medium text-[#8a5300]">
              Confirm your password to create a {TIERS.find((t) => t.value === tier)?.label} token
            </p>
            <Field label="Current password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Current password" required autoFocus autoComplete="current-password" />
          </form>
        )}
      </Modal>
    </SettingsCard>
  );
}
