// The layout choices offered when the agent could not fit a fix into the client's design on its own, built from the
// SITE'S OWN component templates (site.url_file_map.siteRoot.componentTemplates) instead of a fixed list. A template is
// the site's real HTML for a block (a `row` and a `wrapper` in its own classes), so every option offered here is one the
// builder (implementers/lib/marker-merge.js) can actually render, and a pick is simply "use this template".
//
// Only FAQ blocks have more than one template that can show the same content (a site's `faq` list and its `qaContent`
// accordion, say). A fix with a single template (related links) or none (schema, headers) has nothing to choose between.
const has = (t, placeholder) => typeof t?.row === 'string' && t.row.includes(placeholder);

// A template can show FAQ items only if its row takes a question and an answer and its wrapper takes the rows.
export function isFaqCapableTemplate(t) {
  return has(t, '{{QUESTION}}') && has(t, '{{ANSWER}}') && typeof t.wrapper === 'string' && t.wrapper.includes('{{ROWS}}');
}

// What the template's own markup looks like, in words a person understands.
export function describeTemplate(t) {
  const row = String(t?.row || '');
  if (/<details[\s>]|<summary[\s>]|aria-expanded|activeIndex/i.test(row)) {
    return { shape: 'accordion', name: 'Open and close list', note: 'Questions fold away and open on a click, so the page stays short.' };
  }
  if (/<dt[\s>]/i.test(row)) {
    return { shape: 'list', name: 'Question and answer list', note: 'Every question with its answer underneath, all visible at once.' };
  }
  if (/<h[1-6][\s>]/i.test(row)) {
    return { shape: 'headings', name: 'Headings with answers', note: 'Each question is a heading with its answer beneath it.' };
  }
  return { shape: 'list', name: 'Your plain layout', note: 'The simplest layout your site already uses for this.' };
}

// A picture of the site's REAL block: its own row/wrapper markup filled with a few sample questions, styled with the
// class rules the site's templates were verified against (verifiedClassRules), so two options look as different as they
// will on the page. It is shown in a script-less sandboxed frame, and anything executable is stripped here as well.
const SAMPLE_FAQS = [
  ['How long does it take to see results?', 'Most sites start to move within a few weeks, and the biggest gains build up over the following months.'],
  ['Do I have to approve every change?', 'Small, safe fixes go out on their own. Anything that changes how a page looks waits for your OK.'],
  ['Can I undo a change?', 'Yes. Every change is recorded and can be reverted with one click.'],
];
const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 };
const esc = (c) => c.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
const stripActive = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');

export function renderTemplatePreview(t, faqs = SAMPLE_FAQS) {
  if (!isFaqCapableTemplate(t)) return null;
  const rows = faqs.map(([q, a], i) => {
    let r = t.row.replace('{{QUESTION}}', q).replace('{{ANSWER}}', a);
    if (i === 0) r = r.replace(/<details(\s|>)/i, '<details open$1');
    return r;
  }).join('\n');
  const html = stripActive(t.wrapper.replace('{{ROWS}}', rows));
  const base = []; const media = {};
  for (const [cls, decl] of Object.entries(t.verifiedClassRules || {})) {
    const m = /^(sm|md|lg|xl):(.+)$/.exec(cls);
    if (m) (media[m[1]] ||= []).push(`.${esc(cls)}{${decl}}`); else base.push(`.${esc(cls)}{${decl}}`);
  }
  const css = [...base, ...Object.entries(BREAKPOINTS).filter(([k]) => media[k]).map(([k, px]) => `@media(min-width:${px}px){${media[k].join('')}}`)].join('');
  return `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827}details>summary{cursor:pointer;list-style:none}details{border-bottom:1px solid #e5e7eb;padding:.5rem 0}dt,h2,h3{margin:0}dd{margin:0 0 1rem}${css}</style>${html}`;
}

const FAQ_TEMPLATE_KEYS = ['faq', 'faqInline', 'qaContent'];

// The options for one site, or [] when there is no real choice (fewer than two usable templates, or two that look the same).
export function deriveFaqDesignOptions(componentTemplates) {
  const seen = new Set();
  const options = [];
  for (const key of FAQ_TEMPLATE_KEYS) {
    const t = componentTemplates?.[key];
    if (!isFaqCapableTemplate(t)) continue;
    const d = describeTemplate(t);
    if (seen.has(d.shape)) continue; // two templates that look the same are not two choices
    seen.add(d.shape);
    options.push({ key, shape: d.shape, name: d.name, note: `${d.note} Uses your site's own "${key}" component.`, previewHtml: renderTemplatePreview(t), ...(key === 'faq' ? { tag: 'Your usual FAQ style' } : {}) });
  }
  return options.length >= 2 ? options : [];
}

export const DESIGN_CHOICE_GENERATORS = new Set(['faq']);
export const hasDesignOptions = (generatorId) => DESIGN_CHOICE_GENERATORS.has(generatorId);
export const designOptionsFor = (generatorId, componentTemplates) => (generatorId === 'faq' ? deriveFaqDesignOptions(componentTemplates) : []);

// A pick must be one of the options this particular row was offered (the row stores its own options).
export function validateDesignPick(row, optionKey) {
  if (!row) return { ok: false, status: 404, error: 'That item was not found.' };
  if (!['needs_choice', 'chosen', 'withdrawn'].includes(row.status)) return { ok: false, status: 409, error: 'This one is already being built, so the choice can no longer be changed here.' };
  if (!(row.options || []).some((o) => o.key === optionKey)) return { ok: false, status: 400, error: 'That is not one of the options for this item.' };
  return { ok: true };
}
