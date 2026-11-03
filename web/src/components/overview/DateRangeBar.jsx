import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import Modal from '../Modal.jsx';
import Button from '../Button.jsx';
import {
  PRESETS, BAR_KEYS, COMPARE_MODES, presetRange, rangeKeyFor, labelForKey, isYmd,
} from '../../lib/overview-view.js';

const ring = { boxShadow: '0 0 0 1px var(--input)' };

function Radio({ on, onClick, children }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
      className="flex items-center gap-3.5 w-full py-2.5 text-left text-[15px] text-fg">
      <span className="w-5 h-5 rounded-full grid place-items-center shrink-0" style={{ boxShadow: `inset 0 0 0 2px ${on ? 'var(--primary)' : '#3c3b38'}` }}>
        {on && <span className="w-2.5 h-2.5 rounded-full bg-primary" />}
      </span>
      {children}
    </button>
  );
}

function DateFields({ start, end, onStart, onEnd, min, max, error }) {
  const input = 'h-10 w-full px-3 rounded-control bg-white text-[14px] text-fg';
  return (
    <div className="ml-[34px] mt-1 mb-2">
      <div className="flex items-end gap-2.5">
        <label className="flex-1 min-w-0 text-xs text-faint">Start date
          <input type="date" value={start} min={min} max={max} onChange={(e) => onStart(e.target.value)} className={`${input} mt-1`} style={ring} />
        </label>
        <span className="pb-2.5 text-faint">-</span>
        <label className="flex-1 min-w-0 text-xs text-faint">End date
          <input type="date" value={end} min={min} max={max} onChange={(e) => onEnd(e.target.value)} className={`${input} mt-1`} style={ring} />
        </label>
      </div>
      {error && <p className="mt-1.5 text-xs" style={{ color: '#b42318' }}>{error}</p>}
    </div>
  );
}

// The Search Console-style dialog: Filter (which dates) and Compare (what to set them against), one Apply for both.
function DateRangeDialog({ isOpen, onClose, start, end, anchor, earliest, compareMode, compareCustom, initialTab, onApply }) {
  const current = rangeKeyFor(start, end, anchor, earliest);
  const [tab, setTab] = useState(initialTab || 'range');
  const [pick, setPick] = useState(current === 'custom' || !BAR_KEYS.includes(current) ? current : '180');
  const [cStart, setCStart] = useState(start);
  const [cEnd, setCEnd] = useState(end);
  const [mode, setMode] = useState(compareMode);
  const [kStart, setKStart] = useState(compareCustom?.start || '');
  const [kEnd, setKEnd] = useState(compareCustom?.end || '');
  const [touched, setTouched] = useState(false);

  const moreOptions = PRESETS.filter((p) => !BAR_KEYS.includes(p.key));
  const bounds = { min: earliest || undefined, max: anchor };
  const rangeError = pick === 'custom' && (!isYmd(cStart) || !isYmd(cEnd) ? 'Pick both dates.' : cStart > cEnd ? 'The start date is after the end date.' : null);
  const compareError = mode === 'custom' && (!isYmd(kStart) || !isYmd(kEnd) ? 'Pick both dates.' : kStart > kEnd ? 'The start date is after the end date.' : null);
  const valid = !rangeError && !compareError;

  const apply = () => {
    let range = null;
    if (pick === 'custom') range = { start: cStart, end: cEnd };
    else range = presetRange(anchor, pick, earliest);
    onApply(range, mode, mode === 'custom' ? { start: kStart, end: kEnd } : null);
  };

  const tabBtn = (id, label) => (
    <button type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={`px-3 pt-1 pb-3 text-[15px] font-medium border-b-[3px] -mb-px ${tab === id ? 'text-primary border-primary' : 'text-text border-transparent'}`}>{label}</button>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Date range" subtitle="Choose the days to look at, and what to compare them with." maxWidth="max-w-md"
      footer={(
        <>
          <Button variant="light" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!touched || !valid}>Apply</Button>
        </>
      )}>
      <div role="tablist" className="flex gap-1.5 border-b border-border -mt-1">{tabBtn('range', 'Filter')}{tabBtn('compare', 'Compare')}</div>
      {tab === 'range' ? (
        <div role="radiogroup" aria-label="Date range">
          {moreOptions.map((p) => (
            <Radio key={p.key} on={pick === p.key} onClick={() => { setPick(p.key); setTouched(true); }}>
              {p.key === 'all' ? 'All time' : `Last ${p.label}`}
            </Radio>
          ))}
          <Radio on={pick === 'custom'} onClick={() => { setPick('custom'); setTouched(true); }}>Custom</Radio>
          {pick === 'custom' && (
            <DateFields start={cStart} end={cEnd} {...bounds} error={touched ? rangeError : null}
              onStart={(v) => { setCStart(v); setTouched(true); }} onEnd={(v) => { setCEnd(v); setTouched(true); }} />
          )}
        </div>
      ) : (
        <div role="radiogroup" aria-label="Compare with">
          <p className="text-[13px] text-faint mb-1">The grey dashed line on the chart, and the change shown under each number.</p>
          {COMPARE_MODES.map((m) => (
            <Radio key={m.key} on={mode === m.key} onClick={() => { setMode(m.key); setTouched(true); }}>{m.label}</Radio>
          ))}
          {mode === 'custom' && (
            <DateFields start={kStart} end={kEnd} {...bounds} error={touched ? compareError : null}
              onStart={(v) => { setKStart(v); setTouched(true); }} onEnd={(v) => { setKEnd(v); setTouched(true); }} />
          )}
        </div>
      )}
    </Modal>
  );
}

// The Overview toolbar: three quick ranges and "More", like Search Console. "More" opens the dialog.
export default function DateRangeBar({ start, end, anchor, earliest, compareMode, compareCustom, onRange, onCompare }) {
  const [open, setOpen] = useState(false);
  const key = rangeKeyFor(start, end, anchor, earliest);
  const inBar = BAR_KEYS.includes(key);
  const btn = 'h-9 px-3.5 text-sm font-medium inline-flex items-center gap-1.5 whitespace-nowrap border-r border-border-2 last:border-r-0 first:rounded-l-[10px] last:rounded-r-[10px]';
  const on = 'bg-primary-tint text-[#7a3400]';

  return (
    <>
      <div className="inline-flex max-w-full rounded-[10px] bg-white" style={ring} role="group" aria-label="Date range">
        {BAR_KEYS.map((k) => (
          <button key={k} type="button" aria-pressed={key === k}
            onClick={() => { const r = presetRange(anchor, k, earliest); if (r) onRange(r); }}
            className={`${btn} ${key === k ? on : 'text-text'}`}>
            {key === k && <Check size={14} />}{labelForKey(k)}
          </button>
        ))}
        <button type="button" aria-haspopup="dialog" aria-pressed={!inBar} onClick={() => setOpen(true)} className={`${btn} ${!inBar ? on : 'text-text'}`}>
          {!inBar && <Check size={14} />}{inBar ? 'More' : labelForKey(key)}<ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <DateRangeDialog isOpen onClose={() => setOpen(false)} start={start} end={end} anchor={anchor} earliest={earliest}
          compareMode={compareMode} compareCustom={compareCustom}
          onApply={(range, mode, custom) => { setOpen(false); if (range) onRange(range); onCompare(mode, custom); }} />
      )}
    </>
  );
}
