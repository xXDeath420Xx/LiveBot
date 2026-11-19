/**
 * /alerts gamenews — manage game news / patch-note watchers.
 *
 * Supersedes scripts/enable-patch-watcher.js, which could only prime a row that already
 * existed — creating a watcher previously meant writing the INSERT by hand.
 *
 * `add` takes a preset key from the catalogue (autocompleted) or a custom source. The first
 * poll after creation primes on whatever the source currently shows and posts nothing —
 * otherwise adding a watcher would dump the entire current front page into the channel.
 */

import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getPreset, searchPresets, GAME_NEWS_PRESETS } from '../../../core/game-news-presets.js';
import { PROVIDERS } from '../../../core/game-patch-watcher-manager.js';

const CUSTOM_PROVIDERS = new Set(['rss', 'steam-news', 'twitter-rss']);

function parseCsv(v) {
    return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

export async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'game') return interaction.respond([]);

    const hits = searchPresets(focused.value, 25);
    await interaction.respond(
        hits.map(p => ({ name: `${p.label} — ${p.platform}`.slice(0, 100), value: p.key }))
    );
}

export async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
        case 'add':      return addWatcher(interaction);
        case 'list':     return listWatchers(interaction);
        case 'remove':   return removeWatcher(interaction);
        case 'toggle':   return toggleWatcher(interaction);
        case 'test':     return testWatcher(interaction);
        case 'catalogue': return showCatalogue(interaction);
        default:
            return interaction.reply({ content: `Unknown subcommand \`${sub}\``, ephemeral: true });
    }
}

async function addWatcher(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('ping-role');
    const presetKey = interaction.options.getString('game');
    const customUrl = interaction.options.getString('feed-url');
    const customAppid = interaction.options.getInteger('steam-appid');
    const customAccount = interaction.options.getString('account');
    const customLabel = interaction.options.getString('name');
    const interval = interaction.options.getInteger('interval') ?? 15;
    const include = parseCsv(interaction.options.getString('only-if'));
    const exclude = parseCsv(interaction.options.getString('never-if'));

    // Verify the bot can actually post before recording a watcher that would fail silently.
    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.ViewChannel) || !perms?.has(PermissionsBitField.Flags.SendMessages)) {
        return interaction.editReply(`I cannot post in ${channel}. Grant me **View Channel** and **Send Messages** there first.`);
    }
    if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) {
        return interaction.editReply(`I need **Embed Links** in ${channel} — patch notes are posted as embeds.`);
    }

    let provider, label, config;
    const preset = getPreset(presetKey);

    if (preset) {
        provider = preset.provider;
        label = customLabel || preset.label;
        config = { ...preset.config };
    } else {
        // Custom source: infer the provider from whichever field was filled in.
        if (customUrl) { provider = 'rss'; config = { url: customUrl }; }
        else if (customAppid) { provider = 'steam-news'; config = { appid: customAppid, feeds: ['steam_community_announcements'] }; }
        else if (customAccount) { provider = 'twitter-rss'; config = { username: customAccount.replace(/^@/, '') }; }
        else {
            return interaction.editReply(
                'Pick a game with `game:` (start typing to search 75+ titles), or give a custom source with `feed-url:`, `steam-appid:` or `account:`.'
            );
        }
        label = customLabel;
        if (!label) return interaction.editReply('A custom source needs a `name:` so people can tell what it is.');
    }

    if (include.length) config.include = include;
    if (exclude.length) config.exclude = exclude;

    if (!PROVIDERS[provider] || (!preset && !CUSTOM_PROVIDERS.has(provider))) {
        return interaction.editReply(`Unsupported source type \`${provider}\`.`);
    }

    // Prove the source works before saving. A watcher that silently never fires is far
    // worse than a rejected command.
    let probe;
    try {
        probe = await PROVIDERS[provider](config, { guild_id: guildId });
    } catch (err) {
        return interaction.editReply(`That source could not be read: \`${err.message}\`\nNothing was saved.`);
    }
    if (!probe.length) {
        return interaction.editReply(
            'That source responded but published nothing I could read, so I have not saved it. ' +
            'Check the feed URL or appid — or if you used `only-if:`, loosen the keywords.'
        );
    }

    try {
        const [result] = await pool.execute(
            `INSERT INTO game_patch_watchers
               (guild_id, channel_id, role_ping_id, provider, preset_key, game_label,
                provider_config, check_interval_minutes, is_enabled, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [guildId, channel.id, role?.id || null, provider, preset?.key || null,
             label.slice(0, 80), JSON.stringify(config), Math.min(Math.max(interval, 5), 1440),
             interaction.user.id]
        );

        const embed = new EmbedBuilder()
            .setColor(0x6366F1)
            .setTitle(`Now watching ${label}`)
            .setDescription(
                `Patch notes and announcements will post to ${channel}.\n\n` +
                'The first check records what is currently published without posting it, ' +
                'so the first message you see will be genuinely new.'
            )
            .addFields(
                { name: 'Source', value: `\`${provider}\``, inline: true },
                { name: 'Checked', value: `every ${Math.min(Math.max(interval, 5), 1440)} min`, inline: true },
                { name: 'Currently visible', value: `${probe.length} item(s)`, inline: true },
                { name: 'Watcher ID', value: `\`${result.insertId}\``, inline: true }
            )
            .setFooter({ text: 'Manage every watcher on the dashboard: Game News' });

        if (role) embed.addFields({ name: 'Pings', value: `${role}`, inline: true });
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return interaction.editReply('That source is already being watched in that channel.');
        }
        logger.error('[GameNews add] Error:', { error: err.message, stack: err.stack });
        return interaction.editReply(`Could not save the watcher: ${err.message}`);
    }
}

async function listWatchers(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const [rows] = await pool.execute(
        `SELECT id, channel_id, provider, game_label, is_enabled, check_interval_minutes,
                last_checked_at, last_posted_at, last_error,
                JSON_LENGTH(COALESCE(last_seen_ids, JSON_ARRAY())) AS seen_count
           FROM game_patch_watchers WHERE guild_id = ? ORDER BY game_label`,
        [interaction.guild.id]
    );

    if (!rows.length) {
        return interaction.editReply(
            'No game news watchers yet. Add one with `/alerts gamenews add game:` — start typing to search the catalogue.'
        );
    }

    const lines = rows.map(r => {
        const state = !r.is_enabled ? 'paused'
            : r.last_error ? 'error'
            : (r.seen_count ?? 0) === 0 ? 'priming'
            : 'active';
        const posted = r.last_posted_at ? `<t:${Math.floor(new Date(r.last_posted_at).getTime() / 1000)}:R>` : 'never';
        return `\`${String(r.id).padStart(3)}\` **${r.game_label}** — <#${r.channel_id}> · ${state} · every ${r.check_interval_minutes}m · last post ${posted}` +
               (r.last_error ? `\n  ⚠ ${String(r.last_error).slice(0, 120)}` : '');
    });

    const embed = new EmbedBuilder()
        .setColor(0x6366F1)
        .setTitle(`Game news watchers — ${rows.length}`)
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: 'Use the watcher ID with remove / toggle / test' });

    return interaction.editReply({ embeds: [embed] });
}

async function removeWatcher(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const [r] = await pool.execute(
        'DELETE FROM game_patch_watchers WHERE id = ? AND guild_id = ?',
        [id, interaction.guild.id]
    );
    return interaction.editReply(
        r.affectedRows
            ? `Watcher \`${id}\` removed — it will stop posting immediately.`
            : `No watcher \`${id}\` in this server. Run \`/alerts gamenews list\` to see the IDs.`
    );
}

async function toggleWatcher(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');
    const enabled = interaction.options.getBoolean('enabled');
    const [r] = await pool.execute(
        'UPDATE game_patch_watchers SET is_enabled = ? WHERE id = ? AND guild_id = ?',
        [enabled ? 1 : 0, id, interaction.guild.id]
    );
    return interaction.editReply(
        r.affectedRows
            ? `Watcher \`${id}\` is now **${enabled ? 'active' : 'paused'}**.`
            : `No watcher \`${id}\` in this server.`
    );
}

async function testWatcher(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = interaction.options.getInteger('id');

    const [[row]] = await pool.execute(
        'SELECT * FROM game_patch_watchers WHERE id = ? AND guild_id = ?',
        [id, interaction.guild.id]
    );
    if (!row) return interaction.editReply(`No watcher \`${id}\` in this server.`);

    const provider = PROVIDERS[row.provider];
    if (!provider) return interaction.editReply(`Watcher \`${id}\` uses unknown source type \`${row.provider}\`.`);

    const cfg = typeof row.provider_config === 'string'
        ? JSON.parse(row.provider_config || '{}')
        : (row.provider_config || {});

    const started = Date.now();
    let items;
    try {
        items = await provider(cfg, row);
    } catch (err) {
        await pool.execute('UPDATE game_patch_watchers SET last_error = ? WHERE id = ?',
            [String(err.message).slice(0, 500), id]).catch(() => {});
        return interaction.editReply(`**${row.game_label}** could not be read: \`${err.message}\``);
    }

    await pool.execute('UPDATE game_patch_watchers SET last_error = NULL WHERE id = ?', [id]).catch(() => {});

    const embed = new EmbedBuilder()
        .setColor(items.length ? 0x22C55E : 0xF59E0B)
        .setTitle(`${row.game_label} — ${items.length} item(s) visible`)
        .setDescription(
            items.length
                ? items.slice(0, 5).map(i => `• ${i.url ? `[${i.title.slice(0, 90)}](${i.url})` : i.title.slice(0, 90)}`).join('\n')
                : 'The source responded but published nothing readable.'
        )
        .setFooter({ text: `Fetched in ${Date.now() - started}ms · nothing was posted to the channel` });

    return interaction.editReply({ embeds: [embed] });
}

async function showCatalogue(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const byPlatform = new Map();
    for (const p of GAME_NEWS_PRESETS) {
        if (!byPlatform.has(p.platform)) byPlatform.set(p.platform, []);
        byPlatform.get(p.platform).push(p.label);
    }

    const embed = new EmbedBuilder()
        .setColor(0x6366F1)
        .setTitle(`Game news catalogue — ${GAME_NEWS_PRESETS.length} sources`)
        .setDescription('Use `/alerts gamenews add game:` and start typing to search. Anything not listed can still be added with `feed-url:`, `steam-appid:` or `account:`.');

    for (const [platform, labels] of [...byPlatform.entries()].sort()) {
        embed.addFields({
            name: `${platform} (${labels.length})`,
            value: labels.sort().join(', ').slice(0, 1024),
        });
    }

    return interaction.editReply({ embeds: [embed] });
}

export default { execute, autocomplete };
