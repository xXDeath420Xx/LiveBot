import { Client, Collection, GatewayIntentBits, Partials, REST, Routes, Options } from 'discord.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import encryption from '../utils/encryption.js';
import { localizeCommands } from '../utils/command-localization.js';
import { fitCustomBotCommands, fitSlashLimit, MAX_SLASH_COMMANDS } from './custom-bot-commands.js';
import { buildShortcutJson, shortcutNamesByGuild, forgetMainBotGuilds } from './guild-shortcuts.js';
import { buildDeployJson } from './command-mounts.js';
import { withEntryPoint } from '../utils/entry-point-command.js';
import { jellyfinGuildCommandData } from '../cf-jellyfin/cf-jellyfin-commands.js';
import { logFeatureEvent } from './feature-log.js';
import { parseUnexpected429 } from '../utils/announcement-edit-governor.js';

/**
 * Turn an opaque discord.js login failure into something an operator can act on.
 *
 * The one that matters most here is gateway close 4014. Every bot in this
 * network requests three privileged intents (GuildMembers, MessageContent,
 * GuildPresences) and all three are load-bearing. Discord's policy changed on
 * 2026-06-10: the gate is now a 10,000-user threshold rather than a server
 * count, and approval must be renewed annually — per application, and this
 * network runs 41 separate applications.
 *
 * When approval lapses the bot does not degrade, it fails to connect at all,
 * and the raw message ("Used disallowed intents") gives no hint that the cause
 * is an expired approval on the developer portal rather than a code change.
 *
 * See docs/privileged-intents-compliance.md.
 *
 * @returns {{summary: string, remediation: string}|null} null when the failure
 *          is not one we have a specific diagnosis for.
 */
function diagnoseLoginFailure(error) {
    const code = error?.code;
    const message = String(error?.message || '');

    if (code === 4014 || /disallowed intent/i.test(message)) {
        return {
            summary: 'Disallowed intents (gateway 4014) — a privileged intent is not approved for this application',
            remediation:
                'Check Privileged Gateway Intents for this application in the Discord developer portal. ' +
                'We request GuildMembers, MessageContent and GuildPresences. Since 2026-06-10 approval ' +
                'expires annually and must be reapplied for per application. ' +
                'See docs/privileged-intents-compliance.md.',
        };
    }

    if (code === 4004 || /invalid token/i.test(message)) {
        return {
            summary: 'Invalid token (gateway 4004) — the stored token was rejected',
            remediation:
                'The bot token was reset or the encrypted value in custom_bots is stale. ' +
                'Re-enter the token; it is stored AES-256-GCM encrypted and decrypted via utils/encryption.js.',
        };
    }

    return null;
}

// Dashboard startup window (isStarting): grace after the last custom bot's login, and a cap.
const STARTUP_GRACE_MS = 30_000;
const STARTUP_MAX_MS = 5 * 60_000;

/**
 * Bot Manager - Manages multiple Discord client connections
 * Each bot instance shares the same commands, events, and database
 * Similar to MEE6's architecture where each server can use a custom bot
 */
class BotManager {
    constructor() {
        this.clients = new Map(); // Map<botId, ClientInstance>
        this.guildBotMapping = new Map(); // Map<guildId, botId>
        this.defaultBotId = 'default';
        this.commandLoader = null;
        this.eventLoader = null;
        this.managerInitializer = null;
        // Shared command collection - loaded once, used by all bots
        this.sharedCommands = null;
        // Startup window, for the dashboard (services/bot-readiness.js): until index.js has
        // logged in every custom bot, "no bot has this guild" may only mean "not yet".
        this.startedAt = Date.now();
        this.startupCompleteAt = null;
        // Auxiliary bots: clients logged in by a feature of their own (the audit bot in
        // events/globalBanReportWatcher.js) that run only that feature. Kept OUT of `clients` on
        // purpose: everything that loops over `clients` (event loaders, command deploys, guild
        // counts, scheduled jobs) must not pick them up. Only the dashboard looks here, so the
        // owner can manage the few settings these bots do use.
        this.auxClients = new Map(); // Map<key, { client, label, page }>
        // Last thing that went wrong per bot, for the dashboard's bot list (/bot-management):
        // a bot that failed to log in is not in `clients`, so without this the page could only
        // say "offline" with no reason. { message, kind: 'start'|'error'|'disconnect'|'invalidated', at }
        this.botErrors = new Map();
    }

    /** Register a feature-owned bot for dashboard management only (see auxClients above). */
    registerAuxiliaryClient(key, client, meta = {}) {
        this.auxClients.set(key, { key, client, label: meta.label || key, page: meta.page || key });
    }

    /** The auxiliary bot that is in this guild, when no regular bot is: { key, client, label, page } or null. */
    getAuxiliaryForGuild(guildId) {
        for (const aux of this.auxClients.values()) {
            if (aux.client?.isReady?.() && aux.client.guilds.cache.has(guildId)) return aux;
        }
        return null;
    }

    /**
     * Log Discord REST rate limits per bot. Before this nothing recorded them, so when one bot's
     * requests stalled (KumaCord, 2026-11-17 22:04) there was no evidence of why. Throttled to one
     * line per bot + route per minute.
     */
    attachRestDiagnostics(client, label) {
        const last = new Map();
        client.rest.on('rateLimited', (info) => {
            const key = `${info.global ? 'global' : info.route}`;
            if (Date.now() - (last.get(key) || 0) < 60_000) return;
            last.set(key, Date.now());
            logger.warn(`[DiscordREST] ${label} rate limited`, {
                route: info.route, method: info.method, global: info.global, scope: info.scope,
                limit: info.limit, retryAfterMs: info.retryAfter ?? info.timeToReset, category: 'discord-rest'
            });
        });
        // A 429 discord.js did not see coming (shared / sub-limits, e.g. message edits) does not emit
        // 'rateLimited': discord.js just sleeps for Retry-After and every later request on that route
        // waits behind it. It is only visible in the debug stream (H-311).
        client.rest.on('restDebug', (message) => {
            const hit = parseUnexpected429(message);
            if (!hit) return;
            const key = `429:${hit.global ? 'global' : hit.route}`;
            if (Date.now() - (last.get(key) || 0) < 60_000) return;
            last.set(key, Date.now());
            logger.warn(`[DiscordREST] ${label} got an unexpected 429`, {
                route: hit.route, method: hit.method, global: hit.global, scope: hit.scope,
                majorParameter: hit.majorParameter, retryAfterMs: hit.retryAfterMs, sublimitMs: hit.sublimitMs,
                category: 'discord-rest'
            });
        });
    }

    /** index.js calls this once every custom bot has had its login attempt. */
    markStartupComplete() {
        if (!this.startupCompleteAt) this.startupCompleteAt = Date.now();
    }

    /**
     * True while bots are still coming online: before markStartupComplete() (capped at
     * STARTUP_MAX_MS in case startup threw before reaching it) and for STARTUP_GRACE_MS after,
     * while the last bots' guild caches fill.
     */
    isStarting(now = Date.now()) {
        if (this.startupCompleteAt) return now - this.startupCompleteAt < STARTUP_GRACE_MS;
        return now - this.startedAt < STARTUP_MAX_MS;
    }

    /**
     * Create a new bot client with standard configuration
     */
    createClient() {
        return new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
                GatewayIntentBits.GuildInvites,
                GatewayIntentBits.GuildPresences,
                GatewayIntentBits.GuildModeration,
                GatewayIntentBits.GuildEmojisAndStickers,
                GatewayIntentBits.GuildIntegrations,
                GatewayIntentBits.AutoModerationConfiguration,
                GatewayIntentBits.AutoModerationExecution,
                // Without it no guildScheduledEvent* event ever arrives (event logs, event reminders).
                GatewayIntentBits.GuildScheduledEvents,
                GatewayIntentBits.DirectMessages
            ],
            partials: [
                Partials.Message,
                Partials.Channel,
                Partials.Reaction,
                Partials.User,
                Partials.GuildMember,
                Partials.GuildScheduledEvent
            ],
            makeCache: Options.cacheWithLimits({
                ...Options.DefaultMakeCacheSettings,
                MessageManager: 50,           // 50 messages per channel (default unlimited)
                GuildMemberManager: {         // 200 members per guild (default unlimited)
                    maxSize: 200,
                    // The object form is required: a plain number drops this, the bot's own member gets
                    // evicted in larger servers, and guild.members.me comes back as a blank partial with no
                    // roles, so every permission check says no.
                    keepOverLimit: (member) => member.id === member.client.user.id,
                },
                PresenceManager: 200,         // Limit cached presences per guild (startup scan reads from cache)
                // Emojis and stickers stay cached (the default). With a 0 limit discord.js could not diff
                // emoji/sticker updates: every update fired a create for every existing one (a log storm)
                // and deletes/renames never fired, and everything reading guild.emojis.cache (/server,
                // backups, /emoji, takeover, emoji hunts) saw an empty list. A few hundred small objects.
                ThreadManager: 0,             // Rarely needed from cache
            }),
            sweepers: {
                ...Options.DefaultSweeperSettings,
                messages: {
                    interval: 300,   // Sweep every 5 minutes
                    lifetime: 1800,  // Remove messages older than 30 minutes
                },
            },
        });
    }

    /**
     * Initialize the default bot (main CertiFried Utility bot)
     */
    async initializeDefaultBot(token) {
        const client = this.createClient();
        this.attachRestDiagnostics(client, 'main');
        client.botId = this.defaultBotId;
        client.isDefaultBot = true;

        // Initialize collections
        client.commands = new Collection();
        client.cooldowns = new Collection();

        await this.attachLoaders(client);

        // Store the loaded commands as shared for other bots to use
        this.sharedCommands = client.commands;
        logger.info(`[BotManager] Shared command collection initialized with ${this.sharedCommands.size} commands`);

        this.setupReconnectionHandler(client);

        try {
            await client.login(token);
        } catch (loginError) {
            // The default bot previously logged in bare, so an intent or token
            // failure surfaced as an unannotated stack trace at startup.
            const diagnosis = diagnoseLoginFailure(loginError);
            logger.error('[BotManager] ❌ Default bot login failed:', {
                error: loginError.message,
                code: loginError.code,
                ...(diagnosis ? { diagnosis: diagnosis.summary, remediation: diagnosis.remediation } : {})
            });
            throw loginError;
        }

        this.clients.set(this.defaultBotId, client);
        logger.info('[BotManager] Default bot initialized');

        // Deploy global slash commands for the default bot. Custom bots get this
        // in addCustomBot(), but the default path used to skip it and required a
        // manual push. Hash-cached in DB (guild_id = '') so we only PUT when
        // command set actually changes.
        //
        // deployCommandsForBot needs the actual Discord application snowflake
        // (numeric) to build the Routes.applicationCommands URL — NOT the
        // string label 'default' that we store in this.defaultBotId.
        // client.application.id (set post-login) is the true bot snowflake.
        try {
            const realBotId = client.application?.id || client.user?.id;
            if (realBotId) {
                await this.deployCommandsForBot(client, realBotId);
            } else {
                logger.warn('[BotManager] Default bot: no application/user id — cannot deploy commands');
            }
        } catch (e) {
            logger.error('[BotManager] Default bot command deploy failed:', { error: e.message });
        }

        return client;
    }

    /**
     * Add a custom bot for specific guilds
     * @param {object} botConfig - Bot configuration
     * @param {string} botConfig.bot_id - Discord bot user ID
     * @param {object} botConfig.bot_token - Encrypted token object {iv, encryptedData, authTag}
     * @param {string[]} botConfig.guild_ids - Array of guild IDs this bot serves
     */
    async addCustomBot(botConfig) {
        const { bot_id, bot_name, bot_token, guild_ids } = botConfig;

        try {
            logger.info(`[BotManager] Step 1/7: Decrypting token for ${bot_name}...`);

            // Decrypt token before use
            let decryptedToken;
            try {
                decryptedToken = encryption.decrypt(bot_token);
                logger.info(`[BotManager] Step 1/7: ✅ Token decrypted successfully for ${bot_name}`);
            } catch (decryptError) {
                logger.error(`[BotManager] Step 1/7: ❌ Token decryption failed for ${bot_name}:`, {
                    error: decryptError.message,
                    bot_id,
                    tokenStructure: bot_token ? Object.keys(bot_token) : 'null'
                });
                throw new Error(`Token decryption failed: ${decryptError.message}`);
            }

            logger.info(`[BotManager] Step 2/7: Creating Discord client for ${bot_name}...`);
            const client = this.createClient();
            this.attachRestDiagnostics(client, bot_name || bot_id);
            client.botId = bot_id;
            client.botName = bot_name; // Add bot name to client
            client.isDefaultBot = false;
            client.assignedGuilds = guild_ids;

            // Use shared commands from default bot instead of loading again (saves ~20MB memory per bot)
            if (this.sharedCommands) {
                client.commands = this.sharedCommands;
                logger.info(`[BotManager] Step 2/7: ✅ Using shared command collection (${client.commands.size} commands)`);
            } else {
                client.commands = new Collection();
                logger.warn(`[BotManager] Step 2/7: Shared commands not available, loading fresh`);
            }
            client.cooldowns = new Collection();
            logger.info(`[BotManager] Step 2/7: ✅ Discord client created for ${bot_name}`);

            logger.info(`[BotManager] Step 3/7: Attaching event loaders for ${bot_name}...`);
            // Only load events, not commands (commands are shared)
            if (this.eventLoader) {
                await this.eventLoader(client);
            }
            // Only load commands if shared commands weren't available
            if (!this.sharedCommands && this.commandLoader) {
                await this.commandLoader(client);
            }
            logger.info(`[BotManager] Step 3/7: ✅ Loaders attached (${client.commands.size} commands) for ${bot_name}`);

            logger.info(`[BotManager] Step 4/7: Setting up reconnection handler for ${bot_name}...`);
            this.setupReconnectionHandler(client);
            logger.info(`[BotManager] Step 4/7: ✅ Reconnection handler set up for ${bot_name}`);

            logger.info(`[BotManager] Step 5/7: Logging in to Discord for ${bot_name}...`);
            try {
                await client.login(decryptedToken);
                logger.info(`[BotManager] Step 5/7: ✅ Successfully logged in to Discord as ${bot_name}`);
            } catch (loginError) {
                const diagnosis = diagnoseLoginFailure(loginError);
                logger.error(`[BotManager] Step 5/7: ❌ Login failed for ${bot_name}:`, {
                    error: loginError.message,
                    code: loginError.code,
                    bot_id,
                    tokenLength: decryptedToken ? decryptedToken.length : 0,
                    ...(diagnosis ? { diagnosis: diagnosis.summary, remediation: diagnosis.remediation } : {})
                });
                throw new Error(`Discord login failed: ${diagnosis ? diagnosis.summary : loginError.message}`);
            }

            logger.info(`[BotManager] Step 6/7: Registering bot ${bot_name} in bot manager...`);
            this.clients.set(bot_id, client);

            // Map guilds to this bot
            for (const guildId of guild_ids) {
                this.guildBotMapping.set(guildId, bot_id);
            }
            logger.info(`[BotManager] Step 6/7: ✅ Bot ${bot_name} registered, managing ${guild_ids.length} guild(s)`);

            logger.info(`[BotManager] Step 7/7: Deploying slash commands for ${bot_name}...`);
            // Deploy commands to Discord automatically (don't throw on failure)
            await this.deployCommandsForBot(client, bot_id);
            logger.info(`[BotManager] Step 7/7: ✅ Command deployment completed for ${bot_name}`);

            // Managers last: until they exist the client cannot actually serve a command, and
            // events/interactionCreate.js refuses interactions until this sets managersReady.
            if (this.managerInitializer) {
                logger.info(`[BotManager] Step 8/8: Attaching feature managers for ${bot_name}...`);
                try {
                    await this.managerInitializer(client);
                    logger.info(`[BotManager] Step 8/8: ✅ Managers attached for ${bot_name}`);
                } catch (managerError) {
                    // initializeManagers flags readiness in a finally, so the bot still opens for
                    // business — but a partial manager set is worth shouting about.
                    logger.error(`[BotManager] Step 8/8: ❌ Manager init failed for ${bot_name}: ${managerError.message}`, { stack: managerError.stack });
                }
            } else {
                logger.error(`[BotManager] No manager initializer registered — ${bot_name} would serve nothing. `
                    + 'Call botManager.setManagerInitializer() during startup.');
            }

            logger.info(`[BotManager] 🎉 Custom bot ${bot_name} (${bot_id}) fully initialized and ready!`);
            this.botErrors.delete(bot_id);

            return client;
        } catch (error) {
            logger.error(`[BotManager] ❌ CRITICAL: Failed to initialize bot ${bot_name} (${bot_id}):`, {
                error: error.message,
                stack: error.stack,
                code: error.code,
                bot_id,
                bot_name
            });
            this.recordBotError(bot_id, error.message, 'start');
            throw error;
        }
    }

    /**
     * Deploy slash commands to Discord API for a specific bot. Runs one at a time per bot: two
     * PUTs racing on a guild left a duplicate command on Discord. A queued run skips on the hash.
     */
    deployCommandsForBot(client, botId) {
        this.deployQueues ??= new Map();
        const run = (this.deployQueues.get(botId) || Promise.resolve()).then(() => this.runCommandDeploy(client, botId));
        this.deployQueues.set(botId, run.catch(() => {}));
        return run;
    }

    async runCommandDeploy(client, botId) {
        // Operator switch: while a .deploy-paused file exists in the repo root, slash commands are not pushed to
        // Discord (used 2026-11-18 to ship urgent fixes while the slash/text command split was mid-way).
        if (fs.existsSync(path.join(process.cwd(), '.deploy-paused'))) {
            logger.warn(`[Deploy] command deploy for ${botId} skipped: .deploy-paused is present`);
            return;
        }
        try {
            // Extract command data from client.commands collection
            // localizeCommands mutates in place and returns the same array. Applied
            // here so every custom bot gets the same localized payload the default
            // bot does — and so the deploy hash reflects the localized content,
            // which means adding a translation correctly triggers a re-push.
            // guildScoped commands (cannabis features) are held back from the DEFAULT bot's
            // payload, which is global and is what the App Directory reviews. Custom bots
            // deploy per-guild and go through fitCustomBotCommands, because Discord rejects the
            // whole payload past 100 slash commands. Filtering before the hash keeps the
            // deploy-skip check honest.
            // buildDeployJson folds moved commands into their parents (core/command-mounts.js).
            const builtCommands = buildDeployJson(Array.from(client.commands.values())
                .filter(cmd => !(client.isDefaultBot && cmd.guildScoped))
                .filter(cmd => cmd.data?.toJSON));
            const localized = localizeCommands(builtCommands);
            const fit = (reserve = 0) => {
                // The default bot's global payload has the same 100 cap; it reached exactly 100 on 2026-11-05.
                const fitted = client.isDefaultBot ? fitSlashLimit(localized, reserve) : fitCustomBotCommands(localized, reserve);
                if (fitted.overBy) {
                    logger.error(`[BotManager] bot ${botId}: ${fitted.overBy} slash command(s) over Discord's limit — add more to OVERFLOW_ORDER in core/custom-bot-commands.js`);
                }
                return fitted.commands;
            };
            const commandData = fit();

            if (commandData.length === 0) {
                logger.warn(`[BotManager] No commands found to deploy for bot ${botId}`);
                return;
            }

            // Hash the payload so we can skip re-deploys when nothing changed.
            // Discord rate-limits command creates at ~200/day per guild — every
            // PM2 restart used to burn through that budget for no benefit.
            const { createHash } = await import('crypto');
            const hashOf = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
            const hash = hashOf(commandData);
            const pool = (await import('../utils/db.js')).default;

            // retries: 0 — without this, discord.js silently auto-retries 429s
            // forever, masking rate-limits as "timeout after Xms" so we can't
            // tell whether Discord is rate-limiting us or actually slow.
            // timeout: 60s — large enough for legitimate slow bulk PUTs.
            const rest = new REST({ retries: 0, timeout: 60_000 }).setToken(client.token);

            // For custom bots, deploy to specific guilds instead of globally.
            // Wrapped in a hard timeout because discord.js's REST handler will
            // silently auto-retry 429s forever — without this, a rate-limited
            // bot's deploy never resolves AND never rejects, hanging Step 7/7
            // for that bot's whole uptime.
            // 90s timeout: bulk PUT to applicationGuildCommands can legitimately
            // take 30-60s when the bot has 80+ commands and Discord is busy.
            // 20s was too aggressive — Kitsune kept timing out on real deploys.
            const DEPLOY_TIMEOUT_MS = 90_000;
            const BLOCK_BACKOFF_MS = 30 * 60 * 1000;   // 30 min (was 1h — too long for transient slowness)
            const withTimeout = (p, ms, label) => Promise.race([
                p,
                new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms))
            ]);

            if (!client.isDefaultBot && client.assignedGuilds && client.assignedGuilds.length > 0) {
                let successCount = 0, skipped = 0, blocked = 0;
                // Per-server shortcuts (/confess for /fun confess), core/guild-shortcuts.js.
                const shortcutNames = await shortcutNamesByGuild(client.assignedGuilds).catch(e => {
                    logger.warn(`[BotManager] bot ${botId}: shortcut lookup failed, deploying without them: ${e.message}`);
                    return new Map();
                });
                this.shortcutSigs ??= new Map();
                for (const guildId of client.assignedGuilds) {
                    try {
                        // A guild_bot_mapping row outlives the bot's membership: when a bot
                        // is kicked, the mapping stays and every restart then tries to PUT
                        // commands into a guild it isn't in, failing with "Missing Access".
                        // Checking this bot's own cache is self-correcting — a re-invite puts
                        // the guild back in cache and deploys resume with no manual cleanup.
                        //
                        // Gated on isReady() rather than a non-empty cache: discord.js fills
                        // guilds.cache during READY, so once ready the cache is authoritative
                        // even when it's empty — and empty is exactly the case here, a bot
                        // kicked from the only guild it was mapped to.
                        if (client.isReady() && !client.guilds.cache.has(guildId)) {
                            skipped++;
                            logger.warn(`[BotManager] bot ${botId} is not a member of guild ${guildId} — skipping deploy (stale guild_bot_mapping row?)`);
                            continue;
                        }

                        // The PUT below replaces the guild's whole list, so a guild-only command left
                        // out is wiped, and with the list at 100 it could not be added back.
                        const extras = jellyfinGuildCommandData(guildId);
                        const base = extras.length ? fit(extras.length) : commandData;
                        // Shortcuts only take slots the real commands leave free; they never push one out.
                        const free = MAX_SLASH_COMMANDS - base.filter(c => (c.type ?? 1) === 1).length - extras.length;
                        const names = shortcutNames.get(String(guildId)) || [];
                        const shortcuts = buildShortcutJson(localized, names).slice(0, Math.max(0, free));
                        this.shortcutSigs.set(`${botId}:${guildId}`, names.join(','));
                        const guildData = [...base, ...extras, ...shortcuts];
                        const guildHash = (extras.length || shortcuts.length) ? hashOf(guildData) : hash;

                        const [[prev]] = await pool.execute(
                            'SELECT hash, blocked_until FROM command_deploy_hashes WHERE bot_id = ? AND guild_id = ?',
                            [botId, guildId]
                        );
                        if (prev?.hash === guildHash) { skipped++; continue; }
                        // Honor active block (rate-limited recently — don't pile on)
                        if (prev?.blocked_until && new Date(prev.blocked_until) > new Date()) {
                            blocked++;
                            logger.warn(`[BotManager] bot ${botId} guild ${guildId}: skipping (blocked until ${prev.blocked_until})`);
                            continue;
                        }
                        await withTimeout(
                            rest.put(Routes.applicationGuildCommands(botId, guildId), { body: guildData }),
                            DEPLOY_TIMEOUT_MS,
                            `deploy ${botId}/${guildId}`
                        );
                        await pool.execute(
                            `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
                             VALUES (?, ?, ?, NULL, NULL)
                             ON DUPLICATE KEY UPDATE hash = VALUES(hash), deployed_at = NOW(), blocked_until = NULL, last_block_reason = NULL`,
                            [botId, guildId, guildHash]
                        );
                        successCount++;
                    } catch (guildError) {
                        this.shortcutSigs.delete(`${botId}:${guildId}`);   // not deployed: let the shortcut check retry
                        const isTimeout = /timeout/i.test(guildError.message);
                        const isRateLimit = guildError.code === 429 || guildError.status === 429 || /rate.?limit/i.test(guildError.message);
                        // Discord error 30034 = daily command-create budget exhausted.
                        // Resets 24h after first create of the day. Block 25h to be safe —
                        // any earlier retry just burns future budget and re-extends the block.
                        const isDailyLimit = guildError.code === 30034
                            || /daily application command creates/i.test(guildError.message)
                            || /max number of daily/i.test(guildError.message);
                        if (isDailyLimit) {
                            const until = new Date(Date.now() + 25 * 60 * 60 * 1000);
                            await pool.execute(
                                `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
                                 VALUES (?, ?, '', ?, ?)
                                 ON DUPLICATE KEY UPDATE blocked_until = VALUES(blocked_until), last_block_reason = VALUES(last_block_reason)`,
                                [botId, guildId, until, `DAILY-LIMIT-30034: ${guildError.message}`.slice(0, 240)]
                            );
                            logger.error(`[BotManager] bot ${botId} guild ${guildId}: DAILY COMMAND-CREATE BUDGET EXHAUSTED (200/day Discord cap) — blocking deploys for 25h until ${until.toISOString()}`);
                            void logFeatureEvent(() => (client.guilds.cache.get(guildId)), 'system.commandsFailed', () => ({
                                title: '❌ Command Registration Failed',
                                description: 'Discord refused to update this server\'s slash commands: the bot hit Discord\'s daily limit for registering commands. The bot will try again automatically.',
                                fields: [['Bot', client.user?.tag || botId], ['Retrying', `<t:${Math.floor(until.getTime() / 1000)}:R>`]],
                                throttle: { key: 'cmds-fail:' + guildId, ms: 6 * 3600e3 },
                            }));
                        } else if (isTimeout || isRateLimit) {
                            const until = new Date(Date.now() + BLOCK_BACKOFF_MS);
                            await pool.execute(
                                `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash, blocked_until, last_block_reason)
                                 VALUES (?, ?, '', ?, ?)
                                 ON DUPLICATE KEY UPDATE blocked_until = VALUES(blocked_until), last_block_reason = VALUES(last_block_reason)`,
                                [botId, guildId, until, guildError.message.slice(0, 240)]
                            );
                            logger.warn(`[BotManager] bot ${botId} guild ${guildId}: ${isTimeout ? 'TIMEOUT' : 'RATE LIMIT'} — backing off until ${until.toISOString()}`);
                        } else {
                            logger.error(`[BotManager] Failed to deploy commands to guild ${guildId}:`, {
                                error: guildError.message, botId, guildId
                            });
                            void logFeatureEvent(() => (client.guilds.cache.get(guildId)), 'system.commandsFailed', () => ({
                                title: '❌ Command Registration Failed',
                                description: 'Discord refused to update this server\'s slash commands, so new or changed commands may be missing. The bot tries again the next time it updates its commands.',
                                fields: [['Bot', client.user?.tag || botId], ['Why', String(guildError.message || 'Unknown error').slice(0, 300)]],
                                throttle: { key: 'cmds-fail:' + guildId, ms: 6 * 3600e3 },
                            }));
                        }
                    }
                }
                logger.info(`[BotManager] bot ${botId}: deployed ${successCount}, skipped ${skipped} unchanged, ${blocked} blocked of ${client.assignedGuilds.length} guild(s)`);

                // Hide the default bot's global commands in this guild by deploying
                // empty guild commands for the default bot. Guild commands override
                // global commands, so this prevents users from seeing duplicate commands.
                await this.hideDefaultBotCommandsInGuilds(client.assignedGuilds);
            } else {
                // Default bot uses global commands — same hash-skip pattern.
                const [[prev]] = await pool.execute(
                    `SELECT hash FROM command_deploy_hashes WHERE bot_id = ? AND guild_id = ''`,
                    [botId]
                );
                if (prev?.hash === hash) {
                    logger.info(`[BotManager] bot ${botId}: global commands unchanged, skipping deploy`);
                } else {
                    const deployed = await rest.put(
                        Routes.applicationCommands(botId),
                        // Keeps the Discord Activity's Entry Point command, which Discord will not let a bulk update drop.
                        { body: await withEntryPoint(rest, botId, commandData) }
                    );
                    await pool.execute(
                        `INSERT INTO command_deploy_hashes (bot_id, guild_id, hash) VALUES (?, '', ?)
                         ON DUPLICATE KEY UPDATE hash = VALUES(hash), deployed_at = NOW()`,
                        [botId, hash]
                    );
                    logger.info(`[BotManager] Deployed ${deployed.length} global slash commands for bot ${botId}`);
                }
            }
        } catch (error) {
            logger.error(`[BotManager] Failed to deploy commands for bot ${botId}:`, {
                error: error.message,
                stack: error.stack
            });
            // Don't throw - bot can still function without slash commands deployed
        }
    }

    /**
     * Hide the default bot's commands in guilds that have custom bots.
     * Deploys an empty guild command set for the default bot, which overrides
     * its global commands in those specific guilds.
     */
    async hideDefaultBotCommandsInGuilds(guildIds) {
        const defaultClient = this.clients.get(this.defaultBotId);
        if (!defaultClient || !defaultClient.token) {
            logger.warn('[BotManager] Cannot hide default bot commands - default bot not available');
            return;
        }

        const rest = new REST().setToken(defaultClient.token);
        const defaultAppId = defaultClient.application?.id || process.env.DISCORD_CLIENT_ID;

        if (!defaultAppId) {
            logger.warn('[BotManager] Cannot hide default bot commands - no application ID');
            return;
        }

        for (const guildId of guildIds) {
            try {
                await rest.put(
                    Routes.applicationGuildCommands(defaultAppId, guildId),
                    { body: [] }
                );
                logger.info(`[BotManager] Hidden default bot commands in guild ${guildId} (custom bot active)`);
                // That PUT also removed the main bot's shortcuts here; forget them so they come back if the
                // server returns to the main bot.
                await forgetMainBotGuilds(defaultAppId, [guildId]).catch(() => {});
            } catch (error) {
                // "Missing Access" means the default bot isn't in this guild,
                // so its global commands won't show there anyway - not a problem
                if (error.message?.includes('Missing Access') || error.status === 403) {
                    logger.debug(`[BotManager] Default bot not in guild ${guildId}, no commands to hide (OK)`);
                } else {
                    logger.error(`[BotManager] Failed to hide default bot commands in guild ${guildId}:`, {
                        error: error.message
                    });
                }
            }
        }
    }

    /**
     * Retry deployments that were blocked but whose backoff has now expired.
     * Without this, a bot that fails its boot deploy stays without commands
     * until the next PM2 restart — even after the block clears in DB.
     * Called by a 5-min scheduler in index.js.
     */
    async retryBlockedDeployments() {
        const pool = (await import('../utils/db.js')).default;
        try {
            // Rows with empty hash that were blocked but the block has now lapsed.
            // (deployed rows have a real hash; never-deployed rows have '')
            const [rows] = await pool.execute(
                `SELECT bot_id, guild_id FROM command_deploy_hashes
                 WHERE hash = '' AND blocked_until IS NOT NULL AND blocked_until < NOW()`
            );
            if (rows.length === 0) return;

            const grouped = new Map();
            for (const r of rows) {
                if (!grouped.has(r.bot_id)) grouped.set(r.bot_id, []);
                grouped.get(r.bot_id).push(r.guild_id);
            }

            for (const [botId, guildIds] of grouped.entries()) {
                const client = this.clients.get(botId);
                if (!client || !client.token) continue;
                logger.info(`[BotManager] Retrying blocked deploy for bot ${botId} (${guildIds.length} guild(s))`);
                // Clear stale block so deployCommandsForBot doesn't immediately skip
                await pool.execute(
                    `UPDATE command_deploy_hashes
                     SET blocked_until = NULL, last_block_reason = NULL
                     WHERE bot_id = ? AND guild_id IN (${guildIds.map(() => '?').join(',')})`,
                    [botId, ...guildIds]
                );
                await this.deployCommandsForBot(client, botId).catch(err => {
                    logger.error(`[BotManager] Retry deploy failed for ${botId}:`, { error: err.message });
                });
            }
        } catch (err) {
            logger.error('[BotManager] retryBlockedDeployments error:', { error: err.message });
        }
    }

    /**
     * Remove a custom bot
     */
    async removeCustomBot(botId) {
        const client = this.clients.get(botId);
        if (!client) {
            throw new Error(`Bot ${botId} not found`);
        }
        if (client.isDefaultBot) {
            throw new Error('Cannot remove default bot');
        }

        // Remove guild mappings
        for (const [guildId, mappedBotId] of this.guildBotMapping.entries()) {
            if (mappedBotId === botId) {
                this.guildBotMapping.delete(guildId);
            }
        }

        // Destroy client
        client.destroy();
        this.clients.delete(botId);

        logger.info(`[BotManager] Custom bot ${botId} removed`);
    }

    /**
     * Get the appropriate client for a guild
     * 1. Try the mapped custom bot first
     * 2. Search ALL connected clients for one that has the guild in cache
     * 3. Fall back to default bot only as last resort
     */
    getClientForGuild(guildId) {
        // Try mapped bot first — but only if it actually has the guild cached.
        // A mapped bot may be "ready" (gateway handshake done) yet still not
        // have this guild, e.g. right after self-service creation before the
        // user completes the OAuth invite. Cache presence is the truth check.
        const botId = this.guildBotMapping.get(guildId);
        if (botId && this.clients.has(botId)) {
            const client = this.clients.get(botId);
            if (client.isReady() && client.guilds.cache.has(guildId)) {
                return client;
            }
        }

        // Fall through: find any ready client that actually has this guild cached
        for (const [id, client] of this.clients) {
            if (client.isReady() && client.guilds.cache.has(guildId)) {
                return client;
            }
        }

        // Last resort fallback to default bot
        return this.clients.get(this.defaultBotId);
    }

    /**
     * Get all connected clients
     */
    getAllClients() {
        return Array.from(this.clients.values());
    }

    /**
     * Get client by bot ID
     */
    getClient(botId) {
        return this.clients.get(botId);
    }

    /**
     * Get default bot client
     */
    getDefaultClient() {
        return this.clients.get(this.defaultBotId);
    }

    /**
     * Attach command and event loaders to a client
     */
    async attachLoaders(client) {
        if (this.commandLoader) {
            await this.commandLoader(client);
        }
        if (this.eventLoader) {
            await this.eventLoader(client);
        }
    }

    /**
     * Set command loader function
     * This function will be called for each bot to load commands
     */
    setCommandLoader(loaderFn) {
        this.commandLoader = loaderFn;
    }

    /**
     * Set event loader function
     * This function will be called for each bot to load events
     */
    setEventLoader(loaderFn) {
        this.eventLoader = loaderFn;
    }

    /**
     * Register the function that attaches the feature managers to a client.
     *
     * Startup used to call this itself after addCustomBot() returned, but the dashboard's
     * "add bot" routes (dashboard/routes/bots.js, super-admin.js) call addCustomBot directly
     * and never did — so a bot added while the process was running had NO managers until the
     * next restart, and every feature that goes through one silently did nothing while the
     * command still reported success. Owning the call here means every path gets managers.
     */
    setManagerInitializer(initFn) {
        this.managerInitializer = initFn;
    }

    /** Remember the latest problem for a bot (shown on /bot-management). */
    recordBotError(botId, message, kind = 'error') {
        if (!botId) return;
        this.botErrors.set(botId, { message: String(message || 'Unknown error').slice(0, 300), kind, at: new Date().toISOString() });
    }

    /** The latest recorded problem for a bot, or null. */
    getBotError(botId) {
        return this.botErrors.get(botId) || null;
    }

    /**
     * Handle bot reconnection and errors
     */
    setupReconnectionHandler(client) {
        client.on('disconnect', () => {
            logger.warn(`[BotManager] Bot ${client.botId} disconnected`);
        });

        client.on('error', (error) => {
            logger.error(`[BotManager] Bot ${client.botId} error:`, error);
            this.recordBotError(client.botId, error?.message || error, 'error');
        });

        // discord.js v14 has no 'disconnect' event; these are what fire when a gateway session drops.
        client.on('shardDisconnect', (event, shardId) => {
            if (event?.code === 1000) return; // our own destroy() (disable / delete / reconnect)
            this.recordBotError(client.botId, `Gateway closed (code ${event?.code ?? '?'}) on shard ${shardId}`, 'disconnect');
        });
        client.on('invalidated', () => {
            this.recordBotError(client.botId, 'Discord invalidated the session (token reset or revoked)', 'invalidated');
        });

        client.on('warn', (warning) => {
            logger.warn(`[BotManager] Bot ${client.botId} warning:`, warning);
        });
    }

    /**
     * Get bot status information
     */
    getBotStatus(botId) {
        const client = this.clients.get(botId);
        if (!client) return null;

        // Calculate actual HUMAN member count from guilds (exclude bots)
        let totalMembers = 0;
        if (client.isReady()) {
            client.guilds.cache.forEach(guild => {
                // Use cached members to count only humans
                const humanCount = guild.members.cache.filter(m => !m.user.bot).size;
                totalMembers += humanCount;
            });
        }

        return {
            botId: client.botId,
            isDefault: client.isDefaultBot,
            isReady: client.isReady(),
            guilds: client.guilds.cache.size,
            users: totalMembers, // Human members only (excludes bots)
            uptime: client.uptime,
            assignedGuilds: client.assignedGuilds || [],
            username: client.user?.username || 'Unknown',
            discriminator: client.user?.discriminator || '0000',
            avatar: client.user?.displayAvatarURL({ size: 128, extension: 'png' }) || null,
            avatarHash: client.user?.avatar || null
        };
    }

    /**
     * Update guild bot mapping
     */
    updateGuildMapping(guildId, botId) {
        if (botId === 'default' || botId === this.defaultBotId) {
            // Remove mapping to use default bot
            this.guildBotMapping.delete(guildId);
        } else {
            this.guildBotMapping.set(guildId, botId);
        }
        logger.info(`[BotManager] Guild ${guildId} mapped to bot ${botId}`);
    }

    /**
     * Get all bot statuses
     */
    getAllBotStatuses() {
        const statuses = [];
        for (const [botId, client] of this.clients.entries()) {
            statuses.push(this.getBotStatus(botId));
        }
        return statuses;
    }

    /**
     * UNIFIED LOOKUP: Get a guild from ANY connected bot instance
     * This allows commands to find servers across all bot instances
     * @param {string} guildId - The guild ID to find
     * @returns {Guild|null} The guild object or null if not found
     */
    getGuildFromAnyClient(guildId) {
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady() && client.guilds.cache.has(guildId)) {
                return client.guilds.cache.get(guildId);
            }
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Get all guilds across ALL connected bot instances
     * Returns a Map to avoid duplicates (same guild might be in multiple bots theoretically)
     * @returns {Map<string, Guild>} Map of guildId -> Guild object
     */
    getAllGuildsUnified() {
        const allGuilds = new Map();
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                client.guilds.cache.forEach(guild => {
                    if (!allGuilds.has(guild.id)) {
                        allGuilds.set(guild.id, guild);
                    }
                });
            }
        }
        return allGuilds;
    }

    /**
     * UNIFIED LOOKUP: Get total member count across all bot instances
     * @returns {number} Total unique members
     */
    getTotalMemberCount() {
        let total = 0;
        const seenGuilds = new Set();
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                client.guilds.cache.forEach(guild => {
                    if (!seenGuilds.has(guild.id)) {
                        seenGuilds.add(guild.id);
                        total += guild.memberCount || 0;
                    }
                });
            }
        }
        return total;
    }

    /**
     * UNIFIED LOOKUP: Get total guild count across all bot instances
     * @returns {number} Total unique guilds
     */
    getTotalGuildCount() {
        return this.getAllGuildsUnified().size;
    }

    /**
     * UNIFIED LOOKUP: Find a user across all bot instances
     * @param {string} userId - The user ID to find
     * @returns {User|null} The user object or null
     */
    getUserFromAnyClient(userId) {
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady() && client.users.cache.has(userId)) {
                return client.users.cache.get(userId);
            }
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Fetch a user from any client (with API call if needed)
     * @param {string} userId - The user ID to fetch
     * @returns {Promise<User|null>} The user object or null
     */
    async fetchUserFromAnyClient(userId) {
        // First try cache
        const cachedUser = this.getUserFromAnyClient(userId);
        if (cachedUser) return cachedUser;

        // Try fetching from each client
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                try {
                    const user = await client.users.fetch(userId);
                    if (user) return user;
                } catch (e) {
                    // Continue to next client
                }
            }
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Find a member in a guild across all bot instances
     * @param {string} guildId - The guild ID
     * @param {string} userId - The user ID
     * @returns {GuildMember|null} The member object or null
     */
    getMemberFromAnyClient(guildId, userId) {
        const guild = this.getGuildFromAnyClient(guildId);
        if (guild && guild.members.cache.has(userId)) {
            return guild.members.cache.get(userId);
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Fetch a member from any client (with API call if needed)
     * @param {string} guildId - The guild ID
     * @param {string} userId - The user ID
     * @returns {Promise<GuildMember|null>} The member object or null
     */
    async fetchMemberFromAnyClient(guildId, userId) {
        const guild = this.getGuildFromAnyClient(guildId);
        if (!guild) return null;

        // Try cache first
        if (guild.members.cache.has(userId)) {
            return guild.members.cache.get(userId);
        }

        // Fetch from API
        try {
            return await guild.members.fetch(userId);
        } catch (e) {
            return null;
        }
    }

    /**
     * UNIFIED LOOKUP: Search guilds by name across all bot instances
     * @param {string} query - Search query (partial name match)
     * @returns {Guild[]} Array of matching guilds
     */
    searchGuildsByName(query) {
        const results = [];
        const seenGuilds = new Set();
        const lowerQuery = query.toLowerCase();

        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                client.guilds.cache.forEach(guild => {
                    if (!seenGuilds.has(guild.id) && guild.name.toLowerCase().includes(lowerQuery)) {
                        seenGuilds.add(guild.id);
                        results.push(guild);
                    }
                });
            }
        }
        return results;
    }
}

export default new BotManager();
