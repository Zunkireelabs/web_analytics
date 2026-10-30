import Badge from '../Badge.jsx';
import ListCard, { ROW } from './ListCard.jsx';

export default function WordsToAdd({ words, loading }) {
  return (
    <ListCard
      title="Words to add to your pages"
      subtitle="Phrases buyers use that your pages do not say yet, and where they would go"
      empty={loading ? 'Loading…' : !words.length ? 'Nothing to add yet. Phrases show up here once there are prompts you are missing.' : null}
      footer={!loading && words.length > 0 && <><span>{words.length} phrase{words.length === 1 ? '' : 's'} in total</span><span /></>}
    >
      {words.map((w) => (
        <div key={w.phrase} className={`${ROW} items-center`}>
          <span className="min-w-0 flex-1 text-fg">{w.phrase}</span>
          <span className="text-xs text-faint truncate max-w-[40%]">{w.page ? <>on <span className="text-text">{w.page}</span></> : 'new page'}</span>
          <Badge tone="amber" className="tnum shrink-0">{w.covers} prompt{w.covers === 1 ? '' : 's'}</Badge>
        </div>
      ))}
    </ListCard>
  );
}
