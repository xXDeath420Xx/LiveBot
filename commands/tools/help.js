import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

// Category emojis and descriptions
const CATEGORIES = {
    admin: { emoji: '🛡️', description: 'Server management, moderation & security' },
    community: { emoji: '👥', description: 'Community engagement, social feeds & features' },
    economy: { emoji: '💰', description: 'Virtual currency, shop & pets' },
    fun: { emoji: '🎉', description: 'Entertainment, jokes, memes & casual games' },
    games: { emoji: '🎮', description: 'Interactive games, RPG, Pokemon & trivia' },
    info: { emoji: '🔍', description: 'Lookups — media, weather, crypto & user info' },
    music: { emoji: '🎵', description: 'Music playback & text-to-speech' },
    tools: { emoji: '🔧', description: 'Utilities, productivity & personal tools' }
};

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Get help with bot commands')
        .addStringOption(option =>
            option
                .setName('command')
                .setDescription('Get detailed help for a specific command')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option
                .setName('category')
                .setDescription('View commands in a specific category')
                .setRequired(false)
                .addChoices(
                    { name: '🛡️ Admin', value: 'admin' },
                    { name: '👥 Community', value: 'community' },
                    { name: '💰 Economy', value: 'economy' },
                    { name: '🎉 Fun', value: 'fun' },
                    { name: '🎮 Games', value: 'games' },
                    { name: '🔍 Info', value: 'info' },
                    { name: '🎵 Music', value: 'music' },
                    { name: '🔧 Tools', value: 'tools' }
                )
        ),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        const commands = [...interaction.client.commands.values()];

        const filtered = commands
            .filter(cmd => cmd.data?.name?.toLowerCase().includes(focusedValue))
            .slice(0, 25)
            .map(cmd => ({
                name: `/${cmd.data.name} - ${cmd.data.description?.substring(0, 50) || 'No description'}`,
                value: cmd.data.name
            }));

        await interaction.respond(filtered);
    },

    async execute(interaction) {
        const commandName = interaction.options.getString('command');
        const categoryName = interaction.options.getString('category');

        if (commandName) {
            // Show detailed help for a specific command
            await showCommandHelp(interaction, commandName);
        } else if (categoryName) {
            // Show commands in a category
            await showCategoryHelp(interaction, categoryName);
        } else {
            // Show main help menu
            await showMainHelp(interaction);
        }
    }
};

/**
 * Show the main help menu with all categories
 */
async function showMainHelp(interaction) {
    const commands = [...interaction.client.commands.values()];

    // Group commands by category
    const categoryCounts = {};
    for (const cmd of commands) {
        const cat = cmd.category || 'tools';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📚 Bot Help')
        .setDescription(
            `Welcome to **${interaction.client.user.username}**!\n\n` +
            `Use \`/help command:<name>\` for detailed command info\n` +
            `Use \`/help category:<name>\` to browse by category\n\n` +
            `**Available Categories:**`
        )
        .setThumbnail(interaction.client.user.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: `${commands.length} commands available` })
        .setTimestamp();

    // Add category fields
    for (const [catName, catInfo] of Object.entries(CATEGORIES)) {
        const count = categoryCounts[catName] || 0;
        if (count > 0) {
            embed.addFields({
                name: `${catInfo.emoji} ${catName.charAt(0).toUpperCase() + catName.slice(1)}`,
                value: `${catInfo.description}\n\`${count} command${count !== 1 ? 's' : ''}\``,
                inline: true
            });
        }
    }

    // Add quick links
    embed.addFields({
        name: '🔗 Quick Links',
        value:
            '• `/music` - Music controls\n' +
            '• `/tools tts speak` - Text-to-speech\n' +
            '• `/weather` - Weather info\n' +
            '• `/admin support` - Support tickets\n' +
            '• `/grow journal` - Grow journals',
        inline: false
    });

    // Create category select menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help_category_select')
        .setPlaceholder('Select a category to explore...')
        .addOptions(
            Object.entries(CATEGORIES)
                .filter(([cat]) => categoryCounts[cat] > 0)
                .map(([catName, catInfo]) => ({
                    label: catName.charAt(0).toUpperCase() + catName.slice(1),
                    description: catInfo.description.substring(0, 50),
                    value: catName,
                    emoji: catInfo.emoji
                }))
        );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({ embeds: [embed], components: [row] });
}

/**
 * Show commands in a specific category
 */
async function showCategoryHelp(interaction, categoryName) {
    const commands = [...interaction.client.commands.values()];
    const catInfo = CATEGORIES[categoryName] || { emoji: '📁', description: 'Commands' };

    // Filter commands by category
    const categoryCommands = commands.filter(cmd => {
        const cmdCat = cmd.category || 'tools';
        return cmdCat.toLowerCase() === categoryName.toLowerCase();
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${catInfo.emoji} ${categoryName.charAt(0).toUpperCase() + categoryName.slice(1)} Commands`)
        .setDescription(catInfo.description)
        .setFooter({ text: `${categoryCommands.length} commands in this category` })
        .setTimestamp();

    if (categoryCommands.length === 0) {
        embed.addFields({
            name: 'No Commands',
            value: 'No commands found in this category.',
            inline: false
        });
    } else {
        // Group commands (max 25 fields per embed)
        const commandList = categoryCommands
            .sort((a, b) => a.data.name.localeCompare(b.data.name))
            .slice(0, 20)
            .map(cmd => `\`/${cmd.data.name}\` - ${cmd.data.description?.substring(0, 60) || 'No description'}`)
            .join('\n');

        embed.addFields({
            name: 'Commands',
            value: commandList || 'No commands available',
            inline: false
        });

        if (categoryCommands.length > 20) {
            embed.addFields({
                name: '\u200b',
                value: `*...and ${categoryCommands.length - 20} more commands*`,
                inline: false
            });
        }
    }

    await interaction.reply({ embeds: [embed] });
}

/**
 * Show detailed help for a specific command
 */
async function showCommandHelp(interaction, commandName) {
    const command = interaction.client.commands.get(commandName);

    if (!command) {
        return await interaction.reply({
            content: `❌ Command \`/${commandName}\` not found. Use \`/help\` to see all available commands.`,
            ephemeral: true
        });
    }

    const cmdData = command.data;
    const catInfo = CATEGORIES[command.category] || { emoji: '📁', description: 'Command' };

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${catInfo.emoji} /${cmdData.name}`)
        .setDescription(cmdData.description || 'No description available')
        .setFooter({ text: `Category: ${command.category || 'tools'}` })
        .setTimestamp();

    // Add subcommands if any
    const subcommands = cmdData.options?.filter(opt => opt.type === 1) || [];
    if (subcommands.length > 0) {
        const subList = subcommands
            .map(sub => `\`${sub.name}\` - ${sub.description || 'No description'}`)
            .join('\n');
        embed.addFields({
            name: '📋 Subcommands',
            value: subList,
            inline: false
        });
    }

    // Add subcommand groups if any
    const subGroups = cmdData.options?.filter(opt => opt.type === 2) || [];
    if (subGroups.length > 0) {
        for (const group of subGroups) {
            const groupSubs = group.options?.map(sub => `\`${sub.name}\` - ${sub.description || ''}`) || [];
            embed.addFields({
                name: `📁 ${group.name}`,
                value: groupSubs.join('\n') || 'No subcommands',
                inline: false
            });
        }
    }

    // Add options if no subcommands
    if (subcommands.length === 0 && subGroups.length === 0) {
        const options = cmdData.options?.filter(opt => opt.type !== 1 && opt.type !== 2) || [];
        if (options.length > 0) {
            const optList = options
                .map(opt => {
                    const required = opt.required ? '(required)' : '(optional)';
                    return `\`${opt.name}\` ${required} - ${opt.description || 'No description'}`;
                })
                .join('\n');
            embed.addFields({
                name: '⚙️ Options',
                value: optList,
                inline: false
            });
        }
    }

    // Add usage example
    let usage = `/${cmdData.name}`;
    if (subcommands.length > 0) {
        usage += ` <subcommand>`;
    }
    embed.addFields({
        name: '💡 Usage',
        value: `\`${usage}\``,
        inline: false
    });

    await interaction.reply({ embeds: [embed] });
}
