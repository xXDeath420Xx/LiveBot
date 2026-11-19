/**
 * Rendering Discord entities on a web page.
 *
 * Discord's mention syntax — `<#123>`, `<@&123>`, `<@123>` — only resolves inside Discord. Emitted
 * into HTML it is just noise: the webhooks page was showing a literal `<#1529606788553375906>`
 * where a channel name belonged. Anywhere the dashboard displays a channel or role it should show
 * the NAME, linked to the thing itself.
 *
 * Populate the lookups once per page from the guild data the server already renders, then use
 * `Discord.channel(id)` / `Discord.role(id)` / `Discord.mentions(text)`.
 *
 *   Discord.init({ guildId: '...', channels: [...], roles: [...] });
 *   el.innerHTML = Discord.channel(row.channel_id);
 *
 * Every function returns escaped HTML and degrades gracefully: an id with no match (a deleted
 * channel, or one this admin cannot see) renders as a muted `#unknown-channel` with the raw id in
 * the tooltip, which is still far more use than a bare snowflake.
 */
(function (global) {
    'use strict';

    var guildId = null;
    var channels = Object.create(null);
    var roles = Object.create(null);

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function index(target, list) {
        (list || []).forEach(function (item) {
            if (item && item.id) target[String(item.id)] = item;
        });
    }

    function init(opts) {
        opts = opts || {};
        if (opts.guildId) guildId = String(opts.guildId);
        // Voice channels arrive as a separate list in most of the manage views.
        index(channels, opts.channels);
        index(channels, opts.voiceChannels);
        index(channels, opts.categories);
        index(roles, opts.roles);
    }

    /** True once init() has been given something to look names up in. */
    function ready() {
        return Object.keys(channels).length > 0 || Object.keys(roles).length > 0;
    }

    function channelUrl(id) {
        return guildId ? 'https://discord.com/channels/' + encodeURIComponent(guildId) + '/' + encodeURIComponent(id) : null;
    }

    /**
     * A channel as `#name`, linked into Discord when the guild id is known.
     * @param {string} id
     * @param {{link?: boolean}} [opts] link defaults to true
     */
    function channel(id, opts) {
        if (!id) return '<span class="dc-none">—</span>';
        var known = channels[String(id)];
        var name = known ? known.name : null;
        var label = '#' + esc(name || 'unknown-channel');
        var url = channelUrl(id);

        if (!name) {
            return '<span class="dc-ref dc-missing" title="' + esc(id) + ' — not found, it may have been deleted">'
                 + label + '</span>';
        }
        if (opts && opts.link === false) return '<span class="dc-ref">' + label + '</span>';
        return url
            ? '<a class="dc-ref" href="' + url + '" target="_blank" rel="noopener" title="' + esc(id) + '">' + label + '</a>'
            : '<span class="dc-ref" title="' + esc(id) + '">' + label + '</span>';
    }

    /** A role as `@name`, tinted with the role's own colour when we know it. */
    function role(id) {
        if (!id) return '<span class="dc-none">—</span>';
        var known = roles[String(id)];
        if (!known) {
            return '<span class="dc-ref dc-missing" title="' + esc(id) + ' — not found, it may have been deleted">@unknown-role</span>';
        }
        // Discord sends 0 for "no colour", which would render as black on a dark page.
        var colour = known.color && known.color !== 0
            ? '#' + known.color.toString(16).padStart(6, '0')
            : null;
        return '<span class="dc-ref dc-role"' + (colour ? ' style="color:' + colour + '"' : '')
             + ' title="' + esc(id) + '">@' + esc(known.name) + '</span>';
    }

    /** A user id — no directory to resolve against, so link out and show the id. */
    function user(id) {
        if (!id) return '<span class="dc-none">—</span>';
        return '<a class="dc-ref" href="https://discord.com/users/' + encodeURIComponent(id)
             + '" target="_blank" rel="noopener">' + esc(id) + '</a>';
    }

    /**
     * Replace every Discord mention inside a plain-text string with a rendered one.
     * Use for stored templates and message content, where mentions are embedded in prose.
     * The input is escaped first, so this is safe on untrusted text.
     */
    function mentions(text) {
        if (!text) return '';
        return esc(text)
            .replace(/&lt;#(\d+)&gt;/g, function (_, id) { return channel(id); })
            .replace(/&lt;@&amp;(\d+)&gt;/g, function (_, id) { return role(id); })
            .replace(/&lt;@!?(\d+)&gt;/g, function (_, id) { return user(id); });
    }

    /**
     * Pick the right renderer for a column, from its NAME and its VALUE together.
     *
     * Name alone is not enough in either direction. `role_ping_id` and `allowed_channels` are
     * entity references that no simple `_id$` pattern matches, while `channel_name` mentions a
     * channel but holds text — rendering that as a reference would print `#unknown-channel`
     * over a perfectly good name. So: the name says which KIND, and the value must actually
     * look like snowflakes before anything is rendered.
     *
     * Returns null when this is not an entity column, so the caller falls through to its own
     * formatting.
     */
    function auto(columnName, value) {
        if (value === null || value === undefined || value === '') return null;

        var name = String(columnName).toLowerCase();
        var render = null;
        if (/channel/.test(name)) render = channel;
        else if (/role/.test(name)) render = role;
        else if (/user|member|created_by|updated_by|author|owner/.test(name)) render = user;
        if (!render) return null;

        var ids = parseIds(value);
        // Every entry must be a snowflake. A single non-id (a name, a template, a mode string)
        // means this column is not a reference after all.
        if (!ids.length || !ids.every(isSnowflake)) return null;

        return ids.map(render).join(' ');
    }

    function isSnowflake(v) {
        return /^\d{15,25}$/.test(String(v));
    }

    /** Split one id, a JSON array, or a comma-separated string into an array of id strings. */
    function parseIds(value) {
        var ids;
        if (Array.isArray(value)) ids = value;
        else {
            var s = String(value).trim();
            if (s.charAt(0) === '[') {
                try { ids = JSON.parse(s); } catch (e) { ids = [s]; }
            } else if (s.indexOf(',') !== -1) ids = s.split(',');
            else ids = [s];
        }
        return (ids || []).map(function (x) { return String(x).trim(); }).filter(Boolean);
    }

    /** Render one id, or a JSON array / comma-separated list of them. */
    function list(value, render) {
        var ids = parseIds(value);
        if (!ids.length) return '<span class="dc-none">—</span>';
        return ids.map(render).join(' ');
    }

    global.Discord = {
        init: init, ready: ready,
        channel: channel, role: role, user: user,
        mentions: mentions, auto: auto, esc: esc,
    };
})(window);
