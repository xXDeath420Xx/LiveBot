/*
 * `/avatarfilter nsfw …` — NSFW protection (core/nsfw-protection.js): the avatar side's settings, a test
 * of a member's avatar or an image, the member scan (review-only), the NSFW review queue (avatars and chat
 * images) with Ban / Kick / Not NSFW / Skip / Overturn, and the status (model installed?, today's scans
 * against the cap). The chat-image settings are `/link-filter threats nsfw-images`; everything is also on
 * the dashboard's NSFW Protection page, which shows the avatars (blurred until clicked).
 *
 * A group of /avatarfilter rather than a new top-level command (the bot is near Discord's 100). Access is
 * checked by avatarfilter.js (configure access, judged live); ban / kick need that permission too.
 */
import { EmbedBuilder } from 'discord.js';
import nsfw from '../../core/nsfw-protection.js';
import { pct } from '../../core/nsfw-logic.js';
import { actorMay } from './namefilter.js';

const EPHEMERAL = { flags: 64 };
const QUIET = { allowedMentions: { parse: [] } };
const ACTION_WORD = { log: 'log only + review', flag: 'flag with a role', kick: 'kick', ban: 'ban' };
const dash = (guildId) => `${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '')}/manage/${guildId}?page=nsfw-protection`;
const ts = (d) => Math.floor(new Date(d).getTime() / 1000);
const isImageAttachment = (a) => !!a && /^image\/(png|jpe?g|webp|gif)$/i.test(a.contentType || '');

/** Options for the `nsfw` subcommand group (built here so avatarfilter.js stays readable). */
export function nsfwGroup(group) {
    return group.setName('nsfw').setDescription('NSFW avatars and chat images: local models, two-stage, review queue')
        .addSubcommand(s => s.setName('settings').setDescription('NSFW avatar checks: on/off, action, thresholds, daily cap')
            .addBooleanOption(o => o.setName('enabled').setDescription('Check avatars on join and on every change'))
            .addStringOption(o => o.setName('action').setDescription('When both models agree').addChoices(
                { name: 'Log only + review queue (default)', value: 'log' }, { name: 'Flag with a role', value: 'flag' },
                { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
            .addNumberOption(o => o.setName('act_at').setDescription('Both models at or above this (0.80-0.99, default 0.90)').setMinValue(0.8).setMaxValue(0.99))
            .addNumberOption(o => o.setName('review_at').setDescription('Queue for review at or above (0.30-0.99, default 0.60)').setMinValue(0.3).setMaxValue(0.99))
            .addIntegerOption(o => o.setName('daily_cap').setDescription('Most avatar scans a day (10-50000, default 1000)').setMinValue(10).setMaxValue(50000))
            .addBooleanOption(o => o.setName('dm').setDescription('Tell kicked / banned members why')))
        .addSubcommand(s => s.setName('status').setDescription('Model installed?, settings, today\'s scans and the queue'))
        .addSubcommand(s => s.setName('test').setDescription('Score a member\'s avatar or an image (nothing is stored)')
            .addUserOption(o => o.setName('user').setDescription('A member'))
            .addAttachmentOption(o => o.setName('image').setDescription('An image')))
        .addSubcommand(s => s.setName('scan').setDescription('Check every member\'s avatar now (review only, within the cap)'))
        .addSubcommand(s => s.setName('review').setDescription('The NSFW review queue: borderline finds and actions you can overturn'))
        .addSubcommand(s => s.setName('decide').setDescription('Decide or overturn a queue entry')
            .addUserOption(o => o.setName('user').setDescription('Member in the queue').setRequired(true))
            .addStringOption(o => o.setName('decision').setDescription('What to do').setRequired(true).addChoices(
                { name: 'Overturn (undo the bot\'s action, remember the picture as safe)', value: 'overturn' },
                { name: 'Not NSFW (remember the picture as safe)', value: 'safe' },
                { name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Skip', value: 'skip' }))
            .addStringOption(o => o.setName('which').setDescription('Avatar (default) or chat image').addChoices(
                { name: 'Avatar', value: 'avatar' }, { name: 'Chat image', value: 'image' })));
}

function describe(o) {
    const a = o.avatar;
    const i = o.image;
    const m = o.model;
    return [
        m.installed ? '**Model:** installed.' : m.partial ? '**Model:** first stage only (the second model is missing), so nothing is ever acted on.'
            : `**Model not installed** (${m.missing.join('; ')}). Nothing is scanned until it is.`,
        `**Avatars:** ${a.enabled ? 'on' : 'off'} · ${ACTION_WORD[a.action]} when both models are at ${pct(a.act)} or more · review from ${pct(a.review)} · DM ${a.dm ? 'on' : 'off'}`,
        `**Chat images:** ${i.enabled ? 'on' : 'off'} · ${i.action}${i.action === 'timeout' ? ` ${i.timeoutMinutes} min` : ''} · act ${pct(i.act)}, review ${pct(i.review)} (\`/link-filter threats nsfw-images\`)`,
        `**Today:** avatars ${o.cap.avatar.used}/${o.cap.avatar.limit} scans, chat images ${o.cap.image.used}/${o.cap.image.limit} scans`,
    ].join('\n');
}

async function status(interaction, guild) {
    const o = await nsfw.overview(guild);
    const live = o.usage.today.sinceRestart;
    const skipped = (s) => s.capped + s.dropped;
    const embed = new EmbedBuilder().setTitle('NSFW protection').setDescription(describe(o))
        .addFields(
            { name: 'Review queue', value: `avatars ${o.counts.avatar.pending ?? 0} waiting, ${o.counts.avatar.actioned ?? 0} acted on · images ${o.counts.image.pending ?? 0} waiting, ${o.counts.image.actioned ?? 0} acted on`, inline: false },
            { name: 'Since the last restart', value: `avatars: ${live.avatar.scanned} scanned, ${live.avatar.nsfw} NSFW, ${skipped(live.avatar)} skipped · images: ${live.image.scanned} scanned, ${live.image.nsfw} NSFW, ${skipped(live.image)} skipped`, inline: false },
            { name: 'Classifier', value: `${o.model.workers.running}/${o.model.workers.max} worker(s) · queue ${o.model.queue.priority + o.model.queue.normal} · ${o.model.queue.dropped} dropped when busy${o.model.avgMs ? ` · ${o.model.avgMs} ms average` : ''}`, inline: false })
        .setFooter({ text: 'Dashboard: NSFW Protection page' });
    if (o.scan.running) embed.addFields({ name: 'Member scan', value: `${o.scan.checked}/${o.scan.total ?? '?'} checked, ${o.scan.found} queued` });
    return interaction.reply({ embeds: [embed], ...QUIET, ...EPHEMERAL });
}

async function settings(interaction, guild) {
    const o = interaction.options;
    const patch = {};
    if (o.getBoolean('enabled') !== null) patch.enabled = o.getBoolean('enabled');
    if (o.getString('action')) patch.action = o.getString('action');
    if (o.getNumber('act_at') !== null) patch.act = o.getNumber('act_at');
    if (o.getNumber('review_at') !== null) patch.review = o.getNumber('review_at');
    if (o.getInteger('daily_cap') !== null) patch.dailyCap = o.getInteger('daily_cap');
    if (o.getBoolean('dm') !== null) patch.dm = o.getBoolean('dm');
    if (!Object.keys(patch).length) return status(interaction, guild);
    const out = await nsfw.saveSettings(guild, 'avatar', patch, interaction.user.id);
    if (!out.ok) return interaction.reply({ content: out.error, ...EPHEMERAL });
    const ov = await nsfw.overview(guild);
    return interaction.reply({ content: `Saved.\n${describe(ov)}`, ...QUIET, ...EPHEMERAL });
}

async function test(interaction, guild) {
    const user = interaction.options.getUser('user');
    const image = interaction.options.getAttachment('image');
    if (!user && !image) return interaction.reply({ content: 'Give a `user` or an `image` to test.', ...EPHEMERAL });
    if (image && !isImageAttachment(image)) return interaction.reply({ content: 'Attach a PNG, JPEG, WebP or GIF image.', ...EPHEMERAL });
    await interaction.deferReply(EPHEMERAL);
    let r;
    if (user) {
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply({ content: 'They are not in this server.' });
        r = await nsfw.testImage(guild, { member, surface: 'avatar' });
    } else {
        const res = await fetch(image.url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
        if (!res?.ok) return interaction.editReply({ content: 'Could not download that image.' });
        r = await nsfw.testImage(guild, { buffer: Buffer.from(await res.arrayBuffer()), surface: 'image' });
    }
    if (!r.installed) return interaction.editReply({ content: `The NSFW model is not installed yet: ${r.missing.join('; ')}.` });
    const word = { nsfw: '**NSFW** (both models agree: the action applies)', review: 'borderline (review queue only)', clean: 'clean',
        minor: '**label suggesting minors**', safe: 'remembered as safe', skipped: 'not scored' };
    const lines = r.results.map(x => `${x.scope === 'server' ? 'Server avatar' : x.scope === 'upload' ? 'Image' : 'Avatar'}: ${word[x.status] ?? x.status}`
        + `${x.line ? `\n  ${x.line}` : ''}${x.why ? `\n  ${x.why}` : ''}`);
    return interaction.editReply({
        content: [`Act at ${pct(r.thresholds.act)} (both models), review at ${pct(r.thresholds.review)}.`, ...lines, ...r.notes].join('\n').slice(0, 1900) || 'Nothing to test.',
        ...QUIET,
    });
}

async function scan(interaction, guild) {
    const out = nsfw.startScan(guild, interaction.user.id);
    return interaction.reply({
        content: out.ok ? `Scan started. It never acts: finds go to the NSFW review queue (it stops at today's cap). ${dash(guild.id)}` : out.error,
        ...EPHEMERAL,
    });
}

async function review(interaction, guild) {
    const rows = await nsfw.listReviews(guild.id, { kind: 'all', status: 'open', limit: 25 });
    const lines = rows.map(r => `<@${r.user_id}> · ${r.kind === 'nsfw_avatar' ? 'avatar' : 'image'} · ${r.status === 'actioned' ? `**${r.action_taken}** (overturnable)` : r.status}`
        + ` · ${pct(r.score ?? 0)}${r.judge_score != null ? ` / ${pct(r.judge_score)}` : ''} <t:${ts(r.found_at)}:R>`);
    return interaction.reply({
        embeds: [new EmbedBuilder().setTitle(`NSFW review queue${rows.length ? ` (${rows.length}${rows.length === 25 ? '+' : ''})` : ''}`)
            .setDescription((lines.join('\n') || 'Nothing waiting.') + `\n\nSee the avatars (blurred until clicked) and decide in bulk: ${dash(guild.id)}\nOr one at a time: \`/avatarfilter nsfw decide\``)],
        ...QUIET, ...EPHEMERAL,
    });
}

async function decide(interaction, guild, member) {
    const user = interaction.options.getUser('user');
    const decision = interaction.options.getString('decision');
    const surface = interaction.options.getString('which') || 'avatar';
    if ((decision === 'ban' || decision === 'kick') && !actorMay(member, guild, decision)) {
        return interaction.reply({ content: `You need the ${decision === 'ban' ? 'Ban Members' : 'Kick Members'} permission for that.`, ...EPHEMERAL });
    }
    if (decision === 'overturn' && !actorMay(member, guild, 'ban')) {
        return interaction.reply({ content: 'Overturning can unban, so it needs the Ban Members permission.', ...EPHEMERAL });
    }
    await interaction.deferReply(EPHEMERAL);
    const out = await nsfw.decideReviews(guild, surface, [user.id], decision, interaction.user.id);
    const word = { ban: 'banned', kick: 'kicked', safe: 'marked not NSFW (picture remembered as safe)', skip: 'skipped', overturn: 'overturned (picture remembered as safe)' }[decision];
    const failed = out.failed.map(f => f.problem).join('; ');
    return interaction.editReply({
        content: out.done ? `Done: <@${user.id}> ${word}.${out.notes.length ? ` ${out.notes.join(' ')}` : ''}`
            : (failed || `They are not in the NSFW ${surface === 'image' ? 'chat-image' : 'avatar'} queue (or were skipped: left, changed avatar, staff or exempt).`),
        ...QUIET,
    });
}

const HANDLERS = { settings, status, test, scan, review, decide };

/** Called by avatarfilter.js for the `nsfw` group (access already checked). */
export async function execute(interaction, guild, member) {
    return HANDLERS[interaction.options.getSubcommand()](interaction, guild, member);
}

export default { nsfwGroup, execute };
