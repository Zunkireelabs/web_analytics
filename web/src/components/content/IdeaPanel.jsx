import { useEffect, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import DesignFrame from './DesignFrame.jsx';
import ArticleShot from './ArticleShot.jsx';

// The side panel for one content idea: each option drawn as a page in the CLIENT's own design (the server draws it from the site's own
// recorded look), with the other options one tab away, Desktop and Mobile, and a Pick button. Picking only marks it on screen; the
// client still presses Approve once at the bottom of the page, and nothing is built until then.
export default function IdeaPanel({ idea, onClose, onPick }) {
  const [key, setKey] = useState(idea?.startKey);
  useEffect(() => { setKey(idea?.startKey); }, [idea?.item?.id, idea?.startKey]);
  if (!idea) return null;
  const { title, url, options, previews, selectedKey, locked, generatorId, siteId } = idea;
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
          const sketch = html ? <DesignFrame html={html} url={url} title={option.name} />
            : <div className="rounded-card bg-muted px-5 py-10 text-center text-sm text-text">This option has no page picture yet.</div>;
          // Blog, landing page and translation are drawn inside a real captured page of the site's own template.
          return ['blog-outline', 'landing-page', 'translation'].includes(generatorId) ? <ArticleShot option={option.key} title={title} siteId={siteId} generatorId={generatorId} url={url} fallback={sketch} /> : sketch;
        })()}
        <p className="mt-3 text-[13px] text-faint">This is how the page would look on your site. Nothing is built until you pick an option and approve.</p>
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
