// One way to read a website address typed into a form, so what is stored, what Search Console
// properties are matched against, and what is shown can never disagree.
//
// "https://WWW.Example.com:8080/path?x#y" -> "example.com". Returns { ok: true, domain } (domain null when
// nothing was given) or { ok: false, error }.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, domain: null };
  if (/\s/.test(raw)) return { ok: false, error: 'A website address cannot contain spaces.' };
  const host = raw.toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^sc-domain:/, '')
    .replace(/[/?#].*$/, '')
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  const labels = host.split('.');
  const valid = host.length > 0 && host.length <= 253 && labels.length >= 2
    && labels.every((l) => LABEL.test(l)) && /^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]);
  return valid ? { ok: true, domain: host } : { ok: false, error: 'Enter a website address like example.com.' };
}
