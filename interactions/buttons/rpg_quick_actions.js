/**
 * RPG Quick Action Button Handlers
 * Handles the quick action buttons (Attack, Search, Talk, Rest)
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import RPGAiDungeonMaster from '../../core/rpg-ai-dm.js';
import RPGCampaignManager from '../../core/rpg-campaign-manager.js';
import { registerRPGMessage } from '../../core/rpg-reply-handler.js';

/**
 * Build the standard quick action buttons
 */
function buildQuickButtons() {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('rpg_quick_attack')
                .setLabel('Attack')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('⚔️'),
            new ButtonBuilder()
                .setCustomId('rpg_quick_search')
                .setLabel('Search')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔍'),
            new ButtonBuilder()
                .setCustomId('rpg_quick_talk')
                .setLabel('Talk')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('💬'),
            new ButtonBuilder()
                .setCustomId('rpg_quick_rest')
                .setLabel('Rest')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🏕️')
        );
}

/**
 * Process a quick action and return the response
 */
async function processQuickAction(interaction, action, actionType = 'action') {
    await interaction.deferReply();

    // Get campaign and session
    const campaign = await RPGCampaignManager.getUserActiveCampaign(
        interaction.user.id,
        interaction.guild.id
    );

    if (!campaign) {
        await interaction.editReply({
            content: '❌ You need to join a campaign first. Use `/rpg campaign join`'
        });
        return;
    }

    const session = await RPGAiDungeonMaster.getActiveSession(campaign.campaign_id);
    if (!session) {
        await interaction.editReply({
            content: '❌ No active session. Start one with `/rpg session start`'
        });
        return;
    }

    const character = await RPGCampaignManager.getPlayerCharacter(
        interaction.user.id,
        campaign.campaign_id
    );

    if (!character) {
        await interaction.editReply({
            content: '❌ Could not find your character.'
        });
        return;
    }

    // Process the action
    const response = await RPGAiDungeonMaster.processPlayerAction(
        session.session_id,
        character.character_id,
        action,
        actionType
    );

    // Build response embed
    const embed = new EmbedBuilder()
        .setColor(response.combatInitiated || response.inCombat ? '#FF0000' : '#9B59B6')
        .setDescription(response.narration.length > 3500 ? response.narration.substring(0, 3500) + '...' : response.narration);

    // Add combat status if in combat
    if (response.combatStatus) {
        embed.addFields({
            name: '⚔️ Combat',
            value: response.combatStatus.length > 1000 ? response.combatStatus.substring(0, 1000) + '...' : response.combatStatus,
            inline: false
        });
    }

    // Add status bar
    if (response.statusBar) {
        embed.addFields({
            name: `📊 ${character.character_name}`,
            value: response.statusBar,
            inline: false
        });
    }

    // Add location
    if (response.location && response.location !== 'Unknown Location') {
        embed.setAuthor({ name: `📍 ${response.location}` });
    }

    // Add rewards if any
    const rewards = [];
    if (response.goldGained > 0) rewards.push(`💰 ${response.goldGained} gold`);
    if (response.xpGained > 0) rewards.push(`✨ ${response.xpGained} XP`);
    if (response.loot && response.loot.length > 0) {
        rewards.push(...response.loot.map(l => `🎁 ${l.item}${l.quantity > 1 ? ` x${l.quantity}` : ''}`));
    }
    if (rewards.length > 0) {
        embed.addFields({
            name: '🏆 Rewards',
            value: rewards.join(' | '),
            inline: false
        });
    }

    // Show combat status
    if (response.combatInitiated) {
        embed.setTitle('⚔️ Combat!');
    }

    embed.setFooter({ text: `${character.character_name} | @mention or reply to continue` });

    const reply = await interaction.editReply({ embeds: [embed], components: [buildQuickButtons()] });

    // Register for reply-based gameplay (include userId for @mention support)
    registerRPGMessage(interaction.channel.id, reply.id, session.session_id, interaction.user.id);
}

/**
 * Handle Attack button
 */
export async function handleQuickAttack(interaction) {
    await processQuickAction(
        interaction,
        'attacks the nearest enemy with their weapon, striking with full force',
        'combat'
    );
}

/**
 * Handle Search button
 */
export async function handleQuickSearch(interaction) {
    await processQuickAction(
        interaction,
        'carefully searches the area, looking for anything of interest - hidden doors, traps, loot, or clues',
        'examine'
    );
}

/**
 * Handle Talk button
 */
export async function handleQuickTalk(interaction) {
    await processQuickAction(
        interaction,
        'approaches and attempts to speak with any nearby creatures or NPCs, trying to gather information or negotiate',
        'dialogue'
    );
}

/**
 * Handle Rest button
 */
export async function handleQuickRest(interaction) {
    await processQuickAction(
        interaction,
        'takes a short rest, spending about an hour to catch their breath, tend to wounds, and recover',
        'action'
    );
}

export default {
    handleQuickAttack,
    handleQuickSearch,
    handleQuickTalk,
    handleQuickRest,
    buildQuickButtons
};
