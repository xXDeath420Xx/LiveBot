// commands/media/watch.js
// Alias for /movie — same command shape, same handlers, but registered under
// the more inclusive name /watch since /movie now covers TV episodes and whole
// shows too. Both commands stay usable so muscle memory keeps working.
import { SlashCommandBuilder } from 'discord.js';
import movie from './movie.js';

export default {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Watch a movie or TV episode from the Jellyfin library together in voice')
    .addSubcommand((s) => s.setName('play').setDescription('Start a movie, TV episode, or pick a season/episode from a show')
      .addStringOption((o) => o.setName('title').setDescription('Search the library — movies, shows, or specific episodes')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the current playback (also clears any queued episodes)'))
    .addSubcommand((s) => s.setName('skip').setDescription('Skip to the next queued episode (only when a season/queue is playing)'))
    .addSubcommand((s) => s.setName('queue').setDescription('Show queued-up episodes'))
    .addSubcommand((s) => s.setName('status').setDescription('Show what is playing'))
    .addSubcommand((s) => s.setName('config').setDescription('Enable Cinema and set the control role (admin)')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable in this server').setRequired(true))
      .addRoleOption((o) => o.setName('control_role').setDescription('Role allowed to control playback')))
    .addSubcommandGroup((g) => g.setName('panel').setDescription('Persistent theater control panel')
      .addSubcommand((s) => s.setName('create').setDescription('Post an auto-updating theater panel in this channel'))
      .addSubcommand((s) => s.setName('delete').setDescription('Remove the theater panel'))),

  // Reuse /movie's handlers verbatim — the subcommand names, options, and flows
  // are identical, so autocomplete + execute don't care which command name Discord
  // used to invoke them.
  autocomplete: movie.autocomplete,
  execute: movie.execute,
};
