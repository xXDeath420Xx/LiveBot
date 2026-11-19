/*
 * Runs a guild's custom commands (`custom_commands`), from chat (`!rules`, via the universal command
 * bridge in core/universal-commands.js) and from a slash interaction.
 *
 * Responses are templates: variables, arguments and API calls are filled in by
 * core/custom-command-vars.js, and every API call goes through utils/safe-fetch.js (public http/https
 * only, re-checked on each redirect) and the shared per-guild / per-command rate limiter. API text is
 * cleaned and checked against core/hate-terms.js before it is inserted, and replies are sent with
 * allowedMentions limited to the people our own tokens mention (plus mentions the admin typed into
 * the template) — so neither an argument nor an API reply can ping @everyone or a role.
 *
 * {db:…} / {sdb:…} storage tokens read and write custom_commands_kv through core/custom-command-store.js:
 * per member (whoever ran the command) or server-wide. Stored values are cleaned like API text and get
 * the same allowedMentions, so they cannot ping either. The dashboard Test reads real values but saves nothing.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { safeFetch } from '../utils/safe-fetch.js';
import { containsHateTerm, rejectReason } from './hate-terms.js';
import { evilInsults, isEvilInsultUrl } from './evil-insults.js';
import { getGuildWordFilter } from './advanced-automod-manager.js';
import { logFeatureEvent } from './feature-log.js';
import {
  TEMPLATE_VARIABLES, renderTemplate, allowedMentionsFor, mentionTokensUsed, normaliseArgs, touserOf, apiLimiter,
} from './custom-command-vars.js';
import { createSqlStore, createPreviewStore } from './custom-command-store.js';

export { TEMPLATE_VARIABLES };

const kvStore = createSqlStore(pool);

const commandCache = new Map();
const missCache = new Map(); // `${guildId}:${name}` -> expiry; any prefixed sentence is looked up, so remember misses briefly
const MISS_TTL_MS = 60_000;

// Clear cache every 5 minutes
setInterval(() => { commandCache.clear(); missCache.clear(); }, 5 * 60 * 1000).unref?.();

/**
 * API plumbing for one command in one guild. `log: false` for dashboard previews.
 * evilinsult.com generate_insult.php URLs (and {evilinsult}) never reach the network: they are
 * answered from core/evil-insults.js, filtered by the bot-wide slur list plus this server's automod
 * words and patterns, exactly like /fun insult.
 */
export function apiDepsFor(guild, commandName, { log = true } = {}) {
  return {
    localAnswer: async (url) => {
      if (!isEvilInsultUrl(url)) return null;
      const filter = await getGuildWordFilter(guild?.id);
      return evilInsults.answerApi(url, { guildId: guild?.id, reject: (text) => rejectReason(text, filter) });
    },
    fetcher: (url) => safeFetch(url),
    limiter: apiLimiter,
    isBlockedText: containsHateTerm,
    onError: (code, url) => {
      let host = '';
      try { host = new URL(url).host; } catch { host = 'invalid URL'; }
      logger.debug(`[CustomCommand] API call for '${commandName}' failed: ${code} (${host})`, { guildId: guild?.id });
      if (!log || String(code).startsWith('rate_')) return;
      void logFeatureEvent(() => guild, 'system.customApiFailed', () => ({
        title: 'Custom command API call failed',
        description: `\`${commandName}\` showed "(API error)" instead of the API reply.`,
        fields: [['Host', host], ['Reason', String(code).replace(/_/g, ' ')]],
        footer: 'Shown at most once every 10 minutes per command',
        throttle: { key: `ccapi:${guild?.id}:${commandName}`, ms: 10 * 60 * 1000 },
      }));
    },
  };
}

/**
 * Fill a command's response for one invocation.
 * @param {object} p
 *   guild, channel, sender (User), senderName, target (User; mentioned or sender), targetName,
 *   mentionedName (display name of the first mention or null), args (string[]), commandName, log,
 *   preview (true: storage reads are real, writes are not saved), store (tests: a store object)
 * @returns {Promise<{ content: string, allowedMentions: object, calls: Array, storage: Array }>}
 */
export async function renderCustomResponse(response, p) {
  const args = p.args || [];
  const values = {
    'user.name': p.target.username,
    'user.mention': `<@${p.target.id}>`,
    'user.id': p.target.id,
    'user.tag': p.target.tag ?? p.target.username,
    sender: p.senderName || p.sender.username,
    'sender.mention': `<@${p.sender.id}>`,
    touser: touserOf({ mentionedName: p.mentionedName, args, senderName: p.senderName || p.sender.username }),
    'channel.name': p.channel?.name ?? 'DM',
    'channel.mention': p.channel?.id ? `<#${p.channel.id}>` : '#channel',
    'channel.id': p.channel?.id ?? '',
    'server.name': p.guild.name,
    'server.id': p.guild.id,
  };
  const baseStore = p.store || kvStore;
  const { text, calls, storage } = await renderTemplate(response, { values, args }, {
    guildId: p.guild.id,
    commandKey: p.commandKey || p.commandName,
    deps: apiDepsFor(p.guild, p.commandName, { log: p.log !== false }),
  }, {
    store: p.preview ? createPreviewStore(baseStore) : baseStore,
    guildId: p.guild.id,
    userId: p.sender.id,
    onError: (err, node) => logger.warn(`[CustomCommand] storage ${node.op} '${node.key}' failed for '${p.commandName}': ${err.message}`, { guildId: p.guild.id }),
  });
  const used = mentionTokensUsed(response);
  const ids = [used.has('user.mention') ? p.target.id : null, used.has('sender.mention') ? p.sender.id : null];
  return { content: text, allowedMentions: allowedMentionsFor(response, ids), calls, storage };
}

/** Dashboard "Test": render as the admin, in no channel, with real API calls (same guard and limits)
 * and real storage reads; storage writes are not saved. */
export async function previewCustomResponse(guild, user, response, rawArgs = '') {
  const tokens = String(rawArgs || '').split(/\s+/).filter(Boolean);
  const member = await guild.members?.fetch?.(user.id).catch(() => null);
  const senderName = member?.displayName || user.global_name || user.username;
  const sender = { id: user.id, username: user.username, tag: user.username };
  const { content, calls } = await renderCustomResponse(response, {
    guild, channel: { id: null, name: 'channel' }, sender, senderName, target: sender, mentionedName: null,
    args: normaliseArgs(tokens), commandName: 'dashboard-test', commandKey: `preview:${user.id}`, log: false, preview: true,
  });
  return { content, calls };
}

function parseIdList(value) {
  try { return value ? JSON.parse(value) : []; } catch { return []; }
}

/**
 * Count a successful run (the dashboard's Uses column). Fire-and-forget: before migration 425
 * adds the columns the UPDATE fails with ER_BAD_FIELD_ERROR, which is ignored.
 */
function recordUse(command) {
  if (!command?.id) return;
  pool.execute('UPDATE custom_commands SET use_count = use_count + 1, last_used_at = NOW() WHERE id = ?', [command.id])
    .catch(() => {});
}

/**
 * Handle custom command from interaction
 * @param {ChatInputCommandInteraction} interaction - Discord interaction object
 * @returns {Promise<boolean>} - Whether a custom command was handled
 */
export async function handleCustomCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const guildId = interaction.guild.id;
  const commandName = interaction.commandName.toLowerCase();
  let command;
  try {
    command = await findCustomCommand(guildId, commandName);
  } catch (error) {
    logger.error(`[CustomCommandHandler] lookup failed: ${error.message}`);
    return false;
  }
  if (!command) return false;
  return runCustomCommand(interaction, command);
}

/**
 * Run one custom command for a slash interaction: /tools cc run (commands/admin/cc.js) and
 * handleCustomCommand. Same checks and output as the chat path below (required roles, allowed
 * channels, role actions, template and API calls, the use counter). Reads the `user` option as the
 * target and `args` / `text` as the arguments when the command has them.
 * @returns {Promise<boolean>} true: the interaction was answered.
 */
export async function runCustomCommand(interaction, command) {
  const guildId = interaction.guild.id;
  const commandName = command.command_name;
  try {
    // Permission Checks - Required Roles
    const requiredRoles = parseIdList(command.required_roles);
    if (requiredRoles.length > 0 && !interaction.member.roles.cache.some(r => requiredRoles.includes(r.id))) {
      await interaction.reply({ content: 'You do not have the required role to use this command.', ephemeral: true });
      return true;
    }

    // Permission Checks - Allowed Channels
    const allowedChannels = parseIdList(command.allowed_channels);
    if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
      await interaction.reply({
        content: `This command can only be used in the following channels: ${allowedChannels.map(id => `<#${id}>`).join(', ')}.`,
        ephemeral: true,
      });
      return true;
    }

    const targetMember = interaction.options.getMember('user') || interaction.member;

    switch (command.action_type) {
      case 'add_role':
      case 'remove_role': {
        const role = await interaction.guild.roles.fetch(command.action_content).catch(() => null);
        if (!role || !role.editable) {
          await interaction.reply({ content: 'Error: The role configured for this command is invalid or I cannot manage it.', ephemeral: true });
          return true;
        }
        const adding = command.action_type === 'add_role';
        await targetMember.roles[adding ? 'add' : 'remove'](role);
        recordUse(command);
        await interaction.reply({
          content: `${adding ? 'Added' : 'Removed'} the ${role.name} role ${adding ? 'to' : 'from'} ${targetMember.displayName}.`,
          ephemeral: true,
        });
        return true;
      }
      case 'reply':
      default: {
        const mentioned = interaction.options.getUser('user');
        const mentionedMember = interaction.options.getMember('user');
        let rawArgs = '';
        try { rawArgs = interaction.options.getString('args') || interaction.options.getString('text') || ''; } catch { rawArgs = ''; }
        const needsApi = /\{api|customapi|urlfetch/i.test(command.response || '');
        if (needsApi) await interaction.deferReply();
        const out = await renderCustomResponse(command.response, {
          guild: interaction.guild,
          channel: interaction.channel,
          sender: interaction.user,
          senderName: interaction.member?.displayName || interaction.user.username,
          target: mentioned || interaction.user,
          mentionedName: mentioned ? (mentionedMember?.displayName || mentioned.username) : null,
          args: normaliseArgs(rawArgs.split(/\s+/)),
          commandName,
        });
        const payload = { content: out.content || '​', allowedMentions: out.allowedMentions };
        if (needsApi) await interaction.editReply(payload);
        else await interaction.reply(payload);
        recordUse(command);
        return true;
      }
    }
  } catch (error) {
    if (error.code !== 'ER_BAD_FIELD_ERROR') {
      logger.error(`[CustomCommandHandler] Error executing command '${commandName}'`, {
        error: error.message,
        stack: error.stack,
        guildId,
        commandName,
      });
    }
    const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
    await interaction[method]({
      content: 'There was an error trying to execute that custom command. It may not be configured correctly.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }
}

/** Look a custom command up (cached) by guild + name. */
export async function findCustomCommand(guildId, commandName) {
  const name = String(commandName || '').toLowerCase();
  const cacheKey = `${guildId}:${name}`;
  if (commandCache.has(cacheKey)) return commandCache.get(cacheKey);
  if ((missCache.get(cacheKey) || 0) > Date.now()) return null;

  const [rows] = await pool.execute(
    'SELECT * FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, name]);
  const command = rows[0] || null;
  if (command) commandCache.set(cacheKey, command);
  else {
    missCache.set(cacheKey, Date.now() + MISS_TTL_MS);
    if (missCache.size > 10_000) missCache.clear();
  }
  return command;
}

/**
 * Run a custom command from a plain chat message (`!rules`, `!roast @someone`).
 *
 * Custom commands were previously only reachable through `handleCustomCommand`, which
 * nothing called and which needed a slash command that was never registered — so they
 * never ran at all. The prefix bridge is what actually makes them work.
 *
 * @param {string[]} argTokens  the words typed after the command name
 * @returns {Promise<boolean>} true if a custom command with this name ran.
 */
export async function handleCustomPrefixCommand(message, commandName, argTokens = []) {
  if (!message.guild) return false;

  let command;
  try {
    command = await findCustomCommand(message.guild.id, commandName);
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') {
      logger.error(`[CustomCommand] lookup failed: ${error.message}`);
    }
    return false;
  }
  if (!command) return false;

  try {
    const requiredRoles = parseIdList(command.required_roles);
    if (requiredRoles.length && !message.member?.roles.cache.some(r => requiredRoles.includes(r.id))) {
      await message.reply({ content: 'You do not have the required role to use this command.' }).catch(() => {});
      return true;
    }

    const allowedChannels = parseIdList(command.allowed_channels);
    if (allowedChannels.length && !allowedChannels.includes(message.channelId)) {
      await message.reply({
        content: `This command can only be used in: ${allowedChannels.map(id => `<#${id}>`).join(', ')}.`,
      }).catch(() => {});
      return true;
    }

    const mentioned = message.mentions.users.first() || null;
    const targetUser = mentioned || message.author;
    const targetMember = message.mentions.members?.first() || message.member;

    switch (command.action_type) {
      case 'add_role':
      case 'remove_role': {
        const role = await message.guild.roles.fetch(command.action_content).catch(() => null);
        if (!role || !role.editable) {
          await message.reply({ content: 'That role is invalid or I cannot manage it.' }).catch(() => {});
          return true;
        }
        const adding = command.action_type === 'add_role';
        await targetMember.roles[adding ? 'add' : 'remove'](role);
        recordUse(command);
        await message.reply({
          content: `${adding ? 'Added' : 'Removed'} the ${role.name} role ${adding ? 'to' : 'from'} ${targetMember.displayName}.`,
        }).catch(() => {});
        return true;
      }
      case 'reply':
      default: {
        const nameOf = (id) => {
          const m = message.mentions.members?.get(id);
          const u = message.mentions.users.get(id);
          return m?.displayName || u?.globalName || u?.username || null;
        };
        const out = await renderCustomResponse(command.response, {
          guild: message.guild,
          channel: message.channel,
          sender: message.author,
          senderName: message.member?.displayName || message.author.globalName || message.author.username,
          target: targetUser,
          mentionedName: mentioned ? nameOf(mentioned.id) : null,
          args: normaliseArgs(argTokens, nameOf),
          commandName: command.command_name,
        });
        if (out.content) {
          await message.reply({ content: out.content, allowedMentions: out.allowedMentions }).catch(() => {});
        }
        // A reply that only saves ({db:set:…}) sends nothing but still ran.
        if (out.content || out.storage?.length) recordUse(command);
        return true;
      }
    }
  } catch (error) {
    logger.error(`[CustomCommand] '${commandName}' failed: ${error.message}`, { guildId: message.guild.id });
    await message.reply({ content: 'That custom command is not configured correctly.' }).catch(() => {});
    return true;
  }
}

/**
 * Invalidate command cache for a specific command
 * @param {string} guildId - Guild ID
 * @param {string} commandName - Command name
 */
export function invalidateCommandCache(guildId, commandName) {
  const cacheKey = `${guildId}:${String(commandName || '').toLowerCase()}`;
  commandCache.delete(cacheKey);
  missCache.delete(cacheKey);
}
