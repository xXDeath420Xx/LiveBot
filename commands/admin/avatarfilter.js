/*
 * `/avatarfilter` — avatar protection: protected images (a member's avatar, every member of a role,
 * the server icon, an attached image), the exact scam-avatar list, thresholds and actions, the
 * review-first cleanse and its queue, and Auto-Pilot's avatar part (core/avatar-protection.js).
 *
 * The dashboard's Avatar Protection page does all of this with pictures (the review queue shows each
 * flagged avatar beside the image it matched, with bulk actions and the threshold slider); this
 * command is the in-Discord way to the same functions. A force cleanse asks for a button press first
 * (interactions/buttons/avatar_filter.js). `export` sends the protected images and scam avatars as the same
 * versioned JSON file (fingerprints only, no pictures) the dashboard's Export button gives; `import` previews
 * a file (added / already there / refused / over the limit) with Import / Cancel buttons, like
 * `/moderation namefilter import`.
 *
 * `/avatarfilter nsfw …` (NSFW avatars and the NSFW review queue, core/nsfw-protection.js) is a subcommand
 * group whose handlers live in avatarfilter-nsfw-handler.js.
 */
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { liveConfigAccess } from '../../core/protection-exempt.js';
import ap from '../../core/avatar-protection.js';
import nf from '../../core/name-filters.js';
import { actorMay } from './namefilter.js';
import { scoreText, MIN_THRESHOLD } from '../../core/avatar-match-logic.js';
import { nsfwGroup, execute as executeNsfw } from './avatarfilter-nsfw-handler.js';

const EPHEMERAL = { flags: 64 };
const ACTION_CHOICES = [
    { name: 'Log only + review queue (default)', value: 'log' },
    { name: 'Flag with a role', value: 'flag' },
    { name: 'Timeout', value: 'timeout' },
    { name: 'Kick', value: 'kick' },
    { name: 'Ban', value: 'ban' },
];
const ACTION_WORD = { log: 'log only + review', flag: 'flag with a role', timeout: 'timeout', kick: 'kick', ban: 'ban' };
const ts = (d) => Math.floor(new Date(d).getTime() / 1000);
const dash = (guildId) => `${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '')}/manage/${guildId}?page=avatar-protection`;
const actionOpt = (o, name = 'action', desc = 'What to do at the act threshold') => o.setName(name).setDescription(desc).addChoices(...ACTION_CHOICES);
const thresholdOpt = (o, name, desc) => o.setName(name).setDescription(desc).setMinValue(MIN_THRESHOLD).setMaxValue(1);

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('avatarfilter')
        .setDescription('Catch impersonators using staff avatars, and scam avatars: protect, test, cleanse, review')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('add').setDescription('Protect an avatar, a role\'s avatars, the server icon or an image')
            .addUserOption(o => o.setName('user').setDescription('Protect this member\'s avatar'))
            .addRoleOption(o => o.setName('role').setDescription('Protect every member of this role'))
            .addBooleanOption(o => o.setName('server_icon').setDescription('Protect the server icon'))
            .addAttachmentOption(o => o.setName('image').setDescription('Protect this image'))
            .addStringOption(o => o.setName('which').setDescription('Which avatar of a member (default: both)').addChoices(
                { name: 'Both', value: 'both' }, { name: 'Avatar', value: 'global' }, { name: 'Server avatar', value: 'server' }))
            .addBooleanOption(o => o.setName('as_scam').setDescription('Image only: add it as a known scam avatar (exact copies)'))
            .addStringOption(o => o.setName('label').setDescription('Label for staff').setMaxLength(120)))
        .addSubcommand(s => s.setName('remove').setDescription('Stop protecting an image (or remove a scam avatar)')
            .addIntegerOption(o => o.setName('id').setDescription('Image #').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('list').setDescription('List protected images and scam avatars'))
        .addSubcommand(s => s.setName('test').setDescription('Score a member\'s avatar or an image against the protected images')
            .addUserOption(o => o.setName('user').setDescription('A member to check'))
            .addAttachmentOption(o => o.setName('image').setDescription('An image to check')))
        .addSubcommand(s => s.setName('cleanse').setDescription('Check every member\'s avatar')
            .addStringOption(o => o.setName('mode').setDescription('Review first (default) or act now').addChoices(
                { name: 'Review first: queue matches on the dashboard', value: 'review' },
                { name: 'Force: act now on near-exact and scam matches', value: 'force' })))
        .addSubcommand(s => s.setName('review').setDescription('Members waiting in the avatar review queue'))
        .addSubcommand(s => s.setName('decide').setDescription('Decide a queued member')
            .addUserOption(o => o.setName('user').setDescription('Member in the queue').setRequired(true))
            .addStringOption(o => o.setName('decision').setDescription('What to do').setRequired(true).addChoices(
                { name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' },
                { name: 'Not a match', value: 'safe' }, { name: 'Skip', value: 'skip' })))
        .addSubcommand(s => s.setName('settings').setDescription('Switch avatar checks on and set thresholds and actions')
            .addBooleanOption(o => o.setName('enabled').setDescription('Check avatars on join and on every change'))
            .addStringOption(o => actionOpt(o))
            .addNumberOption(o => thresholdOpt(o, 'act_at', 'Act at or above this score (0.70-1.00, default 0.90)'))
            .addNumberOption(o => thresholdOpt(o, 'review_at', 'Queue for review at or above (0.70-1.00, default 0.75)'))
            .addBooleanOption(o => o.setName('scam_avatars').setDescription('Check the exact scam-avatar list (default on)'))
            .addStringOption(o => actionOpt(o, 'scam_action', 'What to do with an exact scam avatar'))
            .addRoleOption(o => o.setName('flag_role').setDescription('Role for the flag action'))
            .addIntegerOption(o => o.setName('timeout_minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320))
            .addBooleanOption(o => o.setName('dm').setDescription('Tell removed / timed-out members why')))
        .addSubcommand(s => s.setName('autopilot').setDescription('Protect staff avatars automatically (Auto-Pilot)')
            .addBooleanOption(o => o.setName('avatars').setDescription('Auto-Pilot also protects avatars'))
            .addBooleanOption(o => o.setName('enabled').setDescription('Auto-Pilot on or off (shared with /moderation namefilter)'))
            .addBooleanOption(o => o.setName('sync').setDescription('Refresh the protected avatars now')))
        .addSubcommand(s => s.setName('status').setDescription('What avatar protection is doing in this server'))
        .addSubcommand(s => s.setName('hits').setDescription('Recent avatar-protection hits'))
        .addSubcommand(s => s.setName('export').setDescription('Download the protected images and scam avatars as a JSON file'))
        .addSubcommand(s => s.setName('import').setDescription('Import protected images from an export file (previewed first)')
            .addAttachmentOption(o => o.setName('file').setDescription('An /avatarfilter export JSON file').setRequired(true)))
        .addSubcommandGroup(g => nsfwGroup(g)),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guild = interaction.guild;
        try {
            const access = await liveConfigAccess(guild, interaction.user.id);
            if (!access.ok) {
                return interaction.reply({ content: 'You need Manage Server, Administrator or a bot-manager role to use this.', ...EPHEMERAL });
            }
            if (interaction.options.getSubcommandGroup(false) === 'nsfw') return await executeNsfw(interaction, guild, access.member);
            return await HANDLERS[sub](interaction, guild, access.member);
        } catch (error) {
            logger.error('[AvatarFilter Command] Error:', { error: error.message, sub, stack: error.stack });
            const reply = { content: `Error: ${error.message}`, ...EPHEMERAL };
            if (interaction.deferred || interaction.replied) return interaction.editReply(reply);
            return interaction.reply(reply);
        }
    },
};

const isImageAttachment = (a) => !!a && /^image\/(png|jpe?g|webp|gif)$/i.test(a.contentType || '');

const HANDLERS = {
    async add(interaction, guild) {
        const o = interaction.options;
        const user = o.getUser('user');
        const role = o.getRole('role');
        const icon = o.getBoolean('server_icon');
        const image = o.getAttachment('image');
        const label = o.getString('label');
        const picked = [user, role, icon, image].filter(Boolean).length;
        if (picked !== 1) return interaction.reply({ content: 'Give exactly one of `user`, `role`, `server_icon` or `image`.', ...EPHEMERAL });
        if (image && !isImageAttachment(image)) return interaction.reply({ content: 'Attach a PNG, JPEG, WebP or GIF image.', ...EPHEMERAL });
        await interaction.deferReply(EPHEMERAL);
        if (image && o.getBoolean('as_scam')) {
            const out = await ap.addScamAvatar(guild, { url: image.url, label }, interaction.user.id);
            return interaction.editReply({ content: out.ok ? (out.existing ? 'That scam avatar is already on the list.' : `Added as scam avatar #${out.id}. Exact copies are caught from now on.`) : out.error });
        }
        const scope = o.getString('which') || 'both';
        const spec = user ? { source: 'member', userId: user.id, scope } : role ? { source: 'role', roleId: role.id, scope }
            : icon ? { source: 'server_icon' } : { source: 'url', url: image.url, label };
        if (label && !image) spec.label = label;
        const out = await ap.addProtected(guild, spec, interaction.user.id);
        if (!out.ok) return interaction.editReply({ content: out.error });
        const lines = [
            `Protected ${out.added.length} image(s)${out.existing ? ` (${out.existing} already were)` : ''}: ${out.added.slice(0, 8).map(a => `#${a.id} ${a.label}`).join(', ')}${out.added.length > 8 ? '…' : ''}`,
            out.skipped.length ? `Skipped ${out.skipped.length}: ${out.skipped.slice(0, 3).map(s => `${s.label} (${s.why})`).join('; ')}` : null,
            'Everyone already here is being re-checked in the background; matches go to the review queue.',
            `Review: ${dash(guild.id)}`,
        ].filter(Boolean);
        return interaction.editReply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
    },

    async remove(interaction, guild) {
        const id = interaction.options.getInteger('id');
        const ok = await ap.removeImage(guild, id, interaction.user.id);
        return interaction.reply({ content: ok ? `Image #${id} removed.` : `There is no protected image or scam avatar #${id} in this server.`, ...EPHEMERAL });
    },

    async list(interaction, guild) {
        const [images, scam] = await Promise.all([ap.listProtected(guild.id), ap.listScam(guild.id)]);
        const active = images.filter(i => !i.removed);
        const lines = active.slice(0, 30).map(i => `\`#${i.id}\` ${String(i.label ?? '').slice(0, 60)} · ${i.sourceLabel}${i.protectedUserId ? ` <@${i.protectedUserId}>` : ''} · ${i.hits} hit(s)`);
        const embed = new EmbedBuilder().setTitle(`Protected images (${active.length})`)
            .setDescription((lines.join('\n') || 'Nothing protected yet. `/avatarfilter add` or switch on `/avatarfilter autopilot`.').slice(0, 3800)
                + (active.length > 30 ? `\n…${active.length - 30} more on the dashboard` : ''))
            .addFields({ name: `Scam avatars (${scam.length})`, value: scam.slice(0, 10).map(s => `${s.id ? `\`#${s.id}\` ` : ''}${s.label}${s.builtin ? ' (built in)' : ''}`).join('\n').slice(0, 1024) })
            .setFooter({ text: 'See the pictures on the dashboard: Avatar Protection page' });
        return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] }, ...EPHEMERAL });
    },

    async test(interaction, guild) {
        const user = interaction.options.getUser('user');
        const image = interaction.options.getAttachment('image');
        if (!user && !image) return interaction.reply({ content: 'Give a `user` or an `image` to test.', ...EPHEMERAL });
        if (image && !isImageAttachment(image)) return interaction.reply({ content: 'Attach a PNG, JPEG, WebP or GIF image.', ...EPHEMERAL });
        await interaction.deferReply(EPHEMERAL);
        let r;
        if (user) {
            const member = await guild.members.fetch(user.id).catch(() => null);
            if (!member) return interaction.editReply({ content: 'They are not in this server.' });
            r = await ap.testAvatar(guild, { member });
        } else {
            const res = await fetch(image.url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
            if (!res?.ok) return interaction.editReply({ content: 'Could not download that image.' });
            r = await ap.testAvatar(guild, { buffer: Buffer.from(await res.arrayBuffer()) });
        }
        const embed = new EmbedBuilder().setTitle('Avatar test')
            .setDescription(`Act at ${scoreText(r.settings.autoThreshold)}, review at ${scoreText(r.settings.reviewThreshold)} · ${r.protectedCount} protected image(s)`);
        for (const a of r.avatars.slice(0, 2)) {
            const name = a.scope === 'server' ? 'Server avatar' : a.scope === 'upload' ? 'Image' : 'Avatar';
            const value = a.error ? a.error : [
                a.scam ? `**Exact scam avatar:** ${a.scam.label} (check ${a.scam.enabled ? `on, ${ACTION_WORD[a.scam.action]}` : 'off'})` : null,
                a.usable ? null : `Too plain to score (${a.flat ? `${a.flat} image` : `${a.bits}/256 bits`}).`,
                ...a.scores.slice(0, 5).map(s => `${scoreText(s.score)} · #${s.id} ${String(s.label ?? '').slice(0, 50)}${s.decision ? ` → **${s.decision === 'auto' ? ACTION_WORD[r.settings.action] : 'review'}**` : ''}`),
                a.usable && !a.scores.length ? 'No protected images to compare with.' : null,
            ].filter(Boolean).join('\n') || 'No match.';
            embed.addFields({ name, value: value.slice(0, 1024) });
        }
        if (!r.avatars.length) embed.addFields({ name: 'Avatar', value: 'No avatar to test.' });
        if (r.notes.length) embed.addFields({ name: 'Notes', value: r.notes.join('\n').slice(0, 1024) });
        if (r.avatars[0]?.url) embed.setThumbnail(r.avatars[0].url);
        if (!r.settings.enabled) embed.setFooter({ text: 'Avatar checks are switched off: /avatarfilter settings enabled:true' });
        return interaction.editReply({ embeds: [embed] });
    },

    async cleanse(interaction, guild, member) {
        const mode = interaction.options.getString('mode') || 'review';
        if (mode === 'force') {
            if (!actorMay(member, guild, 'ban')) {
                return interaction.reply({ content: 'A force cleanse can ban, so it needs the Ban Members permission. Use review mode instead.', ...EPHEMERAL });
            }
            const token = nf.rememberPending({ kind: 'avatar-cleanse', guildId: guild.id, actorId: interaction.user.id });
            return interaction.reply({
                content: '**Force cleanse:** every member whose avatar scores at or above the act threshold, and every exact scam avatar, is acted on now '
                    + 'with your actions (review-band and log-only matches still go to the queue). Staff, protected and exempt members are left alone. Continue?',
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`avatarfilter_force:${token}`).setLabel('Run force cleanse').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`avatarfilter_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
                ...EPHEMERAL,
            });
        }
        const out = ap.startCleanse(guild, { mode: 'review' }, interaction.user.id);
        return interaction.reply({
            content: out.ok ? `Scan started. Matches go to the review queue: ${dash(guild.id)}\n\`/avatarfilter review\` shows the queue here too.` : out.error,
            ...EPHEMERAL,
        });
    },

    async review(interaction, guild) {
        const rows = await ap.listReviews(guild.id, { status: 'pending', limit: 20 });
        const status = ap.cleanseStatus(guild.id);
        const lines = rows.map(r => `<@${r.user_id}> · ${r.detail === 'scam avatar' ? 'scam avatar' : `${scoreText(r.score ?? 0)} like #${r.image_id ?? '?'}`} · ${String(r.filter_label ?? '').slice(0, 60)}`);
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle(`Avatar review queue${rows.length ? ` (${rows.length}${rows.length === 20 ? '+' : ''})` : ''}`)
                .setDescription((lines.join('\n') || 'Nothing waiting.') + `\n\nSee the avatars side by side and decide in bulk: ${dash(guild.id)}\nOr one at a time: \`/avatarfilter decide\``)
                .setFooter({ text: status.running ? `A scan is running: ${status.checked ?? 0}/${status.total ?? '?'} checked` : 'Run /avatarfilter cleanse to scan again' })],
            allowedMentions: { parse: [] }, ...EPHEMERAL,
        });
    },

    async decide(interaction, guild, member) {
        const user = interaction.options.getUser('user');
        const decision = interaction.options.getString('decision');
        if ((decision === 'ban' || decision === 'kick') && !actorMay(member, guild, decision)) {
            return interaction.reply({ content: `You need the ${decision === 'ban' ? 'Ban Members' : 'Kick Members'} permission for that.`, ...EPHEMERAL });
        }
        await interaction.deferReply(EPHEMERAL);
        const out = await ap.decideReviews(guild, [user.id], decision, interaction.user.id);
        const failed = out.failed.map(f => f.problem).join('; ');
        const word = { ban: 'banned', kick: 'kicked', safe: 'marked not a match', skip: 'skipped' }[decision];
        return interaction.editReply({ content: out.done ? `Done: <@${user.id}> ${word}.` : (failed || 'They are not in the avatar review queue (or were skipped: left, changed avatar, staff or exempt).'), allowedMentions: { parse: [] } });
    },

    async settings(interaction, guild) {
        const o = interaction.options;
        const patch = {};
        if (o.getBoolean('enabled') !== null) patch.enabled = o.getBoolean('enabled');
        if (o.getString('action')) patch.action = o.getString('action');
        if (o.getNumber('act_at') !== null) patch.autoThreshold = o.getNumber('act_at');
        if (o.getNumber('review_at') !== null) patch.reviewThreshold = o.getNumber('review_at');
        if (o.getBoolean('scam_avatars') !== null || o.getString('scam_action')) {
            patch.scam = {};
            if (o.getBoolean('scam_avatars') !== null) patch.scam.enabled = o.getBoolean('scam_avatars');
            if (o.getString('scam_action')) patch.scam.action = o.getString('scam_action');
        }
        if (o.getRole('flag_role')) patch.flagRoleId = o.getRole('flag_role').id;
        if (o.getInteger('timeout_minutes') !== null) patch.timeoutMinutes = o.getInteger('timeout_minutes');
        if (o.getBoolean('dm') !== null) patch.dm = o.getBoolean('dm');
        const s = await ap.saveSettings(guild, patch, interaction.user.id);
        return interaction.reply({ content: `${Object.keys(patch).length ? 'Saved. ' : ''}${describe(s)}`, ...EPHEMERAL });
    },

    async autopilot(interaction, guild) {
        const o = interaction.options;
        const a = {};
        if (o.getBoolean('avatars') !== null) a.avatars = o.getBoolean('avatars');
        if (o.getBoolean('enabled') !== null) a.enabled = o.getBoolean('enabled');
        const s = Object.keys(a).length ? await ap.saveSettings(guild, { autopilot: a }, interaction.user.id) : await ap.getSettings(guild.id);
        let synced = '';
        if (o.getBoolean('sync')) {
            await interaction.deferReply(EPHEMERAL);
            const r = await ap.syncAutoPilot(guild, { fetch: true });
            synced = `\nSynced: ${r.protected} covered member(s), ${r.created} image(s) added, ${r.retired} retired${r.skipped ? `, ${r.skipped} skipped` : ''}.`;
        }
        const text = `Auto-Pilot is **${s.autopilot.enabled ? 'on' : 'off'}** and ${s.autopilot.avatars ? 'protects' : 'does **not** protect'} avatars`
            + `${s.enabled ? '' : ' (avatar checks are off, so nothing is protected yet)'}. Covers: `
            + ([s.autopilot.managers && 'bot managers and allowlisted members', ...s.autopilot.roles.map(r => `<@&${r}>`)].filter(Boolean).join(', ') || 'nobody')
            + '. Who it covers is set with `/moderation namefilter autopilot` or on either dashboard page. Default avatars are skipped; deleting an Auto-Pilot image is remembered.'
            + synced;
        return interaction.deferred ? interaction.editReply({ content: text, allowedMentions: { parse: [] } })
            : interaction.reply({ content: text, allowedMentions: { parse: [] }, ...EPHEMERAL });
    },

    async status(interaction, guild) {
        const o = await ap.overview(guild);
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('Avatar protection').setDescription(describe(o.settings))
                .addFields(
                    { name: 'Protected images', value: `${o.protected.active} / ${o.protected.limit} (${o.protected.autopilot} by Auto-Pilot)`, inline: true },
                    { name: 'Scam avatars', value: String(o.scamAvatars), inline: true },
                    { name: 'Hits (30 days)', value: `${o.hits30d}${o.lastHitAt ? `, last <t:${ts(o.lastHitAt)}:R>` : ''}`, inline: true },
                    { name: 'Review queue', value: String(o.reviews.pending ?? 0), inline: true },
                    { name: 'Not a match', value: String(o.reviews.safe ?? 0), inline: true })
                .setFooter({ text: 'Dashboard: Avatar Protection page' })],
            ...EPHEMERAL,
        });
    },

    async export(interaction, guild) {
        await interaction.deferReply(EPHEMERAL);
        const data = await ap.exportProtected(guild);
        const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), { name: `avatar-protection-${guild.id}.json` });
        const scam = data.images.filter(i => i.kind === 'scam').length;
        return interaction.editReply({
            content: `${data.images.length - scam} protected image(s) and ${scam} scam avatar(s) exported (fingerprints only, no pictures). `
                + 'Import it with `/avatarfilter import` or on the dashboard.',
            files: [file],
        });
    },

    async import(interaction, guild) {
        const att = interaction.options.getAttachment('file');
        if (!att || att.size > 4 * 1024 * 1024) return interaction.reply({ content: 'Attach an export file of at most 4 MB.', ...EPHEMERAL });
        await interaction.deferReply(EPHEMERAL);
        let text;
        try {
            const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            text = await res.text();
        } catch (err) {
            return interaction.editReply({ content: `Could not read that file (${err.message}).` });
        }
        const plan = await ap.importProtected(guild, text, { apply: false });
        if (!plan.ok) return interaction.editReply({ content: plan.error });
        const line = (e) => `${e.kind === 'scam_avatar' || e.kind === 'scam' ? 'scam avatar' : 'protected'}: ${String(e.label ?? 'no label').replace(/`/g, "'").slice(0, 60)}`;
        const embed = new EmbedBuilder()
            .setColor(plan.add.length ? 0x3498DB : 0x95A5A6)
            .setTitle(`Import preview: ${plan.add.length} to add`)
            .setDescription([
                plan.add.length ? `**Will be added:**\n${plan.add.slice(0, 10).map(line).join('\n')}${plan.add.length > 10 ? `\n…and ${plan.add.length - 10} more` : ''}` : 'Nothing new to add.',
                plan.duplicates.length ? `**Already there (skipped):** ${plan.duplicates.length}` : null,
                plan.rejected.length ? `**Refused:**\n${plan.rejected.slice(0, 5).map(r => `${line(r)}: ${r.why}`).join('\n')}${plan.rejected.length > 5 ? `\n…and ${plan.rejected.length - 5} more` : ''}` : null,
                plan.overCap.length ? `**Over the limit (not added):** ${plan.overCap.length}` : null,
            ].filter(Boolean).join('\n\n').slice(0, 4000))
            .setFooter({ text: 'Nothing is saved until you press Import. Expires in 15 minutes.' });
        if (!plan.add.length) return interaction.editReply({ embeds: [embed] });
        const token = nf.rememberPending({ kind: 'avatar-import', guildId: guild.id, actorId: interaction.user.id, text });
        return interaction.editReply({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`avatarfilter_import:${token}`).setLabel(`Import ${plan.add.length}`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`avatarfilter_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
        });
    },

    async hits(interaction, guild) {
        const rows = await ap.recentHits(guild.id, 20);
        const word = { avatar_banned: 'banned', avatar_kicked: 'kicked', avatar_timeout: 'timed out', avatar_flagged: 'flagged',
            avatar_logged: 'logged', avatar_queued: 'sent to review', failed: 'could not act' };
        return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('Recent avatar-protection hits')
                .setDescription(rows.map(r => `<t:${ts(r.created_at)}:R> <@${r.user_id}> · ${word[r.action] ?? r.action} · ${String(r.detail ?? '').slice(0, 90)}`).join('\n').slice(0, 4000) || 'None yet.')],
            allowedMentions: { parse: [] }, ...EPHEMERAL,
        });
    },
};

function describe(s) {
    return [
        `Avatar checks are **${s.enabled ? 'on' : 'off'}** (join and every avatar change).`,
        `Act at **${scoreText(s.autoThreshold)}** (${ACTION_WORD[s.action]}), review at **${scoreText(s.reviewThreshold)}**.`,
        `Scam avatars: ${s.scam.enabled ? ACTION_WORD[s.scam.action] : 'off'} · flag role: ${s.flagRoleId ? `<@&${s.flagRoleId}>` : `"${ap.FLAG_ROLE_NAME}" (made when first needed)`} · timeout ${s.timeoutMinutes} min · DM ${s.dm ? 'on' : 'off'}.`,
        `Auto-Pilot: ${s.autopilot.enabled ? (s.autopilot.avatars ? 'on, protects avatars' : 'on, names only') : 'off'}.`,
    ].join('\n');
}
