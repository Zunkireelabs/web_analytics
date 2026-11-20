import { useEffect, useRef, useState } from 'react';

// A page drawn in the CLIENT'S OWN design (the server draws it from the site's stylesheets, fonts and colours), in a browser frame,
// with Desktop and Mobile views. The page is in a script-less sandboxed frame: nothing in it can run. Desktop is drawn at 1000px and
// scaled to fit the panel; Mobile at 390px.
export default function DesignFrame({ html, url, title, height = 560 }) {
  const [device, setDevice] = useState('desktop');
  const box = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = box.current; if (!el) return undefined;
    const fit = () => setWidth(el.clientWidth || 640);
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mobile = device === 'mobile';
  const natural = mobile ? 390 : 1000;
  const scale = mobile ? 1 : Math.min(1, width / 1000);
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[13px] text-faint">How it will look on your site</span>
        <div className="toggle ml-auto" role="tablist" aria-label="Screen size">
          {['desktop', 'mobile'].map((d) => <button key={d} type="button" role="tab" aria-selected={device === d} className={device === d ? 'is-on' : ''} onClick={() => setDevice(d)}>{d === 'desktop' ? 'Desktop' : 'Mobile'}</button>)}
        </div>
      </div>
      <div className="rounded-[12px] overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--border-canvas), 0 8px 24px -12px rgba(0,0,0,.18)' }}>
        <div className="flex items-center gap-2.5 px-3 py-2 border-b border-border-canvas" style={{ background: '#f3f2f0' }}>
          <span className="flex gap-1.5">{[0, 1, 2].map((i) => <i key={i} className="w-[9px] h-[9px] rounded-full" style={{ background: '#d9d6d1' }} />)}</span>
          <span className="flex-1 truncate rounded-[7px] bg-white px-2.5 py-0.5 text-xs text-faint" style={{ boxShadow: 'inset 0 0 0 1px var(--border-canvas)' }}>{url || 'your site'}</span>
        </div>
        <div ref={box} className="bg-white" style={{ height, overflow: 'hidden', display: mobile ? 'flex' : 'block', justifyContent: 'center' }}>
          <iframe title={title || 'Preview'} sandbox="" srcDoc={html}
            style={{ width: natural, height: height / scale, border: 0, transformOrigin: '0 0', transform: `scale(${scale})`, background: '#fff', flex: 'none' }} />
        </div>
      </div>
    </div>
  );
}
