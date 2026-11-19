/*
 * `/lockdown start` and `/lockdown stop` — the Confirm / Cancel buttons (Hashbot asks for a confirm
 * button too; the dashboard asks for "LOCKDOWN" typed out). What was asked for waits here for five
 * minutes; only the person who ran the command can confirm it, and their permission is checked
 * again when they do.
 */
import { randomBytes } from 'node:crypto';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../../utils/logger.js';
import { liveConfigAccess } from '../../core/protection-exempt.js';
import { startLockdown, endLockdown } from '../../core/raid-lockdown.js';
import { ACTION_LABEL, summarise } from '../../core/raid-lockdown-logic.js';

const EPHEMERAL = { flags: 64 };
const TTL = 5 * 60_000;
const pending = new Map();

/** Remember a start/stop awaiting confirmation; returns the token for the button ids. */
export function rememberLockdownRequest(entry) {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > TTL) pending.delete(k);
    const token = randomBytes(6).toString('hex');
    pending.set(token, { ...entry, at: now });
    return token;
}

const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    quarantine: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};

/** May this member start a lockdown that does `action`? null = yes, else the refusal text. */
export async function lockdownRefusal(guild, userId, action) {
    const access = await liveConfigAccess(guild, userId);
    if (!access.ok) return 'You need Manage Server, Administrator or a bot-manager role in this server.';
    const need = NEEDS[action];
    if (need && !access.isOwner && !access.member.permissions.has(need[0])) {
        return `A ${ACTION_LABEL[action].toLowerCase()} lockdown needs the ${need[1]} permission, which you don't have.`;
    }
    return null;
}

function take(interaction) {
    const token = interaction.customId.split(':')[1];
    const entry = pending.get(token);
    if (!entry || Date.now() - entry.at > TTL || entry.guildId !== interaction.guildId) return { token, entry: null };
    return { token, entry };
}

/** `rlock_go:<token>` */
export async function handleLockdownConfirm(interaction) {
    const { token, entry } = take(interaction);
    if (!entry) return interaction.update({ content: 'This request has expired. Run the command again.', embeds: [], components: [] });
    if (entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who asked can confirm this.', ...EPHEMERAL });
    }
    pending.delete(token);
    const refusal = await lockdownRefusal(interaction.guild, interaction.user.id, entry.kind === 'start' ? entry.action : null);
    if (refusal) return interaction.update({ content: refusal, embeds: [], components: [] });
    await interaction.update({ content: entry.kind === 'start' ? 'Starting the lockdown…' : 'Ending the lockdown…', embeds: [], components: [] });

    try {
        if (entry.kind === 'start') {
            const out = await startLockdown(interaction.guild, {
                action: entry.action, durationMs: entry.durationMs, trigger: 'manual', by: interaction.user,
                reason: entry.reason, pauseInvites: entry.pauseInvites, lockChannels: entry.lockChannels,
            });
            if (!out.ok) return interaction.editReply({ content: `Not started: ${out.error}` });
            const end = Math.floor(new Date(out.row.ends_at).getTime() / 1000);
            return interaction.editReply({
                content: '',
                embeds: [new EmbedBuilder().setColor(0xC0392B).setTitle(`🚨 Lockdown #${out.row.id} started`)
                    .setDescription(`Every new member is handled with **${ACTION_LABEL[out.row.action]}** until <t:${end}:F> (<t:${end}:R>).\n`
                        + `${out.row.invites_paused ? 'Discord invites are paused for the same time.\n' : ''}`
                        + 'End it early with `/lockdown stop` or from the dashboard.')],
            });
        }
        const out = await endLockdown(interaction.guild, { by: interaction.user, why: 'manual' });
        if (!out.ok) return interaction.editReply({ content: out.error });
        const sum = summarise(out.row);
        return interaction.editReply({
            content: '',
            embeds: [new EmbedBuilder().setColor(0x2ECC71).setTitle(`✅ Lockdown #${out.row.id} ended`)
                .setDescription(`${sum.blocked} join(s) blocked, ${sum.held} exempt or paused, ${sum.failed} failed. New members can join again.`)],
        });
    } catch (err) {
        logger.error(`[RaidLockdown] confirm failed in ${interaction.guildId}: ${err.message}`);
        return interaction.editReply({ content: `Something went wrong: ${err.message}` });
    }
}

/** `rlock_no:<token>` */
export async function handleLockdownCancel(interaction) {
    const { token, entry } = take(interaction);
    if (entry && entry.actorId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the person who asked can cancel this.', ...EPHEMERAL });
    }
    pending.delete(token);
    return interaction.update({ content: 'Cancelled — nothing changed.', embeds: [], components: [] });
}
