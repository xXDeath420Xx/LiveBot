/*
 * /steam — who in this server owns which Steam game. Members link once (Steam sign-in or a
 * pasted profile link); everything after that is a query against core/steam-library-manager.js.
 * Distinct from /media steam, which watches store pages for news and prices.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import {
    STEAM_COLOR, SteamLibraryError, buildLinkPrompt, getLink, syncLibrary, refreshWaitMs, refreshPanels,
    unshareFromGuild, unlinkEverywhere, guildsSharedBy, isSharedWith, searchGuildGames, gameOwners, appName,
    topGames, guildStats, commonGames, getConfig, postPanel, createNight, storeUrl, linkUrl,
} from '../../core/steam-library-manager.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const STATUS_DOT = { online: '🟢', idle: '🌙', dnd: '⛔' };
const clean = s => String(s).replace(/[*_`~|]/g, '');

async function resolveGame(guildId, input) {
    const s = String(input || '').trim();
    if (/^\d{1,10}$/.test(s)) return { appId: Number(s), name: await appName(Number(s)) };
    const [hit] = await searchGuildGames(guildId, s, 1);
    return hit || null;
}

function mentionList(ids, max = 40) {
    const shown = ids.slice(0, max).map(id => `<@${id}>`).join(' ');
    return ids.length > max ? `${shown} … +${ids.length - max} more` : shown;
}

export default {
    category: 'games',
    data: new SlashCommandBuilder()
        .setName('steam')
        .setDescription('Who owns which Steam game here — plan game nights around it')
        .setDMPermission(false)
        .addSubcommand(s => s.setName('link').setDescription('Link your Steam so your games are counted in this server'))
        .addSubcommand(s => s.setName('who').setDescription('Who here owns a game (and who is online)')
            .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('common').setDescription('Games a group all own. Uses your voice channel if nobody is picked')
            .addUserOption(o => o.setName('user1').setDescription('Someone to include'))
            .addUserOption(o => o.setName('user2').setDescription('Someone to include'))
            .addUserOption(o => o.setName('user3').setDescription('Someone to include'))
            .addUserOption(o => o.setName('user4').setDescription('Someone to include'))
            .addUserOption(o => o.setName('user5').setDescription('Someone to include'))
            .addBooleanOption(o => o.setName('voice').setDescription('Also include everyone in your voice channel')))
        .addSubcommand(s => s.setName('top').setDescription('The most-owned games in this server')
            .addIntegerOption(o => o.setName('page').setDescription('Page').setMinValue(1).setMaxValue(20)))
        .addSubcommand(s => s.setName('me').setDescription('Your link status (only you see it)'))
        .addSubcommand(s => s.setName('refresh').setDescription('Re-read your games from Steam now'))
        .addSubcommand(s => s.setName('unlink').setDescription('Stop counting your games here, or delete everything')
            .addBooleanOption(o => o.setName('everywhere').setDescription('Delete your Steam link and games from every server')))
        .addSubcommand(s => s.setName('night').setDescription('Post a game night card with RSVP buttons')
            .addStringOption(o => o.setName('game').setDescription('Game').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('when').setDescription('e.g. "in 3h", "Friday 9pm EST", or a <t:…> timestamp').setMaxLength(100))
            .addStringOption(o => o.setName('note').setDescription('Anything people should know').setMaxLength(300))
            .addBooleanOption(o => o.setName('ping-owners').setDescription('Ping everyone here who owns it (default: no)')))
        .addSubcommand(s => s.setName('panel').setDescription('[Admin] Post the live "who owns what" board with link buttons')
            .addChannelOption(o => o.setName('channel').setDescription('Where to post it')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))),

    async autocomplete(interaction) {
        if (!interaction.guildId) return interaction.respond([]);
        const focused = interaction.options.getFocused();
        const games = await searchGuildGames(interaction.guildId, focused, 25);
        await interaction.respond(games.map(g => ({
            name: `${g.name} · ${g.owners} own${g.owners === 1 ? 's' : ''}`.slice(0, 100),
            value: String(g.appId),
        })));
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        if (!guildId) return interaction.reply({ content: 'This only works in a server.', ...EPHEMERAL });

        try {
            switch (sub) {
                case 'link': return interaction.reply({ ...(await buildLinkPrompt(guildId, interaction.user.id)), ...EPHEMERAL });
                case 'who': return handleWho(interaction);
                case 'common': return handleCommon(interaction);
                case 'top': return handleTop(interaction);
                case 'me': return handleMe(interaction);
                case 'refresh': return handleRefresh(interaction);
                case 'unlink': return handleUnlink(interaction);
                case 'night': return handleNight(interaction);
                case 'panel': return handlePanel(interaction);
            }
        } catch (err) {
            const msg = err instanceof SteamLibraryError ? err.message : 'Something went wrong talking to Steam. Try again in a minute.';
            if (!(err instanceof SteamLibraryError)) logger.error(`[/steam ${sub}]`, { error: err.message, stack: err.stack });
            const payload = { content: `❌ ${msg}`, ...EPHEMERAL };
            if (interaction.deferred || interaction.replied) return interaction.editReply({ content: payload.content }).catch(() => {});
            return interaction.reply(payload).catch(() => {});
        }
    },
};

async function handleWho(interaction) {
    await interaction.deferReply();
    const game = await resolveGame(interaction.guildId, interaction.options.getString('game'));
    if (!game) return interaction.editReply('Nobody here who linked Steam owns a game by that name.');
    const owners = await gameOwners(interaction.guildId, game.appId);

    // Online first: the question is usually "who can play right now".
    const guild = interaction.guild;
    const members = owners.length ? await guild.members.fetch({ user: owners.slice(0, 100) }).catch(() => null) : null;
    const rows = owners.map(id => {
        const status = members?.get(id)?.presence?.status;
        return { id, status, rank: status === 'online' ? 0 : status === 'idle' ? 1 : status === 'dnd' ? 2 : 3 };
    }).sort((a, b) => a.rank - b.rank);
    const online = rows.filter(r => r.rank < 3).length;

    let body = rows.map(r => `${STATUS_DOT[r.status] || '⚫'} <@${r.id}>`).join('\n') || '*Nobody who linked owns it.*';
    while (body.length > 3800) body = body.split('\n').slice(0, -1).join('\n');

    const embed = new EmbedBuilder()
        .setColor(STEAM_COLOR)
        .setTitle(clean(game.name).slice(0, 256))
        .setURL(storeUrl(game.appId))
        .setDescription(body)
        .setFooter({ text: `${owners.length} own it · ${online} online now · only members who linked Steam are counted` });
    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCommon(interaction) {
    await interaction.deferReply();
    const ids = new Set([interaction.user.id]);
    for (let i = 1; i <= 5; i++) {
        const u = interaction.options.getUser(`user${i}`);
        if (u && !u.bot) ids.add(u.id);
    }
    const picked = ids.size > 1;
    const vc = interaction.member?.voice?.channel;
    if (interaction.options.getBoolean('voice') || !picked) {
        if (vc) vc.members.forEach(m => { if (!m.user.bot) ids.add(m.id); });
        else if (!picked) {
            return interaction.editReply("Pick some people (`user1`…`user5`), or join a voice channel and I'll use everyone in it.");
        }
    }
    if (ids.size < 2) return interaction.editReply("That's just you. Add someone else to compare with.");

    const r = await commonGames(interaction.guildId, [...ids]);
    const lines = [];
    if (r.counted.length < 2) {
        lines.push('Fewer than two of those people have linked Steam here, so there is nothing to compare.');
    } else {
        lines.push(`**All ${r.counted.length} of you own (${r.all.length}):**`);
        let all = r.all.map(g => `• [${clean(g.name)}](${storeUrl(g.appId)})`);
        if (!all.length) all = ['*Nothing in common. Check the list below.*'];
        let block = all.slice(0, 30).join('\n');
        if (all.length > 30) block += `\n… and ${all.length - 30} more`;
        lines.push(block);
        if (r.almost.length) {
            lines.push('', `**Everyone but one (${r.almost.length}):**`);
            lines.push(r.almost.slice(0, 12).map(g => `• ${clean(g.name)}: missing <@${g.missing[0]}>`).join('\n'));
        }
    }
    if (r.notShared.length) {
        lines.push('', `-# Not counted (haven't linked Steam here, or their game list is private): ${mentionList(r.notShared, 15)}`);
    }
    let desc = lines.join('\n');
    if (desc.length > 4000) desc = desc.slice(0, 3990) + '\n…';
    const embed = new EmbedBuilder()
        .setColor(STEAM_COLOR)
        .setTitle(`🎮 Games in common${vc && !picked ? ` · ${clean(vc.name)}` : ''}`.slice(0, 256))
        .setDescription(desc)
        .setFooter({ text: '/steam night to put one on the calendar' });
    return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleTop(interaction) {
    await interaction.deferReply();
    const page = interaction.options.getInteger('page') || 1;
    const games = await topGames(interaction.guildId, { limit: 20, offset: (page - 1) * 20 });
    const stats = await guildStats(interaction.guildId);
    const body = games.map((g, i) => `\`${String((page - 1) * 20 + i + 1).padStart(3)}\` **${clean(g.name)}** · ${g.owners}`).join('\n')
        || (stats.members ? '*No games on this page.*' : '*Nobody has linked Steam here yet. `/steam link`*');
    const embed = new EmbedBuilder()
        .setColor(STEAM_COLOR)
        .setTitle('🏆 Most-owned games here')
        .setDescription(body)
        .setFooter({ text: `Page ${page} · ${stats.members} linked · ${stats.games} different games` });
    return interaction.editReply({ embeds: [embed] });
}

async function handleMe(interaction) {
    const link = await getLink(interaction.user.id);
    if (!link) return interaction.reply({ ...(await buildLinkPrompt(interaction.guildId, interaction.user.id)), ...EPHEMERAL });
    const shared = await guildsSharedBy(interaction.user.id);
    const synced = link.synced_at ? `<t:${Math.floor(new Date(link.synced_at).getTime() / 1000)}:R>` : 'not yet';
    const lines = [
        `**Steam account:** [your profile](https://steamcommunity.com/profiles/${link.steam_id64}) ${link.verified ? '(verified)' : '(not verified)'}`,
        `**Games:** ${link.sync_status === 'private' ? 'your game list is private on Steam, so none are counted' : link.game_count}`,
        `**Last read from Steam:** ${synced}`,
        `**Counted in:** ${shared.includes(interaction.guildId) ? 'this server' : 'not this server'}${shared.length > 1 ? ` + ${shared.length - (shared.includes(interaction.guildId) ? 1 : 0)} other(s)` : ''}`,
        '',
        '-# Only you can see this. `/steam unlink` removes you from this server; `everywhere:true` deletes it all.',
    ];
    return interaction.reply({ content: lines.join('\n'), ...EPHEMERAL });
}

async function handleRefresh(interaction) {
    const link = await getLink(interaction.user.id);
    if (!link) return interaction.reply({ ...(await buildLinkPrompt(interaction.guildId, interaction.user.id)), ...EPHEMERAL });
    const wait = refreshWaitMs(link);
    if (wait > 0) {
        return interaction.reply({ content: `⏳ Refreshed recently. Try again <t:${Math.ceil((Date.now() + wait) / 1000)}:R>.`, ...EPHEMERAL });
    }
    await interaction.deferReply(EPHEMERAL);
    const r = await syncLibrary(interaction.user.id);
    refreshPanels(await guildsSharedBy(interaction.user.id));
    const msg = {
        ok: `✅ Got **${r.count}** games from Steam.`,
        private: '🔒 Steam says your game list is private, so nothing is counted. Set **Game details: Public** in Steam\'s privacy settings, then refresh.',
        error: '⚠️ Steam did not answer. Try again in a few minutes.',
    }[r.status];
    return interaction.editReply(msg);
}

async function handleUnlink(interaction) {
    if (interaction.options.getBoolean('everywhere')) {
        const guilds = await unlinkEverywhere(interaction.user.id);
        refreshPanels(guilds, 2000);
        return interaction.reply({ content: '🗑️ Deleted. Your Steam link and game list are gone from every server.', ...EPHEMERAL });
    }
    if (!(await isSharedWith(interaction.guildId, interaction.user.id))) {
        return interaction.reply({ content: "Your games aren't counted in this server. (`everywhere:true` deletes your link entirely.)", ...EPHEMERAL });
    }
    const { deletedAll } = await unshareFromGuild(interaction.guildId, interaction.user.id);
    refreshPanels([interaction.guildId], 2000);
    return interaction.reply({
        content: deletedAll
            ? '🗑️ Removed. You weren\'t sharing with any other server, so your link and game list are deleted.'
            : '✅ Your games are no longer counted here. Other servers you linked in still see them.',
        ...EPHEMERAL,
    });
}

async function handleNight(interaction) {
    const game = await resolveGame(interaction.guildId, interaction.options.getString('game'));
    if (!game) return interaction.reply({ content: 'Pick a game from the list. Only games someone here owns can be suggested.', ...EPHEMERAL });
    const channel = interaction.channel;
    const perms = channel?.permissionsFor?.(interaction.guild.members.me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
        return interaction.reply({ content: "I can't post embeds in this channel.", ...EPHEMERAL });
    }
    await interaction.deferReply(EPHEMERAL);
    const { message } = await createNight({
        guildId: interaction.guildId, channel, hostId: interaction.user.id, appId: game.appId,
        whenText: interaction.options.getString('when'), note: interaction.options.getString('note'),
        pingOwners: !!interaction.options.getBoolean('ping-owners'),
    });
    return interaction.editReply(`✅ Posted: ${message.url}`);
}

async function handlePanel(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** for that.', ...EPHEMERAL });
    }
    const channel = interaction.options.getChannel('channel');
    await interaction.deferReply(EPHEMERAL);
    const msg = await postPanel(interaction.guildId, channel.id);
    const cfg = await getConfig(interaction.guildId);
    return interaction.editReply(
        `✅ Board posted: ${msg.url}\nIt updates itself as people link. Members can also use \`/steam link\`, or this sign-in link: <${linkUrl(interaction.guildId)}>` +
        (cfg.public_token ? '' : '\n-# Want a shareable web page of the list? Turn it on under Dashboard → Steam Library.'));
}
