/*
 * /ai — opt this server in to the @mention AI assistant, and manage its memory and personas.
 *
 * Off by default everywhere. An AI that talks in chat and can take actions is not something to
 * switch on for people without asking, so it is per-guild and admin-only (Manage Server).
 *
 * Members do not need this command to protect their own data: "@bot forget" wipes their own
 * conversation memory in a channel, and opting out of message logging stops it being stored.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import {
  getConfig, setEnabled, isConfigured,
  setMemorySettings, clearMemory, countMemory,
  getPersona, setPersona, clearPersona, listPersonas,
} from '../../core/ai-assistant.js';
import { clampMemorySettings, MEMORY_LIMITS, PERSONA_LIMITS } from '../../core/ai-memory-utils.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread,
  ChannelType.PrivateThread, ChannelType.GuildVoice];

const MODE_LABEL = {
  off: 'Off — every question stands alone',
  user: 'Per member — each person\'s own recent exchanges in that channel',
  channel: 'Shared — one conversation per channel, everyone sees the context',
};

const data = new SlashCommandBuilder()
  .setName('ai')
  .setDescription('Configure the @mention AI assistant')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('enable').setDescription('Turn the AI assistant on in this server')
    .addBooleanOption(o => o.setName('actions').setDescription('Allow it to DO things (play music, purge). Default: true')))
  .addSubcommand(s => s.setName('disable').setDescription('Turn the AI assistant off (also deletes its saved conversations)'))
  .addSubcommand(s => s.setName('status').setDescription('Show whether it is on, today\'s usage, memory and personas'))
  .addSubcommand(s => s.setName('limit').setDescription('Set the daily request cap for this server')
    .addIntegerOption(o => o.setName('per_day').setDescription('Requests per day (1-5000)').setRequired(true)))
  .addSubcommand(s => s.setName('memory').setDescription('How much of the conversation the assistant remembers')
    .addStringOption(o => o.setName('mode').setDescription('Who shares a conversation').setRequired(true)
      .addChoices(
        { name: 'Per member (private, default)', value: 'user' },
        { name: 'Shared per channel', value: 'channel' },
        { name: 'Off (stateless)', value: 'off' }))
    .addIntegerOption(o => o.setName('turns').setDescription(`Exchanges remembered (${MEMORY_LIMITS.minTurns}-${MEMORY_LIMITS.maxTurns}, default ${MEMORY_LIMITS.defaultTurns})`)
      .setMinValue(MEMORY_LIMITS.minTurns).setMaxValue(MEMORY_LIMITS.maxTurns))
    .addIntegerOption(o => o.setName('minutes').setDescription(`Forget after this many idle minutes (${MEMORY_LIMITS.minTtlMinutes}-${MEMORY_LIMITS.maxTtlMinutes}, default ${MEMORY_LIMITS.defaultTtlMinutes})`)
      .setMinValue(MEMORY_LIMITS.minTtlMinutes).setMaxValue(MEMORY_LIMITS.maxTtlMinutes)))
  .addSubcommand(s => s.setName('forget').setDescription('Delete saved AI conversations')
    .addChannelOption(o => o.setName('channel').setDescription('Only this channel (default: this channel)').addChannelTypes(...TEXT_CHANNELS))
    .addUserOption(o => o.setName('user').setDescription('Only this member\'s conversations'))
    .addBooleanOption(o => o.setName('whole_server').setDescription('Every channel in the server (ignores channel)')))
  .addSubcommand(s => s.setName('persona').setDescription('Give the assistant a custom persona in one channel')
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'Set', value: 'set' }, { name: 'View', value: 'view' }, { name: 'Clear', value: 'clear' }))
    .addChannelOption(o => o.setName('channel').setDescription('Channel (default: this channel)').addChannelTypes(...TEXT_CHANNELS))
    .addStringOption(o => o.setName('prompt').setDescription('Persona: name, voice, tone, focus (for Set)')
      .setMinLength(PERSONA_LIMITS.minChars).setMaxLength(PERSONA_LIMITS.maxChars)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  // Cleanup must work even if the provider key is gone — people may want their data deleted.
  if (!isConfigured() && !['disable', 'forget', 'persona', 'status'].includes(sub)) {
    return interaction.reply({ content: 'No AI provider key is configured on this bot.', ...EPHEMERAL });
  }

  try {
    if (sub === 'enable') {
      const actions = interaction.options.getBoolean('actions');
      await setEnabled(guildId, true, { allowActions: actions === null ? true : actions });
      const cfg = await getConfig(guildId);
      const mem = clampMemorySettings(cfg);
      return interaction.reply({
        content: `✅ AI assistant **enabled**. Mention me and ask anything — e.g. \`@${interaction.client.user.username} what's the weather today?\`\n`
          + `Actions (playing music, purging): **${cfg.allow_actions ? 'allowed' : 'disabled'}**. `
          + `Daily cap: **${cfg.daily_cap}**.\n`
          + `Memory: **${MODE_LABEL[mem.mode]}**${mem.mode !== 'off' ? ` (last ${mem.turns} exchanges, ${mem.ttlMinutes} min)` : ''}. Change it with \`/manage ai memory\`.\n`
          + '*Actions always respect the permissions of whoever is asking — it can never do more than they can. '
          + 'Anyone can say "@me forget" to wipe their own conversation.*',
        ...EPHEMERAL,
      });
    }

    if (sub === 'disable') {
      await setEnabled(guildId, false);
      let cleared = 0;
      try { cleared = await clearMemory({ guildId }); }
      catch (e) { logger.error(`[AI] could not clear memory on disable for ${guildId}: ${e.message}`, { category: 'ai' }); }
      return interaction.reply({
        content: '🛑 AI assistant **disabled**. I will ignore mentions that are not commands.'
          + (cleared ? ` Deleted **${cleared}** saved conversation message(s).` : ''),
        ...EPHEMERAL,
      });
    }

    if (sub === 'limit') {
      const n = Math.max(1, Math.min(5000, interaction.options.getInteger('per_day', true)));
      await pool.execute('UPDATE ai_config SET daily_cap = ? WHERE guild_id = ?', [n, guildId]);
      return interaction.reply({ content: `Daily cap set to **${n}** requests.`, ...EPHEMERAL });
    }

    if (sub === 'memory') {
      const mode = interaction.options.getString('mode', true);
      const turns = interaction.options.getInteger('turns');
      const minutes = interaction.options.getInteger('minutes');
      const saved = await setMemorySettings(guildId, { mode, turns: turns ?? undefined, ttlMinutes: minutes ?? undefined });
      logger.info(`[AI] memory set to ${saved.mode}/${saved.turns}/${saved.ttlMinutes}m in ${guildId} by ${interaction.user.id}`, { category: 'ai' });
      return interaction.reply({
        content: `🧠 Memory: **${MODE_LABEL[saved.mode]}**`
          + (saved.mode !== 'off' ? `\nRemembers the last **${saved.turns}** exchange(s) for **${saved.ttlMinutes}** minute(s).` : '')
          + (saved.cleared ? `\nDeleted **${saved.cleared}** saved message(s) that no longer apply.` : ''),
        ...EPHEMERAL,
      });
    }

    if (sub === 'forget') {
      const whole = interaction.options.getBoolean('whole_server') === true;
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const user = interaction.options.getUser('user');
      const n = await clearMemory({
        guildId,
        channelId: whole ? null : channel.id,
        userId: user?.id || null,
      });
      logger.info(`[AI] ${interaction.user.id} cleared ${n} memory row(s) in ${guildId}`, {
        category: 'ai', channelId: whole ? 'all' : channel.id, targetUser: user?.id || 'all',
      });
      const scope = `${user ? `${user}'s` : 'all'} saved conversations ${whole ? 'in this server' : `in ${channel}`}`;
      return interaction.reply({
        content: `🧹 Deleted ${scope} (**${n}** message(s)).`,
        allowedMentions: { parse: [] },
        ...EPHEMERAL,
      });
    }

    if (sub === 'persona') {
      const action = interaction.options.getString('action', true);
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      if (action === 'set') {
        const prompt = interaction.options.getString('prompt');
        if (!prompt) {
          return interaction.reply({ content: 'Give the persona in the `prompt` option — e.g. *"You are Captain Byte, a cheerful pirate who answers in pirate speak and loves retro games."*', ...EPHEMERAL });
        }
        const result = await setPersona(guildId, channel.id, prompt, interaction.user.id);
        if (!result.ok) return interaction.reply({ content: `❌ ${result.error}`, ...EPHEMERAL });
        logger.info(`[AI] persona set in ${channel.id} (${guildId}) by ${interaction.user.id}`, { category: 'ai' });
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle('🎭 Persona saved')
            .setDescription(`Mentions in ${channel} now use this persona:\n>>> ${result.persona.slice(0, 1500)}`)
            .setFooter({ text: 'It changes voice and style only — the assistant\'s rules, safety and permission checks still apply.' })],
          ...EPHEMERAL,
        });
      }

      if (action === 'clear') {
        const removed = await clearPersona(channel.id);
        return interaction.reply({
          content: removed ? `🎭 Persona removed from ${channel} — back to the default assistant.` : `${channel} has no custom persona.`,
          ...EPHEMERAL,
        });
      }

      const persona = await getPersona(channel.id);
      return interaction.reply({
        content: persona ? `🎭 Persona in ${channel}:\n>>> ${persona.slice(0, 1800)}` : `${channel} uses the default assistant (no persona).`,
        ...EPHEMERAL,
      });
    }

    // status
    const cfg = await getConfig(guildId);
    const usedToday = cfg && cfg.usage_date && new Date(cfg.usage_date).toDateString() === new Date().toDateString()
      ? cfg.used_today : 0;
    const mem = clampMemorySettings(cfg || {});
    let stored = 0;
    let personas = [];
    try {
      stored = await countMemory(guildId);
      personas = await listPersonas(guildId);
    } catch (e) {
      logger.warn(`[AI] status lookups failed for ${guildId}: ${e.message}`, { category: 'ai' });
    }
    const embed = new EmbedBuilder()
      .setColor(cfg?.enabled ? 0x2ecc71 : 0x95a5a6)
      .setTitle('🤖 AI Assistant')
      .addFields(
        { name: 'Status', value: cfg?.enabled ? 'Enabled' : 'Disabled', inline: true },
        { name: 'Actions', value: cfg?.allow_actions ? 'Allowed' : 'Read-only', inline: true },
        { name: 'Today', value: `${usedToday} / ${cfg?.daily_cap ?? 500}`, inline: true },
        {
          name: 'Memory',
          value: `${MODE_LABEL[mem.mode]}${mem.mode !== 'off' ? `\n${mem.turns} exchanges · ${mem.ttlMinutes} min · ${stored} message(s) stored` : ''}`,
          inline: false,
        },
        {
          name: `Personas (${personas.length})`,
          value: personas.length
            ? personas.slice(0, 10).map(p => `<#${p.channel_id}> — ${String(p.preview).replace(/\s+/g, ' ').slice(0, 80)}`).join('\n').slice(0, 1024)
            : 'None — set one with `/manage ai persona action:Set`',
          inline: false,
        },
      )
      .setFooter({ text: 'Mention the bot with a question. Existing commands still take priority. Members can say "@bot forget".' });
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  } catch (error) {
    logger.error(`[AI] /ai ${sub} failed in ${guildId}: ${error.message}`, { category: 'ai', stack: error.stack });
    const msg = { content: 'Something went wrong saving that. Please try again.', ...EPHEMERAL };
    if (interaction.replied || interaction.deferred) return interaction.followUp(msg).catch(() => {});
    return interaction.reply(msg).catch(() => {});
  }
}

export { data, execute };
export default { category: 'tools', data, execute };
