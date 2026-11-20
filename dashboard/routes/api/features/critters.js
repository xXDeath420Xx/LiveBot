/**
 * Critters game API: `/api/guilds/:guildId/owo/*` (the /owo game's dashboard page,
 * dashboard/views/partials/manage/critters.ejs). The parent router (dashboard/routes/api/index.js) checks the
 * caller manages the server. Every read comes from the critters tables through core/critters (docs/critters-api.md):
 * the game wallet, the real inventory and the real catalog.
 *
 * Responses are `{ success: true, ... }` or `{ error }` with 400 (bad input) or 500. Admin changes to members'
 * games are written to the server's log as owoAdminAction.* (the generic dashboard action log skips /owo routes,
 * dashboard/server.js DASHBOARD_ACTION_SKIP).
 */
import express from 'express';
import { EmbedBuilder } from 'discord.js';
import * as critters from '../../../../core/critters/index.js';
import { sendLogEmbed } from '../../../../core/log-manager.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const { admin } = critters;

const BAD_INPUT = new Set(['BAD_USER_ID', 'UNKNOWN_SPECIES', 'BAD_AMOUNT', 'CONFIRM_REQUIRED', 'BAD_CONFIG', 'BAD_KIND', 'BAD_COUNT']);

function fail(res, err, what) {
    if (critters.isCritterError(err) && BAD_INPUT.has(err.code)) return res.status(400).json({ error: err.message, code: err.code });
    logger.error(`[API critters] ${what} failed: ${err.message}`);
    return res.status(500).json({ error: `Could not ${what}.` });
}

const guildOf = (req) => req.guildObject || req.botClient?.guilds?.cache?.get(req.params.guildId) || null;

/** Write an admin change to the server log (category owoAdminAction). Never fails the request. */
async function auditLog(req, title, action, fields) {
    try {
        const guild = guildOf(req);
        if (!guild) return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(0x5f7a4f)
            .addFields({ name: 'By', value: req.user?.id ? `<@${req.user.id}>` : 'Dashboard', inline: true }, ...fields)
            .setFooter({ text: 'Critters, changed from the dashboard' })
            .setTimestamp();
        await sendLogEmbed(guild, 'owoAdminAction', embed, action);
    } catch (err) {
        logger.debug(`[API critters] audit log failed: ${err.message}`);
    }
}

const member = (id) => ({ name: 'Member', value: `<@${id}> (${id})`, inline: true });
const int = (v) => (v === '' || v == null ? NaN : Math.trunc(Number(v)));

/* ----------------------------------------------------------------------------------------------- config */

router.get('/config', async (req, res) => {
    try {
        const config = await critters.getConfig(req.params.guildId);
        res.json({ success: true, config });
    } catch (err) { fail(res, err, 'load the settings'); }
});

router.put('/config', async (req, res) => {
    try {
        const config = await critters.updateConfig(req.params.guildId, req.body || {});
        res.json({ success: true, config });
    } catch (err) { fail(res, err, 'save the settings'); }
});

/* ----------------------------------------------------------------------------------------------- read-only views */

router.get('/stats', async (req, res) => {
    try {
        res.json({ success: true, stats: await admin.dashboardStats(req.params.guildId) });
    } catch (err) { fail(res, err, 'load the numbers'); }
});

router.get('/catalog', async (req, res) => {
    try {
        const config = await critters.getConfig(req.params.guildId);
        res.json({
            success: true,
            catalog: admin.dashboardCatalog(),
            rewards: admin.rewardTable(config.reward_currency_multiplier),
            currency: { name: critters.CURRENCY.name, singular: critters.CURRENCY.singular },
        });
    } catch (err) { fail(res, err, 'load the catalog'); }
});

/** The command switches: the ten core commands (legacy shape) plus every feature key the server can switch off. */
router.get('/commands', async (req, res) => {
    try {
        const config = await critters.getConfig(req.params.guildId);
        const off = new Set(config.disabled_subcommands);
        res.json({
            success: true,
            commands: admin.commandSwitches(config),
            features: critters.FEATURE_KEYS.map(key => ({ key, enabled: !off.has(key) })),
        });
    } catch (err) { fail(res, err, 'load the commands'); }
});

router.get('/leaderboard/:kind', async (req, res) => {
    try {
        const rows = await admin.leaderboard(req.params.guildId, req.params.kind);
        const guild = guildOf(req);
        const leaderboard = rows.map(r => ({ ...r, displayName: guild?.members?.cache?.get(r.userId)?.displayName || null }));
        res.json({ success: true, leaderboard });
    } catch (err) { fail(res, err, 'load the leaderboard'); }
});

router.get('/module-snapshot', async (req, res) => {
    try {
        res.json({ success: true, snapshot: await admin.moduleSnapshot(req.params.guildId) });
    } catch (err) { fail(res, err, 'load the snapshot'); }
});

async function memberProfile(req, userId) {
    try {
        const guild = guildOf(req);
        const m = guild?.members?.cache?.get(userId) || await guild?.members?.fetch?.(userId).catch(() => null);
        if (!m) return null;
        return { id: m.id, tag: m.user?.tag || m.user?.username, displayName: m.displayName, avatarURL: m.displayAvatarURL?.({ size: 64 }) || null };
    } catch {
        return null;
    }
}

router.get('/user-zoo/:userId', async (req, res) => {
    try {
        const userId = admin.assertUserId(req.params.userId);
        const zoo = await admin.userZoo(req.params.guildId, userId);
        res.json({ success: true, zoo, profile: await memberProfile(req, userId) });
    } catch (err) { fail(res, err, 'load that zoo'); }
});

router.get('/user-full/:userId', async (req, res) => {
    try {
        const userId = admin.assertUserId(req.params.userId);
        const full = await admin.userFull(req.params.guildId, userId);
        res.json({ success: true, profile: await memberProfile(req, userId), ...full });
    } catch (err) { fail(res, err, 'load that member'); }
});

/* ----------------------------------------------------------------------------------------------- admin changes */

router.post('/reset-user', async (req, res) => {
    try {
        const userId = admin.assertUserId(req.body?.userId);
        const out = await admin.resetUser(req.params.guildId, userId);
        await auditLog(req, 'Critters zoo reset', 'owoAdminAction.reset', [member(userId), { name: 'Removed', value: `${out.zooRowsRemoved} critter rows, ${out.cooldownsRemoved} timers`, inline: true }]);
        res.json({ success: true, ...out });
    } catch (err) { fail(res, err, 'reset that member'); }
});

router.post('/reset-guild', async (req, res) => {
    try {
        const out = await admin.resetGuild(req.params.guildId, { confirm: req.body?.confirm === true });
        await auditLog(req, 'Every critters zoo reset', 'owoAdminAction.reset', [{ name: 'Removed', value: `${out.zooRowsRemoved} critter rows from the whole server`, inline: true }]);
        res.json({ success: true, ...out });
    } catch (err) { fail(res, err, 'reset the server'); }
});

router.post('/grant-animal', async (req, res) => {
    try {
        const userId = admin.assertUserId(req.body?.userId);
        const count = int(req.body?.count);
        const out = await admin.grantAnimal(req.params.guildId, userId, String(req.body?.animalKey || ''), count);
        await auditLog(req, count > 0 ? 'Critters given' : 'Critters taken away', count > 0 ? 'owoAdminAction.granted' : 'owoAdminAction.removed',
            [member(userId), { name: 'Critter', value: `${out.animalName} ×${Math.abs(count)} (now ${out.newCount})`, inline: true }]);
        res.json({ success: true, ...out });
    } catch (err) { fail(res, err, 'change that member\'s critters'); }
});

/** Shared by the currency, shards, crates and lootboxes grants: amount > 0 gives, < 0 takes (floored at 0). */
function grantRoute(path, label, grant, { field = 'amount', min = null, max = null } = {}) {
    router.post(path, async (req, res) => {
        try {
            const userId = admin.assertUserId(req.body?.userId);
            const n = int(req.body?.[field]);
            if (!Number.isSafeInteger(n) || n === 0 || (min != null && n < min) || (max != null && n > max)) {
                return res.status(400).json({ error: `The ${field} must be a whole number${min != null ? ` from ${min}` : ''}${max != null ? ` to ${max}` : ''}, not 0.` });
            }
            const out = await grant(req.params.guildId, userId, n);
            await auditLog(req, n > 0 ? `Critters ${label} given` : `Critters ${label} taken away`, n > 0 ? 'owoAdminAction.granted' : 'owoAdminAction.removed',
                [member(userId), { name: label, value: `${n > 0 ? '+' : ''}${n} (now ${out.total})`, inline: true }]);
            res.json({ success: true, delta: out.delta, total: out.total });
        } catch (err) { fail(res, err, `change ${label}`); }
    });
}

grantRoute('/grant-currency', critters.CURRENCY.name, admin.grantCurrency);
grantRoute('/grant-shards', 'shards', admin.grantShards);
grantRoute('/grant-crate', 'weapon crates', admin.grantCrates, { field: 'count', min: 1, max: critters.CRATE_GRANT_MAX });
grantRoute('/grant-lootbox', 'lootboxes', admin.grantLootboxes, { field: 'count', min: 1, max: 1000 });

export default router;
