/**
 * OwO-style module API — per-guild config, stats, catalog, admin ops.
 *
 * All routes live under `/api/guilds/:guildId/owo/*` which is already
 * gated by `apiCheckGuildAdmin` at the parent router, so `req.guildObject`
 * is pre-populated and callers have at least Manage Guild.
 *
 * See /LICENSE-OWO-NOTICE.md for the module's derivative-license scope.
 */
import express from 'express';
import { EmbedBuilder } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import {
    getConfig,
    invalidateConfigCache,
    listCatalog,
    getZoo,
    resetUserZoo,
    resetGuildZoo,
    grantAnimal,
} from '../../../../core/owo/manager.js';
import { sendLogEmbed } from '../../../../core/log-manager.js';

const router = express.Router({ mergeParams: true });

// ── Validation helpers ────────────────────────────────────────────────

const MULT_MIN = 0.1, MULT_MAX = 10.0;
const COOLDOWN_MIN = 1, COOLDOWN_MAX = 3600;

const KNOWN_SUBCOMMANDS = [
    // /owo core
    'hunt', 'zoo', 'leaderboard', 'catalog',
    'sell', 'sacrifice', 'daily', 'balance', 'give', 'stats',
    // /owo teams + battle
    'team', 'team-create', 'team-add', 'team-remove', 'team-switch',
    'team-rename', 'equip', 'unequip', 'pet-name', 'battle',
    // /owo weapons + quests
    'weapon', 'crate', 'quest',
    // /owo2 shard/forge/ranch overflow
    'shards', 'dismantle', 'forge', 'favorite', 'forge-prices',
    'ranch', 'ranch-claim',
    // top-level commands
    'autohunt', 'luck',
];

function clampNum(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
}

function sanitizeSnowflakeArray(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(v => typeof v === 'string' && /^\d{15,25}$/.test(v));
}

function sanitizeSubcommandArray(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(v => KNOWN_SUBCOMMANDS.includes(v));
}

async function auditLog(req, embedBuilder) {
    try {
        const guild = req.guildObject;
        if (!guild) return;
        const embed = embedBuilder(guild);
        await sendLogEmbed(guild, 'owoAdminAction', embed);
    } catch (e) {
        logger.warn('[OwO API] audit log failed (non-fatal)', { err: e.message });
    }
}

// ── Config ────────────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
    try {
        const cfg = await getConfig(req.params.guildId);
        res.json({ success: true, config: cfg });
    } catch (error) {
        logger.error('[API OwO Config GET]', error);
        res.status(500).json({ error: 'Failed to fetch OwO config' });
    }
});

/**
 * Partial update: only fields present in the body are changed. Uses
 * read-modify-write so unspecified columns keep their existing value.
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const current = await getConfig(guildId);
        const body = req.body || {};
        const next = { ...current };

        if ('enabled' in body) next.enabled = body.enabled ? 1 : 0;
        if ('hunt_cooldown_seconds' in body) {
            const v = clampNum(body.hunt_cooldown_seconds, COOLDOWN_MIN, COOLDOWN_MAX);
            if (v === null) return res.status(400).json({ error: 'hunt_cooldown_seconds must be a number' });
            next.hunt_cooldown_seconds = Math.trunc(v);
        }
        for (const key of ['reward_currency_multiplier', 'reward_xp_multiplier', 'sell_multiplier', 'sacrifice_xp_multiplier']) {
            if (key in body) {
                const v = clampNum(body[key], MULT_MIN, MULT_MAX);
                if (v === null) return res.status(400).json({ error: `${key} must be a number in [${MULT_MIN}, ${MULT_MAX}]` });
                next[key] = v;
            }
        }
        if ('disabled_subcommands' in body) next.disabled_subcommands = sanitizeSubcommandArray(body.disabled_subcommands);
        if ('allowed_channel_ids' in body) next.allowed_channel_ids = sanitizeSnowflakeArray(body.allowed_channel_ids);
        if ('blocked_role_ids' in body) next.blocked_role_ids = sanitizeSnowflakeArray(body.blocked_role_ids);
        if ('announce_rare_catches' in body) next.announce_rare_catches = body.announce_rare_catches ? 1 : 0;

        await pool.execute(
            `INSERT INTO owo_config (
                guild_id, enabled, hunt_cooldown_seconds,
                reward_currency_multiplier, reward_xp_multiplier,
                sell_multiplier, sacrifice_xp_multiplier,
                disabled_subcommands, allowed_channel_ids, blocked_role_ids,
                announce_rare_catches
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                hunt_cooldown_seconds = VALUES(hunt_cooldown_seconds),
                reward_currency_multiplier = VALUES(reward_currency_multiplier),
                reward_xp_multiplier = VALUES(reward_xp_multiplier),
                sell_multiplier = VALUES(sell_multiplier),
                sacrifice_xp_multiplier = VALUES(sacrifice_xp_multiplier),
                disabled_subcommands = VALUES(disabled_subcommands),
                allowed_channel_ids = VALUES(allowed_channel_ids),
                blocked_role_ids = VALUES(blocked_role_ids),
                announce_rare_catches = VALUES(announce_rare_catches)`,
            [
                guildId, next.enabled, next.hunt_cooldown_seconds,
                next.reward_currency_multiplier, next.reward_xp_multiplier,
                next.sell_multiplier, next.sacrifice_xp_multiplier,
                JSON.stringify(next.disabled_subcommands),
                JSON.stringify(next.allowed_channel_ids),
                JSON.stringify(next.blocked_role_ids),
                next.announce_rare_catches,
            ]
        );

        invalidateConfigCache(guildId);
        res.json({ success: true, config: next });
    } catch (error) {
        logger.error('[API OwO Config PUT]', error);
        res.status(500).json({ error: 'Failed to update OwO config' });
    }
});

// ── Stats ─────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [[totals]] = await pool.execute(
            `SELECT COUNT(DISTINCT user_id) AS hunters,
                    COUNT(*) AS unique_catches,
                    COALESCE(SUM(count), 0) AS total_catches
             FROM owo_zoo WHERE guild_id = ?`, [guildId]
        );

        const [byRank] = await pool.execute(
            `SELECT rank, COUNT(*) AS unique_animals, COALESCE(SUM(count), 0) AS total
             FROM owo_zoo WHERE guild_id = ?
             GROUP BY rank`, [guildId]
        );

        const [topHunters] = await pool.execute(
            `SELECT user_id, SUM(count) AS total, COUNT(*) AS unique_animals
             FROM owo_zoo WHERE guild_id = ?
             GROUP BY user_id ORDER BY total DESC LIMIT 10`, [guildId]
        );

        // Last 24h catch rate, using last_caught on updated rows.
        const [[rate]] = await pool.execute(
            `SELECT COALESCE(SUM(count), 0) AS recent_total
             FROM owo_zoo
             WHERE guild_id = ? AND last_caught >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
            [guildId]
        );

        res.json({
            success: true,
            stats: {
                hunters: Number(totals?.hunters) || 0,
                uniqueCatches: Number(totals?.unique_catches) || 0,
                totalCatches: Number(totals?.total_catches) || 0,
                last24hCatches: Number(rate?.recent_total) || 0,
                byRank: byRank.map(r => ({
                    rank: r.rank,
                    uniqueAnimals: Number(r.unique_animals),
                    total: Number(r.total),
                })),
                topHunters: topHunters.map(r => ({
                    userId: r.user_id,
                    total: Number(r.total),
                    uniqueAnimals: Number(r.unique_animals),
                })),
            },
        });
    } catch (error) {
        logger.error('[API OwO Stats GET]', error);
        res.status(500).json({ error: 'Failed to fetch OwO stats' });
    }
});

// ── Catalog ───────────────────────────────────────────────────────────

router.get('/catalog', (req, res) => {
    try {
        res.json({ success: true, catalog: listCatalog() });
    } catch (error) {
        logger.error('[API OwO Catalog GET]', error);
        res.status(500).json({ error: 'Failed to fetch catalog' });
    }
});

// ── Command reference ────────────────────────────────────────────────

const COMMANDS = [
    { name: 'hunt',        slash: '/owo hunt',                      prefix: 'owo hunt',            aliases: ['h', 'catch'],          category: 'Actions',  description: 'Hunt for a random animal.' },
    { name: 'sell',        slash: '/owo sell <rank>',               prefix: 'owo sell <rank>',     aliases: [],                      category: 'Actions',  description: 'Sell duplicates of a rank for currency (keeps 1 of each).' },
    { name: 'sacrifice',   slash: '/owo sacrifice <rank>',          prefix: 'owo sacrifice <rank>',aliases: ['sac'],                 category: 'Actions',  description: 'Sacrifice duplicates of a rank for XP.' },
    { name: 'daily',       slash: '/owo daily',                     prefix: 'owo daily',           aliases: [],                      category: 'Economy', description: 'Claim the daily currency reward.' },
    { name: 'balance',     slash: '/owo balance',                   prefix: 'owo balance',         aliases: ['bal', 'money', 'cowoncy'], category: 'Economy', description: 'Show your wallet + bank.' },
    { name: 'give',        slash: '/owo give <user> <amount>',      prefix: 'owo give @user <amt>',aliases: ['gift'],                category: 'Economy', description: 'Transfer currency to another member.' },
    { name: 'zoo',         slash: '/owo zoo [user]',                prefix: 'owo zoo',             aliases: [],                      category: 'Viewers', description: 'Show your (or another member\'s) zoo.' },
    { name: 'leaderboard', slash: '/owo leaderboard',               prefix: 'owo leaderboard',     aliases: ['lb', 'top'],           category: 'Viewers', description: 'Top 10 hunters in this server.' },
    { name: 'catalog',     slash: '/owo catalog',                   prefix: 'owo catalog',         aliases: ['dex'],                 category: 'Viewers', description: 'Browse every animal by rank.' },
    { name: 'stats',       slash: '/owo stats [user]',              prefix: 'owo stats',           aliases: [],                      category: 'Viewers', description: 'Detailed stats — by rank + rarest find.' },
];

router.get('/commands', async (req, res) => {
    try {
        const cfg = await getConfig(req.params.guildId);
        const disabled = new Set(cfg.disabled_subcommands);
        res.json({
            success: true,
            commands: COMMANDS.map(c => ({ ...c, enabled: !disabled.has(c.name) })),
        });
    } catch (error) {
        logger.error('[API OwO Commands GET]', error);
        res.status(500).json({ error: 'Failed to fetch command list' });
    }
});

// ── Admin: inspect + reset + grant ────────────────────────────────────

router.get('/user-zoo/:userId', async (req, res) => {
    try {
        const { guildId, userId } = req.params;
        if (!/^\d{15,25}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const zoo = await getZoo(guildId, userId);

        // Hydrate display name/avatar from the bot's guild cache if available
        let profile = null;
        try {
            const member = await req.guildObject?.members.fetch(userId).catch(() => null);
            if (member) {
                profile = {
                    id: member.id,
                    tag: member.user.tag,
                    displayName: member.displayName,
                    avatarURL: member.user.displayAvatarURL({ size: 128 }),
                };
            }
        } catch { /* profile optional */ }

        res.json({ success: true, zoo, profile: profile || { id: userId } });
    } catch (error) {
        logger.error('[API OwO User Zoo GET]', error);
        res.status(500).json({ error: 'Failed to fetch user zoo' });
    }
});

router.post('/reset-user', async (req, res) => {
    try {
        const { guildId } = req.params;
        const userId = String(req.body?.userId || '');
        if (!/^\d{15,25}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const result = await resetUserZoo(guildId, userId);
        auditLog(req, (guild) => new EmbedBuilder()
            .setColor(0xF44336)
            .setTitle('🗑️ OwO zoo reset — user')
            .setDescription(`Dashboard admin reset <@${userId}>'s OwO data.`)
            .addFields(
                { name: 'Actor', value: `<@${req.user.id}>`, inline: true },
                { name: 'Rows removed', value: `zoo: ${result.zooRowsRemoved} · cooldowns: ${result.cooldownsRemoved}`, inline: true }
            )
            .setTimestamp()
        );
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[API OwO Reset User]', error);
        res.status(500).json({ error: 'Failed to reset user zoo' });
    }
});

router.post('/reset-guild', async (req, res) => {
    try {
        if (req.body?.confirm !== true) {
            return res.status(400).json({ error: 'Must include { confirm: true } in body.' });
        }
        const { guildId } = req.params;
        const result = await resetGuildZoo(guildId);
        auditLog(req, (guild) => new EmbedBuilder()
            .setColor(0xF44336)
            .setTitle('💣 OwO zoo reset — entire guild')
            .setDescription(`Dashboard admin wiped every OwO zoo in this server.`)
            .addFields(
                { name: 'Actor', value: `<@${req.user.id}>`, inline: true },
                { name: 'Rows removed', value: `zoo: ${result.zooRowsRemoved} · cooldowns: ${result.cooldownsRemoved}`, inline: true }
            )
            .setTimestamp()
        );
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[API OwO Reset Guild]', error);
        res.status(500).json({ error: 'Failed to reset guild zoo' });
    }
});

router.post('/grant-animal', async (req, res) => {
    try {
        const { guildId } = req.params;
        const userId = String(req.body?.userId || '');
        const animalKey = String(req.body?.animalKey || '').toLowerCase();
        const count = Math.trunc(Number(req.body?.count ?? 1));

        if (!/^\d{15,25}$/.test(userId)) return res.status(400).json({ error: 'Invalid user ID' });
        if (!animalKey) return res.status(400).json({ error: 'animalKey required' });
        if (!Number.isFinite(count) || count === 0) return res.status(400).json({ error: 'count must be a non-zero integer' });

        const result = await grantAnimal(guildId, userId, animalKey, count);
        if (result.error) return res.status(400).json({ error: result.error });

        auditLog(req, (guild) => new EmbedBuilder()
            .setColor(count > 0 ? 0x4CAF50 : 0xFF9800)
            .setTitle(count > 0 ? '🎁 OwO animal granted' : '➖ OwO animal removed')
            .addFields(
                { name: 'Actor',  value: `<@${req.user.id}>`, inline: true },
                { name: 'Target', value: `<@${userId}>`,     inline: true },
                { name: 'Animal', value: `${animalKey} (${result.rank})`, inline: true },
                { name: 'Delta',  value: String(count),      inline: true },
                { name: 'New count', value: String(result.newCount), inline: true }
            )
            .setTimestamp()
        );
        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[API OwO Grant Animal]', error);
        res.status(500).json({ error: 'Failed to grant animal' });
    }
});

// ── Extended admin: full-context user snapshot + grants + leaderboards ──
//
// These were added in Phase 9 of the OwO port — they let admins inspect
// and award every new subsystem (weapons, teams, autohunt, quests, ranch,
// luck) without opening a shell.

import { listWeapons } from '../../../../core/owo/weapons-service.js';
import { listTeams, getTeamDetails } from '../../../../core/owo/teams-service.js';
import { status as autohuntStatus } from '../../../../core/owo/autohunt-service.js';
import { listQuests } from '../../../../core/owo/quests-service.js';
import { status as ranchStatus } from '../../../../core/owo/ranch-service.js';
import { getLuckStats } from '../../../../core/owo/luck-service.js';
import { getShards, adminGrantCrate } from '../../../../core/owo/weapons-service.js';
import { addCowoncy, getCowoncy } from '../../../../core/owo/cowoncy.js';

/**
 * GET /api/guilds/:guildId/owo/user-full/:userId
 * Full snapshot of an OwO user: zoo + stats + weapons (count + top 5) +
 * teams + autohunt + quests + ranch + luck + wallet + shards.
 */
router.get('/user-full/:userId', async (req, res) => {
    try {
        const { guildId, userId } = req.params;
        if (!/^\d{15,25}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const [zoo, weapons, teams, ah, quests, ranch, luck, wallet, shards] = await Promise.all([
            getZoo(guildId, userId).catch(() => null),
            listWeapons(guildId, userId, { limit: 10 }).catch(() => []),
            listTeams(guildId, userId).catch(() => []),
            autohuntStatus(guildId, userId).catch(() => ({ enabled: false })),
            listQuests(guildId, userId).catch(() => []),
            ranchStatus(guildId, userId).catch(() => ({ hasTeam: false })),
            getLuckStats(guildId, userId).catch(() => ({ lifetimeRolls: 0 })),
            getCowoncy(guildId, userId).catch(() => 0),
            getShards(guildId, userId).catch(() => 0),
        ]);

        // Total weapon count (listWeapons is paged to top 10; grab the raw count too)
        const [[{ total: weaponTotal }]] = await pool.execute(
            'SELECT COUNT(*) AS total FROM owo_user_weapon WHERE guild_id = ? AND uid = ?',
            [guildId, userId]
        );

        // Active team with full details (if any)
        let activeTeam = null;
        try {
            activeTeam = await getTeamDetails(guildId, userId);
        } catch { /* ignore */ }

        let profile = null;
        try {
            const member = await req.guildObject?.members.fetch(userId).catch(() => null);
            if (member) {
                profile = {
                    id: member.id,
                    tag: member.user.tag,
                    displayName: member.displayName,
                    avatarURL: member.user.displayAvatarURL({ size: 128 }),
                };
            }
        } catch { /* optional */ }

        res.json({
            success: true,
            profile: profile || { id: userId },
            wallet,
            shards,
            zoo,
            weapons: { total: Number(weaponTotal) || 0, top: weapons },
            teams,
            activeTeam,
            autohunt: ah,
            quests,
            ranch,
            luck,
        });
    } catch (error) {
        logger.error('[API OwO User Full]', error);
        res.status(500).json({ error: 'Failed to fetch user snapshot' });
    }
});

/**
 * POST /api/guilds/:guildId/owo/grant-shards
 * Admin grant: add shards to a user's balance.
 */
router.post('/grant-shards', async (req, res) => {
    try {
        const { guildId } = req.params;
        const userId = String(req.body?.userId || '');
        const amount = Math.trunc(Number(req.body?.amount ?? 0));
        if (!/^\d{15,25}$/.test(userId)) return res.status(400).json({ error: 'Invalid user ID' });
        if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be non-zero' });

        await pool.execute(
            `INSERT INTO owo_shards (guild_id, uid, count) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE count = GREATEST(0, count + VALUES(count))`,
            [guildId, userId, amount]
        );
        const total = await getShards(guildId, userId);

        auditLog(req, () => new EmbedBuilder()
            .setColor(amount > 0 ? 0x4CAF50 : 0xFF9800)
            .setTitle(amount > 0 ? '💠 Shards granted' : '➖ Shards removed')
            .addFields(
                { name: 'Actor',  value: `<@${req.user.id}>`, inline: true },
                { name: 'Target', value: `<@${userId}>`, inline: true },
                { name: 'Delta',  value: String(amount), inline: true },
                { name: 'New total', value: String(total), inline: true }
            ).setTimestamp()
        );
        res.json({ success: true, delta: amount, total });
    } catch (error) {
        logger.error('[API OwO Grant Shards]', error);
        res.status(500).json({ error: 'Failed to grant shards' });
    }
});

/**
 * POST /api/guilds/:guildId/owo/grant-currency
 * Admin grant: credit guild-native currency through economy-manager.
 */
router.post('/grant-currency', async (req, res) => {
    try {
        const { guildId } = req.params;
        const userId = String(req.body?.userId || '');
        const amount = Math.trunc(Number(req.body?.amount ?? 0));
        if (!/^\d{15,25}$/.test(userId)) return res.status(400).json({ error: 'Invalid user ID' });
        if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be non-zero' });

        await addCowoncy(guildId, userId, amount, `Dashboard admin grant by ${req.user.id}`);
        const total = await getCowoncy(guildId, userId);

        auditLog(req, () => new EmbedBuilder()
            .setColor(amount > 0 ? 0x4CAF50 : 0xFF9800)
            .setTitle(amount > 0 ? '💰 Currency granted' : '➖ Currency deducted')
            .addFields(
                { name: 'Actor',  value: `<@${req.user.id}>`, inline: true },
                { name: 'Target', value: `<@${userId}>`, inline: true },
                { name: 'Delta',  value: String(amount), inline: true },
                { name: 'New total', value: String(total), inline: true }
            ).setTimestamp()
        );
        res.json({ success: true, delta: amount, total });
    } catch (error) {
        logger.error('[API OwO Grant Currency]', error);
        res.status(500).json({ error: 'Failed to grant currency' });
    }
});

/**
 * POST /api/guilds/:guildId/owo/grant-crate
 * Admin grant: add weapon crate(s) to a user's crate inventory.
 */
router.post('/grant-crate', async (req, res) => {
    try {
        const { guildId } = req.params;
        const userId = String(req.body?.userId || '');
        const count = Math.trunc(Number(req.body?.count ?? 1));
        if (!/^\d{15,25}$/.test(userId)) return res.status(400).json({ error: 'Invalid user ID' });
        if (!Number.isFinite(count) || count <= 0 || count > 1000) return res.status(400).json({ error: 'count must be between 1 and 1000' });

        await adminGrantCrate(guildId, userId, count);
        const [[row]] = await pool.execute(
            'SELECT boxcount FROM owo_crate WHERE guild_id = ? AND uid = ? AND cratetype = 0',
            [guildId, userId]
        );
        const total = Number(row?.boxcount) || 0;

        auditLog(req, () => new EmbedBuilder()
            .setColor(0x4CAF50)
            .setTitle('📦 Weapon crate(s) granted')
            .addFields(
                { name: 'Actor',  value: `<@${req.user.id}>`, inline: true },
                { name: 'Target', value: `<@${userId}>`, inline: true },
                { name: 'Count',  value: String(count), inline: true },
                { name: 'New total', value: String(total), inline: true }
            ).setTimestamp()
        );
        res.json({ success: true, delta: count, total });
    } catch (error) {
        logger.error('[API OwO Grant Crate]', error);
        res.status(500).json({ error: 'Failed to grant crate' });
    }
});

/**
 * GET /api/guilds/:guildId/owo/leaderboard/:kind
 * kind: 'battle' (W/L streak) or 'wealth' (currency top).
 */
router.get('/leaderboard/:kind', async (req, res) => {
    try {
        const { guildId } = req.params;
        const kind = String(req.params.kind || '').toLowerCase();

        if (kind === 'battle') {
            const [rows] = await pool.execute(
                `SELECT uid, tname, win, lose, streak, highest_streak
                 FROM owo_pet_team
                 WHERE guild_id = ?
                 ORDER BY win DESC, highest_streak DESC
                 LIMIT 15`,
                [guildId]
            );
            return res.json({
                success: true,
                leaderboard: rows.map(r => ({
                    userId: r.uid,
                    teamName: r.tname,
                    wins: Number(r.win) || 0,
                    losses: Number(r.lose) || 0,
                    streak: Number(r.streak) || 0,
                    highestStreak: Number(r.highest_streak) || 0,
                })),
            });
        }
        if (kind === 'wealth') {
            // guild-native economy table; schema lives outside this module.
            // Best-effort: read from `economy` — if schema doesn't match, empty.
            try {
                const [rows] = await pool.execute(
                    `SELECT user_id, wallet FROM economy
                     WHERE guild_id = ?
                     ORDER BY wallet DESC
                     LIMIT 15`,
                    [guildId]
                );
                return res.json({
                    success: true,
                    leaderboard: rows.map(r => ({ userId: r.user_id, wallet: Number(r.wallet) || 0 })),
                });
            } catch {
                return res.json({ success: true, leaderboard: [], note: 'Economy table not accessible' });
            }
        }
        if (kind === 'hunters') {
            const [rows] = await pool.execute(
                `SELECT id AS user_id, total, common, uncommon, rare, epic, mythical, legendary
                 FROM owo_animal_count
                 WHERE guild_id = ?
                 ORDER BY total DESC LIMIT 15`,
                [guildId]
            );
            return res.json({
                success: true,
                leaderboard: rows.map(r => ({
                    userId: r.user_id,
                    total: Number(r.total) || 0,
                    common: Number(r.common) || 0,
                    uncommon: Number(r.uncommon) || 0,
                    rare: Number(r.rare) || 0,
                    epic: Number(r.epic) || 0,
                    mythical: Number(r.mythical) || 0,
                    legendary: Number(r.legendary) || 0,
                })),
            });
        }
        res.status(400).json({ error: 'Unknown leaderboard kind. Use: battle, wealth, hunters.' });
    } catch (error) {
        logger.error('[API OwO Leaderboard]', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

/**
 * GET /api/guilds/:guildId/owo/module-snapshot
 * Guild-wide rollup — how many users have engaged with each subsystem.
 */
router.get('/module-snapshot', async (req, res) => {
    try {
        const { guildId } = req.params;
        const queries = [
            ['hunters',         "SELECT COUNT(DISTINCT id) n FROM owo_animal WHERE guild_id = ?"],
            ['weaponOwners',    "SELECT COUNT(DISTINCT uid) n FROM owo_user_weapon WHERE guild_id = ?"],
            ['teamOwners',      "SELECT COUNT(DISTINCT uid) n FROM owo_pet_team WHERE guild_id = ?"],
            ['battlesFought',   "SELECT COALESCE(SUM(win+lose), 0) n FROM owo_pet_team WHERE guild_id = ?"],
            ['autohuntActive',  "SELECT COUNT(*) n FROM owo_autohunt WHERE guild_id = ?"],
            ['questHolders',    "SELECT COUNT(DISTINCT uid) n FROM owo_quest WHERE guild_id = ? AND claimed IS NULL"],
            ['ranchClaims',     "SELECT COUNT(*) n FROM owo_cooldowns WHERE guild_id = ? AND command = 'ranch'"],
            ['luckRolls',       "SELECT COALESCE(SUM(lcount), 0) n FROM owo_luck WHERE guild_id = ?"],
            ['cratesUnopened',  "SELECT COALESCE(SUM(boxcount), 0) n FROM owo_crate WHERE guild_id = ?"],
            ['totalShards',     "SELECT COALESCE(SUM(count), 0) n FROM owo_shards WHERE guild_id = ?"],
        ];
        const out = {};
        for (const [key, sql] of queries) {
            try { const [[r]] = await pool.execute(sql, [guildId]); out[key] = Number(r?.n) || 0; }
            catch (e) { out[key] = 0; }
        }
        res.json({ success: true, snapshot: out });
    } catch (error) {
        logger.error('[API OwO Module Snapshot]', error);
        res.status(500).json({ error: 'Failed to build snapshot' });
    }
});

export default router;
