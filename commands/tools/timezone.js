import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
  resolveZone, searchZones, formatIn,
  getUserSettings, setUserZone, setUserPrefs, clearUser,
  getGuildConfig, setGuildConfig,
  getGuildList, addGuildListZone, removeGuildListZone,
} from '../../core/timezone-manager.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function zoneOption(o, required = true) {
  return o.setName('zone')
    .setDescription('IANA zone or abbreviation (e.g. America/New_York, PST)')
    .setRequired(required)
    .setAutocomplete(true);
}

export default {
  category: 'tools',
  data: new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('Time zones — convert times mentioned in chat')
    .addSubcommand(s => s.setName('set')
      .setDescription('Set your time zone')
      .addStringOption(o => zoneOption(o)))
    .addSubcommand(s => s.setName('me')
      .setDescription('View or change your own time settings')
      .addStringOption(o => o.setName('clock').setDescription('12- or 24-hour display')
        .addChoices({ name: '12-hour', value: '12' }, { name: '24-hour', value: '24' }))
      .addBooleanOption(o => o.setName('private')
        .setDescription('Hide your zone name from others (times still convert)'))
      .addBooleanOption(o => o.setName('reset').setDescription('Delete your time zone entirely')))
    .addSubcommand(s => s.setName('time')
      .setDescription('What time is it for a user, a zone, or this server?')
      .addUserOption(o => o.setName('user').setDescription('Whose local time?'))
      .addStringOption(o => zoneOption(o, false)))
    .addSubcommand(s => s.setName('server')
      .setDescription('[Admin] Configure this server')
      .addStringOption(o => o.setName('autodetect')
        .setDescription('What to do when someone mentions a time')
        .addChoices(
          { name: 'react — add a 🕰️ people can click', value: 'react' },
          { name: 'list — reply with the server zone board', value: 'list' },
          { name: 'off — disable detection', value: 'off' }))
      .addStringOption(o => zoneOption(o, false).setDescription('Fallback zone for users who haven\'t set one'))
      .addStringOption(o => o.setName('clock').setDescription('12- or 24-hour display')
        .addChoices({ name: '12-hour', value: '12' }, { name: '24-hour', value: '24' })))
    .addSubcommandGroup(g => g.setName('list')
      .setDescription('[Admin] The server zone board (max 10)')
      .addSubcommand(s => s.setName('show').setDescription('Show the board and current times'))
      .addSubcommand(s => s.setName('add').setDescription('Add a zone to the board')
        .addStringOption(o => zoneOption(o)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a zone from the board')
        .addStringOption(o => zoneOption(o)))),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const zones = searchZones(focused, 25);
    await interaction.respond(zones.map(z => ({ name: z, value: z }))).catch(() => {});
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'list') return handleList(interaction, sub);
    if (sub === 'set') return handleSet(interaction);
    if (sub === 'me') return handleMe(interaction);
    if (sub === 'time') return handleTime(interaction);
    if (sub === 'server') return handleServer(interaction);
  },
};

function badZone(interaction, raw) {
  const guesses = searchZones(raw, 5);
  return interaction.reply({
    content: `**${raw}** isn't a time zone I recognize.` +
      (guesses.length ? `\nDid you mean: ${guesses.map(z => `\`${z}\``).join(', ')}?` : ''),
    ...EPHEMERAL,
  });
}

async function handleSet(interaction) {
  const raw = interaction.options.getString('zone');
  const zone = resolveZone(raw);
  if (!zone) return badZone(interaction, raw);

  await setUserZone(interaction.user.id, zone);
  const me = await getUserSettings(interaction.user.id);
  return interaction.reply({
    content: `✅ Your time zone is **${zone}** — it's **${formatIn(new Date(), zone, me?.time_format)}** for you.\n` +
      `When someone mentions a time here, click the 🕰️ and I'll DM you the conversion.`,
    ...EPHEMERAL,
  });
}

async function handleMe(interaction) {
  if (interaction.options.getBoolean('reset')) {
    await clearUser(interaction.user.id);
    return interaction.reply({ content: '🗑️ Your time zone and settings are deleted.', ...EPHEMERAL });
  }

  const current = await getUserSettings(interaction.user.id);
  if (!current) {
    return interaction.reply({ content: 'You haven\'t set a time zone yet — run **/timezone set**.', ...EPHEMERAL });
  }

  const clock = interaction.options.getString('clock');
  const priv = interaction.options.getBoolean('private');
  if (clock !== null || priv !== null) {
    await setUserPrefs(interaction.user.id, {
      timeFormat: clock ?? undefined,
      privateMode: priv ?? undefined,
    });
  }

  const s = await getUserSettings(interaction.user.id);
  const embed = new EmbedBuilder()
    .setTitle('🕰️ Your Time Settings')
    .setColor(0x1591FD)
    .addFields(
      { name: 'Time Zone', value: s.time_zone, inline: true },
      { name: 'Clock', value: `${s.time_format}-hour`, inline: true },
      { name: 'Private Mode', value: s.private_mode ? 'On — zone hidden' : 'Off', inline: true },
      { name: 'Your Local Time', value: formatIn(new Date(), s.time_zone, s.time_format) },
    );
  return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

async function handleTime(interaction) {
  const rawZone = interaction.options.getString('zone');
  const target = interaction.options.getUser('user');
  const viewer = await getUserSettings(interaction.user.id);
  const fmt = viewer?.time_format || '12';
  const now = new Date();

  if (rawZone) {
    const zone = resolveZone(rawZone);
    if (!zone) return badZone(interaction, rawZone);
    return interaction.reply({ content: `🕰️ **${zone}** — ${formatIn(now, zone, fmt)}`, ...EPHEMERAL });
  }

  if (target) {
    const s = await getUserSettings(target.id);
    if (!s?.time_zone) {
      return interaction.reply({ content: `**${target.username}** hasn't set a time zone.`, ...EPHEMERAL });
    }
    const where = s.private_mode ? '' : ` (${s.time_zone})`;
    return interaction.reply({
      content: `🕰️ It's **${formatIn(now, s.time_zone, fmt)}** for **${target.username}**${where}.`,
      ...EPHEMERAL,
    });
  }

  // No args: this server's zone board, else the server zone, else your own.
  if (interaction.guild) {
    const cfg = await getGuildConfig(interaction.guild.id);
    const zones = await getGuildList(interaction.guild.id);
    if (zones.length) {
      const body = zones.map(z => `• **${z}** — ${formatIn(now, z, cfg?.time_format || fmt)}`).join('\n');
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle(`🕰️ Times in ${interaction.guild.name}`)
          .setColor(0x1591FD).setDescription(body)],
        ...EPHEMERAL,
      });
    }
    if (cfg?.time_zone) {
      return interaction.reply({
        content: `🕰️ **${interaction.guild.name}** — ${formatIn(now, cfg.time_zone, cfg.time_format)}`, ...EPHEMERAL,
      });
    }
  }

  if (viewer?.time_zone) {
    return interaction.reply({ content: `🕰️ **${formatIn(now, viewer.time_zone, fmt)}**`, ...EPHEMERAL });
  }
  return interaction.reply({
    content: 'No zone to show. Set yours with **/timezone set**, or ask an admin to run **/timezone server**.',
    ...EPHEMERAL,
  });
}

async function handleServer(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'You need **Manage Server** to change this.', ...EPHEMERAL });
  }

  const autoDetect = interaction.options.getString('autodetect');
  const rawZone = interaction.options.getString('zone');
  const clock = interaction.options.getString('clock');

  let zone;
  if (rawZone) {
    zone = resolveZone(rawZone);
    if (!zone) return badZone(interaction, rawZone);
  }

  if (autoDetect || zone || clock) {
    await setGuildConfig(interaction.guild.id, {
      enabled: true, autoDetect: autoDetect ?? undefined,
      timeZone: zone ?? undefined, timeFormat: clock ?? undefined,
    });
  }

  const cfg = await getGuildConfig(interaction.guild.id);
  if (!cfg) {
    return interaction.reply({
      content: 'Time detection is **off** here. Turn it on with `/timezone server autodetect:react`.',
      ...EPHEMERAL,
    });
  }

  const modes = {
    react: 'React with 🕰️ — members click it to get a DM with the conversion',
    list: 'Reply in-channel with the server zone board',
    off: 'Disabled',
  };
  const embed = new EmbedBuilder()
    .setTitle('🕰️ Server Time Settings')
    .setColor(0x1591FD)
    .addFields(
      { name: 'Auto-Detect', value: modes[cfg.auto_detect] },
      { name: 'Fallback Zone', value: cfg.time_zone || '*none — members must run `/timezone set`*', inline: true },
      { name: 'Clock', value: `${cfg.time_format}-hour`, inline: true },
    );
  if (cfg.auto_detect === 'list') {
    const zones = await getGuildList(interaction.guild.id);
    embed.addFields({ name: 'Zone Board', value: zones.length ? zones.map(z => `• ${z}`).join('\n') : '*empty — add zones with `/timezone list add`*' });
  }
  return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

async function handleList(interaction, sub) {
  const now = new Date();

  if (sub === 'show') {
    const zones = await getGuildList(interaction.guild.id);
    const cfg = await getGuildConfig(interaction.guild.id);
    if (!zones.length) {
      return interaction.reply({ content: 'The zone board is empty. Add one with `/timezone list add`.', ...EPHEMERAL });
    }
    const body = zones.map(z => `• **${z}** — ${formatIn(now, z, cfg?.time_format || '12')}`).join('\n');
    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle(`🕰️ Zone Board — ${interaction.guild.name}`)
        .setColor(0x1591FD).setDescription(body).setFooter({ text: `${zones.length}/10 zones` })],
      ...EPHEMERAL,
    });
  }

  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'You need **Manage Server** to change the zone board.', ...EPHEMERAL });
  }

  const raw = interaction.options.getString('zone');
  const zone = resolveZone(raw);
  if (!zone) return badZone(interaction, raw);

  if (sub === 'add') {
    const res = await addGuildListZone(interaction.guild.id, zone);
    if (!res.ok) {
      return interaction.reply({
        content: res.reason === 'full'
          ? 'The zone board is full (10 max). Remove one first.'
          : `**${zone}** is already on the board.`,
        ...EPHEMERAL,
      });
    }
    return interaction.reply({ content: `✅ Added **${zone}** — ${formatIn(now, zone)}`, ...EPHEMERAL });
  }

  const removed = await removeGuildListZone(interaction.guild.id, zone);
  return interaction.reply({
    content: removed ? `🗑️ Removed **${zone}** from the board.` : `**${zone}** wasn't on the board.`,
    ...EPHEMERAL,
  });
}
