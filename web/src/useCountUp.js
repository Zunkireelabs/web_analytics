import { useEffect, useRef, useState } from 'react';

// Counts up from 0 to `target` over `duration` ms whenever target changes —
// used for the Command Center's stat tiles so numbers feel alive rather than
// just appearing. Skips straight to the final value for non-numeric targets
// or when the user has requested reduced motion.
export function useCountUp(target, duration = 600) {
  const [value, setValue] = useState(typeof target === 'number' ? 0 : target);
  const raf = useRef(null);

  useEffect(() => {
    if (typeof target !== 'number' || Number.isNaN(target)) { setValue(target); return; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setValue(target); return; }

    const start = performance.now();
    function tick(now) {
      const pct = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - pct) * (1 - pct); // ease-out
      setValue(Math.round(target * eased));
      if (pct < 1) raf.current = requestAnimationFrame(tick);
    }
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);

  return value;
}
