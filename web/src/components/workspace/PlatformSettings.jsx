import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, Building2, ChevronRight, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import Modal from '../Modal.jsx';
import Field from '../Field.jsx';
import TransferProjectModal from './TransferProjectModal.jsx';
import StaffProjectControls from './StaffProjectControls.jsx';
import ApprovalRequests from './ApprovalRequests.jsx';
import AccessRequests from './AccessRequests.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import { plural } from '../../lib/workspace.js';
import { siteDomain, siteInitials } from '../../lib/nav.js';

const inputRing = { boxShadow: '0 0 0 1px var(--input)' };

// Account settings → Platform: every workspace on app.superrank.si, for the
// SuperRank team only. Search by workspace, owner, project or domain; filter to
// the ones that still need setting up; open any project as support (which is
// logged, so a client can always be told who looked and when).
export default function PlatformSettings({ onSwitchProject }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [onlySetup, setOnlySetup] = useState(false);
  const [opening, setOpening] = useState(null);
  const [controlsFor, setControlsFor] = useState(null); // the project whose staff controls are open
  const [transferFor, setTransferFor] = useState(null); // the project whose transfer dialog is open
  const [deleting, setDeleting] = useState(null); // the workspace whose delete dialog is open
  const [typed, setTyped] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState(null);
  const askDelete = (w) => { setDeleting(w); setTyped(''); setDelError(null); };
  const doDelete = async () => {
    setDelBusy(true); setDelError(null);
    try { await api.platform.deleteWorkspace(deleting.id, typed.trim()); setDeleting(null); await loadAll(); }
    catch (e) { setDelError(e.message || 'Could not delete the workspace.'); }
    finally { setDelBusy(false); }
  };
  const loadAll = () => api.platform.workspaces().then(setData).catch((e) => setError(e.message || 'Could not load the workspaces.'));

  useEffect(() => {
    api.platform.workspaces().then(setData).catch((e) => setError(e.message || 'Could not load the workspaces.'));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.workspaces || []).filter((w) => {
      if (onlySetup && !w.needsSetup) return false;
      if (!q) return true;
      return w.name.toLowerCase().includes(q)
        || w.owners.some((o) => o.toLowerCase().includes(q))
        || w.projects.some((p) => p.name.toLowerCase().includes(q) || (p.domain || '').toLowerCase().includes(q));
    });
  }, [data, query, onlySetup]);

  const open = async (project) => {
    setOpening(project.id);
    try {
      await api.platform.supportView(project.id); // log first: a view that can't be recorded isn't made
      await onSwitchProject(project.id);
      navigate('/overview');
    } catch (e) {
      setError(e.message || 'Could not open that project.');
      setOpening(null);
    }
  };

  return (
    <div className="mt-5 space-y-3">
      <AccessRequests />
      <ApprovalRequests />
      <SettingsCard icon={Building2} title="All workspaces"
        description={data ? `${plural(data.totals.workspaces, 'workspace', 'workspaces')} · ${plural(data.totals.projects, 'project', 'projects')}${data.totals.needsSetup ? ` · ${data.totals.needsSetup} still to set up` : ''}` : 'Every workspace on the platform.'}>
        <div className="px-4 sm:px-5 py-3 border-b border-border flex flex-wrap items-center gap-2">
          <div className="relative basis-full sm:basis-auto sm:flex-1 sm:max-w-[320px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspace, owner, project or domain" aria-label="Search workspaces"
              className="h-8 w-full pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={inputRing} />
          </div>
          <button type="button" aria-pressed={onlySetup} onClick={() => setOnlySetup((v) => !v)}
            className={`h-8 px-2.5 rounded-control text-[13px] inline-flex items-center gap-1.5 ${onlySetup ? 'bg-primary-tint text-primary' : 'bg-white text-text'}`}
            style={onlySetup ? { boxShadow: 'inset 0 0 0 1px var(--primary-ring)' } : inputRing}>
            <AlertTriangle size={13} />Needs setup
          </button>
        </div>

        {error && <div className="px-5 py-4 text-[13px]" style={{ color: '#b42318' }}>{error}</div>}
        {!error && data === null && <div className="px-5 py-8"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>}
        {data && shown.length === 0 && <div className="px-5 py-8 text-center text-[13px] text-faint">No workspace matches.</div>}

        {shown.map((w) => (
          <div key={w.id} className="px-4 sm:px-5 py-3.5 border-b border-border last:border-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-6 h-6 rounded-[7px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={13} /></span>
              <b className="text-[14px] font-semibold text-fg">{w.name}</b>
              <span className="text-xs text-faint">{plural(w.projects.length, 'project', 'projects')} · {plural(w.memberCount, 'person', 'people')}</span>
              {w.needsSetup > 0 && <Badge tone="amber">{w.needsSetup} to set up</Badge>}
              <span className="text-xs text-faint sm:ml-auto truncate max-w-full">{w.owners.length ? `Owner: ${w.owners.join(', ')}` : 'No owner'}</span>
              <button type="button" onClick={() => askDelete(w)} aria-label={`Delete workspace ${w.name}`} title="Delete workspace"
                className="h-7 w-7 rounded-control grid place-items-center text-faint hover:text-[#b42318] hover:bg-[#fdecec]"><Trash2 size={14} /></button>
            </div>
            {w.projects.length > 0 && (
              <div className="mt-2.5 grid gap-1.5 sm:pl-9">
                {w.projects.map((p) => (
                  <div key={p.id} className="flex items-center gap-2.5 rounded-control bg-white px-2.5 py-2" style={inputRing}>
                    <span className="w-6 h-6 rounded-[7px] bg-primary text-white text-[9px] font-medium grid place-items-center shrink-0">{siteInitials(p.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-fg truncate">{p.name}</span>
                      <span className="block text-xs text-faint truncate">{siteDomain({ website_domain: p.domain }) || 'No website set'}</span>
                    </span>
                    {p.missing.length > 0
                      ? <span className="hidden sm:block text-xs text-right max-w-[280px]" style={{ color: '#8a5300' }} title={`Missing: ${p.missing.join(', ')}`}>Missing: {p.missing.join(', ')}</span>
                      : <Badge tone="green">Set up</Badge>}
                    <Button variant="light" size="sm" onClick={() => setControlsFor({ id: p.id, name: p.name })}>
                      <SlidersHorizontal size={13} />Controls
                    </Button>
                    <Button variant="light" size="sm" onClick={() => setTransferFor({ id: p.id, name: p.name, domain: p.domain, workspaceId: w.id, workspaceName: w.name })}>
                      <ArrowLeftRight size={13} />Transfer
                    </Button>
                    <Button variant="light" size="sm" onClick={() => open(p)} disabled={opening === p.id}>
                      {opening === p.id ? 'Opening…' : <>Open as support<ChevronRight size={13} /></>}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </SettingsCard>
      <Modal isOpen={!!deleting} onClose={() => !delBusy && setDeleting(null)} icon={Trash2} title="Delete workspace"
        subtitle={deleting ? <>This removes <span className="text-fg font-medium">{deleting.name}</span> and its {plural(deleting.projects.length, 'project', 'projects')}. Its people lose access. The data is kept, so we can restore it if asked.</> : null}
        footer={<><Button variant="light" onClick={() => setDeleting(null)} disabled={delBusy}>Cancel</Button>
          <button type="button" className="btn" style={{ background: '#d92d20', color: '#fff', opacity: typed.trim() === deleting?.name && !delBusy ? 1 : 0.5 }}
            disabled={typed.trim() !== deleting?.name || delBusy} onClick={doDelete}>{delBusy ? 'Deleting…' : 'Delete workspace'}</button></>}>
        <Field label={deleting ? `Type "${deleting.name}" to confirm` : 'Confirm'} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        {delError && <p className="mt-3 text-[13px]" style={{ color: '#b42318' }} role="alert">{delError}</p>}
      </Modal>
      <StaffProjectControls project={controlsFor} isOpen={!!controlsFor} onClose={() => setControlsFor(null)} onChanged={loadAll} />
      <TransferProjectModal project={transferFor} isOpen={!!transferFor} onClose={() => setTransferFor(null)}
        onDone={async () => { setTransferFor(null); await loadAll(); }} />
    </div>
  );
}
