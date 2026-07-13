/*
 * /cah — Cards Against Humanity. Slash command surface for the
 * core/cah-manager.js engine. Behavior:
 *   /cah start           — open a lobby in this channel (host = invoker)
 *   /cah join            — join the lobby in this channel
 *   /cah leave           — leave it
 *   /cah end             — host (or admin) ends the game early
 *   /cah decks add       — import a CAST deck by code
 *   /cah decks list      — list imported decks
 *   /cah decks select    — pick decks for this lobby
 *   /cah config view/set — per-guild CAH policy (admin)
 */
import {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, PermissionFlagsBits
} from 'discord.js';
import {
    createGame, getGame, getGameByChannel, listActiveGames,
    getGuildConfig, updateGuildConfig, DEFAULT_SETTINGS, STATES
} from '../../core/cah-manager.js';
import {
    importCastDeck, bulkImportCastDecks, listDecks,
    startDiscoveryAndImport, getDiscoveryStatus
} from '../../core/cah-deck-importer.js';
import { attachDiscordAdapter } from '../../core/cah-discord-adapter.js';
import logger from '../../utils/logger.js';

const data = new SlashCommandBuilder()
    .setName('cah')
    .setDescription('Cards Against Humanity')
    .setDMPermission(false)
    .addSubcommand(s => s
        .setName('start').setDescription('Open a CAH lobby in this channel')
        .addIntegerOption(o => o.setName('points').setDescription('Points needed to win (default 7)').setMinValue(3).setMaxValue(30))
        .addIntegerOption(o => o.setName('rounds').setDescription('Max rounds before the highest score wins (default 20)').setMinValue(3).setMaxValue(50))
        .addStringOption(o => o.setName('czar_rotation').setDescription('How the Card Czar is chosen each round').addChoices(
            { name: 'Rotate (round-robin)', value: 'rotate' },
            { name: 'Random', value: 'random' },
            { name: 'Previous round winner', value: 'previous_winner' }
        ))
        .addBooleanOption(o => o.setName('timeout').setDescription('Enable per-round AFK timeout (default on)'))
        .addIntegerOption(o => o.setName('timeout_seconds').setDescription('Seconds per round (default 90)').setMinValue(30).setMaxValue(600))
        .addStringOption(o => o.setName('timeout_policy').setDescription('What happens on timeout').addChoices(
            { name: 'Skip player\'s submission', value: 'skip' },
            { name: 'Auto-play a random card from their hand', value: 'auto_random' },
            { name: 'Strike (3 strikes = kicked)', value: 'strike_kick' }
        ))
        .addIntegerOption(o => o.setName('blank_cards').setDescription('Blank cards mixed into deck (write-your-own)').setMinValue(0).setMaxValue(20))
        .addStringOption(o => o.setName('visibility').setDescription('Who can browse + join this game').addChoices(
            { name: 'Private (this channel only)', value: 'private' },
            { name: 'Guild (anyone in this server)', value: 'guild_only' },
            { name: 'Public (also listed on certifriedmultitool.com)', value: 'public' }
        ))
        .addBooleanOption(o => o.setName('nsfw').setDescription('Include NSFW decks if guild permits'))
        .addIntegerOption(o => o.setName('randos').setDescription('Add Rando Cardrissian AI players (0-3)').setMinValue(0).setMaxValue(3))
        .addStringOption(o => o.setName('password').setDescription('Require this password to join (leave blank for none)').setMaxLength(64)))
    .addSubcommand(s => s.setName('join').setDescription('Join the CAH lobby in this channel'))
    .addSubcommand(s => s.setName('leave').setDescription('Leave the CAH game'))
    .addSubcommand(s => s.setName('end').setDescription('End the current CAH game (host/admin only)'))
    .addSubcommandGroup(g => g.setName('decks').setDescription('Manage CAH decks')
        .addSubcommand(s => s.setName('add').setDescription('Import a deck from crcast.cc')
            .addStringOption(o => o.setName('code').setDescription('CrCast deck code (e.g., VD5MM)').setRequired(true))
            .addBooleanOption(o => o.setName('nsfw').setDescription('Mark this deck as NSFW')))
        .addSubcommand(s => s.setName('bulk_add').setDescription('Import many decks at once (admin)')
            .addStringOption(o => o.setName('codes').setDescription('Comma or space-separated CrCast codes').setRequired(true)))
        .addSubcommand(s => s.setName('discover').setDescription('Pull every CrCast deck (admin, takes 10-40 min)')
            .addStringOption(o => o.setName('sort').setDescription('Pull order').addChoices(
                { name: 'Popular first', value: 'popular' },
                { name: 'Featured first', value: 'featured' },
                { name: 'Newest first', value: 'new' },
                { name: 'Popular (month)', value: 'popularLM' }
            )))
        .addSubcommand(s => s.setName('discover_status').setDescription('Check progress of /cah decks discover'))
        .addSubcommand(s => s.setName('list').setDescription('List imported decks'))
        .addSubcommand(s => s.setName('select').setDescription('Pick decks for this lobby')
            .addStringOption(o => o.setName('deck_ids').setDescription('Comma-separated deck ids (from /cah decks list)').setRequired(true))))
    .addSubcommandGroup(g => g.setName('config').setDescription('Per-guild CAH policy (admin)')
        .addSubcommand(s => s.setName('view').setDescription('Show current config'))
        .addSubcommand(s => s.setName('set').setDescription('Update config')
            .addBooleanOption(o => o.setName('nsfw_allowed').setDescription('Allow NSFW decks in this guild'))
            .addBooleanOption(o => o.setName('blank_cards_allowed').setDescription('Allow write-your-own blank cards'))
            .addIntegerOption(o => o.setName('max_blank_cards').setDescription('Max blanks per game').setMinValue(0).setMaxValue(50))
            .addBooleanOption(o => o.setName('allow_public_imports').setDescription('Allow CAST deck imports'))));

async function execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'decks') {
        if (sub === 'add') return handleDeckAdd(interaction);
        if (sub === 'bulk_add') return handleDeckBulkAdd(interaction);
        if (sub === 'discover') return handleDeckDiscover(interaction);
        if (sub === 'discover_status') return handleDeckDiscoverStatus(interaction);
        if (sub === 'list') return handleDeckList(interaction);
        if (sub === 'select') return handleDeckSelect(interaction);
    }
    if (group === 'config') {
        if (sub === 'view') return handleConfigView(interaction);
        if (sub === 'set') return handleConfigSet(interaction);
    }
    if (sub === 'start') return handleStart(interaction);
    if (sub === 'join') return handleJoin(interaction);
    if (sub === 'leave') return handleLeave(interaction);
    if (sub === 'end') return handleEnd(interaction);
}

async function handleStart(interaction) {
    const existing = getGameByChannel(interaction.channelId);
    if (existing) {
        return interaction.reply({ content: '⚠️ A CAH game is already running in this channel.', ephemeral: true });
    }
    await interaction.deferReply();
    const cfg = await getGuildConfig(interaction.guildId);
    const settings = {
        pointsToWin: interaction.options.getInteger('points') ?? cfg.default_points ?? DEFAULT_SETTINGS.pointsToWin,
        maxRounds: interaction.options.getInteger('rounds') ?? cfg.default_max_rounds ?? DEFAULT_SETTINGS.maxRounds,
        czarRotation: interaction.options.getString('czar_rotation') ?? DEFAULT_SETTINGS.czarRotation,
        timeoutEnabled: interaction.options.getBoolean('timeout') ?? DEFAULT_SETTINGS.timeoutEnabled,
        timeoutSeconds: interaction.options.getInteger('timeout_seconds') ?? cfg.default_timeout_secs ?? DEFAULT_SETTINGS.timeoutSeconds,
        timeoutPolicy: interaction.options.getString('timeout_policy') ?? DEFAULT_SETTINGS.timeoutPolicy,
        blankCardCount: interaction.options.getInteger('blank_cards') ?? 0,
        visibility: interaction.options.getString('visibility') ?? DEFAULT_SETTINGS.visibility,
        nsfw: interaction.options.getBoolean('nsfw') ?? false,
        randoCount: interaction.options.getInteger('randos') ?? 0,
        joinPassword: interaction.options.getString('password') || null,
        deckIds: [] // host selects via /cah decks select before /cah start (or auto-pick builtin)
    };

    // If no decks selected yet, auto-pick the built-in
    const all = await listDecks({ source: 'builtin', limit: 1 });
    if (all.length > 0) settings.deckIds = [all[0].id];

    const result = await createGame({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        hostUserId: interaction.user.id,
        settings
    });
    if (!result.ok) {
        const extra = result.nsfwDeckNames ? ` (${result.nsfwDeckNames.join(', ')})` : '';
        return interaction.editReply({ content: `❌ Couldn't create game: \`${result.reason}\`${extra}` });
    }
    const game = result.game;
    game.addPlayer({ userId: interaction.user.id, platform: 'discord', displayName: interaction.user.displayName || interaction.user.username });
    attachDiscordAdapter(game, interaction.client);

    const embed = new EmbedBuilder()
        .setColor(0xE94B3C)
        .setTitle('🃏 Cards Against Humanity — Lobby Open')
        .setDescription(`**Host:** <@${interaction.user.id}>\nClick **Join** to play. Host clicks **Start** when ready (min 3 players).`)
        .addFields(
            { name: 'Win at', value: `${settings.pointsToWin} pts or ${settings.maxRounds} rounds`, inline: true },
            { name: 'Czar', value: settings.czarRotation, inline: true },
            { name: 'Blanks', value: String(settings.blankCardCount), inline: true },
            { name: 'Timeout', value: settings.timeoutEnabled ? `${settings.timeoutSeconds}s (${settings.timeoutPolicy})` : 'off', inline: true },
            { name: 'Visibility', value: settings.visibility, inline: true },
            { name: 'NSFW', value: settings.nsfw ? 'on' : 'off', inline: true },
            { name: 'Randos', value: String(settings.randoCount || 0), inline: true }
        )
        .setFooter({ text: `Game id: ${game.id.slice(0, 8)}` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cah_join:${game.id}`).setLabel('Join').setStyle(ButtonStyle.Success).setEmoji('🎴'),
        new ButtonBuilder().setCustomId(`cah_leave:${game.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`cah_startgame:${game.id}`).setLabel('Start Game').setStyle(ButtonStyle.Primary).setEmoji('▶️')
    );
    const msg = await interaction.editReply({ embeds: [embed], components: [row] });
    game._mainMessageId = msg.id;     // adapter uses this to edit the lobby/round embed in place
    logger.info(`[cah] lobby opened in #${interaction.channelId} (game ${game.id})`);
}

async function handleJoin(interaction) {
    const game = getGameByChannel(interaction.channelId);
    if (!game) return interaction.reply({ content: '❌ No CAH game in this channel. Start one with `/cah start`.', ephemeral: true });
    if (game.state !== STATES.LOBBY) return interaction.reply({ content: '⚠️ Game already in progress.', ephemeral: true });
    const result = game.addPlayer({ userId: interaction.user.id, platform: 'discord', displayName: interaction.user.displayName || interaction.user.username });
    if (!result.ok) return interaction.reply({ content: `❌ \`${result.reason}\``, ephemeral: true });
    return interaction.reply({ content: `✅ Joined! ${game.players.size} players in lobby.`, ephemeral: true });
}

async function handleLeave(interaction) {
    const game = getGameByChannel(interaction.channelId);
    if (!game) return interaction.reply({ content: '❌ No CAH game here.', ephemeral: true });
    const result = game.removePlayer(interaction.user.id);
    if (!result.ok) return interaction.reply({ content: `❌ \`${result.reason}\``, ephemeral: true });
    return interaction.reply({ content: '👋 Left the game.', ephemeral: true });
}

async function handleEnd(interaction) {
    const game = getGameByChannel(interaction.channelId);
    if (!game) return interaction.reply({ content: '❌ No CAH game here.', ephemeral: true });
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (game.hostUserId !== interaction.user.id && !isAdmin) {
        return interaction.reply({ content: '❌ Only the host or a guild admin can end the game.', ephemeral: true });
    }
    game.endGame('ended_by_host');
    return interaction.reply({ content: '🛑 Game ended.' });
}

async function handleDeckAdd(interaction) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    const cfg = await getGuildConfig(interaction.guildId);
    if (!cfg.allow_public_imports && !isAdmin) {
        return interaction.reply({ content: '❌ CAST imports are disabled in this guild.', ephemeral: true });
    }
    const code = interaction.options.getString('code', true);
    const nsfw = interaction.options.getBoolean('nsfw') ?? false;
    if (nsfw && !cfg.nsfw_allowed) {
        return interaction.reply({ content: '❌ NSFW decks are disabled in this guild.', ephemeral: true });
    }
    await interaction.deferReply();
    const r = await importCastDeck(code, { importedBy: interaction.user.id, markNsfw: nsfw });
    if (!r.ok) return interaction.editReply(`❌ Import failed: \`${r.reason}\`${r.error ? ` — ${r.error.slice(0, 200)}` : ''}`);
    return interaction.editReply(`✅ Imported deck #${r.deckId} — ${r.white} white, ${r.black} black cards.`);
}

async function handleDeckBulkAdd(interaction) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isAdmin) return interaction.reply({ content: '❌ Admin only — bulk import bypasses the per-user rate limit.', ephemeral: true });
    const raw = interaction.options.getString('codes', true);
    const codes = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (codes.length === 0) return interaction.reply({ content: '❌ No codes provided.', ephemeral: true });
    if (codes.length > 50) return interaction.reply({ content: `❌ Too many at once (${codes.length}). Cap is 50 per call.`, ephemeral: true });
    await interaction.deferReply();
    const { results, summary } = await bulkImportCastDecks(codes, { importedBy: interaction.user.id });
    const failures = results.filter(r => !r.ok).map(r => `\`${r.code}\` (${r.reason})`);
    const lines = [
        `**Imported ${summary.ok}/${codes.length}** decks — +${summary.totalWhite} white / +${summary.totalBlack} black`,
        ''
    ];
    if (failures.length > 0) {
        lines.push(`**Failures (${failures.length}):**`);
        lines.push(failures.slice(0, 15).join(', '));
        if (failures.length > 15) lines.push(`...and ${failures.length - 15} more.`);
    }
    return interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
}

async function handleDeckDiscover(interaction) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isAdmin) return interaction.reply({ content: '❌ Admin only — discovery hits the upstream API hard.', ephemeral: true });
    const sort = interaction.options.getString('sort') || 'popular';
    const r = startDiscoveryAndImport({ importedBy: interaction.user.id, sort });
    if (!r.ok) {
        return interaction.reply({ content: `⚠️ Discovery is already running. Check \`/cah decks discover_status\`.`, ephemeral: true });
    }
    return interaction.reply({
        content: `🔍 Started discovery (sort: \`${sort}\`). This will take 10-40 minutes depending on catalog size. Check progress with \`/cah decks discover_status\`.`,
        ephemeral: true
    });
}

async function handleDeckDiscoverStatus(interaction) {
    const s = getDiscoveryStatus();
    if (!s.running && !s.phase) return interaction.reply({ content: 'No discovery job has run yet.', ephemeral: true });
    const lines = [
        `**Status:** ${s.running ? '🟡 running' : (s.phase === 'done' ? '🟢 done' : s.phase === 'failed' ? '🔴 failed' : '⚪️ idle')}`,
        `**Phase:** \`${s.phase || '-'}\``,
        `**Discovered:** ${s.discovered || 0} decks`,
        `**Cards imported:** ${s.cardImported || 0} / ${s.cardTotal || 0} (${s.cardFailed || 0} failed)`,
    ];
    if (s.startedAt) lines.push(`**Started:** <t:${Math.floor(new Date(s.startedAt).getTime()/1000)}:R>`);
    if (s.finishedAt) lines.push(`**Finished:** <t:${Math.floor(new Date(s.finishedAt).getTime()/1000)}:R>`);
    if (s.error) lines.push(`**Error:** \`${s.error}\``);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleDeckList(interaction) {
    const decks = await listDecks({ limit: 25 });
    if (!decks.length) return interaction.reply({ content: 'No decks imported yet. Try `/cah decks add code:<code>`.', ephemeral: true });
    const embed = new EmbedBuilder()
        .setColor(0x1F8B4C).setTitle('🃏 Imported CAH Decks')
        .setDescription(decks.map(d => `**#${d.id}** [${d.source}] **${d.name}** — ${d.white_count}w/${d.black_count}b${d.nsfw ? ' 🔞' : ''}`).join('\n'));
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDeckSelect(interaction) {
    const game = getGameByChannel(interaction.channelId);
    if (!game) return interaction.reply({ content: '❌ No lobby here.', ephemeral: true });
    if (game.hostUserId !== interaction.user.id) return interaction.reply({ content: '❌ Only the host can pick decks.', ephemeral: true });
    if (game.state !== STATES.LOBBY) return interaction.reply({ content: '⚠️ Game already started.', ephemeral: true });
    const raw = interaction.options.getString('deck_ids', true);
    const ids = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return interaction.reply({ content: '❌ Provide comma-separated deck ids.', ephemeral: true });
    game.settings.deckIds = ids;
    return interaction.reply({ content: `✅ Lobby will use decks: ${ids.join(', ')}`, ephemeral: true });
}

async function handleConfigView(interaction) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isAdmin) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const cfg = await getGuildConfig(interaction.guildId);
    const embed = new EmbedBuilder()
        .setColor(0x5865F2).setTitle('🃏 CAH Guild Config')
        .addFields(
            { name: 'NSFW allowed', value: cfg.nsfw_allowed ? 'yes' : 'no', inline: true },
            { name: 'Blank cards', value: cfg.blank_cards_allowed ? `yes (max ${cfg.max_blank_cards})` : 'no', inline: true },
            { name: 'CAST imports', value: cfg.allow_public_imports ? 'yes' : 'no', inline: true },
            { name: 'Default points', value: String(cfg.default_points), inline: true },
            { name: 'Default rounds', value: String(cfg.default_max_rounds), inline: true },
            { name: 'Default timeout', value: `${cfg.default_timeout_secs}s`, inline: true }
        );
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleConfigSet(interaction) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!isAdmin) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const patch = {};
    const fields = [
        ['nsfw_allowed', 'getBoolean', 'nsfw_allowed'],
        ['blank_cards_allowed', 'getBoolean', 'blank_cards_allowed'],
        ['max_blank_cards', 'getInteger', 'max_blank_cards'],
        ['allow_public_imports', 'getBoolean', 'allow_public_imports']
    ];
    for (const [optName, method, dbField] of fields) {
        const val = interaction.options[method](optName);
        if (val !== null && val !== undefined) {
            patch[dbField] = (typeof val === 'boolean') ? (val ? 1 : 0) : val;
        }
    }
    if (!Object.keys(patch).length) return interaction.reply({ content: '⚠️ No changes provided.', ephemeral: true });
    await updateGuildConfig(interaction.guildId, patch);
    return interaction.reply({ content: `✅ Updated: ${Object.keys(patch).join(', ')}`, ephemeral: true });
}

export { data, execute };
export default { data, execute };
