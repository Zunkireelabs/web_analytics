import SegmentedTabs from './SegmentedTabs.jsx';

export default function Tabs({ tabs, active, onChange }) {
  return (
    <div className="mb-5 -mt-1 max-w-full overflow-x-auto no-scrollbar">
      <SegmentedTabs options={tabs} value={active} onChange={onChange} />
    </div>
  );
}
