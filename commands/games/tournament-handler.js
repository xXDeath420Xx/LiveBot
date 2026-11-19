import { EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { getSettings, updateSettings } from '../../core/bgames-settings.js';
import * as T from '../../core/tournament-manager.js';
import { formatCoins } from '../../core/bgames-rewards.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const STATUS_ICON = { registration: '📝', active: '⚔️', completed: '🏆', cancelled: '🚫' };

async function reply(interaction, content, extra = {}) {
    const payload = { content, allowedMentions: { parse: [] }, ...extra };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply({ ...payload, ...EPHEMERAL });
}

async function enabledOrReply(interaction) {
    const s = await getSettings('tournaments', interaction.guildId);
    if (s.enabled) return s;
    await reply(interaction, '❌ Tournaments are turned off in this server.');
    return null;
}

/**
 * The tournament an option points at. With no option, the server's only open tournament (or the
 * only one in `statuses`) is used, so a one-tournament server never has to type an id.
 */
async function resolveTournament(interaction, statuses = ['registration', 'active']) {
    const id = interaction.options.getInteger('tournament');
    if (id) {
        const t = await T.getTournament(interaction.guildId, id);
        if (!t) await reply(interaction, '❌ No tournament with that number here.');
        return t;
    }
    const rows = (await T.listTournaments(interaction.guildId, { includeFinished: statuses.includes('completed') }))
        .filter(t => statuses.includes(t.status));
    if (rows.length === 1) return rows[0];
    await reply(interaction, rows.length
        ? `There are ${rows.length} tournaments — pick one with the \`tournament\` option.`
        : '❌ There is no tournament for that right now.');
    return null;
}

async function resolveMatch(interaction) {
    const found = await T.getMatch(interaction.guildId, interaction.options.getInteger('match'));
    if (!found) await reply(interaction, '❌ No match with that number here.');
    return found;
}

async function staffOrReply(interaction, t = null) {
    if (await T.isStaff(interaction.member, t)) return true;
    await reply(interaction, '❌ Only tournament staff can do that (Manage Server, Manage Events, the organiser role, or the organiser).');
    return false;
}

export async function handleCreate(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const s = await enabledOrReply(interaction);
    if (!s) return;
    if (!(await staffOrReply(interaction))) return;
    const o = interaction.options;
    const channel = o.getChannel('channel')
        || (s.default_channel_id ? interaction.guild.channels.cache.get(s.default_channel_id) : null)
        || interaction.channel;
    try {
        const res = await T.createTournament({
            guild: interaction.guild,
            organizerId: interaction.user.id,
            name: o.getString('name'),
            game: o.getString('game'),
            format: o.getString('format') || 'single',
            maxParticipants: o.getInteger('max-players') ?? 16,
            signupMinutes: o.getInteger('signup-minutes') ?? 60,
            seeding: o.getString('seeding') || 'random',
            prizeCoins: o.getInteger('prize-coins') || 0,
            prizePool: o.getString('prize'),
            rules: o.getString('rules'),
            channel,
        });
        if (!res.ok) return reply(interaction, `❌ ${res.error}`);
        const t = res.tournament;
        return reply(interaction, `✅ **${t.name}** (#${t.id}) is open for sign-ups${res.message ? ` in ${channel}` : ''}. `
            + (t.start_ms ? `It starts <t:${Math.floor(Number(t.start_ms) / 1000)}:R>.` : 'Start it with `/tournament start` when ready.'));
    } catch (err) {
        logger.error('[Tournament] /create failed', { guildId: interaction.guildId, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Something went wrong creating the tournament.');
    }
}

export async function handleJoin(interaction) {
    await interaction.deferReply(EPHEMERAL);
    if (!(await enabledOrReply(interaction))) return;
    const t = await resolveTournament(interaction, ['registration']);
    if (!t) return;
    try {
        const res = await T.join(interaction.guild, t, interaction.member, interaction.options.getString('team'));
        return reply(interaction, res.ok ? `✅ You're in **${t.name}** (${res.count}/${t.max_participants}). Good luck!` : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /join failed', { guildId: interaction.guildId, error: err.message });
        return reply(interaction, '❌ Could not sign you up.');
    }
}

export async function handleLeave(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const t = await resolveTournament(interaction, ['registration']);
    if (!t) return;
    try {
        const res = await T.leave(interaction.guild, t, interaction.user.id);
        return reply(interaction, res.ok ? `✅ You left **${t.name}**.` : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /leave failed', { guildId: interaction.guildId, error: err.message });
        return reply(interaction, '❌ Could not remove you.');
    }
}

export async function handleList(interaction) {
    await interaction.deferReply();
    if (!(await enabledOrReply(interaction))) return;
    try {
        const rows = await T.listTournaments(interaction.guildId, { includeFinished: true, limit: 15 });
        if (!rows.length) return reply(interaction, 'No tournaments yet. Staff can start one with `/tournament create`.');
        const lines = [];
        for (const t of rows) {
            const when = t.status === 'registration' && t.start_ms ? ` · starts <t:${Math.floor(Number(t.start_ms) / 1000)}:R>`
                : t.status === 'completed' && t.winner_id ? ` · won by <@${t.winner_id}>` : '';
            const prize = t.prize_coins > 0 ? ` · ${await formatCoins(interaction.guildId, t.prize_coins)}` : '';
            const link = t.message_id ? ` · [post](https://discord.com/channels/${t.guild_id}/${t.channel_id}/${t.message_id})` : '';
            lines.push(`${STATUS_ICON[t.status] || '•'} **#${t.id} ${t.name}**${t.game ? ` (${t.game})` : ''} — `
                + `${T.FORMAT_LABELS[t.bracket_type] || t.bracket_type}${when}${prize}${link}`);
        }
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('🏆 Tournaments')
            .setDescription(lines.join('\n').slice(0, 4000));
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[Tournament] /list failed', { guildId: interaction.guildId, error: err.message });
        return reply(interaction, '❌ Could not load tournaments.');
    }
}

export async function handleBracket(interaction) {
    await interaction.deferReply();
    if (!(await enabledOrReply(interaction))) return;
    const t = await resolveTournament(interaction, ['registration', 'active', 'completed']);
    if (!t) return;
    try {
        return interaction.editReply({ embeds: [await T.bracketEmbed(interaction.guild, t)], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[Tournament] /bracket failed', { guildId: interaction.guildId, tournamentId: t.id, error: err.message });
        return reply(interaction, '❌ Could not draw the bracket.');
    }
}

export async function handleStart(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const t = await resolveTournament(interaction, ['registration']);
    if (!t) return;
    if (!(await staffOrReply(interaction, t))) return;
    try {
        const res = await T.startTournament(interaction.guild, t.id, interaction.user.id);
        return reply(interaction, res.ok ? `✅ **${t.name}** has started — the bracket is posted.` : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /start failed', { guildId: interaction.guildId, tournamentId: t.id, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Something went wrong starting the bracket.');
    }
}

export async function handleReport(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const found = await resolveMatch(interaction);
    if (!found) return;
    try {
        const res = await T.reportResult(interaction.guild, found.tournament, found.match, interaction.user.id,
            interaction.options.getString('result') === 'won', interaction.options.getString('score'));
        return reply(interaction, res.ok ? res.message : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /report failed', { guildId: interaction.guildId, matchId: found.match.id, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Could not record the report.');
    }
}

export async function handleConfirm(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const found = await resolveMatch(interaction);
    if (!found) return;
    try {
        const staff = await T.isStaff(interaction.member, found.tournament);
        const res = await T.confirmReport(interaction.guild, found.tournament, found.match, interaction.user.id, { staff });
        return reply(interaction, res.ok ? res.message : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /confirm failed', { guildId: interaction.guildId, matchId: found.match.id, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Could not confirm the result.');
    }
}

export async function handleDispute(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const found = await resolveMatch(interaction);
    if (!found) return;
    try {
        const staff = await T.isStaff(interaction.member, found.tournament);
        const res = await T.disputeReport(interaction.guild, found.tournament, found.match, interaction.user.id,
            interaction.options.getString('reason'), { staff });
        return reply(interaction, res.ok ? res.message : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /dispute failed', { guildId: interaction.guildId, matchId: found.match.id, error: err.message });
        return reply(interaction, '❌ Could not dispute the result.');
    }
}

export async function handleSetWinner(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const found = await resolveMatch(interaction);
    if (!found) return;
    if (!(await staffOrReply(interaction, found.tournament))) return;
    try {
        const res = await T.setWinner(interaction.guild, found.tournament, found.match,
            interaction.options.getUser('winner').id, interaction.options.getString('score'),
            interaction.user.id, !!interaction.options.getBoolean('force'));
        return reply(interaction, res.ok ? res.message : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /setwinner failed', { guildId: interaction.guildId, matchId: found.match.id, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Could not set the result.');
    }
}

export async function handleSeed(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const t = await resolveTournament(interaction, ['registration']);
    if (!t) return;
    if (!(await staffOrReply(interaction, t))) return;
    const ids = [...new Set([...String(interaction.options.getString('order')).matchAll(/(\d{15,25})/g)].map(m => m[1]))];
    if (!ids.length) return reply(interaction, '❌ Mention the players best first, e.g. `@alice @bob @carol`.');
    try {
        const res = await T.setSeeds(t, ids);
        return reply(interaction, res.ok
            ? `✅ Seeded ${res.seeded} player(s) in that order; everyone else follows in sign-up order.`
            : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /seed failed', { guildId: interaction.guildId, tournamentId: t.id, error: err.message });
        return reply(interaction, '❌ Could not save the seeds.');
    }
}

export async function handleDisqualify(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const t = await resolveTournament(interaction);
    if (!t) return;
    if (!(await staffOrReply(interaction, t))) return;
    try {
        const res = await T.disqualify(interaction.guild, t, interaction.options.getUser('user').id, interaction.user.id);
        return reply(interaction, res.ok ? (res.message || '✅ Removed.') : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /disqualify failed', { guildId: interaction.guildId, tournamentId: t.id, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Could not withdraw that player.');
    }
}

export async function handleCancel(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const t = await resolveTournament(interaction);
    if (!t) return;
    if (!(await staffOrReply(interaction, t))) return;
    try {
        const res = await T.cancelTournament(interaction.guild, t, interaction.user.id);
        return reply(interaction, res.ok ? `✅ **${t.name}** cancelled.` : `❌ ${res.error}`);
    } catch (err) {
        logger.error('[Tournament] /cancel failed', { guildId: interaction.guildId, tournamentId: t.id, error: err.message });
        return reply(interaction, '❌ Could not cancel it.');
    }
}

export async function handleConfig(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return reply(interaction, '❌ You need **Manage Server** to change tournament settings.');
    }
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    const patch = {};
    const enabled = o.getBoolean('enabled');
    if (enabled !== null) patch.enabled = enabled;
    const ch = o.getChannel('channel');
    if (ch) patch.default_channel_id = ch.id;
    const role = o.getRole('organizer-role');
    if (role) patch.organizer_role_id = role.id;
    const ping = o.getRole('ping-role');
    if (ping) patch.ping_role_id = ping.id;
    if (o.getBoolean('clear-ping-role')) patch.ping_role_id = '';
    const hours = o.getInteger('auto-confirm-hours');
    if (hours !== null) patch.auto_confirm_hours = hours;
    try {
        const s = Object.keys(patch).length
            ? await updateSettings('tournaments', interaction.guildId, patch, interaction.user.id)
            : await getSettings('tournaments', interaction.guildId);
        return reply(interaction, `⚙️ **Tournament settings${Object.keys(patch).length ? ' saved' : ''}**\n`
            + `Enabled: **${s.enabled ? 'yes' : 'no'}** · Default channel: ${s.default_channel_id ? `<#${s.default_channel_id}>` : '_where /create is run_'}\n`
            + `Organiser role: ${s.organizer_role_id ? `<@&${s.organizer_role_id}>` : 'none (Manage Server / Manage Events only)'}`
            + ` · Ping: ${s.ping_role_id ? `<@&${s.ping_role_id}>` : 'none'}\n`
            + `Reports auto-confirm after **${s.auto_confirm_hours} h** if the opponent doesn't respond.`);
    } catch (err) {
        logger.error('[Tournament] /config failed', { guildId: interaction.guildId, error: err.message });
        return reply(interaction, '❌ Could not save the settings.');
    }
}

// ── Autocomplete ────────────────────────────────────────────────────────────────────────────

// Short round tags for autocomplete (the full labels need the bracket size, which this list lacks).
const ROUND_SHORT = (bracket, round) => ({ W: `R${round}`, L: `Losers R${round}`, GF: round === 1 ? 'Grand Final' : 'GF reset', RR: `Round ${round}` }[bracket] || `R${round}`);

export async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const q = String(focused.value || '').toLowerCase();
    const sub = interaction.options.getSubcommand(false);
    if (focused.name === 'tournament') {
        const rows = await T.listTournaments(interaction.guildId, { includeFinished: sub === 'bracket' });
        const want = sub === 'join' || sub === 'leave' || sub === 'start' || sub === 'seed'
            ? rows.filter(t => t.status === 'registration') : rows;
        return interaction.respond(want
            .filter(t => !q || `${t.id} ${t.name}`.toLowerCase().includes(q))
            .slice(0, 25)
            .map(t => ({ name: `#${t.id} ${t.name} (${t.status})`.slice(0, 100), value: Number(t.id) })));
    }
    if (focused.name === 'match') {
        const rows = sub === 'setwinner'
            ? await T.decidableMatches(interaction.guildId)
            : await T.openMatchesForUser(interaction.guildId, interaction.user.id);
        const want = sub === 'confirm' || sub === 'dispute'
            ? rows.filter(m => m.status === 'reported' && m.reported_by !== interaction.user.id)
            : sub === 'report' ? rows.filter(m => m.status === 'ready' || m.reported_by !== interaction.user.id) : rows;
        return interaction.respond(want
            .map(m => ({
                name: `#${m.id} ${m.tournament_name} · ${ROUND_SHORT(m.bracket, m.round_number)}`
                    + ` · ${m.status}`,
                value: Number(m.id),
            }))
            .filter(c => !q || c.name.toLowerCase().includes(q))
            .slice(0, 25)
            .map(c => ({ ...c, name: c.name.slice(0, 100) })));
    }
    return interaction.respond([]);
}

// ── Buttons: bgt:join:<tid> · bgt:leave:<tid> · bgt:ok:<matchId> · bgt:no:<matchId> ─────────

export async function handleTournamentButton(interaction) {
    const [, action, rawId] = interaction.customId.split(':');
    const id = Number(rawId);
    if (!interaction.guild || !Number.isInteger(id)) return false;
    try {
        await interaction.deferReply(EPHEMERAL);
        if (action === 'join' || action === 'leave') {
            const t = await T.getTournament(interaction.guildId, id);
            if (!t) return reply(interaction, '❌ That tournament no longer exists.');
            const res = action === 'join'
                ? await T.join(interaction.guild, t, interaction.member)
                : await T.leave(interaction.guild, t, interaction.user.id);
            return reply(interaction, res.ok
                ? (action === 'join' ? `✅ You're in **${t.name}** (${res.count}/${t.max_participants}). Good luck!` : `✅ You left **${t.name}**.`)
                : `❌ ${res.error}`);
        }
        if (action === 'ok' || action === 'no') {
            const found = await T.getMatch(interaction.guildId, id);
            if (!found) return reply(interaction, '❌ That match no longer exists.');
            const staff = await T.isStaff(interaction.member, found.tournament);
            const res = action === 'ok'
                ? await T.confirmReport(interaction.guild, found.tournament, found.match, interaction.user.id, { staff })
                : await T.disputeReport(interaction.guild, found.tournament, found.match, interaction.user.id, null, { staff });
            return reply(interaction, res.ok ? res.message : `❌ ${res.error}`);
        }
        return reply(interaction, '❌ Unknown button.');
    } catch (err) {
        logger.error('[Tournament] Button failed', { customId: interaction.customId, guildId: interaction.guildId, error: err.message, stack: err.stack });
        return reply(interaction, '❌ Something went wrong.').catch(() => {});
    }
}
