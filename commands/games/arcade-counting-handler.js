import { PermissionFlagsBits } from 'discord.js';
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
