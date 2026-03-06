import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('qotd')
        .setDescription('Question of the Day system - automated content posting')
        .addSubcommandGroup(group =>
            group
                .setName('setup')
                .setDescription('Configure QOTD for a channel')
                .addSubcommand(sub =>
                    sub
                        .setName('channel')
                        .setDescription('Set up QOTD in a channel')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('Channel to post QOTD in')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('schedule')
                                .setDescription('Posting schedule')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Daily', value: 'daily' },
                                    { name: 'Weekly', value: 'weekly' },
                                    { name: 'Custom Interval', value: 'custom' }
                                )
                        )
                        .addStringOption(option =>
                            option
                                .setName('time')
                                .setDescription('Time to post (HH:MM format, e.g., 09:00)')
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('schedule')
                        .setDescription('Configure posting schedule')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('QOTD channel')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('type')
                                .setDescription('Schedule type')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Daily', value: 'daily' },
                                    { name: 'Weekly', value: 'weekly' },
                                    { name: 'Custom Interval', value: 'custom' }
                                )
                        )
                        .addIntegerOption(option =>
                            option
                                .setName('interval')
                                .setDescription('Custom interval in hours (for custom type)')
                                .setMinValue(1)
                                .setMaxValue(168)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('appearance')
                        .setDescription('Customize QOTD appearance')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('QOTD channel')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('title')
                                .setDescription('Embed title')
                                .setMaxLength(256)
                                .setRequired(false)
                        )
                        .addStringOption(option =>
                            option
                                .setName('color')
                                .setDescription('Embed color (hex code, e.g., #5865F2)')
                                .setRequired(false)
                        )
                        .addBooleanOption(option =>
                            option
                                .setName('thread')
                                .setDescription('Create a thread for each post')
                                .setRequired(false)
                        )
                        .addBooleanOption(option =>
                            option
                                .setName('pin')
                                .setDescription('Pin the message')
                                .setRequired(false)
                        )
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('deck')
                .setDescription('Manage card decks')
                .addSubcommand(sub =>
                    sub
                        .setName('create')
                        .setDescription('Create a new deck')
                        .addStringOption(option =>
                            option
                                .setName('name')
                                .setDescription('Deck name')
                                .setMaxLength(100)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('type')
                                .setDescription('Deck type')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Questions', value: 'question' },
                                    { name: 'Facts', value: 'fact' },
                                    { name: 'Quotes', value: 'quote' },
                                    { name: 'Polls', value: 'poll' },
                                    { name: 'Mixed', value: 'mixed' }
                                )
                        )
                        .addStringOption(option =>
                            option
                                .setName('description')
                                .setDescription('Deck description')
                                .setMaxLength(500)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('list')
                        .setDescription('List available decks')
                        .addBooleanOption(option =>
                            option
                                .setName('community')
                                .setDescription('Show community decks')
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('select')
                        .setDescription('Select active deck for a channel')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('QOTD channel')
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true)
                        )
                        .addIntegerOption(option =>
                            option
                                .setName('deck_id')
                                .setDescription('Deck ID to use')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('shuffle')
                        .setDescription('Shuffle cards in a deck')
                        .addIntegerOption(option =>
                            option
                                .setName('deck_id')
                                .setDescription('Deck ID to shuffle')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('delete')
                        .setDescription('Delete a deck')
                        .addIntegerOption(option =>
                            option
                                .setName('deck_id')
                                .setDescription('Deck ID to delete')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('card')
                .setDescription('Manage cards')
                .addSubcommand(sub =>
                    sub
                        .setName('add')
                        .setDescription('Add a card to a deck')
                        .addIntegerOption(option =>
                            option
                                .setName('deck_id')
                                .setDescription('Deck to add to')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('content')
                                .setDescription('Card content')
                                .setMaxLength(2000)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('image_url')
                                .setDescription('Optional image URL')
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('edit')
                        .setDescription('Edit a card')
                        .addIntegerOption(option =>
                            option
                                .setName('card_id')
                                .setDescription('Card ID to edit')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('content')
                                .setDescription('New content')
                                .setMaxLength(2000)
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('delete')
                        .setDescription('Delete a card')
                        .addIntegerOption(option =>
                            option
                                .setName('card_id')
                                .setDescription('Card ID to delete')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('view')
                        .setDescription('View cards in a deck')
                        .addIntegerOption(option =>
                            option
                                .setName('deck_id')
                                .setDescription('Deck ID to view')
                                .setMinValue(1)
                                .setRequired(true)
                        )
                        .addIntegerOption(option =>
                            option
                                .setName('page')
                                .setDescription('Page number')
                                .setMinValue(1)
                                .setRequired(false)
                        )
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('suggest')
                .setDescription('Suggest a card for the server')
                .addStringOption(option =>
                    option
                        .setName('content')
                        .setDescription('Your suggestion')
                        .setMaxLength(2000)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('type')
                        .setDescription('Suggestion type')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Question', value: 'question' },
                            { name: 'Fact', value: 'fact' },
                            { name: 'Quote', value: 'quote' },
                            { name: 'Other', value: 'other' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('post')
                .setDescription('Manually post the next card')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('QOTD channel')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('view')
                .setDescription('View QOTD configuration')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('QOTD channel')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommandGroup === 'setup') {
                await handleSetup(interaction, subcommand);
            } else if (subcommandGroup === 'deck') {
                await handleDeck(interaction, subcommand);
            } else if (subcommandGroup === 'card') {
                await handleCard(interaction, subcommand);
            } else if (subcommand === 'suggest') {
                await handleSuggest(interaction);
            } else if (subcommand === 'post') {
                await handlePost(interaction);
            } else if (subcommand === 'view') {
                await handleView(interaction);
            }
        } catch (error) {
            logger.error('[QOTD] Command error:', { error, subcommand, subcommandGroup });
            const errorEmbed = new EmbedBuilder()
                .setColor('#ed4245')
                .setTitle('Error')
                .setDescription(`An error occurred: ${error.message}`)
                .setTimestamp();

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    }
};

// Setup handlers
async function handleSetup(interaction, subcommand) {
    await interaction.deferReply();

    if (subcommand === 'channel') {
        const channel = interaction.options.getChannel('channel');
        const schedule = interaction.options.getString('schedule');
        const time = interaction.options.getString('time') || '09:00';

        // Validate time format
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(time)) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Invalid Time Format')
                    .setDescription('Please use HH:MM format (e.g., 09:00, 14:30)')
                ]
            });
        }

        // Create or update channel configuration
        await pool.execute(`
            INSERT INTO qotd_channels (channel_id, guild_id, schedule_type, schedule_time)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE schedule_type = VALUES(schedule_type), schedule_time = VALUES(schedule_time), enabled = 1
        `, [channel.id, interaction.guild.id, schedule, time]);

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('QOTD Channel Configured')
            .setDescription(`Successfully set up QOTD in ${channel}`)
            .addFields(
                { name: 'Schedule', value: schedule.charAt(0).toUpperCase() + schedule.slice(1), inline: true },
                { name: 'Time', value: time, inline: true }
            )
            .setFooter({ text: 'Use /qotd deck select to choose a deck' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'schedule') {
        const channel = interaction.options.getChannel('channel');
        const type = interaction.options.getString('type');
        const interval = interaction.options.getInteger('interval');

        // Check if channel is configured
        const [[config]] = await pool.execute(
            'SELECT * FROM qotd_channels WHERE channel_id = ?',
            [channel.id]
        );

        if (!config) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Channel Not Configured')
                    .setDescription(`${channel} is not set up for QOTD. Use \`/qotd setup channel\` first.`)
                ]
            });
        }

        let customIntervalMinutes = null;
        if (type === 'custom' && interval) {
            customIntervalMinutes = interval * 60; // Convert hours to minutes
        }

        await pool.execute(
            'UPDATE qotd_channels SET schedule_type = ?, custom_interval_minutes = ? WHERE channel_id = ?',
            [type, customIntervalMinutes, channel.id]
        );

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Schedule Updated')
            .setDescription(`Updated posting schedule for ${channel}`)
            .addFields({
                name: 'Type',
                value: type === 'custom' ? `Every ${interval} hours` : type.charAt(0).toUpperCase() + type.slice(1)
            })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'appearance') {
        const channel = interaction.options.getChannel('channel');
        const title = interaction.options.getString('title');
        const color = interaction.options.getString('color');
        const thread = interaction.options.getBoolean('thread');
        const pin = interaction.options.getBoolean('pin');

        // Validate color if provided
        if (color && !/^#[0-9A-F]{6}$/i.test(color)) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Invalid Color')
                    .setDescription('Please use a valid hex color code (e.g., #5865F2)')
                ]
            });
        }

        // Update appearance settings
        const updates = [];
        const values = [];

        if (title !== null) {
            updates.push('embed_title = ?');
            values.push(title);
        }
        if (color !== null) {
            updates.push('embed_color = ?');
            values.push(color);
        }
        if (thread !== null) {
            updates.push('thread_enabled = ?');
            values.push(thread ? 1 : 0);
        }
        if (pin !== null) {
            updates.push('pin_message = ?');
            values.push(pin ? 1 : 0);
        }

        if (updates.length === 0) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ffa500')
                    .setTitle('No Changes')
                    .setDescription('Please specify at least one appearance setting to update.')
                ]
            });
        }

        values.push(channel.id);

        await pool.execute(
            `UPDATE qotd_channels SET ${updates.join(', ')} WHERE channel_id = ?`,
            values
        );

        const embed = new EmbedBuilder()
            .setColor(color || '#57f287')
            .setTitle('Appearance Updated')
            .setDescription(`Customized QOTD appearance for ${channel}`)
            .setTimestamp();

        if (title) embed.addFields({ name: 'Title', value: title, inline: true });
        if (color) embed.addFields({ name: 'Color', value: color, inline: true });
        if (thread !== null) embed.addFields({ name: 'Threads', value: thread ? 'Enabled' : 'Disabled', inline: true });
        if (pin !== null) embed.addFields({ name: 'Pinning', value: pin ? 'Enabled' : 'Disabled', inline: true });

        await interaction.editReply({ embeds: [embed] });
    }
}

// Deck handlers
async function handleDeck(interaction, subcommand) {
    await interaction.deferReply();

    if (subcommand === 'create') {
        const name = interaction.options.getString('name');
        const type = interaction.options.getString('type');
        const description = interaction.options.getString('description');

        const [result] = await pool.execute(
            'INSERT INTO qotd_decks (guild_id, deck_name, description, deck_type, created_by) VALUES (?, ?, ?, ?, ?)',
            [interaction.guild.id, name, description, type, interaction.user.id]
        );

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Deck Created')
            .setDescription(`Created new ${type} deck`)
            .addFields(
                { name: 'Name', value: name, inline: true },
                { name: 'Deck ID', value: result.insertId.toString(), inline: true }
            )
            .setFooter({ text: 'Use /qotd card add to add cards to this deck' })
            .setTimestamp();

        if (description) {
            embed.addFields({ name: 'Description', value: description });
        }

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'list') {
        const showCommunity = interaction.options.getBoolean('community') ?? false;

        let query = showCommunity
            ? 'SELECT * FROM qotd_decks WHERE is_community = 1 OR guild_id = ? ORDER BY deck_name'
            : 'SELECT * FROM qotd_decks WHERE guild_id = ? ORDER BY deck_name';

        const [decks] = await pool.execute(query, [interaction.guild.id]);

        if (decks.length === 0) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ffa500')
                    .setTitle('No Decks Found')
                    .setDescription('No decks available. Create one with `/qotd deck create`')
                ]
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865f2')
            .setTitle(showCommunity ? 'Available Decks (Including Community)' : 'Server Decks')
            .setDescription(decks.map(d =>
                `**${d.deck_id}. ${d.deck_name}** ${d.is_community ? '🌐' : ''}\n` +
                `Type: ${d.deck_type} | Cards: ${d.card_count} | Uses: ${d.times_used}\n` +
                (d.description ? `_${d.description}_` : '')
            ).join('\n\n'))
            .setFooter({ text: `${decks.length} deck(s) | 🌐 = Community Deck` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'select') {
        const channel = interaction.options.getChannel('channel');
        const deckId = interaction.options.getInteger('deck_id');

        // Verify deck exists and is accessible
        const [[deck]] = await pool.execute(
            'SELECT * FROM qotd_decks WHERE deck_id = ? AND (guild_id = ? OR is_community = 1)',
            [deckId, interaction.guild.id]
        );

        if (!deck) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Deck Not Found')
                    .setDescription('Deck not found or not accessible to this server.')
                ]
            });
        }

        // Update channel configuration
        await pool.execute(
            'UPDATE qotd_channels SET active_deck_id = ? WHERE channel_id = ?',
            [deckId, channel.id]
        );

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Deck Selected')
            .setDescription(`Set active deck for ${channel}`)
            .addFields(
                { name: 'Deck', value: deck.deck_name, inline: true },
                { name: 'Cards', value: deck.card_count.toString(), inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'shuffle') {
        const deckId = interaction.options.getInteger('deck_id');

        // Verify deck ownership
        const [[deck]] = await pool.execute(
            'SELECT * FROM qotd_decks WHERE deck_id = ? AND guild_id = ?',
            [deckId, interaction.guild.id]
        );

        if (!deck) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Deck Not Found')
                    .setDescription('Deck not found or you don\'t have permission to shuffle it.')
                ]
            });
        }

        // Get all cards and shuffle positions
        const [cards] = await pool.execute(
            'SELECT card_id FROM qotd_cards WHERE deck_id = ?',
            [deckId]
        );

        if (cards.length === 0) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ffa500')
                    .setTitle('No Cards to Shuffle')
                    .setDescription('This deck has no cards.')
                ]
            });
        }

        // Fisher-Yates shuffle
        const shuffled = [...cards];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        // Update positions
        for (let i = 0; i < shuffled.length; i++) {
            await pool.execute(
                'UPDATE qotd_cards SET position = ? WHERE card_id = ?',
                [i + 1, shuffled[i].card_id]
            );
        }

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Deck Shuffled')
            .setDescription(`Shuffled ${cards.length} cards in **${deck.deck_name}**`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'delete') {
        const deckId = interaction.options.getInteger('deck_id');

        // Verify deck ownership
        const [[deck]] = await pool.execute(
            'SELECT * FROM qotd_decks WHERE deck_id = ? AND guild_id = ?',
            [deckId, interaction.guild.id]
        );

        if (!deck) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Deck Not Found')
                    .setDescription('Deck not found or you don\'t have permission to delete it.')
                ]
            });
        }

        // Delete deck (cards will be cascade deleted)
        await pool.execute('DELETE FROM qotd_decks WHERE deck_id = ?', [deckId]);

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Deck Deleted')
            .setDescription(`Deleted deck **${deck.deck_name}** and all its cards`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
}

// Card handlers
async function handleCard(interaction, subcommand) {
    await interaction.deferReply();

    if (subcommand === 'add') {
        const deckId = interaction.options.getInteger('deck_id');
        const content = interaction.options.getString('content');
        const imageUrl = interaction.options.getString('image_url');

        // Verify deck ownership
        const [[deck]] = await pool.execute(
            'SELECT * FROM qotd_decks WHERE deck_id = ? AND guild_id = ?',
            [deckId, interaction.guild.id]
        );

        if (!deck) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Deck Not Found')
                    .setDescription('Deck not found or you don\'t have permission to add cards to it.')
                ]
            });
        }

        // Get next position
        const [[{ maxPos }]] = await pool.execute(
            'SELECT COALESCE(MAX(position), 0) as maxPos FROM qotd_cards WHERE deck_id = ?',
            [deckId]
        );

        // Add card
        const [result] = await pool.execute(
            'INSERT INTO qotd_cards (deck_id, content, card_type, image_url, position, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [deckId, content, deck.deck_type, imageUrl, maxPos + 1, interaction.user.id]
        );

        // Update deck card count
        await pool.execute(
            'UPDATE qotd_decks SET card_count = card_count + 1 WHERE deck_id = ?',
            [deckId]
        );

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Card Added')
            .setDescription(`Added card to **${deck.deck_name}**`)
            .addFields({ name: 'Content', value: content.substring(0, 1024) })
            .setFooter({ text: `Card ID: ${result.insertId}` })
            .setTimestamp();

        if (imageUrl) {
            embed.setImage(imageUrl);
        }

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'edit') {
        const cardId = interaction.options.getInteger('card_id');
        const content = interaction.options.getString('content');

        // Verify card ownership
        const [[card]] = await pool.execute(`
            SELECT c.*, d.guild_id
            FROM qotd_cards c
            JOIN qotd_decks d ON c.deck_id = d.deck_id
            WHERE c.card_id = ? AND d.guild_id = ?
        `, [cardId, interaction.guild.id]);

        if (!card) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Card Not Found')
                    .setDescription('Card not found or you don\'t have permission to edit it.')
                ]
            });
        }

        await pool.execute(
            'UPDATE qotd_cards SET content = ? WHERE card_id = ?',
            [content, cardId]
        );

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Card Updated')
            .setDescription('Successfully updated card content')
            .addFields({ name: 'New Content', value: content.substring(0, 1024) })
            .setFooter({ text: `Card ID: ${cardId}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'delete') {
        const cardId = interaction.options.getInteger('card_id');

        // Verify card ownership
        const [[card]] = await pool.execute(`
            SELECT c.*, d.guild_id, d.deck_name
            FROM qotd_cards c
            JOIN qotd_decks d ON c.deck_id = d.deck_id
            WHERE c.card_id = ? AND d.guild_id = ?
        `, [cardId, interaction.guild.id]);

        if (!card) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Card Not Found')
                    .setDescription('Card not found or you don\'t have permission to delete it.')
                ]
            });
        }

        await pool.execute('DELETE FROM qotd_cards WHERE card_id = ?', [cardId]);

        // Update deck card count
        await pool.execute(
            'UPDATE qotd_decks SET card_count = card_count - 1 WHERE deck_id = ?',
            [card.deck_id]
        );

        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('Card Deleted')
            .setDescription(`Deleted card from **${card.deck_name}**`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'view') {
        const deckId = interaction.options.getInteger('deck_id');
        const page = interaction.options.getInteger('page') || 1;
        const perPage = 10;
        const offset = (page - 1) * perPage;

        // Verify deck access
        const [[deck]] = await pool.execute(
            'SELECT * FROM qotd_decks WHERE deck_id = ? AND (guild_id = ? OR is_community = 1)',
            [deckId, interaction.guild.id]
        );

        if (!deck) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ed4245')
                    .setTitle('Deck Not Found')
                    .setDescription('Deck not found or not accessible.')
                ]
            });
        }

        const [cards] = await pool.execute(
            'SELECT * FROM qotd_cards WHERE deck_id = ? ORDER BY position LIMIT ? OFFSET ?',
            [deckId, perPage, offset]
        );

        if (cards.length === 0) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#ffa500')
                    .setTitle('No Cards')
                    .setDescription('This deck has no cards.')
                ]
            });
        }

        const totalPages = Math.ceil(deck.card_count / perPage);

        const embed = new EmbedBuilder()
            .setColor('#5865f2')
            .setTitle(`${deck.deck_name} - Cards`)
            .setDescription(cards.map(c =>
                `**${c.card_id}.** ${c.content.substring(0, 100)}${c.content.length > 100 ? '...' : ''}`
            ).join('\n\n'))
            .setFooter({ text: `Page ${page}/${totalPages} | ${deck.card_count} total cards` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
}

// Suggest handler
async function handleSuggest(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const content = interaction.options.getString('content');
    const type = interaction.options.getString('type') || 'question';

    await pool.execute(
        'INSERT INTO qotd_suggestions (guild_id, user_id, content, suggestion_type) VALUES (?, ?, ?, ?)',
        [interaction.guild.id, interaction.user.id, content, type]
    );

    const embed = new EmbedBuilder()
        .setColor('#57f287')
        .setTitle('Suggestion Submitted')
        .setDescription('Your suggestion has been submitted to server staff for review.')
        .addFields({ name: 'Content', value: content.substring(0, 1024) })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

// Post handler
async function handlePost(interaction) {
    await interaction.deferReply();

    const channel = interaction.options.getChannel('channel');

    // Get channel config
    const [[config]] = await pool.execute(
        'SELECT * FROM qotd_channels WHERE channel_id = ?',
        [channel.id]
    );

    if (!config || !config.active_deck_id) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#ed4245')
                .setTitle('Not Configured')
                .setDescription(`${channel} is not configured or has no active deck. Use \`/qotd setup channel\` and \`/qotd deck select\`.`)
            ]
        });
    }

    // Import and use the posting logic
    const { postQOTD } = await import('../../core/qotd-poster.js');
    const result = await postQOTD(interaction.client, config);

    if (result.success) {
        const embed = new EmbedBuilder()
            .setColor('#57f287')
            .setTitle('QOTD Posted')
            .setDescription(`Successfully posted to ${channel}`)
            .addFields({ name: 'Content', value: result.content.substring(0, 1024) })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } else {
        throw new Error(result.error || 'Failed to post QOTD');
    }
}

// View handler
async function handleView(interaction) {
    await interaction.deferReply();

    const channel = interaction.options.getChannel('channel');

    const [[config]] = await pool.execute(
        'SELECT * FROM qotd_channels WHERE channel_id = ?',
        [channel.id]
    );

    if (!config) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#ffa500')
                .setTitle('Not Configured')
                .setDescription(`${channel} has not been set up for QOTD.`)
            ]
        });
    }

    // Get active deck info
    let deckInfo = 'None selected';
    if (config.active_deck_id) {
        const [[deck]] = await pool.execute(
            'SELECT * FROM qotd_decks WHERE deck_id = ?',
            [config.active_deck_id]
        );
        if (deck) {
            deckInfo = `${deck.deck_name} (${deck.card_count} cards)`;
        }
    }

    const embed = new EmbedBuilder()
        .setColor(config.embed_color || '#5865f2')
        .setTitle('QOTD Configuration')
        .setDescription(`Settings for ${channel}`)
        .addFields(
            { name: 'Status', value: config.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
            { name: 'Schedule', value: config.schedule_type.charAt(0).toUpperCase() + config.schedule_type.slice(1), inline: true },
            { name: 'Post Time', value: config.schedule_time || 'Not set', inline: true },
            { name: 'Active Deck', value: deckInfo, inline: true },
            { name: 'Mode', value: config.mode.charAt(0).toUpperCase() + config.mode.slice(1), inline: true },
            { name: 'Threads', value: config.thread_enabled ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Embed Title', value: config.embed_title || 'Question of the Day' },
            { name: 'Last Posted', value: config.last_posted_at ? `<t:${Math.floor(new Date(config.last_posted_at).getTime() / 1000)}:R>` : 'Never' }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}
