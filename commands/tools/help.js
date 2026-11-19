import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { themeColor } from '../../core/guild-theme.js';
import { MOUNTS, slashPath } from '../../core/command-mounts.js';
import { describePath } from '../../core/universal-commands.js';
import { commandType, relPaths } from '../../core/command-registration.js';

// What a member can type: no dropped aliases (core/command-mounts.js), moved commands under their parent's path.
const listed = client => [...client.commands.values()].filter(cmd => cmd.data?.name && !MOUNTS[cmd.data.name]?.drop);

/**
 * How a command is run (slash/text split, core/command-registration.js): its slash path, or for a text
 * command the words members type as a message ("/owo"), with a short type note.
 */
function labelFor(cmd) {
    const name = cmd.data.name;
    let type = 'slash';
    try { type = commandType(name, cmd); } catch { /* treat as slash */ }
    if (type !== 'text') return { type, label: `/${slashPath(name)}` };
    let json = null;
    try { json = cmd.data.toJSON(); } catch { /* fall through */ }
    const forms = (json ? relPaths(json) : ['']).map(rel => describePath(rel ? `${name} ${rel}` : name).text).filter(Boolean);
    const firsts = [...new Set(forms.map(f => f.split(' ')[0]))];
    return { type, label: forms.length === 1 ? forms[0] : (firsts.length === 1 ? firsts[0] : `/${name}`) };
}
const typeNote = t => (t === 'text' ? ' (text)' : t === 'mixed' ? ' (slash + text)' : '');
/** One subcommand as members run it: "/music play" or "/joke (text)". */
function runFormFor(path) {
    const d = describePath(path);
    return d.slash ? `\`${d.slash}\`` : d.text ? `\`${d.text}\` (text)` : `\`!${path}\``;
}

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
        const commands = listed(interaction.client);

        const filtered = commands
            .filter(cmd => cmd.data?.name?.toLowerCase().includes(focusedValue))
            .slice(0, 25)
            .map(cmd => {
                const { type, label } = labelFor(cmd);
                return {
                    name: `${label}${typeNote(type)} - ${cmd.data.description?.substring(0, 50) || 'No description'}`.slice(0, 100),
                    value: cmd.data.name
                };
            });

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
    const commands = listed(interaction.client);

    // Group commands by category
    const categoryCounts = {};
    for (const cmd of commands) {
        const cat = cmd.category || 'tools';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('📚 Bot Help')
        .setDescription(
            `Welcome to **${interaction.client.user.username}**!\n\n` +
            `Use \`/help command:<name>\` for detailed command info\n` +
            `Use \`/help category:<name>\` to browse by category\n\n` +
            `**Slash** commands are in Discord's / menu. **Text** commands are typed as a normal message, ` +
            `for example \`/owo hunt\` or \`/joke\` (\`!\` and the server's other prefixes work too).\n\n` +
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
    // AGPL-3.0 section 13: users who interact with the bot over a network are offered its source.
    embed.addFields({ name: '📜 Source code', value: 'CertiFried is free software (AGPL-3.0-or-later): [github.com/xXDeath420Xx/LiveBot](https://github.com/xXDeath420Xx/LiveBot)', inline: false });

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
    const commands = listed(interaction.client);
    const catInfo = CATEGORIES[categoryName] || { emoji: '📁', description: 'Commands' };

    // Filter commands by category
    const categoryCommands = commands.filter(cmd => {
        const cmdCat = cmd.category || 'tools';
        return cmdCat.toLowerCase() === categoryName.toLowerCase();
    });

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
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
            .map(cmd => { const { type, label } = labelFor(cmd); return `\`${label}\`${typeNote(type)} - ${cmd.data.description?.substring(0, 60) || 'No description'}`; })
            .join('\n')
            .slice(0, 1024);

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

    if (!command || MOUNTS[commandName]?.drop) {
        return await interaction.reply({
            content: `❌ Command \`/${commandName}\` not found. Use \`/help\` to see all available commands.`,
            ephemeral: true
        });
    }

    const cmdData = command.data;
    const catInfo = CATEGORIES[command.category] || { emoji: '📁', description: 'Command' };
    const { type, label } = labelFor(command);
    const howTo = type === 'text'
        ? 'Text command: type it as a normal message (it is not in the / menu).'
        : type === 'mixed' ? 'Some parts are slash commands, the rest are typed as messages; each one below shows which.'
            : 'Slash command: pick it from the / menu.';

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`${catInfo.emoji} ${label}${typeNote(type)}`)
        .setDescription(`${cmdData.description || 'No description available'}\n${howTo}`)
        .setFooter({ text: `Category: ${command.category || 'tools'}` })
        .setTimestamp();

    // Add subcommands if any
    const subcommands = cmdData.options?.filter(opt => opt.type === 1) || [];
    if (subcommands.length > 0) {
        const subList = subcommands
            .map(sub => `${runFormFor(`${cmdData.name} ${sub.name}`)} - ${sub.description || 'No description'}`)
            .join('\n')
            .slice(0, 1024);
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
            // The run form once per group ("/rpg character", or "/random" for a renamed text group), so a
            // command with ~100 subcommands stays inside Discord's 6,000-character embed limit.
            const first = group.options?.[0];
            const f = first ? describePath(`${cmdData.name} ${group.name} ${first.name}`) : null;
            const prefix = f?.slash ? f.slash.split(' ').slice(0, -1).join(' ') : f?.text ? `${f.text.split(' ').slice(0, -1).join(' ')} (text)` : '';
            const groupSubs = group.options?.map(sub => `\`${sub.name}\` - ${sub.description || ''}`) || [];
            embed.addFields({
                name: `📁 ${group.name}${prefix ? ` · ${prefix}` : ''}`.slice(0, 256),
                value: (groupSubs.join('\n') || 'No subcommands').slice(0, 1024),
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
    let usage = label;
    if (subcommands.length > 0) {
        usage += ` <subcommand>`;
    }
    embed.addFields({
        name: '💡 Usage',
        value: `\`${usage}\``,
        inline: false
    });

    // Discord rejects an embed over 6,000 characters: drop the last groups rather than fail.
    const size = () => JSON.stringify(embed.toJSON()).length;
    const fields = embed.data.fields || [];
    let cut = 0;
    while (fields.length > 2 && size() > 5800) { fields.splice(fields.length - 2, 1); cut++; }
    if (cut) embed.setFooter({ text: `Category: ${command.category || 'tools'} · ${cut} more group(s) not shown; the dashboard's Commands page lists them all` });

    await interaction.reply({ embeds: [embed] });
}
