import { MessageContextAdapter } from './message-context-adapter.js';
import { getCommand, getAllCommands, getCategories, getCommandsByCategory } from './prefix-command-registry.js';
import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import { runUniversalCommand, DEFAULT_PREFIXES, isKnownPath, resolve as resolveUniversal } from './universal-commands.js';
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
    const all = [...new Set([primary, ...list])].filter(p => typeof p === 'string' && p.length);
    return all.sort((a, b) => b.length - a.length);
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
    if (!config.enabled) return false;

    const stripped = stripPrefix(message, config);
    if (!stripped) return false;
    const { prefix, body: withoutPrefix } = stripped;
    if (!withoutPrefix) return false;

    const spaceIndex = withoutPrefix.indexOf(' ');
    let commandName = (spaceIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIndex)).toLowerCase();
    const rawArgs = spaceIndex === -1 ? '' : withoutPrefix.slice(spaceIndex + 1);

    // Check guild-specific aliases FIRST (override defaults)
    const guildAliases = await getGuildAliases(message.guildId);
    if (guildAliases.has(commandName)) {
        commandName = guildAliases.get(commandName);
    }

    // Look up command in the default registry
    const commandDef = getCommand(commandName);

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
        }
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

    try {
        const handler = await resolveHandler(commandDef.handler);
        await handler(ctx);
    } catch (error) {
        logger.error(`[PrefixCmd] Error executing !${commandName}:`, {
            error: error.message,
            stack: error.stack,
            guildId: message.guildId,
            userId: message.author.id,
            category: 'prefix'
        });

        await message.reply({ content: 'Something went wrong running that command.' }).catch(() => {});
    }

    // ── Cleanup logic ──
    const category = commandDef.category;
    const isPrivate = config.privateCategories.has(category);
    const delay = config.cleanupDelay || 10;

    // Delete the user's trigger message (e.g. "!ban @user")
    if (config.deleteTrigger) {
        message.delete().catch(() => {});
    }

    // Auto-delete bot response for private categories (moderation, etc.)
    if (isPrivate && ctx._replyMessage) {
        setTimeout(() => {
            ctx._replyMessage?.delete().catch(() => {});
        }, delay * 1000);
    }

    return true;
}

export default { handlePrefixCommand, getPrefix, invalidateGuildCache };
