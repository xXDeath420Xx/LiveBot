/*
 * Top-level shortcuts registered per server: /confess for /fun confess, /birthday for /engage birthday, and so on.
 *
 * The global list has to stay under Discord's 100 cap, so these live inside parent commands. A server has its
 * own list of up to 100 commands on top of the global one, and that is where the shortcuts go. Feature
 * shortcuts appear only in servers where that feature is on (the same rule as the dashboard catalog: flag on, or
 * real config and not flagged off); the rest appear everywhere.
 *
 * A shortcut is not a second implementation. applyShortcut() turns `/confess` back into `/fun confess` before
 * any gate runs, so restrictions, feature switches, cooldowns and the handler are exactly the nested command's.
 * A shortcut for a subcommand group (/birthday) carries the group's subcommands; one for a plain subcommand
 * (/confess) carries its options. Permissions are copied from the parent, so /giveaway stays Manage Server.
 *
 * Registering them:
 *  - Custom bots replace each server's list whole on deploy (core/bot-manager.js runCommandDeploy), so shortcuts
 *    are added to that payload, only into slots the real commands leave free.
 *  - The main bot's per-server lists also hold commands registered elsewhere (cannabis commands from
 *    scripts/deploy-guild-scoped-commands.js, /jellyfin), so it never replaces a list: it creates, updates and
 *    deletes shortcut names only. What it last registered is kept in guild_shortcut_deploys so restarts don't
 *    repeat the work.
 * reconcileShortcuts() runs every 5 minutes and right after a feature is switched (refreshSoon).
 */
import { REST, Routes } from 'discord.js';
import { createHash } from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { guildsWithFeaturesOn } from './feature-flags.js';
import { buildDeployJson } from './command-mounts.js';
import { localizeCommands } from '../utils/command-localization.js';

const LOG = '[GuildShortcuts]';
const SUB = 1, GROUP = 2;

// shortcut → the nested path it stands for, and the feature that must be on (none = every server)
export const SHORTCUTS = {
    // Member features
    confess: { parent: 'fun', sub: 'confess', feature: 'confessions' },
    birthday: { parent: 'engage', sub: 'birthday', feature: 'birthdays' },
    suggest: { parent: 'engage', sub: 'suggest', feature: 'suggestions' },
    emojihunt: { parent: 'arcade', sub: 'emojihunt', feature: 'emoji_hunts' },
    goals: { parent: 'arcade', sub: 'goals', feature: 'community_goals' },
    tree: { parent: 'arcade', sub: 'tree', feature: 'growtree' },
    loyalty: { parent: 'level', sub: 'loyalty', feature: 'loyalty' },
    // Staff features (Manage Server, copied from /manage)
    giveaway: { parent: 'manage', sub: 'giveaway', feature: 'giveaways' },
    poll: { parent: 'manage', sub: 'poll', feature: 'polls' },
    // Every server
    ping: { parent: 'tools', sub: 'ping' },
    owoify: { parent: 'fun', sub: 'owoify' },
    kofi: { parent: 'creator', sub: 'kofi' },
    throne: { parent: 'creator', sub: 'throne' },
    charts: { parent: 'server', sub: 'charts' },
};

const FEATURE_KEYS = [...new Set(Object.values(SHORTCUTS).map(s => s.feature).filter(Boolean))];
const hashOf = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Command JSON for the shortcuts in `names`, cut from the deployed top-level list (mounted and localized, so a
 * shortcut is always identical to what members see nested). A name that is already a top-level command, or whose
 * target is missing, is skipped.
 */
export function buildShortcutJson(topLevel, names) {
    const byName = new Map(topLevel.map(c => [c.name, c]));
    const out = [];
    for (const name of names) {
        const s = SHORTCUTS[name];
        if (!s || byName.has(name)) continue;
        const parent = byName.get(s.parent);
        const target = parent?.options?.find(o => o.name === s.sub && (o.type === SUB || o.type === GROUP));
        if (!target) continue;
        out.push({
            type: 1,
            name,
            description: target.description,
            ...(target.description_localizations ? { description_localizations: target.description_localizations } : {}),
            options: target.options ?? [],
            default_member_permissions: parent.default_member_permissions ?? null,
        });
    }
    return out;
}

/**
 * Turn a shortcut interaction back into the nested command, in place, before dispatch (and before applyMount,
 * which then carries /tools ping on to /ping). Only guild-registered commands are touched.
 * Returns the parent's name, or null when this is not a shortcut.
 */
export function applyShortcut(interaction) {
    const s = SHORTCUTS[interaction.commandName];
    const base = interaction.options;
    if (!s || !interaction.commandGuildId || !base) return null;
    const shim = Object.create(base);
    if (base.getSubcommand?.(false)) {
        // Stands for a group: the member picked one of the group's subcommands.
        shim.getSubcommandGroup = () => s.sub;
        Object.defineProperty(shim, '_group', { value: s.sub });
    } else {
        // Stands for a plain subcommand.
        shim.getSubcommandGroup = () => null;
        shim.getSubcommand = () => s.sub;
        Object.defineProperty(shim, '_group', { value: null });
        Object.defineProperty(shim, '_subcommand', { value: s.sub });
    }
    interaction.options = shim;
    interaction.shortcutFrom = interaction.commandName;
    interaction.commandName = s.parent;
    return s.parent;
}

/**
 * guildId → Set of feature keys on there, for the features shortcuts need. Same rule as the catalog
 * (core/feature-flags.js guildsWithFeaturesOn): the feature's own switch where it has one (Confessions
 * off on its page, or from the catalog, removes /confess), otherwise real config unless flagged off.
 */
async function activeFeatures() {
    return guildsWithFeaturesOn(FEATURE_KEYS);
}

/** Shortcut names a guild should have, given activeFeatures(). */
function namesFor(guildId, active) {
    const on = active.get(String(guildId));
    return Object.keys(SHORTCUTS).filter(n => !SHORTCUTS[n].feature || on?.has(SHORTCUTS[n].feature));
}

/** guildId → shortcut names, for the custom-bot deploy. */
export async function shortcutNamesByGuild(guildIds) {
    const active = await activeFeatures();
    return new Map(guildIds.map(g => [String(g), namesFor(g, active)]));
}

/** Main bot: bring one server's shortcut commands to `desired`, touching nothing else. Returns true on change. */
async function syncMainBotGuild(rest, appId, guildId, desired) {
    const want = Object.fromEntries(desired.map(c => [c.name, hashOf(c)]));
    const [[row]] = await pool.query(
        'SELECT commands_json FROM guild_shortcut_deploys WHERE bot_id = ? AND guild_id = ?', [appId, guildId]);
    const had = row ? JSON.parse(row.commands_json || '{}') : null;
    if (had && JSON.stringify(Object.entries(had).sort()) === JSON.stringify(Object.entries(want).sort())) return false;

    const existing = await rest.get(Routes.applicationGuildCommands(appId, guildId));
    for (const cmd of desired) {
        const there = existing.some(e => e.name === cmd.name);
        if (there && had?.[cmd.name] === want[cmd.name]) continue;
        // POST upserts by name, so a changed shortcut is updated in place and nothing else is replaced.
        await rest.post(Routes.applicationGuildCommands(appId, guildId), { body: cmd });
        await sleep(250);
    }
    for (const e of existing) {
        if (SHORTCUTS[e.name] && !(e.name in want)) {
            await rest.delete(Routes.applicationGuildCommand(appId, guildId, e.id));
            await sleep(250);
        }
    }
    await pool.query(
        `INSERT INTO guild_shortcut_deploys (bot_id, guild_id, commands_json) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE commands_json = VALUES(commands_json), updated_at = NOW()`,
        [appId, guildId, JSON.stringify(want)]);
    return true;
}

/** Forget what the main bot registered in these servers (a custom bot took over and cleared its list). */
export async function forgetMainBotGuilds(appId, guildIds) {
    if (!guildIds.length) return;
    await pool.query('DELETE FROM guild_shortcut_deploys WHERE bot_id = ? AND guild_id IN (?)', [appId, guildIds]);
}

let queue = Promise.resolve();
/**
 * Bring every server (or just `onlyGuild`) to the shortcuts it should have. Main bot: per-command sync.
 * Custom bots: a normal deploy when any of their servers' shortcut sets changed (it skips unchanged servers).
 * Runs one at a time; a call made during a run waits for it.
 */
export function reconcileShortcuts(botManager, opts = {}) {
    queue = queue.then(() => runReconcile(botManager, opts))
        .catch(e => logger.error(`${LOG} reconcile failed: ${e.message}`));
    return queue;
}

async function runReconcile(botManager, { onlyGuild = null } = {}) {
    const active = await activeFeatures();
    const customGuilds = new Set();
    botManager.shortcutSigs ??= new Map();

    for (const [botId, client] of botManager.clients) {
        if (client.isDefaultBot || !client.assignedGuilds?.length) continue;
        for (const g of client.assignedGuilds) customGuilds.add(String(g));
        const guilds = client.assignedGuilds.map(String).filter(g => !onlyGuild || g === onlyGuild);
        const stale = guilds.some(g => botManager.shortcutSigs.get(`${botId}:${g}`) !== namesFor(g, active).join(','));
        if (stale) await botManager.deployCommandsForBot(client, botId);
    }

    const main = botManager.getDefaultClient?.();
    const appId = main?.application?.id || process.env.DISCORD_CLIENT_ID;
    if (!main?.isReady?.() || !appId) return;
    const topLevel = localizeCommands(buildDeployJson(Array.from(main.commands.values())
        .filter(c => !c.guildScoped && c.data?.toJSON)));
    const rest = new REST().setToken(main.token);
    let changed = 0, failed = 0;
    for (const guildId of main.guilds.cache.keys()) {
        if (customGuilds.has(guildId) || (onlyGuild && guildId !== onlyGuild)) continue;
        try {
            if (await syncMainBotGuild(rest, appId, guildId, buildShortcutJson(topLevel, namesFor(guildId, active)))) changed++;
        } catch (e) {
            failed++;
            logger.warn(`${LOG} guild ${guildId}: ${e.status || ''} ${e.message}`);
        }
    }
    if (changed || failed) logger.info(`${LOG} main bot: ${changed} server(s) updated, ${failed} failed`);
}

const pending = new Map();
/** A feature was switched in this server: update its shortcuts shortly (debounced). */
export function refreshSoon(guildId) {
    if (!guildId || !global.botManager) return;
    clearTimeout(pending.get(guildId));
    pending.set(guildId, setTimeout(() => {
        pending.delete(guildId);
        reconcileShortcuts(global.botManager, { onlyGuild: String(guildId) });
    }, 3000));
}

let timer = null;
export function startGuildShortcuts(botManager) {
    if (timer) return;
    setTimeout(() => reconcileShortcuts(botManager), 60_000);
    timer = setInterval(() => reconcileShortcuts(botManager), 5 * 60_000);
}
