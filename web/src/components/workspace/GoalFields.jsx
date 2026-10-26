import { Search, Mail, Bot, TrendingUp, Target, PenLine, Check } from 'lucide-react';
import { GOAL_CHOICES, GROWTH_CHOICES, MONTH_CHOICES, CUSTOM_GOAL, GOAL_CUSTOM_MAX, goalSentence, goalsOf } from '../../lib/workspace.js';

const ICONS = { google_visitors: Search, enquiries: Mail, ai_answers: Bot, key_rankings: TrendingUp, custom: PenLine };
const RING = '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)';
const RING_ON = '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)';

// "What do you want to grow?" in everyday words. Tick as many as apply.
// value = { goals, growth, months, customText } — `goals` in the order ticked;
// customText only when "Something else" is ticked. The growth choice only matters for
// the preset goals, so it hides when "Something else" is the only one ticked.
export default function GoalFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const goals = goalsOf(value);
  const custom = goals.includes(CUSTOM_GOAL);
  const hasPreset = goals.some((k) => k !== CUSTOM_GOAL);
  const sentence = goalSentence(value);
  const toggle = (key) => {
    const next = goals.includes(key) ? goals.filter((k) => k !== key) : [...goals, key];
    if (!next.length) return; // a project always has at least one goal
    set({ goals: next });
  };
  return (
    <div className="space-y-5">
      <div>
        <div className="text-[13px] font-medium text-fg mb-0.5">What matters most?</div>
        <div className="text-xs text-faint mb-2">Choose as many as you like.</div>
        <div role="group" aria-label="What matters most?" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {GOAL_CHOICES.map((g) => {
            const on = goals.includes(g.key), Icon = ICONS[g.key];
            return (
              <button key={g.key} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(g.key)}
                className="flex items-start gap-2.5 p-3 rounded-card bg-white text-left" style={{ boxShadow: on ? RING_ON : RING }}>
                <span className={`w-8 h-8 rounded-control grid place-items-center shrink-0 ${on ? 'bg-primary-tint text-primary' : 'bg-muted text-text'}`}><Icon size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg leading-[18px]">{g.title}</span>
                  <span className="block text-xs text-faint mt-0.5 leading-4">{g.description}</span>
                </span>
                <span className={`w-[18px] h-[18px] rounded-[5px] grid place-items-center shrink-0 mt-0.5 ${on ? 'bg-primary text-white' : 'bg-white'}`}
                  style={on ? undefined : { boxShadow: 'inset 0 0 0 1px var(--input)' }} aria-hidden="true">
                  {on && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {custom && (
        <label className="fld">
          <span className="fld__label">What is your goal?</span>
          <textarea value={value.customText || ''} onChange={(e) => set({ customText: e.target.value.slice(0, GOAL_CUSTOM_MAX) })}
            rows={2} maxLength={GOAL_CUSTOM_MAX} autoFocus placeholder="Fill our three new course pages with enquiries"
            className="w-full rounded-control bg-white text-[13px] text-fg px-2.5 py-2 outline-none resize-none"
            style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)', fontFamily: 'inherit', lineHeight: '19px' }} />
          <span className="fld__hint">In your own words. {GOAL_CUSTOM_MAX - (value.customText || '').length} characters left.</span>
        </label>
      )}

      {hasPreset && (
      <div>
        <div className="text-[13px] font-medium text-fg mb-2">How much growth do you want?</div>
        <div role="radiogroup" aria-label="How much growth" className="grid grid-cols-3 gap-2">
          {GROWTH_CHOICES.map((g) => {
            const on = value.growth === g.key;
            return (
              <button key={g.key} type="button" role="radio" aria-checked={on} onClick={() => set({ growth: g.key })}
                className="p-3 rounded-card bg-white text-center" style={{ boxShadow: on ? RING_ON : RING }}>
                <span className="block text-[13px] font-medium text-fg">{g.title}</span>
                <span className="block text-xs text-faint mt-0.5">{g.description}</span>
              </button>
            );
          })}
        </div>
      </div>
      )}

      <div>
        <div className="text-[13px] font-medium text-fg mb-2">In how long?</div>
        <div className="toggle" role="radiogroup" aria-label="In how long">
          {MONTH_CHOICES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={value.months === m} className={value.months === m ? 'is-on' : undefined} onClick={() => set({ months: m })}>
              {m} months
            </button>
          ))}
        </div>
      </div>

      {sentence && (
        <div className="flex items-start gap-2.5 rounded-control bg-muted px-3 py-2.5 text-[13px] leading-5 text-text">
          <Target size={15} className="text-faint shrink-0 mt-0.5" />
          <span><b className="font-medium text-fg">Your goal:</b> {sentence} We track it on your Overview and tell you in plain words if you are on track.</span>
        </div>
      )}
    </div>
  );
}
