import { EmbedBuilder } from 'discord.js';
import { formatDuration, SEGMENTS, DORMANT_DAYS } from './activity-audit.js';

/**
 * Discord rendering for a stored audit.
 *
 * Kept apart from the engine so the command, the dashboard's "post to Discord" button and
 * any future scheduled run all emit the identical report. The previous incarnation of this
 * audit had its formatting inline in a one-off script, which is how the median ended up
 * hardcoded to "4" and a "zero channels denied" claim survived into a run that had not
 * checked.
 */

const COLOR = { ink: 0x136E76, teal: 0x2E9AA0, muted: 0x5A6A6E, ember: 0x9C5A22, red: 0xA33A2A };
const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const md = (s) => String(s ?? '').replace(/([*_~`|\\<>[\]])/g, '\\$1');
const pad = (s, w) => String(s).padStart(w, ' ');

function chunk(lines, limit = 3900) {
    const out = [];
    let buf = '';
    for (const l of lines) {
        if (buf.length + l.length + 1 > limit) { out.push(buf); buf = ''; }
        buf += (buf ? '\n' : '') + l;
    }
    if (buf) out.push(buf);
    return out;
}

function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

/**
 * @param {Object} loaded - result of loadAudit()
 * @param {Object} [opts]
 * @param {Object} [opts.diff] - result of compareAudits()
 * @param {string} [opts.guildName]
 * @param {string} [opts.link] - dashboard or artifact URL for the full table
 * @returns {EmbedBuilder[]}
 */
export function buildAuditEmbeds(loaded, opts = {}) {
    const { audit, members, ctx } = loaded;
    const seg = (key) => {
        const s = SEGMENTS.find(x => x.key === key);
        return members.filter(m => s.predicate(m, ctx));
    };

    const posters = members.filter(m => m.messages > 0).sort((a, b) => b.messages - a.messages);
    const voice = members.filter(m => m.voiceSeconds > 0).sort((a, b) => b.voiceSeconds - a.voiceSeconds);
    const from = new Date(ctx.windowStartMs).toISOString().slice(0, 10);
    const to = new Date(ctx.nowMs).toISOString().slice(0, 10);
    const embeds = [];

    // ── summary ─────────────────────────────────────────────────────────────
    const scanned = audit.scanned ?? {};
    const coverage = (scanned.denied ?? 0) === 0
        ? `All **${scanned.containers ?? '?'}** channels and threads were read to the cutoff — a complete census, not a sample.`
        : `Read **${scanned.readable}** of **${scanned.containers}** channels and threads; **${scanned.denied}** could not be read by the bot and are excluded from every figure.`;

    const summary = new EmbedBuilder()
        .setColor(COLOR.ink)
        .setTitle(`${audit.windowDays}-Day Activity Audit`)
        .setDescription(
            `Every member of **${md(opts.guildName ?? 'this server')}** measured between ` +
            `**${from}** and **${to}**, by messages *and* time in voice.\n\n${coverage}`)
        .addFields(
            { name: 'Members covered', value: `**${n(members.length)}**`, inline: true },
            { name: 'Posted', value: `**${n(posters.length)}**`, inline: true },
            { name: 'In voice', value: audit.voiceTracked ? `**${n(voice.length)}**` : '_not tracked_', inline: true },
            { name: 'Messages', value: n(audit.totals?.humanMessages), inline: true },
            { name: 'Median / poster', value: String(median(posters.map(p => p.messages))), inline: true },
            { name: 'Voice hours', value: audit.voiceTracked ? n(Math.round((audit.totals?.voiceSeconds ?? 0) / 3600)) : '—', inline: true },
        )
        .setFooter({ text: `Audit #${audit.id} · counts are exact, not sampled` })
        .setTimestamp(new Date(audit.completedAt ?? Date.now()));
    if (opts.link) summary.setURL(opts.link);
    embeds.push(summary);

    // ── the flags worth acting on ───────────────────────────────────────────
    // Deliberately ahead of the rosters: this is the part a leader acts on, and burying it
    // under a hundred ranked names is how it gets skipped.
    const flagKeys = ['never_active', 'newcomer_silent', 'dormant_30', 'one_message_no_voice', 'one_voice_no_text', 'voice_only'];
    const flagLines = [];
    for (const key of flagKeys) {
        const s = SEGMENTS.find(x => x.key === key);
        const list = seg(key);
        if (!list.length) continue;
        // Voice-derived groups are meaningless when the voice log does not cover the window;
        // showing them as empty would read as "nobody does this" rather than "not measured".
        if (!audit.voiceTracked && /voice/.test(key)) continue;
        const names = list
            .sort((a, b) => (b.messages - a.messages) || (b.voiceSeconds - a.voiceSeconds))
            .slice(0, 12).map(m => md(m.displayName)).join(', ');
        flagLines.push(`**${s.label} — ${list.length}**\n${names}${list.length > 12 ? ` +${list.length - 12} more` : ''}`);
    }
    if (flagLines.length) {
        embeds.push(new EmbedBuilder()
            .setColor(COLOR.ember)
            .setTitle('⚑ Worth a look')
            .setDescription(flagLines.join('\n\n').slice(0, 4000))
            .setFooter({ text: `"Quiet ${DORMANT_DAYS}+ days" means active earlier in the window, then nothing in either channels or voice.` }));
    }

    // ── movement ────────────────────────────────────────────────────────────
    if (opts.diff) {
        const d = opts.diff;
        const parts = [`Compared with audit **#${d.previous.id}** (${d.previous.windowDays}-day window, ` +
            `${new Date(d.previous.completedAt).toISOString().slice(0, 10)}).`];
        if (d.becameActive.length) parts.push(`\n**Active now, wasn't before** — ${d.becameActive.length}\n` +
            d.becameActive.slice(0, 20).map(m => md(m.displayName)).join(', ') +
            (d.becameActive.length > 20 ? ` +${d.becameActive.length - 20} more` : ''));
        if (d.wentQuiet.length) parts.push(`\n**Was active, now silent** — ${d.wentQuiet.length}\n` +
            d.wentQuiet.slice(0, 20).map(m => md(m.displayName)).join(', ') +
            (d.wentQuiet.length > 20 ? ` +${d.wentQuiet.length - 20} more` : ''));
        if (d.risingByMessages.length) parts.push(`\n**Biggest message increases**\n` +
            d.risingByMessages.slice(0, 5).map(x => `${md(x.displayName)} ${x.messagesBefore} → **${x.messages}**`).join(', '));
        if (d.risingByVoice.length) parts.push(`\n**Biggest voice increases**\n` +
            d.risingByVoice.slice(0, 5).map(x => `${md(x.displayName)} ${formatDuration(x.voiceBefore)} → **${formatDuration(x.voiceSeconds)}**`).join(', '));

        const notes = ['Matched on user id, so a rename is a rename and not a departure plus an arrival.'];
        if (d.renamed.length) notes.push(`${d.renamed.length} member${d.renamed.length === 1 ? '' : 's'} renamed since.`);
        notes.push('Counts below the previous audit usually mean the window slid past older activity, so only increases are listed.');

        embeds.push(new EmbedBuilder()
            .setColor(COLOR.muted)
            .setTitle('△ Movement since the last audit')
            .setDescription(parts.join('\n').slice(0, 4000))
            .setFooter({ text: notes.join(' · ').slice(0, 2040) }));
    }

    // ── rosters ─────────────────────────────────────────────────────────────
    const CORE_MSGS = 5;
    const core = posters.filter(p => p.messages > CORE_MSGS);
    const occ = posters.filter(p => p.messages <= CORE_MSGS);

    chunk(core.map((p, i) => `\`${pad('#' + (i + 1), 3)} ${pad(n(p.messages), 5)}\` **${md(p.displayName)}**`))
        .forEach((desc, i, a) => embeds.push(new EmbedBuilder()
            .setColor(COLOR.teal)
            .setTitle(i === 0 ? `⬥ The ${core.length} regulars — more than ${CORE_MSGS} messages` : '⬥ Regulars (cont.)')
            .setDescription(desc)
            .setFooter(i === a.length - 1 ? { text: `${core.length} members · ${n(core.reduce((s, p) => s + p.messages, 0))} messages` } : null)));

    chunk(occ.map((p, i) => `\`${pad('#' + (core.length + i + 1), 3)} ${pad(n(p.messages), 5)}\` ${md(p.displayName)}`))
        .forEach((desc, i, a) => embeds.push(new EmbedBuilder()
            .setColor(COLOR.muted)
            .setTitle(i === 0 ? `· The ${occ.length} occasional — ${CORE_MSGS} messages or fewer` : '· Occasional (cont.)')
            .setDescription(desc)
            .setFooter(i === a.length - 1 ? { text: `${occ.length} members · ${n(occ.reduce((s, p) => s + p.messages, 0))} messages` } : null)));

    if (audit.voiceTracked && voice.length) {
        const VOICE_CORE = 3600;
        const vCore = voice.filter(v => v.voiceSeconds >= VOICE_CORE);
        const vOcc = voice.filter(v => v.voiceSeconds < VOICE_CORE);
        const line = (v, i, bold) => `\`${pad('#' + (i + 1), 3)} ${pad(formatDuration(v.voiceSeconds), 5)}\` ` +
            `${bold ? `**${md(v.displayName)}**` : md(v.displayName)} \`${v.voiceSessions}\``;

        chunk(vCore.map((v, i) => line(v, i, true)))
            .forEach((desc, i, a) => embeds.push(new EmbedBuilder()
                .setColor(COLOR.teal)
                .setTitle(i === 0 ? `🔊 The ${vCore.length} in voice an hour or more` : '🔊 In voice (cont.)')
                .setDescription(desc)
                .setFooter(i === a.length - 1
                    ? { text: `${vCore.length} members · ${n(Math.round(vCore.reduce((s, v) => s + v.voiceSeconds, 0) / 3600))} hours · trailing number is session count` }
                    : null)));

        chunk(vOcc.map((v, i) => line(v, i + vCore.length, false)))
            .forEach((desc, i, a) => embeds.push(new EmbedBuilder()
                .setColor(COLOR.muted)
                .setTitle(i === 0 ? `· The ${vOcc.length} in voice under an hour` : '· In voice, brief (cont.)')
                .setDescription(desc)
                .setFooter(i === a.length - 1 ? { text: `${vOcc.length} members` } : null)));
    }

    return embeds;
}
