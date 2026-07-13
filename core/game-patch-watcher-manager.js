// Generic per-game patch-note watcher.
//
// Each game_patch_watchers row points at one game in one guild + one provider.
// Providers:
//   - cod-blog       : scrapes www.callofduty.com/blog HTML (no JS rendering needed)
//   - fortnite-news  : uses Playwright to render fortnite.com/news (SPA + Cloudflare)
//
// First poll after row creation does NOT post — it primes last_seen_ids with the
// currently-visible items so the next poll only fires on what's actually new.

import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const PROVIDERS = {};

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
        'UPDATE game_patch_watchers SET last_seen_ids = ?, last_checked_at = NOW() WHERE id = ?',
        [JSON.stringify(primed), row.id]
      );
      logger.info(`[GamePatchWatcher] primed "${row.game_label}" with ${primed.length} current items - next poll will detect new ones only`);
      return;
    }

    const seenSet = new Set(lastSeen);
    const newItems = items.filter(it => !seenSet.has(it.id));

    if (newItems.length === 0) {
      await pool.execute('UPDATE game_patch_watchers SET last_checked_at = NOW() WHERE id = ?', [row.id]);
      return;
    }

    // Post oldest-first so the channel reads chronologically
    for (const item of newItems.slice().reverse()) {
      await this.postItem(row, item);
      await new Promise(r => setTimeout(r, 800));
    }

    const merged = [...newItems.map(i => i.id), ...lastSeen].slice(0, 200);
    await pool.execute(
      'UPDATE game_patch_watchers SET last_seen_ids = ?, last_checked_at = NOW() WHERE id = ?',
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

    const colors = {
      'cod-blog':       0xC72C41,
      'fortnite-news':  0x751F1F,
    };

    const embed = new EmbedBuilder()
      .setColor(colors[row.provider] ?? 0x5865F2)
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
