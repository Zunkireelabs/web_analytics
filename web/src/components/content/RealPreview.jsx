import { useEffect, useRef, useState } from 'react';

// The site's own design as it will look on the page: real markup and styles in a script-less frame, drawn at a desktop
// width and scaled to fit the card, so options can be told apart at a glance.
export default function RealPreview({ html, title, height = 420 }) {
  const box = useRef(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = box.current; if (!el) return undefined;
    const fit = () => setScale(el.clientWidth / 1000);
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="w-full overflow-hidden" style={{ height: height * scale }}>
      <iframe title={title} sandbox="" srcDoc={html} tabIndex={-1} style={{ width: 1000, height, border: 0, transformOrigin: '0 0', transform: `scale(${scale})`, pointerEvents: 'none', background: '#fff' }} />
    </div>
  );
}
