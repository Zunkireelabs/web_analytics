import { PREVIEW_SCRIPT } from './preview-script.js';

// Makes a drawn page (a sketch of an idea) clickable part by part: every heading, paragraph, button, link, image, form field, card and section gets an id, and the
// preview script reports which one was touched. Pure browser code (DOMParser); the server's page is untouched. Returns { html, parts: [{ id, kind, label, text }] }.
const LEAF = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BUTTON', 'IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'BLOCKQUOTE', 'FIGURE', 'LABEL']);
const REGION = new Set(['SECTION', 'HEADER', 'FOOTER', 'FORM', 'NAV', 'ASIDE', 'ARTICLE', 'MAIN']);
const KIND = { H1: 'Heading', H2: 'Heading', H3: 'Heading', H4: 'Heading', H5: 'Heading', H6: 'Heading', P: 'Paragraph', LI: 'List item', BUTTON: 'Button', A: 'Button', IMG: 'Image', INPUT: 'Form field', TEXTAREA: 'Form field', SELECT: 'Form field', BLOCKQUOTE: 'Quote', FIGURE: 'Image', LABEL: 'Label', FORM: 'Form', SECTION: 'Section', HEADER: 'Header', FOOTER: 'Footer', NAV: 'Menu', ASIDE: 'Side box', ARTICLE: 'Card', MAIN: 'Main part' };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
const sig = (el) => `${el.tagName}.${(el.getAttribute('class') || '').trim()}`;

export function makeInteractiveSketch(html) {
  if (!html || typeof DOMParser === 'undefined') return { html, parts: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const parts = [];
  const tag = (el, kind, text) => {
    if (el.hasAttribute('data-block-id')) return;
    const id = `part:${parts.length}`;
    el.setAttribute('data-block-id', id);
    const label = clip(text ? `${kind}: “${text}”` : kind, 78);
    parts.push({ id, kind, label, text: clip(textOf(el) || text || '', 300), el });
  };
  // The page's own outer wrapper(s) (a lone div around everything) are never a part: touching blank space must not select the whole page.
  let root = doc.body;
  while ([...root.children].filter((c) => !['SCRIPT', 'STYLE'].includes(c.tagName.toUpperCase())).length === 1) {
    const only = [...root.children].find((c) => !['SCRIPT', 'STYLE'].includes(c.tagName.toUpperCase()));
    if (!only || !only.children.length) break;
    root = only;
  }
  const all = [...doc.body.querySelectorAll('*')].filter((el) => !['SCRIPT', 'STYLE', 'SVG', 'PATH', 'BR', 'SPAN', 'B', 'I', 'EM', 'STRONG'].includes(el.tagName.toUpperCase()));
  for (const el of all) {
    const t = el.tagName.toUpperCase();
    const text = textOf(el);
    if (LEAF.has(t)) {
      if (t === 'LI' && el.querySelector('p,h1,h2,h3,h4,h5,h6')) continue; // its own heading/paragraph is the part
      if (t === 'LABEL' && !text) continue;
      const alt = t === 'IMG' ? (el.getAttribute('alt') || '') : (t === 'INPUT' || t === 'TEXTAREA') ? (el.getAttribute('placeholder') || el.getAttribute('name') || '') : text;
      if (!alt && t !== 'IMG') continue;
      tag(el, KIND[t], alt);
    } else if (t === 'A') {
      if (text && !el.querySelector('p,h1,h2,h3,h4,h5,h6,div')) tag(el, 'Button', text);
    } else if (REGION.has(t)) {
      if (text) tag(el, KIND[t], t === 'FORM' ? '' : text.split(/(?<=[.!?])\s/)[0]);
    } else if (t === 'DIV' || t === 'UL' || t === 'OL') {
      // A card is one of several same-looking siblings that hold their own parts; a lone wrapper is not a part.
      const parent = el.parentElement;
      const twins = parent ? [...parent.children].filter((c) => sig(c) === sig(el)).length : 0;
      if (twins >= 2 && text && el.querySelector('h1,h2,h3,h4,h5,h6,p,button,a,img')) tag(el, 'Card', el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim() || text);
      else if (parent === root && text && el.querySelector('h1,h2,h3,h4,h5,h6,p,button,a,img')) tag(el, 'Section starting', el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim() || text);
    }
  }
  // Where each part sits: the touched part's enclosing tagged parts, innermost first ("Card: “Clear answers”", then its section).
  for (const p of parts) {
    const chain = []; let up = p.el.parentElement;
    while (up && chain.length < 2) { const hit = parts.find((q) => q.el === up); if (hit) chain.push(hit.label); up = up.parentElement; }
    p.context = chain.length ? clip(`inside ${chain.join(', inside ')}`, 200) : '';
  }
  // Only after every part has found its enclosing parts: deleting `el` inside the loop above left the outer parts without it, so almost no part found where it sits.
  for (const p of parts) delete p.el;
  doc.body.setAttribute('data-select-mode', '1');
  const script = doc.createElement('script');
  script.textContent = PREVIEW_SCRIPT;
  doc.body.appendChild(script);
  return { html: `<!doctype html>${doc.documentElement.outerHTML}`, parts };
}
