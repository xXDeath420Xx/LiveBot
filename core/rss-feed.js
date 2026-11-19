/*
 * Generic RSS / Atom feeds (blogs, news sites, podcasts), polled with the other social feeds by
 * jobs/social-feed-scheduler.js every 15 minutes. Rows live in rss_feeds and are managed on the
 * Social feeds page (dashboard/routes/api/features/feeds.js).
 *
 * The URL is chosen by a server admin, so every fetch goes through utils/safe-fetch.js (public
 * addresses only, checked on every redirect, size and time capped).
 *
 * New items are found by remembering the items already seen (seen_ids, hashed keys), not "the newest
 * one", because many feeds reorder or re-date items. A feed added from the dashboard is baselined there
 * (its current items are remembered, nothing is posted); a row with no seen_ids is baselined on its first
 * check the same way. Message template, ping role and title filters come from core/feed-message.js.
 */
import crypto from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { safeFetch } from '../utils/safe-fetch.js';
import { themeColor } from './guild-theme.js';
import { buildFeedContent, titlePasses } from './feed-message.js';
import { pollsGuild } from './guild-presence-logic.js';

export const RSS_MAX_PER_GUILD = 10;
const SEEN_KEEP = 150;
const MAX_NEW_PER_CHECK = 3;
const MAX_BYTES = 4 * 1024 * 1024;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: true });

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
/** Text of a parsed node: a string, a number, or an object carrying '#text'. */
function text(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return text(v[0]);
    if (typeof v === 'object') return text(v['#text'] ?? '');
    return String(v).trim();
}
function stripHtml(html) {
    return String(html || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
function httpUrl(u) {
    const s = text(u);
    return /^https?:\/\//i.test(s) ? s : null;
}
function atomLink(links) {
    const list = asArray(links);
    const alt = list.find(l => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) || list[0];
    return httpUrl(typeof alt === 'object' ? alt['@_href'] : alt);
}
const keyOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 20);

/**
 * Items of an RSS 2.0, RSS 1.0 (RDF) or Atom document, newest first as the feed lists them.
 * @returns {{ title:string|null, items: Array<{key,title,url,published,summary,image,author,audio}> }}
 */
export function parseFeed(xml) {
    const doc = parser.parse(String(xml || ''));
    let title = null;
    let raw = [];
    let kind = null;
    if (doc?.rss?.channel) {
        const ch = asArray(doc.rss.channel)[0];
        title = text(ch.title) || null;
        raw = asArray(ch.item);
        kind = 'rss';
    } else if (doc?.feed) {
        title = text(doc.feed.title) || null;
        raw = asArray(doc.feed.entry);
        kind = 'atom';
    } else if (doc?.['rdf:RDF']) {
        title = text(doc['rdf:RDF'].channel?.title) || null;
        raw = asArray(doc['rdf:RDF'].item);
        kind = 'rss';
    } else {
        throw new Error('This is not an RSS or Atom feed');
    }
    const channelImage = kind === 'rss'
        ? httpUrl(asArray(doc?.rss?.channel)[0]?.['itunes:image']?.['@_href']) || httpUrl(asArray(doc?.rss?.channel)[0]?.image?.url)
        : null;
    const items = raw.map(it => {
        const url = kind === 'atom' ? atomLink(it.link) : httpUrl(it.link) || httpUrl(it.guid);
        const itemTitle = stripHtml(text(it.title)) || 'Untitled';
        const published = text(it.pubDate || it.published || it.updated || it['dc:date']) || null;
        const summary = stripHtml(text(it.description || it.summary || it['content:encoded'] || it.content || it['itunes:summary']));
        const enclosure = asArray(it.enclosure)[0];
        const encType = String(enclosure?.['@_type'] || '');
        const media = asArray(it['media:content'])[0] || asArray(it['media:group']?.['media:content'])[0];
        const image = httpUrl(it['itunes:image']?.['@_href'])
            || httpUrl(asArray(it['media:thumbnail'])[0]?.['@_url'])
            || (String(media?.['@_medium'] || media?.['@_type'] || '').startsWith('image') ? httpUrl(media?.['@_url']) : null)
            || (encType.startsWith('image/') ? httpUrl(enclosure?.['@_url']) : null)
            || channelImage;
        const audio = encType.startsWith('audio/') ? httpUrl(enclosure?.['@_url']) : null;
        const author = stripHtml(text(it.author?.name ?? it.author ?? it['dc:creator'] ?? it['itunes:author'])) || null;
        const id = text(it.guid) || text(it.id) || url || `${itemTitle}|${published || ''}`;
        return { key: keyOf(id), title: itemTitle, url, published, summary, image, author, audio };
    });
    return { title, items };
}

/** Fetch and parse a feed URL under the safe-fetch rules. A cut-off (oversized) document is closed after its last whole item. */
export async function fetchFeed(url) {
    const res = await safeFetch(url, {
        timeoutMs: 15000, maxBytes: MAX_BYTES, maxRedirects: 3,
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
    });
    let body = res.text;
    if (res.truncated) {
        const lastItem = Math.max(body.lastIndexOf('</item>'), body.lastIndexOf('</entry>'));
        if (lastItem < 0) throw new Error('The feed is too large');
        const close = body.lastIndexOf('</entry>') > body.lastIndexOf('</item>') ? '</feed>' : '</channel></rss>';
        body = body.slice(0, lastItem + (body.startsWith('</entry>', lastItem) ? 8 : 7)) + close;
    }
    return parseFeed(body);
}

export async function checkRssFeeds(client) {
    let feeds;
    try {
        [feeds] = await pool.execute('SELECT * FROM rss_feeds WHERE suspended_until IS NULL OR suspended_until < NOW()');
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') return; // migration not run yet
        throw e;
    }
    // Every bot client runs the check; each handles the servers it is in.
    // One bot per server (H-315: core/guild-presence-logic.js pollsGuild).
    const mine = feeds.filter(f => pollsGuild(client, f.guild_id, global.botManager));
    for (const feed of mine) {
        await processRssFeed(feed, client);
    }
}

const parseSeen = (raw) => {
    if (!raw) return null;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
};

export async function processRssFeed(feed, client) {
    try {
        const { title: feedTitle, items } = await fetchFeed(feed.feed_url);
        const seen = parseSeen(feed.seen_ids);
        const keys = items.map(i => i.key);
        if (!seen) {
            await pool.execute(
                'UPDATE rss_feeds SET seen_ids = ?, feed_title = COALESCE(feed_title, ?), failed_count = 0, last_error = NULL, last_checked = NOW() WHERE id = ?',
                [JSON.stringify(keys.slice(0, SEEN_KEEP)), feedTitle ? feedTitle.slice(0, 255) : null, feed.id]);
            return;
        }
        const known = new Set(seen);
        const fresh = items.filter(i => !known.has(i.key)).slice(0, MAX_NEW_PER_CHECK).reverse();
        const nextSeen = JSON.stringify([...new Set([...keys, ...seen])].slice(0, SEEN_KEEP));
        if (!fresh.length) {
            await pool.execute('UPDATE rss_feeds SET seen_ids = ?, failed_count = 0, last_error = NULL, last_checked = NOW() WHERE id = ?', [nextSeen, feed.id]);
            return;
        }
        const guild = client.guilds.cache.get(feed.guild_id);
        const channel = guild ? await guild.channels.fetch(feed.channel_id).catch(() => null) : null;
        if (!channel) {
            logger.warn(`[RssFeed] Feed ${feed.id}: channel ${feed.channel_id} not found`);
            return;
        }
        const name = feed.feed_title || feedTitle || new URL(feed.feed_url).hostname;
        let posted = 0;
        for (const item of fresh) {
            if (!titlePasses({ include: feed.title_include, exclude: feed.title_exclude }, item.title)) continue;
            const embed = new EmbedBuilder()
                .setColor(themeColor(feed.guild_id, 'primary'))
                .setTitle(item.title.slice(0, 256))
                .setAuthor({ name: name.slice(0, 256) })
                .setFooter({ text: item.author ? `${item.author.slice(0, 100)} · RSS` : 'RSS' });
            if (item.url) embed.setURL(item.url);
            if (item.summary) embed.setDescription(item.summary.length > 350 ? `${item.summary.slice(0, 350)}…` : item.summary);
            if (item.image) embed.setThumbnail(item.image);
            if (item.audio) embed.addFields({ name: 'Episode', value: `[Listen](${item.audio.replace(/\)/g, '%29')})`, inline: true });
            const date = item.published ? new Date(item.published) : null;
            if (date && !Number.isNaN(date.getTime())) embed.setTimestamp(date);
            const { content, allowedMentions } = buildFeedContent({
                template: feed.custom_message,
                pingRoleId: feed.ping_role_id,
                vars: { feed: name, title: item.title, url: item.url || '', author: item.author || '' },
            });
            await channel.send({ content, allowedMentions: allowedMentions || { parse: [] }, embeds: [embed] });
            posted++;
        }
        await pool.execute(
            'UPDATE rss_feeds SET seen_ids = ?, feed_title = COALESCE(feed_title, ?), failed_count = 0, last_error = NULL, last_checked = NOW() WHERE id = ?',
            [nextSeen, feedTitle ? feedTitle.slice(0, 255) : null, feed.id]);
        if (posted) logger.info(`[RssFeed] Feed ${feed.id} posted ${posted} item(s) to ${feed.channel_id}`);
    } catch (error) {
        // Same breaker as the YouTube feed: 5 failures in a row pause the feed for 24 hours.
        try {
            await pool.execute(
                `UPDATE rss_feeds
                    SET failed_count = failed_count + 1, last_error = ?, last_checked = NOW(),
                        suspended_until = CASE WHEN failed_count + 1 >= 5 THEN DATE_ADD(NOW(), INTERVAL 24 HOUR) ELSE suspended_until END
                  WHERE id = ?`,
                // safe-fetch words its errors for custom-command APIs; say "site" on the dashboard.
                [String(error.message || error).replace(/\bThe API\b/g, 'The site').replace(/\bthe API\b/g, 'the site').slice(0, 240), feed.id]);
        } catch { /* do not compound */ }
        logger.warn(`[RssFeed] Feed ${feed.id} (${feed.feed_url}) failed: ${error.message}`);
    }
}
