/*
 * `/utilities erase` — remove a departed member's traces from the server.
 *
 * Its own top-level command rather than a group under `/admin`, for two reasons. `/admin` is at
 * Discord's 8000-character ceiling for a single command and adding this pushed it over, breaking the
 * deploy for EVERY command in the bulk PUT — so anything added there now is a liability. And the
 * name matters: `/admin mod purge` already exists and cleans messages by filter, which is a
 * different job from erasing one person's history.
 *
 * Gated to Administrator so it does not appear for members at all; the handler then requires the
 * server OWNER, because this permanently deletes other people's messages.
 */
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { handle } from './admin-purge-handler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('erase')
    .setDescription("Erase departed members' messages from this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)

    .addSubcommand(sub =>
      sub.setName('settings').setDescription('Show or change what a departure erases')
        .addBooleanOption(o => o.setName('enabled').setDescription('Erase automatically when someone leaves'))
        .addBooleanOption(o => o.setName('on-leave').setDescription('Erase when a member leaves on their own'))
        .addBooleanOption(o => o.setName('on-kick').setDescription('Erase when a member is kicked'))
        .addBooleanOption(o => o.setName('on-ban').setDescription('Erase when a member is banned'))
        .addBooleanOption(o => o.setName('include-mentions').setDescription('Also delete messages that mention them'))
        .addBooleanOption(o => o.setName('exempt-mod-logs').setDescription('Keep moderation and ban records (recommended)'))
        .addBooleanOption(o => o.setName('archive').setDescription('Archive every message before deleting it'))
        .addIntegerOption(o => o.setName('grace-minutes').setDescription('Wait this long, so a rejoin cancels it')
          .setMinValue(0).setMaxValue(1440)))

    .addSubcommand(sub =>
      sub.setName('departed').setDescription('Who has posted here but is no longer a member'))

    .addSubcommand(sub =>
      sub.setName('member').setDescription('Erase one former member. Dry run unless you confirm.')
        .addUserOption(o => o.setName('user').setDescription('The former member').setRequired(true))
        .addStringOption(o => o.setName('confirm').setDescription('Type the server name exactly to run it for real'))
        .addIntegerOption(o => o.setName('max-age-days')
          .setDescription('Only look back this many days — this server has 5 years of logs')
          .setMinValue(1).setMaxValue(3650)))

    .addSubcommand(sub =>
      sub.setName('backfill').setDescription('Erase everyone who has already left. Dry run unless you confirm.')
        .addStringOption(o => o.setName('confirm').setDescription('Type the server name exactly to run it for real'))
        .addIntegerOption(o => o.setName('max-age-days')
          .setDescription('Only look back this many days — a full 5-year scan takes hours')
          .setMinValue(1).setMaxValue(3650)))

    .addSubcommand(sub =>
      sub.setName('status').setDescription('Recent erases and how far the running one has got'))

    .addSubcommand(sub =>
      sub.setName('resume').setDescription('Pick up a run that a restart interrupted, where it stopped')
        .addIntegerOption(o => o.setName('job').setDescription('Which job — defaults to the most recent interrupted one')))

    .addSubcommand(sub =>
      sub.setName('cancel').setDescription('Stop a running erase')
        .addIntegerOption(o => o.setName('job').setDescription('The job number from /erase status').setRequired(true))),

  async execute(interaction) {
    return handle(interaction);
  },
};
