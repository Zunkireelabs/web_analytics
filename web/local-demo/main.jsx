import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LivePreview from '../src/components/LivePreview.jsx';
import '../src/index.css';

// A picker of example drafts (one or two per client) and the real LivePreview component: click a part of the page, say what to change or edit the text, save.
function Demo() {
  const [index, setIndex] = useState(null);
  const [picked, setPicked] = useState(null);
  const load = () => fetch('/api/demo/index').then((r) => r.json()).then((d) => { setIndex(d); if (!picked) setPicked(d.drafts[0]); });
  useEffect(() => { load(); }, []);
  if (!index) return <div className="p-6 text-sm">Loading…</div>;
  return (
    <div className="max-w-[1500px] mx-auto p-5 space-y-4">
      <div className="rounded-control border border-border bg-white p-4 text-[13px] space-y-1">
        <div className="text-sm font-medium">Local check: draft preview and click-to-edit</div>
        <div>Pick an example draft. Click any part of the page (or a part in the chip list), then say what to change, or edit the text yourself. Nothing here touches a real client or the production database.</div>
        <div>AI rewrites: <b>{index.ai}</b>. {index.ai === 'off' ? 'Typing your own text works; "Change it" will say the writing assistant is offline. Restart with DEMO_AI=claude to let it rewrite with your Claude Code.' : ''}</div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-sm">Example draft</label>
        <select className="rounded-control border border-border px-3 py-2 text-sm bg-white" value={picked?.id} onChange={(e) => setPicked(index.drafts.find((d) => String(d.id) === e.target.value))}>
          {index.drafts.map((d) => <option key={d.id} value={d.id}>{d.client}: {d.title}</option>)}
        </select>
        <button type="button" className="btn btn--light" onClick={() => fetch('/api/demo/reset', { method: 'POST' }).then(() => { setPicked({ ...picked }); load(); })}>Reset all examples</button>
      </div>
      {picked && <LivePreview key={`${picked.id}-${picked.nonce || 0}`} draftId={picked.id} siteId={picked.siteId} onSaved={() => {}} />}
    </div>
  );
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Demo /></React.StrictMode>);
