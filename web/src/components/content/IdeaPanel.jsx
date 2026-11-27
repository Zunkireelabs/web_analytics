import { useEffect, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SketchPage from './SketchPage.jsx';
import SelectionBox from '../SelectionBox.jsx';
import ArticleShot from './ArticleShot.jsx';

// The side panel for one content idea: each option drawn as a page in the CLIENT's own design (the server draws it from the site's own
// recorded look), with the other options one tab away, Desktop and Mobile, and a Pick button. Picking only marks it on screen; the
// client still presses Approve once at the bottom of the page, and nothing is built until then.
export default function IdeaPanel({ idea, onClose, onPick, onNotes }) {
  const [key, setKey] = useState(idea?.startKey);
  const [parts, setParts] = useState([]);
  const [partId, setPartId] = useState(null);
  useEffect(() => { setKey(idea?.startKey); }, [idea?.item?.id, idea?.startKey]);
  useEffect(() => { setPartId(null); }, [idea?.item?.id, key]);
  if (!idea) return null;
  const { title, url, options, previews, selectedKey, locked, generatorId, siteId, notes = [] } = idea;
  const option = options.find((o) => o.key === key) || options[0];
  const html = previews?.[option.key];
  const picked = selectedKey === option.key;
  return (
    <Drawer isOpen onClose={onClose} title={title} subtitle={url || 'Content idea'} icon={LayoutTemplate} maxWidth="max-w-[760px]">
      <div className="px-5 pt-3">
        <div className="flex gap-1 border-b border-border -mx-5 px-5" role="tablist">
          {options.map((o) => (
            <button key={o.key} type="button" role="tab" aria-selected={o.key === option.key} onClick={() => setKey(o.key)}
              className={`px-3.5 pt-2 pb-2.5 text-sm font-medium -mb-px border-b-2 ${o.key === option.key ? 'text-fg border-primary' : 'text-text border-transparent'}`}>
              Option {o.key}{selectedKey === o.key ? ' ✓' : ''}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-3 mb-1">
          <span className="text-sm font-semibold text-fg">{option.name}</span>
          {option.tag && <Badge tone="amber">{option.tag}</Badge>}
        </div>
        <p className="text-[13px] text-text">{option.note}</p>
      </div>
      <div className="px-5 py-4 flex-1">
        {(() => {
          // The box that opens beside a touched part: what to change in THAT part only (the writer is told which part, by its kind and words).
          const renderBox = locked ? null : ({ id, text: words, close }) => {
            const part = parts.find((p) => p.id === id);
            return (
              <SelectionBox kind={part?.kind || ''} words={words} onClose={() => { close(); setPartId(null); }}
                onSubmit={(instruction) => {
                  onNotes?.(picked ? selectedKey : option.key, [...notes, { part: part?.label || null, partText: part?.text || null, context: part?.context || null, selected: words || null, text: instruction }]);
                  close(); setPartId(null);
                }} />
            );
          };
          const sketch = html ? <SketchPage html={html} url={url} title={option.name} selected={partId} onSelect={setPartId} onParts={setParts} renderBox={renderBox} />
            : <div className="rounded-card bg-muted px-5 py-10 text-center text-sm text-text">This option has no page picture yet.</div>;
          // Blog, landing page and translation are drawn inside a real captured page of the site's own template.
          return ['blog-outline', 'landing-page', 'translation'].includes(generatorId) ? <ArticleShot option={option.key} title={title} siteId={siteId} generatorId={generatorId} url={url} fallback={sketch} onParts={setParts} onPart={setPartId} selectedPart={partId} renderBox={renderBox} /> : sketch;
        })()}
        <p className="mt-3 text-[13px] text-faint">Nothing is built until you pick an option and approve.</p>
        {notes.length > 0 && (
          <div className="mt-3 rounded-card border border-border bg-white p-4 space-y-2" aria-label="Changes you asked for">
            <div className="text-sm font-medium text-fg">Changes you asked for</div>
            <ul className="space-y-1.5">
              {notes.map((n, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]"><span className="flex-1"><b>{n.selected ? `“${n.selected}”` : (n.part || 'Whole piece')}:</b> {n.text}</span>{!locked && <button type="button" className="underline text-faint" onClick={() => onNotes?.(picked ? selectedKey : option.key, notes.filter((_, j) => j !== i))}>Remove</button>}</li>
              ))}
            </ul>
            {!picked && <p className="text-xs text-faint">Pick Option {option.key} below to approve it with these changes.</p>}
          </div>
        )}
      </div>
      <div className="sticky bottom-0 border-t border-border px-5 py-3 flex items-center gap-2" style={{ background: '#fcfcfb' }}>
        <Button variant="light" onClick={onClose}>Close</Button>
        <span className="flex-1" />
        {picked && <span className="text-[13px] font-medium" style={{ color: 'var(--green)' }}>Picked</span>}
        <Button variant={picked ? 'light' : 'primary'} disabled={locked} onClick={() => { onPick(option.key); if (!picked) onClose(); }}>{picked ? 'Undo' : `Pick Option ${option.key}`}</Button>
      </div>
    </Drawer>
  );
}
