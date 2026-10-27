import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Card, { ROW } from './Card.jsx';
import { STATUS } from '../../lib/palette.js';

// "Write for it" drafts a post for that exact keyword (the server only accepts keywords the Analyst
// currently predicts) and the draft lands in Action Center for approval.
export default function KeywordsCard({ keywords, loading }) {
  const [state, setState] = useState({}); // keyword -> { busy } | { done, reused } | { error }
  const has = keywords && keywords.length > 0;

  async function write(keyword) {
    setState((s) => ({ ...s, [keyword]: { busy: true } }));
    try {
      const r = await api.analyst.writeForKeyword(keyword);
      setState((s) => ({ ...s, [keyword]: { done: true, reused: !!r.reused } }));
    } catch (e) {
      setState((s) => ({ ...s, [keyword]: { error: e.message || 'Could not draft that.' } }));
    }
  }

  return (
    <Card
      title="Keywords that can grow" subtitle="Close to page 1 and rising. Gain is extra clicks a month if you get there"
      loading={loading} empty={!loading && !has ? 'Nothing here yet. Keywords show up once Search Console has enough history.' : null}
      maxHeight={340} footer={has && <><span>Ranked by predicted gain</span><span /></>}
    >
      {has && keywords.map((k) => {
        const st = state[k.keyword] || {};
        return (
          <div key={k.keyword} className={`${ROW} items-center`}>
            <div className="min-w-0 flex-1">
              <div className="text-fg truncate">{k.keyword}</div>
              <div className="text-xs text-faint">
                {k.position != null && `now position ${Math.round(k.position * 10) / 10}`}
                {k.position != null && k.likelihoodPct != null && ' · '}
                {k.likelihoodPct != null && `${Math.round(k.likelihoodPct)}% likely to reach page 1`}
              </div>
              {st.error && <div className="text-xs mt-0.5" style={{ color: STATUS.critical.text }}>{st.error}</div>}
            </div>
            {k.gainClicks != null && <span className="tnum shrink-0" style={{ color: STATUS.good.text }}>+{Math.round(k.gainClicks).toLocaleString('en-US')} clicks</span>}
            {st.done ? (
              <Link to="/action-center" className="shrink-0 text-xs text-primary hover:underline">{st.reused ? 'Already drafted' : 'Draft ready'} · open</Link>
            ) : (
              <Button size="sm" variant="light" className="shrink-0" disabled={st.busy} onClick={() => write(k.keyword)}>{st.busy ? 'Drafting…' : 'Write for it'}</Button>
            )}
          </div>
        );
      })}
    </Card>
  );
}
