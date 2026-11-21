/*
 * Fortnite feed — four sources into one room.
 *
 *   vice        vice.com's Fortnite desk. Three overlapping tags, deduped by URL.
 *   epic_news   fortnite-api.com/v2/news — the in-game message of the day, which
 *               is Epic's own copy rather than anyone's summary of it.
 *   epic_status status.epicgames.com — downtime and incidents.
 *   cosmetics   /v2/cosmetics/new — everything added to the game files in the
 *               latest build. This is the actual leak: it lands days before the
 *               item reaches the shop.
 *   shop        /v2/shop — the daily rotation.
 *
 * Everything is keyed on a stable id per source and written to feed_seen only
 * AFTER the post lands, so a failed send is retried rather than silently skipped.
 */
import cron from 'node-cron';
import { XMLParser } from 'fast-xml-parser';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { resolveFeedTarget } from '../core/feed-target.js';
import { buildFeedContent } from '../core/feed-message.js';
import { findDuplicate } from '../utils/content-similarity.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const MAX_PER_CYCLE = 4;          // a backlog trickles in rather than flooding the room
let task = null;

const VICE_TAGS = ['fortnite', 'fortnite-leaks', 'fortnite-updates'];

/** One readable sentence from an HTML blob, capped so it can't run on. */
function firstSentence(html, cap = 150) {
    const text = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const stop = text.search(/[.!?](\s|$)/);
    const line = stop > 30 ? text.slice(0, stop + 1) : text;
    return line.length > cap ? line.slice(0, cap - 1).trimEnd() + '…' : line;
}

async function getJSON(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return res.json();
}

async function viceItems() {
    const parser = new XMLParser({ ignoreAttributes: false });
    const out = new Map();                       // keyed by link: the tags overlap heavily
    for (const tag of VICE_TAGS) {
        try {
            const res = await fetch(`https://www.vice.com/en/tag/${tag}/feed/`,
                { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
            if (!res.ok) continue;
            const doc = parser.parse(await res.text());
            const items = doc?.rss?.channel?.item;
            for (const it of (Array.isArray(items) ? items : items ? [items] : [])) {
                if (!it.link || out.has(it.link)) continue;
                /* Vice ships no media:content or enclosure — the article photo is
                   only ever an <img> inside the HTML body, so that is where it has
                   to come from. Without it every post is a wall of grey text. */
                const html = String(it['content:encoded'] || it.description || '');
                const img = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || null;
                out.set(it.link, {
                    id: it.link,
                    title: String(it.title || '').trim(),
                    url: it.link,
                    at: it.pubDate ? new Date(it.pubDate) : null,
                    image: img,
                    // One line, not the article. The headline and the picture carry it.
                    blurb: firstSentence(html),
                });
            }
        } catch (e) {
            logger.warn(`[FortniteFeed] vice/${tag}: ${e.message}`, { category: 'fortnite' });
        }
    }
    return [...out.values()];
}

async function epicNews() {
    const d = await getJSON('https://fortnite-api.com/v2/news');
    const motds = d?.data?.br?.motds || [];
    /* The MOTD carries no per-item link — only id, title, body and art — so the
       honest destination is Epic's own news page, which is where these live. */
    return motds.filter((m) => !m.hidden).map((m) => ({
        id: `motd:${m.id || m.title}`,
        title: m.title,
        blurb: firstSentence(m.body),
        url: 'https://www.fortnite.com/news',
        image: m.image || m.tileImage || null,
    }));
}

async function epicStatus() {
    const d = await getJSON('https://status.epicgames.com/api/v2/incidents.json');
    return (d?.incidents || []).slice(0, 5).map((i) => ({
        id: `incident:${i.id}:${i.updated_at}`,
        title: `${i.name} — ${i.status}`,
        url: i.shortlink || 'https://status.epicgames.com',
        blurb: (i.incident_updates?.[0]?.body || '').slice(0, 300),
        at: i.updated_at ? new Date(i.updated_at) : null,
    }));
}

async function newCosmetics() {
    const d = await getJSON('https://fortnite-api.com/v2/cosmetics/new');
    const build = d?.data?.build || 'unknown';
    const items = d?.data?.items?.br || [];
    if (!items.length) return [];
    // One post per build, not one per item: 102 separate messages is a raid, not a feed.
    const names = items.slice(0, 20).map((i) => i.name).filter(Boolean);
    return [{
        id: `cosmetics:${build}`,
        title: `${items.length} new cosmetics found in ${String(build).replace('++Fortnite+Release-', 'v')}`,
        blurb: names.slice(0, 10).join(' · ') + (items.length > 10 ? ` …and ${items.length - 10} more` : ''),
        // These are in the files but not the shop yet, so the shop page would be
        // wrong. fortnite.gg/new is the page that actually lists them.
        url: 'https://fortnite.gg/new',
        image: items.find((i) => i.images?.featured)?.images?.featured
            || items.find((i) => i.images?.icon)?.images?.icon || null,
    }];
}

async function shop() {
    const d = await getJSON('https://fortnite-api.com/v2/shop');
    const date = d?.data?.date?.slice(0, 10);
    const entries = d?.data?.entries || [];
    if (!date || !entries.length) return [];
    const all = entries.flatMap((e) => e.brItems || []);
    const names = [...new Set(all.map((i) => i.name).filter(Boolean))].slice(0, 10);
    return [{
        id: `shop:${date}`,
        title: `Item shop — ${date}`,
        blurb: names.join(' · '),
        url: 'https://www.fortnite.com/item-shop',
        image: all.find((i) => i.images?.featured)?.images?.featured || null,
    }];
}

const SOURCES = {
    vice:        { label: 'Vice',              colour: 0xE0454F, fetch: viceItems },
    epic_news:   { label: 'In game right now',  colour: 0x00C8FF, fetch: epicNews },
    epic_status: { label: 'Epic status',       colour: 0xE8A33D, fetch: epicStatus },
    cosmetics:   { label: 'New in this build', colour: 0x9B59D0, fetch: newCosmetics },
    shop:        { label: 'Item shop',         colour: 0x5DCFA6, fetch: shop },
};

async function seen(guildId, source, id) {
    const [rows] = await pool.execute(
        'SELECT 1 FROM fortnite_feed_seen WHERE guild_id=? AND source=? AND item_id=? LIMIT 1',
        [guildId, source, String(id).slice(0, 255)]);
    return rows.length > 0;
}

async function runFeed(client) {
    let feeds;
    try {
        [feeds] = await pool.execute('SELECT * FROM fortnite_feeds WHERE enabled = 1');
    } catch (e) {
        logger.error(`[FortniteFeed] could not load feeds: ${e.message}`, { category: 'fortnite' });
        return;
    }
    if (!feeds.length) return;

    for (const feed of feeds) {
        const wanted = JSON.parse(feed.sources || '[]');
        let guild = client.guilds.cache.get(feed.guild_id);
        if (!guild && global.botManager?.clients) {
            for (const [, c] of global.botManager.clients) {
                const g = c.guilds.cache.get(feed.guild_id);
                if (g) { guild = g; break; }
            }
        }
        // No bot of ours is in that server (H-315): nothing to post to and nothing to warn about.
        // The feed is picked up again as soon as a bot is back.
        if (!guild) continue;
        // Through the client that has the guild, so a thread (even an archived one) resolves too.
        const { channel, problem } = await resolveFeedTarget(guild.client || client, feed.channel_id, { guildId: feed.guild_id });
        if (!channel) {
            logger.warn(`[FortniteFeed] feed ${feed.id}: ${problem}`, { category: 'fortnite' });
            continue;
        }

        /* Everything already in the room, including messages from channels the
           owner has FOLLOWED — Epic's own #announcements and #fortnite-status-feed
           arrive here as webhook posts. Those are the ones our feed is most likely
           to repeat, so they have to be part of the comparison. Read once per
           cycle rather than per item. */
        let recent = [];
        try {
            const fetched = await channel.messages.fetch({ limit: 60 });
            const cutoff = Date.now() - 1000 * 60 * 60 * 72;   // three days is plenty
            recent = [...fetched.values()]
                .filter((m) => m.createdTimestamp >= cutoff)
                .map((m) => ({
                    text: [m.content, ...(m.embeds || []).flatMap((e) => [e.title, e.description])]
                        .filter(Boolean).join(' '),
                    url: (m.embeds || []).map((e) => e.url).find(Boolean) || null,
                    who: m.author?.username,
                }));
        } catch (e) {
            // Can't read the room: post rather than go silent, and say why.
            logger.warn(`[FortniteFeed] could not read recent history: ${e.message}`, { category: 'fortnite' });
        }

        // The feed's ping role (Social feeds page, migration 480), in front of each post.
        const ping = buildFeedContent({ template: null, vars: {}, pingRoleId: feed.ping_role_id });
        let posted = 0;
        for (const key of wanted) {
            const src = SOURCES[key];
            if (!src || posted >= MAX_PER_CYCLE) continue;
            let items = [];
            try { items = await src.fetch(); }
            catch (e) { logger.warn(`[FortniteFeed] ${key}: ${e.message}`, { category: 'fortnite' }); continue; }

            /* Priming.
             *
             * Some sources carry no date. Epic's message of the day is a rotating
             * promo carousel — it shows whatever Epic is pushing right now, which
             * can be a collab that launched weeks ago. /cosmetics/new reports the
             * latest build, which may also be days old. With no timestamp the
             * watermark can't judge them, so on the very first sight of a source
             * we record everything it currently holds as seen and post none of it.
             * From then on only genuinely new entries appear. Without this the
             * feed opens by announcing old news as though it just happened.
             */
            const [[primed]] = await pool.execute(
                'SELECT COUNT(*) AS n FROM fortnite_feed_seen WHERE guild_id=? AND source=?',
                [feed.guild_id, key]);
            if (primed.n === 0 && items.length) {
                for (const item of items) {
                    await pool.execute(
                        'INSERT IGNORE INTO fortnite_feed_seen (guild_id,source,item_id) VALUES (?,?,?)',
                        [feed.guild_id, key, String(item.id).slice(0, 255)]);
                }
                logger.info(`[FortniteFeed] primed ${key} with ${items.length} existing item(s) — none posted`,
                    { category: 'fortnite' });
                continue;
            }

            // Oldest first, so a backlog arrives in the order it happened.
            items.sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0));
            for (const item of items) {
                if (posted >= MAX_PER_CYCLE) break;
                if (await seen(feed.guild_id, key, item.id)) continue;
                // Nothing published before the feed was switched on.
                if (feed.posted_from && item.at && item.at <= new Date(feed.posted_from)) {
                    await pool.execute(
                        'INSERT IGNORE INTO fortnite_feed_seen (guild_id,source,item_id) VALUES (?,?,?)',
                        [feed.guild_id, key, String(item.id).slice(0, 255)]);
                    continue;
                }
                const embed = {
                    author: { name: src.label },
                    title: item.title?.slice(0, 256),
                    description: item.blurb || undefined,
                    url: item.url || undefined,
                    color: src.colour,
                };
                // Only stamp a time we actually know. Stamping "now" on an undated
                // item is how a three-week-old promo ends up looking like breaking news.
                if (item.at) embed.timestamp = item.at.toISOString();
                // A feed post with nothing to click is a dead end. Every source
                // above supplies one; this is the guard that keeps it true.
                if (!embed.url) {
                    logger.warn(`[FortniteFeed] ${key}/${item.id} has no link — skipped`, { category: 'fortnite' });
                    continue;
                }
                /* Full-width image rather than the little corner thumbnail. These
                   are feed posts people scroll past — the picture is what stops them,
                   and the headline plus one line is all the text that earns its place. */
                if (item.image) embed.image = { url: item.image };

                /* Already covered? Mark it seen and move on. Recording it matters:
                   otherwise every cycle re-tests the same item forever. */
                const dupe = findDuplicate(item, recent, { threshold: feed.dedupe_threshold ?? 0.5 });
                if (dupe) {
                    logger.info(`[FortniteFeed] skipped "${String(item.title).slice(0, 60)}" — ${dupe.reason}` +
                        ` (${dupe.score.toFixed(2)}) vs ${dupe.match.who}: "${String(dupe.match.text).slice(0, 60)}"`,
                        { category: 'fortnite' });
                    await pool.execute(
                        'INSERT IGNORE INTO fortnite_feed_seen (guild_id,source,item_id) VALUES (?,?,?)',
                        [feed.guild_id, key, String(item.id).slice(0, 255)]);
                    continue;
                }

                try {
                    await channel.send({ content: ping.content, allowedMentions: ping.allowedMentions, embeds: [embed] });
                    // Our own post counts against the next item in this same cycle.
                    recent.push({ text: `${item.title || ''} ${item.blurb || ''}`, url: item.url || null, who: 'us' });
                } catch (e) {
                    logger.error(`[FortniteFeed] send failed (${key}/${item.id}): ${e.message}`, { category: 'fortnite' });
                    continue;                      // leave it unseen so the next cycle retries
                }
                await pool.execute(
                    'INSERT IGNORE INTO fortnite_feed_seen (guild_id,source,item_id) VALUES (?,?,?)',
                    [feed.guild_id, key, String(item.id).slice(0, 255)]);
                posted++;
                await new Promise((r) => setTimeout(r, 1200));
            }
        }
        if (posted) logger.info(`[FortniteFeed] posted ${posted} item(s) to ${feed.guild_id}`, { category: 'fortnite' });
        await pool.execute('UPDATE fortnite_feeds SET last_checked = NOW() WHERE id = ?', [feed.id]);
    }
}

export function startFortniteFeedChecker(client) {
    if (task) return;
    task = cron.schedule('*/20 * * * *', () => runFeed(client));
    logger.info('[FortniteFeed] checker started (every 20 minutes)', { category: 'fortnite' });
}
export function stopFortniteFeedChecker() { task?.stop(); task = null; }
export { runFeed as runFortniteFeedOnce };
