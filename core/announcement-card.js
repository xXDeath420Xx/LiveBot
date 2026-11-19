import {
    ContainerBuilder, TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
    SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
} from 'discord.js';

/**
 * Free-form staff announcements: picture on top, then title, body and footer, in one
 * Components V2 container.
 *
 * Not an embed on purpose. An embed puts its image UNDER the text, and a slash-command string
 * option cannot hold a line break, so `/admin announce` could never post a multi-paragraph
 * notice with the art first. The text comes from a modal instead (4000 chars, newlines kept).
 *
 * Discord caps the TEXT of a V2 message at 4000 characters across every text display, so the
 * limit is checked over title + body + footer + ping together, not per field.
 */

export const TEXT_LIMIT = 4000;

// Stable component ids, so `/manage announce edit` can read the parts back out of a posted message.
const ID_TITLE = 11;
const ID_BODY = 12;
const ID_FOOTER = 13;
const ID_PING = 14;

export function parseHexColor(input) {
    if (!input) return null;
    const hex = String(input).trim().replace(/^#/, '');
    return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : null;
}

function pingText(pingRoleId) {
    if (!pingRoleId) return null;
    return pingRoleId === 'everyone' ? '@everyone' : `<@&${pingRoleId}>`;
}

export function textLength({ title, body, footer, pingRoleId }) {
    return (title ? `# ${title}`.length : 0)
        + (body || '').length
        + (footer ? `-# ${footer}`.length : 0)
        + (pingText(pingRoleId) || '').length;
}

/**
 * @param {object} p
 * @param {string} [p.title]
 * @param {string} p.body
 * @param {string} [p.footer]
 * @param {number} [p.color]        accent stripe
 * @param {string} [p.imageName]    filename of an image uploaded in the same request
 * @param {string} [p.pingRoleId]   role id, or 'everyone'
 * @returns message payload minus `files`
 */
export function buildAnnouncement({ title, body, footer, color, imageName, pingRoleId }) {
    const len = textLength({ title, body, footer, pingRoleId });
    if (len > TEXT_LIMIT) {
        throw new Error(`Announcement text is ${len} characters; Discord allows ${TEXT_LIMIT}. Trim ${len - TEXT_LIMIT}.`);
    }

    const container = new ContainerBuilder();
    if (color != null) container.setAccentColor(color);

    if (imageName) {
        container.addMediaGalleryComponents(new MediaGalleryBuilder()
            .addItems(new MediaGalleryItemBuilder().setURL(`attachment://${imageName}`)));
    }
    if (title) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setId(ID_TITLE).setContent(`# ${title}`));
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setId(ID_BODY).setContent(body));
    if (footer) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(new TextDisplayBuilder().setId(ID_FOOTER).setContent(`-# ${footer}`));
    }

    const components = [];
    const ping = pingText(pingRoleId);
    // The ping sits OUTSIDE the container: a mention inside a container still notifies, but
    // leading with it makes the card read as the announcement rather than a quoted block.
    if (ping) components.push(new TextDisplayBuilder().setId(ID_PING).setContent(ping));
    components.push(container);

    return {
        components,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: pingRoleId === 'everyone'
            ? { parse: ['everyone'] }
            : { roles: pingRoleId ? [pingRoleId] : [] },
    };
}

/** Read an announcement back out of a message this module posted. Null if it isn't one. */
export function readAnnouncement(message) {
    const found = {};
    const walk = (list) => {
        for (const c of list || []) {
            const j = typeof c.toJSON === 'function' ? c.toJSON() : c;
            if (j.id != null && typeof j.content === 'string') found[j.id] = j.content;
            if (j.components) walk(j.components);
            if (j.type === 17 && j.accent_color != null) found.color = j.accent_color;
            // A V2 message does NOT list component-referenced files in `attachments`; the
            // picture is only reachable through the gallery item's resolved CDN url.
            if (j.type === 12 && j.items?.[0]?.media?.url) found.imageUrl = j.items[0].media.url;
        }
    };
    walk(message.components);
    if (found[ID_BODY] == null) return null;

    const ping = found[ID_PING];
    const roleMatch = ping && /^<@&(\d+)>$/.exec(ping);
    return {
        title: found[ID_TITLE]?.replace(/^# /, '') || '',
        body: found[ID_BODY],
        footer: found[ID_FOOTER]?.replace(/^-# /, '') || '',
        color: found.color ?? null,
        imageUrl: found.imageUrl ?? null,
        pingRoleId: ping === '@everyone' ? 'everyone' : roleMatch ? roleMatch[1] : null,
    };
}
