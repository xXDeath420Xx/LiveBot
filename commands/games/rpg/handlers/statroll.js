/**
 * RPG Stat Roll Handler - Ability score generation methods
 * Absorbed from rpg-status.js (formerly /rpgstatus statroll)
 */
import { EmbedBuilder } from 'discord.js';

/**
 * Handle statroll subcommands (roll, standard, pointbuy)
 */
export async function handleStatroll(interaction, subcommand, characterManager) {
    if (subcommand === 'roll') {
        // Roll 4d6 drop lowest for each stat
        const rollResult = characterManager.rollAbilityScores();

        const embed = new EmbedBuilder()
            .setTitle('🎲 Roll for Stats (4d6 Drop Lowest)')
            .setColor('#9C27B0')
            .setDescription('Here are your rolled ability scores!\nAssign them to your character when creating.')
            .addFields({
                name: '📊 Your Rolled Scores',
                value: rollResult.scores.map((s, i) => `**${s}**`).join(' | '),
                inline: false
            });

        // Show the breakdown for each roll
        const rollBreakdown = rollResult.details.map((d, i) => {
            const keptStr = d.kept.join('+');
            return `Roll ${i+1}: [${d.rolls.join(', ')}] → ${keptStr} = **${d.total}** (dropped ${d.dropped})`;
        }).join('\n');

        embed.addFields({ name: '🎲 Roll Details', value: rollBreakdown, inline: false });
        embed.addFields({
            name: '📝 How to Use',
            value: 'Use `/rpg character create` and manually assign these values to STR, DEX, CON, INT, WIS, CHA.',
            inline: false
        });
        embed.setFooter({ text: 'Fighters: STR/CON | Wizards: INT | Rogues: DEX' });

        await interaction.reply({ embeds: [embed] });
    }
    else if (subcommand === 'standard') {
        const standardArray = characterManager.getStandardArray();

        const embed = new EmbedBuilder()
            .setTitle('📊 Standard Array')
            .setColor('#2196F3')
            .setDescription('The Standard Array provides balanced starting stats.')
            .addFields({
                name: 'Your Scores',
                value: standardArray.map(s => `**${s}**`).join(' | '),
                inline: false
            })
            .addFields({
                name: 'Typical Assignments',
                value:
                    '**Fighter/Paladin:** 15 STR, 14 CON, 13 DEX, 12 WIS, 10 CHA, 8 INT\n' +
                    '**Rogue:** 15 DEX, 14 CON, 13 INT, 12 WIS, 10 STR, 8 CHA\n' +
                    '**Wizard:** 15 INT, 14 CON, 13 DEX, 12 WIS, 10 STR, 8 CHA\n' +
                    '**Cleric:** 15 WIS, 14 CON, 13 STR, 12 DEX, 10 CHA, 8 INT',
                inline: false
            });
        embed.setFooter({ text: 'Use /rpg character create to apply these values' });

        await interaction.reply({ embeds: [embed] });
    }
    else if (subcommand === 'pointbuy') {
        const embed = new EmbedBuilder()
            .setTitle('📊 Point Buy System')
            .setColor('#FF9800')
            .setDescription('Build your stats with 27 points! All stats start at 8.')
            .addFields({
                name: 'Point Costs',
                value:
                    '**8:** 0 | **9:** 1 | **10:** 2 | **11:** 3 | **12:** 4\n' +
                    '**13:** 5 | **14:** 7 | **15:** 9 (max)',
                inline: true
            })
            .addFields({
                name: 'Example Build',
                value:
                    '**Balanced Fighter:**\n15 STR (9) + 14 CON (7) + 13 DEX (5) + 10×3 (6) = 27',
                inline: false
            });
        embed.setFooter({ text: 'Min: 8 | Max: 15 | Budget: 27 points' });

        await interaction.reply({ embeds: [embed] });
    }
}
