import FixesStrip from './FixesStrip.jsx';
import ProblemsCard from './ProblemsCard.jsx';
import SolvedCard from './SolvedCard.jsx';
import WeekCard from './WeekCard.jsx';
import { Notice } from './OutlookTab.jsx';

export default function FixesTab({ fixes, loading, error, onRetry, onApprove, approving }) {
  if (error) return <Notice text={error} action={<button type="button" className="underline" onClick={onRetry}>Retry</button>} />;
  return (
    <div className="space-y-3">
      <FixesStrip counts={fixes?.counts} loading={loading} />
      <div className="grid gap-3 lg:grid-cols-2 items-start">
        <ProblemsCard problems={fixes?.problems} loading={loading} onApprove={onApprove} approving={approving} />
        <div className="space-y-3">
          <SolvedCard solved={fixes?.solved} loading={loading} />
          <WeekCard week={fixes?.week} loading={loading} />
        </div>
      </div>
    </div>
  );
}
