import logger from '../utils/logger.js';

/**
 * One placeholder vocabulary for every user-authored message in the network.
 *
 * Before this there were three, and they disagreed:
 *
 *   greeting-manager      {mention} {username} {user} {server} {memberCount}
 *                         {member_count} {count} {quirky} {quirky_plain}
 *   leveling-manager      {user} {username} {level} {role} — {user} here is a
 *                         mention, while in greeting-manager {user} is a tag
 *   custom-command-templates  {user.mention} {user.name} {server.name}
 *                         {server.id} {channel.mention} — dotted, and the only
 *                         one that is
 *
 * So `{user}` meant two different things depending on which box you typed it
 * into, and a server owner who learned the welcome syntax could not reuse it in
 * a level-up message. That is a customization problem disguised as a formatting
 * problem: people stop customizing things whose syntax they have to relearn.
 *
 * This resolver accepts **all three vocabularies** and normalises them, so every
 * existing configured message keeps working exactly as it does now while new
 * ones can use one consistent set. Nothing has to be migrated.
 *
 * ## Ambiguity is resolved by context, deliberately
 *
 * `{user}` is the genuine conflict. Rather than pick a winner and silently
 * change what existing messages render, each caller declares which reading its
 * historical messages used via `legacyUser`. Welcome messages keep meaning
 * "tag"; level-ups keep meaning "mention". New templates should use the explicit
 * `{user.mention}` / `{user.tag}` forms, which mean the same thing everywhere.
 */

/**
 * Build the value map for a template.
 *
 * Every field is optional — a placeholder with no backing value is left as
 * written rather than rendered as "undefined", so a typo in a config field looks
 * like a typo instead of like a bug in the bot.
 *
 * @param {object} ctx
 * @param {import('discord.js').User}        [ctx.user]
 * @param {import('discord.js').GuildMember} [ctx.member]
 * @param {import('discord.js').Guild}       [ctx.guild]
 * @param {import('discord.js').GuildChannel}[ctx.channel]
 * @param {import('discord.js').Role}        [ctx.role]
 * @param {object} [ctx.extra]  Feature-specific values ({level}, {quirky}, …).
 * @param {'tag'|'mention'} [ctx.legacyUser='mention']  What bare {user} means here.
 */
export function buildValues({ user, member, guild, channel, role, extra = {}, legacyUser = 'mention' } = {}) {
    const u = user || member?.user || null;
    const g = guild || member?.guild || null;

    const values = {};

    if (u) {
        values['user.mention'] = `<@${u.id}>`;
        values['user.name'] = u.username;
        values['user.tag'] = u.tag ?? u.username;
        values['user.id'] = u.id;
        values['user.avatar'] = typeof u.displayAvatarURL === 'function' ? u.displayAvatarURL() : '';
        values['user.display'] = member?.displayName ?? u.displayName ?? u.username;

        // Legacy aliases.
        values.username = u.username;
        values.mention = `<@${u.id}>`;
        values.user = legacyUser === 'tag' ? (u.tag ?? u.username) : `<@${u.id}>`;
    }

    if (g) {
        values['server.name'] = g.name;
        values['server.id'] = g.id;
        values['server.members'] = String(g.memberCount ?? '');
        values['server.icon'] = typeof g.iconURL === 'function' ? (g.iconURL() || '') : '';

        values.server = g.name;
        values.guild = g.name;
        // Three legacy spellings, all of which appear in configured messages.
        values.memberCount = String(g.memberCount ?? '');
        values.member_count = String(g.memberCount ?? '');
        values.count = String(g.memberCount ?? '');
    }

    if (channel) {
        values['channel.mention'] = `<#${channel.id}>`;
        values['channel.name'] = channel.name;
        values['channel.id'] = channel.id;
        values.channel = `<#${channel.id}>`;
    }

    if (role) {
        values['role.mention'] = `<@&${role.id}>`;
        values['role.name'] = role.name;
        values['role.id'] = role.id;
        values.role = `<@&${role.id}>`;
    }

    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null) values[key] = String(value);
    }

    return values;
}

/** {random:1-100} — inclusive both ends. */
function expandRandom(text) {
    return text.replace(/\{random:(-?\d+)-(-?\d+)\}/g, (match, lo, hi) => {
        const a = Number(lo);
        const b = Number(hi);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return match;
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        return String(min + Math.floor(Math.random() * (max - min + 1)));
    });
}

/** {choice:a|b|c} — one at random. */
function expandChoice(text) {
    return text.replace(/\{choice:([^}]*)\}/g, (match, list) => {
        const options = list.split('|');
        if (!options.length) return match;
        return options[Math.floor(Math.random() * options.length)];
    });
}

/**
 * Render a template.
 *
 * @param {string} template
 * @param {object} values  From buildValues().
 * @param {object} [opts]
 * @param {boolean} [opts.dynamic=true]  Expand {random:} and {choice:}.
 * @returns {string}
 */
export function render(template, values, { dynamic = true } = {}) {
    if (!template) return '';

    let out = String(template);
    if (dynamic) {
        out = expandRandom(out);
        out = expandChoice(out);
    }

    // Longest keys first so `{user.mention}` is never eaten by `{user}`.
    return out.replace(/\{([a-zA-Z_][\w.]*)\}/g, (match, key) => {
        const value = values[key];
        // Unknown placeholder: leave it visible. Rendering "undefined" makes a
        // config typo look like a bot fault, and blanking it hides the mistake
        // entirely — neither helps the person who has to fix it.
        return value === undefined ? match : value;
    });
}

/**
 * Convenience: build values and render in one call.
 *
 * @param {string} template
 * @param {object} ctx  As buildValues().
 */
export function renderTemplate(template, ctx = {}) {
    try {
        return render(template, buildValues(ctx), { dynamic: ctx.dynamic !== false });
    } catch (error) {
        // A broken template must never take down a welcome or a level-up.
        logger.warn(`[TemplateResolver] Render failed, returning template verbatim: ${error.message}`);
        return String(template ?? '');
    }
}

/**
 * Placeholders available in a given context, for help text and dashboard hints.
 * Grouped so a UI can show "user", "server", … sections.
 */
export function describePlaceholders({ includeLegacy = false, extra = [] } = {}) {
    const groups = {
        user: ['{user.mention}', '{user.name}', '{user.tag}', '{user.display}', '{user.id}', '{user.avatar}'],
        server: ['{server.name}', '{server.members}', '{server.id}', '{server.icon}'],
        channel: ['{channel.mention}', '{channel.name}', '{channel.id}'],
        role: ['{role.mention}', '{role.name}', '{role.id}'],
        dynamic: ['{random:1-100}', '{choice:a|b|c}'],
    };
    if (extra.length) groups.feature = extra.map((e) => `{${e}}`);
    if (includeLegacy) {
        groups.legacy = ['{user}', '{username}', '{mention}', '{server}', '{memberCount}', '{count}'];
    }
    return groups;
}

export default { buildValues, render, renderTemplate, describePlaceholders };
