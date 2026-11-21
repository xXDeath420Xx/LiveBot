/*
 * Watch Together: a server's settings and who may do what. Reuses the Cinema settings (cinema_config, the dashboard's
 * Cinema page) and the Watch party page's host role, exactly as /movie does (handlers/cinema/state.js):
 *   enabled = 1 and watch_mode = 'activity'   Watch Together is on in this server
 *   jellyfin_library_id                       the library it may show (NULL: every video library)
 *   control_role_id                           may control any session, not only one they host
 *   Watch party host_role_id                  when set, only members with it (or Manage Server) may start a title
 */
import { PermissionFlagsBits } from 'discord.js';

export const WATCH_MODES = Object.freeze(['stream', 'activity']);

/** Discord's link that adds CertiFried to a member's own account (User Install), for servers run by a custom bot. */
export const USER_INSTALL_URL = 'https://discord.com/oauth2/authorize?client_id=1409904443125665875&integration_type=1&scope=applications.commands';

/**
 * The bot client that can see this server: the main bot when it is in it, else the server's own custom-branded bot
 * (core/bot-manager.js getClientForGuild). null when no CertiFried bot is in the server. The Activity belongs to the
 * main application only; in a custom-bot server members open it through their own install (User Install), and the
 * custom bot is what reads their roles and permissions.
 */
export function guildClientFor(mainClient, guildId, botManager = global.botManager) {
    if (!guildId) return null;
    if (mainClient?.guilds?.cache?.has?.(guildId)) return mainClient;
    const other = botManager?.getClientForGuild?.(guildId) || null;
    return other?.guilds?.cache?.has?.(guildId) ? other : null;
}

/** Is this server run by a custom-branded bot instead of the main one (so members need CertiFried on their account)? */
export function servedByCustomBot(mainClient, guildId, botManager = global.botManager) {
    const c = guildClientFor(mainClient, guildId, botManager);
    return !!c && c !== mainClient;
}

export async function loadWatchConfig(pool, guildId) {
    if (!guildId) return null;
    let row;
    try {
        const [rows] = await pool.execute('SELECT * FROM cinema_config WHERE guild_id = ?', [guildId]);
        row = rows[0];
    } catch {
        return null;
    }
    if (!row) return null;
    return {
        enabled: Number(row.enabled) === 1,
        mode: 'activity', // the Go Live stream (the CertiFried-Cinema selfbot) was retired on 2026-11-20
        libraryId: row.jellyfin_library_id ? String(row.jellyfin_library_id) : null,
        controlRoleId: row.control_role_id ? String(row.control_role_id) : null,
    };
}

/** The Cinema page's note for a server run by a custom-branded bot, or null (dashboard feature-config GET). */
export function customBotWatchNotice(mainClient, guildId, botManager = global.botManager) {
    if (!servedByCustomBot(mainClient, guildId, botManager)) return null;
    return {
        kind: 'info',
        title: 'This server uses its own bot.',
        text: 'Watch Together belongs to CertiFried, not to this server\'s bot, so members open it themselves. Each member adds CertiFried to their Discord account once with the link below. Then, in a voice channel, they press the Activities button (the rocket) and pick CertiFried. A film picked with /movie play starts when they open it. Server admins: members need the Use Activities permission in your voice channels, and Use External Apps lets apps they added to their own account post in the server.',
        link: { href: USER_INSTALL_URL, text: 'Add CertiFried to your account' },
    };
}

/** Is Watch Together on for this server? { ok, reason }. */
export function watchAvailability({ activityEnabled, guildId, botInGuild, config }) {
    if (!activityEnabled) return { ok: false, reason: 'Watch Together is not switched on yet.' };
    if (!guildId) return { ok: false, reason: 'Watch Together works in a server\'s voice channel, not in DMs.' };
    // No CertiFried bot at all (main or custom) and nothing set up: a plain answer, not an error.
    if (!botInGuild) return { ok: false, reason: config ? 'CertiFried is not in this server, so it has no film library here.' : 'This server hasn\'t set up Watch Together.' };
    if (!config?.enabled) return { ok: false, reason: 'This server has not turned on Cinema. An admin can on the dashboard (Music & voice, then Cinema).' };
    if (config.mode !== 'activity') return { ok: false, reason: 'This server still uses the Go Live stream. An admin can switch Cinema to Watch Together on the dashboard.' };
    return { ok: true, reason: null };
}

/**
 * What a member may do, from their Discord member object (or null when not found):
 *   start   pick a title when nobody is playing one they can't control (host role, else everyone)
 *   control control any session in the server (control role, Manage Server)
 */
export function memberRights(member, { config, hostRoleId = null }) {
    if (!member) return { start: false, control: false };
    const manager = member.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
    const control = manager || (!!config?.controlRoleId && !!member.roles?.cache?.has?.(config.controlRoleId));
    const start = manager || control || !hostRoleId || !!member.roles?.cache?.has?.(hostRoleId);
    return { start, control };
}
