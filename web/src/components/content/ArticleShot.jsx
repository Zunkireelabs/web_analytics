import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import InteractivePage from '../InteractivePage.jsx';

// A blog option drawn inside a REAL article page of the client's own site (its header, fonts, spacing and footer), as pictures at desktop and phone width.
// The server draws it on demand (it opens a real browser), so this loads when the option is shown. When the site has no captured article page, or the drawing
// fails, it says why and shows the sketch (`fallback`) instead, so the client is never shown a lookalike as if it were the real thing.
export default function ArticleShot({ option, title, siteId, fallback, generatorId = 'blog-outline', url = '', onParts = null, onPart = null, selectedPart = null, renderBox = null }) {
  const [state, setState] = useState('loading'); // 'loading' | { ok:true, ... } | { ok:false, error }
  const [view, setView] = useState('desktop');
  useEffect(() => {
    let alive = true;
    setState('loading');
    api.actionCenter.blogOptionPreview(option, title, siteId, generatorId, url)
      .then((r) => { if (alive) setState(r); })
      .catch((e) => { if (alive) setState({ ok: false, error: e?.message || 'The page could not be drawn.' }); });
    return () => { alive = false; };
  }, [option, title, siteId, generatorId, url]);

  // The parts of the page a person can click (the server lists them); a click is reported to the panel, and the panel can highlight one.
  useEffect(() => { if (state && state !== 'loading' && state.ok && state.parts) onParts?.(state.parts); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state === 'loading') return <div className="rounded-card bg-muted px-5 py-16 text-center text-sm text-text">Drawing this option in your site’s own page…</div>;
  if (!state.ok) {
    return (
      <div>
        <div className="mb-3 rounded-control px-3.5 py-2.5 text-[13px]" style={{ background: '#fff6e5', color: '#8a5a00' }}>
          Could not draw this in your site’s real page: {state.error} Showing a general sketch instead.
        </div>
        {fallback}
      </div>
    );
  }
  if (state.html) {
    const phone = view === 'mobile';
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[13px] text-faint">How it will look on your site</span>
          <div className="toggle ml-auto" role="tablist" aria-label="Screen size">
            <button type="button" role="tab" aria-selected={!phone} className={!phone ? 'is-on' : ''} onClick={() => setView('desktop')}>Desktop</button>
            <button type="button" role="tab" aria-selected={phone} className={phone ? 'is-on' : ''} onClick={() => setView('mobile')}>Phone</button>
          </div>
        </div>
        <InteractivePage html={state.html} phone={phone} title="Option drawn inside your site's page" selected={selectedPart} onSelect={onPart} renderBox={renderBox} selectMode />
        <a className="mt-2 inline-block text-xs underline text-faint" href={/^https?:\/\//i.test(state.referenceUrl || '') ? state.referenceUrl : undefined} target="_blank" rel="noreferrer">Drawn inside this page of your site</a>
      </div>
    );
  }
  const shot = state.shots.find((s) => s.viewport === view) || state.shots[0];
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[13px] text-faint">How it will look on your site</span>
        <div className="toggle ml-auto" role="tablist" aria-label="Screen size">
          {state.shots.map((s) => <button key={s.viewport} type="button" role="tab" aria-selected={s.viewport === shot.viewport} className={s.viewport === shot.viewport ? 'is-on' : ''} onClick={() => setView(s.viewport)}>{s.viewport === 'mobile' ? 'Mobile' : 'Desktop'}</button>)}
        </div>
      </div>
      <div className="rounded-[12px] border border-border overflow-auto bg-white" style={{ maxHeight: '64vh' }}>
        <img src={`data:image/png;base64,${shot.png}`} alt={`Option drawn inside your site's page, ${shot.viewport} width`}
          style={{ width: shot.viewport === 'mobile' ? 390 : '100%', maxWidth: '100%', display: 'block', margin: shot.viewport === 'mobile' ? '0 auto' : 0 }} />
      </div>
      <a className="mt-2 inline-block text-xs underline text-faint" href={/^https?:\/\//i.test(state.referenceUrl || '') ? state.referenceUrl : undefined} target="_blank" rel="noreferrer">Drawn inside this page of your site</a>
    </div>
  );
}
