import { useState } from 'react';
import { api } from '../api.js';
import Button from './Button.jsx';
import { STATUS } from '../lib/palette.js';

// What a blog draft will look like: the draft's text put into a real article page of this client's site (its own header, fonts, spacing and footer), shown at
// desktop and phone width. Read-only and on demand, since it opens a real browser on the server. Deviations from the site's own articles are listed
// in plain words so a flat-looking render is never mistaken for a good one.
const DEVIATION_TEXT = {
  'heading-scale': 'Heading size differs from the site’s own articles',
  'line-height': 'Line spacing differs from the site’s own articles',
  'heading-rule': 'The line under headings differs from the site’s own articles',
  'paragraph-gap': 'Space between paragraphs differs from the site’s own articles',
  'line-length': 'Line length differs from the site’s own articles',
  'horizontal-overflow': 'The page scrolls sideways at this width',
};
const describe = (d) => `${DEVIATION_TEXT[d.kind] || d.kind} (${d.viewport}${d.expected != null ? `: site ${d.expected}, draft ${d.actual}` : ''})`;

export default function ArticlePreview({ draftId, siteId }) {
  const [state, setState] = useState(null); // null | 'loading' | { ok:true, ... } | { ok:false, error }
  const [view, setView] = useState('desktop');

  async function load() {
    setState('loading');
    try { setState(await api.actionCenter.articlePreview(draftId, siteId)); }
    catch (e) { setState({ ok: false, error: e.message || 'The preview could not be drawn.' }); }
  }

  const shot = state && state.ok ? state.shots.find((s) => s.viewport === view) || state.shots[0] : null;
  return (
    <div className="pt-5 border-t border-border space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-fg">See it on the site</div>
          <div className="text-xs text-fg-muted">Your draft inside a real article page of this site, at desktop and phone width.</div>
        </div>
        <Button variant="light" onClick={load} disabled={state === 'loading'}>{state === 'loading' ? 'Drawing the page…' : state ? 'Redraw' : 'Show preview'}</Button>
      </div>

      {state && state !== 'loading' && !state.ok && (
        <div className="rounded-control px-3.5 py-3 text-[13px]" style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>{state.error}</div>
      )}

      {shot && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {state.shots.map((s) => (
              <Button key={s.viewport} size="sm" variant={s.viewport === shot.viewport ? 'dark' : 'light'} onClick={() => setView(s.viewport)}>
                {s.viewport === 'mobile' ? 'Phone' : 'Desktop'}
              </Button>
            ))}
            <span className="text-xs text-fg-muted ml-auto">{state.matchesSiteDesign ? 'Matches the site’s own articles' : 'Differs from the site’s own articles'}</span>
          </div>
          {!state.matchesSiteDesign && state.deviations?.length > 0 && (
            <ul className="rounded-control px-3.5 py-3 text-[13px] space-y-1 list-disc pl-6" style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>
              {state.deviations.map((d, i) => <li key={i}>{describe(d)}</li>)}
            </ul>
          )}
          <div className="rounded-control border border-border overflow-auto max-h-[70vh] bg-white">
            <img
              src={`data:image/png;base64,${shot.png}`}
              alt={`Draft shown inside the site's article page, ${shot.viewport} width`}
              style={{ width: shot.viewport === 'mobile' ? 390 : '100%', maxWidth: '100%', display: 'block', margin: shot.viewport === 'mobile' ? '0 auto' : 0 }}
            />
          </div>
          <a className="text-xs underline text-fg-muted" href={state.referenceUrl} target="_blank" rel="noreferrer">Based on this article of the site</a>
        </div>
      )}
    </div>
  );
}
