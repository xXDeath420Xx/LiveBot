// commands/media/movie.js
import {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits,
} from 'discord.js';
import * as jf from '../../utils/jellyfin.js';
import { getConfig } from '../../handlers/cinema/state.js';
import pool from '../../utils/db.js';

export default {
  data: new SlashCommandBuilder()
    .setName('movie')
    .setDescription('Watch a movie or TV episode from the Jellyfin library together in voice')
    .addSubcommand((s) => s.setName('play').setDescription('Start a movie, TV episode, or pick a season/episode from a show')
      .addStringOption((o) => o.setName('title').setDescription('Search the library — movies, shows, or specific episodes')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the current playback (also clears any queued episodes)'))
    .addSubcommand((s) => s.setName('skip').setDescription('Skip to the next queued episode (only when a season/queue is playing)'))
    .addSubcommand((s) => s.setName('queue').setDescription('Show queued-up episodes'))
    .addSubcommand((s) => s.setName('status').setDescription('Show what is playing'))
    .addSubcommand((s) => s.setName('open').setDescription('Open Watch Together (the Discord Activity) in your voice channel'))
    .addSubcommand((s) => s.setName('config').setDescription('Enable Cinema and set the control role (admin)')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable in this server').setRequired(true))
      .addRoleOption((o) => o.setName('control_role').setDescription('Role allowed to control playback')))
    .addSubcommandGroup((g) => g.setName('panel').setDescription('Persistent theater control panel')
      .addSubcommand((s) => s.setName('create').setDescription('Post an auto-updating theater panel in this channel'))
      .addSubcommand((s) => s.setName('delete').setDescription('Remove the theater panel'))),

  async autocomplete(interaction) {
    const term = interaction.options.getFocused();
    if (!term || term.length < 2) return interaction.respond([]);
    try {
      const items = await jf.search(term);
      await interaction.respond(items.slice(0, 25).map((i) => ({
        name: i.name.slice(0, 100), value: i.id,
      })));
    } catch { await interaction.respond([]); }
  },

  async execute(interaction) {
    // Theater panel management (subcommand group) — handled before the cinema
    // enable/health checks so a panel can be created even when idle.
    if (interaction.options.getSubcommandGroup(false) === 'panel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'Manage Server required to manage the theater panel.', ephemeral: true });
      }
      const { handleTheaterPanelCreate, handleTheaterPanelDelete } = await import('../../handlers/cinema/theater-panel.js');
      const psub = interaction.options.getSubcommand();
      return psub === 'create' ? handleTheaterPanelCreate(interaction) : handleTheaterPanelDelete(interaction);
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'config') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'Manage Server required.', ephemeral: true });
      }
      const enabled = interaction.options.getBoolean('enabled') ? 1 : 0;
      const role = interaction.options.getRole('control_role');
      await pool.execute(
        `INSERT INTO cinema_config (guild_id, enabled, control_role_id, watch_mode) VALUES (?,?,?,'activity')
         ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), control_role_id=VALUES(control_role_id)`,
        [interaction.guildId, enabled, role?.id ?? null]);
      return interaction.reply({ content: `Cinema ${enabled ? 'enabled' : 'disabled'}${role ? `, control role <@&${role.id}>` : ''}.`, ephemeral: true });
    }

    const config = await getConfig(interaction.guildId);
    if (!config?.enabled) {
      return interaction.reply({ content: 'Cinema is not enabled in this server.', ephemeral: true });
    }

    // Watch Together (the Discord Activity, docs/activities.md) replaces the Go Live stream in a server whose Cinema
    // page says so: status/stop/open here, 'play' runs the usual pickers and their Start button launches the Activity.
    if (config.watch_mode === 'activity') {
      const { handleMovieActivity } = await import('../../handlers/activities/launch.js');
      const done = await handleMovieActivity(interaction, sub, config);
      if (done !== null) return done;
      const pick = interaction.options.getString('title');
      if (!jf.isValidItemId(pick)) return interaction.reply({ content: 'Pick a title from the suggestions.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const { presentSelection: present } = await import('../../handlers/cinema/panel.js');
      return present(interaction, pick);
    }
    // Not reached: getConfig always says 'activity' since the Go Live stream (the CertiFried-Cinema selfbot) was
    // retired on 2026-11-20. Kept as a plain answer in case that ever changes.
    return interaction.reply({ content: 'Cinema plays films with Watch Together now. Join a voice channel and use `/movie open`.', ephemeral: true });
  },
};
