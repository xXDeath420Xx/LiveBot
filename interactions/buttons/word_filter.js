/*
 * Filtered words: the buttons on the moderators' card (core/word-filter.js).
 *
 *   wfilter:<action>:<detectionId>:<userId>         warn | mute | kick | ban → opens the modal below
 *                                                   dismiss → closes the card, nothing happens to the member
 *   wfilter_modal:<action>:<detectionId>:<userId>   reason (and duration for a mute), then the action
 *
 * The modal doubles as the confirmation, so a stray click cannot ban anyone. Each button needs the Discord
 * permission its action needs, and goes through logInfraction like the /admin commands, so it reaches the
 * mod log and counts towards the server's escalation rules.
 */
import { ActionRowBuilder, EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { logInfraction, sendModerationDm, protectedRoleFor } from '../../core/moderation-manager.js';
import { whyCannot, whyFailed } from '../../core/manual-action.js';
import { isManager } from '../../core/protection-exempt.js';
import { isProtectedFromBanCommands } from '../../utils/owner-protection.js';
import { parseTimeToMs, formatDuration } from '../../utils/timeParser.js';
import { cardIsOpen, claimCard, closeCard, settleCard } from '../../core/word-filter.js';

const EPHEMERAL = { flags: 64 };
const P = PermissionFlagsBits;
const MOD_PERMS = [P.ModerateMembers, P.KickMembers, P.BanMembers, P.ManageMessages];
const DEFAULT_REASON = 'Used a filtered word';

const ACTIONS = {
    warn: { title: 'Warn member', done: 'Warned', dm: 'warned', outcome: 'warned', anyOf: MOD_PERMS, need: 'a moderation permission' },
    mute: { title: 'Mute member', done: 'Muted', dm: 'muted', outcome: 'muted', anyOf: [P.ModerateMembers], need: 'the Timeout Members permission', can: 'timeout' },
    kick: { title: 'Kick member', done: 'Kicked', dm: 'kicked', outcome: 'kicked', anyOf: [P.KickMembers], need: 'the Kick Members permission', can: 'kick' },
    ban: { title: 'Ban member', done: 'Banned', dm: 'banned', outcome: 'banned', anyOf: [P.BanMembers], need: 'the Ban Members permission', can: 'ban' },
};

function parseId(customId) {
    const [, action, detectionId, userId] = customId.split(':');
    return /^\d+$/.test(detectionId || '') && /^\d{15,25}$/.test(userId || '') ? { action, detectionId: Number(detectionId), userId } : null;
}

async function allowed(interaction, action) {
    if (interaction.guild.ownerId === interaction.user.id) return true;
    const perms = interaction.member?.permissions;
    if (action === 'dismiss') return MOD_PERMS.some(p => perms?.has(p)) || isManager(interaction.member);
    return ACTIONS[action].anyOf.some(p => perms?.has(p));
}

/** Close the card: outcome added, buttons gone. */
async function finishCard(interaction, outcome) {
    const original = interaction.message?.embeds?.[0];
    if (!original) return;
    const embed = EmbedBuilder.from(original).setColor(themeColor(interaction.guildId, 'success')).addFields({ name: 'Outcome', value: outcome.slice(0, 1024) });
    await interaction.message.edit({ embeds: [embed], components: [] }).catch((err) => logger.warn(`[WordFilter] Card not closed: ${err.message}`));
}

export async function handleWordFilterButton(interaction) {
    const id = parseId(interaction.customId);
    if (!interaction.guild || !id || !(id.action === 'dismiss' || ACTIONS[id.action])) {
        return interaction.reply({ content: 'This card is no longer valid.', ...EPHEMERAL });
    }
    if (!await allowed(interaction, id.action)) {
        const need = id.action === 'dismiss' ? 'a moderation permission' : ACTIONS[id.action].need;
        return interaction.reply({ content: `You need ${need} to use this button.`, ...EPHEMERAL });
    }
    if (!await cardIsOpen(interaction.guildId, id.detectionId)) {
        await interaction.message?.edit({ components: [] }).catch(() => {});
        return interaction.reply({ content: 'Another moderator has already handled this.', ...EPHEMERAL });
    }
    if (id.action === 'dismiss') {
        await interaction.deferReply(EPHEMERAL);
        if (!await claimCard(interaction.guildId, id.detectionId)) return interaction.editReply('Another moderator has already handled this.');
        await settleCard(interaction.guildId, id.detectionId, 'dismissed');
        closeCard(interaction.guildId, id.userId);
        await finishCard(interaction, `Dismissed by ${interaction.user}`);
        return interaction.editReply('Dismissed. Nothing was done to the member; the message stays deleted.');
    }

    const reason = new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph)
        .setRequired(true).setMaxLength(400).setValue(DEFAULT_REASON);
    const rows = [new ActionRowBuilder().addComponents(reason)];
    if (id.action === 'mute') {
        rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (for example 30m, 1h, 1d)')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10).setValue('1h')));
    }
    return interaction.showModal(new ModalBuilder().setCustomId(`wfilter_modal:${id.action}:${id.detectionId}:${id.userId}`)
        .setTitle(ACTIONS[id.action].title).addComponents(...rows));
}

/** Why this moderator cannot do this to this member, or null. */
function refusal(interaction, action, userId, target) {
    if (isProtectedFromBanCommands(userId)) return 'This user is protected and cannot be actioned through this bot.';
    if (userId === interaction.user.id) return 'You cannot action yourself.';
    if (target && interaction.guild.ownerId !== interaction.user.id
        && interaction.member.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
        return 'Their highest role is the same as yours or above it.';
    }
    if (!target && (action === 'mute' || action === 'kick')) return 'They have left the server, so that does not apply. Ban still works.';
    const can = ACTIONS[action].can;
    return (can && target ? whyCannot(interaction.guild, can, { member: target })?.text : null) ?? null;
}

/** The member's DM, worded and switched on or off on the Moderation page (core/moderation-manager.js). */
async function tell(user, guild, action, details) {
    await sendModerationDm(guild, user, action, details);
}

export async function handleWordFilterModal(interaction) {
    const id = parseId(interaction.customId);
    const action = ACTIONS[id?.action];
    if (!interaction.guild || !action) return interaction.reply({ content: 'This card is no longer valid.', ...EPHEMERAL });
    await interaction.deferReply(EPHEMERAL);
    if (!await allowed(interaction, id.action)) return interaction.editReply(`You need ${action.need} to do that.`);

    const reason = interaction.fields.getTextInputValue('reason').trim() || DEFAULT_REASON;
    let durationMs = null;
    if (id.action === 'mute') {
        durationMs = parseTimeToMs(interaction.fields.getTextInputValue('duration').trim());
        if (!durationMs) return interaction.editReply('That duration was not understood. Try 30m, 1h or 1d.');
    }
    const { guild } = interaction;
    const target = await guild.members.fetch(id.userId).catch(() => null);
    const user = target?.user ?? await interaction.client.users.fetch(id.userId).catch(() => null);
    if (!user) return interaction.editReply('That user could not be found.');
    const refused = refusal(interaction, id.action, id.userId, target);
    if (refused) return interaction.editReply(refused);
    const shielded = await protectedRoleFor(guild, target);
    if (shielded) return interaction.editReply(`They have the protected role "${shielded.name}", so they cannot be actioned with bot commands.`);

    if (!await claimCard(guild.id, id.detectionId)) return interaction.editReply('Another moderator has already handled this.');
    const audit = `${reason} (by ${interaction.user.tag})`.slice(0, 500);
    const minutes = durationMs ? Math.round(durationMs / 60_000) : null;
    try {
        const dm = { reason, moderator: interaction.user };
        if (id.action === 'warn') {
            if (!await logInfraction(interaction, user, 'Warn', reason)) throw new Error('The warning could not be recorded.');
            await tell(user, guild, 'warn', dm);
        } else if (id.action === 'mute') {
            await target.timeout(durationMs, audit);
            await logInfraction(interaction, user, 'Mute', reason, minutes);
            await tell(user, guild, 'mute', { ...dm, durationMinutes: minutes, expiresAtMs: Date.now() + durationMs });
        } else if (id.action === 'kick') {
            await tell(user, guild, 'kick', dm);
            await target.kick(audit);
            await logInfraction(interaction, user, 'Kick', reason);
        } else {
            await tell(user, guild, 'ban', { ...dm, permanent: true });
            await guild.members.ban(id.userId, { reason: audit, deleteMessageSeconds: 3600 });
            await logInfraction(interaction, user, 'Ban', reason);
        }
    } catch (err) {
        await settleCard(guild.id, id.detectionId, 'flagged');
        const cause = (action.can ? whyFailed(err, guild, action.can, { member: target })?.text : null) ?? err.message;
        logger.warn(`[WordFilter] ${id.action} failed in ${guild.id}: ${err.message}`);
        return interaction.editReply(`That did not go through: ${cause}`);
    }
    await settleCard(guild.id, id.detectionId, action.outcome);
    closeCard(guild.id, id.userId);
    const length = durationMs ? ` for ${formatDuration(Math.round(durationMs / 1000))}` : '';
    await finishCard(interaction, `${action.done}${length} by ${interaction.user}\nReason: ${reason}`);
    return interaction.editReply(`${action.done} ${user}${length}.`);
}

export default { handleWordFilterButton, handleWordFilterModal };
