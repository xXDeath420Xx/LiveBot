// commands/media/movie.js
import {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits,
} from 'discord.js';
import * as jf from '../../utils/jellyfin.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig, canControl, resolveWatchPartyStart } from '../../handlers/cinema/state.js';
// Queue lives in the cinema service now — skip/queue/stop delegate to it.
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
        `INSERT INTO cinema_config (guild_id, enabled, control_role_id) VALUES (?,?,?)
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
    if (sub === 'open') {
      return interaction.reply({ content: 'This server plays films as a Go Live stream. An admin can switch Cinema to Watch Together on the dashboard (Music & voice, then Cinema).', ephemeral: true });
    }
    if (!(await cinema.healthy())) {
      return interaction.reply({ content: 'Cinema is temporarily unavailable.', ephemeral: true });
    }

    if (sub === 'status') {
      const st = await getActiveState();
      const here = st && st.guild_id === interaction.guildId;
      return interaction.reply({
        content: here ? `🎬 **${st.item_name}** — ${st.status} in <#${st.voice_channel_id}>`
                      : 'Nothing is playing.',
        ephemeral: true,
      });
    }

    if (sub === 'stop') {
      const st = await getActiveState();
      if (!st || st.guild_id !== interaction.guildId) {
        return interaction.reply({ content: 'No movie is playing in this server.', ephemeral: true });
      }
      if (!canControl(interaction.member, st, config)) {
        return interaction.reply({ content: 'Only the host or a mod can stop playback.', ephemeral: true });
      }
      // stop() in the service tears down playback AND clears its internal queue.
      await cinema.stop();
      return interaction.reply({ content: '⏹ Stopped.', ephemeral: true });
    }

    if (sub === 'skip') {
      const st = await getActiveState();
      if (!st || st.guild_id !== interaction.guildId) {
        return interaction.reply({ content: 'Nothing is playing in this server.', ephemeral: true });
      }
      if (!canControl(interaction.member, st, config)) {
        return interaction.reply({ content: 'Only the host or a mod can skip.', ephemeral: true });
      }
      if (Number(st.queue_remaining || 0) < 1) {
        return interaction.reply({ content: 'Nothing queued after the current item.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const res = await cinema.next();
      if (res.data?.done) return interaction.editReply({ content: '⏭ End of queue.' });
      if (res.ok) return interaction.editReply({ content: `⏭ Skipped — now playing **${res.data?.item?.itemName || 'next episode'}**` });
      return interaction.editReply({ content: '⏭ Skip failed — try again.' });
    }

    if (sub === 'queue') {
      // Read live queue state from the cinema service.
      const s = (await cinema.status()).data || {};
      if (!s.busy) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      const remaining = Number(s.queueRemaining || 0);
      if (remaining < 1) {
        return interaction.reply({ content: `▶ Now playing **${s.session?.itemName || '?'}** — no more episodes queued.`, ephemeral: true });
      }
      return interaction.reply({
        content: `▶ Now playing **${s.session?.itemName || '?'}**\n⏭ Up next: **${s.upNext?.itemName || '—'}**\n📺 ${remaining} episode(s) remaining in the queue.`,
        ephemeral: true,
      });
    }

    // sub === 'play'
    // Host role and voice channel (own, else the server's default) — checked again when playback starts.
    const start = await resolveWatchPartyStart(interaction.member, interaction.guild, { cinema: config });
    if (!start.ok) {
      return interaction.reply({ content: start.error, ephemeral: true });
    }
    const existing = await getActiveState();
    if (existing) {
      return interaction.reply({
        content: `🎬 Cinema is busy — **${existing.item_name}** is playing in <#${existing.voice_channel_id}>.`,
        ephemeral: true,
      });
    }

    const itemId = interaction.options.getString('title');
    // 'title' carries the Jellyfin id from autocomplete, but a client can send any
    // string — reject non-ids before they reach a URL path / the ffmpeg filtergraph.
    if (!jf.isValidItemId(itemId)) {
      return interaction.reply({ content: 'Pick a title from the suggestions.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    // Route the chosen item to the right picker (series → season → episode →
    // tracks, or movie/episode → tracks). Shared with the theater panel search.
    const { presentSelection } = await import('../../handlers/cinema/panel.js');
    await presentSelection(interaction, itemId);
  },
};
