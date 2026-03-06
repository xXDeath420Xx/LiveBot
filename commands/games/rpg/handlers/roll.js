/**
 * RPG Roll subcommand handlers
 */
import { EmbedBuilder } from 'discord.js';
import RPGDiceEngine, { ABILITIES } from '../../../../core/rpg-dice-engine.js';

export async function handleRoll(interaction, subcommand, characterManager) {
    if (subcommand === 'dice') {
        return handleDice(interaction);
    } else if (subcommand === 'ability') {
        return handleAbility(interaction, characterManager);
    } else if (subcommand === 'skill') {
        return handleSkill(interaction, characterManager);
    } else if (subcommand === 'save') {
        return handleSave(interaction, characterManager);
    } else if (subcommand === 'initiative') {
        return handleInitiative(interaction, characterManager);
    }
}

async function handleDice(interaction) {
    const notation = interaction.options.getString('notation', true);
    const advantageType = interaction.options.getString('advantage') || 'normal';

    try {
        const result = RPGDiceEngine.roll(notation, {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            rollType: 'custom'
        });

        let rollsDisplay = result.keptRolls.join(', ');
        if (result.droppedRolls && result.droppedRolls.length > 0) {
            rollsDisplay += ` (~~${result.droppedRolls.join(', ')}~~)`;
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Dice Roll`)
            .setDescription(`**${interaction.user.displayName}** rolled \`${notation}\``)
            .addFields(
                { name: 'Rolls', value: `[${rollsDisplay}]`, inline: true },
                { name: 'Total', value: `**${result.total}**`, inline: true }
            );

        if (result.modifier !== 0) {
            embed.addFields({
                name: 'Modifier',
                value: result.modifier > 0 ? `+${result.modifier}` : `${result.modifier}`,
                inline: true
            });
        }

        if (result.isExploding) {
            embed.setFooter({ text: 'Exploding dice!' });
        }

        await RPGDiceEngine.logRoll({
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            rollType: 'custom',
            notation: notation,
            rolls: result.rolls,
            modifier: result.modifier,
            total: result.total
        });

        await interaction.reply({ embeds: [embed] });
    } catch (rollError) {
        await interaction.reply({
            content: `Invalid dice notation: ${rollError.message}`,
            ephemeral: true
        });
    }
}

async function handleAbility(interaction, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character to make ability checks. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const ability = interaction.options.getString('ability', true);
    const dc = interaction.options.getInteger('dc');
    const advantageType = interaction.options.getString('advantage') || 'normal';

    const result = RPGDiceEngine.abilityCheck(character, ability, advantageType, dc);

    let rollDisplay = `${result.d20.roll}`;
    if (result.d20.advantageType !== 'normal') {
        const allRolls = result.d20.allRolls.join(', ');
        rollDisplay = `[${allRolls}] -> **${result.d20.roll}**`;
    }

    const embed = new EmbedBuilder()
        .setColor(result.success === true ? '#00FF00' : result.success === false ? '#FF0000' : '#FFD700')
        .setTitle(`${result.abilityName} Check`)
        .setDescription(`**${character.character_name}** makes a ${result.abilityName} check!`)
        .addFields(
            { name: 'd20 Roll', value: rollDisplay, inline: true },
            { name: 'Modifier', value: RPGDiceEngine.formatModifier(result.modifier), inline: true },
            { name: 'Total', value: `**${result.total}**`, inline: true }
        );

    if (dc !== null) {
        const successText = result.success ? 'SUCCESS' : 'FAILURE';
        embed.addFields(
            { name: 'DC', value: dc.toString(), inline: true },
            { name: 'Result', value: successText, inline: true },
            { name: 'Margin', value: `${result.margin >= 0 ? '+' : ''}${result.margin}`, inline: true }
        );
    }

    if (result.d20.isCritical) {
        embed.setFooter({ text: 'Natural 20!' });
    } else if (result.d20.isFumble) {
        embed.setFooter({ text: 'Natural 1!' });
    } else if (advantageType !== 'normal') {
        embed.setFooter({ text: advantageType === 'advantage' ? 'Rolled with Advantage' : 'Rolled with Disadvantage' });
    }

    await RPGDiceEngine.logRoll({
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        characterId: character.character_id,
        rollType: 'ability',
        notation: result.formula,
        rolls: result.d20.allRolls,
        modifier: result.modifier,
        total: result.total,
        advantageType: advantageType,
        isCritical: result.d20.isCritical,
        isFumble: result.d20.isFumble,
        dc: dc,
        success: result.success,
        context: `${result.abilityName} check`
    });

    await interaction.reply({ embeds: [embed] });
}

async function handleSkill(interaction, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character to make skill checks. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const skill = interaction.options.getString('skill', true);
    const dc = interaction.options.getInteger('dc');
    const advantageType = interaction.options.getString('advantage') || 'normal';

    const result = RPGDiceEngine.skillCheck(character, skill, advantageType, dc);

    let rollDisplay = `${result.d20.roll}`;
    if (result.d20.advantageType !== 'normal') {
        const allRolls = result.d20.allRolls.join(', ');
        rollDisplay = `[${allRolls}] -> **${result.d20.roll}**`;
    }

    let profText = '';
    if (result.proficiencyLevel === 2) {
        profText = ' (Expertise)';
    } else if (result.proficiencyLevel === 1) {
        profText = ' (Proficient)';
    }

    const embed = new EmbedBuilder()
        .setColor(result.success === true ? '#00FF00' : result.success === false ? '#FF0000' : '#FFD700')
        .setTitle(`${result.skillName} Check${profText}`)
        .setDescription(`**${character.character_name}** makes a ${result.skillName} (${ABILITIES[result.ability]}) check!`)
        .addFields(
            { name: 'd20 Roll', value: rollDisplay, inline: true },
            { name: 'Modifier', value: RPGDiceEngine.formatModifier(result.totalModifier), inline: true },
            { name: 'Total', value: `**${result.total}**`, inline: true }
        );

    let breakdown = `${ABILITIES[result.ability]} mod: ${RPGDiceEngine.formatModifier(result.abilityMod)}`;
    if (result.proficiencyBonus > 0) {
        breakdown += `\nProficiency: +${result.proficiencyBonus}`;
    }
    embed.addFields({ name: 'Breakdown', value: breakdown, inline: false });

    if (dc !== null) {
        const successText = result.success ? 'SUCCESS' : 'FAILURE';
        embed.addFields(
            { name: 'DC', value: dc.toString(), inline: true },
            { name: 'Result', value: successText, inline: true },
            { name: 'Margin', value: `${result.margin >= 0 ? '+' : ''}${result.margin}`, inline: true }
        );
    }

    if (result.d20.isCritical) {
        embed.setFooter({ text: 'Natural 20!' });
    } else if (result.d20.isFumble) {
        embed.setFooter({ text: 'Natural 1!' });
    } else if (advantageType !== 'normal') {
        embed.setFooter({ text: advantageType === 'advantage' ? 'Rolled with Advantage' : 'Rolled with Disadvantage' });
    }

    await RPGDiceEngine.logRoll({
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        characterId: character.character_id,
        rollType: 'skill_check',
        notation: result.formula,
        rolls: result.d20.allRolls,
        modifier: result.totalModifier,
        total: result.total,
        advantageType: advantageType,
        isCritical: result.d20.isCritical,
        isFumble: result.d20.isFumble,
        dc: dc,
        success: result.success,
        context: `${result.skillName} (${ABILITIES[result.ability]})`
    });

    await interaction.reply({ embeds: [embed] });
}

async function handleSave(interaction, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character to make saving throws. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const ability = interaction.options.getString('ability', true);
    const dc = interaction.options.getInteger('dc', true);
    const advantageType = interaction.options.getString('advantage') || 'normal';

    const result = RPGDiceEngine.savingThrow(character, ability, dc, advantageType);

    let rollDisplay = `${result.d20.roll}`;
    if (result.d20.advantageType !== 'normal') {
        const allRolls = result.d20.allRolls.join(', ');
        rollDisplay = `[${allRolls}] -> **${result.d20.roll}**`;
    }

    const profText = result.isProficient ? ' (Proficient)' : '';

    const embed = new EmbedBuilder()
        .setColor(result.success ? '#00FF00' : '#FF0000')
        .setTitle(`${result.abilityName} Saving Throw${profText}`)
        .setDescription(`**${character.character_name}** makes a ${result.abilityName} save vs DC ${dc}!`)
        .addFields(
            { name: 'd20 Roll', value: rollDisplay, inline: true },
            { name: 'Modifier', value: RPGDiceEngine.formatModifier(result.totalModifier), inline: true },
            { name: 'Total', value: `**${result.total}**`, inline: true },
            { name: 'DC', value: dc.toString(), inline: true },
            { name: 'Result', value: result.success ? 'SAVED' : 'FAILED', inline: true },
            { name: 'Margin', value: `${result.margin >= 0 ? '+' : ''}${result.margin}`, inline: true }
        );

    if (result.d20.isCritical) {
        embed.setFooter({ text: 'Natural 20 - Automatic Success!' });
    } else if (result.d20.isFumble) {
        embed.setFooter({ text: 'Natural 1 - Automatic Failure!' });
    } else if (advantageType !== 'normal') {
        embed.setFooter({ text: advantageType === 'advantage' ? 'Rolled with Advantage' : 'Rolled with Disadvantage' });
    }

    await RPGDiceEngine.logRoll({
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        characterId: character.character_id,
        rollType: 'saving_throw',
        notation: result.formula,
        rolls: result.d20.allRolls,
        modifier: result.totalModifier,
        total: result.total,
        advantageType: advantageType,
        isCritical: result.d20.isCritical,
        isFumble: result.d20.isFumble,
        dc: dc,
        success: result.success,
        context: `${result.abilityName} save`
    });

    await interaction.reply({ embeds: [embed] });
}

async function handleInitiative(interaction, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character to roll initiative. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const result = RPGDiceEngine.rollInitiative(character);

    const embed = new EmbedBuilder()
        .setColor('#FF4500')
        .setTitle('Initiative Roll')
        .setDescription(`**${character.character_name}** rolls for initiative!`)
        .addFields(
            { name: 'd20 Roll', value: `${result.d20.roll}`, inline: true },
            { name: 'DEX Mod', value: RPGDiceEngine.formatModifier(result.dexMod), inline: true },
            { name: 'Initiative', value: `**${result.total}**`, inline: true }
        );

    if (result.d20.isCritical) {
        embed.setFooter({ text: 'Natural 20 - First to act!' });
    } else if (result.d20.isFumble) {
        embed.setFooter({ text: 'Natural 1 - Last to act...' });
    }

    await RPGDiceEngine.logRoll({
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        characterId: character.character_id,
        rollType: 'initiative',
        notation: result.formula,
        rolls: [result.d20.roll],
        modifier: result.totalModifier,
        total: result.total,
        isCritical: result.d20.isCritical,
        isFumble: result.d20.isFumble,
        context: 'Initiative'
    });

    await interaction.reply({ embeds: [embed] });
}
