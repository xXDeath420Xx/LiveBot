/**
 * RPG Inventory subcommand handlers
 */
import { EmbedBuilder } from 'discord.js';

export async function handleInventory(interaction, subcommand, characterManager, shopManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    if (subcommand === 'view') {
        return handleView(interaction, character, characterManager);
    } else if (subcommand === 'equip') {
        return handleEquip(interaction, character, characterManager, shopManager);
    } else if (subcommand === 'unequip') {
        return handleUnequip(interaction, character, characterManager, shopManager);
    }
}

async function handleView(interaction, character, characterManager) {
    await interaction.deferReply();

    const items = await characterManager.getInventory(character.character_id);

    if (items.length === 0) {
        await interaction.editReply({ content: 'Your inventory is empty.' });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#E67E22')
        .setTitle(`${character.character_name}'s Inventory`)
        .setDescription(`Total Items: ${items.length}`);

    const itemsByType = {};
    items.forEach(item => {
        if (!itemsByType[item.item_type]) {
            itemsByType[item.item_type] = [];
        }
        itemsByType[item.item_type].push(item);
    });

    for (const [type, typeItems] of Object.entries(itemsByType)) {
        const itemList = typeItems.map(item => {
            const equipped = item.equipped ? ' [EQUIPPED]' : '';
            return `**${item.item_name}** (ID: ${item.item_id}) x${item.quantity}${equipped}\n${item.rarity.toUpperCase()} | ${item.value}g`;
        }).join('\n\n');

        embed.addFields({
            name: type.charAt(0).toUpperCase() + type.slice(1) + 's',
            value: itemList || 'None',
            inline: false
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleEquip(interaction, character, characterManager, shopManager) {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger('item_id', true);

    await characterManager.equipItem(character.character_id, itemId);

    const item = await shopManager.getItemDetails(itemId);

    await interaction.editReply({
        content: `Successfully equipped **${item.item_name}**!`
    });
}

async function handleUnequip(interaction, character, characterManager, shopManager) {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger('item_id', true);

    await characterManager.unequipItem(character.character_id, itemId);

    const item = await shopManager.getItemDetails(itemId);

    await interaction.editReply({
        content: `Successfully unequipped **${item.item_name}**!`
    });
}
