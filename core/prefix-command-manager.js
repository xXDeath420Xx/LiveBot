import { MessageContextAdapter } from './message-context-adapter.js';
import { getCommand, getAllCommands, getCategories, getCommandsByCategory } from './prefix-command-registry.js';
import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import { runUniversalCommand, DEFAULT_PREFIXES, SLASH_TEXT_PREFIX, isKnownPath, resolve as resolveUniversal, tryAiFallback, ensureIndex, trackChatUse } from './universal-commands.js';
import { BUILTIN_NAMES } from './command-registration.js';
import { isScopedCommandAvailable, legacyScopedCommand } from './guild-scoped-access.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PREFIX = '!';

// Cache: guildId → { prefix, disabledCommands, ts }
const guildConfigCache = new Map();
// Cache: guildId → { aliases: Map<alias, commandName>, ts }
const guildAliasCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Handler function cache: avoid re-importing on every command
const handlerCache = new Map();

/**
 * Get guild config (prefix, disabled commands) — cached
 */
async function getGuildConfig(guildId) {
    const cached = guildConfigCache.get(guildId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

    try {
        const [rows] = await pool.execute(
            'SELECT prefix, prefixes, allow_mention, universal_commands, enabled, disabled_commands, delete_trigger, cleanup_delay, private_categories FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );
        const row = rows[0];
        const config = {
            prefix: row?.prefix || DEFAULT_PREFIX,
            prefixes: resolvePrefixList(row),
            allowMention: row?.allow_mention !== 0,
            universal: row?.universal_commands !== 0,
            enabled: row?.enabled ?? 1,
            disabledCommands: new Set(row?.disabled_commands ? JSON.parse(row.disabled_commands) : []),
            deleteTrigger: row?.delete_trigger === 1,
            cleanupDelay: row?.cleanup_delay || 0,
            privateCategories: new Set(row?.private_categories ? JSON.parse(row.private_categories) : []),
            ts: Date.now()
        };
        guildConfigCache.set(guildId, config);
        return config;
    } catch {
        return { prefix: DEFAULT_PREFIX, prefixes: [DEFAULT_PREFIX, ...DEFAULT_PREFIXES], allowMention: true, universal: true, enabled: 1, disabledCommands: new Set(), deleteTrigger: false, cleanupDelay: 0, privateCategories: new Set(), ts: Date.now() };
    }
}

/** The guild's own prefix always wins; the shared defaults come after. Longest first. */
function resolvePrefixList(row) {
    let list = null;
    if (row?.prefixes) {
        try { list = JSON.parse(row.prefixes); } catch { list = null; }
    }
    if (!Array.isArray(list) || !list.length) list = [...DEFAULT_PREFIXES];
    const primary = row?.prefix || DEFAULT_PREFIX;
    // "/" is always on: it is how members reach the text commands, which have no slash command.
    const all = [...new Set([primary, ...list, SLASH_TEXT_PREFIX])].filter(p => typeof p === 'string' && p.length);
    return all.sort((a, b) => b.length - a.length);
}

// "/word" that is not a command gets a short hint (other prefixes stay silent). Not for tone tags
// ("/s", "/j"), not for Discord's own commands, and at most once a minute per member.
// With "/" these never run a command either: "/s" on its own is sarcasm, not the `s` (skip) shortcut,
// and "/p" or "/q" alone are tone tags more often than music. `/play`, `/skip`, `/queue` still work.
const TONE_TAGS = new Set(['s', 'j', 'srs', 'hj', 'lh', 'gen', 'pos', 'neg', 'nm', 'nbh', 'rh', 'sarc', 'ref', 'lyr', 'nsrs', 'jk', 'hyp', 'ex', 'c', 'l', 'p', 'q', 't', 'r', 'g', 'm', 'nc', 'nf', 'neu', 'ot', 'th', 'cb', 'pc', 'sx', 'x', 'ly', 'li', 'lu', 'nbr', 'npa', 'nay', 'ay', 'nsx', 'rt', 'pf', 'o', 'cr', 'f', 'pl', 'sr']);
const unknownHintAt = new Map();
async function hintUnknownSlashText(message, word) {
    const w = String(word || '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(w) || TONE_TAGS.has(w) || BUILTIN_NAMES.has(w)) return;
    const key = `${message.guildId}:${message.author.id}`;
    const now = Date.now();
    if (now - (unknownHintAt.get(key) || 0) < 60_000) return;
    unknownHintAt.set(key, now);
    if (unknownHintAt.size > 5000) for (const [k, t] of unknownHintAt) if (now - t > 60_000) unknownHintAt.delete(k);
    await message.reply({ content: 'Unknown command — try /help', allowedMentions: { repliedUser: false } }).catch(() => {});
}

/**
 * Get guild-specific aliases — cached
 * Returns Map<alias, commandName>
 */
async function getGuildAliases(guildId) {
    const cached = guildAliasCache.get(guildId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.aliases;

    try {
        const [rows] = await pool.execute(
            'SELECT alias, command_name FROM prefix_command_aliases WHERE guild_id = ?',
            [guildId]
        );
        const aliases = new Map(rows.map(r => [r.alias.toLowerCase(), r.command_name.toLowerCase()]));
        guildAliasCache.set(guildId, { aliases, ts: Date.now() });
        return aliases;
    } catch {
        return new Map();
    }
}

/**
 * Get the prefix for a guild (convenience wrapper)
 */
export async function getPrefix(guildId) {
    const config = await getGuildConfig(guildId);
    return config.prefix;
}

/**
 * Invalidate all caches for a guild (call after config/alias changes)
 */
export function invalidateGuildCache(guildId) {
    guildConfigCache.delete(guildId);
    guildAliasCache.delete(guildId);
}

/**
 * May a slash GROUP take over a name that a legacy prefix command already owns?
 *
 * Only when the group is the same subsystem the legacy command is a shortcut INTO. `birthday`
 * is a flattened alias for `/engage birthday set`, so the `engage birthday` group rightly owns
 * `!birthday list` — its handler lives in `commands/community/engage-birthday-handler.js`.
 *
 * `play` is the counter-example, and the reason this check exists: it is the music command, but
 * `rpg` also happens to define a `play` GROUP. Letting the group win would silently route
 * `!play <song>` into the RPG system the moment a song title collided with an RPG subcommand
 * name. Different subsystem → the legacy command keeps its name.
 *
 * A non-group match (`!emoji list` → `/emoji list`) is always the same command by construction,
 * so it needs no check.
 */
function groupMayOverride(commandDef, hit, suppliedArgCount) {
    if (!hit.viaGroup) return true;

    const parent = String(hit.path ?? '').split(' ')[0];
    if (!parent) return false;
    const file = typeof commandDef.handler === 'object' ? String(commandDef.handler.file ?? '') : '';
    if (!file.toLowerCase().includes(parent.toLowerCase())) return false;

    // The user named a real subcommand (`!birthday list`) — the group owns it.
    if (!hit.needsSub) return true;

    // Bare name (`!birthday`, `!toke`). Only list the subsystem if the legacy command could not
    // have run anyway. `!birthday` needs a date, so listing is strictly more useful than an
    // error; `!toke` takes no arguments and is meant to just fire — never hijack that.
    const required = (commandDef.args ?? []).filter(a => a.required).length;
    return suppliedArgCount < required;
}

/**
 * Parse args from message content based on command arg definitions.
 *
 * For args with `rest: true`, all remaining text is captured as one string.
 * Otherwise, args are split by whitespace.
 */
function parseArgs(argsText, argDefs) {
    if (!argDefs || argDefs.length === 0) return {};

    const parsed = {};
    const parts = argsText.trim().split(/\s+/);
    let partIndex = 0;

    for (const argDef of argDefs) {
        if (argDef.rest) {
            // Capture everything remaining as one string
            const remaining = parts.slice(partIndex).join(' ');
            parsed[argDef.name] = remaining || null;
            break;
        }

        parsed[argDef.name] = parts[partIndex] ?? null;
        partIndex++;
    }

    return parsed;
}

/**
 * Resolve a handler reference to an actual function.
 * Supports:
 *   - { file, method } — lazy import + method lookup
 *   - { file, method, wrap } — lazy import + wrapper fn for extra args
 *   - 'builtin:name' — built-in commands (help, prefix, alias, etc.)
 *   - Direct function reference
 */
async function resolveHandler(handlerRef) {
    if (typeof handlerRef === 'function') return handlerRef;

    if (typeof handlerRef === 'string' && handlerRef.startsWith('builtin:')) {
        return getBuiltinHandler(handlerRef.replace('builtin:', ''));
    }

    const cacheKey = `${handlerRef.file}:${handlerRef.method}`;
    if (handlerCache.has(cacheKey)) return handlerCache.get(cacheKey);

    const modulePath = join(__dirname, handlerRef.file);
    const mod = await import(modulePath);

    // Resolve dotted method paths like 'default.execute'
    let fn = mod;
    for (const part of handlerRef.method.split('.')) {
        fn = fn[part];
    }

    if (typeof fn !== 'function') {
        throw new Error(`Handler ${cacheKey} is not a function`);
    }

    // Apply wrapper if defined (for handlers that take extra params like guildId, userId)
    if (handlerRef.wrap) {
        fn = handlerRef.wrap(fn);
    }

    handlerCache.set(cacheKey, fn);
    return fn;
}

/**
 * Built-in prefix commands (help, prefix, alias, disable, enable)
 */
function getBuiltinHandler(name) {
    switch (name) {
        case 'help': return handleHelp;
        case 'prefix': return handlePrefix;
        case 'alias': return handleAlias;
        case 'disable': return handleDisable;
        case 'enable': return handleEnable;
        case 'cleanup': return handleCleanup;
        default: throw new Error(`Unknown builtin: ${name}`);
    }
}

async function handleHelp(ctx) {
    const categoryName = ctx.options.getString('category');

    if (categoryName) {
        const cmds = getCommandsByCategory(categoryName.toLowerCase());
        if (cmds.length === 0) {
            return ctx.reply({ content: `No commands found in category: ${categoryName}` });
        }
        const prefix = await getPrefix(ctx.guildId);
        const lines = cmds.map(c => {
            const aliases = c.aliases?.length ? ` (${c.aliases.map(a => prefix + a).join(', ')})` : '';
            const args = c.args?.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ') || '';
            return `\`${prefix}${c.name}${args ? ' ' + args : ''}\`${aliases} — ${c.description}`;
        });
        const embed = new EmbedBuilder()
            .setColor('#a78bfa')
            .setTitle(`${categoryName.charAt(0).toUpperCase() + categoryName.slice(1)} Commands`)
            .setDescription(lines.join('\n'));
        return ctx.reply({ embeds: [embed] });
    }

    const categories = getCategories();
    const prefix = await getPrefix(ctx.guildId);
    const lines = categories.map(cat => {
        const cmds = getCommandsByCategory(cat);
        return `**${cat.charAt(0).toUpperCase() + cat.slice(1)}** — ${cmds.length} commands\n` +
               cmds.map(c => `\`${prefix}${c.name}\``).join(', ');
    });

    const embed = new EmbedBuilder()
        .setColor('#a78bfa')
        .setTitle('Prefix Commands')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `Use ${prefix}prefixhelp <category> for details | Prefix: ${prefix}` });

    return ctx.reply({ embeds: [embed] });
}

async function handlePrefix(ctx) {
    const newPrefix = ctx.options.getString('new_prefix');

    if (!newPrefix) {
        const prefix = await getPrefix(ctx.guildId);
        return ctx.reply({ content: `Current prefix: \`${prefix}\`` });
    }

    // Require ManageGuild permission to change prefix
    if (!ctx.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return ctx.reply({ content: 'You need **Manage Server** permission to change the prefix.' });
    }

    if (newPrefix.length > 5) {
        return ctx.reply({ content: 'Prefix must be 5 characters or less.' });
    }

    await pool.execute(
        `INSERT INTO prefix_command_config (guild_id, prefix) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE prefix = VALUES(prefix)`,
        [ctx.guildId, newPrefix]
    );

    invalidateGuildCache(ctx.guildId);
    return ctx.reply({ content: `Prefix updated to \`${newPrefix}\`` });
}

async function handleAlias(ctx) {
    if (!ctx.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return ctx.reply({ content: 'You need **Manage Server** permission.' });
    }

    const action = ctx.options.getString('action')?.toLowerCase();
    const aliasName = ctx.options.getString('alias_name');
    const targetCommand = ctx.options.getString('target_command');
    const prefix = await getPrefix(ctx.guildId);

    if (action === 'add') {
        if (!aliasName || !targetCommand) {
            return ctx.reply({ content: `Usage: \`${prefix}alias add <alias> <command>\`` });
        }
        // The runtime substitutes an alias then falls through to the universal bridge, so a
        // target may be a hand-written prefix command OR any slash path ("dj" -> "music dj").
        // Validating against the registry alone rejected targets that would have run fine.
        if (!getCommand(targetCommand) && !isKnownPath(targetCommand)) {
            return ctx.reply({ content: `Unknown command: \`${targetCommand}\`. Use \`${prefix}prefixhelp\` to see available commands.` });
        }
        await pool.execute(
            `INSERT INTO prefix_command_aliases (guild_id, alias, command_name, created_by)
             VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE command_name = VALUES(command_name)`,
            [ctx.guildId, aliasName.toLowerCase(), targetCommand.toLowerCase(), ctx.user.id]
        );
        invalidateGuildCache(ctx.guildId);
        return ctx.reply({ content: `Alias created: \`${prefix}${aliasName}\` → \`${prefix}${targetCommand}\`` });

    } else if (action === 'remove' || action === 'delete') {
        if (!aliasName) {
            return ctx.reply({ content: `Usage: \`${prefix}alias remove <alias>\`` });
        }
        const [result] = await pool.execute(
            'DELETE FROM prefix_command_aliases WHERE guild_id = ? AND alias = ?',
            [ctx.guildId, aliasName.toLowerCase()]
        );
        invalidateGuildCache(ctx.guildId);
        return ctx.reply({ content: result.affectedRows ? `Alias \`${prefix}${aliasName}\` removed.` : `No alias found: \`${aliasName}\`` });

    } else if (action === 'list') {
        const [rows] = await pool.execute(
            'SELECT alias, command_name FROM prefix_command_aliases WHERE guild_id = ? ORDER BY alias',
            [ctx.guildId]
        );
        if (!rows.length) return ctx.reply({ content: 'No custom aliases set for this server.' });
        const lines = rows.map(r => `\`${prefix}${r.alias}\` → \`${prefix}${r.command_name}\``);
        const embed = new EmbedBuilder()
            .setColor('#a78bfa')
            .setTitle('Custom Aliases')
            .setDescription(lines.join('\n'));
        return ctx.reply({ embeds: [embed] });

    } else {
        return ctx.reply({ content: `Usage: \`${prefix}alias <add|remove|list> [alias] [command]\`` });
    }
}

async function handleDisable(ctx) {
    if (!ctx.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return ctx.reply({ content: 'You need **Manage Server** permission.' });
    }
    const command = ctx.options.getString('command')?.toLowerCase();
    if (!getCommand(command)) {
        return ctx.reply({ content: `Unknown command: \`${command}\`` });
    }

    const [rows] = await pool.execute(
        'SELECT disabled_commands FROM prefix_command_config WHERE guild_id = ?',
        [ctx.guildId]
    );
    let disabled = rows[0]?.disabled_commands ? JSON.parse(rows[0].disabled_commands) : [];
    if (disabled.includes(command)) {
        return ctx.reply({ content: `\`${command}\` is already disabled.` });
    }
    disabled.push(command);
    await pool.execute(
        `INSERT INTO prefix_command_config (guild_id, disabled_commands)
         VALUES (?, ?) ON DUPLICATE KEY UPDATE disabled_commands = VALUES(disabled_commands)`,
        [ctx.guildId, JSON.stringify(disabled)]
    );
    invalidateGuildCache(ctx.guildId);
    return ctx.reply({ content: `Prefix command \`${command}\` disabled.` });
}

async function handleEnable(ctx) {
    if (!ctx.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return ctx.reply({ content: 'You need **Manage Server** permission.' });
    }
    const command = ctx.options.getString('command')?.toLowerCase();

    const [rows] = await pool.execute(
        'SELECT disabled_commands FROM prefix_command_config WHERE guild_id = ?',
        [ctx.guildId]
    );
    let disabled = rows[0]?.disabled_commands ? JSON.parse(rows[0].disabled_commands) : [];
    if (!disabled.includes(command)) {
        return ctx.reply({ content: `\`${command}\` is not disabled.` });
    }
    disabled = disabled.filter(c => c !== command);
    await pool.execute(
        'UPDATE prefix_command_config SET disabled_commands = ? WHERE guild_id = ?',
        [JSON.stringify(disabled), ctx.guildId]
    );
    invalidateGuildCache(ctx.guildId);
    return ctx.reply({ content: `Prefix command \`${command}\` re-enabled.` });
}

async function handleCleanup(ctx) {
    if (!ctx.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return ctx.reply({ content: 'You need **Manage Server** permission.' });
    }

    const setting = ctx.options.getString('setting')?.toLowerCase();
    const value = ctx.options.getString('value');
    const prefix = await getPrefix(ctx.guildId);

    // Ensure config row exists
    await pool.execute(
        'INSERT IGNORE INTO prefix_command_config (guild_id) VALUES (?)',
        [ctx.guildId]
    );

    if (setting === 'status') {
        const config = await getGuildConfig(ctx.guildId);
        const embed = new EmbedBuilder()
            .setColor('#a78bfa')
            .setTitle('Prefix Cleanup Settings')
            .addFields(
                { name: 'Delete trigger messages', value: config.deleteTrigger ? 'On' : 'Off', inline: true },
                { name: 'Self-destruct delay', value: config.cleanupDelay ? `${config.cleanupDelay}s` : 'Off', inline: true },
                { name: 'Private categories', value: config.privateCategories.size ? [...config.privateCategories].join(', ') : 'None', inline: false }
            )
            .setFooter({ text: `${prefix}cleanup <setting> <value>` });
        return ctx.reply({ embeds: [embed] });
    }

    if (setting === 'delete' || setting === 'deletetrigger') {
        const on = !value || ['on', 'true', 'yes', '1', 'enable'].includes(value.toLowerCase());
        await pool.execute(
            'UPDATE prefix_command_config SET delete_trigger = ? WHERE guild_id = ?',
            [on ? 1 : 0, ctx.guildId]
        );
        invalidateGuildCache(ctx.guildId);
        return ctx.reply({ content: `Trigger message deletion: **${on ? 'on' : 'off'}**` });
    }

    if (setting === 'delay') {
        const seconds = parseInt(value, 10);
        if (isNaN(seconds) || seconds < 0 || seconds > 300) {
            return ctx.reply({ content: 'Delay must be 0-300 seconds. 0 = off.' });
        }
        await pool.execute(
            'UPDATE prefix_command_config SET cleanup_delay = ? WHERE guild_id = ?',
            [seconds, ctx.guildId]
        );
        invalidateGuildCache(ctx.guildId);
        return ctx.reply({ content: seconds ? `Self-destruct delay set to **${seconds}s** for private categories.` : 'Response self-destruct **disabled**.' });
    }

    if (setting === 'private') {
        if (!value) {
            return ctx.reply({ content: `Usage: \`${prefix}cleanup private <add|remove|list> [category]\`` });
        }
        const parts = value.split(/\s+/);
        const action = parts[0]?.toLowerCase();
        const category = parts[1]?.toLowerCase();

        const [rows] = await pool.execute(
            'SELECT private_categories FROM prefix_command_config WHERE guild_id = ?',
            [ctx.guildId]
        );
        let cats = rows[0]?.private_categories ? JSON.parse(rows[0].private_categories) : [];

        if (action === 'add' && category) {
            if (!cats.includes(category)) cats.push(category);
            await pool.execute(
                'UPDATE prefix_command_config SET private_categories = ? WHERE guild_id = ?',
                [JSON.stringify(cats), ctx.guildId]
            );
            invalidateGuildCache(ctx.guildId);
            return ctx.reply({ content: `Category \`${category}\` marked as private — responses will self-destruct.` });
        } else if ((action === 'remove' || action === 'delete') && category) {
            cats = cats.filter(c => c !== category);
            await pool.execute(
                'UPDATE prefix_command_config SET private_categories = ? WHERE guild_id = ?',
                [JSON.stringify(cats), ctx.guildId]
            );
            invalidateGuildCache(ctx.guildId);
            return ctx.reply({ content: `Category \`${category}\` removed from private list.` });
        } else if (action === 'list') {
            return ctx.reply({ content: cats.length ? `Private categories: ${cats.map(c => `\`${c}\``).join(', ')}` : 'No private categories set.' });
        } else {
            return ctx.reply({ content: `Usage: \`${prefix}cleanup private <add|remove|list> [category]\`` });
        }
    }

    // Show usage
    const embed = new EmbedBuilder()
        .setColor('#a78bfa')
        .setTitle('Cleanup Settings')
        .setDescription([
            `\`${prefix}cleanup status\` — view current settings`,
            `\`${prefix}cleanup delete <on|off>\` — delete user's command message`,
            `\`${prefix}cleanup delay <seconds>\` — self-destruct delay for private categories (0 = off)`,
            `\`${prefix}cleanup private add <category>\` — mark a category as private`,
            `\`${prefix}cleanup private remove <category>\` — unmark a category`,
            `\`${prefix}cleanup private list\` — list private categories`,
            '',
            `**Categories:** ${getCategories().map(c => `\`${c}\``).join(', ')}`
        ].join('\n'));
    return ctx.reply({ embeds: [embed] });
}

/**
 * Match any of the guild's prefixes, or a leading @mention of this bot.
 *
 * A symbol prefix must be followed by a letter. `?` and `.` are legal prefixes, so
 * without that guard "..." and "?? what" would be parsed as commands on every message.
 * @returns {{prefix: string, body: string} | null}
 */
export function stripPrefix(message, config) {
    const content = message.content.trimStart();

    if (config.allowMention) {
        const m = /^<@!?(\d+)>\s*/.exec(content);
        if (m && m[1] === message.client.user?.id) {
            return { prefix: `@${message.client.user.username} `, body: content.slice(m[0].length).trim() };
        }
    }

    for (const prefix of config.prefixes) {
        if (!content.startsWith(prefix)) continue;
        const body = content.slice(prefix.length);
        // Letters only: keeps "!!!" , "?!", "$5", "...", "-1" out of the command path.
        if (!/^[a-z]/i.test(body)) continue;
        return { prefix, body: body.trim() };
    }
    return null;
}

/**
 * Main entry point — called from messageCreate event.
 * Returns true if the message was handled as a prefix command.
 */
export async function handlePrefixCommand(message) {
    if (!message.guild || message.author.bot) return false;

    const config = await getGuildConfig(message.guildId);
    // With prefix commands switched off, "/" still reaches the text commands (they have no slash
    // command, so it is their only way in) and nothing else.
    const stripped = stripPrefix(message, config.enabled ? config : { ...config, allowMention: false, prefixes: [SLASH_TEXT_PREFIX] });
    if (!stripped) return false;
    const { prefix, body: withoutPrefix } = stripped;
    if (!withoutPrefix) return false;
    if (prefix === SLASH_TEXT_PREFIX && TONE_TAGS.has(withoutPrefix.split(/\s+/)[0].toLowerCase())) return false;

    if (prefix === SLASH_TEXT_PREFIX && !config.enabled) {
        const tokens = withoutPrefix.split(/\s+/).filter(Boolean);
        if (await runUniversalCommand(message, tokens, prefix, { textOnly: true })) return true;
        await hintUnknownSlashText(message, tokens[0]);
        return false;   // let the rest of message handling (automod) see it
    }

    const spaceIndex = withoutPrefix.indexOf(' ');
    let commandName = (spaceIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIndex)).toLowerCase();
    const rawArgs = spaceIndex === -1 ? '' : withoutPrefix.slice(spaceIndex + 1);

    // Check guild-specific aliases FIRST (override defaults)
    const guildAliases = await getGuildAliases(message.guildId);
    if (guildAliases.has(commandName)) {
        commandName = guildAliases.get(commandName);
    }

    // Look up command in the default registry
    let commandDef = getCommand(commandName);
    // The 'cannabis' legacy commands (!toke, !strain, !startgrow) run the /cannabis and /grow handlers, which are
    // per-server (guildScoped): they follow the same rule as the slash commands (core/guild-scoped-access.js, H-711).
    const scopedAs = legacyScopedCommand(commandDef);
    if (scopedAs && !(await isScopedCommandAvailable(message.client, message.guildId, scopedAs))) commandDef = null;

    // A flat legacy command must not shadow a richer slash subsystem. `birthday` is registered
    // here as a one-shot "set your birthday" with a required date, which swallowed
    // `!birthday list`, `!birthday view`, `!birthday remove` — the whole subsystem was
    // unreachable, because the legacy registry is consulted before the slash bridge.
    //
    // So when the tokens actually NAME a subcommand (depth >= 2), or name a bare group with
    // nothing after it, the slash path wins. A single-token match (`!ban @user spam`, which
    // resolves via shortcut at depth 1) is left alone, so every existing prefix command keeps
    // its current behaviour.
    if (commandDef && config.universal) {
        const argTokens = rawArgs.split(/\s+/).filter(Boolean);
        const tokens = [...commandName.split(/\s+/).filter(Boolean), ...argTokens];
        const hit = resolveUniversal(tokens);
        if (hit && (hit.depth >= 2 || hit.viaGroup) && groupMayOverride(commandDef, hit, argTokens.length)) {
            if (await runUniversalCommand(message, tokens, prefix)) return true;
        }
    }

    if (!commandDef) {
        // Not a hand-written prefix command — try reaching a slash command directly,
        // e.g. `!play <url>` -> `/music play`. Silent when nothing matches.
        if (config.universal) {
            // Use the ALIASED name: an alias may expand to a multi-word slash path
            // ("dj" -> "music dj"), so rebuild the token list from it rather than
            // re-splitting the original message.
            const tokens = [...commandName.split(/\s+/), ...rawArgs.split(/\s+/)].filter(Boolean);
            if (await runUniversalCommand(message, tokens, prefix)) return true;
        } else if (prefix === SLASH_TEXT_PREFIX) {
            // The bridge is off here, but the text commands have no other way in.
            const tokens = [...commandName.split(/\s+/), ...rawArgs.split(/\s+/)].filter(Boolean);
            if (await runUniversalCommand(message, tokens, prefix, { textOnly: true })) return true;
        } else if (message.guild) {
            // The server's own custom commands answer with "Reach every slash command from chat" off too: they
            // are not slash commands (H-805). Before, they only ran through the bridge.
            const tokens = [...commandName.split(/\s+/), ...rawArgs.split(/\s+/)].filter(Boolean);
            const { handleCustomPrefixCommand } = await import('./custom-command-handler.js');
            if (tokens.length && await handleCustomPrefixCommand(message, tokens[0].toLowerCase(), tokens.slice(1))) return true;
        }
        // "/word" was meant as a command: say so, but still return false so automod and the other
        // message handlers see the message.
        if (prefix === SLASH_TEXT_PREFIX) await hintUnknownSlashText(message, commandName.split(/\s+/)[0]);
        return false; // fall through to tags etc.
    }

    // Resolve to canonical name (in case the default registry matched an alias)
    const canonicalName = commandDef.canonicalName || commandName;

    // Check if this command is disabled in this guild
    if (config.disabledCommands.has(canonicalName)) {
        await message.reply({ content: 'This command is disabled in this server.' });
        return true;
    }

    // Moderation category commands require ManageGuild permission
    const ADMIN_PREFIX_CATEGORIES = new Set(['moderation']);
    if (ADMIN_PREFIX_CATEGORIES.has(commandDef.category) && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        await message.reply({ content: 'This command is restricted to moderators.' });
        return true;
    }

    // An admin who switched the economy off meant every way in, not just /economy. The admin
    // grant (`give`) stays usable, as it does under /economy.
    if (commandDef.category === 'economy' && canonicalName !== 'give') {
        const { economyStatus, ECONOMY_DISABLED_MESSAGE } = await import('./economy-manager.js');
        if (await economyStatus(message.guild.id) === 'disabled') {
            await message.reply({ content: ECONOMY_DISABLED_MESSAGE });
            return true;
        }
    }

    // Parse args based on command definition
    const parsedArgs = parseArgs(rawArgs, commandDef.args);

    // Check required args
    for (const argDef of (commandDef.args || [])) {
        if (argDef.required && !parsedArgs[argDef.name]) {
            const usage = commandDef.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ');
            await message.reply({ content: `Usage: \`${prefix}${commandName} ${usage}\`` });
            return true;
        }
    }

    // Build adapter
    const ctx = new MessageContextAdapter(message, commandName, parsedArgs);

    // Usage is recorded under the slash path this legacy command stands for when there is one
    // (`!play` -> "music play"), so the Commands page counts both ways in together.
    let usagePath = canonicalName;
    try {
        ensureIndex(message.client);
        const hit = resolveUniversal([canonicalName]);
        if (hit?.entry && hit.path) usagePath = hit.path;
    } catch { /* keep the legacy name */ }
    const usageStart = Date.now();
    try {
        const handler = await resolveHandler(commandDef.handler);
        try {
            await handler(ctx);
        } catch (runErr) {
            trackChatUse(message, usagePath.split(' ')[0], usagePath, prefix, usageStart, runErr);
            throw runErr;
        }
        trackChatUse(message, usagePath.split(' ')[0], usagePath, prefix, usageStart, null);
    } catch (error) {
        logger.error(`[PrefixCmd] Error executing !${commandName}:`, {
            error: error.message,
            stack: error.stack,
            guildId: message.guildId,
            userId: message.author.id,
            category: 'prefix'
        });

        // A mention is ambiguous — "@bot give me game ideas" starts with the real command `give`.
        // Hand the sentence to the AI rather than reporting a command failure. No-op for symbol
        // prefixes and for guilds without the assistant enabled.
        //
        // Deliberately NOT an early return: the cleanup below (private-category message deletion)
        // must still run whichever way this went.
        const answered = await tryAiFallback(message);
        if (!answered) {
            await message.reply({ content: 'Something went wrong running that command.' }).catch(() => {});
        }
    }

    // ── Cleanup logic ──
    const delayMs = privateReplyDelayMs(config, commandDef.category);

    // Delete the user's trigger message (e.g. "!ban @user")
    if (config.deleteTrigger) {
        message.delete().catch(() => {});
    }

    // Auto-delete bot response for private categories (moderation, etc.)
    if (delayMs && ctx._replyMessage) {
        setTimeout(() => {
            ctx._replyMessage?.delete().catch(() => {});
        }, delayMs);
    }

    return true;
}

/**
 * How long a reply to a command in `category` stays up before it deletes itself, in ms; 0 = never.
 * Only categories marked private self-destruct, and a delay of 0 turns it off (the Core page and
 * the cleanup command both say so; it used to fall back to 10 seconds).
 */
export function privateReplyDelayMs(config, category) {
    const seconds = Number(config?.cleanupDelay) || 0;
    if (seconds <= 0 || !config?.privateCategories?.has?.(category)) return 0;
    return Math.min(300, seconds) * 1000;
}

export default { handlePrefixCommand, getPrefix, invalidateGuildCache };
