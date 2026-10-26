export default function dnsRecords({ dns }) {
  const results = [];

  results.push({
    id: 'spf-record',
    title: 'SPF Record',
    category: 'seo',
    passed: dns.spf,
    score: dns.spf === true ? 2 : 0,
    maxScore: dns.spf === null ? 0 : 2,
    message: dns.spf === null ? 'Could not verify SPF record.' : dns.spf ? 'SPF record found.' : 'No SPF record found.',
    recommendation: dns.spf ? 'No action needed.' : 'Add an SPF DNS TXT record to help prevent email spoofing.',
  });

  results.push({
    id: 'dmarc-record',
    title: 'DMARC Record',
    category: 'seo',
    passed: dns.dmarc,
    score: dns.dmarc === true ? 2 : 0,
    maxScore: dns.dmarc === null ? 0 : 2,
    message:
      dns.dmarc === null ? 'Could not verify DMARC record.' : dns.dmarc ? 'DMARC record found.' : 'No DMARC record found.',
    recommendation: dns.dmarc ? 'No action needed.' : 'Add a DMARC DNS TXT record to help prevent email spoofing.',
  });

  return results;
};
