// A small wireframe for each content option. Generic on purpose: it shows the SHAPE of the choice (where the form
// goes, how long the words run), never a claim about a particular client's site.
const INK = '#2b2b2b';
const LINE = '#e3e0da';
const ACCENT = 'var(--primary)';

const Bar = ({ w = '100%', c = LINE, h = 5 }) => <i style={{ display: 'block', height: h, width: w, background: c, borderRadius: 3 }} />;
const Frame = ({ children, pad = 12 }) => (
  <div style={{ width: 200, height: 150, background: '#fff', borderRadius: 6, boxShadow: `0 0 0 1px ${LINE}`, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: pad }}>{children}</div>
);
const Nav = () => <div style={{ height: 13, background: '#1a1a1a', margin: '-12px -12px 7px', display: 'flex', alignItems: 'center', padding: '0 6px', gap: 4 }}><i style={{ width: 10, height: 5, background: ACCENT, borderRadius: 2 }} /><i style={{ width: 18, height: 3, background: '#555', borderRadius: 2 }} /></div>;
const Hero = () => <div style={{ borderRadius: 4, background: '#f6f3ee', padding: '8px 7px', display: 'grid', gap: 5, marginBottom: 6 }}><Bar w="62%" c={INK} h={7} /><Bar w="84%" /><i style={{ display: 'block', height: 10, width: '42%', background: ACCENT, borderRadius: 3 }} /></div>;
const Cards = () => <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>{[0, 1, 2].map((i) => <div key={i} style={{ border: `1px solid ${LINE}`, borderRadius: 4, padding: 4, display: 'grid', gap: 3 }}><Bar w="60%" c={ACCENT} /><Bar w="92%" /></div>)}</div>;

function Landing({ k }) {
  return (
    <Frame><Nav />
      {k === 'A' && <><Hero /><Cards /><div style={{ display: 'grid', gap: 4, marginTop: 6 }}>{[0, 1].map((i) => <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><b style={{ width: 10, height: 10, borderRadius: '50%', background: INK, flex: 'none' }} /><Bar w="70%" /></div>)}</div></>}
      {k === 'B' && <><div style={{ border: `1px solid ${LINE}`, borderRadius: 5, padding: 7, display: 'grid', gap: 5, marginBottom: 6 }}><Bar w="40%" c={INK} h={6} /><i style={{ display: 'block', height: 9, border: `1px solid ${LINE}`, borderRadius: 3 }} /><i style={{ display: 'block', height: 9, border: `1px solid ${LINE}`, borderRadius: 3 }} /><i style={{ display: 'block', height: 11, width: '50%', background: ACCENT, borderRadius: 3 }} /></div><Cards /></>}
      {k === 'C' && <><Hero />{[0, 1].map((i) => <div key={i} style={{ borderLeft: `3px solid ${ACCENT}`, paddingLeft: 6, display: 'grid', gap: 3, marginBottom: 6 }}><Bar w="90%" /><Bar w="55%" c="#9a958a" /></div>)}</>}
    </Frame>
  );
}

function Translation({ k }) {
  const long = { A: '78%', B: '100%', C: '58%' }[k];
  return (
    <Frame pad={10}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignContent: 'start' }}>
        <div style={{ display: 'grid', gap: 6 }}><b style={{ font: '700 8px/1 sans-serif', color: '#9a958a' }}>ENGLISH</b><Bar w="60%" c={INK} h={6} /><Bar w="90%" /><Bar w="78%" /><i style={{ display: 'block', height: 12, width: '62%', background: ACCENT, borderRadius: 3, marginTop: 4 }} /></div>
        <div style={{ display: 'grid', gap: 6 }}><b style={{ font: '700 8px/1 sans-serif', color: '#9a958a' }}>NEW LANGUAGE</b><Bar w={k === 'C' ? '50%' : '78%'} c={INK} h={6} /><Bar w={long} /><Bar w={k === 'C' ? '70%' : '96%'} /><i style={{ display: 'block', height: 12, width: k === 'B' ? '92%' : k === 'C' ? '58%' : '62%', background: ACCENT, borderRadius: 3, marginTop: 4 }} /></div>
      </div>
    </Frame>
  );
}

function Blog({ k }) {
  return (
    <Frame>
      <div style={{ display: 'grid', gap: 7, alignContent: 'start' }}>
        {k === 'A' && <><Bar w="70%" c={INK} h={8} /><Bar w="96%" /><Bar w="90%" /><Bar w="94%" /><Bar w="60%" /></>}
        {k === 'B' && <><div style={{ borderLeft: `3px solid ${ACCENT}`, paddingLeft: 7, display: 'grid', gap: 5 }}><Bar w="85%" c={INK} h={7} /><Bar w="96%" /></div><Bar w="60%" c={INK} h={6} /><Bar w="94%" /><Bar w="88%" /><Bar w="70%" /></>}
        {k === 'C' && [0, 1, 2].map((i) => <div key={i} style={{ display: 'grid', gap: 4 }}><Bar w="60%" c={INK} h={6} /><Bar w="95%" /><Bar w="70%" /></div>)}
      </div>
    </Frame>
  );
}


// A block the agent adds INTO an existing page (an FAQ block, a related-links block), shown in place on a generic page.
function Block({ k, variant, shape }) {
  // `shape` is read from the site's own template (list / accordion / headings); older A/B/C keys still work.
  const kk = shape ? { list: 'C', accordion: 'B', headings: 'A' }[shape] || k : k;
  const faq = variant !== 'links';
  return (
    <Frame><Nav />
      <div style={{ borderRadius: 4, background: '#f6f3ee', height: 22, marginBottom: 6 }} />
      <Bar w="46%" c={INK} h={6} />
      <div style={{ marginTop: 6 }}>
        {faq && kk === 'A' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ border: `1px solid ${LINE}`, borderRadius: 4, padding: 4, display: 'grid', gap: 3 }}><Bar w="70%" c={ACCENT} /><Bar w="95%" /></div>)}</div>}
        {faq && kk === 'B' && <div style={{ display: 'grid', gap: 3 }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ borderBottom: `1px solid ${LINE}`, padding: '4px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><Bar w="62%" c={i === 0 ? INK : '#9a958a'} /><b style={{ font: '700 9px/1 sans-serif', color: ACCENT }}>{i === 0 ? '–' : '+'}</b></div>)}</div>}
        {faq && kk === 'C' && <div style={{ display: 'grid', gap: 6 }}>{[0, 1, 2].map((i) => <div key={i} style={{ display: 'grid', gap: 3 }}><Bar w="55%" c={INK} /><Bar w="96%" /></div>)}</div>}
        {!faq && k === 'A' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>{[0, 1, 2].map((i) => <div key={i} style={{ border: `1px solid ${LINE}`, borderRadius: 4, padding: 4, display: 'grid', gap: 3 }}><Bar w="60%" c={ACCENT} /><Bar w="92%" /></div>)}</div>}
        {!faq && k === 'B' && <div style={{ display: 'grid', gap: 5 }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><b style={{ width: 4, height: 4, borderRadius: '50%', background: INK, flex: 'none' }} /><Bar w="60%" c={ACCENT} /></div>)}</div>}
        {!faq && k === 'C' && <div style={{ display: 'grid', gap: 4 }}><Bar w="96%" /><div style={{ display: 'flex', gap: 3 }}><Bar w="34%" /><Bar w="26%" c={ACCENT} /><Bar w="30%" /></div><Bar w="88%" /></div>}
      </div>
    </Frame>
  );
}

const BY_TYPE = { landing: Landing, translation: Translation, blog: Blog, block: Block };
export default function OptionPreview({ type, optionKey, variant, shape }) {
  const C = BY_TYPE[type];
  return C ? <C k={optionKey} variant={variant} shape={shape} /> : null;
}
