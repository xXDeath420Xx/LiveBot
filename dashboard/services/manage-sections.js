/**
 * Data for the /manage pages whose sections the render object used to fill with hard-coded empty
 * placeholders (economyConfig: {}, shopItems: [], …), so settings and records that exist in the
 * database never showed. Each loader runs only for the page being viewed and returns the keys that
 * page's partial reads; the route spreads them over the placeholders.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { safeJsonArray } from '../../utils/safeJson.js';
import { loadModmailSection } from './modmail-section.js';

async function rows(sql, params) {
    const [r] = await pool.execute(sql, params);
    return r;
}

async function one(sql, params) {
    return (await rows(sql, params))[0] || null;
}

/** Display name for a member/user from the caches only (no API calls while rendering). */
function nameOf(guild, id) {
    if (!id) return null;
    const member = guild?.members?.cache?.get(String(id));
    if (member) return member.displayName || member.user?.username || null;
    const user = guild?.client?.users?.cache?.get(String(id));
    return user ? (user.globalName || user.username) : null;
}

function avatarOf(guild, id) {
    const user = guild?.members?.cache?.get(String(id))?.user || guild?.client?.users?.cache?.get(String(id));
    return user?.displayAvatarURL ? user.displayAvatarURL({ size: 64 }) : null;
}

/**
 * Permission overrides are stored as role/channel lists on guild_command_restrictions, the table
 * core/command-restrictions.js enforces. One row per list entry for the Permissions page; the id
 * encodes command|type|target|allowed so delete can find the entry again.
 */
export const OVERRIDE_LISTS = [
    ['role', 1, 'allowed_roles'],
    ['role', 0, 'denied_roles'],
    ['channel', 1, 'allowed_channels'],
    ['channel', 0, 'denied_channels'],
];

export function overrideId(command, type, target, allowed) {
    return [command, type, target, allowed ? 1 : 0].join('|');
}

export function parseOverrideId(id) {
    const [command, type, target, allowed] = String(id || '').split('|');
    if (!command || !['role', 'channel'].includes(type) || !/^\d{5,25}$/.test(target || '')) return null;
    return { command, type, target, allowed: allowed === '1' };
}

export function overrideColumn(type, allowed) {
    return OVERRIDE_LISTS.find(([t, a]) => t === type && a === (allowed ? 1 : 0))[2];
}

const LOADERS = {
    async economy(guildId) {
        const [economyConfig, shopItems, users, tx, topUsers] = await Promise.all([
            // Every field the Economy page shows and saves (H-668: the crime, rob, cooldown and trading fields
            // were not loaded, so the page showed the defaults and saving it wrote them over the real values).
            one(`SELECT enabled, currency_name, currency_emoji, starting_balance, daily_amount, weekly_amount,
                        work_min_amount, work_max_amount, work_cooldown, max_bank_capacity,
                        crime_min_amount, crime_max_amount, crime_success_rate, crime_fine_multiplier,
                        rob_min_amount, rob_max_amount, rob_success_rate, rob_fine_amount,
                        allow_gifting, allow_trading
                   FROM economy_config WHERE guild_id = ?`, [guildId]),
            rows(`SELECT id AS item_id, item_name, item_description, item_emoji, item_type, price, stock,
                         max_per_user, role_id, usable, tradeable, sellable, sell_value, is_active
                    FROM shop_items WHERE guild_id = ? ORDER BY price, item_name`, [guildId]),
            one(`SELECT COUNT(*) AS total_users, COALESCE(SUM(wallet + bank), 0) AS total_currency
                   FROM user_economy WHERE guild_id = ?`, [guildId]),
            one('SELECT COUNT(*) AS total_transactions FROM economy_transactions WHERE guild_id = ?', [guildId]),
            rows(`SELECT user_id, wallet, bank FROM user_economy WHERE guild_id = ?
                   ORDER BY (wallet + bank) DESC LIMIT 10`, [guildId]),
        ]);
        const { ECONOMY_DEFAULTS } = await import('../../core/economy-manager.js');
        return {
            economyConfig: economyConfig || {},
            // No row = never saved: /economy runs on the defaults and the page shows the switch on (H-668).
            economyConfigured: !!economyConfig,
            economyDefaults: ECONOMY_DEFAULTS,
            shopItems,
            economyStats: {
                total_users: Number(users?.total_users) || 0,
                total_currency: Number(users?.total_currency) || 0,
                total_transactions: Number(tx?.total_transactions) || 0,
            },
            topUsers,
        };
    },

    async games(guildId) {
        // Only this server's own questions/words: the global banks are not editable per server.
        const [triviaQuestions, hangmanWords, countingChannels, stats] = await Promise.all([
            rows(`SELECT id AS question_id, question, category, difficulty, correct_answer, incorrect_answers, points_value
                    FROM trivia_questions WHERE guild_id = ? ORDER BY id DESC`, [guildId]),
            rows(`SELECT id AS word_id, word, category, difficulty, definition AS hint
                    FROM word_list WHERE guild_id = ? ORDER BY word`, [guildId]),
            rows(`SELECT channel_id, current_count, highest_count
                    FROM counting_channels WHERE guild_id = ? AND is_active = 1`, [guildId]),
            one(`SELECT COALESCE(SUM(games_played), 0) AS total_games, COUNT(DISTINCT user_id) AS total_players
                   FROM game_stats WHERE guild_id = ?`, [guildId]),
        ]);
        return {
            triviaQuestions,
            hangmanWords,
            countingChannels,
            gameStats: { total_games: Number(stats?.total_games) || 0, total_players: Number(stats?.total_players) || 0 },
        };
    },

    // The RPG page's play channel (guild_settings.rpg_channel_id, as /rpg settings channel stores it).
    async rpg(guildId) {
        const row = await one('SELECT rpg_channel_id FROM guild_settings WHERE guild_id = ?', [guildId]);
        return { rpgChannelId: row?.rpg_channel_id || null };
    },

    async gambling(guildId) {
        const [config, history, totals, topGamblers] = await Promise.all([
            one(`SELECT enabled, min_bet, max_bet, cooldown_seconds AS cooldown, house_edge
                   FROM gambling_config WHERE guild_id = ?`, [guildId]),
            rows(`SELECT user_id, game_type, bet_amount, win_amount AS payout, result AS detail,
                         COALESCE(created_at, timestamp) AS timestamp
                    FROM gambling_history WHERE guild_id = ? ORDER BY id DESC LIMIT 25`, [guildId]),
            one(`SELECT COUNT(*) AS total_games, COALESCE(SUM(bet_amount), 0) AS total_wagered,
                        COALESCE(SUM(win_amount), 0) AS total_won
                   FROM gambling_history WHERE guild_id = ?`, [guildId]),
            rows(`SELECT user_id, COUNT(*) AS games_played, SUM(bet_amount) AS total_wagered,
                         SUM(win_amount) AS total_won, SUM(win_amount > bet_amount) AS wins
                    FROM gambling_history WHERE guild_id = ?
                   GROUP BY user_id ORDER BY total_wagered DESC LIMIT 10`, [guildId]),
        ]);
        // gambling_history.result holds the game's own description (e.g. "7 (higher)"); the page
        // shows win/loss, which is what the payout says.
        const gamblingHistory = history.map((g) => ({
            ...g,
            result: Number(g.payout) > Number(g.bet_amount) ? 'win'
                : Number(g.payout) === Number(g.bet_amount) ? 'push' : 'loss',
        }));
        return {
            gamblingConfig: config || {},
            // No row = never saved: the games run on core/gambling-manager.js's defaults (on, bets 1-10,000, no wait).
            gamblingConfigured: !!config,
            gamblingHistory,
            gamblingStats: {
                total_games: Number(totals?.total_games) || 0,
                total_wagered: Number(totals?.total_wagered) || 0,
                total_won: Number(totals?.total_won) || 0,
                house_edge: config?.house_edge ?? null,
            },
            topGamblers,
        };
    },

    async quarantine(guildId, guild) {
        const [quarantineConfig, list] = await Promise.all([
            one('SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?', [guildId]),
            rows(`SELECT user_id, reason, quarantined_by AS moderator_id, quarantined_at
                    FROM quarantined_users WHERE guild_id = ? ORDER BY quarantined_at DESC`, [guildId]),
        ]);
        return {
            quarantineConfig: quarantineConfig || {},
            quarantinedUsers: list.map((u) => ({
                ...u,
                username: nameOf(guild, u.user_id) || u.user_id,
                avatar_url: avatarOf(guild, u.user_id),
                moderator_tag: nameOf(guild, u.moderator_id) || u.moderator_id || null,
            })),
        };
    },

    async security(guildId) {
        return {
            quarantineConfig: (await one('SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?', [guildId])) || {},
        };
    },

    async suggestions(guildId, guild, query = {}) {
        const counts = await rows('SELECT status, COUNT(*) AS c FROM suggestions WHERE guild_id = ? GROUP BY status', [guildId]);
        const by = Object.fromEntries(counts.map((r) => [r.status, Number(r.c)]));
        const { listTags, listSuggestionsForDashboard, normaliseFilters } = await import('../../core/suggestion-tags.js');
        const [suggestionTags, suggestions] = await Promise.all([
            listTags(guildId),
            listSuggestionsForDashboard(guildId, query, { guild }),
        ]);
        return {
            suggestionStats: {
                pending: (by.pending || 0) + (by.under_review || 0),
                approved: by.approved || 0,
                rejected: (by.rejected || 0) + (by.duplicate || 0),
                implemented: by.implemented || 0,
            },
            suggestionTags,
            suggestions,
            suggestionFilters: normaliseFilters(query),
        };
    },

    async 'stat-roles'(guildId) {
        const statroleConfigs = await rows(
            'SELECT id, role_id, stat_type, required_amount, remove_below FROM statrole_configs WHERE guild_id = ? ORDER BY stat_type, required_amount',
            [guildId]);
        const grants = await rows('SELECT role_id, COUNT(*) AS c FROM statrole_grants WHERE guild_id = ? GROUP BY role_id', [guildId]);
        return { statroleConfigs, statroleGrantCounts: Object.fromEntries(grants.map((g) => [g.role_id, Number(g.c)])) };
    },

    async permissions(guildId) {
        const list = await rows(
            `SELECT command_name, allowed_roles, denied_roles, allowed_channels, denied_channels
               FROM guild_command_restrictions WHERE guild_id = ? ORDER BY command_name`, [guildId]);
        const permissionOverrides = [];
        for (const row of list) {
            for (const [type, allowed, column] of OVERRIDE_LISTS) {
                for (const target of safeJsonArray(row[column])) {
                    permissionOverrides.push({
                        id: overrideId(row.command_name, type, target, allowed),
                        command_name: row.command_name, type, target_id: String(target), allowed: !!allowed,
                    });
                }
            }
        }
        return { permissionOverrides };
    },

    async reminders(guildId) {
        const list = await rows(
            `SELECT id, user_id, channel_id, message, remind_at, is_dm, recurring_interval, recurring_count,
                    occurrences_sent, next_occurrence
               FROM reminders WHERE guild_id = ? ORDER BY COALESCE(next_occurrence, remind_at)`, [guildId]);
        const now = Date.now();
        return {
            reminders: list.map((r) => ({
                ...r,
                is_active: !!r.recurring_interval || new Date(r.next_occurrence || r.remind_at).getTime() > now,
            })),
        };
    },

    // Tickets page "Default panel" (ticket_config, also written by /support ticket setup). The route passed a
    // fixed {} here, so the form never showed what was saved and the Post panel button never appeared.
    async tickets(guildId) {
        const ticketConfig = await one(
            `SELECT panel_channel_id, panel_message_id, ticket_category_id, support_role_id, log_channel_id
               FROM ticket_config WHERE guild_id = ?`, [guildId]);
        return { ticketConfig: ticketConfig || {} };
    },

    // Modmail page: settings, open/closed conversations, block list, stats (services/modmail-section.js).
    async modmail(guildId, guild) {
        return loadModmailSection(guildId, guild);
    },

    async trading(guildId, guild) {
        const { loadTradingPageData } = await import('../../core/trade-manager.js');
        return loadTradingPageData(guildId, guild);
    },

    async tags(guildId, guild) {
        const list = await rows(
            'SELECT id, tag_name, tag_content, creator_id, use_count FROM tags WHERE guild_id = ? ORDER BY tag_name', [guildId]);
        return { tags: list.map((t) => ({ ...t, use_count: Number(t.use_count) || 0, creator_tag: nameOf(guild, t.creator_id) })) };
    },

    /**
     * The rejoin limit's page: totals, members who have joined more than once (counted exactly as the
     * rule counts them: resets, approvals, window), the rule's recent actions, and one member's full
     * history when `?user=` names someone (an id, or a cached username / display name).
     */
    async rejoin(guildId, guild, query = {}) {
        const { rejoinStatus } = await import('../../core/join-gate.js');
        const { joinHistory, isBackfilling } = await import('../../core/join-history.js');
        const config = await one('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]);
        const totals = await one(
            `SELECT COUNT(*) AS joins, COUNT(DISTINCT user_id) AS members, MIN(joined_at) AS first_join
               FROM member_join_history WHERE guild_id = ?`, [guildId]);

        const repeat = await rows(
            `SELECT user_id, COUNT(*) AS total, MAX(joined_at) AS last_join FROM member_join_history
              WHERE guild_id = ? GROUP BY user_id HAVING total > 1 ORDER BY total DESC, last_join DESC LIMIT 100`, [guildId]);
        const repeaters = [];
        for (const r of repeat) {
            const s = await rejoinStatus(guildId, r.user_id, config);
            repeaters.push({
                userId: r.user_id, name: nameOf(guild, r.user_id), avatar: avatarOf(guild, r.user_id),
                total: Number(r.total) || 0, lastJoin: r.last_join, counted: s.count, over: s.over,
                resetAt: s.reset?.reset_at || null,
            });
        }
        repeaters.sort((a, b) => (b.counted - a.counted) || (b.total - a.total));

        const actions = (await rows(
            `SELECT user_id, username, action, dm_delivered, detail, created_at FROM join_gate_events
              WHERE guild_id = ? AND action LIKE 'rejoin\\_%' ORDER BY id DESC LIMIT 25`, [guildId]))
            .map(a => ({ ...a, name: nameOf(guild, a.user_id) || a.username }));

        let lookup = null;
        const q = String(query.user || '').trim().slice(0, 64);
        if (q) {
            let userId = /^\d{17,20}$/.test(q) ? q : null;
            if (!userId) {
                const needle = q.replace(/^@/, '').toLowerCase();
                userId = guild?.members?.cache?.find(m => [m.user?.username, m.displayName, m.user?.globalName]
                    .some(n => n && n.toLowerCase() === needle))?.id || null;
            }
            if (!userId) {
                lookup = { query: q, notFound: true };
            } else {
                const { joins, total } = await joinHistory(guildId, userId, 100);
                const s = await rejoinStatus(guildId, userId, config);
                // One member: worth the two API calls for an accurate name and "still here?".
                const member = await guild?.members?.fetch(userId).catch(() => null);
                const user = member?.user || await guild?.client?.users?.fetch(userId).catch(() => null);
                lookup = {
                    query: q, userId, joins, total, inServer: !!member,
                    name: member?.displayName || user?.globalName || user?.username || null,
                    username: user?.username || null,
                    avatar: user?.displayAvatarURL ? user.displayAvatarURL({ size: 128 }) : null,
                    counted: s.count, since: s.since, over: s.over, max: s.max,
                    reset: s.reset, approvedAt: s.approvedAt,
                };
            }
        }

        return {
            rejoin: {
                config,
                totals: { joins: Number(totals?.joins) || 0, members: Number(totals?.members) || 0, firstJoin: totals?.first_join || null },
                repeaters: repeaters.slice(0, 50),
                repeaterCount: repeat.length,
                actions,
                lookup,
                backfilling: isBackfilling(guildId),
                notice: ['reset', 'counting', 'counted'].includes(query.notice) ? query.notice : null,
            },
        };
    },
};

LOADERS.holidays = async function holidays(guildId) {
    const { listCatalog, computeCountdown, formatHolidayDate } = await import('../../core/holiday-manager.js');
    const [pinRows] = await pool.execute(
        'SELECT slug, channel_id, message_id, last_updated_at, last_days_remaining, disabled_reason FROM holiday_countdown_pins WHERE guild_id = ?',
        [guildId]
    );
    const pinBySlug = new Map(pinRows.map(r => [r.slug, r]));

    const holidays = [];
    for (const h of listCatalog()) {
        try {
            const info = await computeCountdown(h.slug);
            if (!info) continue;
            holidays.push({
                slug: h.slug, emoji: h.emoji, label: h.label,
                nextDate: info.nextDate.toISOString().slice(0, 10),
                nextDateFormatted: formatHolidayDate(info.nextDate),
                daysRemaining: info.daysRemaining,
                isToday: info.isToday,
                year: info.year,
                pin: pinBySlug.get(h.slug) || null,
            });
        } catch (e) {
            logger.warn(`[Manage] holiday ${h.slug} loader skipped: ${e.message}`);
        }
    }
    holidays.sort((a, b) => a.daysRemaining - b.daysRemaining);

    // Auto-reply channels (defensive — the table may not exist on a server that
    // hasn't yet run migration 364; present an empty list rather than crashing
    // the whole page).
    let autoChannels = [];
    try {
        const { listAutoChannels } = await import('../../core/holiday-auto-reply.js');
        autoChannels = await listAutoChannels(guildId);
    } catch (e) {
        logger.warn(`[Manage] holiday auto-channels load failed: ${e.message}`);
    }

    return { holidays, holidayAutoChannels: autoChannels };
};

/** Keys for the page being viewed; {} for pages without a loader or when loading fails. */

LOADERS['network-intel'] = async function networkIntel(guildId) {
    // Pending + recent reports for this guild (reviewers see only their own; staff from another
    // guild can't see your inbox). Shown with reporter and target so staff can decide.
    let pendingReports = [];
    let recentReports = [];
    try {
        const [rows] = await pool.query(
            `SELECT id, reported_user_id, reporter_user_id, content_preview, verdict,
                    join_delta_seconds, contributed_to_blacklist, created_at, reviewed_at, reviewed_by
               FROM dm_spam_reports
              WHERE guild_id = ?
              ORDER BY (verdict = 'pending') DESC, created_at DESC
              LIMIT 100`,
            [guildId]
        );
        pendingReports = rows.filter(r => r.verdict === 'pending');
        recentReports = rows.filter(r => r.verdict !== 'pending').slice(0, 25);
    } catch (e) {
        logger.warn(`[Manage] network-intel reports load failed: ${e.message}`);
    }

    // Network-scoped blacklist (visible to every guild — this is the shared truth). We join on the
    // activity row to show "how much we know about this user" alongside the entry.
    let blacklistEntries = [];
    try {
        const [rows] = await pool.query(
            `SELECT b.id, b.platform_user_id AS user_id, b.reason, b.source, b.evidence_count,
                    b.blacklisted_at, b.confirmed_by, b.confirmed_at, b.expires_at,
                    a.guilds_joined, a.guilds_banned_from, a.guilds_active, a.last_message_at,
                    a.last_username, a.dm_reports_count
               FROM blacklisted_users b
          LEFT JOIN network_member_activity a ON a.user_id = b.platform_user_id
              WHERE b.scope = 'network' AND b.platform = 'discord'
              ORDER BY b.blacklisted_at DESC
              LIMIT 100`
        );
        blacklistEntries = rows;
    } catch (e) {
        logger.warn(`[Manage] network-intel blacklist load failed: ${e.message}`);
    }

    // Rough health stats for the top of the page.
    let networkStats = { totalTracked: 0, blacklistedCount: 0, pendingReportsAllGuilds: 0, bannedFromMany: 0 };
    try {
        const [[a]] = await pool.query(`SELECT COUNT(*) AS n FROM network_member_activity`);
        const [[b]] = await pool.query(
            `SELECT COUNT(*) AS n FROM blacklisted_users WHERE scope = 'network' AND platform = 'discord'`);
        const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM dm_spam_reports WHERE verdict = 'pending'`);
        const [[d]] = await pool.query(
            `SELECT COUNT(*) AS n FROM network_member_activity WHERE guilds_banned_from >= 3`);
        networkStats = {
            totalTracked: a?.n || 0,
            blacklistedCount: b?.n || 0,
            pendingReportsAllGuilds: c?.n || 0,
            bannedFromMany: d?.n || 0,
        };
    } catch (e) {
        logger.warn(`[Manage] network-intel stats load failed: ${e.message}`);
    }

    return { pendingReports, recentReports, blacklistEntries, networkStats };
};

/**
 * Overview: the last 7 days of activity (ProBot-style). Daily counts come from activity_stats,
 * which core/server-stats-manager.js writes against CURDATE(); days without a row are zero.
 * Active members = distinct people who sent a message (message_stats) in the same window.
 */
LOADERS.overview = async function overview(guildId) {
    const [[{ today }], days, [prev], [active]] = await Promise.all([
        rows("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today", []),
        rows(`SELECT DATE_FORMAT(stat_date, '%Y-%m-%d') AS d, messages_sent, members_joined, members_left
                FROM activity_stats WHERE guild_id = ? AND stat_date BETWEEN CURDATE() - INTERVAL 6 DAY AND CURDATE()`, [guildId]),
        rows(`SELECT COALESCE(SUM(messages_sent), 0) AS messages, COALESCE(SUM(members_joined), 0) AS joined,
                     COALESCE(SUM(members_left), 0) AS left_n
                FROM activity_stats WHERE guild_id = ? AND stat_date BETWEEN CURDATE() - INTERVAL 13 DAY AND CURDATE() - INTERVAL 7 DAY`, [guildId]),
        rows(`SELECT COUNT(DISTINCT user_id) AS n FROM message_stats
                WHERE guild_id = ? AND stat_date BETWEEN CURDATE() - INTERVAL 6 DAY AND CURDATE()`, [guildId]),
    ]);
    const byDay = new Map(days.map((r) => [r.d, r]));
    const base = new Date(today + 'T00:00:00Z');
    const series = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
        const r = byDay.get(d);
        series.push({
            date: d,
            messages: Number(r?.messages_sent) || 0,
            joined: Number(r?.members_joined) || 0,
            left: Number(r?.members_left) || 0,
        });
    }
    return {
        overviewActivity: {
            days: series,
            activeMembers: Number(active?.n) || 0,
            previous: { messages: Number(prev?.messages) || 0, joined: Number(prev?.joined) || 0, left: Number(prev?.left_n) || 0 },
        },
    };
};

export async function loadManageSection(page, guildId, guild, query = {}) {
    const loader = Object.prototype.hasOwnProperty.call(LOADERS, page) ? LOADERS[page] : null;
    if (!loader) return {};
    try {
        return await loader(guildId, guild, query || {});
    } catch (err) {
        logger.error(`[Manage] loading data for the ${page} page failed`, { guildId, error: err.message });
        return {};
    }
}
