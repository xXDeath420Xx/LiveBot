/*
 * Colour picker interactions: the five shade menus, "Other…", and "Remove my colour".
 *
 * Every reply is ephemeral. A colour change is nobody's business but the person
 * making it, and a public confirmation in a busy Reaction Roles channel is noise.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import {
    applyColour, ensureColourRole, readability, buildPicker,
} from '../../core/colour-picker-manager.js';

const HEX = /^#?([0-9a-fA-F]{6})$/;
const SHORT_HEX = /^#?([0-9a-fA-F]{3})$/;

/** Accepts "#F5A7C5", "f5a7c5", "#fac" — and the common names people actually type. */
const NAMED = {
    red: '#ED4245', crimson: '#E03131', pink: '#F8026D', hotpink: '#F8026D', rose: '#F4A6C0',
    orange: '#FF8A3D', peach: '#FFC4A0', coral: '#FA8E7C', gold: '#E8C46A', yellow: '#F1C40F',
    butter: '#F5E1A4', lime: '#8FD44A', green: '#3E9B52', mint: '#93DCB8', sage: '#A8C89A',
    teal: '#21B8C0', seafoam: '#7FD8C4', cyan: '#3BC9DB', sky: '#8CC6F2', blue: '#4A6BD6',
    periwinkle: '#9BA7F0', indigo: '#6B5BD6', purple: '#9B59D0', lavender: '#C7A5E8',
    violet: '#B47FE8', magenta: '#E05AC8', white: '#DADEE0', silver: '#B9C4D4', grey: '#8E9AA8',
    gray: '#8E9AA8', black: '#4A4D55',
};
export function parseColour(input) {
    const raw = String(input || '').trim();
    const key = raw.toLowerCase().replace(/[\s_-]/g, '');
    if (NAMED[key]) return NAMED[key];
    const m = raw.match(HEX);
    if (m) return `#${m[1].toUpperCase()}`;
    const s = raw.match(SHORT_HEX);
    if (s) return `#${s[1].split('').map((c) => c + c).join('').toUpperCase()}`;
    return null;
}

/** One of the five shade menus. */
export async function handleColourPick(interaction) {
    try {
        const roleId = interaction.values?.[0];
        if (!roleId) {
            await applyColour(interaction.member, null);
            return interaction.reply({ content: 'Colour removed.', ephemeral: true });
        }
        const role = await applyColour(interaction.member, roleId);
        if (!role) {
            return interaction.reply({ content: "That colour isn't available any more — pick another.", ephemeral: true });
        }
        return interaction.reply({ content: `Your name is now **${role.name}**.`, ephemeral: true });
    } catch (err) {
        logger.error(`[ColourPicker] pick failed: ${err.message}`, { category: 'roles' });
        // 50013 is the one a member can't do anything about, so say what it means.
        const msg = err.code === 50013
            ? "I can't change your colour — my role has been moved below the colour roles. Tell a mod."
            : 'That didn\'t work. Try again in a moment.';
        return interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
}

/** "Other…" — ask for a colour by name or hex. */
export async function handleColourOther(interaction) {
    const [[cfg]] = await pool.execute(
        'SELECT allow_custom FROM colour_picker_config WHERE guild_id = ?', [interaction.guild.id]);
    if (cfg && cfg.allow_custom === 0) {
        return interaction.reply({ content: 'Custom colours are switched off here — pick one from the menus.', ephemeral: true });
    }
    return interaction.showModal({
        custom_id: 'colour_custom_modal',
        title: 'Pick your own colour',
        components: [
            { type: 1, components: [{
                type: 4, custom_id: 'hex', style: 1, required: true, max_length: 30,
                label: 'Colour', placeholder: '#F5A7C5, or a name like lavender',
            }] },
            { type: 1, components: [{
                type: 4, custom_id: 'name', style: 1, required: false, max_length: 40,
                label: 'What to call it (optional)', placeholder: 'Bubblegum',
            }] },
        ],
    });
}

export async function handleColourCustomModal(interaction) {
    try {
        const input = interaction.fields.getTextInputValue('hex');
        const hex = parseColour(input);
        if (!hex) {
            return interaction.reply({
                content: `I couldn't read **${input}** as a colour. Try a hex code like \`#F5A7C5\`, or a name like \`lavender\`.`,
                ephemeral: true,
            });
        }
        const label = (interaction.fields.getTextInputValue('name') || '').trim() || hex;
        const { role, created } = await ensureColourRole(interaction.guild, label.slice(0, 40), hex, interaction.user.id);
        await applyColour(interaction.member, role.id);

        const check = readability(hex);
        const lines = [`Your name is now **${role.name}** (${hex}).`];
        if (created) lines.push('It\'s been added to the menus, so anyone else can use it too.');
        // Warn, but never refuse: it's their name.
        if (!check.ok) {
            lines.push(`\n⚠️ Heads up — this one is ${check.why}. ` +
                `Contrast is ${check.dark.toFixed(1)}:1 on dark and ${check.light.toFixed(1)}:1 on light; ` +
                `3:1 is about the point where a name stays readable. You can keep it, it just may be hard to see.`);
        }
        return interaction.reply({ content: lines.join(' '), ephemeral: true });
    } catch (err) {
        logger.error(`[ColourPicker] custom colour failed: ${err.message}`, { category: 'roles' });
        const msg = err.code === 50013
            ? "I can't create roles here — my role needs to sit above the colour block. Tell a mod."
            : err.code === 30005
                ? 'This server has hit Discord\'s 250-role limit, so no new colours can be added.'
                : 'That didn\'t work. Try again in a moment.';
        return interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
}

export async function handleColourClear(interaction) {
    await applyColour(interaction.member, null);
    return interaction.reply({ content: 'Colour removed — your name is back to default.', ephemeral: true });
}

/**
 * Redraw the live panel after the palette changes, so a colour someone just
 * invented shows up for everyone without anybody reposting the message.
 */
export async function refreshColourPanel(guild) {
    const [[cfg]] = await pool.execute(
        'SELECT channel_id, message_id FROM colour_picker_config WHERE guild_id = ?', [guild.id]);
    if (!cfg?.channel_id || !cfg?.message_id) return 'not_posted';
    const channel = await guild.channels.fetch(cfg.channel_id).catch(() => null);
    const message = channel ? await channel.messages.fetch(cfg.message_id).catch(() => null) : null;
    if (!message) return 'message_gone';
    const { components } = await buildPicker(guild);
    await message.edit({ components });
    return 'updated';
}
