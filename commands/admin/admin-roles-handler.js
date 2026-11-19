/**
 * `/admin roles bulk-create` — paste a line-separated list of role names, get roles.
 *
 * The slash options carry the defaults (colour, permission preset, hoist, mentionable,
 * anchor role); the names themselves come from a modal because a slash option can't hold
 * a multi-line list. Those defaults ride along in the modal's customId, so the flow
 * survives a bot restart between opening the form and submitting it.
 */

import {
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    PermissionsBitField,
} from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import {
    PERMISSION_PRESETS,
    parseRoleList,
    planRoles,
    createRoles,
    resolveColor,
    clampPosition,
    hexOf,
} from '../../core/bulk-role-creator.js';

export const MODAL_PREFIX = 'bulkroles:';

/** customId payload: bulkroles:<colorHex|->:<preset>:<hoist><mentionable>:<anchorId|-> */
function encodeOptions({ color, preset, hoist, mentionable, anchorId }) {
    return [
        MODAL_PREFIX.slice(0, -1),
        color == null ? '-' : (color >>> 0 & 0xffffff).toString(16).padStart(6, '0'),
        preset || 'none',
        `${hoist ? 1 : 0}${mentionable ? 1 : 0}`,
        anchorId || '-',
    ].join(':');
}

function decodeOptions(customId) {
    const [, colorHex = '-', preset = 'none', flags = '00', anchorId = '-'] = customId.split(':');
    return {
        color: colorHex === '-' ? 0 : parseInt(colorHex, 16),
        preset: PERMISSION_PRESETS[preset] ? preset : 'none',
        hoist: flags[0] === '1',
        mentionable: flags[1] === '1',
        anchorId: anchorId === '-' ? null : anchorId,
    };
}

/** Step 1 — validate the options, then pop the names form. */
export async function handleBulkCreate(interaction) {
    const member = interaction.member;
    if (!interaction.guild || !member) {
        return interaction.reply({ content: 'That only works inside a server.', ephemeral: true });
    }
    if (!member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: 'You need the Manage Roles permission to do that.', ephemeral: true });
    }

    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: 'I need the Manage Roles permission before I can create anything.', ephemeral: true });
    }

    const colorInput = interaction.options.getString('color');
    let color = 0;
    if (colorInput) {
        const resolved = resolveColor(colorInput);
        if (resolved.error) {
            return interaction.reply({
                content: `${resolved.error}. Use a hex code like \`#5865F2\`, a name like \`blurple\`, or \`random\`.`,
                ephemeral: true,
            });
        }
        color = resolved.color;
    }

    const preset = interaction.options.getString('permissions') || 'none';
    if (preset === 'admin' && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({
            content: "You can't create Administrator roles without having Administrator yourself.",
            ephemeral: true,
        });
    }

    const anchor = interaction.options.getRole('below');
    if (anchor && anchor.position > member.roles.highest.position && interaction.guild.ownerId !== member.id) {
        return interaction.reply({
            content: `${anchor.name} sits above your own highest role, so I'd be placing roles you can't manage. Pick a lower anchor.`,
            ephemeral: true,
        });
    }

    const customId = encodeOptions({
        color: colorInput ? color : null,
        preset,
        hoist: interaction.options.getBoolean('hoist') ?? false,
        mentionable: interaction.options.getBoolean('mentionable') ?? false,
        anchorId: anchor?.id,
    });

    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle('Create roles from a list')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('names')
                    .setLabel('One role name per line')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Moderator | #ff0000 | hoist\nSubscriber | random\nEvent Team')
                    .setRequired(true)
                    .setMaxLength(4000)
            )
        );

    return interaction.showModal(modal);
}

/** Step 2 — parse the pasted list and create the roles. */
export async function handleBulkCreateModal(interaction) {
    try {
        if (!interaction.guild || !interaction.member?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.reply({ content: 'You need the Manage Roles permission to do that.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const opts = decodeOptions(interaction.customId);
        const { entries, errors } = parseRoleList(interaction.fields.getTextInputValue('names'), {
            color: opts.color,
            permissions: PERMISSION_PRESETS[opts.preset].perms,
            hoist: opts.hoist,
            mentionable: opts.mentionable,
        });

        if (!entries.length) {
            const detail = errors.length
                ? `\n\n${errors.map(e => `• Line ${e.line}: ${e.error}`).join('\n').slice(0, 1500)}`
                : '';
            return interaction.editReply(`I couldn't read a single usable role name out of that.${detail}`);
        }

        const plan = planRoles(interaction.guild, entries, {
            actorPermissions: interaction.member.permissions,
        });

        if (plan.blocked) return interaction.editReply(plan.blocked);
        if (!plan.create.length) {
            return interaction.editReply(`Nothing to create — all ${plan.skip.length} name(s) already exist as roles here.`);
        }

        const anchorRole = opts.anchorId ? interaction.guild.roles.cache.get(opts.anchorId) : null;
        const position = clampPosition(interaction.guild, anchorRole ? anchorRole.position : null, interaction.member);

        const { created, failed } = await createRoles(interaction.guild, plan.create, {
            position,
            reason: `Bulk role creation by ${interaction.user.tag} (${interaction.user.id})`,
        });

        logger.info(`[BulkRoles] ${interaction.user.tag} created ${created.length} role(s) in ${interaction.guild.name}`);

        return interaction.editReply({
            embeds: [buildResultEmbed(interaction, { created, failed, skip: plan.skip, errors, notes: plan.permissionNotes, anchorRole })],
        });
    } catch (error) {
        logger.error('[BulkRoles] modal submit failed', { error: error.message, stack: error.stack });
        const message = 'Something went wrong creating those roles. Nothing further was attempted.';
        if (interaction.deferred || interaction.replied) return interaction.editReply(message).catch(() => {});
        return interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
}

function buildResultEmbed(interaction, { created, failed, skip, errors, notes, anchorRole }) {
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, created.length ? 'success' : 'danger'))
        .setTitle(`Created ${created.length} role${created.length === 1 ? '' : 's'}`)
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

    if (created.length) {
        embed.setDescription(truncateList(created.map(r => `<@&${r.id}> \`${hexOf(r.color)}\``), 3900));
    }
    if (anchorRole && created.length) {
        embed.addFields({ name: 'Placement', value: `Directly below ${anchorRole}`, inline: false });
    }
    if (skip.length) {
        embed.addFields({ name: `Skipped — already exist (${skip.length})`, value: truncateList(skip.map(s => `\`${s.name}\``), 1000) });
    }
    if (errors.length) {
        embed.addFields({ name: `Ignored lines (${errors.length})`, value: truncateList(errors.map(e => `Line ${e.line}: ${e.error}`), 1000) });
    }
    if (failed.length) {
        embed.addFields({ name: `Failed (${failed.length})`, value: truncateList(failed.map(f => `\`${f.name}\` — ${f.error}`), 1000) });
    }
    if (notes.blockedByActor.length) {
        embed.addFields({ name: 'Permissions dropped (you lack them)', value: truncateList(notes.blockedByActor, 1000) });
    }
    if (notes.blockedByBot.length) {
        embed.addFields({ name: 'Permissions dropped (I lack them)', value: truncateList(notes.blockedByBot, 1000) });
    }

    return embed;
}

function truncateList(items, limit) {
    const out = [];
    let length = 0;
    for (const item of items) {
        if (length + item.length + 2 > limit) {
            out.push(`…and ${items.length - out.length} more`);
            break;
        }
        out.push(item);
        length += item.length + 2;
    }
    return out.join('\n') || '—';
}

/** Slash-option choices, built from the preset table so the two can't drift. */
export const PRESET_CHOICES = Object.entries(PERMISSION_PRESETS).map(([value, p]) => ({
    name: `${p.label} — ${p.description}`.slice(0, 100),
    value,
}));
