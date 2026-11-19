import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { themeColor } from '../../core/guild-theme.js';
import logger from '../../utils/logger.js';
import pool from '../../utils/db.js';
import { parseScheduleStart, isEventSlugTaken } from '../../core/schedule-manager.js';

export default {
  category: 'community',
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Manage event schedules (marathon, stream schedules)')
    // Event management
    .addSubcommandGroup(group =>
      group
        .setName('event')
        .setDescription('Manage schedule events')
        .addSubcommand(sub =>
          sub.setName('create')
            .setDescription('Create a new event')
            .addStringOption(opt => opt.setName('name').setDescription('Event name').setRequired(true))
            .addStringOption(opt => opt.setName('slug').setDescription('URL-friendly identifier (e.g., agdq2025)').setRequired(true))
            .addStringOption(opt => opt.setName('description').setDescription('Event description'))
            .addStringOption(opt => opt.setName('twitch').setDescription('Twitch channel name'))
        )
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('List all events in this server')
        )
        .addSubcommand(sub =>
          sub.setName('view')
            .setDescription('View event details')
            .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('delete')
            .setDescription('Delete an event')
            .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
        )
    )
    // Schedule management
    .addSubcommandGroup(group =>
      group
        .setName('list')
        .setDescription('Manage schedule lists within events')
        .addSubcommand(sub =>
          sub.setName('create')
            .setDescription('Create a schedule within an event')
            .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
            .addStringOption(opt => opt.setName('name').setDescription('Schedule name (e.g., Day 1)').setRequired(true))
            .addStringOption(opt => opt.setName('slug').setDescription('URL-friendly identifier').setRequired(true))
            .addStringOption(opt => opt.setName('start').setDescription('When the first run starts, YYYY-MM-DD HH:MM (24h)'))
            .addStringOption(opt => opt.setName('timezone').setDescription('Time zone of the start time (default UTC)').setAutocomplete(true))
        )
        .addSubcommand(sub =>
          sub.setName('set-start')
            .setDescription('Set or change when a schedule starts')
            .addIntegerOption(opt => opt.setName('schedule_id').setDescription('Schedule ID').setRequired(true))
            .addStringOption(opt => opt.setName('start').setDescription('When the first run starts, YYYY-MM-DD HH:MM (24h)').setRequired(true))
            .addStringOption(opt => opt.setName('timezone').setDescription('Time zone of the start time (default UTC)').setAutocomplete(true))
        )
        .addSubcommand(sub =>
          sub.setName('view')
            .setDescription('View schedules in an event')
            .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('delete')
            .setDescription('Delete a schedule')
            .addIntegerOption(opt => opt.setName('schedule_id').setDescription('Schedule ID').setRequired(true))
        )
    )
    // Run/Item management
    .addSubcommandGroup(group =>
      group
        .setName('run')
        .setDescription('Manage runs/items in a schedule')
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add a run to a schedule')
            .addIntegerOption(opt => opt.setName('schedule_id').setDescription('Schedule ID').setRequired(true))
            .addStringOption(opt => opt.setName('game').setDescription('Game name').setRequired(true))
            .addStringOption(opt => opt.setName('category').setDescription('Run category (e.g., Any%)'))
            .addStringOption(opt => opt.setName('runners').setDescription('Runner name(s)'))
            .addStringOption(opt => opt.setName('estimate').setDescription('Estimated time (e.g., 1:30:00 or 45m)'))
            .addStringOption(opt => opt.setName('setup').setDescription('Setup time (e.g., 5m)'))
        )
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('List runs in a schedule')
            .addIntegerOption(opt => opt.setName('schedule_id').setDescription('Schedule ID').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('edit')
            .setDescription('Edit a run')
            .addIntegerOption(opt => opt.setName('run_id').setDescription('Run ID').setRequired(true))
            .addStringOption(opt => opt.setName('game').setDescription('Game name'))
            .addStringOption(opt => opt.setName('category').setDescription('Run category'))
            .addStringOption(opt => opt.setName('runners').setDescription('Runner name(s)'))
            .addStringOption(opt => opt.setName('estimate').setDescription('Estimated time'))
        )
        .addSubcommand(sub =>
          sub.setName('delete')
            .setDescription('Delete a run')
            .addIntegerOption(opt => opt.setName('run_id').setDescription('Run ID').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('start')
            .setDescription('Start a run (mark as running)')
            .addIntegerOption(opt => opt.setName('run_id').setDescription('Run ID').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('complete')
            .setDescription('Complete a run')
            .addIntegerOption(opt => opt.setName('run_id').setDescription('Run ID').setRequired(true))
        )
    )
    // Ticker/Link management
    .addSubcommand(sub =>
      sub.setName('ticker')
        .setDescription('View current schedule ticker')
        .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('link')
        .setDescription('Link this channel for schedule updates')
        .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
        .addStringOption(opt => opt.setName('type').setDescription('Update type')
          .addChoices(
            { name: 'Ticker (auto-updating embed)', value: 'ticker' },
            { name: 'Announcements only', value: 'announcements' },
            { name: 'Ticker + announcements', value: 'full' }
          ))
        .addRoleOption(opt => opt.setName('ping_role').setDescription('Role to ping for announcements'))
        .addIntegerOption(opt => opt.setName('announce_before').setDescription('Post "starting soon" this many minutes ahead (default 5)')
          .setMinValue(1).setMaxValue(120))
    )
    .addSubcommand(sub =>
      sub.setName('unlink')
        .setDescription('Unlink this channel from schedule updates')
        .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
    )
    // Discord server events: reminders + recurring templates (core/event-reminder-manager.js)
    .addSubcommandGroup(group =>
      group
        .setName('discord')
        .setDescription('Discord server events: reminders and repeating events')
        .addSubcommand(sub =>
          sub.setName('recurring-add')
            .setDescription('Create a repeating Discord event (Manage Events)')
            .addStringOption(opt => opt.setName('name').setDescription('Event name').setRequired(true).setMaxLength(100))
            .addStringOption(opt => opt.setName('start').setDescription('First start, YYYY-MM-DD HH:MM (24h)').setRequired(true))
            .addStringOption(opt => opt.setName('repeat').setDescription('How often').setRequired(true)
              .addChoices(
                { name: 'Daily', value: 'daily:1' },
                { name: 'Weekly', value: 'weekly:1' },
                { name: 'Every 2 weeks', value: 'weekly:2' },
                { name: 'Monthly', value: 'monthly:1' }
              ))
            .addStringOption(opt => opt.setName('timezone').setDescription('Time zone of the start time (default UTC)').setAutocomplete(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Voice/stage channel (empty = event outside Discord)')
              .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
            .addStringOption(opt => opt.setName('location').setDescription('Location, for events outside Discord').setMaxLength(100))
            .addIntegerOption(opt => opt.setName('duration').setDescription('Length in minutes (default 60)').setMinValue(15).setMaxValue(1440))
            .addStringOption(opt => opt.setName('description').setDescription('Event description').setMaxLength(1000))
        )
        .addSubcommand(sub =>
          sub.setName('recurring-list')
            .setDescription('List repeating Discord events')
        )
        .addSubcommand(sub =>
          sub.setName('recurring-remove')
            .setDescription('Delete a repeating event (Manage Events)')
            .addIntegerOption(opt => opt.setName('id').setDescription('Template ID from recurring-list').setRequired(true))
            .addBooleanOption(opt => opt.setName('cancel_upcoming').setDescription('Also delete the next event it already created'))
        )
        .addSubcommand(sub =>
          sub.setName('recurring-pause')
            .setDescription('Pause or resume a repeating event (Manage Events)')
            .addIntegerOption(opt => opt.setName('id').setDescription('Template ID from recurring-list').setRequired(true))
            .addBooleanOption(opt => opt.setName('paused').setDescription('True = pause, False = resume').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('reminders')
            .setDescription('Turn event reminder DMs from this server on or off for you')
            .addBooleanOption(opt => opt.setName('enabled').setDescription('Receive reminder DMs').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('settings')
            .setDescription('Reminder and announcement settings (Manage Server)')
            .addBooleanOption(opt => opt.setName('dm_reminders').setDescription('DM members who clicked Interested'))
            .addIntegerOption(opt => opt.setName('minutes_before').setDescription('Minutes before start to remind').setMinValue(5).setMaxValue(1440))
            .addBooleanOption(opt => opt.setName('announce').setDescription('Post when an event starts'))
            .addChannelOption(opt => opt.setName('announce_channel').setDescription('Channel for start announcements')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addRoleOption(opt => opt.setName('announce_role').setDescription('Role to ping in start announcements'))
        )
    ),

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    // Discord server events do not use the marathon ScheduleManager at all.
    if (subcommandGroup === 'discord') {
      try {
        return await this.handleDiscordEvents(interaction, subcommand);
      } catch (error) {
        logger.error('[Schedule] /schedule discord failed', { error: error.message, stack: error.stack, guildId: interaction.guildId, subcommand });
        const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
        return interaction[method]({ content: 'Something went wrong handling that event command.', ephemeral: true }).catch(() => {});
      }
    }

    const scheduleManager = interaction.client.scheduleManager;

    if (!scheduleManager) {
      return interaction.reply({
        content: 'Schedule system is not available.',
        ephemeral: true
      });
    }

    try {
      // Event management
      if (subcommandGroup === 'event') {
        // Require Manage Guild for event management
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: 'You need **Manage Server** permission to manage events.',
            ephemeral: true
          });
        }

        if (subcommand === 'create') {
          return await this.handleEventCreate(interaction, scheduleManager);
        } else if (subcommand === 'list') {
          return await this.handleEventList(interaction, scheduleManager);
        } else if (subcommand === 'view') {
          return await this.handleEventView(interaction, scheduleManager);
        } else if (subcommand === 'delete') {
          return await this.handleEventDelete(interaction, scheduleManager);
        }
      }

      // Schedule list management
      if (subcommandGroup === 'list') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: 'You need **Manage Server** permission to manage schedules.',
            ephemeral: true
          });
        }

        if (subcommand === 'create') {
          return await this.handleScheduleCreate(interaction, scheduleManager);
        } else if (subcommand === 'set-start') {
          return await this.handleScheduleSetStart(interaction, scheduleManager);
        } else if (subcommand === 'view') {
          return await this.handleScheduleView(interaction, scheduleManager);
        } else if (subcommand === 'delete') {
          return await this.handleScheduleDelete(interaction, scheduleManager);
        }
      }

      // Run management
      if (subcommandGroup === 'run') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: 'You need **Manage Server** permission to manage runs.',
            ephemeral: true
          });
        }

        if (subcommand === 'add') {
          return await this.handleRunAdd(interaction, scheduleManager);
        } else if (subcommand === 'list') {
          return await this.handleRunList(interaction, scheduleManager);
        } else if (subcommand === 'edit') {
          return await this.handleRunEdit(interaction, scheduleManager);
        } else if (subcommand === 'delete') {
          return await this.handleRunDelete(interaction, scheduleManager);
        } else if (subcommand === 'start') {
          return await this.handleRunStart(interaction, scheduleManager);
        } else if (subcommand === 'complete') {
          return await this.handleRunComplete(interaction, scheduleManager);
        }
      }

      // Standalone subcommands
      if (subcommand === 'ticker') {
        return await this.handleTicker(interaction, scheduleManager);
      } else if (subcommand === 'link') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: 'You need **Manage Server** permission to link channels.',
            ephemeral: true
          });
        }
        return await this.handleLink(interaction, scheduleManager);
      } else if (subcommand === 'unlink') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: 'You need **Manage Server** permission to unlink channels.',
            ephemeral: true
          });
        }
        return await this.handleUnlink(interaction, scheduleManager);
      }

    } catch (error) {
      console.error('[Schedule Command Error]', error);
      const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
      return interaction[method]({
        content: 'An error occurred while processing the schedule command.',
        ephemeral: true
      });
    }
  },

  // ==================== EVENT HANDLERS ====================

  async handleEventCreate(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name');
    const slug = interaction.options.getString('slug').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const description = interaction.options.getString('description');
    const twitch = interaction.options.getString('twitch');

    // The slug is the public address (/schedule/<slug>), so it must be free in every server.
    const taken = `The slug \`${slug}\` is already used by another event (slugs are web addresses, shared by every server). Pick another.`;
    if (await isEventSlugTaken(slug)) {
      return interaction.editReply({ content: taken });
    }

    let eventId;
    try {
      eventId = await manager.createEvent(interaction.guild.id, {
        slug,
        name,
        description,
        twitchChannel: twitch
      }, interaction.user.id);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return interaction.editReply({ content: taken });
      throw err;
    }

    return interaction.editReply({
      content: `Event **${name}** created successfully!\n` +
               `- Event ID: \`${eventId}\`\n` +
               `- Slug: \`${slug}\`\n\n` +
               `Next: Create a schedule with \`/schedule list create\``
    });
  },

  async handleEventList(interaction, manager) {
    await interaction.deferReply();

    const events = await manager.listEvents(interaction.guild.id);

    if (events.length === 0) {
      return interaction.editReply({
        content: 'No events found. Create one with `/schedule event create`'
      });
    }

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'primary'))
      .setTitle('Schedule Events')
      .setDescription(events.map(e =>
        `**${e.name}** (\`${e.slug}\`)\n` +
        `ID: ${e.id} | ${e.is_active ? 'Active' : 'Inactive'}`
      ).join('\n\n'))
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async handleEventView(interaction, manager) {
    await interaction.deferReply();

    const eventSlug = interaction.options.getString('event');
    const event = await manager.getEvent(interaction.guild.id, eventSlug);

    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    const schedules = await manager.listSchedules(event.id);

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'primary'))
      .setTitle(event.name)
      .setDescription(event.description || '*No description*')
      .addFields(
        { name: 'ID', value: event.id.toString(), inline: true },
        { name: 'Slug', value: event.slug, inline: true },
        { name: 'Status', value: event.is_active ? 'Active' : 'Inactive', inline: true }
      )
      .setTimestamp();

    if (event.twitch_channel) {
      embed.addFields({ name: 'Twitch', value: event.twitch_channel, inline: true });
    }

    if (schedules.length > 0) {
      embed.addFields({
        name: 'Schedules',
        value: schedules.map(s => `${s.name} (ID: ${s.id})`).join('\n')
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },

  async handleEventDelete(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const eventSlug = interaction.options.getString('event');
    const event = await manager.getEvent(interaction.guild.id, eventSlug);

    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    await manager.deleteEvent(event.id);
    return interaction.editReply({ content: `Event **${event.name}** deleted.` });
  },

  // ==================== SCHEDULE HANDLERS ====================

  async handleScheduleCreate(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const eventSlug = interaction.options.getString('event');
    const name = interaction.options.getString('name');
    const slug = interaction.options.getString('slug').toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const event = await manager.getEvent(interaction.guild.id, eventSlug);
    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    // Optional start: without one the page cannot show planned run times and "starting soon"
    // announcements have nothing to count from.
    const startText = interaction.options.getString('start');
    let start = null;
    if (startText) {
      start = parseScheduleStart(startText, interaction.options.getString('timezone') || event.timezone || 'UTC');
      if (!start.ok) return interaction.editReply({ content: start.error });
    }

    const scheduleId = await manager.createSchedule(event.id, { slug, name, startTime: start?.date || null });

    return interaction.editReply({
      content: `Schedule **${name}** created!\n` +
               `- Schedule ID: \`${scheduleId}\`\n` +
               (start ? `- Starts: <t:${Math.floor(start.date.getTime() / 1000)}:F>\n\n`
                      : `- No start time yet: set one with \`/schedule list set-start schedule_id:${scheduleId}\`\n\n`) +
               `Add runs with \`/schedule run add schedule_id:${scheduleId} game:"Game Name"\``
    });
  },

  async handleScheduleSetStart(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const scheduleId = interaction.options.getInteger('schedule_id');
    const schedule = await manager.getSchedule(scheduleId);
    if (!schedule || schedule.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Schedule not found.' });
    }

    const [[event]] = await pool.execute('SELECT timezone FROM schedule_events WHERE id = ?', [schedule.event_id]);
    const start = parseScheduleStart(interaction.options.getString('start'), interaction.options.getString('timezone') || event?.timezone || 'UTC');
    if (!start.ok) return interaction.editReply({ content: start.error });

    await manager.updateSchedule(scheduleId, { start_time: start.date });
    return interaction.editReply({
      content: `**${schedule.name}** now starts <t:${Math.floor(start.date.getTime() / 1000)}:F> (${start.zone}). Planned run times follow from it.`
    });
  },

  async handleScheduleView(interaction, manager) {
    await interaction.deferReply();

    const eventSlug = interaction.options.getString('event');
    const event = await manager.getEvent(interaction.guild.id, eventSlug);

    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    const schedules = await manager.listSchedules(event.id);

    if (schedules.length === 0) {
      return interaction.editReply({
        content: `No schedules in **${event.name}**. Create one with \`/schedule list create\``
      });
    }

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'primary'))
      .setTitle(`Schedules: ${event.name}`)
      .setDescription(schedules.map(s =>
        `**${s.name}** (ID: ${s.id})\nSlug: \`${s.slug}\``
      ).join('\n\n'))
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async handleScheduleDelete(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const scheduleId = interaction.options.getInteger('schedule_id');
    const schedule = await manager.getSchedule(scheduleId);

    if (!schedule || schedule.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Schedule not found.' });
    }

    await manager.deleteSchedule(scheduleId);
    return interaction.editReply({ content: `Schedule **${schedule.name}** deleted.` });
  },

  // ==================== RUN HANDLERS ====================

  async handleRunAdd(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const scheduleId = interaction.options.getInteger('schedule_id');
    const game = interaction.options.getString('game');
    const category = interaction.options.getString('category');
    const runners = interaction.options.getString('runners');
    const estimate = interaction.options.getString('estimate');
    const setup = interaction.options.getString('setup');

    const schedule = await manager.getSchedule(scheduleId);
    if (!schedule || schedule.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Schedule not found.' });
    }

    const itemId = await manager.addItem(scheduleId, {
      gameName: game,
      category,
      runners,
      estimateSeconds: manager.parseDuration(estimate),
      setupSeconds: manager.parseDuration(setup)
    });

    return interaction.editReply({
      content: `Run added: **${game}**${category ? ` - ${category}` : ''}\n` +
               `Run ID: \`${itemId}\``
    });
  },

  async handleRunList(interaction, manager) {
    await interaction.deferReply();

    const scheduleId = interaction.options.getInteger('schedule_id');
    const schedule = await manager.getSchedule(scheduleId);

    if (!schedule || schedule.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Schedule not found.' });
    }

    const items = await manager.listItems(scheduleId);

    if (items.length === 0) {
      return interaction.editReply({
        content: `No runs in **${schedule.name}**. Add with \`/schedule run add\``
      });
    }

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'primary'))
      .setTitle(`${schedule.event_name} - ${schedule.name}`)
      .setDescription(items.map((item, i) => {
        const status = item.status === 'running' ? '>' :
                      item.status === 'completed' ? 'x' :
                      item.status === 'skipped' ? '-' : ' ';
        let line = `\`${status}\` **${item.game_name}**`;
        if (item.category) line += ` - ${item.category}`;
        if (item.runners) line += `\n    ${item.runners}`;
        if (item.estimate_seconds > 0) {
          line += ` [${manager.formatDuration(item.estimate_seconds)}]`;
        }
        line += ` (ID: ${item.id})`;
        return line;
      }).join('\n'))
      .setFooter({ text: '> = running, x = completed, - = skipped' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async handleRunEdit(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const runId = interaction.options.getInteger('run_id');
    const item = await manager.getItem(runId);

    if (!item || item.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Run not found.' });
    }

    const updates = {};
    const game = interaction.options.getString('game');
    const category = interaction.options.getString('category');
    const runners = interaction.options.getString('runners');
    const estimate = interaction.options.getString('estimate');

    if (game) updates.gameName = game;
    if (category) updates.category = category;
    if (runners) updates.runners = runners;
    if (estimate) updates.estimateSeconds = manager.parseDuration(estimate);

    if (Object.keys(updates).length === 0) {
      return interaction.editReply({ content: 'No changes provided.' });
    }

    await manager.updateItem(runId, updates);
    return interaction.editReply({ content: `Run **${item.game_name}** updated.` });
  },

  async handleRunDelete(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const runId = interaction.options.getInteger('run_id');
    const item = await manager.getItem(runId);

    if (!item || item.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Run not found.' });
    }

    await manager.deleteItem(runId);
    return interaction.editReply({ content: `Run **${item.game_name}** deleted.` });
  },

  async handleRunStart(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const runId = interaction.options.getInteger('run_id');
    const item = await manager.getItem(runId);

    if (!item || item.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Run not found.' });
    }

    await manager.startItem(runId);
    return interaction.editReply({ content: `Run **${item.game_name}** started!` });
  },

  async handleRunComplete(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const runId = interaction.options.getInteger('run_id');
    const item = await manager.getItem(runId);

    if (!item || item.guild_id !== interaction.guild.id) {
      return interaction.editReply({ content: 'Run not found.' });
    }

    await manager.completeItem(runId);

    // Auto-start next run
    const next = await manager.getNextItem(item.schedule_id);
    let response = `Run **${item.game_name}** completed!`;
    if (next) {
      response += `\n\nUp next: **${next.game_name}**${next.category ? ` - ${next.category}` : ''}`;
    }

    return interaction.editReply({ content: response });
  },

  // ==================== TICKER/LINK HANDLERS ====================

  async handleTicker(interaction, manager) {
    await interaction.deferReply();

    const eventSlug = interaction.options.getString('event');
    const event = await manager.getEvent(interaction.guild.id, eventSlug);

    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    const schedules = await manager.listSchedules(event.id);
    if (schedules.length === 0) {
      return interaction.editReply({ content: 'No schedules in this event.' });
    }

    // Use first schedule for ticker
    const ticker = await manager.getTicker(schedules[0].id);
    const embed = manager.buildTickerEmbed(event.name, ticker);

    return interaction.editReply({ embeds: [embed] });
  },

  async handleLink(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const eventSlug = interaction.options.getString('event');
    const updateType = interaction.options.getString('type') || 'ticker';
    const pingRole = interaction.options.getRole('ping_role');
    const announceBefore = interaction.options.getInteger('announce_before');

    const event = await manager.getEvent(interaction.guild.id, eventSlug);
    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    await manager.linkChannel(
      interaction.guild.id,
      interaction.channel.id,
      event.id,
      null,
      {
        updateType,
        roleToPing: pingRole?.id,
        announceBeforeMinutes: announceBefore || 5
      }
    );

    const typeLabel = {
      ticker: 'Auto-updating ticker',
      announcements: 'Announcements only',
      full: 'Ticker + announcements'
    }[updateType] || updateType;
    let content = `This channel is now linked to **${event.name}**!\nUpdate type: ${typeLabel}`;
    if (updateType !== 'ticker') {
      content += `\nPosts "starting soon" ${announceBefore || 5} min before each run, plus "now playing" and "completed".` +
                 (pingRole ? ` Pings ${pingRole} for starting soon / now playing.` : '');
      const schedules = await manager.listSchedules(event.id);
      if (!schedules.some(s => s.start_time)) {
        content += '\nNote: no schedule in this event has a start time yet, so "starting soon" can only be ' +
                   'worked out once a run is under way (start runs with `/schedule run start`).';
      }
    }
    return interaction.editReply({ content });
  },

  // ==================== DISCORD SERVER EVENTS ====================

  canManageEvents(interaction) {
    const perms = interaction.memberPermissions;
    return !!perms && (perms.has(PermissionFlagsBits.ManageEvents) || perms.has(PermissionFlagsBits.ManageGuild));
  },

  async handleDiscordEvents(interaction, subcommand) {
    if (!interaction.guild) {
      return interaction.reply({ content: 'Use this in a server.', ephemeral: true });
    }
    const em = await import('../../core/event-reminder-manager.js');

    if (subcommand === 'reminders') {
      const enabled = interaction.options.getBoolean('enabled', true);
      await em.setOptOut(interaction.guild.id, interaction.user.id, !enabled);
      const cfg = await em.getEventConfig(interaction.guild.id);
      let content = enabled
        ? 'You will get a DM before events you mark as **Interested** in this server.'
        : 'You will not get event reminder DMs from this server.';
      if (enabled && !cfg.dmEnabled) content += '\n-# Reminder DMs are currently turned off by this server\'s admins.';
      return interaction.reply({ content, ephemeral: true });
    }

    if (subcommand === 'recurring-list') {
      return this.handleRecurringList(interaction, em);
    }

    if (subcommand === 'settings') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** permission to change event settings.', ephemeral: true });
      }
      return this.handleDiscordSettings(interaction, em);
    }

    if (!this.canManageEvents(interaction)) {
      return interaction.reply({ content: 'You need **Manage Events** permission to manage repeating events.', ephemeral: true });
    }

    if (subcommand === 'recurring-add') return this.handleRecurringAdd(interaction, em);

    if (subcommand === 'recurring-remove') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getInteger('id', true);
      const out = await em.removeTemplate(interaction.guild, id, {
        cancelUpcoming: interaction.options.getBoolean('cancel_upcoming') || false
      });
      if (!out.removed) return interaction.editReply({ content: `No repeating event #${id} in this server.` });
      return interaction.editReply({
        content: `Repeating event **${out.template.template_name}** (#${id}) deleted.` +
                 (out.cancelled ? ' Its upcoming event was cancelled too.' : ' Any event it already created stays as it is.')
      });
    }

    if (subcommand === 'recurring-pause') {
      const id = interaction.options.getInteger('id', true);
      const paused = interaction.options.getBoolean('paused', true);
      const ok = await em.setTemplateActive(interaction.guild.id, id, !paused);
      if (!ok) return interaction.reply({ content: `No repeating event #${id} in this server.`, ephemeral: true });
      return interaction.reply({
        content: paused
          ? `Repeating event #${id} paused — no new events will be created.`
          : `Repeating event #${id} resumed — the next event is created within a minute if none is scheduled.`,
        ephemeral: true
      });
    }

    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
  },

  async handleRecurringAdd(interaction, em) {
    const { buildRule, nextOccurrenceAfter, describeRule } = await import('../../core/recurrence-rule.js');
    const { resolveZone } = await import('../../core/timezone-manager.js');

    const name = interaction.options.getString('name', true).trim();
    const start = interaction.options.getString('start', true);
    const [freq, interval] = interaction.options.getString('repeat', true).split(':');
    const tzInput = interaction.options.getString('timezone');
    const channel = interaction.options.getChannel('channel');
    const location = interaction.options.getString('location')?.trim() || null;
    const duration = interaction.options.getInteger('duration') || 60;
    const description = interaction.options.getString('description')?.trim() || null;

    if (!channel && !location) {
      return interaction.reply({ content: 'Pick a voice/stage **channel**, or give a **location** for an event outside Discord.', ephemeral: true });
    }

    const tz = tzInput ? resolveZone(tzInput) : 'UTC';
    if (!tz) {
      return interaction.reply({ content: `Unknown time zone \`${tzInput}\`. Pick one from the list, e.g. \`America/New_York\`.`, ephemeral: true });
    }

    let rule;
    try {
      rule = buildRule({ freq, interval: Number(interval) || 1, tz, start });
    } catch (err) {
      return interaction.reply({ content: err.message, ephemeral: true });
    }

    const me = interaction.guild.members.me;
    const canCreate = me?.permissions.has(PermissionFlagsBits.ManageEvents) ||
      (PermissionFlagsBits.CreateEvents !== undefined && me?.permissions.has(PermissionFlagsBits.CreateEvents));
    if (!canCreate) {
      return interaction.reply({ content: 'I need the **Create Events** (or **Manage Events**) permission to create events.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const eventType = channel ? (channel.type === ChannelType.GuildStageVoice ? 'stage' : 'voice') : 'external';
    const firstStartMs = nextOccurrenceAfter(rule, Date.now() + 2 * 60_000).startMs;
    const templateId = await em.createTemplate({
      guildId: interaction.guild.id,
      name,
      description,
      rule,
      firstStartMs,
      durationMinutes: duration,
      eventType,
      channelId: channel?.id || null,
      location: channel ? null : location,
      creatorId: interaction.user.id
    });

    const result = await em.createNextOccurrence(templateId, { client: interaction.client, expectedLastEventId: null });
    if (!result.ok) {
      // Nothing was created: drop the template so a corrected retry starts clean.
      await em.removeTemplate(interaction.guild, templateId);
      return interaction.editReply({ content: `Could not create the event: ${result.error}` });
    }

    const s = Math.floor(result.startMs / 1000);
    return interaction.editReply({
      content: `Repeating event **${name}** created (#${templateId}).\n` +
               `${describeRule(rule)}\n` +
               `First event: <t:${s}:F> — https://discord.com/events/${interaction.guild.id}/${result.event.id}\n` +
               'The next one is created automatically when this one ends.'
    });
  },

  async handleRecurringList(interaction, em) {
    const { parseRule, describeRule } = await import('../../core/recurrence-rule.js');
    const templates = await em.listTemplates(interaction.guild.id);
    if (!templates.length) {
      return interaction.reply({ content: 'No repeating events yet. Create one with `/schedule discord recurring-add`.', ephemeral: true });
    }

    const lines = templates.slice(0, 20).map(t => {
      const rule = parseRule(t.recurrence_rule);
      const next = t.next_scheduled ? Math.floor(new Date(t.next_scheduled).getTime() / 1000) : null;
      const where = t.channel_id ? `<#${t.channel_id}>` : (t.location || 'external');
      let line = `**#${t.id} ${t.template_name}** ${t.active ? '' : '(paused)'}\n` +
                 `${rule ? describeRule(rule) : 'invalid rule'} · ${where} · ${t.duration_minutes || 60} min`;
      if (t.last_created_event_id && next) {
        line += `\nLatest: <t:${next}:F> — https://discord.com/events/${interaction.guild.id}/${t.last_created_event_id}`;
      }
      if (t.last_error) line += `\n⚠️ Last error: ${String(t.last_error).slice(0, 150)}`;
      return line;
    });

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'primary'))
      .setTitle('Repeating Discord events')
      .setDescription(lines.join('\n\n').slice(0, 4000))
      .setFooter({ text: templates.length > 20 ? `Showing 20 of ${templates.length}` : `${templates.length} template(s)` });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async handleDiscordSettings(interaction, em) {
    const patch = {};
    const dm = interaction.options.getBoolean('dm_reminders');
    const minutes = interaction.options.getInteger('minutes_before');
    const announce = interaction.options.getBoolean('announce');
    const channel = interaction.options.getChannel('announce_channel');
    const role = interaction.options.getRole('announce_role');
    if (dm !== null) patch.dm_reminders_enabled = dm;
    if (minutes !== null) patch.reminder_minutes = minutes;
    if (announce !== null) patch.announce_enabled = announce;
    if (channel) patch.announce_channel_id = channel.id;
    if (role) patch.announce_role_id = role.id;

    if (Object.keys(patch).length) {
      try {
        const { setConfig } = await import('../../core/feature-config.js');
        await setConfig('event-reminders', interaction.guild.id, patch, interaction.user.id);
      } catch (err) {
        logger.error('[Schedule] Saving event reminder settings failed', { error: err.message, guildId: interaction.guildId });
        return interaction.reply({ content: `Could not save settings: ${err.message}`, ephemeral: true });
      }
    }

    const cfg = await em.getEventConfig(interaction.guild.id);
    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'primary'))
      .setTitle('Discord event reminders')
      .addFields(
        { name: 'Reminder DMs', value: cfg.dmEnabled ? `On — ${cfg.leadMinutes} min before start` : 'Off', inline: true },
        { name: 'Start announcements', value: cfg.announceEnabled ? `On — <#${cfg.announceChannelId}>` : 'Off', inline: true },
        { name: 'Ping role', value: cfg.announceRoleId ? `<@&${cfg.announceRoleId}>` : 'None', inline: true }
      )
      .setFooter({ text: 'Members can opt out with /schedule discord reminders. The dashboard has the same settings.' });
    if (announce && !cfg.announceChannelId) {
      embed.setDescription('Start announcements need a channel — set `announce_channel`.');
    }
    return interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'timezone') return interaction.respond([]).catch(() => {});
    const { searchZones } = await import('../../core/timezone-manager.js');
    const zones = searchZones(focused.value, 25);
    return interaction.respond(zones.map(z => ({ name: z, value: z }))).catch(() => {});
  },

  async handleUnlink(interaction, manager) {
    await interaction.deferReply({ ephemeral: true });

    const eventSlug = interaction.options.getString('event');
    const event = await manager.getEvent(interaction.guild.id, eventSlug);

    if (!event) {
      return interaction.editReply({ content: 'Event not found.' });
    }

    await manager.unlinkChannel(interaction.channel.id, event.id);
    return interaction.editReply({ content: `Channel unlinked from **${event.name}**.` });
  }
};
