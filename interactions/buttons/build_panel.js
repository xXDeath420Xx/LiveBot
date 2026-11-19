/*
 * Build panels for #server-development.
 *
 * Her ask, in her words: add a channel by naming it and saying where it goes; add
 * a role; move things around; "show me what this will do first, every time";
 * find channels nobody uses; see everyone with power; rename everything at once
 * if she changes the font.
 *
 * Two rules run through all of it:
 *
 *   1. Nothing happens without a preview. Every action renders exactly what it
 *      will do and waits for a confirm. She asked for that explicitly, and it is
 *      also the only way a panel like this is safe to hand to someone who is not
 *      going to read an audit log afterwards.
 *   2. A new channel inherits its category's lettering automatically. The server
 *      is styled in Mathematical Italic inside ༺ornament…ornament༻; typing
 *      "Movie Night" and getting a plain lowercase channel would break the tree
 *      she spent weeks on.
 *
 * Anything the panels can't do DMs the operator rather than failing quietly.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import logger from '../../utils/logger.js';
import { applyStyle, toPlain } from '../../utils/channel-name-style.js';

const OPERATOR = '365905620060340224';     // gets told when something isn't supported yet
const bare = (n) => toPlain(n).replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9 ]+$/, '').trim();

/** The ornament a category wraps its children in, e.g. "🌸" from ༺🌸Community🌸༻. */
function ornamentOf(category) {
    return category?.name?.match(/^༺([^\u{1D400}-\u{1D7FF}]*)/u)?.[1] || '';
}
/** Dress a plain name in the surrounding category's style. */
export function styledChannelName(plain, category) {
    const orn = ornamentOf(category);
    const body = applyStyle(plain.trim().replace(/\s+/g, '-'), { alphabet: 'italic' });
    return `༺${orn}${body}${orn}༻`;
}

const pending = new Map();                  // token -> {kind, payload, expires}
const TTL = 10 * 60 * 1000;
function stash(kind, payload) {
    const token = Math.random().toString(36).slice(2, 10);
    pending.set(token, { kind, payload, expires: Date.now() + TTL });
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    return token;
}

function mayBuild(member) {
    return member.permissions.has(PermissionFlagsBits.ManageGuild)
        || member.permissions.has(PermissionFlagsBits.Administrator);
}

/** The panel itself. */
export function buildPanelMessage() {
    return {
        embeds: [{
            title: 'Server build panel',
            description:
                'Everything here shows you what it will do before it does it.\n\n' +
                '**Add a channel** — name it, pick the section. It gets the same lettering as everything around it.\n' +
                '**Add a role** — name, colour, and where it sits.\n' +
                '**Rename a channel** — keeps the section lettering.\n' +
                '**Quiet channels** — which rooms nobody has used.\n' +
                '**Who can do what** — everyone holding real power, and what they can reach.\n' +
                '**Restyle everything** — if you change the font, this converts every channel at once.\n' +
                '**Stream schedule look** — the shape and artwork of the posted Twitch schedule.\n' +
                '**Update schedule now** — pull from Twitch immediately instead of waiting for the next check.',
            color: 0xC7A5E8,
            footer: { text: 'Anything this cannot do yet gets sent to Dylan instead of failing.' },
        }],
        components: [
            { type: 1, components: [
                { type: 2, style: 1, custom_id: 'build_add_channel', label: 'Add a channel' },
                { type: 2, style: 1, custom_id: 'build_add_role', label: 'Add a role' },
                { type: 2, style: 2, custom_id: 'build_rename', label: 'Rename a channel' },
            ] },
            { type: 1, components: [
                { type: 2, style: 2, custom_id: 'build_quiet', label: 'Quiet channels' },
                { type: 2, style: 2, custom_id: 'build_power', label: 'Who can do what' },
                { type: 2, style: 2, custom_id: 'build_restyle', label: 'Restyle everything' },
            ] },
            { type: 1, components: [
                { type: 2, style: 1, custom_id: 'build_schedule_style', label: 'Stream schedule look' },
                { type: 2, style: 2, custom_id: 'build_schedule_now', label: 'Update schedule now' },
            ] },
            { type: 1, components: [
                { type: 2, style: 4, custom_id: 'build_request', label: 'Ask for something else' },
            ] },
        ],
    };
}

// ── add a channel ──────────────────────────────────────────────────────────
export async function handleAddChannel(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const cats = interaction.guild.channels.cache.filter((c) => c.type === 4)
        .sort((a, b) => a.position - b.position).first(25);
    return interaction.reply({
        ephemeral: true,
        content: 'Which section should it go in?',
        components: [{ type: 1, components: [{
            type: 3, custom_id: 'build_add_channel_cat', placeholder: 'Pick a section',
            options: cats.map((c) => ({ label: bare(c.name).slice(0, 100), value: c.id })),
        }] }],
    });
}

export async function handleAddChannelCategory(interaction) {
    const categoryId = interaction.values[0];
    return interaction.showModal({
        custom_id: `build_add_channel_modal:${categoryId}`,
        title: 'New channel',
        components: [
            { type: 1, components: [{ type: 4, custom_id: 'name', style: 1, required: true, max_length: 40,
                label: 'Channel name', placeholder: 'Movie Night' }] },
            { type: 1, components: [{ type: 4, custom_id: 'topic', style: 2, required: false, max_length: 400,
                label: 'What is it for? (shown at the top)', placeholder: 'What everyone is watching this week.' }] },
            { type: 1, components: [{ type: 4, custom_id: 'kind', style: 1, required: false, max_length: 6,
                label: 'text or voice', placeholder: 'text' }] },
        ],
    });
}

export async function handleAddChannelModal(interaction) {
    const categoryId = interaction.customId.split(':')[1];
    const category = interaction.guild.channels.cache.get(categoryId);
    const plain = interaction.fields.getTextInputValue('name').trim();
    const topic = (interaction.fields.getTextInputValue('topic') || '').trim();
    const voice = /voice/i.test(interaction.fields.getTextInputValue('kind') || '');
    const styled = styledChannelName(plain, category);

    const clash = interaction.guild.channels.cache.find((c) => bare(c.name).toLowerCase() === plain.toLowerCase().replace(/\s+/g, '-'));
    const token = stash('channel', { categoryId, styled, topic, voice });
    const embed = new EmbedBuilder()
        .setTitle('This is what will happen')
        .setColor(0xE8A33D)
        .addFields(
            { name: 'New channel', value: `\`${styled}\`` },
            { name: 'Section', value: bare(category.name), inline: true },
            { name: 'Type', value: voice ? 'voice' : 'text', inline: true },
            { name: 'Description', value: topic || '_none_' },
        );
    if (clash) embed.addFields({ name: 'Careful', value: `**${bare(clash.name)}** already exists and does something similar. Two rooms for one job is how a server gets cluttered.` });
    return interaction.reply({
        ephemeral: true, embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`build_do:${token}`).setLabel('Create it').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('build_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
    });
}

// ── add a role ─────────────────────────────────────────────────────────────
export async function handleAddRole(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    return interaction.showModal({
        custom_id: 'build_add_role_modal',
        title: 'New role',
        components: [
            { type: 1, components: [{ type: 4, custom_id: 'name', style: 1, required: true, max_length: 40,
                label: 'Role name', placeholder: 'Movie Club' }] },
            { type: 1, components: [{ type: 4, custom_id: 'colour', style: 1, required: false, max_length: 20,
                label: 'Colour (hex or name, blank for none)', placeholder: '#C7A5E8' }] },
            { type: 1, components: [{ type: 4, custom_id: 'band', style: 1, required: false, max_length: 20,
                label: 'tag, display, or staff', placeholder: 'tag' }] },
        ],
    });
}

export async function handleAddRoleModal(interaction) {
    const name = interaction.fields.getTextInputValue('name').trim();
    const colourRaw = (interaction.fields.getTextInputValue('colour') || '').trim();
    const band = (interaction.fields.getTextInputValue('band') || 'tag').trim().toLowerCase();
    const { parseColour } = await import('./colour_picker.js');
    const hex = colourRaw ? parseColour(colourRaw) : null;
    if (colourRaw && !hex) {
        return interaction.reply({ content: `I couldn't read **${colourRaw}** as a colour. Try \`#C7A5E8\` or a name like \`lavender\`.`, ephemeral: true });
    }
    /* Where it sits decides what it does. A tag role above the colour block
       silently repaints every name that holds it — the exact fault we just spent
       the build fixing — so the band is chosen here rather than guessed. */
    const anchorName = band === 'staff' ? 'Mod' : band === 'display' ? 'Hot Pink' : 'Member';
    const anchor = interaction.guild.roles.cache.find((r) => r.name === anchorName);
    const token = stash('role', { name, hex, band, anchorId: anchor?.id });
    return interaction.reply({
        ephemeral: true,
        embeds: [new EmbedBuilder().setTitle('This is what will happen').setColor(0xE8A33D).addFields(
            { name: 'New role', value: name, inline: true },
            { name: 'Colour', value: hex || 'none', inline: true },
            { name: 'Sits', value: band === 'staff' ? 'with the staff ranks — it will outrank the colour picker'
                : band === 'display' ? 'in the display band, above Member' : 'below Member, where it cannot affect anyone\'s name colour' },
        )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`build_do:${token}`).setLabel('Create it').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('build_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
    });
}

// ── read-only reports ──────────────────────────────────────────────────────
export async function handleQuiet(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const rows = [];
    for (const c of interaction.guild.channels.cache.filter((x) => x.type === 0).values()) {
        const last = await c.messages.fetch({ limit: 1 }).then((m) => m.first()).catch(() => null);
        const days = last ? Math.floor((Date.now() - last.createdTimestamp) / 86400000) : null;
        rows.push({ name: bare(c.name), days });
    }
    rows.sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
    const quiet = rows.filter((r) => r.days === null || r.days >= 14);
    return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle('Rooms nobody is using')
        .setColor(0x9BA3AF)
        .setDescription(quiet.length
            ? quiet.map((r) => `**${r.name}** — ${r.days === null ? 'never used' : `quiet ${r.days} days`}`).join('\n').slice(0, 4000)
            : 'Every channel has been used in the last fortnight.')
        .setFooter({ text: 'Nothing has been changed. This is just a look.' })] });
}

export async function handlePower(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    await guild.members.fetch().catch(() => {});
    const BIG = { Administrator: 'everything', ManageGuild: 'server settings', ManageRoles: 'roles',
        ManageChannels: 'channels', BanMembers: 'ban', KickMembers: 'kick', ModerateMembers: 'timeout',
        ManageMessages: 'delete messages' };
    const lines = [];
    for (const role of [...guild.roles.cache.values()].sort((a, b) => b.position - a.position)) {
        const can = Object.entries(BIG).filter(([p]) => role.permissions.has(PermissionFlagsBits[p])).map(([, l]) => l);
        if (!can.length) continue;
        const who = role.members.map((m) => m.user.username);
        lines.push(`**${role.name}** — ${can.join(', ')}\n${who.length ? who.join(', ') : '_nobody_'}`);
    }
    return interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle('Everyone with real power')
        .setColor(0xD64545)
        .setDescription(lines.join('\n\n').slice(0, 4000) || 'Nobody holds any of the big permissions.')
        .setFooter({ text: 'Administrator ignores every channel setting. Give it sparingly.' })] });
}

// ── restyle / rename ───────────────────────────────────────────────────────
export async function handleRename(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    return interaction.showModal({
        custom_id: 'build_rename_modal',
        title: 'Rename a channel',
        components: [
            { type: 1, components: [{ type: 4, custom_id: 'from', style: 1, required: true, max_length: 40,
                label: 'Which channel (plain name)', placeholder: 'Yummy-Eats' }] },
            { type: 1, components: [{ type: 4, custom_id: 'to', style: 1, required: true, max_length: 40,
                label: 'New name', placeholder: 'Food-Corner' }] },
        ],
    });
}

export async function handleRenameModal(interaction) {
    const from = interaction.fields.getTextInputValue('from').trim().toLowerCase();
    const to = interaction.fields.getTextInputValue('to').trim();
    const ch = interaction.guild.channels.cache.find((c) => bare(c.name).toLowerCase() === from.replace(/\s+/g, '-'));
    if (!ch) return interaction.reply({ content: `No channel called **${from}**. Use the plain name, like \`Yummy-Eats\`.`, ephemeral: true });
    const cat = ch.parent;
    const styled = styledChannelName(to, cat);
    const token = stash('rename', { channelId: ch.id, styled });
    return interaction.reply({ ephemeral: true,
        embeds: [new EmbedBuilder().setTitle('This is what will happen').setColor(0xE8A33D)
            .addFields({ name: 'From', value: `\`${ch.name}\`` }, { name: 'To', value: `\`${styled}\`` })],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`build_do:${token}`).setLabel('Rename it').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('build_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
}

export async function handleRestyle(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    return interaction.showModal({
        custom_id: 'build_restyle_modal',
        title: 'Restyle every channel',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'alphabet', style: 1, required: true, max_length: 30,
            label: 'Which lettering', placeholder: 'italic, bold, bold-italic, script, fraktur, monospace' }] }],
    });
}

export async function handleRestyleModal(interaction) {
    const alphabet = interaction.fields.getTextInputValue('alphabet').trim().toLowerCase().replace(/\s+/g, '-');
    const sample = ['Yummy-Eats', 'Twitch-Live', 'Utopia-Chat'];
    let preview;
    try { preview = sample.map((s) => applyStyle(s, { alphabet })); }
    catch { return interaction.reply({ content: `I don't know a lettering called **${alphabet}**.`, ephemeral: true }); }
    if (preview[0] === sample[0]) return interaction.reply({ content: `I don't know a lettering called **${alphabet}**.`, ephemeral: true });
    const token = stash('restyle', { alphabet });
    const n = interaction.guild.channels.cache.size;
    return interaction.reply({ ephemeral: true,
        embeds: [new EmbedBuilder().setTitle('This is what will happen').setColor(0xE8A33D)
            .setDescription(`All **${n}** channels and categories get converted to **${alphabet}**.\n\nHere is how three of them would read:\n${preview.map((p) => `\`${p}\``).join('\n')}`)
            .setFooter({ text: 'Ornaments and emoji stay exactly as they are.' })],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`build_do:${token}`).setLabel(`Convert all ${n}`).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('build_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
}

// ── the one confirm path everything funnels through ────────────────────────
export async function handleBuildConfirm(interaction) {
    const token = interaction.customId.split(':')[1];
    const job = pending.get(token);
    if (!job) return interaction.update({ content: 'That preview expired — start again.', embeds: [], components: [] });
    pending.delete(token);
    await interaction.deferUpdate();
    const g = interaction.guild;
    try {
        if (job.kind === 'channel') {
            const c = await g.channels.create({ name: job.payload.styled, type: job.payload.voice ? 2 : 0,
                parent: job.payload.categoryId, topic: job.payload.voice ? undefined : (job.payload.topic || undefined),
                reason: `Build panel: ${interaction.user.tag}` });
            return interaction.editReply({ content: `Created ${c}.`, embeds: [], components: [] });
        }
        if (job.kind === 'role') {
            const role = await g.roles.create({ name: job.payload.name,
                color: job.payload.hex ? parseInt(job.payload.hex.slice(1), 16) : 0,
                permissions: [], reason: `Build panel: ${interaction.user.tag}` });
            const anchor = job.payload.anchorId ? g.roles.cache.get(job.payload.anchorId) : null;
            if (anchor) await role.setPosition(Math.max(1, anchor.position + (job.payload.band === 'tag' ? -1 : 1))).catch(() => {});
            return interaction.editReply({ content: `Created **${role.name}**.`, embeds: [], components: [] });
        }
        if (job.kind === 'rename') {
            const c = g.channels.cache.get(job.payload.channelId);
            await c.setName(job.payload.styled, `Build panel: ${interaction.user.tag}`);
            return interaction.editReply({ content: `Renamed to \`${job.payload.styled}\`.`, embeds: [], components: [] });
        }
        if (job.kind === 'restyle') {
            let done = 0, failed = 0;
            for (const c of g.channels.cache.values()) {
                const plain = bare(c.name);
                const orn = c.type === 4 ? ornamentOf(c) : ornamentOf(c.parent);
                const next = `༺${orn}${applyStyle(plain, { alphabet: job.payload.alphabet })}${orn}༻`;
                if (next === c.name) { done++; continue; }
                try { await c.setName(next, `Restyle by ${interaction.user.tag}`); done++; }
                catch { failed++; }
                await new Promise((r) => setTimeout(r, 700));
            }
            return interaction.editReply({ content: `Converted ${done} channel(s)${failed ? `, ${failed} failed` : ''}.`, embeds: [], components: [] });
        }
    } catch (err) {
        logger.error(`[BuildPanel] ${job.kind} failed: ${err.message}`, { guildId: g.id });
        return interaction.editReply({ content: `That didn't work: ${err.message}`, embeds: [], components: [] });
    }
}

export async function handleBuildCancel(interaction) {
    return interaction.update({ content: 'Cancelled — nothing changed.', embeds: [], components: [] });
}

// ── anything we don't support yet ──────────────────────────────────────────
export async function handleBuildRequest(interaction) {
    if (!mayBuild(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    return interaction.showModal({
        custom_id: 'build_request_modal',
        title: 'Ask for something else',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'what', style: 2, required: true, max_length: 900,
            label: 'What would you like the server to do?', placeholder: 'Describe it however it comes out.' }] }],
    });
}

export async function handleBuildRequestModal(interaction) {
    const what = interaction.fields.getTextInputValue('what').trim();
    // Straight to a human rather than a shrug. This is the promise the panel makes.
    const dylan = await interaction.client.users.fetch(OPERATOR).catch(() => null);
    await dylan?.send({ embeds: [new EmbedBuilder()
        .setTitle('Build request from ' + interaction.guild.name)
        .setColor(0xC7A5E8)
        .setDescription(what)
        .addFields({ name: 'Asked by', value: `${interaction.user.tag} (${interaction.user.id})` })
        .setTimestamp()] }).catch(() => {});
    return interaction.reply({ content: 'Sent to Dylan. He will come back to you on it.', ephemeral: true });
}
