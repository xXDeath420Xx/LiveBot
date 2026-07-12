/*
 * Guild analyzer — read-only deep scan of a server's history.
 *
 * Why this exists: Discord will not tell us what another bot does. `GET /applications/{id}
 * /guild/{id}/commands` requires that application's own token, and there is no endpoint that
 * lists a foreign bot's commands, config or stored data. The *only* evidence available is what
 * a bot has posted and what users typed to make it post. So we index exactly that.
 *
 * Everything here is REST GET. It never posts, edits, deletes or reacts, which makes it safe to
 * run against a live production guild while the gateway is connected.
 *
 * Output, per bot:
 *   • which channels it speaks in, how often, first and last seen
 *   • the distinct *shapes* of message it sends ("templates" — ids, numbers, mentions and URLs
 *     masked out so `Level 5!` and `Level 12!` collapse into one)
 *   • the user messages that immediately preceded each template (its likely triggers)
 *
 * A template that no feature of ours explains is the thing that stops a retirement. That is the
 * point: it catches the bot quietly doing something in a channel nobody remembered configuring.
 */
import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/** Messages per REST page. Discord's maximum. */
const PAGE = 100;
/** Ceiling on distinct templates kept per bot. Hitting it blocks retirement rather than hiding. */
const MAX_TEMPLATES_PER_BOT = 400;
/** A bot message is attributed to a human message at most this long before it. */
const TRIGGER_WINDOW_MS = 30_000;
/** How far back to look for that human message within the walk. */
const TRIGGER_LOOKAHEAD = 6;
/** Channels scanned at once. Kept low: discord.js queues per-route, but history is heavy. */
const CHANNEL_CONCURRENCY = 3;

const DEPTHS = {
    quick: { maxPerChannel: 1_000, sinceDays: null },
    standard: { maxPerChannel: null, sinceDays: 90 },
    deep: { maxPerChannel: null, sinceDays: null },
};

// ── Templating ───────────────────────────────────────────────────────────────

const MASKS = [
    [/<a?:\w+:\d+>/g, '{emoji}'],
    [/<@!?\d+>/g, '{user}'],
    [/<@&\d+>/g, '{role}'],
    [/<#\d+>/g, '{channel}'],
    [/<t:\d+(?::[tTdDfFR])?>/g, '{time}'],
    [/https?:\/\/\S+/g, '{url}'],
    [/\b\d[\d,._]*\b/g, '{n}'],
];

/** Component types that hold other components. */
const CONTAINER_TYPES = new Set([1 /* action row */, 9 /* section */, 17 /* container */]);

/**
 * Recursively flatten a message's component tree into the text it renders and the controls it
 * offers. Handles both the raw REST shape and discord.js's wrapper classes.
 *
 * @returns {{text: string[], labels: string[]}}
 */
export function walkComponents(components, out = { text: [], labels: [] }, depth = 0) {
    if (depth > 6) return out; // Discord nests 3 deep; this is just a cycle guard.

    for (const node of components ?? []) {
        const c = node?.data ?? node ?? {};
        const type = node?.type ?? c.type;

        if (typeof c.content === 'string' && c.content) out.text.push(c.content); // text display
        const label = c.label ?? c.placeholder ?? c.custom_id ?? c.customId;
        if (label && (type === 2 || type === 3 || (type >= 5 && type <= 8))) out.labels.push(String(label));
        if (type === 12) out.labels.push('media');
        if (type === 13) out.labels.push('file');

        const accessory = node?.accessory ?? c.accessory;
        if (accessory) walkComponents([accessory], out, depth + 1);

        const kids = node?.components ?? c.components;
        if (CONTAINER_TYPES.has(type) || Array.isArray(kids)) walkComponents(kids, out, depth + 1);
    }
    return out;
}

/**
 * Reduce a message to its shape. Two messages with the same shape came from the same code path
 * in the originating bot, which is what we actually want to enumerate.
 */
export function templateOf(msg) {
    const parts = [];

    if (msg.content) parts.push(msg.content);

    for (const e of msg.embeds ?? []) {
        const bits = [e.title, e.author?.name, e.description?.slice(0, 120)].filter(Boolean);
        // Field *names* are structural; their values are data.
        const fields = (e.fields ?? []).map(f => f.name).filter(Boolean);
        if (bits.length || fields.length) parts.push(`embed:${[...bits, ...fields].join('|')}`);
    }

    // Components V2 (containers/sections/text displays). A CV2 message carries its entire text in
    // `components[].content` with EMPTY `content` and EMPTY `embeds` — so a walk that only reads
    // button labels sees a blank message and the bot looks silent. That is not hypothetical: it
    // hid every one of FreeStuff's posts and OwO's guild boss from the first scan of this guild.
    const { text: uiText, labels } = walkComponents(msg.components ?? []);
    if (uiText.length) parts.push(uiText.join('\n'));
    if (labels.length) parts.push(`ui:${labels.join('|')}`);

    if (!parts.length && (msg.attachments?.size || msg.attachments?.length)) parts.push('attachment');

    let text = parts.join(' ⟡ ');
    for (const [re, to] of MASKS) text = text.replace(re, to);
    return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

export const hash16 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * A human message is only interesting as a trigger if it looks like a command: a prefix, a
 * mention, or a single short token. Long prose that happens to precede a bot post is noise.
 */
export function triggerOf(content) {
    const t = String(content || '').trim();
    if (!t || t.length > 60) return null;
    if (/^[!?$.\-+>~%&*]\S/.test(t)) return t.split(/\s+/)[0].slice(0, 32);
    if (/^<@!?\d+>/.test(t)) return '{mention}';
    if (/^\d{1,15}$/.test(t)) return '{number}';
    if (/^\w{1,20}$/.test(t)) return t.toLowerCase();
    return null;
}

// ── Scan lifecycle ───────────────────────────────────────────────────────────

/** In-process handles so a second click cannot start a second scan of the same guild. */
const running = new Map(); // guildId -> { scanId, cancel: boolean }

export function isScanning(guildId) {
    return running.has(guildId);
}

/** Channels we can actually read history from. Anything else is reported, never silently skipped. */
export function scannableChannels(guild) {
    const me = guild.members.me;
    const usable = [];
    const skipped = [];

    for (const ch of guild.channels.cache.values()) {
        const textLike = ch.type === ChannelType.GuildText
            || ch.type === ChannelType.GuildAnnouncement
            || ch.isThread?.();
        if (!textLike) continue;

        const perms = ch.permissionsFor(me);
        if (perms?.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.ReadMessageHistory)) {
            usable.push(ch);
        } else {
            skipped.push({ id: ch.id, name: ch.name, why: 'cannot read history' });
        }
    }
    return { usable, skipped };
}

/**
 * Begin a scan. Returns as soon as the row exists; the walk continues in the background so the
 * dashboard can poll `getScan()` for progress. A crash mid-walk leaves the scan resumable.
 */
export async function startScan(guild, { depth = 'deep', startedBy = null } = {}) {
    if (!DEPTHS[depth]) throw new Error(`unknown depth "${depth}"`);
    if (running.has(guild.id)) throw new Error('a scan is already running for this server');

    const { usable, skipped } = scannableChannels(guild);
    if (skipped.length) {
        logger.warn(`[Analyzer] ${guild.id}: ${skipped.length} channel(s) unreadable, excluded from scan: ` +
            skipped.map(s => `#${s.name}`).join(', '));
    }

    const [res] = await pool.execute(
        'INSERT INTO guild_scans (guild_id, status, depth, started_by, channels_total) VALUES (?, ?, ?, ?, ?)',
        [guild.id, 'running', depth, startedBy, usable.length]);
    const scanId = res.insertId;

    for (const ch of usable) {
        await pool.execute(
            `INSERT INTO guild_scan_channels (scan_id, channel_id, channel_name) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_name = VALUES(channel_name)`,
            [scanId, ch.id, ch.name?.slice(0, 120) ?? null]);
    }

    running.set(guild.id, { scanId, cancel: false });
    // Deliberately not awaited: the HTTP request that started this must return immediately.
    walk(guild, scanId).catch(err => logger.error(`[Analyzer] scan ${scanId} crashed: ${err.stack}`));

    return { scanId, channels: usable.length, skipped };
}

/** Resume a scan that a restart interrupted. Picks each channel up at its stored cursor. */
export async function resumeScan(guild, scanId) {
    if (running.has(guild.id)) throw new Error('a scan is already running for this server');
    const scan = await getScan(scanId);
    if (!scan || scan.guild_id !== guild.id) throw new Error('no such scan for this server');
    if (scan.status === 'complete') throw new Error('that scan already finished');

    await pool.execute("UPDATE guild_scans SET status = 'running', error = NULL WHERE id = ?", [scanId]);
    running.set(guild.id, { scanId, cancel: false });
    walk(guild, scanId).catch(err => logger.error(`[Analyzer] resume ${scanId} crashed: ${err.stack}`));
    return { scanId };
}

export function cancelScan(guildId) {
    const h = running.get(guildId);
    if (!h) return false;
    h.cancel = true;
    return true;
}

// ── The walk ─────────────────────────────────────────────────────────────────

async function walk(guild, scanId) {
    const handle = running.get(guild.id);
    try {
        const scan = await getScan(scanId);
        const limits = DEPTHS[scan.depth];
        const since = limits.sinceDays ? Date.now() - limits.sinceDays * 86_400_000 : null;

        const [pending] = await pool.execute(
            'SELECT * FROM guild_scan_channels WHERE scan_id = ? AND complete = 0', [scanId]);

        // Simple worker pool: CHANNEL_CONCURRENCY channels in flight at once.
        const queue = [...pending];
        const workers = Array.from({ length: Math.min(CHANNEL_CONCURRENCY, queue.length || 1) }, async () => {
            while (queue.length) {
                if (handle?.cancel) return;
                const row = queue.shift();
                const channel = guild.channels.cache.get(row.channel_id);
                if (!channel) {
                    await pool.execute(
                        "UPDATE guild_scan_channels SET complete = 1, error = 'channel gone' WHERE scan_id = ? AND channel_id = ?",
                        [scanId, row.channel_id]);
                    continue;
                }
                try {
                    await walkChannel(scanId, guild, channel, row, limits, since, handle);
                } catch (err) {
                    logger.warn(`[Analyzer] #${channel.name}: ${err.message}`);
                    await pool.execute(
                        'UPDATE guild_scan_channels SET complete = 1, error = ? WHERE scan_id = ? AND channel_id = ?',
                        [String(err.message).slice(0, 255), scanId, row.channel_id]);
                }
                await pool.execute(
                    'UPDATE guild_scans SET channels_done = channels_done + 1, heartbeat_at = NOW() WHERE id = ?', [scanId]);
            }
        });
        await Promise.all(workers);

        if (handle?.cancel) {
            await pool.execute("UPDATE guild_scans SET status = 'cancelled', finished_at = NOW() WHERE id = ?", [scanId]);
        } else {
            await markPresence(scanId, guild);
            await pool.execute("UPDATE guild_scans SET status = 'complete', finished_at = NOW() WHERE id = ?", [scanId]);
            logger.info(`[Analyzer] scan ${scanId} of ${guild.name} complete`);
        }
    } catch (err) {
        await pool.execute("UPDATE guild_scans SET status = 'failed', finished_at = NOW(), error = ? WHERE id = ?",
            [String(err.message).slice(0, 500), scanId]).catch(() => {});
        throw err;
    } finally {
        running.delete(guild.id);
    }
}

/**
 * Page a single channel newest→oldest.
 *
 * Direction matters for trigger attribution: because we walk backwards in time, the human
 * message that *caused* a bot message appears LATER in our iteration, not earlier. So for each
 * bot message we look forward in the array for the first human message within TRIGGER_WINDOW_MS.
 */
async function walkChannel(scanId, guild, channel, row, limits, since, handle) {
    const bots = new Map();      // botId -> aggregate
    const templates = new Map(); // `${botId}:${hash}` -> aggregate

    let before = row.oldest_id || undefined;
    let scanned = row.messages_scanned || 0;
    let carry = [];  // tail of the previous page, so triggers survive page boundaries

    for (;;) {
        if (handle?.cancel) break;

        const page = await channel.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) });
        if (!page.size) break;

        const msgs = [...page.values()]; // newest → oldest
        const window = [...carry, ...msgs];

        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            if (since && msg.createdTimestamp < since) { before = null; break; }

            if (!msg.author?.bot && !msg.webhookId) continue;

            const isWebhook = !!msg.webhookId && !msg.interaction;
            const id = isWebhook ? `wh:${msg.author.username}` : msg.author.id;

            const agg = bots.get(id) ?? {
                id, name: msg.author.username?.slice(0, 120) ?? id,
                kind: isWebhook ? 'webhook' : 'bot',
                messages: 0, first: msg.createdTimestamp, last: msg.createdTimestamp,
                channels: new Set(),
            };
            agg.messages++;
            agg.first = Math.min(agg.first, msg.createdTimestamp);
            agg.last = Math.max(agg.last, msg.createdTimestamp);
            agg.channels.add(channel.id);
            bots.set(id, agg);

            const shape = templateOf(msg);
            if (!shape) continue;
            const key = `${id}:${hash16(shape)}`;
            const t = templates.get(key) ?? { botId: id, hash: hash16(shape), sample: shape, count: 0, triggers: new Set() };
            t.count++;

            // Slash commands name their own trigger. Otherwise, look forward (= earlier in time).
            if (msg.interaction?.commandName) {
                t.triggers.add(`/${msg.interaction.commandName}`);
            } else {
                const start = carry.length + i + 1;
                for (let j = start; j < Math.min(start + TRIGGER_LOOKAHEAD, window.length); j++) {
                    const cand = window[j];
                    if (!cand || cand.author?.bot || cand.webhookId) continue;
                    if (msg.createdTimestamp - cand.createdTimestamp > TRIGGER_WINDOW_MS) break;
                    const trig = triggerOf(cand.content);
                    if (trig) t.triggers.add(trig);
                    break;
                }
            }
            templates.set(key, t);
        }

        scanned += msgs.length;
        const oldest = msgs[msgs.length - 1];
        if (before === null) break;                      // hit the `since` cutoff
        before = oldest.id;
        carry = msgs.slice(-TRIGGER_LOOKAHEAD);

        await pool.execute(
            'UPDATE guild_scan_channels SET messages_scanned = ?, oldest_id = ? WHERE scan_id = ? AND channel_id = ?',
            [scanned, before, scanId, channel.id]);
        await pool.execute(
            'UPDATE guild_scans SET messages_scanned = messages_scanned + ?, heartbeat_at = NOW() WHERE id = ?',
            [msgs.length, scanId]);

        if (page.size < PAGE) break;                     // reached the first message
        if (limits.maxPerChannel && scanned >= limits.maxPerChannel) break;
    }

    await flush(scanId, bots, templates);
    if (!handle?.cancel) {
        await pool.execute('UPDATE guild_scan_channels SET complete = 1, messages_scanned = ? WHERE scan_id = ? AND channel_id = ?',
            [scanned, scanId, channel.id]);
    }
}

/** Merge one channel's aggregates into the scan. Counts add; channel lists union. */
async function flush(scanId, bots, templates) {
    for (const b of bots.values()) {
        await pool.execute(
            `INSERT INTO guild_scan_bots (scan_id, bot_id, name, kind, messages, first_seen, last_seen, channels)
             VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?)
             ON DUPLICATE KEY UPDATE
               messages = messages + VALUES(messages),
               first_seen = LEAST(first_seen, VALUES(first_seen)),
               last_seen = GREATEST(last_seen, VALUES(last_seen)),
               channels = JSON_MERGE_PRESERVE(channels, VALUES(channels))`,
            [scanId, b.id, b.name, b.kind, b.messages,
                Math.floor(b.first / 1000), Math.floor(b.last / 1000), JSON.stringify([...b.channels])]);
    }

    // Enforce the per-bot template ceiling loudly: a truncated bot can never clear its gate.
    const perBot = new Map();
    for (const t of templates.values()) perBot.set(t.botId, (perBot.get(t.botId) ?? 0) + 1);

    for (const t of templates.values()) {
        const [[existing]] = await pool.execute(
            'SELECT COUNT(*) AS n FROM guild_scan_templates WHERE scan_id = ? AND bot_id = ?', [scanId, t.botId]);
        if (Number(existing.n) >= MAX_TEMPLATES_PER_BOT) {
            await pool.execute(
                `INSERT INTO guild_scan_templates (scan_id, bot_id, template_hash, sample, occurrences)
                 VALUES (?, ?, 'TRUNCATED000000', ?, 1)
                 ON DUPLICATE KEY UPDATE occurrences = occurrences + 1`,
                [scanId, t.botId, `⚠ more than ${MAX_TEMPLATES_PER_BOT} distinct templates — not all recorded`]);
            logger.warn(`[Analyzer] scan ${scanId}: template cap hit for bot ${t.botId}`);
            continue;
        }
        await pool.execute(
            `INSERT INTO guild_scan_templates (scan_id, bot_id, template_hash, sample, occurrences, triggers)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               occurrences = occurrences + VALUES(occurrences),
               triggers = JSON_MERGE_PRESERVE(COALESCE(triggers, JSON_ARRAY()), VALUES(triggers))`,
            [scanId, t.botId, t.hash, t.sample, t.count, JSON.stringify([...t.triggers])]);
    }
}

/** Flag which of the bots we saw in history are still members today. */
async function markPresence(scanId, guild) {
    const [rows] = await pool.execute("SELECT bot_id FROM guild_scan_bots WHERE scan_id = ? AND kind = 'bot'", [scanId]);
    for (const r of rows) {
        const member = await guild.members.fetch(r.bot_id).catch(() => null);
        await pool.execute('UPDATE guild_scan_bots SET present = ? WHERE scan_id = ? AND bot_id = ?',
            [member ? 1 : 0, scanId, r.bot_id]);
    }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getScan(scanId) {
    const [[row]] = await pool.execute('SELECT * FROM guild_scans WHERE id = ?', [scanId]);
    return row ?? null;
}

export async function getLatestScan(guildId) {
    const [[row]] = await pool.execute(
        'SELECT * FROM guild_scans WHERE guild_id = ? ORDER BY id DESC LIMIT 1', [guildId]);
    return row ?? null;
}

export async function getBots(scanId) {
    const [rows] = await pool.execute(
        'SELECT * FROM guild_scan_bots WHERE scan_id = ? ORDER BY messages DESC', [scanId]);
    return rows;
}

export async function getTemplates(scanId, botId) {
    const [rows] = await pool.execute(
        `SELECT * FROM guild_scan_templates WHERE scan_id = ? AND bot_id = ?
         ORDER BY attributed ASC, occurrences DESC`, [scanId, botId]);
    return rows;
}

/** Mark a template as covered (or not) by one of our features. Retirement reads this. */
export async function attribute(scanId, templateId, { attributed, feature = null, userId = null }) {
    const [r] = await pool.execute(
        `UPDATE guild_scan_templates SET attributed = ?, attributed_to = ?, attributed_by = ?
         WHERE id = ? AND scan_id = ?`,
        [attributed ? 1 : 0, attributed ? feature : null, attributed ? userId : null, templateId, scanId]);
    return r.affectedRows === 1;
}

export async function unattributedCount(scanId, botId) {
    const [[row]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM guild_scan_templates WHERE scan_id = ? AND bot_id = ? AND attributed = 0',
        [scanId, botId]);
    return Number(row.n);
}

export const _internals = { walkChannel, flush, DEPTHS, PAGE, TRIGGER_LOOKAHEAD };
