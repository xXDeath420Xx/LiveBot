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
 * The one exception is the "/" prefix (core/prefix-command-manager.js): a message that starts with
 * "/word" was meant as a command, so it gets a short "Unknown command" hint there.
 *
 * "/" is the prefix of the text commands from the slash/text split (core/command-registration.js):
 * commands that are not registered with Discord are typed as `/owo hunt` and arrive here as a message.
 * TEXT_MERGE folds trees together (`/owo shards` runs /owo2), TEXT_ALIASES adds natural names
 * (`/joke` runs /fun joke). Usage and restriction keys always use the command's own path.
 */
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { MessageContextAdapter, ModalUnsupportedError } from './message-context-adapter.js';
import configCache from '../utils/configCache.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isSuperAdmin } from '../utils/constants.js';
import { getRestriction, evaluate, replyPolicy } from './command-restrictions.js';
import { featureForCommand } from './feature-config-spec.js';
import { checkAccess as checkFeatureAccess } from './feature-config.js';
import { flagGateFor } from './feature-flags.js';
import { translatorFor, tMaybe } from '../utils/i18n.js';
import { recordCommandUse, errorCodeOf } from './command-usage.js';
import { TEXT_MERGE, TEXT_ALIASES, BUILTIN_NAMES, isPrivateTextPath, isSlashPath } from './command-registration.js';
import { themeReplies } from './guild-theme.js';
import { buildDeployJson, MOUNTS } from './command-mounts.js';
import { SHORTCUTS } from './guild-shortcuts.js';
import { retiredMessage } from './retired-commands.js';
import { isScopedCommandAvailable } from './guild-scoped-access.js';

// Kept identical to events/interactionCreate.js — categories that need ManageGuild when
// a guild has no explicit restriction row.
const ADMIN_CATEGORIES = new Set(['admin', 'streams']);

// Discord ApplicationCommandOptionType
const SUB = 1, GROUP = 2, STRING = 3, INTEGER = 4, BOOLEAN = 5,
  USER = 6, CHANNEL = 7, ROLE = 8, MENTIONABLE = 9, NUMBER = 10, ATTACHMENT = 11;

// "/" is always accepted for text commands, whatever a server sets (core/prefix-command-manager.js).
export const DEFAULT_PREFIXES = ['!', '?', '$', '.', '/'];
export const SLASH_TEXT_PREFIX = '/';

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
/** TEXT_ALIASES that are free to use (never a real command, group or path name): alias -> words. */
let aliases = new Map();
// Keyed on the Collection itself, not the bot id: custom bots share one `sharedCommands`
// collection, so keying per-bot would rebuild the whole index on every alternating message.
let indexedCollection = null;
let indexedSize = 0;

const isSubLike = o => o.type === SUB || o.type === GROUP;

/** Build (or rebuild) the lookup tables from a client's command collection. */
export function buildIndex(client) {
  paths = new Map(); flat = new Map(); tops = new Map(); groups = new Map(); aliases = new Map();
  deployCache = null;
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

  // Text trees folded into another (`/owo shards` -> /owo2 shards). The merged path points at the
  // source command's entry and remembers its own path, so usage and restriction keys stay the source's.
  for (const [src, m] of Object.entries(TEXT_MERGE)) {
    const into = tops.get(m.into);
    if (!into || !tops.has(src)) continue;
    for (const [path, entry] of [...paths.entries()]) {
      if (entry.canonical || (path !== src && !path.startsWith(src + ' '))) continue;
      const rel = path.slice(src.length + 1);
      const merged = [m.into, m.as, rel].filter(Boolean).join(' ');
      if (merged === m.into || paths.has(merged)) continue;   // never shadow the target's own paths
      paths.set(merged, { ...entry, canonical: path });
      into.subs.push(merged.slice(m.into.length + 1));
      into.hasSubs = true;
    }
  }

  // Natural names for text commands. Skipped when the name is already taken by a real path,
  // command, group or shortcut, so an alias can only ever add a way in.
  for (const [alias, words] of Object.entries(TEXT_ALIASES)) {
    const a = alias.toLowerCase();
    if (paths.has(a) || tops.has(a) || groups.has(a) || flat.has(a) || BUILTIN_NAMES.has(a)) continue;
    const first = String(words).split(' ')[0];
    if (!tops.has(first) && !paths.has(words)) continue;
    aliases.set(a, String(words).toLowerCase());
  }

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
export function resolve(tokens, _aliasDepth = 0) {
  if (!tokens.length) return null;
  const t = tokens.map(x => x.toLowerCase());

  // Longest path first: "music playlist add" > "music playlist" > "music".
  for (const depth of [3, 2, 1]) {
    if (t.length < depth) continue;
    const path = t.slice(0, depth).join(' ');
    const entry = paths.get(path);
    // A merged path (`owo shards`) answers with the command's own path (`owo2 shards`).
    if (entry) return { entry, rest: tokens.slice(depth), path: entry.canonical || path, depth, typed: path };
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

  // A natural name from TEXT_ALIASES: `/joke` -> fun joke, `/charts export` -> stats export.
  const alias = aliases.get(t[0]);
  if (alias && _aliasDepth < 2) {
    const hit = resolve([...alias.split(' '), ...tokens.slice(1)], _aliasDepth + 1);
    if (hit) return { ...hit, depth: hit.depth != null ? Math.max(1, hit.depth - (alias.split(' ').length - 1)) : 1, viaAlias: t[0] };
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
  // File options take the message's attachments in order (required ones first). They use no typed
  // word, so they are filled whether or not any words are left: `/rpg character import` with only
  // the PDF attached used to answer "Missing pdf".
  const files = message?.attachments?.values ? [...message.attachments.values()] : [];
  const fileDefs = remaining.filter(o => o.type === ATTACHMENT);
  for (const def of [...fileDefs.filter(o => o.required), ...fileDefs.filter(o => !o.required)]) {
    if (files.length) args[def.name] = files.shift();
  }
  const words = remaining.filter(o => o.type !== ATTACHMENT);
  // Required first, so `!ban @user reason` fills `user` before an optional flag.
  const ordered = [...words.filter(o => o.required), ...words.filter(o => !o.required)];

  for (let i = 0; i < ordered.length && positional.length; i++) {
    const def = ordered[i];
    const isLast = i === ordered.length - 1;


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
  const restriction = await getRestriction(message.guildId, cmdName, subKey);

  if (restriction) {
    // Same reader and same evaluation order as the slash path. This used to be a
    // hand-copied subset that only understood allowed/admin_only/channel_id, so
    // a guild that set a role allowlist or a cooldown got it enforced on `/cmd`
    // and silently ignored on `!cmd` — the exact gap the bridge exists to close.
    const verdict = evaluate(restriction, {
      member,
      channelId: message.channelId,
      userId: message.author.id,
      guildId: message.guildId,
      commandKey: subKey || cmdName,
    });

    if (!verdict.ok) {
      const tr = await translatorFor(message).catch(() => null);
      return verdict.custom
        || (tr ? tMaybe(verdict.reasonKey, verdict.vars, { locale: tr.locale }) : null)
        || "You can't use that command here.";
    }
  } else if (ADMIN_CATEGORIES.has(entry.command.category) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return 'This command is restricted to moderators.';
  }

  // 3. Per-feature settings, same gate the slash path applies. Without this a server could
  // disable /grow or lock it to one channel and `!grow` would sail straight past — the same
  // class of bypass the restriction gate above was written to close.
  try {
    const gate = featureForCommand(cmdName, subKey);
    if (gate) {
      const access = await checkFeatureAccess(gate.feature, {
        guild: message.guild,
        channelId: message.channelId,
        member,
      }, gate.enabledKey);
      if (!access.allowed) return access.reason;
    }
    // Turned off in the feature catalog with no switch of its own (core/feature-flags.js SWITCHES `flag`).
    const flaggedOff = await flagGateFor(message.guildId, cmdName, subKey);
    if (flaggedOff) return `**${flaggedOff.name}** is turned off in this server.`;
  } catch (err) {
    logger.error(`[UniversalCommands] Feature-access check failed for ${path}: ${err.message}`);
  }

  return null;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run a slash command from a plain message.
 * @returns {Promise<boolean>} true if a command ran (or we replied with usage).
 */

/**
 * A bot MENTION is ambiguous: "@bot give me game recommendations" starts with the word "give",
 * which is also a real command, so the bridge matched /give and blew up on the missing arguments.
 * Symbol prefixes ("!give") are unambiguous — a mention is usually just someone talking.
 *
 * So when a mention-invoked command cannot run, hand the whole sentence to the AI assistant instead
 * of showing a command error. Returns true when the AI answered. Off unless the guild enabled it
 * (handleMention returns null), in which case the caller falls back to its normal error.
 */
export async function tryAiFallback(message) {
  try {
    if (!message.guild || !message.mentions?.users?.has(message.client.user.id)) return false;
    const { handleMention } = await import('./ai-assistant.js');
    const prompt = message.content.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
    if (!prompt) return false;
    const answer = await handleMention(message, prompt);
    if (!answer) return false;
    await message.reply({ content: answer, allowedMentions: { repliedUser: true, parse: [] } }).catch(() => {});
    return true;
  } catch (e) {
    logger.warn(`[UniversalCmd] AI fallback failed: ${e.message}`, { category: 'prefix' });
    return false;
  }
}

/**
 * One command_usage row (core/command-usage.js) for a command run from chat. `prefixUsed` is the
 * prefix as typed; a mention arrives as "@BotName " and is stored as '@'. "/" is the text-command
 * prefix of the slash/text split, kind 'slash_text'. Never throws.
 */
export function trackChatUse(message, command, path, prefixUsed, startedAt, error) {
  const p = typeof prefixUsed === 'string' ? prefixUsed : '!';
  recordCommandUse({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author?.id,
    appId: message.client?.application?.id || message.client?.user?.id,
    command,
    path,
    kind: p === '/' ? 'slash_text' : 'prefix',
    prefix: p.startsWith('@') ? '@' : p,
    success: !error,
    errorCode: error instanceof ModalUnsupportedError ? 'modal_unsupported' : errorCodeOf(error),
    latencyMs: Date.now() - startedAt,
  });
}

/** Is a resolved chat path served as text only (not registered with Discord)? */
export function isTextOnlyPath(path) {
  const words = String(path || '').split(' ');
  return !isSlashPath(words[0], words.slice(1).join(' '));
}

// Commands' own `cooldown` (default 3 s), shared with the slash path through client.cooldowns.
async function defaultCooldownDenial(message, command) {
  const { cooldowns } = message.client;
  if (!cooldowns || isSuperAdmin(message.author.id)) return null;
  const name = command.data.name;
  if (!cooldowns.has(name)) cooldowns.set(name, new Map());
  const stamps = cooldowns.get(name);
  const amount = (command.cooldown || 3) * 1000;
  const now = Date.now();
  const last = stamps.get(message.author.id);
  if (last && now < last + amount) {
    return `Please wait ${((last + amount - now) / 1000).toFixed(1)} more second(s) before reusing \`${name}\`.`;
  }
  stamps.set(message.author.id, now);
  setTimeout(() => stamps.delete(message.author.id), amount).unref?.();
  return null;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.textOnly]  only run commands that are served as text (not registered with
 *   Discord). Used for "/" in servers that switched prefix commands off: those commands have no
 *   other way in. Anything else is ignored silently (returns false).
 */
export async function runUniversalCommand(message, tokens, prefixUsed = '!', opts = {}) {
  // Same startup window as events/interactionCreate.js: the gateway delivers messages before
  // index.js has attached the managers, so a `!command` in that window would run against
  // undefined managers and cold caches and still report success. Refuse instead of half-doing it.
  if (message.client?.managersReady !== true) {
    await message.reply('⏳ I\'m still starting up, so that command didn\'t run — **nothing was changed**. '
      + 'Give me a few seconds and try again.').catch(() => {});
    return true;   // handled: the user got an answer, don't fall through to other matchers
  }

  ensureIndex(message.client);
  let hit = resolve(tokens);

  // A per-server (guildScoped) command runs from chat only where it is registered: an opted-in server on
  // the main bot, or a server a custom bot serves (core/guild-scoped-access.js, H-711). Anywhere else it is
  // treated as an unknown command, so the cannabis commands kept out of the global set stay out of chat too.
  const scoped = scopedCommandOf(hit);
  if (scoped && !(await isScopedCommandAvailable(message.client, message.guildId, scoped.data.name))) hit = null;

  // A removed command (core/retired-commands.js, H-650: Reddit feeds, /community automeme, /arcade cfx) says why
  // it is gone instead of listing the parent's other subcommands or falling silent.
  if (!hit || hit.needsSub) {
    const retired = retiredMessage(tokens);
    if (retired) {
      await message.reply({ content: retired, allowedMentions: { repliedUser: false } }).catch(() => {});
      return true;
    }
  }

  if (opts.textOnly && hit) {
    const p = hit.needsSub ? (hit.path || hit.needsSub) : hit.path;
    const top = String(p).split(' ')[0];
    const anyText = hit.needsSub
      ? (tops.get(top)?.subs ?? []).some(s => isTextOnlyPath(`${top} ${s}`))
      : isTextOnlyPath(p);
    if (!anyText) return false;
  }
  if (opts.textOnly && !hit) return false;   // no custom commands either: prefix commands are off here

  if (!hit) {
    // A guild's own custom command (`!rules`, `!roast @someone`) — checked last so it can never
    // shadow a real command. The words after the name are its {args}/{arg1}…
    if (message.guild && tokens.length >= 1) {
      const { handleCustomPrefixCommand } = await import('./custom-command-handler.js');
      return handleCustomPrefixCommand(message, tokens[0].toLowerCase(), tokens.slice(1));
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

  const denial = await checkAccess(message, entry, path)
    || await defaultCooldownDenial(message, entry.command);
  if (denial) {
    await message.reply({ content: denial, allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }

  const args = parseOptions(entry.options, rest, message);

  const missing = missingRequired(entry.options, args);
  if (missing) {
    if (await tryAiFallback(message)) return true;
    await message.reply({
      content: `Missing **${missing.name}**.\nUsage: \`${prefixUsed}${usageFor(path, entry.options)}\``,
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return true;
  }

  // Reproduce the choice / range / type checks Discord does for slash commands.
  const invalid = validateOptions(entry.options, args);
  if (invalid) {
    if (await tryAiFallback(message)) return true;
    await message.reply({
      content: `${invalid}\nUsage: \`${prefixUsed}${usageFor(path, entry.options)}\``,
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return true;
  }

  const ctx = new MessageContextAdapter(message, entry.command.data.name, args, {
    subcommand: entry.sub, subcommandGroup: entry.group,
    // A few text paths reply with something only the member should see (a generated password):
    // those replies go by DM instead of into the channel.
    privateDm: isPrivateTextPath(path),
  });
  themeReplies(ctx);   // the Embed theme footer on its embeds, as for slash commands (H-719)

  const usageStart = Date.now();
  try {
    try {
      await entry.command.execute(ctx);
    } catch (runErr) {
      trackChatUse(message, entry.command.data.name, path, prefixUsed, usageStart, runErr);
      throw runErr;
    }
    trackChatUse(message, entry.command.data.name, path, prefixUsed, usageStart, null);
    // "Delete the reply after N seconds" from the Commands page drawer (the slash path applies it
    // in events/interactionCreate.js). A chat reply is an ordinary message, so the bot deletes its
    // own message. "Private replies" cannot apply here: a chat reply is always public.
    const cmdName = entry.command.data.name;
    const subKey = entry.group ? `${cmdName}:${entry.group}` : (entry.sub ? `${cmdName}:${entry.sub}` : null);
    const after = replyPolicy(await getRestriction(message.guildId, cmdName, subKey).catch(() => null))?.seconds;
    if (after && ctx._replyMessage) {
      const timer = setTimeout(() => { ctx._replyMessage?.delete().catch(() => {}); }, after * 1000);
      timer.unref?.();
    }
  } catch (err) {
    if (err instanceof ModalUnsupportedError) {
      const slash = describePath(path).slash;
      await message.reply({
        content: slash
          ? `\`${slash}\` opens a popup form, so it only works as a slash command: pick it from the / menu.`
          : `\`${path}\` opens a popup form, which cannot open from a chat message.`,
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return true;
    }
    logger.error(`[UniversalCmd] ${path} failed: ${err.message}`, {
      stack: err.stack, guildId: message.guildId, userId: message.author.id, category: 'prefix',
    });
    if (await tryAiFallback(message)) return true;
    await message.reply({ content: 'Something went wrong running that command.' }).catch(() => {});
  }
  return true;
}

/** The guildScoped command module a resolved hit would run (or list subcommands of), else null. */
function scopedCommandOf(hit) {
  if (!hit) return null;
  const command = hit.entry
    ? hit.entry.command
    : tops.get(String(hit.path || hit.needsSub || '').split(' ')[0])?.command;
  return command?.guildScoped ? command : null;
}

/**
 * Every command path the bridge can reach, for the dashboard's command browser and
 * for validating alias targets. Safe to call before an index exists (returns []).
 */
export function listCommandPaths() {
  primeIndex();
  return [...paths.entries()]
    .filter(([, e]) => !e.canonical)   // merged duplicates (`owo shards`) are listed under their own path
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
  return paths.has(n) || tops.has(n) || flat.has(n) || aliases.has(n);
}

// ── Slash or text: what a member types ──────────────────────────────────────

let deployCache = null;

/**
 * What is registered with Discord for the current command collection:
 *   slashOf    chat path -> the slash path members pick ("owoify" -> "fun owoify"), slash paths only
 *   registered first words Discord's client takes over: every deployed command, every per-server
 *              shortcut that can be deployed, and the per-server (guildScoped) commands
 */
export function deployInfo() {
  primeIndex();
  if (deployCache && deployCache.coll === indexedCollection && deployCache.size === indexedSize) return deployCache;
  const slashOf = new Map();
  const registered = new Set();
  const mods = [...(indexedCollection?.values?.() ?? [])].filter(c => c?.data?.toJSON);
  let top = [];
  try { top = buildDeployJson(mods, { paths: slashOf }); } catch (e) { logger.warn(`[UniversalCmd] deploy preview failed: ${e.message}`); }
  // Every module goes in here, guildScoped ones too: they are registered in the servers that opted in.
  for (const c of top) if ((c.type ?? 1) === 1) registered.add(c.name);
  for (const [name, s] of Object.entries(SHORTCUTS)) {
    const parent = top.find(c => c.name === s.parent);
    if (parent?.options?.some(o => o.name === s.sub)) registered.add(name);
  }
  deployCache = { coll: indexedCollection, size: indexedSize, slashOf, registered };
  return deployCache;
}

/**
 * The ways in for one chat path ("owo hunt", "fun confess", "music play").
 * @returns {{ path: string, type: 'slash'|'text', slash: string|null, text: string|null }}
 *   slash  what to pick from Discord's / menu, when the path is registered
 *   text   what to type as a message starting with "/" (never a registered name or a built-in);
 *          null when the path is slash-only reachable by "/" (it still works with ! ? $ .)
 */
export function describePath(path) {
  primeIndex();
  const p = String(path || '').trim().toLowerCase();
  const { slashOf, registered } = deployInfo();
  const slash = slashOf.has(p) ? `/${slashOf.get(p)}` : null;
  return { path: p, type: slash ? 'slash' : 'text', slash, text: textFormFor(p, registered) };
}

/** The shortest "/" form that resolves back to `p` and whose first word Discord leaves alone. */
function textFormFor(p, registered) {
  const words = p.split(' ');
  const free = w => !registered.has(w) && !BUILTIN_NAMES.has(w);
  // A merged form first (`/owo shards`, not `/owo2 shards`), then the path as it is.
  const candidates = [];
  for (const [src, m] of Object.entries(TEXT_MERGE)) {
    if (p === src || p.startsWith(src + ' ')) candidates.push([m.into, m.as, p.slice(src.length + 1)].filter(Boolean).join(' '));
  }
  candidates.push(p);
  for (const [a, w] of aliases) {
    if (p === w) candidates.push(a);
    else if (p.startsWith(w + ' ')) candidates.push(`${a} ${p.slice(w.length + 1)}`);
  }
  if (words.length === 3 && groups.get(words[1])?.prefix === `${words[0]} ${words[1]}`) candidates.push(`${words[1]} ${words[2]}`);
  const last = words[words.length - 1];
  if (words.length > 1 && flat.get(last) === p) candidates.push(last);
  for (const c of candidates) {
    if (!free(c.split(' ')[0])) continue;
    const hit = resolve(c.split(' '));
    if (hit?.entry && hit.path === p && hit.rest.length === 0) return `/${c}`;
  }
  return null;
}

/** The dashboard can be queried before any message has triggered indexing. */
function primeIndex() {
  if (!paths.size && global.client?.commands?.size) buildIndex(global.client);
}

export const _internals = { CURATED, resolve, parseOptions, buildIndex, validateOptions, missingRequired };
