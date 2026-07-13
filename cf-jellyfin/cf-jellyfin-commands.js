// ============================================================================
// CertiFried Jellyfin — slash command suite
// ----------------------------------------------------------------------------
// Drop-in module providing the /jellyfin command tree with per-guild opt-in.
//
// CONTRACT:
//   - One global command `/jellyfin-enable` (Manage Guild only) flips a guild
//     into the opted-in state and registers the per-guild Jellyfin command set
//     in just that guild. Until then, NO Jellyfin commands are visible.
//   - Per-guild commands (`/jellyfin link|status|reset-password|disable|config`)
//     are registered ONLY in opted-in guilds, scoped to that guild — so they
//     don't leak into unrelated CertiFried-bot guilds.
//   - All replies are EPHEMERAL by default (only the invoker sees them).
//     The bot never DMs users and never auto-creates accounts.
//
// CONFIG STORAGE: better-sqlite3 file (defaults to ./guild-config.db).
// AUTH-APP: callouts go through createAuthAppClient (HMAC-signed).
// ============================================================================

import {
    SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
    MessageFlags, ChannelType
} from 'discord.js';
import Database from 'better-sqlite3';
import path from 'path';

const PURPLE = 0xa78bfa;
const GREEN  = 0x34d399;
const RED    = 0xf87171;
const GRAY   = 0x6b7280;

// ---------------------------------------------------------------------------
// Slash command schemas
// ---------------------------------------------------------------------------

function buildPerGuildCommands() {
    return [
        new SlashCommandBuilder()
            .setName('jellyfin')
            .setDescription('CertiFried Movie Theatre')
            .addSubcommand(s => s
                .setName('link')
                .setDescription('Get a link to create or manage your Movie Theatre account'))
            .addSubcommand(s => s
                .setName('status')
                .setDescription('Check the status of your Movie Theatre account'))
            .addSubcommand(s => s
                .setName('reset-password')
                .setDescription('Generate a new password for your Movie Theatre account'))
            .addSubcommand(s => s
                .setName('request')
                .setDescription('Request a movie or TV show for the Movie Theatre')
                .addStringOption(o => o
                    .setName('title')
                    .setDescription('Title of the movie or show')
                    .setRequired(true)
                    .setMinLength(2)
                    .setMaxLength(200))
                .addStringOption(o => o
                    .setName('type')
                    .setDescription('Movie or TV series')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Movie', value: 'movie' },
                        { name: 'TV Series', value: 'tv' }
                    ))
                .addIntegerOption(o => o
                    .setName('year')
                    .setDescription('Release year (helps disambiguate)')
                    .setMinValue(1900)
                    .setMaxValue(2100))
                .addStringOption(o => o
                    .setName('quality')
                    .setDescription('Preferred quality (default 1080p)')
                    .addChoices(
                        { name: '720p', value: '720p' },
                        { name: '1080p', value: '1080p' },
                        { name: '2160p (4K)', value: '2160p' }
                    )))
            .addSubcommand(s => s
                .setName('requests')
                .setDescription('Check the status of your recent Movie Theatre requests'))
            .addSubcommand(s => s
                .setName('disable')
                .setDescription('(Admin) Turn OFF Jellyfin features in this server'))
            .addSubcommand(s => s
                .setName('config')
                .setDescription('(Admin) Configure Jellyfin notification channels')
                .addChannelOption(o => o
                    .setName('new-media')
                    .setDescription('Channel for new-media announcements')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addChannelOption(o => o
                    .setName('now-playing')
                    .setDescription('Channel for now-playing posts')
                    .addChannelTypes(ChannelType.GuildText))
                .addChannelOption(o => o
                    .setName('audit')
                    .setDescription('Channel for audit logs')
                    .addChannelTypes(ChannelType.GuildText)))
            .setDMPermission(false)
            .toJSON()
    ];
}

function buildGlobalCommands() {
    return [
        new SlashCommandBuilder()
            .setName('jellyfin-enable')
            .setDescription('(Admin) Turn ON CertiFried Movie Theatre features in this server')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .setDMPermission(false)
            .toJSON()
    ];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function openConfigDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS guild_jellyfin_settings (
            guild_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            enabled_at TEXT,
            enabled_by TEXT,
            new_media_channel TEXT,
            now_playing_channel TEXT,
            audit_channel TEXT
        );
    `);
    return db;
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

export function createJellyfinCommands(opts) {
    if (!opts || !opts.authAppClient) {
        throw new Error('cf-commands: authAppClient required');
    }
    const dbPath = opts.dbPath || path.join(process.cwd(), 'guild-config.db');
    const loginUrl = opts.loginUrl || 'https://jellyfin.certifriedmultitool.net/account';
    const brandName = opts.brandName || 'CertiFried Movie Theatre';
    const db = openConfigDb(dbPath);
    const auth = opts.authAppClient;

    const stmts = {
        get: db.prepare('SELECT * FROM guild_jellyfin_settings WHERE guild_id = ?'),
        upsertEnable: db.prepare(
            "INSERT INTO guild_jellyfin_settings (guild_id, enabled, enabled_at, enabled_by) " +
            "VALUES (?, 1, datetime('now'), ?) " +
            "ON CONFLICT(guild_id) DO UPDATE SET enabled = 1, enabled_at = datetime('now'), enabled_by = excluded.enabled_by"
        ),
        disable: db.prepare('UPDATE guild_jellyfin_settings SET enabled = 0 WHERE guild_id = ?'),
        setChannel: (key) => db.prepare('UPDATE guild_jellyfin_settings SET ' + key + ' = ? WHERE guild_id = ?')
    };

    function isEnabledForGuild(guildId) {
        const row = stmts.get.get(guildId);
        return !!(row && row.enabled);
    }

    function getGuildConfig(guildId) {
        return stmts.get.get(guildId) || null;
    }

    // ------------------- Guild registration -------------------

    async function registerForGuild(client, guildId) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new Error('Bot is not in guild ' + guildId);
        // Same reasoning as registerGlobalCommands() below — MUST NOT use .set()
        // because cf-jellyfin shares the main bot's application id, and .set()
        // does PUT /applications/{id}/guilds/{guildId}/commands which REPLACES
        // every command in the guild (wiping the main bot's 49 commands and
        // leaving only /jellyfin). Use .create() per command — it upserts by
        // name and is additive against existing commands.
        for (const cmd of buildPerGuildCommands()) {
            await guild.commands.create(cmd);
        }
    }

    async function unregisterForGuild(client, guildId) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        // Same reason — fetch current guild commands and delete ONLY the
        // jellyfin-owned ones, leaving the main bot's commands intact.
        const ours = new Set(buildPerGuildCommands().map(c => c.name));
        const existing = await guild.commands.fetch();
        for (const cmd of existing.values()) {
            if (ours.has(cmd.name)) {
                await guild.commands.delete(cmd.id).catch(() => {});
            }
        }
    }

    async function enableForGuild(client, guildId, byUserId) {
        stmts.upsertEnable.run(guildId, byUserId || null);
        await registerForGuild(client, guildId);
    }

    async function disableForGuild(client, guildId) {
        stmts.disable.run(guildId);
        await unregisterForGuild(client, guildId);
    }

    async function registerGlobalCommands(client) {
        // IMPORTANT: must NOT use .set() — cf-jellyfin shares the main bot's
        // Discord application ID, and .set() does PUT /applications/{id}/commands
        // which REPLACES the entire global command list (wiping the main bot's
        // commands and leaving only /jellyfin-enable visible to users).
        // Use .create() per command, which POSTs and upserts by name — additive.
        for (const cmd of buildGlobalCommands()) {
            await client.application.commands.create(cmd);
        }
    }

    async function reconcileAllGuilds(client) {
        const opted = db.prepare('SELECT guild_id FROM guild_jellyfin_settings WHERE enabled = 1').all();
        for (const row of opted) {
            try {
                if (client.guilds.cache.has(row.guild_id)) {
                    await registerForGuild(client, row.guild_id);
                }
            } catch (err) {
                console.error('[cf-commands] Reconcile failed for ' + row.guild_id + ':', err.message);
            }
        }
    }

    // ------------------- Interaction handlers -------------------

    function ephemeral(content) {
        return { content, flags: MessageFlags.Ephemeral };
    }

    function ephemeralEmbed(embed) {
        return { embeds: [embed], flags: MessageFlags.Ephemeral };
    }

    async function handleEnable(interaction, client) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply(ephemeral('You need Manage Guild permission to enable Jellyfin features.'));
        }
        if (isEnabledForGuild(interaction.guildId)) {
            return interaction.reply(ephemeral('Jellyfin features are already enabled for this server. Use `/jellyfin disable` to turn them off.'));
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            await enableForGuild(client, interaction.guildId, interaction.user.id);
            const embed = new EmbedBuilder()
                .setColor(GREEN)
                .setTitle(brandName + ' enabled')
                .setDescription([
                    'Jellyfin commands are now available in this server.',
                    '',
                    'Members can run `/jellyfin link` to create their account.',
                    'Set up notification channels with `/jellyfin config`.'
                ].join('\n'))
                .setFooter({ text: brandName });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[cf-commands] enableForGuild failed:', err.message);
            await interaction.editReply(ephemeral('Failed to enable: ' + err.message));
        }
    }

    async function handleDisable(interaction, client) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply(ephemeral('You need Manage Guild permission.'));
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            await disableForGuild(client, interaction.guildId);
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(GRAY)
                    .setTitle(brandName + ' disabled')
                    .setDescription('Jellyfin commands have been removed from this server. Existing linked accounts are unaffected.')
                    .setFooter({ text: brandName })]
            });
        } catch (err) {
            await interaction.editReply(ephemeral('Failed to disable: ' + err.message));
        }
    }

    async function handleConfig(interaction) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply(ephemeral('You need Manage Guild permission.'));
        }
        const newMedia = interaction.options.getChannel('new-media');
        const nowPlaying = interaction.options.getChannel('now-playing');
        const audit = interaction.options.getChannel('audit');
        const changes = [];
        if (newMedia)   { stmts.setChannel('new_media_channel').run(newMedia.id, interaction.guildId);   changes.push('new-media -> ' + newMedia.toString()); }
        if (nowPlaying) { stmts.setChannel('now_playing_channel').run(nowPlaying.id, interaction.guildId); changes.push('now-playing -> ' + nowPlaying.toString()); }
        if (audit)      { stmts.setChannel('audit_channel').run(audit.id, interaction.guildId);          changes.push('audit -> ' + audit.toString()); }

        const cfg = getGuildConfig(interaction.guildId);
        const lines = [
            '**Current configuration**',
            'New media:   ' + (cfg && cfg.new_media_channel   ? '<#' + cfg.new_media_channel + '>'   : '_(not set)_'),
            'Now playing: ' + (cfg && cfg.now_playing_channel ? '<#' + cfg.now_playing_channel + '>' : '_(not set)_'),
            'Audit:       ' + (cfg && cfg.audit_channel       ? '<#' + cfg.audit_channel + '>'       : '_(not set)_')
        ];
        if (changes.length) lines.push('', '**Updated:** ' + changes.join(', '));

        return interaction.reply(ephemeralEmbed(
            new EmbedBuilder().setColor(PURPLE).setDescription(lines.join('\n')).setFooter({ text: brandName })
        ));
    }

    async function handleLink(interaction) {
        const status = await auth.get('/account/internal/user-status?discord_id=' + encodeURIComponent(interaction.user.id));
        const linked = !!(status.ok && status.data && status.data.linked);
        const embed = new EmbedBuilder()
            .setColor(PURPLE)
            .setTitle(brandName)
            .setURL(loginUrl)
            .setDescription(linked
                ? 'You already have an account linked. Click below to open it.'
                : 'Click the link below to create your free Movie Theatre account.\nYou must be in a CertiFried Discord server (you are ✅).')
            .addFields({ name: 'Account portal', value: loginUrl })
            .setFooter({ text: brandName });
        return interaction.reply(ephemeralEmbed(embed));
    }

    async function handleStatus(interaction) {
        const r = await auth.get('/account/internal/user-status?discord_id=' + encodeURIComponent(interaction.user.id));
        if (!r.ok) {
            return interaction.reply(ephemeral('Could not reach the account service. Try again in a minute.'));
        }
        const data = r.data;
        if (!data || !data.linked) {
            return interaction.reply(ephemeralEmbed(new EmbedBuilder()
                .setColor(GRAY)
                .setTitle('Not linked')
                .setDescription("You don't have a Movie Theatre account yet. Run `/jellyfin link` to create one.")
                .setFooter({ text: brandName })));
        }
        const since = data.since ? new Date(data.since).toLocaleDateString() : 'unknown';
        const stateLabel = data.is_disabled === true ? '🚫 Disabled' :
                          data.is_disabled === false ? '✅ Active' : '❔ Unknown';
        return interaction.reply(ephemeralEmbed(new EmbedBuilder()
            .setColor(data.is_disabled === true ? RED : GREEN)
            .setTitle(brandName + ' account')
            .addFields(
                { name: 'Status', value: stateLabel, inline: true },
                { name: 'Username', value: '`' + data.jellyfin_username + '`', inline: true },
                { name: 'Member since', value: since, inline: true }
            )
            .addFields({ name: 'Portal', value: data.login_url || loginUrl })
            .setFooter({ text: brandName })));
    }

    async function handleResetPassword(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await auth.post('/account/internal/reset-password', { discord_id: interaction.user.id });
        if (!r.ok || !r.data || !r.data.success) {
            const msg = (r.data && r.data.error) || ('Reset failed (HTTP ' + r.status + ')');
            return interaction.editReply(ephemeral(msg));
        }
        const embed = new EmbedBuilder()
            .setColor(PURPLE)
            .setTitle('Password reset')
            .setDescription("Your new credentials are below. **Save them — they won't be shown again.**")
            .addFields(
                { name: 'Username', value: '`' + r.data.jellyfin_username + '`' },
                { name: 'Password', value: '`' + r.data.password + '`' }
            )
            .addFields({ name: 'Sign in', value: loginUrl })
            .setFooter({ text: brandName });
        return interaction.editReply({ embeds: [embed] });
    }

    async function handleRequest(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const title = interaction.options.getString('title', true).trim();
        const mediaType = interaction.options.getString('type', true);
        const year = interaction.options.getInteger('year') || null;
        const quality = interaction.options.getString('quality') || '1080p';
        const r = await auth.post('/account/internal/requests', {
            discord_id: interaction.user.id,
            discord_username: interaction.user.username,
            title, year, media_type: mediaType, quality
        });
        if (r.ok && r.data && r.data.ok) {
            const embed = new EmbedBuilder()
                .setColor(GREEN)
                .setTitle('✅ Request submitted')
                .setDescription('Your request is queued for review. You can check status with `/jellyfin requests`.')
                .addFields(
                    { name: 'Title', value: r.data.year ? `${r.data.title} (${r.data.year})` : r.data.title, inline: false },
                    { name: 'Type', value: r.data.media_type === 'tv' ? 'TV Series' : 'Movie', inline: true },
                    { name: 'Quality', value: r.data.quality, inline: true },
                    { name: 'Request ID', value: '#' + r.data.id, inline: true }
                )
                .setFooter({ text: brandName });
            return interaction.editReply({ embeds: [embed] });
        }
        const err = r.data && r.data.error;
        if (err === 'no_linked_account') {
            return interaction.editReply(ephemeralEmbed(new EmbedBuilder()
                .setColor(GRAY)
                .setTitle('Not linked yet')
                .setDescription("You need a linked Movie Theatre account before you can request titles. Run `/jellyfin link` to set one up.")
                .setFooter({ text: brandName })));
        }
        if (err === 'duplicate') {
            return interaction.editReply(ephemeralEmbed(new EmbedBuilder()
                .setColor(GRAY)
                .setTitle('Already requested')
                .setDescription(`You have an active request for that title (#${r.data.existing_id}, status: **${r.data.existing_status}**). Use \`/jellyfin requests\` to see it.`)
                .setFooter({ text: brandName })));
        }
        const msg = err === 'title_required' ? 'Title is required (at least 2 characters).'
                  : err === 'invalid_year'   ? 'Year must be between 1900 and 2100.'
                  : (err ? `Request failed: ${err}` : `Request failed (HTTP ${r.status}).`);
        return interaction.editReply(ephemeral(msg));
    }

    async function handleRequests(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await auth.get('/account/internal/requests?discord_id=' + encodeURIComponent(interaction.user.id));
        if (!r.ok || !r.data || !r.data.ok) {
            return interaction.editReply(ephemeral('Could not reach the request service. Try again in a minute.'));
        }
        const rows = r.data.requests || [];
        if (rows.length === 0) {
            return interaction.editReply(ephemeralEmbed(new EmbedBuilder()
                .setColor(GRAY)
                .setTitle('No requests yet')
                .setDescription("You haven't submitted any requests. Try `/jellyfin request title:... type:...`.")
                .setFooter({ text: brandName })));
        }
        const STATUS_ICON = {
            pending: '⏳', approved: '👍', searching: '🔍', downloading: '⬇️',
            completed: '✅', failed: '⚠️', rejected: '❌', cancelled: '🚫'
        };
        const lines = rows.slice(0, 10).map(row => {
            const yr = row.year ? ` (${row.year})` : '';
            const type = row.media_type === 'tv' ? 'TV' : 'Movie';
            const icon = STATUS_ICON[row.status] || '•';
            const progress = (row.status === 'downloading' && row.progress != null)
                ? ` — ${Math.round(row.progress * 100)}%` : '';
            return `${icon} **#${row.id}** ${row.title}${yr} · *${type}* · \`${row.status}\`${progress}`;
        });
        const overflow = rows.length > 10 ? `\n…and ${rows.length - 10} more` : '';
        const embed = new EmbedBuilder()
            .setColor(PURPLE)
            .setTitle('Your Movie Theatre requests')
            .setDescription(lines.join('\n') + overflow)
            .setFooter({ text: brandName });
        return interaction.editReply({ embeds: [embed] });
    }

    function attach(client) {
        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            try {
                if (interaction.commandName === 'jellyfin-enable') {
                    return handleEnable(interaction, client);
                }
                if (interaction.commandName === 'jellyfin') {
                    if (!interaction.guildId || !isEnabledForGuild(interaction.guildId)) {
                        return interaction.reply(ephemeral('Jellyfin features are not enabled in this server.'));
                    }
                    const sub = interaction.options.getSubcommand();
                    if (sub === 'link')           return handleLink(interaction);
                    if (sub === 'status')         return handleStatus(interaction);
                    if (sub === 'reset-password') return handleResetPassword(interaction);
                    if (sub === 'request')        return handleRequest(interaction);
                    if (sub === 'requests')       return handleRequests(interaction);
                    if (sub === 'disable')        return handleDisable(interaction, client);
                    if (sub === 'config')         return handleConfig(interaction);
                }
            } catch (err) {
                console.error('[cf-commands] interaction error:', err);
                const reply = ephemeral('Something broke. Please try again or ping an admin.');
                if (interaction.deferred || interaction.replied) {
                    interaction.followUp(reply).catch(() => {});
                } else {
                    interaction.reply(reply).catch(() => {});
                }
            }
        });

        // When the bot leaves a guild, clean up its row
        client.on('guildDelete', (guild) => {
            stmts.disable.run(guild.id);
        });
    }

    return {
        attach,
        registerGlobalCommands,
        reconcileAllGuilds,
        enableForGuild,
        disableForGuild,
        isEnabledForGuild,
        getGuildConfig
    };
}
