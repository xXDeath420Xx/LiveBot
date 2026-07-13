import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import * as countingManager from '../../core/counting-manager.js';

function requireManageChannels(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        interaction.reply({
            content: '❌ You need the Manage Channels permission to use this command.',
            ephemeral: true
        });
        return false;
    }
    return true;
}

export async function handleSetup(interaction) {
    if (!requireManageChannels(interaction)) return;
    await countingManager.handleSetup(interaction);
}

export async function handleDisable(interaction) {
    if (!requireManageChannels(interaction)) return;
    await countingManager.handleDisable(interaction);
}

export async function handleReset(interaction) {
    if (!requireManageChannels(interaction)) return;
    await countingManager.handleReset(interaction);
}

export async function handleStats(interaction) {
    await countingManager.handleStats(interaction);
}

export async function handleLeaderboard(interaction) {
    await countingManager.handleLeaderboard(interaction);
}

export async function handleSetCount(interaction) {
    if (!requireManageChannels(interaction)) return;
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const last = interaction.options.getInteger('last-number');

    const cfg = await countingManager.getChannelConfig(interaction.guild.id, channel.id);
    if (!cfg) {
        return interaction.reply({ content: `❌ ${channel} is not set up as a counting channel.`, flags: MessageFlags.Ephemeral });
    }
    await countingManager.setCount(interaction.guild.id, channel.id, last, null);
    return interaction.reply({
        content: `✅ ${channel} is now at **${last}** — the next number is **${last + 1}**.\n` +
            'Stats and the high score were left alone, and nobody is locked out of the next count.',
        flags: MessageFlags.Ephemeral,
    });
}

export async function handleMode(interaction) {
    if (!requireManageChannels(interaction)) return;
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const cfg = await countingManager.getChannelConfig(interaction.guild.id, channel.id);
    if (!cfg) {
        return interaction.reply({ content: `❌ ${channel} is not set up as a counting channel.`, flags: MessageFlags.Ephemeral });
    }

    const fields = {};
    const failMode = interaction.options.getString('on-wrong-number');
    if (failMode) fields.fail_mode = failMode;
    for (const [opt, col] of [
        ['allow-same-user', 'allow_same_user'],
        ['react-on-valid', 'react_on_valid'],
        ['announce-milestones', 'announce_milestones'],
        ['delete-chatter', 'delete_chatter'],
    ]) {
        const v = interaction.options.getBoolean(opt);
        if (v !== null) fields[col] = v ? 1 : 0;
    }

    if (!Object.keys(fields).length) {
        return interaction.reply({
            content: `⚙️ **${channel.name}** — current rules:\n${countingManager.describeMode(cfg)}`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // Deleting messages is the whole feedback mechanism in delete mode.
    const willDelete = (fields.fail_mode ?? cfg.fail_mode) === 'delete';
    if (willDelete && !channel.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({
            content: `❌ I need **Manage Messages** in ${channel} to delete wrong numbers.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    await countingManager.setMode(interaction.guild.id, channel.id, fields);
    const updated = await countingManager.getChannelConfig(interaction.guild.id, channel.id);
    return interaction.reply({
        content: `✅ Updated **${channel.name}**:\n${countingManager.describeMode(updated)}`,
        flags: MessageFlags.Ephemeral,
    });
}
