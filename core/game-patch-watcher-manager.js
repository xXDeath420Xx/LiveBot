// Generic per-game patch-note watcher.
//
// Each game_patch_watchers row points at one game in one guild + one provider.
// Providers:
//   - rss            : any RSS 2.0 / Atom feed. Covers most publishers (Riot, Blizzard,
//                      Bungie, Mojang, Rockstar, Valve…) with no per-site code.
//   - steam-news     : official Steam news API by appid, via utils/services/steam-api.js
//   - cod-blog       : scrapes www.callofduty.com/blog HTML (no JS rendering needed)
//   - fortnite-news  : uses Playwright to render fortnite.com/news (SPA + Cloudflare)
//   - twitter-rss    : relays a Twitter/X account via the Nitter-RSS helper
//
// Prefer `rss` and `steam-news` for new games — a bespoke scraper is only worth writing
// when a publisher ships no feed at all. See core/game-news-presets.js for the catalogue
// of known titles, which is what the dashboard and /gamenews offer by name.
//
// First poll after row creation does NOT post — it primes last_seen_ids with the
// currently-visible items so the next poll only fires on what's actually new.

import { EmbedBuilder } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { presetColor } from './game-news-presets.js';

const PROVIDERS = {};

/** Accepts "#RRGGBB", "RRGGBB" or a plain integer. Returns null for anything unusable. */
function parseColor(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseInt(String(v).replace(/^#/, ''), 16);
  return Number.isFinite(n) ? n : null;
}

class GamePatchWatcherManager {
  constructor(client) {
    this.client = client;
  }

  async pollAll() {
    const [rows] = await pool.execute(`
      SELECT * FROM game_patch_watchers
       WHERE is_enabled = 1
         AND (last_checked_at IS NULL
              OR last_checked_at <= DATE_SUB(NOW(), INTERVAL check_interval_minutes MINUTE))
    `);
    for (const row of rows) {
      // Only the client actually serving this guild should poll/post.
      // (We have N bot clients in the same process; without this, 31 bots all
      // run Playwright in parallel and race on last_seen_ids updates.)
      if (!this.client.guilds.cache.has(row.guild_id)) continue;
      try {
        await this.pollOne(row);
      } catch (err) {
        logger.error(`[GamePatchWatcher] poll failed for row ${row.id} (${row.game_label}): ${err.message}`, { stack: err.stack });
        // Surface the failure on the dashboard instead of burying it in the log. Stamp
        // last_checked_at too, so a permanently broken feed backs off to its own interval
        // rather than being retried on every single cron cycle.
        await pool.execute(
          'UPDATE game_patch_watchers SET last_error = ?, last_checked_at = NOW() WHERE id = ?',
          [String(err.message).slice(0, 500), row.id]
        ).catch(() => {});
      }
    }
  }

  async pollOne(row) {
    const provider = PROVIDERS[row.provider];
    if (!provider) {
      logger.warn(`[GamePatchWatcher] unknown provider "${row.provider}" on row ${row.id}`);
      return;
    }
    const cfg = row.provider_config ? JSON.parse(row.provider_config) : {};
    const items = await provider(cfg, row);

    const lastSeen = row.last_seen_ids
      ? (Array.isArray(row.last_seen_ids) ? row.last_seen_ids : JSON.parse(row.last_seen_ids))
      : [];

    // First poll - prime, do not post
    if (lastSeen.length === 0) {
      const primed = items.map(it => it.id);
      await pool.execute(
        'UPDATE game_patch_watchers SET last_seen_ids = ?, last_checked_at = NOW(), last_error = NULL WHERE id = ?',
        [JSON.stringify(primed), row.id]
      );
      logger.info(`[GamePatchWatcher] primed "${row.game_label}" with ${primed.length} current items - next poll will detect new ones only`);
      return;
    }

    const seenSet = new Set(lastSeen);
    const newItems = items.filter(it => !seenSet.has(it.id));

    if (newItems.length === 0) {
      await pool.execute(
        'UPDATE game_patch_watchers SET last_checked_at = NOW(), last_error = NULL WHERE id = ?',
        [row.id]
      );
      return;
    }

    // Post oldest-first so the channel reads chronologically
    for (const item of newItems.slice().reverse()) {
      await this.postItem(row, item);
      await new Promise(r => setTimeout(r, 800));
    }

    const merged = [...newItems.map(i => i.id), ...lastSeen].slice(0, 200);
    await pool.execute(
      'UPDATE game_patch_watchers SET last_seen_ids = ?, last_checked_at = NOW(), last_posted_at = NOW(), last_error = NULL WHERE id = ?',
      [JSON.stringify(merged), row.id]
    );
    logger.info(`[GamePatchWatcher] posted ${newItems.length} new item(s) for "${row.game_label}"`);
  }

  async postItem(row, item) {
    const guild = this.client.guilds.cache.get(row.guild_id);
    if (!guild) {
      logger.warn(`[GamePatchWatcher] guild ${row.guild_id} not in this client's cache`);
      return;
    }
    const channel = guild.channels.cache.get(row.channel_id);
    if (!channel || !channel.isTextBased()) {
      logger.warn(`[GamePatchWatcher] channel ${row.channel_id} missing or non-text in ${guild.name}`);
      return;
    }

    // Per-watcher colour wins; otherwise the preset's brand colour; otherwise the provider default.
    const providerColors = {
      'cod-blog':      0xC72C41,
      'fortnite-news': 0x751F1F,
      'steam-news':    0x1B2838,
      'twitter-rss':   0x1DA1F2,
      'rss':           0xEE802F,
    };
    const color = parseColor(row.embed_color)
      ?? presetColor(row.preset_key)
      ?? providerColors[row.provider]
      ?? 0x5865F2;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: row.game_label })
      .setTitle(item.title?.slice(0, 256) || '(untitled)')
      .setURL(item.url || null)
      .setDescription((item.description || '').slice(0, 1900) || '​');
    if (item.image) embed.setImage(item.image);
    if (item.posted_at) embed.setTimestamp(new Date(item.posted_at));

    const content = row.role_ping_id ? `<@&${row.role_ping_id}>` : '';
    await channel.send({
      content,
      embeds: [embed],
      allowedMentions: { roles: row.role_ping_id ? [row.role_ping_id] : [] },
    });
  }
}

// --- Providers ----------------------------------------------------------

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Strip HTML/BBCode down to something readable in an embed description. */
function toPlainText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')          // HTML tags
      .replace(/\[\/?[a-z][^\]]*\]/gi, '') // Steam BBCode
  ).replace(/\n{3,}/g, '\n\n').trim();
}

/** First image URL in a blob of HTML, if any. */
function firstImage(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** fast-xml-parser hands back a bare object when a list has one entry. */
function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Decode a feed response using its declared charset.
 *
 * `Response.text()` is specified to always decode as UTF-8, ignoring the charset in
 * Content-Type. Minecraft's official feed is served as utf-16 — through .text() it comes
 * back as interleaved NUL bytes and parses to zero items with no error, which is the worst
 * possible failure mode. Read the bytes and pick the decoder ourselves: BOM first (most
 * reliable), then the Content-Type charset, then the XML declaration.
 */
async function decodeFeed(res) {
  const buf = new Uint8Array(await res.arrayBuffer());

  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);

  const header = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1];
  // Sniff the declaration from the first bytes as UTF-8; harmless if the body is not UTF-8,
  // because a mis-sniff just falls through to the utf-8 default below.
  const declared = /encoding=["']([\w-]+)["']/i.exec(
    new TextDecoder('utf-8').decode(buf.subarray(0, 200))
  )?.[1];

  const charset = (header || declared || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

PROVIDERS['rss'] = async function fetchRss(cfg, _row) {
  // Handles RSS 2.0 (<channel><item>) and Atom (<feed><entry>) with one parser.
  // Config: { url, maxItems?, include?: [str], exclude?: [str] }
  const url = cfg.url;
  if (!url) return [];

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
  const xml = await decodeFeed(res);

  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const rawItems = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? parsed?.['rdf:RDF']?.item ?? [];

  const items = [];
  for (const it of asArray(rawItems)) {
    // Three shapes in the wild: RSS <link>text</link>, Atom <link href="…"/>, and RSS feeds
    // that embed an Atom link under a namespace prefix — Minecraft's official feed carries
    // its only URL as <a10:link href="…"/> with no plain <link> at all.
    let link = it.link
      ?? Object.entries(it).find(([k, v]) => /(^|:)link$/.test(k) && v)?.[1]
      ?? null;
    if (Array.isArray(link)) link = link.find(l => !l['@_rel'] || l['@_rel'] === 'alternate') ?? link[0];
    if (link && typeof link === 'object') link = link['@_href'] ?? link['#text'] ?? null;

    const title = typeof it.title === 'object' ? (it.title['#text'] ?? '') : (it.title ?? '');
    const bodyHtml = it['content:encoded'] ?? it.content?.['#text'] ?? it.content
      ?? it.description ?? it.summary?.['#text'] ?? it.summary ?? '';

    // guid/id is the stable identity; fall back to the link, then the title.
    const guid = it.guid?.['#text'] ?? it.guid ?? it.id ?? link ?? title;

    const image = it.enclosure?.['@_url']
      ?? it['media:thumbnail']?.['@_url']
      ?? it['media:content']?.['@_url']
      ?? firstImage(bodyHtml);

    items.push({
      id: String(guid),
      title: decodeEntities(String(title)),
      description: toPlainText(bodyHtml),
      image: image || null,
      url: link ? String(link) : null,
      posted_at: it.pubDate ?? it.published ?? it.updated ?? it['dc:date'] ?? null,
    });
  }

  return applyKeywordFilters(items, cfg).slice(0, cfg.maxItems || 10);
};

PROVIDERS['steam-news'] = async function fetchSteamNews(cfg, _row) {
  // Config: { appid, maxItems?, feeds?: [str], include?, exclude? }
  // `feeds` restricts to specific Steam feed names — "steam_community_announcements"
  // is the one that carries actual patch notes; leaving it unset takes everything.
  const appid = cfg.appid;
  if (!appid) return [];

  const { default: SteamAPIService } = await import('../utils/services/steam-api.js');
  const steam = new SteamAPIService();
  // Push the feed filter down to Steam — it applies `count` before filtering, so narrowing
  // afterwards silently yields nothing for any game whose recent news is mostly press.
  const news = await steam.getAppNews(String(appid), cfg.maxItems || 10, cfg.feeds || null);

  const items = [];
  for (const n of news) {
    items.push({
      id: String(n.gid),
      title: n.title || '(untitled)',
      description: toPlainText(n.contents),
      image: firstImage(n.contents),
      url: n.url || null,
      // Steam returns seconds since epoch.
      posted_at: n.date ? new Date(n.date * 1000).toISOString() : null,
    });
  }

  return applyKeywordFilters(items, cfg);
};

/**
 * Optional per-watcher keyword narrowing, so one busy feed can be split into
 * "patch notes only" and "everything else" watchers pointed at different channels.
 */
function applyKeywordFilters(items, cfg) {
  const include = (cfg.include || []).map(s => s.toLowerCase());
  const exclude = (cfg.exclude || []).map(s => s.toLowerCase());
  if (!include.length && !exclude.length) return items;

  return items.filter(it => {
    const hay = `${it.title} ${it.description}`.toLowerCase();
    if (exclude.some(e => hay.includes(e))) return false;
    return include.length === 0 || include.some(i => hay.includes(i));
  });
}

PROVIDERS['twitter-rss'] = async function fetchTwitterRss(cfg, _row) {
  // Pulls @username via the existing Nitter-RSS helper. Filters quote-retweets
  // (where the body is just an [x.com/i/article/…] placeholder) and replies (text
  // starting with @) so the stable-ID dedup isn't broken by filtered-out anchors.
  const username = (cfg.username || '').replace(/^@/, '');
  if (!username) return [];
  const { getUserTweets } = await import('../utils/platforms/twitter-api.js');
  const tweets = await getUserTweets(username, cfg.fetchCount || 15);
  if (!tweets?.length) return [];

  const isQuoteRTPlaceholder = (text) => /^\[x\.com\/i\/article\//i.test((text || '').trim());
  const isReply = (text) => /^@\w/.test((text || '').trim());

  const items = [];
  for (const t of tweets) {
    const text = t.text || '';
    if (isQuoteRTPlaceholder(text)) continue;
    if (cfg.skipReplies !== false && isReply(text)) continue;
    items.push({
      id: t.id,
      title: text.slice(0, 240) || '(no text)',
      description: text,
      image: t.image || null,
      url: t.url || `https://twitter.com/${username}/status/${t.id}`,
      posted_at: t.timestamp || t.created_at || null,
    });
  }
  return items;
};

PROVIDERS['cod-blog'] = async function fetchCodBlog(cfg, _row) {
  const filter = cfg.include || ['black-ops', 'warzone'];
  const exclude = cfg.exclude || ['mobile'];
  const html = await fetch('https://www.callofduty.com/blog', {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
  }).then(r => r.text());

  const urls = [...new Set(
    [...html.matchAll(/data-produrl="(https:\/\/www\.callofduty\.com\/blog\/[^"]+)"/g)].map(m => m[1])
  )];
  const filtered = urls.filter(u => {
    const lower = u.toLowerCase();
    if (exclude.some(e => lower.includes(e.toLowerCase()))) return false;
    return filter.some(i => lower.includes(i.toLowerCase()));
  }).slice(0, 8); // cap per-poll work

  const items = [];
  for (const url of filtered) {
    try {
      const articleHtml = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      }).then(r => r.text());
      const og = (prop) => {
        const m = articleHtml.match(new RegExp(`<meta\\s+property="og:${prop}"\\s+content="([^"]+)"`, 'i'));
        return m ? decodeEntities(m[1]) : null;
      };
      const title = og('title') || url.split('/').slice(-1)[0].replace(/-/g, ' ');
      const description = og('description') || '';
      const image = og('image');
      items.push({ id: url, title, description, image, url });
    } catch (err) {
      logger.warn(`[GamePatchWatcher][cod-blog] could not fetch ${url}: ${err.message}`);
    }
  }
  return items;
};

let _playwrightBrowser = null;
async function getBrowser() {
  if (_playwrightBrowser && _playwrightBrowser.isConnected()) return _playwrightBrowser;
  const { chromium } = await import('playwright');
  _playwrightBrowser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  return _playwrightBrowser;
}

PROVIDERS['fortnite-news'] = async function fetchFortniteNews(cfg, _row) {
  // fortnite.com/news is an SPA behind Cloudflare; need real browser rendering.
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  try {
    logger.info('[GamePatchWatcher][fortnite-news] navigating to fortnite.com/news');
    const resp = await page.goto('https://www.fortnite.com/news', { waitUntil: 'domcontentloaded', timeout: 45000 });
    logger.info(`[GamePatchWatcher][fortnite-news] index loaded status=${resp?.status()} title="${await page.title()}"`);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      logger.warn('[GamePatchWatcher][fortnite-news] networkidle timed out on index — proceeding anyway');
    });

    // Collect article links via locator API
    const handles = await page.locator('a[href^="/news/"]').elementHandles();
    const slugSet = new Set();
    for (const h of handles) {
      const href = await h.getAttribute('href');
      if (href && /^\/news\/[a-z0-9-]+$/i.test(href)) slugSet.add(href);
    }
    const slugs = [...slugSet];
    logger.info(`[GamePatchWatcher][fortnite-news] found ${handles.length} anchors, ${slugs.length} unique article slugs`);

    const items = [];
    const cap = cfg.maxArticles || 6;
    for (const slug of slugs.slice(0, cap)) {
      const fullUrl = 'https://www.fortnite.com' + slug;
      try {
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

        // Read og: meta tags via locator getAttribute (no script injection)
        const titleEl = page.locator('meta[property="og:title"]').first();
        const descEl  = page.locator('meta[property="og:description"]').first();
        const imgEl   = page.locator('meta[property="og:image"]').first();
        const title = (await titleEl.getAttribute('content').catch(() => null)) || (await page.title());
        const description = await descEl.getAttribute('content').catch(() => '');
        const image = await imgEl.getAttribute('content').catch(() => null);

        items.push({ id: fullUrl, title, description: description || '', image, url: fullUrl });
      } catch (err) {
        logger.warn(`[GamePatchWatcher][fortnite-news] could not render ${fullUrl}: ${err.message}`);
      }
    }
    logger.info(`[GamePatchWatcher][fortnite-news] returning ${items.length} items`);
    return items;
  } finally {
    await ctx.close();
  }
};

export default GamePatchWatcherManager;
export { PROVIDERS };
