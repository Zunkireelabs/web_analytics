import { getDocs } from '../auth/google.js';

// Generalizes executive-doc.js's section-builder for a one-off, ad hoc
// report (an Analyst finding investigation) rather than a recurring,
// cumulative one. Unlike the daily/weekly/monthly/executive reports, this
// never reuses a doc across calls — each call is its own fresh
// docs.documents.create(), so there's no ensureDoc()/doc-id-column pattern
// to carry, and no risk of two staff investigating two different findings
// stepping on the same document.

function buildSections(title, sections) {
  let text = '';
  const add = (s) => { text += s; };

  const headingStart = text.length;
  add(`${title}\n`);
  const heading = { start: headingStart, end: text.length - 1 };
  add('\n');

  const subheads = [];
  for (const { label, body } of sections) {
    const subStart = text.length;
    add(`${label}\n`);
    subheads.push({ start: subStart, end: text.length - 1 });
    add(`${body}\n\n`);
  }

  return { text, heading, subheads };
}

// site: the sites row (Google credentials scoped per-site, see auth/google.js).
// title: doc title, also the first line of the body.
// sections: [{label, body}] rendered in order, each as a bold sub-heading
// followed by plain-text body — callers decide what sections mean.
export async function createInsightReportDoc(site, { title, sections }) {
  const docs = getDocs(site);
  const created = await docs.documents.create({ requestBody: { title } });
  const docId = created.data.documentId;

  const { text, heading, subheads } = buildSections(title, sections);
  const base = 1;
  const requests = [
    { insertText: { location: { index: base }, text } },
    {
      updateParagraphStyle: {
        range: { startIndex: base, endIndex: base + text.length },
        paragraphStyle: { alignment: 'START' },
        fields: 'alignment',
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: base + heading.start, endIndex: base + heading.end },
        textStyle: { bold: true, fontSize: { magnitude: 16, unit: 'PT' } },
        fields: 'bold,fontSize',
      },
    },
    {
      updateParagraphStyle: {
        range: { startIndex: base + heading.start, endIndex: base + heading.end },
        paragraphStyle: { keepWithNext: true },
        fields: 'keepWithNext',
      },
    },
  ];

  for (const sub of subheads) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: base + sub.start, endIndex: base + sub.end },
        textStyle: { bold: true, fontSize: { magnitude: 12, unit: 'PT' } },
        fields: 'bold,fontSize',
      },
    });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: base + sub.start, endIndex: base + sub.end },
        paragraphStyle: { keepWithNext: true, spaceAbove: { magnitude: 10, unit: 'PT' } },
        fields: 'keepWithNext,spaceAbove',
      },
    });
  }

  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  return { docId, url: `https://docs.google.com/document/d/${docId}/edit` };
}
