import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Field from '../Field.jsx';

// Where a LOCAL business works. Optional, and only worth filling in if customers come from a particular town: it makes
// research, recommendations and the content we draft about THAT town instead of the whole country.
//
// Two fields, because the order matters and two fields make it unmistakable: where you are based first, then the
// places around it. Uses the app's own Field and Button.

export default function PlacesFields({ siteId }) {
  const [loaded, setLoaded] = useState(false);
  const [primary, setPrimary] = useState('');
  const [nearby, setNearby] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    api.project.places.get(siteId)
      .then((res) => { if (!alive) return; setPrimary(res.primary || ''); setNearby((res.nearby || []).join(', ')); setLoaded(true); })
      .catch(() => { if (alive) { setError('Could not load this right now.'); setLoaded(true); } });
    return () => { alive = false; };
  }, [siteId]);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const res = await api.project.places.save(siteId, {
        primary: primary.trim(),
        nearby: nearby.split(',').map((n) => n.trim()).filter(Boolean),
      });
      setPrimary(res.primary); setNearby(res.nearby.join(', ')); setSaved(true);
    } catch (e) { setError(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }

  if (!loaded) return <div className="px-5 py-4 text-sm text-faint">Loading…</div>;

  return (
    <div className="px-5 py-4 space-y-4">
      <p className="text-[13px] leading-relaxed">
        If your customers come from a particular town, say so. We then research and write for that town and the places
        around it, instead of the whole country. <span className="text-faint">Skip this if you serve everywhere.</span>
      </p>
      <Field
        label="Where you are based"
        value={primary}
        onChange={(e) => { setPrimary(e.target.value); setSaved(false); }}
        placeholder="e.g. Northampton"
        maxLength={60}
      />
      <Field
        label="Nearby places you also serve"
        value={nearby}
        onChange={(e) => { setNearby(e.target.value); setSaved(false); }}
        placeholder="e.g. Wellingborough, Daventry, Kettering"
        hint="Separate with commas. List the closest first — they are looked at in this order."
      />
      {error && <div className="rounded-card bg-[#fdecec] border border-[#f3c6c6] text-[#b42318] text-sm px-4 py-3">{error}</div>}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save places'}</Button>
        {saved && <span className="text-[13px] text-faint">Saved.</span>}
      </div>
    </div>
  );
}
