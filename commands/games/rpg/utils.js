/**
 * Shared utilities for RPG command handlers
 */
import { EmbedBuilder } from 'discord.js';

/**
 * Create a progress bar
 */
export function createProgressBar(current, max, length = 10) {
    const percentage = Math.max(0, Math.min(1, current / max));
    const filled = Math.round(length * percentage);
    const empty = length - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * Format an ability score with modifier
 */
export function formatAbilityScore(score) {
    const modifier = Math.floor((score - 10) / 2);
    return `${score} (${modifier >= 0 ? '+' : ''}${modifier})`;
}

/**
 * Create error embed
 */
export function errorEmbed(message) {
    return new EmbedBuilder()
        .setColor('#FF0000')
        .setDescription(`❌ ${message}`);
}

/**
 * Create success embed
 */
export function successEmbed(title, description) {
    return new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(title)
        .setDescription(description);
}

/**
 * Require character helper - returns character or sends error
 */
export async function requireCharacter(interaction, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);
    if (!character) {
        await interaction.editReply({
            content: 'You don\'t have a character yet. Create one with `/rpg character create`'
        });
        return null;
    }
    return character;
}
