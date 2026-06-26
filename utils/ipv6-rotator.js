/**
 * IPv6 source-address rotation for yt-dlp.
 *
 * Rotates yt-dlp's outbound source IP across a routed IPv6 /64 so YouTube can't
 * per-IP rate-limit us — the same trick Lavalink/FlaviBot-class bots use to dodge
 * the "confirm you're not a bot" wall. Each request leaves from a different address
 * out of 18 quintillion, so there's no single IP to flag.
 *
 * Enabled by setting `YTDLP_IPV6_SUBNET=<prefix>/64` in env, AFTER the host side is
 * in place:
 *   1. sysctl net.ipv6.ip_nonlocal_bind=1   (allow bind() to unconfigured addrs)
 *   2. ip route add local <prefix>/64 dev lo (AnyIP: whole block locally delivered)
 * Until the env var is set this module is a no-op (returns []), so it is safe to ship
 * before the system config exists — yt-dlp just uses the default source address.
 *
 * Only applied to YouTube targets: googlevideo/youtube have full IPv6, but forcing a
 * v6 source on a v4-only endpoint (some SoundCloud CDNs, the loopback PO-token
 * provider) would break the connection. So SoundCloud fallback + bgutil keep default
 * routing.
 */
import logger from './logger.js';

let _groups = null;   // first 4 hextets of the /64, or false when disabled
let _warned = false;

function prefixGroups() {
  if (_groups !== null) return _groups;
  const subnet = process.env.YTDLP_IPV6_SUBNET;
  if (!subnet) { _groups = false; return false; }
  // "2604:2dc0:200:163b::/64" → network hextets ['2604','2dc0','200','163b']
  const netPart = subnet.split('/')[0];
  const groups = netPart.split(':').filter(g => g.length > 0);
  if (groups.length < 4) {
    if (!_warned) {
      logger.warn(`[IPv6Rotator] YTDLP_IPV6_SUBNET="${subnet}" is not a usable /64 prefix (need ≥4 hextets); rotation disabled`);
      _warned = true;
    }
    _groups = false;
    return false;
  }
  _groups = groups.slice(0, 4);
  logger.info(`[IPv6Rotator] Enabled — rotating yt-dlp source across ${_groups.join(':')}::/64`);
  return _groups;
}

function randHextet() {
  return Math.floor(Math.random() * 0x10000).toString(16);
}

// Binding yt-dlp to a global v6 source makes it unable to reach the bgutil PO-token
// provider on 127.0.0.1 (v4 loopback ≠ v6 source). bgutil listens on *:4416, and the
// whole /64 is locally delivered (AnyIP), so we redirect the PO fetch to a v6 address
// in our own block — reachable from any rotated source. Override with YTDLP_POT_BASEURL.
function potBaseUrl() {
  if (process.env.YTDLP_POT_BASEURL) return process.env.YTDLP_POT_BASEURL;
  const g = prefixGroups();
  if (!g) return null;
  const port = process.env.YTDLP_POT_PORT || '4416';
  return `http://[${g.join(':')}::1]:${port}`;
}

/** A random global address inside the configured /64, or null when disabled. */
export function randomIPv6() {
  const g = prefixGroups();
  if (!g) return null;
  return [...g, randHextet(), randHextet(), randHextet(), randHextet()].join(':');
}

export function isRotationEnabled() {
  return prefixGroups() !== false;
}

/**
 * yt-dlp args binding this run to a fresh /64 address — but ONLY for YouTube targets.
 * Pass the args array about to be spawned; returns ['--source-address', <addr>] when
 * the request targets YouTube and rotation is enabled, else [].
 */
export function ytdlpSourceArgs(args) {
  if (!isRotationEnabled()) return [];
  const joined = Array.isArray(args) ? args.join(' ') : String(args || '');
  if (!/ytsearch|youtube\.com|youtu\.be/i.test(joined)) return [];   // not YouTube
  if (joined.includes('--source-address')) return [];                // already set
  const addr = randomIPv6();
  if (!addr) return [];
  const out = ['--source-address', addr];
  // Keep PO tokens working while bound to a v6 source (see potBaseUrl).
  const burl = potBaseUrl();
  if (burl) out.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${burl}`);
  return out;
}
