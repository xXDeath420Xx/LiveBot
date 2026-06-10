/**
 * Public / informational defender commands.
 */
import { resolveChannel } from '../channel-tokens.js';

export async function pingCmd(ctx) {
    ctx.reply('KBD is responding! 🐻');
}

export async function infoCmd(ctx) {
    ctx.reply('KumaBot Defender (Kick) — a shared-banlist defense network. Manage at https://certifriedmultitool.com/kick');
}

export async function joinCmd(ctx) {
    ctx.reply('Enroll your channel in the defender at https://certifriedmultitool.com/kick (log in with Kick and enable the defender).');
}

export async function modCheckCmd(ctx) {
    // "mod-check" on Kick == has the channel owner re-authorized with the ban scope?
    const ch = await resolveChannel(ctx.channelId);
    if (!ch) return ctx.reply('This channel is not enrolled / no valid token.');
    const ok = (ch.scopes || []).includes('moderation:ban');
    ctx.reply(ok
        ? 'This channel is re-authorized for bans. ✅'
        : 'This channel is enrolled but NOT re-authorized for bans — re-authorize at /kick.');
}
