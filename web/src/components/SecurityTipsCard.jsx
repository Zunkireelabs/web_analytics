import { ShieldCheck, KeyRound, Fingerprint, Lock, Check, Clock } from 'lucide-react';

const TIPS = [
  { icon: Lock, text: 'Use a strong, unique password', done: true },
  { icon: KeyRound, text: 'Review API tokens periodically', done: true },
  { icon: Fingerprint, text: 'Enable MFA', comingSoon: true },
  { icon: ShieldCheck, text: 'Never share Admin tokens', done: true },
];

export default function SecurityTipsCard() {
  return (
    <div className="bg-white border border-slate-200/60 shadow-sm rounded-[20px] p-6">
      <h2 className="text-sm font-black text-slate-900 flex items-center gap-2 mb-1">
        <ShieldCheck size={15} className="text-[#6C63FF]" /> Security Tips
      </h2>
      <p className="text-xs text-slate-450 font-semibold mb-4">A quick checklist for keeping this account safe.</p>

      <div className="space-y-2.5">
        {TIPS.map(({ icon: Icon, text, done, comingSoon }) => (
          <div key={text} className="flex items-center gap-3">
            <span className={`shrink-0 w-6 h-6 rounded-full grid place-items-center ${comingSoon ? 'bg-slate-100 text-slate-400' : 'bg-emerald-50 text-emerald-600'}`}>
              {comingSoon ? <Clock size={12} /> : <Check size={13} strokeWidth={3} />}
            </span>
            <Icon size={13} className="text-slate-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-700 flex-1">{text}</span>
            {comingSoon && (
              <span className="shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-400">Soon</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
