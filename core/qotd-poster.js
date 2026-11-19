import { EmbedBuilder, ChannelType } from 'discord.js';

/* Discord's poll limits, and what they mean for a card that breaks them. */
const POLL_MAX_QUESTION = 300;
const POLL_MAX_ANSWER = 55;
const POLL_MAX_ANSWERS = 10;

/** Options come out of the database as a JSON string, or already parsed. */
function parseOptions(raw) {
    if (!raw) return [];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed.map((o) => String(o ?? '').trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/**
 * Turn a card into a native poll, or null when it cannot be one.
 *
 * Returning null rather than throwing is the point: a card with one option, or a
 * question channel, still has a perfectly good question to post as an embed.
 */
function buildPoll(content, options, channelConfig) {
    if (options.length < 2) return null;

    const answers = options.slice(0, POLL_MAX_ANSWERS)
        .map((text) => ({ text: text.slice(0, POLL_MAX_ANSWER) }));
    if (answers.length < 2) return null;

    const hours = Number(channelConfig.poll_duration_hours) || 24;
    return {
        question: { text: String(content).slice(0, POLL_MAX_QUESTION) },
        answers,
        // Discord accepts 1-768 hours; a daily poll that outlives the next one is
        // just clutter, so it is clamped to something sane either side.
        duration: Math.min(768, Math.max(1, hours)),
        allowMultiselect: !!channelConfig.poll_multiselect,
    };
}

import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { selectLibraryQuestion } from './qotd-selector.js';

/**
 * Post a QOTD card to a configured channel
 * @param {Client} client - Discord client
 * @param {Object} channelConfig - Channel configuration from qotd_channels table
 * @returns {Promise<Object>} Result object with success status and content
 */
export async function postQOTD(client, channelConfig) {
    try {
        // Get the channel
        const channel = await client.channels.fetch(channelConfig.channel_id).catch(() => null);
        if (!channel) {
            logger.warn('[QOTD] Channel not found', { channelId: channelConfig.channel_id });
            return { success: false, error: 'Channel not found' };
        }

        const sourceMode = channelConfig.source_mode || 'library';

        // A queued card always wins — someone put it there on purpose.
        const [[queueEntry]] = await pool.execute(
            'SELECT * FROM qotd_queue WHERE channel_id = ? ORDER BY position LIMIT 1',
            [channelConfig.channel_id]
        );

        let card = null;          // a qotd_cards row (guild deck)
        let libraryPick = null;   // a qotd_library row
        let selectionTier = null;

        if (queueEntry) {
            const [[queuedCard]] = await pool.execute(
                'SELECT * FROM qotd_cards WHERE card_id = ?',
                [queueEntry.card_id]
            );
            card = queuedCard;
        } else if (sourceMode === 'library' || sourceMode === 'mixed') {
            // 'mixed' drains the guild's own deck first, then falls through to the library.
            if (sourceMode === 'mixed' && channelConfig.active_deck_id) {
                const [[deckCard]] = await pool.execute(`
                    SELECT c.* FROM qotd_cards c
                    WHERE c.deck_id = ? AND c.card_id NOT IN (
                        SELECT COALESCE(card_id, 0) FROM qotd_history
                        WHERE guild_id = ?
                          AND posted_at > DATE_SUB(NOW(), INTERVAL ? DAY)
                    )
                    ORDER BY c.position ASC
                    LIMIT 1
                `, [channelConfig.active_deck_id, channelConfig.guild_id,
                    channelConfig.repeat_window_days || 90]);
                card = deckCard || null;
            }

            if (!card) {
                const picked = await selectLibraryQuestion(channelConfig);
                libraryPick = picked.question;
                selectionTier = picked.tier;
                if (libraryPick) {
                    logger.info('[QOTD] Library selection', {
                        guildId: channelConfig.guild_id,
                        channelId: channelConfig.channel_id,
                        slug: libraryPick.slug,
                        theme: libraryPick.theme,
                        tier: picked.tier,
                        ...picked.stats,
                    });
                }
            }
        } else {
            if (!channelConfig.active_deck_id) {
                logger.warn('[QOTD] No active deck configured', { channelId: channelConfig.channel_id });
                return { success: false, error: 'No active deck configured' };
            }
            if (channelConfig.mode === 'sequential') {
                const [[nextCard]] = await pool.execute(`
                    SELECT c.* FROM qotd_cards c
                    WHERE c.deck_id = ?
                    ORDER BY c.last_used_at IS NULL DESC, c.last_used_at ASC, c.position ASC
                    LIMIT 1
                `, [channelConfig.active_deck_id]);
                card = nextCard;
            } else {
                const [[randomCard]] = await pool.execute(`
                    SELECT c.* FROM qotd_cards c WHERE c.deck_id = ? ORDER BY RAND() LIMIT 1
                `, [channelConfig.active_deck_id]);
                card = randomCard;
            }
        }

        const content = card?.content || libraryPick?.content;
        const rawOptions = card?.options ?? libraryPick?.options ?? null;
        if (!content) {
            logger.warn('[QOTD] No question available to post', {
                channelId: channelConfig.channel_id,
                sourceMode,
                deckId: channelConfig.active_deck_id,
            });
            return { success: false, error: 'No questions available for this channel' };
        }

        // Build embed
        const embed = new EmbedBuilder()
            .setColor(channelConfig.embed_color || '#5865f2')
            .setTitle(channelConfig.embed_title || 'Question of the Day')
            .setDescription(content)
            .setTimestamp();

        if (channelConfig.embed_description) {
            embed.setFooter({ text: channelConfig.embed_description });
        }

        if (card?.image_url) {
            embed.setImage(card.image_url);
        }

        // Build message content (pings)
        let messageContent = null;
        if (channelConfig.ping_role_ids) {
            try {
                const roleIds = JSON.parse(channelConfig.ping_role_ids);
                messageContent = roleIds.map(id => `<@&${id}>`).join(' ');
            } catch (e) {
                logger.warn('[QOTD] Failed to parse ping role IDs', { error: e.message });
            }
        }

        /* Poll of the Day.
         *
         * Discord's native poll is the point of the format — real voting with live
         * counts, no reaction wrangling. Its limits are hard: 300 characters for
         * the prompt, 55 per answer, 2 to 10 answers, and a poll message may NOT
         * carry an embed. So a poll post drops the embed rather than trying to
         * have both, and anything that does not fit falls back to the embed so the
         * channel still gets its question. */
        const options = parseOptions(card?.options ?? libraryPick?.options);
        const format = String(channelConfig.post_format || 'question').toLowerCase();
        const poll = format === 'question' ? null : buildPoll(content, options, channelConfig);

        const message = await channel.send(
            poll
                ? { content: messageContent, poll }
                : { content: messageContent, embeds: [embed] }
        );
        if (queueEntry) {
            await pool.execute('DELETE FROM qotd_queue WHERE queue_id = ?', [queueEntry.queue_id]);
            await pool.execute(
                'UPDATE qotd_queue SET position = position - 1 WHERE channel_id = ? AND position > ?',
                [channelConfig.channel_id, queueEntry.position]
            );
        }
        if (poll) {
            logger.info('[QOTD] Posted as a poll', {
                channelId: channelConfig.channel_id, answers: poll.answers.length,
            });
        }

        // Create thread if enabled
        let threadId = null;
        if (channelConfig.thread_enabled && channel.type === ChannelType.GuildText) {
            try {
                const threadName = channelConfig.thread_name || `Discussion: ${new Date().toLocaleDateString()}`;
                const thread = await message.startThread({
                    name: threadName.substring(0, 100), // Max 100 chars
                    autoArchiveDuration: 1440 // 24 hours
                });
                threadId = thread.id;
                logger.info('[QOTD] Created thread', { threadId, channelId: channelConfig.channel_id });
            } catch (e) {
                logger.warn('[QOTD] Failed to create thread', { error: e.message });
            }
        }

        // Pin message if enabled
        if (channelConfig.pin_message) {
            try {
                // Unpin previous QOTD if it exists
                const pinnedMessages = await channel.messages.fetchPinned();
                // A poll carries no embed, so match on either shape.
                const ownTitle = channelConfig.embed_title || 'Question of the Day';
                const previousQOTD = pinnedMessages.find(m =>
                    m.author.id === client.user.id &&
                    (m.poll || (m.embeds.length > 0 && m.embeds[0].title === ownTitle))
                );

                if (previousQOTD) {
                    await previousQOTD.unpin();
                }

                await message.pin();
            } catch (e) {
                logger.warn('[QOTD] Failed to pin message', { error: e.message });
            }
        }

        if (card) {
            await pool.execute(
                'UPDATE qotd_cards SET times_used = times_used + 1, last_used_at = NOW() WHERE card_id = ?',
                [card.card_id]
            );
            if (channelConfig.active_deck_id) {
                await pool.execute(
                    'UPDATE qotd_decks SET times_used = times_used + 1 WHERE deck_id = ?',
                    [channelConfig.active_deck_id]
                );
            }
        }

        if (libraryPick) {
            await pool.execute(
                'UPDATE qotd_library SET times_used = times_used + 1, last_used_at = NOW() WHERE library_id = ?',
                [libraryPick.library_id]
            );
        }

        // Update channel last posted time
        await pool.execute(
            'UPDATE qotd_channels SET last_posted_at = NOW() WHERE channel_id = ?',
            [channelConfig.channel_id]
        );

        // History is what the no-repeat window reads. variant_group and theme are copied in
        // rather than joined back later, so the window survives the library being reworded.
        await pool.execute(
            `INSERT INTO qotd_history
                (channel_id, guild_id, card_id, library_id, variant_group, theme, message_id, thread_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                channelConfig.channel_id,
                channelConfig.guild_id,
                card?.card_id ?? null,
                libraryPick?.library_id ?? null,
                libraryPick?.variant_group ?? (card ? `deck-card-${card.card_id}` : null),
                libraryPick?.theme ?? null,
                message.id,
                threadId,
            ]
        );

        logger.info('[QOTD] Posted successfully', {
            channelId: channelConfig.channel_id,
            source: libraryPick ? `library:${libraryPick.slug}` : `card:${card.card_id}`,
            tier: selectionTier,
            messageId: message.id
        });

        return {
            success: true,
            content,
            messageId: message.id,
            threadId
        };

    } catch (error) {
        logger.error('[QOTD] Error posting QOTD', {
            error: error.message,
            stack: error.stack,
            channelId: channelConfig?.channel_id
        });
        return { success: false, error: error.message };
    }
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The wall-clock date, weekday and minute-of-day for `when` in an IANA timezone.
 * The server runs on UTC, so without this a channel set to "12:00 America/New_York"
 * posted at 12:00 UTC (and the timezone column did nothing). Bad names fall back to UTC.
 */
export function localParts(when, timeZone) {
    let fmt;
    try {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || 'UTC', hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            weekday: 'long', hour: '2-digit', minute: '2-digit',
        });
    } catch {
        logger.warn('[QOTD] Unknown timezone, using UTC', { timeZone });
        return localParts(when, 'UTC');
    }
    const p = Object.fromEntries(fmt.formatToParts(when).map((x) => [x.type, x.value]));
    return {
        date: `${p.year}-${p.month}-${p.day}`,
        weekday: p.weekday.toLowerCase(),
        minute: Number(p.hour) * 60 + Number(p.minute),
    };
}

export { DAY_NAMES };
const DAY_ALIASES = {
    sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', weds: 'wednesday',
    thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday',
};

/**
 * schedule_days holds names ("monday"), short names ("mon", "thurs") or numbers (0 = Sunday),
 * as a JSON array, an array, or comma/space-separated text. Returns full names in week order.
 */
export function parseDays(raw) {
    if (raw === null || raw === undefined || raw === '') return [];
    let list = raw;
    if (!Array.isArray(list)) {
        try { list = JSON.parse(raw); } catch { list = String(raw).split(/[\s,]+/); }
        if (!Array.isArray(list)) list = [list];
    }
    const found = new Set();
    for (const d of list) {
        const s = String(d).trim().toLowerCase();
        if (!s) continue;
        const bare = s.replace(/s$/, ''); // "mondays", "thurs"
        const day = /^[0-6]$/.test(s) ? DAY_NAMES[Number(s)]
            : DAY_NAMES.includes(s) ? s
            : DAY_NAMES.includes(bare) ? bare
            : DAY_ALIASES[s] || DAY_ALIASES[bare] || null;
        if (day) found.add(day);
    }
    return DAY_NAMES.filter((d) => found.has(d));
}

export function isValidTimeZone(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 50) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** "9:30", "09:30", "09:30:00" → "09:30:00"; anything else → null. */
export function normaliseTime(raw) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(raw ?? '').trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}:00` : null;
}

/** Days as people read them: "Monday", "Monday and Thursday", "Every day". */
export function describeDays(days) {
    const list = parseDays(days);
    if (list.length === 7) return 'Every day';
    const names = list.map((d) => d[0].toUpperCase() + d.slice(1));
    return names.length <= 1 ? (names[0] || 'No days set') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The Question of the Day page's "Enabled" switch (feature-config qotd.enabled). On unless saved
 * off, the spec default. Off: the scheduler posts in none of the server's channels.
 */
export function qotdSwitchOn(cfg) {
    const v = cfg?.enabled;
    return !(v === 0 || v === false || v === '0' || v === 'false');
}

/** Whether scheduled questions may post in this server (qotdSwitchOn on its saved settings). */
export async function qotdEnabledFor(guildId) {
    const { getConfig } = await import('./feature-config.js');
    return qotdSwitchOn(await getConfig('qotd', guildId).catch(() => ({})));
}

/**
 * Values a new qotd_channels row starts with, from the server's saved defaults
 * (Dashboard → Question of the Day → Settings). Before 2026-11-08 nothing read them.
 */
export async function newChannelDefaults(guildId) {
    const { getConfig } = await import('./feature-config.js');
    const cfg = await getConfig('qotd', guildId).catch(() => ({}));
    let type = cfg.default_schedule_type === 'interval' ? 'custom' : cfg.default_schedule_type;
    if (!['daily', 'weekly'].includes(type)) type = 'daily'; // an interval needs a length; daily is the safe start
    const days = parseDays(cfg.default_schedule_days);
    if (type === 'weekly' && !days.length) days.push('monday');
    let roles = [];
    try { roles = JSON.parse(cfg.default_ping_roles || '[]'); } catch { /* ignore */ }
    return {
        schedule_type: type,
        schedule_time: normaliseTime(cfg.default_schedule_time) || '09:00:00',
        schedule_days: days.length ? JSON.stringify(days) : null,
        timezone: isValidTimeZone(cfg.default_timezone) ? cfg.default_timezone : 'UTC',
        mode: cfg.default_mode === 'sequential' ? 'sequential' : 'random',
        ping_role_ids: Array.isArray(roles) && roles.length ? JSON.stringify(roles.map(String)) : null,
        embed_color: /^#[0-9a-f]{6}$/i.test(cfg.default_embed_color || '') ? cfg.default_embed_color : '#5865F2',
        thread_enabled: cfg.default_thread_enabled ? 1 : 0,
        pin_message: cfg.default_pin_message ? 1 : 0,
    };
}

/** Columns a channel's schedule editor may change, from the command or the dashboard. */
export const EDITABLE = ['schedule_type', 'schedule_days', 'schedule_time', 'timezone', 'custom_interval_minutes',
    'embed_title', 'ping_role_ids', 'thread_enabled', 'enabled'];

/**
 * Validate a schedule change against the row it applies to and write it.
 * `patch` holds values for any of EDITABLE. Returns { ok, row } or { ok: false, error }.
 * Checks the row as it will be after the change, so switching to weekly without days, or to
 * custom without an interval, is refused rather than saved and left silently idle.
 */
export async function updateChannelSchedule(guildId, channelId, patch) {
    const [[row]] = await pool.query('SELECT * FROM qotd_channels WHERE channel_id = ? AND guild_id = ?', [channelId, guildId]);
    if (!row) return { ok: false, error: 'That channel is not set up for questions on this server.' };

    const next = { ...row };
    const sets = {};
    for (const k of EDITABLE) {
        if (patch[k] === undefined) continue;
        let v = patch[k];
        if (k === 'schedule_type' && !['daily', 'weekly', 'custom'].includes(v)) return { ok: false, error: 'Schedule must be daily, weekly or custom.' };
        if (k === 'schedule_days') { const d = parseDays(v); v = d.length ? JSON.stringify(d) : null; }
        if (k === 'schedule_time') { v = normaliseTime(v); if (!v) return { ok: false, error: 'Time must be 24-hour HH:MM, e.g. 09:30.' }; }
        if (k === 'timezone' && !isValidTimeZone(v)) return { ok: false, error: `"${v}" is not a timezone. Use a name like America/Los_Angeles.` };
        if (k === 'custom_interval_minutes') {
            if (v === null || v === '') v = null;
            else {
                v = Math.trunc(Number(v));
                if (!(v >= 15 && v <= 10080)) return { ok: false, error: 'Custom interval must be 15 minutes to 7 days.' };
            }
        }
        if (k === 'embed_title') v = v ? String(v).slice(0, 255) : null;
        if (k === 'ping_role_ids') {
            let ids = v;
            if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
            v = Array.isArray(ids) && ids.length ? JSON.stringify(ids.map(String)) : null;
        }
        if (k === 'thread_enabled' || k === 'enabled') v = v ? 1 : 0;
        next[k] = v;
        sets[k] = v;
    }
    if (next.schedule_type === 'weekly' && !parseDays(next.schedule_days).length) {
        return { ok: false, error: 'A weekly schedule needs at least one day.' };
    }
    if (next.schedule_type === 'custom' && !next.custom_interval_minutes) {
        return { ok: false, error: 'A custom schedule needs an interval.' };
    }
    const keys = Object.keys(sets);
    if (keys.length) {
        await pool.query(
            `UPDATE qotd_channels SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE channel_id = ? AND guild_id = ?`,
            [...keys.map((k) => sets[k]), channelId, guildId]);
    }
    return { ok: true, row: next };
}

/** Add a channel with the server's defaults, then apply `overrides`. An existing row is kept and just updated. */
export async function createChannel(guildId, channelId, overrides = {}) {
    const d = await newChannelDefaults(guildId);
    const [res] = await pool.query(`
        INSERT IGNORE INTO qotd_channels (channel_id, guild_id, schedule_type, schedule_time, schedule_days, timezone,
            mode, ping_role_ids, embed_color, thread_enabled, pin_message, source_mode, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'library', 1)`,
        [channelId, guildId, d.schedule_type, d.schedule_time, d.schedule_days, d.timezone,
            d.mode, d.ping_role_ids, d.embed_color, d.thread_enabled, d.pin_message]);
    const created = res.affectedRows === 1;
    const r = await updateChannelSchedule(guildId, channelId, { enabled: true, ...overrides });
    if (!r.ok && !created) return r; // e.g. the channel id belongs to another server
    if (!r.ok) {
        // A brand-new row that the overrides could not be applied to is removed again, so a
        // bad command never leaves a half-configured channel behind.
        await pool.query('DELETE FROM qotd_channels WHERE channel_id = ? AND guild_id = ? AND last_posted_at IS NULL', [channelId, guildId]);
        return r;
    }
    return { ok: true, created, row: r.row };
}

/**
 * Check if a QOTD should be posted based on schedule
 *
 * Daily and weekly compare calendar days in the channel's timezone. The old
 * "24 hours since the last post" test let each post land one scheduler tick (5 min)
 * later than the one before, so channels crept later every day.
 * @param {Object} channelConfig - Channel configuration
 * @param {Date} [now] - injectable for tests
 * @returns {boolean} Whether to post
 */
export function shouldPost(channelConfig, now = new Date()) {
    if (!channelConfig.enabled) return false;

    const lastPosted = channelConfig.last_posted_at ? new Date(channelConfig.last_posted_at) : null;

    if (channelConfig.schedule_type === 'custom') {
        if (!channelConfig.custom_interval_minutes) return false;
        if (!lastPosted) return true;
        const minutesSincePost = Math.floor((now - lastPosted) / (1000 * 60));
        return minutesSincePost >= channelConfig.custom_interval_minutes;
    }

    if (channelConfig.schedule_type !== 'daily' && channelConfig.schedule_type !== 'weekly') return false;

    const tz = channelConfig.timezone || 'UTC';
    const today = localParts(now, tz);
    const [hours, minutes] = String(channelConfig.schedule_time || '09:00').split(':').map(Number);
    if (today.minute < hours * 60 + (minutes || 0)) return false;

    if (channelConfig.schedule_type === 'weekly') {
        const days = parseDays(channelConfig.schedule_days);
        if (days.length === 0) {
            logger.warn('[QOTD] Weekly channel has no days set', { channelId: channelConfig.channel_id });
            return false;
        }
        if (!days.includes(today.weekday)) return false;
    }

    // Once per local calendar day.
    return !lastPosted || localParts(lastPosted, tz).date !== today.date;
}
