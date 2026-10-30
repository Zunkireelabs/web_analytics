import net from 'node:net';
import dns from 'node:dns/promises';

// Audits fetch whatever URL a visitor submits, so every outbound request
// (the page, each redirect hop, robots.txt, the headless browser's own
// sub-requests) must pass through here first. Only public http(s) hosts on
// the default ports are allowed: no loopback, private, link-local or cloud
// metadata addresses, no credentials in the URL, no odd ports.

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv4'));
[
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
  ['2001:db8::', 32],    // documentation
  ['64:ff9b::', 96],     // NAT64: can embed a private IPv4
  ['2002::', 16],        // 6to4: can embed a private IPv4
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, 'ipv6'));

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.corp'];

function blockedTarget(message) {
  const err = new Error(message);
  err.code = 'blocked_target';
  return err;
}

function isPublicIp(address) {
  const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
  // BlockList treats IPv4-mapped IPv6 (::ffff:10.0.0.1) as the IPv4 address.
  return !blocked.check(address, family);
}

// Throws an error with code 'blocked_target' unless `url` points at a public
// host. Resolves the hostname and requires EVERY returned address to be public.
async function assertPublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw blockedTarget('Only http and https URLs are supported.');
  }
  if (url.username || url.password) {
    throw blockedTarget('URLs with credentials are not supported.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw blockedTarget('Only the default web ports are supported.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw blockedTarget('That address cannot be audited.');
    return;
  }
  if (!hostname.includes('.') || hostname === 'localhost' || INTERNAL_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw blockedTarget('That address cannot be audited.');
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    const err = new Error('Could not reach that site.');
    err.code = 'unresolvable';
    throw err;
  }
  if (!records.length || !records.every((r) => isPublicIp(r.address))) {
    throw blockedTarget('That address cannot be audited.');
  }
}

export { assertPublicUrl, isPublicIp };
