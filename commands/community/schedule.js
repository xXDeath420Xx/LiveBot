import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

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
            { name: 'Announcements only', value: 'announcements' }
          ))
        .addRoleOption(opt => opt.setName('ping_role').setDescription('Role to ping for announcements'))
    )
    .addSubcommand(sub =>
      sub.setName('unlink')
        .setDescription('Unlink this channel from schedule updates')
        .addStringOption(opt => opt.setName('event').setDescription('Event slug or ID').setRequired(true))
    ),

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
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

    // Check if slug already exists
    const existing = await manager.getEvent(interaction.guild.id, slug);
    if (existing) {
      return interaction.editReply({
        content: `An event with slug \`${slug}\` already exists.`
      });
    }

    const eventId = await manager.createEvent(interaction.guild.id, {
      slug,
      name,
      description,
      twitchChannel: twitch
    }, interaction.user.id);

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
      .setColor('#5865F2')
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
      .setColor('#5865F2')
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

    const scheduleId = await manager.createSchedule(event.id, { slug, name });

    return interaction.editReply({
      content: `Schedule **${name}** created!\n` +
               `- Schedule ID: \`${scheduleId}\`\n\n` +
               `Add runs with \`/schedule run add schedule_id:${scheduleId} game:"Game Name"\``
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
      .setColor('#5865F2')
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
      .setColor('#5865F2')
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
        roleToPing: pingRole?.id
      }
    );

    return interaction.editReply({
      content: `This channel is now linked to **${event.name}**!\n` +
               `Update type: ${updateType === 'ticker' ? 'Auto-updating ticker' : 'Announcements only'}`
    });
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
