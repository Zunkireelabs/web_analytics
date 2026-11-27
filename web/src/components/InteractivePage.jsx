import { useEffect, useRef, useState } from 'react';

// A captured page of the client's site that can be edited in place. Two modes, same box:
//
//   selectMode (ideas): the person selects the words THEY want changed with the mouse, exactly as they would to copy them. A small box opens right BELOW the selection; they type what to
//     change and press Enter. Clicking anywhere else (or Esc) closes it. Nothing is outlined or opened by merely clicking the page. `renderBox({ id, text, close })` draws the box:
//     `text` is the selected words, `id` the part of the page they are in.
//   otherwise (drafts): touching a part of the page outlines it and opens the box right below it; `selected` lets the caller select a part from outside.
const DESKTOP_WIDTH = 1200;

export default function InteractivePage({ html, phone = false, title = 'Page', selected = null, onSelect = null, renderBox = null, selectMode = false }) {
  const frame = useRef(null);
  const wrap = useRef(null);
  const boxRef = useRef(null);
  const [height, setHeight] = useState(700);
  const [avail, setAvail] = useState(0); // width of the panel the page is shown in
  const [sel, setSel] = useState(null); // { id, rect, text }
  const selRef = useRef(null); selRef.current = sel;
  const closeRef = useRef(null);
  const outer = useRef(null);
  useEffect(() => {
    const el = outer.current; if (!el) return undefined;
    const fit = () => setAvail(el.clientWidth || 0);
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data;
      if (d?.type === 'preview-height' && d.height) setHeight(Math.min(30000, Math.max(300, Math.ceil(d.height))));
      if (selectMode) {
        if (d?.type === 'draft-text-select' && d.text && d.rect) { setSel({ id: d.blockId || null, rect: d.rect, text: d.text }); onSelect?.(d.blockId || null); }
        if (d?.type === 'draft-text-clear') { if (selRef.current) { setSel(null); onSelect?.(null); } }
        return;
      }
      if (d?.type === 'draft-block-click' && d.id) { setSel({ id: d.id, rect: d.rect }); onSelect?.(d.id); }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect, selectMode]);

  useEffect(() => {
    if (selectMode) return;
    if (selected && selected !== sel?.id) frame.current?.contentWindow?.postMessage({ type: 'select-block', id: selected }, '*');
    if (!selected && sel) { setSel(null); frame.current?.contentWindow?.postMessage({ type: 'clear-block' }, '*'); }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (sel) boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [sel?.rect?.top, sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setSel(null); onSelect?.(null);
    const w = frame.current?.contentWindow;
    w?.postMessage({ type: 'clear-block' }, '*');
    w?.postMessage({ type: 'clear-text' }, '*');
  };
  closeRef.current = close;

  // In select mode the box lives until the person clicks elsewhere (outside the box, on the rest of the panel) or presses Esc. A click inside the page itself is reported by the page
  // (it collapses the selection), so it closes the box too.
  useEffect(() => {
    if (!selectMode || !sel) return undefined;
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) closeRef.current?.(); };
    const esc = (e) => { if (e.key === 'Escape') closeRef.current?.(); };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc); };
  }, [selectMode, !!sel]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page is always drawn at a real screen width (desktop 1200px, phone 390px) and scaled to fit the panel, so a narrow panel never makes the site switch to its own mobile layout.
  const natural = phone ? 390 : DESKTOP_WIDTH;
  const scale = phone || !avail ? 1 : Math.min(1, avail / natural);
  const shownWidth = phone ? natural : Math.round(natural * scale);
  const boxWidth = Math.min(520, (avail || 520) - 16);
  const at = sel?.rect ? { left: sel.rect.left * scale, top: sel.rect.top * scale, height: sel.rect.height * scale } : null;
  const left = at ? Math.max(8, Math.min(at.left, shownWidth - boxWidth - 8)) : 8;
  return (
    <div ref={outer} className="rounded-control border border-border bg-white overflow-hidden">
      <div ref={wrap} style={{ position: 'relative', width: shownWidth, height: Math.ceil(height * scale), maxWidth: '100%', margin: phone ? '0 auto' : 0 }}>
        <iframe ref={frame} title={title} sandbox="allow-scripts" srcDoc={html} scrolling="no"
          style={{ width: natural, height, border: 0, display: 'block', transformOrigin: '0 0', transform: scale === 1 ? undefined : `scale(${scale})` }} />
        {at && renderBox && (
          <div ref={boxRef} style={{ position: 'absolute', left, top: at.top + at.height + 10, width: boxWidth, zIndex: 10 }} className="rounded-control border border-border bg-white shadow-lg p-4">
            {renderBox({ id: sel.id, text: sel.text || '', close: () => {
              // The box that was opened for THIS selection closes only this selection: a request that finishes after the person selected other words must not close the new box.
              const cur = selRef.current;
              if (!cur || (cur.id === sel.id && (cur.text || '') === (sel.text || ''))) close();
            } })}
          </div>
        )}
      </div>
    </div>
  );
}
