import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../../utils/logger.js';

/**
 * Handle RPG battle attack button
 */
export async function handleBattleAttack(interaction) {
    try {
        await interaction.deferUpdate();

        const combatManager = interaction.client.rpgCombatManager;
        const characterManager = interaction.client.rpgCharacterManager;

        if (!combatManager || !characterManager) {
            await interaction.followUp({
                content: 'RPG system is not available.',
                ephemeral: true
            });
            return;
        }

        // Get character
        const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

        if (!character) {
            await interaction.followUp({
                content: 'You don\'t have a character!',
                ephemeral: true
            });
            return;
        }

        // Perform attack
        const result = await combatManager.attack(character.character_id);

        if (result.status === 'victory') {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('VICTORY!')
                .setDescription(`You dealt ${result.playerDamage} damage and defeated the enemy!`)
                .addFields(
                    { name: 'Experience Gained', value: result.rewards.exp.toString(), inline: true },
                    { name: 'Gold Gained', value: result.rewards.gold.toString(), inline: true }
                );

            if (result.rewards.item) {
                embed.addFields({ name: 'Item Received', value: result.rewards.item });
            }

            if (result.rewards.leveledUp) {
                embed.addFields({ name: 'LEVEL UP!', value: `You are now level ${result.rewards.newLevel}!` });
            }

            await interaction.editReply({ embeds: [embed], components: [] });
        } else if (result.status === 'defeat') {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('DEFEATED!')
                .setDescription('You have been defeated in battle!')
                .addFields({
                    name: 'Battle Results',
                    value: `You dealt ${result.playerDamage} damage before falling.\nThe enemy dealt ${result.enemyDamage} damage to you.`
                });

            await interaction.editReply({ embeds: [embed], components: [] });
        } else {
            // Battle continues
            const battle = await combatManager.getActiveBattle(character.character_id);

            const embed = new EmbedBuilder()
                .setColor('#FF4500')
                .setTitle(`Battle - Turn ${result.turn}`)
                .setDescription('The battle rages on!')
                .addFields(
                    {
                        name: 'Your Attack',
                        value: `You dealt ${result.playerDamage} damage!`,
                        inline: false
                    },
                    {
                        name: 'Enemy Attack',
                        value: `The enemy dealt ${result.enemyDamage} damage!`,
                        inline: false
                    },
                    {
                        name: 'Your HP',
                        value: `${result.characterHealth}`,
                        inline: true
                    },
                    {
                        name: 'Enemy HP',
                        value: `${result.enemyHealth}`,
                        inline: true
                    }
                );

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('rpg_battle_attack')
                        .setLabel('Attack')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('⚔️'),
                    new ButtonBuilder()
                        .setCustomId('rpg_battle_flee')
                        .setLabel('Flee')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🏃')
                );

            await interaction.editReply({ embeds: [embed], components: [row] });
        }

    } catch (error) {
        logger.error(`[RPG Battle] Error handling attack: ${error.message}`);
        await interaction.followUp({
            content: `Error: ${error.message}`,
            ephemeral: true
        });
    }
}

/**
 * Handle RPG battle flee button
 */
export async function handleBattleFlee(interaction) {
    try {
        await interaction.deferUpdate();

        const combatManager = interaction.client.rpgCombatManager;
        const characterManager = interaction.client.rpgCharacterManager;

        if (!combatManager || !characterManager) {
            await interaction.followUp({
                content: 'RPG system is not available.',
                ephemeral: true
            });
            return;
        }

        // Get character
        const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

        if (!character) {
            await interaction.followUp({
                content: 'You don\'t have a character!',
                ephemeral: true
            });
            return;
        }

        // Attempt to flee
        const result = await combatManager.flee(character.character_id);

        if (result.status === 'fled') {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('Fled from Battle')
                .setDescription('You successfully escaped from the battle!');

            await interaction.editReply({ embeds: [embed], components: [] });
        } else if (result.status === 'defeat') {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('DEFEATED!')
                .setDescription('You failed to flee and were defeated!')
                .addFields({
                    name: 'Battle Results',
                    value: `The enemy dealt ${result.enemyDamage} damage as you tried to escape.`
                });

            await interaction.editReply({ embeds: [embed], components: [] });
        } else {
            // Failed to flee, battle continues
            const battle = await combatManager.getActiveBattle(character.character_id);

            const embed = new EmbedBuilder()
                .setColor('#FF4500')
                .setTitle(`Battle - Turn ${result.turn}`)
                .setDescription('Failed to flee!')
                .addFields(
                    {
                        name: 'Enemy Attack',
                        value: `The enemy dealt ${result.enemyDamage} damage as you tried to escape!`,
                        inline: false
                    },
                    {
                        name: 'Your HP',
                        value: `${result.characterHealth}`,
                        inline: true
                    },
                    {
                        name: 'Enemy HP',
                        value: `${battle.enemy.health}`,
                        inline: true
                    }
                );

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('rpg_battle_attack')
                        .setLabel('Attack')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('⚔️'),
                    new ButtonBuilder()
                        .setCustomId('rpg_battle_flee')
                        .setLabel('Flee')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🏃')
                );

            await interaction.editReply({ embeds: [embed], components: [row] });
        }

    } catch (error) {
        logger.error(`[RPG Battle] Error handling flee: ${error.message}`);
        await interaction.followUp({
            content: `Error: ${error.message}`,
            ephemeral: true
        });
    }
}
