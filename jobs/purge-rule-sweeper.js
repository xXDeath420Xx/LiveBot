/**
 * Sweeper for content-aware channel purge rules (`channel_purge_rules`).
 *
 * ## The guarantee
 *
 * "Delete every post N after it was made, and never miss one."
 *
 * A messageCreate-driven queue cannot promise that. Anything posted while the
 * process is down, during a gateway resume, or before the rule was created has
 * no queue row and would live forever — silently, which is the worst kind of
 * broken for a feature whose whole job is that things disappear.
 *
 * So this reads channel history instead. A snowflake encodes its own creation
 * time, so `snowflakeForTimestamp(now - ttl)` is an exact boundary: every
 * message returned by `fetch({ before: cutoff })` is, by construction, already
 * older than the TTL. Nothing needs to have been observed at post time. The
 * channel is the queue, Discord stores it, and downtime costs latency rather
 * than a permanently missed message.
 *
 * ## Two passes per rule, per cycle
 *
 * FRESH  — always runs, starting at the cutoff snowflake. This is the newest
 *          batch of just-expired messages, so steady state is handled within
 *          one cycle. It keeps paging while a page came back full AND something
 *          in it was deleted, which is what a burst looks like.
 *
 * BACKLOG — only while `scan_complete = 0`. Pages further back from a persisted
 *          `scan_cursor` so that switching a rule on over a 40k-message channel
 *          drains across many cycles instead of one rate-limited stampede.
 *          When a page comes back short, history is exhausted: scan_complete=1.
 *
 * The cursor is needed because of what we DON'T delete. Deleted messages stop
 * appearing, so a pure re-fetch would self-advance — but pinned, exempt and
 * non-matching messages stay, and without a cursor the sweeper would re-read
 * the same protected messages forever and never reach older ones behind them.
 *
 * ## Why deletes are budgeted
 *
 * bulkDelete only works on messages under 14 days old; everything older is one
 * DELETE per message. This database and bot fleet serve 41 bots across 82
 * guilds on shared rate limits, so an unbounded first run on an old channel
 * would starve every other feature. Per-cycle caps make a large backlog take
 * hours instead of taking the fleet down.
 */
import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import {
    loadEnabledRules, compileCriteria, describeMessage, evaluateMessage,
    ruleNeedsRoles, snowflakeForTimestamp, formatDuration,
} from '../core/purge-rules.js';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const MAX_FRESH_PAGES = 5;          // per rule, per cycle
const MAX_BACKLOG_PAGES = 3;        // per rule, per cycle
const MAX_DELETES_PER_RULE = 300;   // per rule, per cycle
const MAX_OLD_DELETES_PER_RULE = 25; // individual (>14d) deletes, per rule, per cycle
const MAX_DRY_RUN_LOGS = 15;        // sample lines per rule, per cycle
const OLD_DELETE_SPACING_MS = 350;

let task = null;
let fallbackClient = null;
let running = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clientFor(guildId) {
    if (global.botManager) {
        return global.botManager.getClientForGuild(guildId) || global.botManager.getDefaultClient() || fallbackClient;
    }
    return fallbackClient;
}

/**
 * Resolve author roles for the messages in a page, but only when the rule
 * actually consults roles. Cached per page so a channel dominated by one poster
 * costs one member fetch, not one per message.
 */
async function resolveRoles(guild, authorIds, cache) {
    for (const id of authorIds) {
        if (cache.has(id)) continue;
        const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
        cache.set(id, member ? [...member.roles.cache.keys()] : null);
    }
}

/**
 * Evaluate one fetched page and delete what the rule selects.
 * @returns {{ deleted: number, oldestId: string|null, size: number, skipped: number }}
 */
async function processPage(batch, rule, criteria, guild, budget, seen) {
    const needRoles = ruleNeedsRoles(rule);
    const roleCache = new Map();
    if (needRoles) {
        const authors = new Set([...batch.values()].map(m => m.author?.id).filter(Boolean));
        await resolveRoles(guild, authors, roleCache);
    }

    const doomed = [];
    let skipped = 0;

    for (const [, message] of batch) {
        // The fresh and backlog passes can overlap on the same page. Deletion
        // makes that harmless, but a dry run would report the same message
        // twice and tell the operator a number that is not real.
        if (seen.has(message.id)) { skipped++; continue; }
        seen.add(message.id);

        // System messages (joins, boosts, pins) are not user posts and several
        // types cannot be deleted at all.
        if (message.system) { skipped++; continue; }

        let roleIds = [];
        if (needRoles) {
            const roles = roleCache.get(message.author?.id);
            if (roles === null) {
                // The author has left, or the member could not be fetched. A
                // rule that exempts a role cannot be evaluated correctly here,
                // so skip rather than delete something a moderator wrote.
                if (rule.exemptRoleIds.length) { skipped++; continue; }
            } else {
                roleIds = roles || [];
            }
        }

        const verdict = evaluateMessage(describeMessage(message, roleIds), rule, criteria);
        if (verdict.del) doomed.push({ message, reason: verdict.reason });
    }

    const oldestId = batch.size ? [...batch.values()][batch.size - 1].id : null;

    if (!doomed.length) return { deleted: 0, oldestId, size: batch.size, skipped };

    if (rule.dryRun) {
        // Budgeted across the whole sweep — a dry run on a 5,000 message channel
        // should be a sample plus a count, not 5,000 log lines.
        for (const { message, reason } of doomed) {
            if (budget.dryLogs <= 0) break;
            budget.dryLogs--;
            logger.info(`[PurgeRules] DRY RUN would delete ${message.id}: ${reason}`, {
                category: 'purge', guildId: rule.guildId, channelId: rule.channelId, ruleId: rule.id,
            });
        }
        return { deleted: 0, oldestId, size: batch.size, skipped, wouldDelete: doomed.length };
    }

    let deleted = 0;
    const cutoff14 = Date.now() - FOURTEEN_DAYS_MS;
    const recent = doomed.filter(d => d.message.createdTimestamp > cutoff14).map(d => d.message);
    const old = doomed.filter(d => d.message.createdTimestamp <= cutoff14).map(d => d.message);

    // Bulk path: up to 100 at a time, and only worth it at 2+.
    for (let i = 0; i < recent.length; i += 100) {
        if (budget.deletes <= 0) break;
        const slice = recent.slice(i, i + 100).slice(0, budget.deletes);
        if (slice.length >= 2) {
            try {
                const done = await channelOf(slice).bulkDelete(slice, true);
                deleted += done.size;
                budget.deletes -= done.size;
            } catch (err) {
                logger.warn(`[PurgeRules] bulkDelete failed: ${err.message}`, {
                    category: 'purge', guildId: rule.guildId, channelId: rule.channelId, ruleId: rule.id,
                });
                break;
            }
        } else if (slice.length === 1) {
            if (await slice[0].delete().then(() => true).catch(() => false)) { deleted++; budget.deletes--; }
        }
    }

    // Slow path: anything over 14 days must go one at a time.
    let consecutiveFailures = 0;
    for (const message of old) {
        if (budget.deletes <= 0 || budget.oldDeletes <= 0) break;
        const ok = await message.delete().then(() => true).catch(() => false);
        if (!ok) {
            // One failure is usually a message someone else already deleted.
            // Several in a row means permissions went away, and continuing to
            // hammer a channel we cannot write to just burns rate limit.
            if (++consecutiveFailures >= 3) break;
            continue;
        }
        consecutiveFailures = 0;
        deleted++; budget.deletes--; budget.oldDeletes--;
        await sleep(OLD_DELETE_SPACING_MS);
    }

    return { deleted, oldestId, size: batch.size, skipped };
}

function channelOf(messages) {
    return messages[0].channel;
}

async function sweepRule(rule) {
    const client = clientFor(rule.guildId);
    if (!client) return null;

    const channel = await client.channels.fetch(rule.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.guild) {
        await pool.execute(
            'UPDATE channel_purge_rules SET last_error = ?, last_run_at = NOW() WHERE id = ?',
            ['Channel not found or not a text channel', rule.id]
        );
        return null;
    }

    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has('ManageMessages') || !perms?.has('ViewChannel') || !perms?.has('ReadMessageHistory')) {
        await pool.execute(
            'UPDATE channel_purge_rules SET last_error = ?, last_run_at = NOW() WHERE id = ?',
            ['Missing View Channel / Read Message History / Manage Messages', rule.id]
        );
        return null;
    }

    const criteria = compileCriteria(rule);
    const cutoffSnowflake = snowflakeForTimestamp(Date.now() - rule.ttlSeconds * 1000);
    const budget = { deletes: MAX_DELETES_PER_RULE, oldDeletes: MAX_OLD_DELETES_PER_RULE, dryLogs: MAX_DRY_RUN_LOGS };
    const seen = new Set();

    let totalDeleted = 0;
    let wouldDelete = 0;

    // --- FRESH: the newest just-expired messages. Always runs. ---
    let before = cutoffSnowflake;
    let freshEnd = null;
    for (let page = 0; page < MAX_FRESH_PAGES; page++) {
        const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0) break;

        const res = await processPage(batch, rule, criteria, channel.guild, budget, seen);
        totalDeleted += res.deleted;
        wouldDelete += res.wouldDelete || 0;
        freshEnd = res.oldestId || freshEnd;

        // Keep going only while this looks like a backlog burst rather than
        // steady state: a full page where we actually removed things.
        if (batch.size < 100 || res.deleted === 0 || budget.deletes <= 0) break;
        before = res.oldestId;
    }

    // --- BACKLOG: drain older history once, after the rule is created. ---
    let scanCursor = rule.scanCursor;
    let scanComplete = rule.scanComplete;

    if (!scanComplete && budget.deletes > 0) {
        // Resume where we left off, else pick up immediately below whatever the
        // fresh pass already covered so the first page is not fetched twice.
        let cursor = scanCursor || freshEnd || cutoffSnowflake;
        for (let page = 0; page < MAX_BACKLOG_PAGES; page++) {
            const batch = await channel.messages.fetch({ limit: 100, before: cursor }).catch(() => null);
            if (!batch) break;
            if (batch.size === 0) { scanComplete = true; scanCursor = null; break; }

            const res = await processPage(batch, rule, criteria, channel.guild, budget, seen);
            totalDeleted += res.deleted;
            wouldDelete += res.wouldDelete || 0;

            cursor = res.oldestId;
            scanCursor = cursor;

            // A short page means we reached the beginning of the channel.
            if (batch.size < 100) { scanComplete = true; scanCursor = null; break; }
            if (budget.deletes <= 0) break;
        }
    }

    await pool.execute(
        `UPDATE channel_purge_rules
            SET last_run_at = NOW(), last_deleted = ?, total_deleted = total_deleted + ?,
                scan_cursor = ?, scan_complete = ?, last_error = NULL
          WHERE id = ?`,
        [totalDeleted, totalDeleted, scanCursor, scanComplete ? 1 : 0, rule.id]
    );

    if (totalDeleted > 0 || wouldDelete > 0) {
        logger.info(
            `[PurgeRules] ${rule.dryRun ? `DRY RUN: ${wouldDelete} would be deleted` : `deleted ${totalDeleted}`} in #${channel.name} (rule "${rule.name}")`,
            { category: 'purge', guildId: rule.guildId, channelId: rule.channelId, ruleId: rule.id }
        );
        await postLog(client, rule, channel, totalDeleted, wouldDelete);
    }

    return totalDeleted;
}

async function postLog(client, rule, channel, deleted, wouldDelete) {
    if (!rule.logChannelId) return;
    const logChannel = await client.channels.fetch(rule.logChannelId).catch(() => null);
    if (!logChannel?.isTextBased()) return;

    const embed = new EmbedBuilder()
        .setColor(rule.dryRun ? 0xf59e0b : 0xa78bfa)
        .setTitle(rule.dryRun ? 'Purge rule — dry run' : 'Purge rule ran')
        .setDescription(`**${rule.name}** in <#${channel.id}>`)
        .addFields(
            { name: rule.dryRun ? 'Would delete' : 'Deleted', value: String(rule.dryRun ? wouldDelete : deleted), inline: true },
            { name: 'Message age', value: formatDuration(rule.ttlSeconds), inline: true },
        )
        .setTimestamp();

    await logChannel.send({ embeds: [embed] }).catch(() => {});
}

async function sweep() {
    if (running) return; // a large backlog can outlast one cycle
    running = true;
    try {
        let rules;
        try {
            rules = await loadEnabledRules();
        } catch (err) {
            if (err.code === 'ER_NO_SUCH_TABLE') return; // migration 245 not applied yet
            throw err;
        }
        if (!rules.length) return;

        for (const rule of rules) {
            try {
                await sweepRule(rule);
            } catch (err) {
                logger.error(`[PurgeRules] Rule ${rule.id} failed: ${err.message}`, {
                    category: 'purge', guildId: rule.guildId, channelId: rule.channelId, ruleId: rule.id,
                });
                await pool.execute(
                    'UPDATE channel_purge_rules SET last_error = ?, last_run_at = NOW() WHERE id = ?',
                    [String(err.message).slice(0, 255), rule.id]
                ).catch(() => {});
            }
        }
    } catch (err) {
        logger.error(`[PurgeRules] Sweep failed: ${err.message}`, { category: 'purge' });
    } finally {
        running = false;
    }
}

export function startPurgeRuleSweeper(client) {
    fallbackClient = client;
    if (task) {
        logger.warn('[PurgeRules] Sweeper already running');
        return;
    }
    // Every 30s: the shortest TTL the dashboard allows is 60s, so a message is
    // never alive for more than ~1.5x its TTL.
    task = cron.schedule('*/30 * * * * *', sweep);
    task.start();
    logger.info('[PurgeRules] Sweeper started (every 30s)');
}

export function stopPurgeRuleSweeper() {
    if (task) {
        task.stop();
        task = null;
        logger.info('[PurgeRules] Sweeper stopped');
    }
}

// Exposed so the dashboard can offer a "run now" without waiting for the cron.
export { sweepRule, sweep };
