import { useEffect, useState } from 'react';
import { PauseCircle, PlayCircle, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';

// SuperRank staff only (Account settings -> Platform). The per-project controls the old Clients drawer
// held and the new Platform view had lost: suspend / reactivate / delete, the autonomous-fixes switch,
// and the analytics IDs the install generator writes. Every call is platform_admin on the server too.
export default function StaffProjectControls({ project, isOpen, onClose, onChanged }) {
  const [row, setRow] = useState(null);
  const [auto, setAuto] = useState(false);
  const [limit, setLimit] = useState(60);
  const [ga4, setGa4] = useState('');
  const [pixel, setPixel] = useState('');
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState('');

  useEffect(() => {
    if (!isOpen || !project) return;
    setRow(null); setError(null); setNote(null); setConfirmDelete('');
    api.clients.list().then((all) => {
      const r = all.find((c) => c.id === project.id);
      setRow(r || null);
      setAuto(!!r?.autoRemediationEnabled); setLimit(r?.autoRemediationDailyLimit ?? 60);
      setGa4(r?.ga4MeasurementId || ''); setPixel(r?.facebookPixelId || '');
    }).catch((e) => setError(e.message || 'Could not load this project.'));
  }, [isOpen, project?.id]);

  const run = async (key, fn, done) => {
    setBusy(key); setError(null); setNote(null);
    try { await fn(); setNote(done); await onChanged?.(); } catch (e) { setError(e.message || 'That did not work.'); } finally { setBusy(null); }
  };
  const status = row?.status || 'active';

  return (
    <Modal isOpen={isOpen} onClose={onClose} icon={ShieldAlert} title="Staff controls" maxWidth="max-w-[520px]"
      subtitle={<span className="text-fg font-medium">{project?.name}</span>} footer={<Button variant="light" onClick={onClose}>Close</Button>}>
      {error && <p className="text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</p>}
      {note && <p className="text-[13px] text-text" role="status">{note}</p>}
      {!row && !error && <div className="h-16 bg-muted rounded-card animate-pulse" />}
      {row && (
        <div className="space-y-5">
          <section>
            <div className="text-[13px] font-medium text-fg mb-1.5">Status: {status === 'active' ? 'Active' : status === 'suspended' ? 'Suspended' : 'Deleted'}</div>
            <div className="flex flex-wrap gap-2">
              {status === 'active' && <Button variant="light" disabled={busy === 'sus'} onClick={() => run('sus', () => api.clients.suspend(row.id), 'Suspended. Its jobs stop; nothing is deleted.')}><PauseCircle size={14} />Suspend</Button>}
              {status !== 'active' && <Button variant="light" disabled={busy === 'rea'} onClick={() => run('rea', () => api.clients.reactivate(row.id), 'Reactivated.')}><PlayCircle size={14} />Reactivate</Button>}
            </div>
          </section>
          <section>
            <div className="text-[13px] font-medium text-fg mb-1.5">Autonomous fixes</div>
            <label className="flex items-center gap-2 text-[13px] text-text">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Let the agent open fix pull requests
            </label>
            <div className="mt-2 flex items-end gap-2">
              <div className="w-28"><Field label="Daily limit" type="number" min="0" max="100" value={limit} onChange={(e) => setLimit(e.target.value)} /></div>
              <Button variant="light" disabled={busy === 'auto'} onClick={() => run('auto', () => api.clients.setAutoRemediation(row.id, auto, Number(limit)), 'Saved.')}>Save</Button>
            </div>
          </section>
          <section>
            <div className="text-[13px] font-medium text-fg mb-1.5">Analytics IDs</div>
            <div className="grid sm:grid-cols-2 gap-2">
              <Field label="GA4 Measurement ID" value={ga4} onChange={(e) => setGa4(e.target.value)} placeholder="G-XXXXXXXXXX" />
              <Field label="Meta Pixel ID" value={pixel} onChange={(e) => setPixel(e.target.value)} placeholder="1234567890" />
            </div>
            <div className="mt-2"><Button variant="light" disabled={busy === 'ids'} onClick={() => run('ids', () => api.clients.setAnalyticsIds(row.id, ga4.trim(), pixel.trim()), 'Saved.')}>Save IDs</Button></div>
          </section>
          {status !== 'soft_deleted' && (
            <section>
              <div className="text-[13px] font-medium text-fg mb-1.5">Delete project</div>
              <p className="text-xs text-faint mb-2">Hides it and stops everything. Type its name to confirm.</p>
              <div className="flex items-end gap-2">
                <div className="flex-1"><Field label="Project name" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={row.name} /></div>
                <Button variant="light" disabled={busy === 'del' || confirmDelete.trim() !== row.name}
                  onClick={() => run('del', () => api.clients.softDelete(row.id), 'Deleted.')}><Trash2 size={14} />Delete</Button>
              </div>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
