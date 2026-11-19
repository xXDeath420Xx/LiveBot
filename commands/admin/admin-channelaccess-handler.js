/**
 * `/admin channel-access` — the slash-command half of the whitelist-to-role tool.
 * All the logic lives in core/channel-access-manager.js; this file is presentation only.
 */
import { EmbedBuilder, ChannelType } from 'discord.js';
import logger from '../../utils/logger.js';
import {
    MIN_WHITELIST,
    readWhitelist,
    scanGuild,
    convertWhitelistToRole,
    listWatches,
    setWatch,
    removeWatch,
    explainRefusal,
    summarize,
} from '../../core/channel-access-manager.js';

const PURPLE = '#8B5CF6';
const GREEN = '#22C55E';
const AMBER = '#F59E0B';

export async function handleScan(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const found = await scanGuild(interaction.guild);
        if (!found.length) {
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(GREEN)
                    .setTitle('No per-user channel whitelists')
                    .setDescription('Every channel here grants access by role. Nothing to clean up — this is the good ending.')],
            });
        }

        const lines = found.slice(0, 25).map(row => {
            const prefix = row.isCategory ? '📁' : '#';
            const flags = [];
            if (row.isTicket) flags.push('ticket — skipped');
            else if (!row.convertible) flags.push(`under the ${MIN_WHITELIST}-user minimum`);
            if (row.watchedRoleId) flags.push(`watched → <@&${row.watchedRoleId}>`);
            return `**${prefix}${row.name}** — ${row.userCount} per-user grant${row.userCount === 1 ? '' : 's'}`
                + (flags.length ? ` _(${flags.join('; ')})_` : '');
        });

        const convertible = found.filter(r => r.convertible && !r.isTicket).length;
        const embed = new EmbedBuilder()
            .setColor(convertible ? AMBER : PURPLE)
            .setTitle(`${found.length} channel${found.length === 1 ? '' : 's'} with per-user whitelists`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: convertible
                ? `${convertible} worth converting — /admin channel-access convert channel: role:`
                : 'Nothing over the minimum; these are small enough to fix by hand.' });
        if (found.length > 25) embed.addFields({ name: 'Truncated', value: `${found.length - 25} more not shown.` });

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[ChannelAccess] Scan failed', { error: error.message, guildId: interaction.guildId });
        return interaction.editReply({ content: `Scan failed: ${error.message}` });
    }
}

export async function handleConvert(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        const dryRun = interaction.options.getBoolean('dry-run') ?? false;
        const watch = interaction.options.getBoolean('watch') ?? false;

        const result = await convertWhitelistToRole({
            channel,
            role,
            actorTag: interaction.user.tag,
            dryRun,
        });

        if (!result.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(AMBER).setTitle('Not converting that one').setDescription(explainRefusal(result))],
            });
        }

        if (!dryRun && watch) {
            await setWatch({
                guildId: interaction.guildId,
                channelId: channel.id,
                roleId: role.id,
                createdBy: interaction.user.id,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(dryRun ? PURPLE : GREEN)
            .setTitle(dryRun ? `Preview — ${result.label} → @${result.roleName}` : `Converted ${result.label} → @${result.roleName}`)
            .setDescription(summarize(result));
        if (!dryRun && watch) {
            embed.addFields({ name: 'Watching', value: `New per-user grants on ${result.label} will be converted to <@&${role.id}> automatically.` });
        }
        if (dryRun) embed.setFooter({ text: 'Nothing changed. Re-run with dry-run: false to apply.' });

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[ChannelAccess] Convert failed', { error: error.message, guildId: interaction.guildId });
        return interaction.editReply({ content: `Conversion failed: ${error.message}` });
    }
}

export async function handleWatch(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        const enabled = interaction.options.getBoolean('enabled') ?? true;

        if (!enabled) {
            await removeWatch(interaction.guildId, channel.id);
            return interaction.editReply({ content: `No longer watching **#${channel.name}**. Hand-added per-user grants will stay where they're put.` });
        }
        if (!role) {
            return interaction.editReply({ content: 'Enabling a watch needs the role that should replace per-user grants.' });
        }
        if (role.managed || role.id === interaction.guildId) {
            return interaction.editReply({ content: 'That role can\'t be assigned by a bot. Pick a normal role.' });
        }

        await setWatch({
            guildId: interaction.guildId,
            channelId: channel.id,
            roleId: role.id,
            createdBy: interaction.user.id,
        });

        const pending = readWhitelist(channel).length;
        const embed = new EmbedBuilder()
            .setColor(GREEN)
            .setTitle(`Watching #${channel.name}`)
            .setDescription(`Any new per-user grant on **#${channel.name}** now becomes <@&${role.id}> instead — `
                + 'the member gets the role, the overwrite gets removed.')
            .setFooter({ text: pending
                ? `${pending} per-user grant(s) already there — run /admin channel-access convert to fold those in.`
                : 'No per-user grants currently on the channel.' });
        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[ChannelAccess] Watch toggle failed', { error: error.message, guildId: interaction.guildId });
        return interaction.editReply({ content: `Couldn't update the watch: ${error.message}` });
    }
}

export async function handleWatchList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const watches = await listWatches(interaction.guildId);
        if (!watches.length) {
            return interaction.editReply({ content: 'No channels are being watched. `/admin channel-access watch` sets one up.' });
        }
        const lines = watches.map(w => {
            const channel = interaction.guild.channels.cache.get(w.channel_id);
            const name = channel ? `#${channel.name}` : `\`${w.channel_id}\` (deleted)`;
            const state = w.enabled ? '' : ' _(disabled)_';
            const converted = w.converted_users ? ` — ${w.converted_users} auto-converted` : '';
            return `**${name}** → <@&${w.role_id}>${state}${converted}`;
        });
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(PURPLE).setTitle('Watched channels').setDescription(lines.join('\n'))],
        });
    } catch (error) {
        logger.error('[ChannelAccess] Watch list failed', { error: error.message, guildId: interaction.guildId });
        return interaction.editReply({ content: `Couldn't list watches: ${error.message}` });
    }
}

export const CONVERTIBLE_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildVoice,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildStageVoice,
    ChannelType.GuildCategory,
];
