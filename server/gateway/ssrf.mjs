import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const bl = new BlockList();
for (const [n, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) bl.addSubnet(n, p, 'ipv4');
for (const [n, p] of [['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) bl.addSubnet(n, p, 'ipv6');
bl.addAddress('::', 'ipv6');

const norm = (ip) => { const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); return m ? m[1] : ip; };
export const isLoopback = (ip) => { ip = norm(ip); return isIP(ip) === 4 ? ip.startsWith('127.') : ip === '::1'; };
export const isBlockedIp = (ip) => { ip = norm(ip); return isLoopback(ip) || bl.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4'); };

// CRAFT_UPSTREAM_ALLOW: comma list of `host`, `host:port`, `ip`, `ip:port` or IPv4 `a.b.c.d/len`.
export function parseAllowList(value = '') {
  return String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => {
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(s);
    if (cidr) { const b = new BlockList(); b.addSubnet(cidr[1], +cidr[2], 'ipv4'); return { cidr: b }; }
    const m = /^(\[[^\]]+\]|[^:]+|[0-9a-f:]+?)(?::(\d+))?$/.exec(s);
    return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? +m[2] : null };
  });
}

function allowed(entries, host, port, ip) {
  return entries.some((e) => e.cidr ? (isIP(ip) === 4 && e.cidr.check(ip, 'ipv4'))
    : (e.host === host || e.host === ip) && (e.port === null || e.port === port));
}

/**
 * Resolve and vet an upstream URL. Returns the validated { ip, family, port, url }; callers must connect to that IP.
 * selfAddr: { port, host } of this gateway, always blocked.
 */
export async function vetUpstream(rawUrl, { allowList = [], allowLoopback = false, self = null } = {}) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http(s) upstreams allowed');
  if (url.username || url.password) throw new Error('credentials in URL not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) throw new Error('upstream host does not resolve');
  for (const { address } of addrs) {
    const ip = norm(address);
    if (self && port === self.port && (isLoopback(ip) || ip === self.host || ['0.0.0.0', '::', undefined].includes(self.host))) throw new Error('upstream points at the gateway itself');
    if (!isBlockedIp(ip)) continue;
    if (allowed(allowList, host, port, ip)) continue;
    if (allowLoopback && isLoopback(ip)) continue;
    throw new Error('upstream address is private/loopback/link-local and not in the allow-list');
  }
  return { url, ip: addrs[0].address, family: addrs[0].family, port };
}
