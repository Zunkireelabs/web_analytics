export default function httpsRedirect({ tls }) {
  const results = [];

  results.push({
    id: 'ssl-enabled',
    title: 'SSL Enabled',
    category: 'seo',
    passed: tls.https,
    score: tls.https ? 8 : 0,
    maxScore: 8,
    message: tls.https ? 'This page loads over HTTPS.' : 'This page does not load over HTTPS.',
    recommendation: tls.https ? 'No action needed.' : 'Enable SSL/TLS and serve the site over HTTPS.',
  });

  results.push({
    id: 'https-redirect',
    title: 'HTTPS Redirect',
    category: 'seo',
    passed: tls.httpToHttpsRedirect === null ? null : tls.httpToHttpsRedirect,
    score: tls.httpToHttpsRedirect === true ? 4 : 0,
    maxScore: tls.httpToHttpsRedirect === null ? 0 : 4,
    message:
      tls.httpToHttpsRedirect === true
        ? 'The HTTP version redirects to HTTPS.'
        : tls.httpToHttpsRedirect === null
        ? 'Could not verify the HTTP to HTTPS redirect.'
        : 'The HTTP version does not redirect to HTTPS.',
    recommendation:
      tls.httpToHttpsRedirect === true
        ? 'No action needed.'
        : 'Force a redirect from HTTP to HTTPS so users always land on the secure version.',
  });

  results.push({
    id: 'http2-usage',
    title: 'HTTP/2 Usage',
    category: 'seo',
    passed: tls.http2 === null ? null : tls.http2,
    score: tls.http2 === true ? 3 : 0,
    maxScore: tls.https ? 3 : 0,
    message:
      tls.http2 === true
        ? 'This site uses HTTP/2.'
        : tls.http2 === null
        ? 'Could not verify HTTP protocol version.'
        : 'This site does not appear to use HTTP/2.',
    recommendation: tls.http2 === true ? 'No action needed.' : 'Enable HTTP/2 on your web server for a performance boost.',
  });

  return results;
};
