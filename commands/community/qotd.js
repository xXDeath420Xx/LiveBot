import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { libraryCoverage, selectLibraryQuestion, DEFAULT_WINDOW_DAYS } from '../../core/qotd-selector.js';
import { createChannel, updateChannelSchedule, describeDays } from '../../core/qotd-poster.js';

/** Shared by setup channel and setup schedule. Short descriptions: /qotd sits near Discord's per-command size limit. */
const daysOption = (o) => o.setName('days').setDescription('Weekly: days to post, e.g. monday or mon,thu').setMaxLength(80).setRequired(false);
const timezoneOption = (o) => o.setName('timezone').setDescription('Timezone, e.g. America/Los_Angeles').setAutocomplete(true).setRequired(false);

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
                        .addStringOption(daysOption)
                        .addStringOption(timezoneOption)
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
                        .addStringOption(daysOption)
                        .addStringOption(o => o.setName('time').setDescription('Time to post, HH:MM').setRequired(false))
                        .addStringOption(timezoneOption)
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
        .addSubcommandGroup(group =>
            group
                .setName('library')
                .setDescription('The shared question library and its no-repeat rules')
                .addSubcommand(sub =>
                    sub
                        .setName('stats')
                        .setDescription('How much of the library this server has used, and how much runway is left')
                )
                .addSubcommand(sub =>
                    sub
                        .setName('preview')
                        .setDescription('Show the next few questions this channel would post')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('QOTD channel')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)
                        )
                        .addIntegerOption(option =>
                            option
                                .setName('days')
                                .setDescription('How many days ahead to preview (default 7)')
                                .setMinValue(1)
                                .setMaxValue(30)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('source')
                        .setDescription('Choose where this channel takes questions from')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('QOTD channel')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName('mode')
                                .setDescription('Where questions come from')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Shared library (recommended)', value: 'library' },
                                    { name: 'This server\'s deck only', value: 'deck' },
                                    { name: 'Deck first, then library', value: 'mixed' }
                                )
                        )
                        .addIntegerOption(option =>
                            option
                                .setName('window')
                                .setDescription('Days before a question may repeat here (default 90)')
                                .setMinValue(7)
                                .setMaxValue(730)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('themes')
                        .setDescription('List every theme, or mute ones this server does not want')
                        .addChannelOption(option =>
                            option
                                .setName('channel')
                                .setDescription('QOTD channel (omit to just list the themes)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(false)
                        )
                        .addStringOption(option =>
                            option
                                .setName('mute')
                                .setDescription('Comma-separated themes to never post here. Use "none" to clear.')
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
        ),
        // No default member permission: Discord hid all of /qotd from members, /qotd suggest included (H-807).
        // execute() requires Manage Server for everything except suggest.

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'timezone') return interaction.respond([]);
        const q = String(focused.value || '').toLowerCase().replace(/\s+/g, '_');
        let zones = [];
        try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['UTC']; }
        if (!zones.includes('UTC')) zones.unshift('UTC');
        const hits = zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 25);
        return interaction.respond(hits.map((z) => ({ name: z.replace(/_/g, ' '), value: z })));
    },

    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const isSuggest = !subcommandGroup && subcommand === 'suggest';
        if (!isSuggest && !interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'You need the Manage Server permission for that. Members can use `/qotd suggest`.', ephemeral: true });
        }

        try {
            if (subcommandGroup === 'setup') {
                await handleSetup(interaction, subcommand);
            } else if (subcommandGroup === 'deck') {
                await handleDeck(interaction, subcommand);
            } else if (subcommandGroup === 'library') {
                await handleLibrary(interaction, subcommand);
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
                .setColor(themeColor(interaction.guildId, 'danger'))
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

/** "Daily", "Weekly: Monday and Thursday", "Every 6 hours". */
function scheduleText(row) {
    if (row.schedule_type === 'weekly') return `Weekly: ${describeDays(row.schedule_days)}`;
    if (row.schedule_type === 'custom') {
        const m = Number(row.custom_interval_minutes) || 0;
        return m % 60 === 0 ? `Every ${m / 60} hour${m === 60 ? '' : 's'}` : `Every ${m} minutes`;
    }
    return 'Daily';
}

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
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Invalid Time Format')
                    .setDescription('Please use HH:MM format (e.g., 09:00, 14:30)')
                ]
            });
        }

        // New channels start from the server's dashboard defaults; options given here win.
        const overrides = { schedule_type: schedule };
        if (interaction.options.getString('time')) overrides.schedule_time = time;
        const days = interaction.options.getString('days');
        if (days) overrides.schedule_days = days;
        const timezone = interaction.options.getString('timezone');
        if (timezone) overrides.timezone = timezone;

        const result = await createChannel(interaction.guild.id, channel.id, overrides);
        if (!result.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Could not set up QOTD')
                    .setDescription(result.error + (schedule === 'weekly' ? '\nAdd `days`, e.g. `days: monday`.' : ''))
                ]
            });
        }
        const row = result.row;

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('QOTD Channel Configured')
            .setDescription(`Successfully set up QOTD in ${channel}`)
            .addFields(
                { name: 'Schedule', value: scheduleText(row), inline: true },
                { name: 'Time', value: `${String(row.schedule_time).slice(0, 5)} ${row.timezone}`, inline: true }
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Channel Not Configured')
                    .setDescription(`${channel} is not set up for QOTD. Use \`/qotd setup channel\` first.`)
                ]
            });
        }

        const patch = { schedule_type: type };
        if (type === 'custom' && interval) patch.custom_interval_minutes = interval * 60; // hours → minutes
        for (const k of ['days', 'time', 'timezone']) {
            const v = interaction.options.getString(k);
            if (v) patch[{ days: 'schedule_days', time: 'schedule_time', timezone: 'timezone' }[k]] = v;
        }

        const result = await updateChannelSchedule(interaction.guild.id, channel.id, patch);
        if (!result.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Schedule not changed')
                    .setDescription(result.error)
                ]
            });
        }
        const row = result.row;

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('Schedule Updated')
            .setDescription(`Updated posting schedule for ${channel}`)
            .addFields(
                { name: 'Schedule', value: scheduleText(row), inline: true },
                { name: 'Time', value: row.schedule_type === 'custom' ? '—' : `${String(row.schedule_time).slice(0, 5)} ${row.timezone}`, inline: true }
            )
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
                    .setColor(themeColor(interaction.guildId, 'warning'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'warning'))
                    .setTitle('No Decks Found')
                    .setDescription('No decks available. Create one with `/qotd deck create`')
                ]
            });
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
                    .setColor(themeColor(interaction.guildId, 'warning'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Deck Not Found')
                    .setDescription('Deck not found or you don\'t have permission to delete it.')
                ]
            });
        }

        // Delete deck (cards will be cascade deleted)
        await pool.execute('DELETE FROM qotd_decks WHERE deck_id = ?', [deckId]);

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                    .setColor(themeColor(interaction.guildId, 'danger'))
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
                    .setColor(themeColor(interaction.guildId, 'warning'))
                    .setTitle('No Cards')
                    .setDescription('This deck has no cards.')
                ]
            });
        }

        const totalPages = Math.ceil(deck.card_count / perPage);

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
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
        .setColor(themeColor(interaction.guildId, 'success'))
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
                .setColor(themeColor(interaction.guildId, 'danger'))
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
            .setColor(themeColor(interaction.guildId, 'success'))
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
                .setColor(themeColor(interaction.guildId, 'warning'))
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
            { name: 'Schedule', value: scheduleText(config), inline: true },
            { name: 'Post Time', value: config.schedule_type === 'custom' ? '—' : `${String(config.schedule_time || '09:00').slice(0, 5)} ${config.timezone || 'UTC'}`, inline: true },
            { name: 'Active Deck', value: deckInfo, inline: true },
            { name: 'Mode', value: config.mode.charAt(0).toUpperCase() + config.mode.slice(1), inline: true },
            { name: 'Threads', value: config.thread_enabled ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Embed Title', value: config.embed_title || 'Question of the Day' },
            { name: 'Last Posted', value: config.last_posted_at ? `<t:${Math.floor(new Date(config.last_posted_at).getTime() / 1000)}:R>` : 'Never' }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}


// Library handlers — the shared pool and its anti-repetition rules.
async function handleLibrary(interaction, subcommand) {
    await interaction.deferReply();

    if (subcommand === 'stats') {
        const [[channel]] = await pool.execute(
            'SELECT repeat_window_days FROM qotd_channels WHERE guild_id = ? ORDER BY created_at LIMIT 1',
            [interaction.guild.id]
        );
        const windowDays = channel?.repeat_window_days || DEFAULT_WINDOW_DAYS;
        const coverage = await libraryCoverage(interaction.guild.id, windowDays);

        const [themes] = await pool.execute(
            'SELECT theme, COUNT(*) AS n FROM qotd_library WHERE active = 1 GROUP BY theme ORDER BY theme'
        );
        const [[recent]] = await pool.execute(
            `SELECT COUNT(*) AS posts, COUNT(DISTINCT variant_group) AS distinct_qs
             FROM qotd_history WHERE guild_id = ? AND posted_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [interaction.guild.id, windowDays]
        );

        // Runway is in groups, not rows: two rewordings of one question are one slot.
        const daysOfRunway = coverage.remaining;

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('QOTD Library')
            .setDescription(
                `**${coverage.libraryQuestions}** questions in **${themes.length}** themes, ` +
                `**${coverage.distinctGroups}** of them distinct once rewordings are collapsed.`
            )
            .addFields(
                { name: 'No-repeat window', value: `${windowDays} days`, inline: true },
                { name: 'Used in that window', value: `${coverage.usedInWindow}`, inline: true },
                { name: 'Days of runway left', value: `${daysOfRunway}`, inline: true },
                { name: 'Posted here recently', value: `${recent.posts} posts, ${recent.distinct_qs} distinct questions`, inline: false },
                { name: 'Themes', value: themes.map(t => `${t.theme} (${t.n})`).join(' · ').slice(0, 1024), inline: false }
            )
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    if (subcommand === 'preview') {
        const channel = interaction.options.getChannel('channel');
        const days = interaction.options.getInteger('days') || 7;

        const [[config]] = await pool.execute(
            'SELECT * FROM qotd_channels WHERE channel_id = ?', [channel.id]
        );
        if (!config) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Not configured')
                    .setDescription(`${channel} has no QOTD setup. Run \`/qotd setup channel\` first.`)]
            });
        }

        // Preview only reads — it never writes history, so the real rotation is unaffected.
        // That also means each previewed day is picked as if it were the only one: two
        // consecutive previews can show the same question twice where the live run would not.
        const lines = [];
        for (let d = 0; d < days; d++) {
            const { question, tier } = await selectLibraryQuestion(config, { dayOffset: d });
            lines.push(question
                ? `**+${d}d** \`${question.theme}\` ${question.content}${tier === 'exhausted' ? ' ⚠️' : ''}`
                : `**+${d}d** — nothing available`);
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(`Next ${days} days in #${channel.name}`)
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setFooter({ text: 'Preview is read-only and approximate — it does not reserve these questions.' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    if (subcommand === 'source') {
        const channel = interaction.options.getChannel('channel');
        const mode = interaction.options.getString('mode');
        const window = interaction.options.getInteger('window');

        const [[config]] = await pool.execute(
            'SELECT * FROM qotd_channels WHERE channel_id = ?', [channel.id]
        );
        if (!config) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Not configured')
                    .setDescription(`${channel} has no QOTD setup. Run \`/qotd setup channel\` first.`)]
            });
        }

        if (mode === 'deck' && !config.active_deck_id) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('No deck selected')
                    .setDescription('Deck-only mode needs a deck. Use `/qotd deck select` first, or pick the shared library.')]
            });
        }

        await pool.execute(
            `UPDATE qotd_channels SET source_mode = ?${window ? ', repeat_window_days = ?' : ''} WHERE channel_id = ?`,
            window ? [mode, window, channel.id] : [mode, channel.id]
        );

        const explain = {
            library: 'Questions come from the shared library, filtered so nothing repeats here inside the window and other servers get different questions.',
            deck: 'Questions come only from this server\'s own deck. The no-repeat window does not apply.',
            mixed: 'This server\'s unposted deck cards go out first, then the shared library takes over.',
        }[mode];

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'success'))
                .setTitle('Question source updated')
                .setDescription(explain)
                .addFields(
                    { name: 'Channel', value: `${channel}`, inline: true },
                    { name: 'Source', value: mode, inline: true },
                    { name: 'No-repeat window', value: `${window || config.repeat_window_days || DEFAULT_WINDOW_DAYS} days`, inline: true }
                )
                .setTimestamp()]
        });
    }

    if (subcommand === 'themes') {
        const channel = interaction.options.getChannel('channel');
        const mute = interaction.options.getString('mute');

        const [themes] = await pool.execute(
            'SELECT theme, COUNT(*) AS n FROM qotd_library WHERE active = 1 GROUP BY theme ORDER BY theme'
        );
        const known = new Set(themes.map(t => t.theme));

        if (mute !== null && !channel) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Which channel?')
                    .setDescription('Muting themes is per-channel — pass the QOTD channel as well.')]
            });
        }

        if (mute === null) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'primary'))
                    .setTitle('Library themes')
                    .setDescription(themes.map(t => `\`${t.theme}\` — ${t.n} questions`).join('\n'))
                    .setFooter({ text: 'Mute themes with /qotd library themes channel:#chan mute:absurd,sports' })]
            });
        }

        const requested = mute.toLowerCase() === 'none'
            ? []
            : mute.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        const unknown = requested.filter(t => !known.has(t));
        if (unknown.length) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('Unknown theme')
                    .setDescription(`No such theme: ${unknown.map(t => `\`${t}\``).join(', ')}\n\nValid: ${[...known].join(', ')}`)]
            });
        }
        if (requested.length >= known.size) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setTitle('That mutes everything')
                    .setDescription('Muting every theme would leave nothing to post. Leave at least one unmuted.')]
            });
        }

        await pool.execute(
            'UPDATE qotd_channels SET theme_blocklist = ? WHERE channel_id = ?',
            [requested.length ? JSON.stringify(requested) : null, channel.id]
        );

        const remaining = themes.filter(t => !requested.includes(t.theme));
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'success'))
                .setTitle(requested.length ? 'Themes muted' : 'Theme filter cleared')
                .setDescription(requested.length
                    ? `${channel} will never post: ${requested.map(t => `\`${t}\``).join(', ')}`
                    : `${channel} now draws from every theme.`)
                .addFields({
                    name: 'Questions still available',
                    value: `${remaining.reduce((n, t) => n + t.n, 0)} across ${remaining.length} themes`,
                })
                .setTimestamp()]
        });
    }
}
