/**
 * RPG Rest Handler - Short/long rest mechanics
 * Absorbed from rpg-status.js (formerly /rpgstatus rest)
 */
import { EmbedBuilder } from 'discord.js';
import { themeColor } from '../../../../core/guild-theme.js';

/** One embed field summarising class resources restored by the rest (or null). */
function restoredResourcesField(result) {
    const restored = Array.isArray(result.restoredResources) ? result.restoredResources : [];
    if (restored.length === 0) return null;
    const value = restored.map(r => `**${r.name}** → ${r.restored}`).join('\n');
    return { name: '🔋 Class Resources', value: value.length > 1024 ? `${value.slice(0, 1021)}...` : value, inline: false };
}

/**
 * Handle rest subcommands (short, long)
 */
export async function handleRest(interaction, subcommand, characterManager) {
    const userId = interaction.user.id;

    // Get active character
    const character = await characterManager.getActiveCharacter(userId);
    if (!character) {
        await interaction.reply({
            content: '❌ You don\'t have an active character. Use `/rpg character create` first!',
            ephemeral: true
        });
        return;
    }

    if (subcommand === 'short') {
        await interaction.deferReply();

        const hitDiceToSpend = interaction.options.getInteger('hit_dice') || 0;
        const result = await characterManager.shortRest(character.character_id, hitDiceToSpend);

        const embed = new EmbedBuilder()
            .setTitle('🏕️ Short Rest')
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(`**${character.character_name}** takes an hour to rest and recuperate.`)
            .addFields(
                { name: '❤️ HP', value: `${result.previousHP} → ${result.newHP}/${character.max_health}`, inline: true },
                { name: '🎲 Hit Dice Spent', value: `${result.hitDiceSpent}`, inline: true },
                { name: '🎲 Hit Dice Remaining', value: `${result.hitDiceRemaining}`, inline: true }
            );

        if (result.healingRolls.length > 0) {
            const rollDetails = result.healingRolls.map((r, i) =>
                `Die ${i+1}: ${r.roll} + ${r.conMod} CON = **${r.total}**`
            ).join('\n');
            embed.addFields({ name: '🩹 Healing Breakdown', value: rollDetails || 'None' });
        }

        if (result.slotsRestored) {
            embed.addFields({ name: '✨ Pact Slots', value: 'Restored', inline: true });
        }
        const resField = restoredResourcesField(result);
        if (resField) embed.addFields(resField);

        embed.setFooter({ text: `Total Healing: ${result.totalHealing} HP` });

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'long') {
        await interaction.deferReply();

        const result = await characterManager.longRest(character.character_id);

        const embed = new EmbedBuilder()
            .setTitle('🌙 Long Rest')
            .setColor('#3F51B5')
            .setDescription(`**${character.character_name}** settles in for 8 hours of rest.`)
            .addFields(
                { name: '❤️ HP Restored', value: `${result.previousHP} → ${result.newHP}`, inline: true },
                { name: '✨ Mana/Slots', value: `Fully restored`, inline: true },
                { name: '🎲 Hit Dice Recovered', value: `+${result.hitDiceRecovered} (${result.hitDiceTotal} total)`, inline: true }
            );

        if (result.exhaustionReduced) {
            embed.addFields({
                name: '😌 Exhaustion',
                value: `Reduced to level ${result.newExhaustionLevel}`,
                inline: true
            });
        }

        const resField = restoredResourcesField(result);
        if (resField) embed.addFields(resField);

        embed.setFooter({ text: 'You are fully rested and ready for adventure!' });

        await interaction.editReply({ embeds: [embed] });
    }
}
