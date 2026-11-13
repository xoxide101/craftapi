import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const bl = new BlockList();
for (const [n, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) bl.addSubnet(n, p, 'ipv4');
for (const [n, p] of [['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['2001::', 32]]) bl.addSubnet(n, p, 'ipv6');
bl.addAddress('::', 'ipv6');

function v6Bytes(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}

// Reduces any IPv6 form that embeds an IPv4 address to that IPv4 (dotted), so every check sees the real target:
// ::ffff:a.b.c.d and ::ffff:7f00:1 (mapped), ::a.b.c.d / ::7f00:1 (compatible), 2002:wwxx:yyzz:: (6to4).
// :: and ::1 are left as IPv6 (they are blocked/loopback on their own).
const norm = (ip) => {
  if (isIP(ip) !== 6) return ip;
  const b = v6Bytes(ip);
  const zeros = (from, to) => b.subarray(from, to).every((x) => x === 0);
  let v4 = null;
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) v4 = b.subarray(12);
  else if (zeros(0, 12) && !(zeros(12, 15) && b[15] <= 1)) v4 = b.subarray(12);
  else if (b[0] === 0x20 && b[1] === 0x02) v4 = b.subarray(2, 6);
  return v4 ? [...v4].join('.') : ip;
};
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
