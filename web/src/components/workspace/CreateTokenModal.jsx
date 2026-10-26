import { useState } from 'react';
import { KeyRound, Copy, Check, Info } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import ChoiceCard from './ChoiceCard.jsx';

// Plain names over the four MCP permission levels (mcp-server/permissions.js).
export const TOKEN_TIERS = [
  { value: 'read_only', label: 'View only', short: 'Read only', hint: 'Can read reports and analytics. Cannot change anything.' },
  { value: 'ai_actions', label: 'View and draft', short: 'AI actions', hint: 'Can also run agents and write drafts. No access to your code.' },
  { value: 'automation', label: 'Open pull requests', short: 'Automation', hint: 'Can also push branches and open pull requests. Never merges by itself.', highTier: true },
  { value: 'admin', label: 'Full admin', short: 'Admin', hint: 'Can also create and revoke tokens. Use with care.', highTier: true },
];

function connectSnippet(token) {
  const origin = import.meta.env.VITE_MCP_ORIGIN || (typeof window !== 'undefined' ? window.location.origin : '');
  return `claude mcp add --transport http superrank ${origin}/api/mcp \\\n  --header "Authorization: Bearer ${token}"`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="light" size="sm" className="shrink-0"
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

const ring = { boxShadow: '0 0 0 1px var(--input)' };

// Create an API token for one project of the workspace. Automation and Full admin
// ask for the account password first (same speed bump as before).
export default function CreateTokenModal({ projects = [], where, createToken, isOpen, onClose, onCreated }) {
  const [label, setLabel] = useState('');
  const [siteId, setSiteId] = useState('');
  const [tier, setTier] = useState('read_only');
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const chosenSite = siteId || String(projects[0]?.id || '');

  const close = () => { setLabel(''); setSiteId(''); setTier('read_only'); setConfirming(false); setPassword(''); setError(null); setCreated(null); setBusy(false); onClose(); };

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const token = await createToken({ siteId: Number(chosenSite), label: label.trim() || null, permissionLevel: tier });
      setCreated(token); setConfirming(false); setPassword('');
      await onCreated?.();
    } catch (err) { setError(err.message || 'Could not create the token.'); }
    setBusy(false);
  };
  const submit = (e) => { e.preventDefault(); if (TOKEN_TIERS.find((t) => t.value === tier)?.highTier && !confirming) { setConfirming(true); return; } create(); };
  const confirmPassword = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.verifyPassword(password); } catch (err) { setError(err.message || 'That password is not right.'); setBusy(false); return; }
    await create();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} icon={KeyRound} title="Create API token" maxWidth="max-w-[520px]"
      subtitle={projects.length === 1 ? <>For <span className="text-fg font-medium">{projects[0].name}</span></> : <>For a project in <span className="text-fg font-medium">{where}</span></>}
      footer={created ? <Button variant="primary" onClick={close}>Done</Button> : confirming ? (
        <><Button variant="light" onClick={() => { setConfirming(false); setPassword(''); setError(null); }}>Back</Button>
          <Button type="submit" form="token-confirm" variant="primary" disabled={busy}>{busy ? 'Confirming…' : 'Confirm and create'}</Button></>
      ) : (
        <><Button variant="light" onClick={close}>Cancel</Button>
          <Button type="submit" form="token-form" variant="primary" disabled={busy || !chosenSite}>{busy ? 'Creating…' : 'Create token'}</Button></>
      )}>
      {error && <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2">{error}</div>}
      {created ? (
        <div className="rounded-card px-4 py-4 space-y-3" style={{ background: 'var(--green-tint)', boxShadow: '0 0 0 1px #c6ebd5' }}>
          <p className="text-sm font-medium text-green">Token created. It is shown once, so copy it now.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[12px] text-fg bg-white rounded-control px-3 py-2 overflow-x-auto whitespace-nowrap" style={ring}>{created.token}</code>
            <CopyButton text={created.token} />
          </div>
          <p className="text-[13px] font-medium text-fg pt-1">Connect with Claude Code</p>
          <div className="flex items-start gap-2">
            <pre className="flex-1 font-mono text-[12px] text-fg bg-white rounded-control px-3 py-2 overflow-x-auto whitespace-pre" style={ring}>{connectSnippet(created.token)}</pre>
            <CopyButton text={connectSnippet(created.token)} />
          </div>
        </div>
      ) : confirming ? (
        <form id="token-confirm" onSubmit={confirmPassword} className="rounded-card px-4 py-4 space-y-3" style={{ background: '#fdf3e1', boxShadow: '0 0 0 1px #f3ddb0' }}>
          <p className="text-sm font-medium text-[#8a5300]">Confirm your password to create a “{TOKEN_TIERS.find((t) => t.value === tier)?.label}” token</p>
          <Field label="Current password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="current-password" />
        </form>
      ) : (
        <form id="token-form" onSubmit={submit} className="space-y-4">
          <Field label="Token name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Claude Desktop" maxLength={100} hint="So you can tell your tokens apart later." />
          {projects.length > 1 && <Field as="select" label="Project" value={chosenSite} onChange={(e) => setSiteId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Field>}
          <div>
            <div className="text-[13px] font-medium text-fg mb-2">What can it do?</div>
            <div role="radiogroup" className="space-y-2">
              {TOKEN_TIERS.map((t) => <ChoiceCard key={t.value} selected={tier === t.value} onSelect={() => setTier(t.value)} title={t.label} description={t.hint} />)}
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
            <Info size={15} className="text-faint shrink-0 mt-0.5" />
            <span>The token is shown once, right after you create it. Even a View only token sends your analytics data to the AI tool you connect, so only give tokens to tools you trust.</span>
          </div>
        </form>
      )}
    </Modal>
  );
}
