import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Building2, Compass, Rocket, Trash2, UserCheck } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Modal from '../Modal.jsx';
import Field from '../Field.jsx';
import TransferProjectModal from './TransferProjectModal.jsx';
import StaffProjectControls from './StaffProjectControls.jsx';
import ApprovalRequests from './ApprovalRequests.jsx';
import AccessRequests from './AccessRequests.jsx';
import UnfinishedSignups from './UnfinishedSignups.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import UnderlineTabs from '../settings/UnderlineTabs.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import { plural } from '../../lib/workspace.js';
import WorkspacesView from '../platform/WorkspacesView.jsx';
import InstancesView from '../platform/InstancesView.jsx';
import IndustrySetsView from '../platform/IndustrySetsView.jsx';

// Account settings → Platform: every workspace on app.superrank.si, for the
// SuperRank team only. Search by workspace, owner, project or domain; filter to
// the ones that still need setting up; open any project as support (which is
// logged, so a client can always be told who looked and when).
// Each kind of work has its own page, so it is clear which is which (the ?tab= in the address remembers the page). Get-started requests
// has a second level: the requests waiting on you, and the sign-ups still in progress ('signups' in the address).
const TABS = [
  { key: 'getstarted', label: 'Get-started requests', icon: Rocket },
  { key: 'approvals', label: 'Approvals', icon: UserCheck },
  { key: 'workspaces', label: 'All workspaces', icon: Building2 },
  { key: 'instances', label: 'Agent instances', icon: Bot },
  { key: 'industries', label: 'Industry sets', icon: Compass },
];

export default function PlatformSettings({ onSwitchProject, tab, onTab }) {
  const sub = tab === 'signups' ? 'signups' : 'requests';
  const active = ['trial', 'signups'].includes(tab) ? 'getstarted' : TABS.some((t) => t.key === tab) ? tab : TABS[0].key;
  const navigate = useNavigate();
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);
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

  // The project in the controls drawer, read from the list each time so its access state is the current one after a change.
  const controlsProject = useMemo(() => {
    if (!controlsFor) return null;
    const p = data?.workspaces.flatMap((w) => w.projects).find((x) => x.id === controlsFor.id);
    return { ...controlsFor, ...(p ? { name: p.name, domain: p.domain, access: p.access } : {}) };
  }, [controlsFor, data]);

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

  const actions = {
    opening,
    openSupport: open,
    controls: (p, w, section) => setControlsFor({ id: p.id, name: p.name, domain: p.domain, access: p.access, workspaceName: w.name, section }),
    transfer: (p, w) => setTransferFor({ id: p.id, name: p.name, domain: p.domain, workspaceId: w.id, workspaceName: w.name }),
    deleteWorkspace: askDelete,
  };

  return (
    <>
    <UnderlineTabs tabs={TABS} value={active} onChange={onTab} />
    <div className="mt-5 space-y-3">
      {active === 'getstarted' && (
        <>
          <SegmentedTabs options={[{ value: 'requests', label: 'Requests' }, { value: 'signups', label: 'Sign-ups in progress' }]} value={sub}
            onChange={(v) => onTab(v === 'signups' ? 'signups' : 'getstarted')} />
          {sub === 'signups' ? <UnfinishedSignups /> : <AccessRequests view="requests" />}
        </>
      )}
      {active === 'approvals' && <><ApprovalRequests /><AccessRequests view="hold" /></>}
      {active === 'workspaces' && <SettingsCard icon={Building2} title="All workspaces"
        description="Every workspace on SuperRank. Open a workspace to see its projects.">
        {error && <div className="px-5 py-4 text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</div>}
        {!error && data === null && <div className="px-5 py-8"><div className="h-5 bg-muted rounded-control animate-pulse" /></div>}
        {data && <WorkspacesView workspaces={data.workspaces} actions={actions} />}
      </SettingsCard>}
      {active === 'instances' && <InstancesView actions={actions} />}
      {active === 'industries' && <IndustrySetsView />}
      <Modal isOpen={!!deleting} onClose={() => !delBusy && setDeleting(null)} icon={Trash2} title="Delete workspace"
        subtitle={deleting ? <>This removes <span className="text-fg font-medium">{deleting.name}</span> and its {plural(deleting.projects.length, 'project', 'projects')}. Its people lose access. The data is kept, so we can restore it if asked.</> : null}
        footer={<><Button variant="light" onClick={() => setDeleting(null)} disabled={delBusy}>Cancel</Button>
          <button type="button" className="btn" style={{ background: '#d92d20', color: '#fff', opacity: typed.trim() === deleting?.name && !delBusy ? 1 : 0.5 }}
            disabled={typed.trim() !== deleting?.name || delBusy} onClick={doDelete}>{delBusy ? 'Deleting…' : 'Delete workspace'}</button></>}>
        <Field label={deleting ? `Type "${deleting.name}" to confirm` : 'Confirm'} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        {delError && <p className="mt-3 text-[13px]" style={{ color: '#b42318' }} role="alert">{delError}</p>}
      </Modal>
      <StaffProjectControls project={controlsProject} section={controlsFor?.section} isOpen={!!controlsFor} onClose={() => setControlsFor(null)} onChanged={loadAll} />
      <TransferProjectModal project={transferFor} isOpen={!!transferFor} onClose={() => setTransferFor(null)}
        onDone={async () => { setTransferFor(null); await loadAll(); }} />
    </div>
    </>
  );
}
