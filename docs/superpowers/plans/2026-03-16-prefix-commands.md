# Prefix Command System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a prefix command system (`!play`, `!skip`, `!ban`, etc.) that exposes every slash command subcommand as a standalone prefix command, with no Discord slot limit.

**Architecture:** A `MessageContextAdapter` wraps Discord `Message` objects to look like `ChatInputCommandInteraction` — same `.reply()`, `.editReply()`, `.deferReply()`, `.options.getString()` API. A prefix command registry maps command names to existing handler functions. A `messageCreate` hook parses prefix + command + args, builds the adapter, and routes to the handler. Per-guild configurable prefix stored in DB.

**Tech Stack:** discord.js 14, existing handler functions, MySQL (guild config)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `core/prefix-command-manager.js` | Message parsing, routing, adapter creation, guild config resolution |
| `core/message-context-adapter.js` | Wraps `Message` to fake `Interaction` API for handlers |
| `core/prefix-command-registry.js` | Static (default) mapping of prefix commands → handler functions + arg definitions |
| `migrations/058_prefix_command_config.js` | DB tables: per-guild prefix/enabled + per-guild custom aliases |
| `events/messageCreate.js` | Add prefix command hook (early in handler chain) |
| `dashboard/routes/api/features/prefix-commands.js` | API routes for dashboard to manage prefix, aliases, disabled commands |
| `dashboard/views/partials/manage/prefix-commands.ejs` | Dashboard UI for prefix command configuration |

---

## Chunk 1: Message Context Adapter + Prefix Manager Core

### Task 1: Create the Message Context Adapter

**Files:**
- Create: `core/message-context-adapter.js`

The adapter must support these methods that handlers actually call:
- `interaction.reply({ content, embeds, ephemeral })` → `message.reply()`
- `interaction.editReply({ content, embeds })` → edit the bot's reply message
- `interaction.deferReply()` → send "typing" indicator, store reference for editReply
- `interaction.followUp()` → send additional message
- `interaction.options.getString('name')` → parse from positional args
- `interaction.options.getInteger('name')` → parse + parseInt
- `interaction.options.getUser('name')` → resolve mention/ID
- `interaction.options.getChannel('name')` → resolve channel mention/ID
- `interaction.options.getBoolean('name')` → parse true/false/yes/no
- `interaction.options.getSubcommand()` → return null (prefix commands are flat)
- `interaction.options.getSubcommandGroup()` → return null
- `interaction.member` → `message.member`
- `interaction.user` → `message.author`
- `interaction.guild` → `message.guild`
- `interaction.channel` → `message.channel`
- `interaction.channelId` → `message.channelId`
- `interaction.guildId` → `message.guildId`
- `interaction.client` → `message.client`
- `interaction.commandName` → the prefix command name
- `interaction.isCommand()` → `true`
- `interaction.isChatInputCommand()` → `true`

- [ ] **Step 1: Create `core/message-context-adapter.js`**

```javascript
import { Collection } from 'discord.js';
import logger from '../utils/logger.js';

/**
 * Wraps a Discord Message to look like a ChatInputCommandInteraction.
 * Allows existing slash command handlers to work with prefix commands.
 */
export class MessageContextAdapter {
    constructor(message, commandName, parsedArgs = {}) {
        this.message = message;
        this.commandName = commandName;
        this._parsedArgs = parsedArgs;
        this._replied = false;
        this._deferred = false;
        this._replyMessage = null;

        // Mirror interaction properties
        this.member = message.member;
        this.user = message.author;
        this.guild = message.guild;
        this.channel = message.channel;
        this.channelId = message.channelId;
        this.guildId = message.guildId;
        this.client = message.client;
        this.id = message.id;
        this.createdTimestamp = message.createdTimestamp;

        // Options resolver
        this.options = new PrefixOptionsResolver(parsedArgs, message);
    }

    isCommand() { return true; }
    isChatInputCommand() { return true; }
    isButton() { return false; }
    isSelectMenu() { return false; }
    isModalSubmit() { return false; }
    isAutocomplete() { return false; }

    async deferReply({ ephemeral } = {}) {
        if (this._deferred || this._replied) return;
        this._deferred = true;
        // Show typing indicator as the "deferred" equivalent
        await this.channel.sendTyping().catch(() => {});
    }

    async reply(options) {
        if (this._replied) return this.followUp(options);
        this._replied = true;

        const content = typeof options === 'string' ? options : undefined;
        const payload = typeof options === 'string' ? { content: options } : { ...options };

        // Strip ephemeral flag — prefix commands can't do ephemeral
        delete payload.ephemeral;
        delete payload.flags;

        try {
            this._replyMessage = await this.message.reply(payload);
            return this._replyMessage;
        } catch (error) {
            // If reply fails (e.g., message deleted), try sending to channel
            logger.warn('[PrefixCmd] reply() failed, sending to channel', { error: error.message });
            this._replyMessage = await this.channel.send(payload);
            return this._replyMessage;
        }
    }

    async editReply(options) {
        const payload = typeof options === 'string' ? { content: options } : { ...options };
        delete payload.ephemeral;
        delete payload.flags;

        if (this._replyMessage) {
            try {
                return await this._replyMessage.edit(payload);
            } catch {
                // Message may have been deleted
                this._replyMessage = await this.channel.send(payload);
                return this._replyMessage;
            }
        }
        // No reply yet — just send
        this._replied = true;
        this._replyMessage = await this.message.reply(payload);
        return this._replyMessage;
    }

    async followUp(options) {
        const payload = typeof options === 'string' ? { content: options } : { ...options };
        delete payload.ephemeral;
        delete payload.flags;
        return this.channel.send(payload);
    }

    async deleteReply() {
        if (this._replyMessage) {
            await this._replyMessage.delete().catch(() => {});
        }
    }
}

/**
 * Mimics interaction.options for prefix commands.
 * Maps named args (from the command definition) to parsed values.
 */
class PrefixOptionsResolver {
    constructor(parsedArgs, message) {
        this._args = parsedArgs;
        this._message = message;
    }

    getString(name, required) {
        return this._args[name] ?? null;
    }

    getInteger(name, required) {
        const val = this._args[name];
        if (val == null) return null;
        const num = parseInt(val, 10);
        return isNaN(num) ? null : num;
    }

    getNumber(name, required) {
        const val = this._args[name];
        if (val == null) return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
    }

    getBoolean(name, required) {
        const val = this._args[name]?.toLowerCase();
        if (val == null) return null;
        return ['true', 'yes', '1', 'on', 'enable'].includes(val);
    }

    getUser(name, required) {
        const val = this._args[name];
        if (!val) return null;
        // Try mention format <@123> or <@!123>
        const match = val.match(/^<@!?(\d+)>$/);
        const userId = match ? match[1] : val;
        return this._message.client.users.cache.get(userId) ?? null;
    }

    getMember(name, required) {
        const val = this._args[name];
        if (!val) return null;
        const match = val.match(/^<@!?(\d+)>$/);
        const userId = match ? match[1] : val;
        return this._message.guild?.members.cache.get(userId) ?? null;
    }

    getChannel(name, required) {
        const val = this._args[name];
        if (!val) return null;
        const match = val.match(/^<#(\d+)>$/);
        const channelId = match ? match[1] : val;
        return this._message.guild?.channels.cache.get(channelId) ?? null;
    }

    getRole(name, required) {
        const val = this._args[name];
        if (!val) return null;
        const match = val.match(/^<@&(\d+)>$/);
        const roleId = match ? match[1] : val;
        return this._message.guild?.roles.cache.get(roleId) ?? null;
    }

    getSubcommand() { return null; }
    getSubcommandGroup() { return null; }
    getAttachment(name) { return this._message.attachments.first() ?? null; }
}

export default MessageContextAdapter;
```

- [ ] **Step 2: Commit**
```bash
git add core/message-context-adapter.js
git commit -m "feat: add MessageContextAdapter for prefix command system"
```

---

### Task 2: Create the Prefix Command Registry

**Files:**
- Create: `core/prefix-command-registry.js`

This is the mapping of `!commandname` → `{ handler, args, description, category }`. Each entry defines:
- `name`: the prefix command name (e.g., `play`)
- `aliases`: alternative names (e.g., `p`)
- `args`: ordered list of `{ name, type, required, rest }` — `rest` means "consume all remaining text"
- `handler`: async function reference OR `{ file, method }` for lazy loading
- `category`: for help display
- `description`: short help text
- `permissions`: optional permission requirements

Start with the highest-value commands — music, moderation, info. More can be added incrementally.

- [ ] **Step 1: Create `core/prefix-command-registry.js`**

```javascript
/**
 * Prefix Command Registry
 *
 * Maps prefix commands to handler functions.
 * Each command defines its arg parsing rules so the adapter
 * can build the correct parsedArgs object.
 *
 * Arg types: 'string' | 'integer' | 'user' | 'channel' | 'role' | 'boolean'
 * Set `rest: true` on the last arg to capture all remaining text.
 */

const registry = new Map();

function register(name, definition) {
    registry.set(name, definition);
    if (definition.aliases) {
        for (const alias of definition.aliases) {
            registry.set(alias, { ...definition, isAlias: true, canonicalName: name });
        }
    }
}

// ═══════════════════════════════════════════════════════════
// MUSIC COMMANDS
// ═══════════════════════════════════════════════════════════

register('play', {
    description: 'Play a song or playlist',
    category: 'music',
    args: [{ name: 'query', type: 'string', required: true, rest: true }],
    handler: { file: '../../handlers/music/player.js', method: 'handlePlay' },
    aliases: ['p']
});

register('skip', {
    description: 'Skip the current song',
    category: 'music',
    args: [],
    handler: { file: '../../handlers/music/player.js', method: 'handleSkip' },
    aliases: ['s', 'next']
});

register('pause', {
    description: 'Pause the music',
    category: 'music',
    args: [],
    handler: { file: '../../handlers/music/player.js', method: 'handlePause' },
    aliases: []
});

register('resume', {
    description: 'Resume the music',
    category: 'music',
    args: [],
    handler: { file: '../../handlers/music/player.js', method: 'handleResume' },
    aliases: ['unpause']
});

register('stop', {
    description: 'Stop music and clear the queue',
    category: 'music',
    args: [],
    handler: { file: '../../handlers/music/player.js', method: 'handleStop' },
    aliases: ['dc', 'disconnect', 'leave']
});

register('nowplaying', {
    description: 'Show the currently playing song',
    category: 'music',
    args: [],
    handler: { file: '../../handlers/music/player.js', method: 'handleNowPlaying' },
    aliases: ['np', 'playing']
});

register('queue', {
    description: 'Show the music queue',
    category: 'music',
    args: [{ name: 'page', type: 'integer', required: false }],
    handler: { file: '../../handlers/music/queue.js', method: 'handleQueue' },
    aliases: ['q']
});

register('shuffle', {
    description: 'Shuffle the queue',
    category: 'music',
    args: [],
    handler: { file: '../../handlers/music/queue.js', method: 'handleShuffle' },
    aliases: []
});

register('volume', {
    description: 'Set the volume (0-100)',
    category: 'music',
    args: [{ name: 'level', type: 'integer', required: true }],
    handler: { file: '../../handlers/music/controls.js', method: 'handleVolume' },
    aliases: ['vol', 'v']
});

// ═══════════════════════════════════════════════════════════
// INFO COMMANDS
// ═══════════════════════════════════════════════════════════

register('userinfo', {
    description: 'Show info about a user',
    category: 'info',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../../commands/info/user.js', method: 'default.execute' },
    aliases: ['whois', 'ui']
});

register('serverinfo', {
    description: 'Show server info',
    category: 'info',
    args: [],
    handler: { file: '../../commands/info/server.js', method: 'default.execute' },
    aliases: ['si']
});

register('avatar', {
    description: "Show a user's avatar",
    category: 'info',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../../commands/info/user.js', method: 'default.execute' },
    aliases: ['av', 'pfp']
});

// ═══════════════════════════════════════════════════════════
// UTILITY COMMANDS
// ═══════════════════════════════════════════════════════════

register('ping', {
    description: 'Check bot latency',
    category: 'utility',
    args: [],
    handler: { file: '../../commands/tools/ping.js', method: 'default.execute' },
    aliases: []
});

register('prefix', {
    description: 'Show or change the prefix for this server',
    category: 'utility',
    args: [{ name: 'new_prefix', type: 'string', required: false }],
    handler: 'builtin:prefix',
    aliases: []
});

register('prefixhelp', {
    description: 'Show all available prefix commands',
    category: 'utility',
    args: [{ name: 'category', type: 'string', required: false }],
    handler: 'builtin:help',
    aliases: ['pcmds', 'phelp', 'commands']
});

// ═══════════════════════════════════════════════════════════

export function getCommand(name) {
    return registry.get(name.toLowerCase());
}

export function getAllCommands() {
    // Return only canonical entries (not aliases)
    return [...registry.entries()]
        .filter(([, def]) => !def.isAlias)
        .map(([name, def]) => ({ name, ...def }));
}

export function getCommandsByCategory(category) {
    return getAllCommands().filter(cmd => cmd.category === category);
}

export function getCategories() {
    return [...new Set(getAllCommands().map(cmd => cmd.category))];
}

export default registry;
```

- [ ] **Step 2: Commit**
```bash
git add core/prefix-command-registry.js
git commit -m "feat: add prefix command registry with music, info, and utility commands"
```

---

### Task 3: Create the Prefix Command Manager

**Files:**
- Create: `core/prefix-command-manager.js`

This is the core routing engine. Called from `messageCreate`, it:
1. Checks if the message starts with the guild's prefix
2. Parses command name + args
3. Looks up the command in the registry
4. Lazy-loads the handler function
5. Builds parsed args from the arg definitions
6. Creates a `MessageContextAdapter`
7. Calls the handler

- [ ] **Step 1: Create `core/prefix-command-manager.js`**

```javascript
import { MessageContextAdapter } from './message-context-adapter.js';
import { getCommand, getAllCommands, getCategories, getCommandsByCategory } from './prefix-command-registry.js';
import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PREFIX = '!';

// Cache: guildId → { prefix, disabledCommands, ts }
const guildConfigCache = new Map();
// Cache: guildId → Map<alias, commandName>
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
            'SELECT prefix, enabled, disabled_commands FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );
        const row = rows[0];
        const config = {
            prefix: row?.prefix || DEFAULT_PREFIX,
            enabled: row?.enabled ?? 1,
            disabledCommands: new Set(row?.disabled_commands ? JSON.parse(row.disabled_commands) : []),
            ts: Date.now()
        };
        guildConfigCache.set(guildId, config);
        return config;
    } catch {
        return { prefix: DEFAULT_PREFIX, enabled: 1, disabledCommands: new Set(), ts: Date.now() };
    }
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
 *   - 'builtin:name' — built-in commands (help, prefix)
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

    handlerCache.set(cacheKey, fn);
    return fn;
}

/**
 * Built-in prefix commands (help, prefix)
 */
function getBuiltinHandler(name) {
    switch (name) {
        case 'help': return handleHelp;
        case 'prefix': return handlePrefix;
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

/**
 * Main entry point — called from messageCreate event.
 * Returns true if the message was handled as a prefix command.
 */
export async function handlePrefixCommand(message) {
    if (!message.guild || message.author.bot) return false;

    const config = await getGuildConfig(message.guildId);
    if (!config.enabled) return false;

    const prefix = config.prefix;
    if (!message.content.startsWith(prefix)) return false;

    // Parse command name and raw args
    const withoutPrefix = message.content.slice(prefix.length).trim();
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
    if (!commandDef) return false; // Not a registered prefix command — ignore

    // Resolve to canonical name (in case the default registry matched an alias)
    const canonicalName = commandDef.canonicalName || commandName;

    // Check if this command is disabled in this guild
    if (config.disabledCommands.has(canonicalName)) {
        await message.reply({ content: 'This command is disabled in this server.' });
        return true;
    }

    // Parse args based on command definition
    const parsedArgs = parseArgs(rawArgs, commandDef.args);

    // Check required args
    for (const argDef of (commandDef.args || [])) {
        if (argDef.required && !parsedArgs[argDef.name]) {
            const prefix = await getPrefix(message.guildId);
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

        await message.reply({ content: `Something went wrong running that command.` }).catch(() => {});
    }

    return true;
}

export default { handlePrefixCommand, getPrefix, invalidateGuildCache };
```

- [ ] **Step 2: Commit**
```bash
git add core/prefix-command-manager.js
git commit -m "feat: add prefix command manager with routing, arg parsing, and built-in help"
```

---

## Chunk 2: Database Migration + Event Hook + Integration

### Task 4: Database Migration

**Files:**
- Create: `migrations/058_prefix_command_config.js`

- [ ] **Step 1: Create migration**

```javascript
export async function up(db) {
    // Core config: prefix, enabled, disabled commands per guild
    await db.execute(`
        CREATE TABLE IF NOT EXISTS prefix_command_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            prefix VARCHAR(5) NOT NULL DEFAULT '!',
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            disabled_commands JSON DEFAULT NULL
        )
    `);

    // Per-guild custom aliases: guild admins can add/rename/remove aliases
    // e.g., guild wants "!s" to mean "!stop" instead of "!skip"
    await db.execute(`
        CREATE TABLE IF NOT EXISTS prefix_command_aliases (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            alias VARCHAR(30) NOT NULL,
            command_name VARCHAR(50) NOT NULL,
            created_by VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild_alias (guild_id, alias),
            INDEX idx_guild (guild_id)
        )
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS prefix_command_aliases');
    await db.execute('DROP TABLE IF EXISTS prefix_command_config');
}
```

- [ ] **Step 2: Run migration**
```bash
node -e "
require('dotenv').config();
const mysql = require('mysql2/promise');
(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME
    });
    await conn.execute(\`
        CREATE TABLE IF NOT EXISTS prefix_command_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            prefix VARCHAR(5) NOT NULL DEFAULT '!',
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            disabled_commands JSON DEFAULT NULL
        )
    \`);
    await conn.execute(\`
        CREATE TABLE IF NOT EXISTS prefix_command_aliases (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            alias VARCHAR(30) NOT NULL,
            command_name VARCHAR(50) NOT NULL,
            created_by VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild_alias (guild_id, alias),
            INDEX idx_guild (guild_id)
        )
    \`);
    console.log('Migration 058 applied');
    await conn.end();
})();
"
```

- [ ] **Step 3: Commit**
```bash
git add migrations/058_prefix_command_config.js
git commit -m "feat: add migration 058 for prefix command config"
```

---

### Task 5: Hook into messageCreate

**Files:**
- Modify: `events/messageCreate.js` (add prefix command check early in the chain)

The prefix command check should run AFTER the bot message filter (line 128) and guild custom bot check (line 131), but BEFORE any other processing. If a prefix command is handled, return early.

- [ ] **Step 1: Add import and hook to `events/messageCreate.js`**

Add import near the top:
```javascript
import { handlePrefixCommand } from '../core/prefix-command-manager.js';
```

Add the hook after the `shouldIgnoreGuild` check (around line 132), before self-promo tracking:
```javascript
// Prefix command handling — runs before all other message processing
if (await handlePrefixCommand(message)) return;
```

- [ ] **Step 2: Commit**
```bash
git add events/messageCreate.js
git commit -m "feat: hook prefix command handler into messageCreate event"
```

---

### Task 6: Test End-to-End

- [ ] **Step 1: Restart PM2**
```bash
pm2 restart CertiFriedUtility
```

- [ ] **Step 2: Test in Discord**
1. `!play https://open.spotify.com/playlist/...` — should add tracks and play
2. `!skip` — should skip current track
3. `!np` — should show now playing
4. `!queue` — should show queue
5. `!ping` — should show latency
6. `!prefixhelp` — should show all prefix commands
7. `!prefix ?` — should change prefix to `?`
8. `?prefixhelp` — should work with new prefix
9. `?prefix !` — change back

- [ ] **Step 3: Verify no interference with existing features**
- Tag triggers (`!tag-name`) should still work — prefix commands are checked first, unrecognized commands fall through
- Song request channel behavior unchanged
- Counting game unchanged
- RPG handlers unchanged

---

## Chunk 3: Expand Command Registry (Incremental)

### Task 7: Add More Commands

After the core system is validated, expand `core/prefix-command-registry.js` with additional commands. These can be added incrementally — each is just a `register()` call.

**Priority commands to add next:**
- Moderation: `ban`, `kick`, `warn`, `mute`, `unmute`, `purge`, `slowmode`
- Economy: `balance`, `daily`, `pay`, `leaderboard`, `shop`, `buy`
- Leveling: `rank`, `level`, `xp`, `leaderboard`
- Fun: `meme`, `8ball`, `roll`, `flip`, `joke`
- Cannabis: `toke`, `strain`, `joint`
- Grow: `plant`, `water`, `harvest`, `garden`
- Games: `trivia`, `hangman`, `lfg`
- Social: `birthday`, `remind`, `suggest`, `report`

Each registration follows the same pattern:
```javascript
register('commandname', {
    description: 'What it does',
    category: 'category',
    args: [{ name: 'argname', type: 'string', required: true, rest: true }],
    handler: { file: '../../handlers/path/to/handler.js', method: 'handleFunctionName' },
    aliases: ['alias1', 'alias2']
});
```

**Note:** Some handlers may need minor adjustments if they use `interaction`-specific methods not covered by the adapter (e.g., `interaction.showModal()`). These edge cases should be handled by adding unsupported method stubs to the adapter that log a warning and send a message saying "This feature requires slash commands."

---

## Chunk 4: Guild Customization — Dashboard API + In-Discord Management

### Task 8: Dashboard API for Prefix Command Config

**Files:**
- Create: `dashboard/routes/api/features/prefix-commands.js`

Provides endpoints for the dashboard to manage prefix settings:
- `GET /:guildId/prefix-commands/config` — get prefix, enabled, disabled commands, custom aliases
- `PUT /:guildId/prefix-commands/config` — update prefix, enabled flag
- `GET /:guildId/prefix-commands/aliases` — list guild's custom aliases
- `POST /:guildId/prefix-commands/aliases` — add a custom alias
- `DELETE /:guildId/prefix-commands/aliases/:alias` — remove a custom alias
- `PUT /:guildId/prefix-commands/commands/:command/disable` — disable a command
- `PUT /:guildId/prefix-commands/commands/:command/enable` — enable a command
- `GET /:guildId/prefix-commands/available` — list all registered commands (for UI)

- [ ] **Step 1: Create the API route file**

```javascript
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { invalidateGuildCache } from '../../../../core/prefix-command-manager.js';
import { getAllCommands, getCategories } from '../../../../core/prefix-command-registry.js';

const router = express.Router({ mergeParams: true });

// GET config
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [configRows] = await pool.execute(
            'SELECT prefix, enabled, disabled_commands FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );
        const [aliasRows] = await pool.execute(
            'SELECT alias, command_name, created_by, created_at FROM prefix_command_aliases WHERE guild_id = ? ORDER BY alias',
            [guildId]
        );
        res.json({
            success: true,
            config: configRows[0] || { prefix: '!', enabled: 1, disabled_commands: null },
            aliases: aliasRows
        });
    } catch (error) {
        logger.error('[API PrefixCmd] Error fetching config:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch prefix command config' });
    }
});

// PUT config (prefix, enabled)
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { prefix, enabled } = req.body;

        if (prefix && prefix.length > 5) {
            return res.status(400).json({ error: 'Prefix must be 5 characters or less' });
        }

        await pool.execute(
            `INSERT INTO prefix_command_config (guild_id, prefix, enabled)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE prefix = VALUES(prefix), enabled = VALUES(enabled)`,
            [guildId, prefix || '!', enabled ? 1 : 0]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error updating config:', { error: error.message });
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// POST alias
router.post('/aliases', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { alias, command_name } = req.body;

        if (!alias || !command_name) {
            return res.status(400).json({ error: 'alias and command_name are required' });
        }
        if (alias.length > 30 || command_name.length > 50) {
            return res.status(400).json({ error: 'alias max 30 chars, command_name max 50 chars' });
        }

        await pool.execute(
            `INSERT INTO prefix_command_aliases (guild_id, alias, command_name, created_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE command_name = VALUES(command_name)`,
            [guildId, alias.toLowerCase(), command_name.toLowerCase(), req.user?.id || null]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error adding alias:', { error: error.message });
        res.status(500).json({ error: 'Failed to add alias' });
    }
});

// DELETE alias
router.delete('/aliases/:alias', async (req, res) => {
    try {
        const { guildId, alias } = req.params;
        await pool.execute(
            'DELETE FROM prefix_command_aliases WHERE guild_id = ? AND alias = ?',
            [guildId, alias.toLowerCase()]
        );
        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error removing alias:', { error: error.message });
        res.status(500).json({ error: 'Failed to remove alias' });
    }
});

// PUT disable command
router.put('/commands/:command/disable', async (req, res) => {
    try {
        const { guildId, command } = req.params;
        const [rows] = await pool.execute(
            'SELECT disabled_commands FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );

        let disabled = rows[0]?.disabled_commands ? JSON.parse(rows[0].disabled_commands) : [];
        if (!disabled.includes(command)) disabled.push(command);

        await pool.execute(
            `INSERT INTO prefix_command_config (guild_id, disabled_commands)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE disabled_commands = VALUES(disabled_commands)`,
            [guildId, JSON.stringify(disabled)]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error disabling command:', { error: error.message });
        res.status(500).json({ error: 'Failed to disable command' });
    }
});

// PUT enable command
router.put('/commands/:command/enable', async (req, res) => {
    try {
        const { guildId, command } = req.params;
        const [rows] = await pool.execute(
            'SELECT disabled_commands FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );

        let disabled = rows[0]?.disabled_commands ? JSON.parse(rows[0].disabled_commands) : [];
        disabled = disabled.filter(c => c !== command);

        await pool.execute(
            'UPDATE prefix_command_config SET disabled_commands = ? WHERE guild_id = ?',
            [JSON.stringify(disabled), guildId]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error enabling command:', { error: error.message });
        res.status(500).json({ error: 'Failed to enable command' });
    }
});

// GET available commands (for dashboard UI to populate dropdowns)
router.get('/available', async (req, res) => {
    const commands = getAllCommands();
    const categories = getCategories();
    res.json({ success: true, commands, categories });
});

export default router;
```

- [ ] **Step 2: Mount in API index**

In `dashboard/routes/api/index.js`, add:
```javascript
import prefixCommandsRoutes from './features/prefix-commands.js';
// ... and mount:
router.use('/guilds/:guildId/prefix-commands', prefixCommandsRoutes);
```

- [ ] **Step 3: Commit**
```bash
git add dashboard/routes/api/features/prefix-commands.js dashboard/routes/api/index.js
git commit -m "feat: add dashboard API routes for prefix command guild customization"
```

---

### Task 9: Add In-Discord Alias Management Commands

Add built-in prefix commands for server admins to manage aliases without the dashboard:

- `!alias add <alias> <command>` — create a guild alias
- `!alias remove <alias>` — remove a guild alias
- `!alias list` — list all guild aliases
- `!disable <command>` — disable a prefix command in this guild
- `!enable <command>` — enable a prefix command in this guild

- [ ] **Step 1: Add to `core/prefix-command-registry.js`**

```javascript
register('alias', {
    description: 'Manage custom command aliases for this server',
    category: 'utility',
    args: [
        { name: 'action', type: 'string', required: true },
        { name: 'alias_name', type: 'string', required: false },
        { name: 'target_command', type: 'string', required: false, rest: true }
    ],
    handler: 'builtin:alias',
    aliases: ['aliases']
});

register('disable', {
    description: 'Disable a prefix command in this server',
    category: 'utility',
    args: [{ name: 'command', type: 'string', required: true }],
    handler: 'builtin:disable',
    aliases: []
});

register('enable', {
    description: 'Enable a previously disabled prefix command',
    category: 'utility',
    args: [{ name: 'command', type: 'string', required: true }],
    handler: 'builtin:enable',
    aliases: []
});
```

- [ ] **Step 2: Add handlers in `core/prefix-command-manager.js`**

Add to the `getBuiltinHandler` switch:
```javascript
case 'alias': return handleAlias;
case 'disable': return handleDisable;
case 'enable': return handleEnable;
```

And the handler functions:

```javascript
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
        // Verify target command exists
        if (!getCommand(targetCommand)) {
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
```

- [ ] **Step 3: Commit**
```bash
git add core/prefix-command-registry.js core/prefix-command-manager.js
git commit -m "feat: add in-discord alias/disable/enable management commands"
```

---

### Task 10: Test Guild Customization

- [ ] **Step 1: Test alias creation**
```
!alias add s stop         → should create alias !s → !stop
!alias add sk skip        → should create alias !sk → !skip
!s                        → should run !stop
!sk                       → should run !skip
!alias list               → should show both aliases
!alias remove s           → should remove the !s alias
```

- [ ] **Step 2: Test command disabling**
```
!disable rpg              → should disable !rpg
!rpg                      → should say "This command is disabled"
!enable rpg               → should re-enable
!rpg                      → should work again
```

- [ ] **Step 3: Test prefix change persistence**
```
!prefix ?                 → change to ?
?prefixhelp               → should work
?alias list               → should show aliases
?prefix !                 → change back
```

---

## Design Decisions & Notes

**Why an adapter pattern instead of separate prefix handlers?**
- Avoids duplicating business logic across 300+ commands
- One bug fix applies to both slash and prefix versions
- New handlers automatically work with both systems

**Why lazy-load handlers?**
- The registry file stays lightweight (no heavy imports)
- Handlers are only imported when first used
- Cached after first load — no repeated imports

**Why per-guild prefix?**
- Different servers may use different bots with different prefixes (Carl uses `?`, MEE6 uses `!`)
- Avoids prefix collisions with other bots already in the server

**Why `rest: true` on args?**
- Commands like `!play never gonna give you up` need the entire remaining text as one arg
- Without `rest`, it would parse as `query: "never"` and drop the rest

**Why guild-level alias overrides?**
- Different servers have different conventions (Carl Bot uses `?`, MEE6 uses `!`, Dyno uses `?`)
- A server that replaced Dyno might want `?ban` to work, another might want `!ban`
- Guild admins know their community's preferences — let them control it
- Guild aliases take priority over default aliases — if default maps `!s` → `!skip` but a guild maps `!s` → `!stop`, the guild wins

**Why a separate `prefix_command_aliases` table instead of JSON in config?**
- Queryable — can search "which guilds use alias X?"
- Individual insert/delete without read-modify-write race conditions
- `created_by` tracking for audit purposes
- UNIQUE constraint prevents duplicate aliases per guild at the DB level

**Known limitations:**
- `ephemeral` responses are impossible with prefix commands — adapted to regular replies
- Autocomplete is unavailable — users must know the command and arg syntax
- `showModal()` is unavailable — commands that require modals should return a message saying to use the slash version
- File attachments from the message are available via `getAttachment()` but only the first one
- Guild aliases can shadow default command names (e.g., `!play` could be remapped to `!skip`) — this is intentional
