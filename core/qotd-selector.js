import crypto from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/*
 * Picks the next QOTD question for a channel.
 *
 * Three guarantees, in priority order:
 *
 *   1. HARD — no question, and no reworded twin of one, repeats in a guild inside its
 *      rolling window (default 90 days). Enforced on variant_group, so rewordings count
 *      as the same question. This is the only rule never relaxed while any candidate
 *      survives it.
 *   2. SOFT — a question another guild posted in the last cross_guild_spacing_days is
 *      held back, so two servers don't run the same prompt the same week.
 *   3. SOFT — a per-guild theme rotation, offset by a hash of the guild id, so servers
 *      drift onto different topics on the same calendar day even when they draw from the
 *      same pool.
 *
 * The final pick is a deterministic hash of (guild, channel, day) indexed into the
 * candidate list — NOT ORDER BY RAND(). Random draws are what produced the same question
 * three times in a month; and an unseeded random would still let two guilds collide on the
 * same day by chance. A guild-salted index cannot.
 */

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_CROSS_GUILD_DAYS = 14;
const THEME_COOLDOWN_POSTS = 4;   // don't revisit a theme within this many posts

function dayIndex(now = new Date()) {
    return Math.floor(now.getTime() / 86_400_000);
}

function hashInt(...parts) {
    const digest = crypto.createHash('sha256').update(parts.join(':')).digest();
    return digest.readUInt32BE(0);
}

function placeholders(n) {
    return Array(n).fill('?').join(',');
}

function parseThemeBlocklist(raw) {
    if (!raw) return [];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

/**
 * Choose the next library question for a channel.
 *
 * @param {Object} config - a qotd_channels row
 * @param {Object} [options]
 * @param {number} [options.dayOffset] - shifts the day used for rotation/pick, so the
 *        rotation can be simulated forward without waiting 90 days to find out it repeats.
 * @returns {Promise<{question: Object|null, tier: string, stats: Object}>}
 */
export async function selectLibraryQuestion(config, options = {}) {
    const day = dayIndex() + (options.dayOffset || 0);
    const guildId = config.guild_id;
    const channelId = config.channel_id;
    const windowDays = Number(config.repeat_window_days) || DEFAULT_WINDOW_DAYS;
    const crossDays = Number(config.cross_guild_spacing_days ?? DEFAULT_CROSS_GUILD_DAYS);
    const blocked = parseThemeBlocklist(config.theme_blocklist);

    // Everything this guild has seen inside its window — by group, so rewordings are
    // covered by whichever twin was actually posted.
    const [seenRows] = await pool.execute(
        `SELECT DISTINCT variant_group FROM qotd_history
         WHERE guild_id = ? AND variant_group IS NOT NULL
           AND posted_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [guildId, windowDays]
    );
    const seenHere = new Set(seenRows.map(r => r.variant_group));

    // What OTHER guilds have posted recently. Soft — relaxed before rule 1 is touched.
    const [elsewhereRows] = crossDays > 0
        ? await pool.execute(
            `SELECT DISTINCT variant_group FROM qotd_history
             WHERE guild_id <> ? AND variant_group IS NOT NULL
               AND posted_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [guildId, crossDays]
        )
        : [[]];
    const seenElsewhere = new Set(elsewhereRows.map(r => r.variant_group));

    // Themes from this guild's most recent posts, for local spacing.
    const [recentThemeRows] = await pool.execute(
        `SELECT theme FROM qotd_history
         WHERE guild_id = ? AND theme IS NOT NULL
         ORDER BY posted_at DESC LIMIT ${THEME_COOLDOWN_POSTS}`,
        [guildId]
    );
    const recentThemes = new Set(recentThemeRows.map(r => r.theme));

    const blockClause = blocked.length ? ` AND theme NOT IN (${placeholders(blocked.length)})` : '';
    /* A channel set to polls must only ever draw poll cards — an open question
       posted into a poll channel has no answers to vote on and reads as a bug.
       'mixed' takes the whole pool; anything else is questions, as before. */
    const format = String(config.post_format || 'question').toLowerCase();
    const typeClause = format === 'poll' ? " AND card_type = 'poll'"
        : format === 'mixed' ? ''
            : " AND card_type <> 'poll'";
    const [library] = await pool.execute(
        `SELECT library_id, slug, content, options, theme, variant_group, card_type
         FROM qotd_library
         WHERE active = 1${typeClause}${blockClause}
         ORDER BY library_id`,
        blocked
    );

    if (!library.length) {
        return { question: null, tier: 'empty-library', stats: { total: 0 } };
    }

    const unseenHere = library.filter(q => !seenHere.has(q.variant_group));

    // Per-guild theme rotation: same day, different servers, different topic.
    const themes = [...new Set(library.map(q => q.theme))].sort();
    const rotationTheme = themes[(hashInt('qotd-theme', guildId) + day) % themes.length];

    const fresh = unseenHere.filter(q => !seenElsewhere.has(q.variant_group));
    const themeSpaced = q => !recentThemes.has(q.theme);

    const tiers = [
        ['rotation',      fresh.filter(q => q.theme === rotationTheme && themeSpaced(q))],
        ['fresh-spaced',  fresh.filter(themeSpaced)],
        ['fresh',         fresh],
        ['unseen-spaced', unseenHere.filter(themeSpaced)],
        ['unseen',        unseenHere],
    ];

    for (const [tier, candidates] of tiers) {
        if (!candidates.length) continue;
        const idx = hashInt('qotd-pick', guildId, channelId, day) % candidates.length;
        return {
            question: candidates[idx],
            tier,
            stats: {
                total: library.length,
                unseenHere: unseenHere.length,
                fresh: fresh.length,
                windowDays,
                rotationTheme,
            },
        };
    }

    // Every question in the library has been posted in this guild inside its window.
    // Rather than break the 90-day promise silently, fall back to the single
    // least-recently-seen question here and say so loudly.
    logger.warn('[QOTD] Library exhausted for guild inside its no-repeat window', {
        guildId, channelId, windowDays, libraryTotal: library.length,
    });

    const [[oldest]] = await pool.execute(
        `SELECT l.library_id, l.slug, l.content, l.options, l.theme, l.variant_group, l.card_type,
                MAX(h.posted_at) AS last_seen
         FROM qotd_library l
         JOIN qotd_history h ON h.variant_group = l.variant_group AND h.guild_id = ?
         WHERE l.active = 1${typeClause}${blockClause}
         GROUP BY l.library_id
         ORDER BY last_seen ASC
         LIMIT 1`,
        [guildId, ...blocked]
    );

    return {
        question: oldest || null,
        tier: 'exhausted',
        stats: { total: library.length, unseenHere: 0, fresh: 0, windowDays },
    };
}

/**
 * Coverage report for a guild — how much runway is left before the window forces a repeat.
 */
export async function libraryCoverage(guildId, windowDays = DEFAULT_WINDOW_DAYS, format = null) {
    const fmt = String(format || '').toLowerCase();
    const typeClause = fmt === 'poll' ? " AND card_type = 'poll'"
        : fmt === 'question' ? " AND card_type <> 'poll'" : '';
    const [[total]] = await pool.execute(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT variant_group) AS groups
         FROM qotd_library WHERE active = 1${typeClause}`
    );
    const [[used]] = await pool.execute(
        `SELECT COUNT(DISTINCT variant_group) AS n FROM qotd_history
         WHERE guild_id = ? AND variant_group IS NOT NULL
           AND posted_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [guildId, windowDays]
    );
    return {
        libraryQuestions: total.n,
        distinctGroups: total.groups,
        usedInWindow: used.n,
        remaining: Math.max(0, total.groups - used.n),
        windowDays,
    };
}

export { DEFAULT_WINDOW_DAYS, DEFAULT_CROSS_GUILD_DAYS };
