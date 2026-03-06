/**
 * RPG Character subcommand handlers
 */
import { EmbedBuilder } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { parseCharacterFromURL, convertToRPGCharacter } from '../../../../utils/pdf-character-parser.js';
import { createProgressBar, formatAbilityScore } from '../utils.js';

export async function handleCharacter(interaction, subcommand, characterManager) {
    if (subcommand === 'create') {
        return handleCreate(interaction, characterManager);
    } else if (subcommand === 'view') {
        return handleView(interaction, characterManager);
    } else if (subcommand === 'stats') {
        return handleStats(interaction, characterManager);
    } else if (subcommand === 'delete') {
        return handleDelete(interaction, characterManager);
    } else if (subcommand === 'import') {
        return handleImport(interaction, characterManager);
    }
}

async function handleCreate(interaction, characterManager) {
    const name = interaction.options.getString('name', true);
    const className = interaction.options.getString('class', true);
    const species = interaction.options.getString('species') || 'human';
    const background = interaction.options.getString('background');

    await interaction.deferReply();

    const result = await characterManager.createCharacter(
        interaction.user.id,
        interaction.guild.id,
        name,
        className,
        { species, background }
    );

    const classDisplay = className.charAt(0).toUpperCase() + className.slice(1);
    const speciesDisplay = species.charAt(0).toUpperCase() + species.slice(1).replace('-', ' ');
    let description = `*Level 1 ${speciesDisplay} ${classDisplay}*`;
    if (background) {
        const bgDisplay = background.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
        description += `\n**Background:** ${bgDisplay}`;
    }

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`${name}`)
        .setDescription(description)
        .addFields(
            { name: 'Hit Points', value: `${result.health}/${result.max_health}`, inline: true },
            { name: 'Mana', value: `${result.mana}/${result.mana}`, inline: true },
            { name: 'Speed', value: `${result.speed || 30} ft.`, inline: true },
            { name: 'STR', value: formatAbilityScore(result.strength), inline: true },
            { name: 'DEX', value: formatAbilityScore(result.dexterity), inline: true },
            { name: 'CON', value: formatAbilityScore(result.constitution), inline: true },
            { name: 'INT', value: formatAbilityScore(result.intelligence), inline: true },
            { name: 'WIS', value: formatAbilityScore(result.wisdom), inline: true },
            { name: 'CHA', value: formatAbilityScore(result.charisma), inline: true }
        );

    if (result.racialTraits && result.racialTraits.length > 0) {
        embed.addFields({
            name: 'Racial Traits',
            value: result.racialTraits.join(', '),
            inline: false
        });
    }

    if (result.backgroundSkills && result.backgroundSkills.length > 0) {
        embed.addFields({
            name: 'Skill Proficiencies',
            value: result.backgroundSkills.map(s => s.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())).join(', '),
            inline: false
        });
    }

    embed.setFooter({ text: 'Use /rpg statroll to see stat rolling options • /rpg character view for full sheet' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleView(interaction, characterManager) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const character = await characterManager.getCharacter(targetUser.id, interaction.guild.id);

    if (!character) {
        await interaction.editReply({
            content: `${targetUser.id === interaction.user.id ? 'You don\'t' : 'That user doesn\'t'} have a character yet. Create one with \`/rpg character create\``
        });
        return;
    }

    const expNeeded = character.level * 100;
    const healthBar = createProgressBar(character.health, character.max_health);
    const manaBar = createProgressBar(character.mana, character.max_mana);
    const expBar = createProgressBar(character.experience, expNeeded);

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${character.character_name} - Level ${character.level} ${character.class}`)
        .setDescription(`Owner: <@${targetUser.id}>`)
        .addFields(
            { name: 'Health', value: `${healthBar} ${character.health}/${character.max_health}`, inline: false },
            { name: 'Mana', value: `${manaBar} ${character.mana}/${character.max_mana}`, inline: false },
            { name: 'Experience', value: `${expBar} ${character.experience}/${expNeeded}`, inline: false },
            { name: 'Gold', value: character.gold.toString(), inline: true },
            { name: 'Current Zone', value: character.current_zone, inline: true },
            { name: '\u200b', value: '\u200b', inline: true },
            { name: 'STR', value: character.strength.toString(), inline: true },
            { name: 'DEX', value: character.dexterity.toString(), inline: true },
            { name: 'CON', value: character.constitution.toString(), inline: true },
            { name: 'INT', value: character.intelligence.toString(), inline: true },
            { name: 'WIS', value: character.wisdom.toString(), inline: true },
            { name: 'CHA', value: character.charisma.toString(), inline: true }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction, characterManager) {
    await interaction.deferReply();

    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.editReply({
            content: 'You don\'t have a character yet. Create one with `/rpg character create`'
        });
        return;
    }

    const damage = await characterManager.calculateDamage(character.character_id);
    const defense = await characterManager.calculateDefense(character.character_id);
    const equipped = await characterManager.getEquippedItems(character.character_id);

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle(`${character.character_name} - Combat Stats`)
        .addFields(
            { name: 'Attack Damage', value: damage.toString(), inline: true },
            { name: 'Defense', value: defense.toString(), inline: true },
            { name: '\u200b', value: '\u200b', inline: true }
        );

    if (equipped.length > 0) {
        const equippedText = equipped.map(item =>
            `**${item.item_name}** (${item.item_type})`
        ).join('\n');
        embed.addFields({ name: 'Equipped Items', value: equippedText });
    } else {
        embed.addFields({ name: 'Equipped Items', value: 'None' });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleDelete(interaction, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You don\'t have a character to delete.',
            ephemeral: true
        });
        return;
    }

    await characterManager.deleteCharacter(interaction.user.id, interaction.guild.id);

    await interaction.reply({
        content: `Your character **${character.character_name}** has been deleted.`,
        ephemeral: true
    });
}

async function handleImport(interaction, characterManager) {
    await interaction.deferReply();

    const existingCharacter = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);
    if (existingCharacter) {
        await interaction.editReply({
            content: `You already have a character named **${existingCharacter.character_name}**. Delete it first with \`/rpg character delete\` if you want to import a new one.`
        });
        return;
    }

    const attachment = interaction.options.getAttachment('pdf', true);

    if (!attachment.name.toLowerCase().endsWith('.pdf')) {
        await interaction.editReply({
            content: 'Please upload a PDF file. Only D&D Beyond character sheet PDFs are supported.'
        });
        return;
    }

    if (attachment.size > 10 * 1024 * 1024) {
        await interaction.editReply({
            content: 'PDF file is too large. Maximum size is 10MB.'
        });
        return;
    }

    try {
        const parsedData = await parseCharacterFromURL(attachment.url);

        if (!parsedData.name) {
            await interaction.editReply({
                content: 'Could not extract character name from the PDF. Make sure it\'s a valid D&D Beyond character sheet with a filled-in character name.'
            });
            return;
        }

        const rpgCharacter = convertToRPGCharacter(parsedData);

        await characterManager.createCharacterFromImport(
            interaction.user.id,
            interaction.guild.id,
            rpgCharacter
        );

        const classDisplay = rpgCharacter.class.charAt(0).toUpperCase() + rpgCharacter.class.slice(1);
        const subclassDisplay = rpgCharacter.subclass ? ` (${rpgCharacter.subclass})` : '';

        const embed = new EmbedBuilder()
            .setColor('#7289DA')
            .setTitle(`${rpgCharacter.character_name}`)
            .setDescription(`*Level ${rpgCharacter.level} ${classDisplay}${subclassDisplay}*\n${rpgCharacter.species ? `**Species:** ${rpgCharacter.species}` : ''} ${rpgCharacter.background ? `• **Background:** ${rpgCharacter.background}` : ''}`)
            .addFields(
                { name: 'Hit Points', value: `${rpgCharacter.health}/${rpgCharacter.max_health}`, inline: true },
                { name: 'Armor Class', value: `${rpgCharacter.armor_class || 10}`, inline: true },
                { name: 'Speed', value: rpgCharacter.speed || '30 ft.', inline: true },
                { name: 'STR', value: formatAbilityScore(rpgCharacter.strength), inline: true },
                { name: 'DEX', value: formatAbilityScore(rpgCharacter.dexterity), inline: true },
                { name: 'CON', value: formatAbilityScore(rpgCharacter.constitution), inline: true },
                { name: 'INT', value: formatAbilityScore(rpgCharacter.intelligence), inline: true },
                { name: 'WIS', value: formatAbilityScore(rpgCharacter.wisdom), inline: true },
                { name: 'CHA', value: formatAbilityScore(rpgCharacter.charisma), inline: true }
            );

        const currency = [];
        if (rpgCharacter.platinum > 0) currency.push(`${rpgCharacter.platinum} PP`);
        if (rpgCharacter.gold > 0) currency.push(`${rpgCharacter.gold} GP`);
        if (rpgCharacter.electrum > 0) currency.push(`${rpgCharacter.electrum} EP`);
        if (rpgCharacter.silver > 0) currency.push(`${rpgCharacter.silver} SP`);
        if (rpgCharacter.copper > 0) currency.push(`${rpgCharacter.copper} CP`);
        if (currency.length > 0) {
            embed.addFields({ name: 'Currency', value: currency.join(', '), inline: false });
        }

        if (rpgCharacter.spellcasting_ability) {
            embed.addFields({
                name: 'Spellcasting',
                value: `**Ability:** ${rpgCharacter.spellcasting_ability} • **DC:** ${rpgCharacter.spell_save_dc || 'N/A'} • **Attack:** +${rpgCharacter.spell_attack_bonus || 0}`,
                inline: false
            });
        }

        embed.setFooter({ text: 'Character imported from D&D Beyond • Use /rpg character view for full details' });

        await interaction.editReply({ embeds: [embed] });

    } catch (parseError) {
        logger.error('[RPG Import] PDF parse error:', parseError);
        await interaction.editReply({
            content: `Failed to parse PDF: ${parseError.message}. Make sure this is a valid D&D Beyond character sheet.`
        });
    }
}
