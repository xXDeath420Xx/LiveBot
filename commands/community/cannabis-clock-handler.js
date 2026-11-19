// /cannabis clock — self-updating 4:20 world clock panels.
import { PermissionFlagsBits } from 'discord.js';
import {
    buildPanel, postPanel, removePanel, listPanels, MAX_PANELS_PER_GUILD
} from '../../core/fourtwenty-panel.js';

const NEEDED = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links']
];

function requireManageGuild(interaction) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    interaction.reply({ content: '🔒 You need **Manage Server** to add or remove clock panels.', ephemeral: true });
    return false;
}

export async function handleClockView(interaction) {
    await interaction.reply({ ...buildPanel(), ephemeral: true });
}

export async function handleClockPost(interaction) {
    if (!requireManageGuild(interaction)) return;

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel?.isTextBased?.() || channel.guildId !== interaction.guildId) {
        return interaction.reply({ content: '❌ Pick a text channel in this server.', ephemeral: true });
    }

    const perms = channel.permissionsFor(interaction.client.user);
    const missing = NEEDED.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
    if (missing.length) {
        return interaction.reply({
            content: `❌ I can't post in ${channel}. I'm missing: **${missing.join(', ')}**.`,
            ephemeral: true
        });
    }

    const panels = await listPanels(interaction.guildId);
    if (panels.length >= MAX_PANELS_PER_GUILD && !panels.some(p => p.channel_id === channel.id)) {
        return interaction.reply({
            content: `❌ This server already has ${panels.length} clock panels (the limit is ${MAX_PANELS_PER_GUILD}): ` +
                panels.map(p => `<#${p.channel_id}>`).join(', ') +
                '. Remove one with `/cannabis clock stop` first.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });
    const replaced = panels.some(p => p.channel_id === channel.id);
    const msg = await postPanel(channel, interaction.user.id);
    await interaction.editReply(
        `✅ ${replaced ? 'Replaced the' : 'Posted a'} 4:20 world clock in ${channel}: ${msg.url}\n` +
        'It updates itself whenever a city hits 4:20. Remove it any time with `/cannabis clock stop`.'
    );
}

export async function handleClockStop(interaction) {
    if (!requireManageGuild(interaction)) return;

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    await interaction.deferReply({ ephemeral: true });

    if (await removePanel(interaction.guildId, channel.id, interaction.client)) {
        return interaction.editReply(`🗑️ Removed the 4:20 clock from ${channel}.`);
    }
    const panels = await listPanels(interaction.guildId);
    await interaction.editReply(panels.length
        ? `There's no clock panel in ${channel}. This server has them in: ${panels.map(p => `<#${p.channel_id}>`).join(', ')}.`
        : 'This server has no 4:20 clock panels. Add one with `/cannabis clock post`.');
}
