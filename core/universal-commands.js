/*
 * Universal command bridge — reach every slash command from plain chat.
 *
 *   !play <url>            ->  /music play query:<url>
 *   ?ban @user spamming    ->  /moderation ban user:@user reason:spamming
 *   $cat inventory         ->  /cat inventory
 *   @CertiFried play <url> ->  /music play query:<url>
 *
 * Nothing here is hand-maintained per command: the arg parser is generated from each
 * command's own SlashCommandBuilder schema, so a new slash command is instantly
 * reachable by prefix too.
 *
 * Silence on no-match is a hard rule. `?` and `.` are legal prefixes, so "..." and
 * "?? what" reach this code constantly; an "unknown command" reply would be spam.
 */
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { MessageContextAdapter, ModalUnsupportedError } from './message-context-adapter.js';
import configCache from '../utils/configCache.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isSuperAdmin } from '../utils/constants.js';

// Kept identical to events/interactionCreate.js — categories that need ManageGuild when
// a guild has no explicit restriction row.
const ADMIN_CATEGORIES = new Set(['admin', 'streams']);

// Discord ApplicationCommandOptionType
const SUB = 1, GROUP = 2, STRING = 3, INTEGER = 4, BOOLEAN = 5,
  USER = 6, CHANNEL = 7, ROLE = 8, MENTIONABLE = 9, NUMBER = 10, ATTACHMENT = 11;

export const DEFAULT_PREFIXES = ['!', '?', '$', '.'];

/**
 * Shorthands for paths people actually type. Also the tie-breaker when a bare
 * subcommand name is ambiguous (`play` exists on /music, /spotify and /soundboard).
 * `/music play` already routes Spotify URLs through go-librespot, so it's the right target.
 */
const CURATED = Object.freeze({
  play: 'music play', skip: 'music skip', stop: 'music stop', pause: 'music pause',
  resume: 'music resume', queue: 'music queue', np: 'music nowplaying',
  nowplaying: 'music nowplaying', loop: 'music loop', volume: 'music volume',
  vol: 'music volume', shuffle: 'music shuffle', lyrics: 'music lyrics',
  seek: 'music seek', voteskip: 'music voteskip', forceskip: 'music forceskip',
  search: 'music search', disconnect: 'music stop', leave: 'music stop',
  p: 'music play', s: 'music skip', q: 'music queue',
});

/** name -> { command, group, sub, options } */
let paths = new Map();
/** bare subcommand name -> full path, only when unambiguous */
let flat = new Map();
/** top-level name -> { command, hasSubs, subs: string[] } */
let tops = new Map();
/**
 * bare GROUP name -> { prefix: "engage birthday", subs: [...] }, only when unambiguous.
 *
 * Without this, a whole subsystem is unreachable from chat. `/engage birthday list` lives under
 * the group `birthday`, and nobody types `!engage birthday list` — they type `!birthday list`.
 * Groups are what make a command's *subsystems* addressable.
 */
let groups = new Map();
// Keyed on the Collection itself, not the bot id: custom bots share one `sharedCommands`
// collection, so keying per-bot would rebuild the whole index on every alternating message.
let indexedCollection = null;
let indexedSize = 0;

const isSubLike = o => o.type === SUB || o.type === GROUP;

/** Build (or rebuild) the lookup tables from a client's command collection. */
export function buildIndex(client) {
  paths = new Map(); flat = new Map(); tops = new Map(); groups = new Map();
  const ambiguous = new Set();
  const ambiguousGroups = new Set();

  for (const [name, command] of client.commands ?? []) {
    let json;
    try { json = command.data.toJSON(); } catch { continue; }
    const opts = json.options ?? [];
    const subs = [];

    const addPath = (path, group, sub, options) => {
      paths.set(path, { command, group, sub, options: options ?? [] });
      if (sub) {
        subs.push(path.slice(name.length + 1));
        if (flat.has(sub) || CURATED[sub]) ambiguous.add(sub);
        else flat.set(sub, path);
      }
    };

    if (!opts.some(isSubLike)) {
      addPath(name, null, null, opts);
    } else {
      for (const o of opts) {
        if (o.type === GROUP) {
          const groupSubs = [];
          for (const s of o.options ?? []) {
            addPath(`${name} ${o.name} ${s.name}`, o.name, s.name, s.options);
            groupSubs.push(s.name);
          }
          if (groups.has(o.name)) ambiguousGroups.add(o.name);
          else groups.set(o.name, { prefix: `${name} ${o.name}`, subs: groupSubs });
        } else if (o.type === SUB) {
          addPath(`${name} ${o.name}`, null, o.name, o.options);
        }
      }
    }
    tops.set(name, { command, hasSubs: subs.length > 0, subs });
  }

  // A bare name that maps to several commands must not silently pick one.
  for (const dup of ambiguous) flat.delete(dup);
  for (const dup of ambiguousGroups) groups.delete(dup);
  // A group must never shadow a real top-level command of the same name.
  for (const name of tops.keys()) groups.delete(name);
  for (const [alias, path] of Object.entries(CURATED)) if (paths.has(path)) flat.set(alias, path);

  indexedCollection = client.commands ?? null;
  indexedSize = client.commands?.size ?? 0;
  logger.info(`[UniversalCmd] indexed ${paths.size} command paths, ${flat.size} shortcuts, ${groups.size} groups`);
  return { paths: paths.size, flat: flat.size, groups: groups.size, ambiguous: [...ambiguous] };
}

export function ensureIndex(client) {
  const coll = client.commands;
  if (!coll) return;
  if (coll === indexedCollection && coll.size === indexedSize && paths.size) return;
  buildIndex(client);
}

/**
 * Turn tokens into a command path.
 * @returns {{entry, rest: string[], path: string} | {needsSub: string, subs: string[]} | null}
 */
export function resolve(tokens) {
  if (!tokens.length) return null;
  const t = tokens.map(x => x.toLowerCase());

  // Longest path first: "music playlist add" > "music playlist" > "music".
  for (const depth of [3, 2, 1]) {
    if (t.length < depth) continue;
    const path = t.slice(0, depth).join(' ');
    const entry = paths.get(path);
    if (entry) return { entry, rest: tokens.slice(depth), path, depth };
  }

  // A top-level command that needs a subcommand we didn't get.
  const top = tops.get(t[0]);
  if (top?.hasSubs) return { needsSub: t[0], subs: top.subs, depth: 1 };

  // A bare GROUP name: `birthday list` -> `/engage birthday list`.
  const group = groups.get(t[0]);
  if (group) {
    if (t.length > 1) {
      const entry = paths.get(`${group.prefix} ${t[1]}`);
      // Only claim it if the second token really is one of the group's subcommands. Otherwise
      // fall through — `!birthday 03-15` must still reach the legacy set-shortcut.
      if (entry) return { entry, rest: tokens.slice(2), path: `${group.prefix} ${t[1]}`, depth: 2, viaGroup: true };
      return null;
    }
    // Bare group name — list what it can do instead of guessing.
    return { needsSub: t[0], subs: group.subs, depth: 1, viaGroup: true, path: group.prefix };
  }

  // Bare shortcut: `!play`, `!inventory`.
  const shortcut = flat.get(t[0]);
  if (shortcut) return { entry: paths.get(shortcut), rest: tokens.slice(1), path: shortcut, depth: 1 };

  return null;
}

// ── Option parsing, generated from the slash schema ──────────────────────────

const TRUE = new Set(['true', 'yes', 'y', '1', 'on', 'enable', 'enabled']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', 'disable', 'disabled']);

const looksLikeUser = s => /^<@!?\d+>$/.test(s);
const looksLikeChannel = s => /^<#\d+>$/.test(s);
const looksLikeRole = s => /^<@&\d+>$/.test(s);

/**
 * Fill an option schema from positional tokens, `name:value` pairs and `--name value`.
 * The final STRING option greedily absorbs the remaining words, so
 * `!ban @user being annoying` puts "being annoying" in `reason`.
 */
export function parseOptions(optionDefs, tokens, message = null) {
  const args = {};
  if (!optionDefs?.length) return args;

  const byName = new Map(optionDefs.map(o => [o.name, o]));
  const positional = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let m = /^--([a-z0-9_-]+)$/i.exec(tok);
    if (m && byName.has(m[1].toLowerCase())) { args[m[1].toLowerCase()] = tokens[++i] ?? ''; continue; }
    m = /^([a-z0-9_-]+):(.*)$/i.exec(tok);
    // Only treat `x:y` as a named arg when `x` is a real option — URLs contain colons.
    if (m && byName.has(m[1].toLowerCase())) {
      const name = m[1].toLowerCase();
      args[name] = m[2] || (tokens[++i] ?? '');
      continue;
    }
    positional.push(tok);
  }

  const remaining = optionDefs.filter(o => !(o.name in args));
  // Required first, so `!ban @user reason` fills `user` before an optional flag.
  const ordered = [...remaining.filter(o => o.required), ...remaining.filter(o => !o.required)];

  for (let i = 0; i < ordered.length && positional.length; i++) {
    const def = ordered[i];
    const isLast = i === ordered.length - 1;

    if (def.type === ATTACHMENT) { args[def.name] = message?.attachments?.first() ?? null; continue; }

    // Prefer a token that actually looks like the mention type we need.
    const wanted =
      def.type === USER ? looksLikeUser :
        def.type === CHANNEL ? looksLikeChannel :
          def.type === ROLE ? looksLikeRole : null;
    if (wanted) {
      const at = positional.findIndex(wanted);
      if (at !== -1) { args[def.name] = positional.splice(at, 1)[0]; continue; }
    }
    if (def.type === MENTIONABLE) {
      const at = positional.findIndex(s => looksLikeUser(s) || looksLikeRole(s));
      if (at !== -1) { args[def.name] = positional.splice(at, 1)[0]; continue; }
    }

    if (def.type === STRING && isLast) { args[def.name] = positional.join(' '); positional.length = 0; continue; }
    args[def.name] = positional.shift();
  }

  // Normalize so the resolver's getBoolean/getInteger see what they expect.
  for (const def of optionDefs) {
    const v = args[def.name];
    if (v == null || v === '') { if (!(def.name in args)) continue; }
    if (def.type === BOOLEAN && typeof v === 'string') {
      const lv = v.toLowerCase();
      args[def.name] = TRUE.has(lv) ? 'true' : FALSE.has(lv) ? 'false' : v;
    }
  }
  return args;
}

/** Check the required options the schema declares; return the first missing one. */
function missingRequired(optionDefs, args) {
  for (const o of optionDefs ?? []) {
    if (o.required && (args[o.name] == null || args[o.name] === '')) return o;
  }
  return null;
}

/**
 * Discord validates `addChoices`, `setMinValue`/`setMaxValue` and numeric types before it
 * ever dispatches a slash command. A chat message gets none of that, so handlers would
 * receive values their schema swore were impossible — `!globalban vote decision:banana`,
 * or a NaN where an integer was promised.
 *
 * Mutates `args` to the canonical choice value (so `Heads` and `heads` both arrive as
 * `heads`, exactly as the slash command would deliver it).
 *
 * @returns {string|null} a user-facing error, or null when every option is acceptable.
 */
function validateOptions(optionDefs, args) {
  for (const def of optionDefs ?? []) {
    const raw = args[def.name];
    if (raw == null || raw === '') continue;

    if (def.choices?.length) {
      const want = String(raw).trim().toLowerCase();
      // Accept either the value users see (name) or the value handlers receive.
      const hit = def.choices.find(c =>
        String(c.value).toLowerCase() === want || String(c.name).toLowerCase() === want);
      if (!hit) {
        const list = def.choices.slice(0, 12).map(c => `\`${c.value}\``).join(', ');
        return `**${def.name}** must be one of: ${list}${def.choices.length > 12 ? ', …' : ''}`;
      }
      args[def.name] = String(hit.value);
      continue;
    }

    if (def.type === INTEGER || def.type === NUMBER) {
      const n = def.type === INTEGER ? parseInt(raw, 10) : parseFloat(raw);
      if (!Number.isFinite(n) || (def.type === INTEGER && !/^-?\d+$/.test(String(raw).trim()))) {
        return `**${def.name}** must be a ${def.type === INTEGER ? 'whole number' : 'number'}.`;
      }
      if (def.min_value != null && n < def.min_value) return `**${def.name}** must be at least **${def.min_value}**.`;
      if (def.max_value != null && n > def.max_value) return `**${def.name}** must be at most **${def.max_value}**.`;
      args[def.name] = String(n);
      continue;
    }

    if (def.type === STRING) {
      const s = String(raw);
      if (def.min_length != null && s.length < def.min_length) return `**${def.name}** must be at least ${def.min_length} characters.`;
      if (def.max_length != null && s.length > def.max_length) return `**${def.name}** must be at most ${def.max_length} characters.`;
    }
  }
  return null;
}

function usageFor(path, optionDefs) {
  const parts = (optionDefs ?? []).map(o => (o.required ? `<${o.name}>` : `[${o.name}]`));
  return `${path}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

// ── Permission gating ────────────────────────────────────────────────────────
//
// Slash commands get two protections we must reproduce by hand, because neither
// applies to a plain chat message:
//   1. Discord itself enforces `default_member_permissions` before dispatching.
//   2. events/interactionCreate.js enforces `guild_command_restrictions`.
// Without these, `!globalban` would be reachable by anyone in a locked-down guild.

async function restrictionFor(guildId, commandName, subKey) {
  const fetch = key => configCache.get('cmd_restrict', `${guildId}:${key}`, async () => {
    const [rows] = await pool.execute(
      'SELECT allowed, admin_only, channel_id FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ?',
      [guildId, key]);
    return rows[0] || null;
  });
  return (subKey ? await fetch(subKey) : null) ?? await fetch(commandName);
}

/** @returns {Promise<string|null>} a denial message, or null if allowed. */
async function checkAccess(message, entry, path) {
  const member = message.member;
  if (!member) return null;
  if (isSuperAdmin(message.author.id)) return null; // owner keeps a repair path

  // 1. The command's own default_member_permissions (discord.js `has()` already
  //    treats Administrator as satisfying everything).
  let json;
  try { json = entry.command.data.toJSON(); } catch { json = null; }
  const dmp = json?.default_member_permissions;
  if (dmp) {
    const required = new PermissionsBitField(BigInt(dmp));
    if (!member.permissions.has(required)) {
      return `You don't have permission to use \`${path}\`.`;
    }
  }

  // 2. Per-guild restrictions, same keys interactionCreate.js uses.
  const cmdName = entry.command.data.name;
  const subKey = entry.group ? `${cmdName}:${entry.group}` : (entry.sub ? `${cmdName}:${entry.sub}` : null);
  const restriction = await restrictionFor(message.guildId, cmdName, subKey);

  if (restriction) {
    if (!restriction.allowed) return 'This command is not available in this server.';
    if (restriction.admin_only && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return 'This command is restricted to moderators in this server.';
    }
    if (restriction.channel_id && message.channelId !== restriction.channel_id) {
      return `This command can only be used in <#${restriction.channel_id}>.`;
    }
  } else if (ADMIN_CATEGORIES.has(entry.command.category) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return 'This command is restricted to moderators.';
  }
  return null;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run a slash command from a plain message.
 * @returns {Promise<boolean>} true if a command ran (or we replied with usage).
 */
export async function runUniversalCommand(message, tokens, prefixUsed = '!') {
  ensureIndex(message.client);
  const hit = resolve(tokens);

  if (!hit) {
    // A guild's own custom command (`!rules`) — checked last so it can never shadow
    // a real command.
    if (message.guild && tokens.length === 1) {
      const { handleCustomPrefixCommand } = await import('./custom-command-handler.js');
      return handleCustomPrefixCommand(message, tokens[0].toLowerCase());
    }
    return false;
  }

  if (hit.needsSub) {
    const list = hit.subs.slice(0, 20).map(s => `\`${prefixUsed}${hit.needsSub} ${s.split(' ').slice(1).join(' ') || s}\``);
    await message.reply({
      content: `\`${prefixUsed}${hit.needsSub}\` needs a subcommand:\n${list.join(', ')}` +
        (hit.subs.length > 20 ? `\n…and ${hit.subs.length - 20} more.` : ''),
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return true;
  }

  const { entry, rest, path } = hit;

  const denial = await checkAccess(message, entry, path);
  if (denial) {
    await message.reply({ content: denial, allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }

  const args = parseOptions(entry.options, rest, message);

  const missing = missingRequired(entry.options, args);
  if (missing) {
    await message.reply({
      content: `Missing **${missing.name}**.\nUsage: \`${prefixUsed}${usageFor(path, entry.options)}\``,
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return true;
  }

  // Reproduce the choice / range / type checks Discord does for slash commands.
  const invalid = validateOptions(entry.options, args);
  if (invalid) {
    await message.reply({
      content: `${invalid}\nUsage: \`${prefixUsed}${usageFor(path, entry.options)}\``,
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return true;
  }

  const ctx = new MessageContextAdapter(message, entry.command.data.name, args, {
    subcommand: entry.sub, subcommandGroup: entry.group,
  });

  try {
    await entry.command.execute(ctx);
  } catch (err) {
    if (err instanceof ModalUnsupportedError) {
      await message.reply({
        content: `\`/${path}\` opens a popup form, so it only works as a slash command.`,
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return true;
    }
    logger.error(`[UniversalCmd] ${path} failed: ${err.message}`, {
      stack: err.stack, guildId: message.guildId, userId: message.author.id, category: 'prefix',
    });
    await message.reply({ content: 'Something went wrong running that command.' }).catch(() => {});
  }
  return true;
}

/**
 * Every command path the bridge can reach, for the dashboard's command browser and
 * for validating alias targets. Safe to call before an index exists (returns []).
 */
export function listCommandPaths() {
  primeIndex();
  return [...paths.entries()]
    .map(([path, e]) => ({
      path,
      command: e.command.data.name,
      category: e.command.category ?? 'misc',
      group: e.group,
      sub: e.sub,
      options: (e.options ?? []).map(o => ({ name: o.name, type: o.type, required: !!o.required })),
      shortcuts: [...flat.entries()].filter(([, p]) => p === path).map(([alias]) => alias),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Unambiguous group names → their full prefix (`birthday` → `engage birthday`).
 * The public command catalog uses this to show that `!birthday list` reaches
 * `/engage birthday list` — nobody types the command name for a grouped subsystem.
 */
export function getGroups() {
  primeIndex();
  return new Map([...groups.entries()].map(([name, g]) => [name, g.prefix]));
}

/** Does this path exist? Used to reject aliases that point nowhere. */
export function isKnownPath(path) {
  primeIndex();
  return paths.has(String(path).trim().toLowerCase());
}

/**
 * Would a custom command with this name be unreachable?
 *
 * The bridge resolves in the order: full path -> top-level -> shortcut -> custom
 * command. So a custom command named `cat` (a top-level with subcommands) or `play`
 * (a shortcut) would never run. Reject those names up front rather than let an admin
 * create a command that silently does nothing.
 */
export function isReservedName(name) {
  primeIndex();
  const n = String(name).trim().toLowerCase();
  return paths.has(n) || tops.has(n) || flat.has(n);
}

/** The dashboard can be queried before any message has triggered indexing. */
function primeIndex() {
  if (!paths.size && global.client?.commands?.size) buildIndex(global.client);
}

export const _internals = { CURATED, resolve, parseOptions, buildIndex, validateOptions, missingRequired };
