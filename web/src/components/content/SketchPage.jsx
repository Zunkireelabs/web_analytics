import { useEffect, useMemo, useState } from 'react';
import InteractivePage from '../InteractivePage.jsx';
import { makeInteractiveSketch } from '../../lib/sketch-parts.js';

// An idea's sketch drawn in the client's own design, with every part touchable: the touched part is outlined and a small box opens right next to it
// (`renderBox`), the same way as the real-page drawing. The sketch only ever shows what the server drew; nothing here changes it.
export default function SketchPage({ html, url, title, selected = null, onSelect = null, onParts = null, renderBox = null }) {
  const [view, setView] = useState('desktop');
  const prepared = useMemo(() => makeInteractiveSketch(html), [html]);
  useEffect(() => { onParts?.(prepared.parts); }, [prepared]); // eslint-disable-line react-hooks/exhaustive-deps
  const phone = view === 'mobile';
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[13px] text-faint">How it will look on your site. Select any words to change them.</span>
        <div className="toggle ml-auto" role="tablist" aria-label="Screen size">
          {['desktop', 'mobile'].map((d) => <button key={d} type="button" role="tab" aria-selected={view === d} className={view === d ? 'is-on' : ''} onClick={() => setView(d)}>{d === 'desktop' ? 'Desktop' : 'Mobile'}</button>)}
        </div>
      </div>
      <InteractivePage html={prepared.html} phone={phone} title={title || 'Preview'} selected={selected} onSelect={onSelect} renderBox={renderBox} selectMode />
      {url && <div className="mt-2 text-xs text-faint">{url}</div>}
    </div>
  );
}
