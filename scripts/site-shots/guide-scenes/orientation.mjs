// Screenshots for the orientation guide. The Discord message is the bot's own embed: buildOrientationEmbed() from
// core/orientation-manager.js, run here with Maple Hollow's features (the database is stubbed for the screenshots).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function ({ manage, discord, ctx, demo }) {
    const { guild, channel, channels, roles, member: M } = demo;
    const orientation = await import(pathToFileURL(path.join(ctx.root, 'core/orientation-manager.js')).href);

    // What Maple Hollow has on (the rest shows as "to set up").
    const on = new Set(['Logging / Audit Trail', 'Raid Detection', 'Phishing Protection', 'Anti-Nuke Protection', 'Moderation Tools',
        'Welcome & Goodbye', 'Ticketing System', 'Stream Announcements', 'Leveling & Rank Cards', 'Reaction Roles', 'Starboard',
        'Birthday Celebrations', 'Suggestions', 'Music Playback', 'Economy System', 'Counting', 'Self-Promo Tracking', 'Auto Publisher']);
    const detect = async () => ({
        enabled: orientation.FEATURE_CHECKS.filter((f) => on.has(f.name)),
        available: orientation.FEATURE_CHECKS.filter((f) => !on.has(f.name)),
    });
    const client = {
        guilds: { cache: new Map([[guild.id, { id: guild.id, name: guild.name, iconURL: () => null }]]) },
        user: { displayName: 'CertiFried Utility', username: 'CertiFried Utility', displayAvatarURL: () => 'https://example.invalid/a.png' },
    };
    const prev = process.env.DASHBOARD_URL;
    process.env.DASHBOARD_URL = 'https://certifriedmultitool.com/';
    const embed = (await orientation.buildOrientationEmbed(client, guild.id, { detect })).toJSON();
    if (prev === undefined) delete process.env.DASHBOARD_URL; else process.env.DASHBOARD_URL = prev;

    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    discord('orientation-discord', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [{
            username: 'CertiFried Utility', avatarUrl: `${B()}/images/CertiFried.png`,
            usedBy: { name: M.juniper.displayName, command: '/systems orientation post' },
            embeds: [{
                color: `#${Number(embed.color || 0x5865f2).toString(16).padStart(6, '0')}`,
                author: embed.author?.name,
                description: embed.description,
                fields: (embed.fields || []).map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })),
                footer: embed.footer?.text,
                timestamp: true,
            }],
        }],
    }), {
        alt: 'The server guide message in #bot-commands: the features Maple Hollow has on, the protection and other features still to set up with the command for each, the commands everyone can use, and links to the guides and the dashboard.',
        guides: ['orientation'], width: 620, outWidth: 720,
    });

    // The Orientation page (a feature-config page: core/feature-config-spec.js orientation).
    // Same answer as the generic feature-config stub in shots.mjs, with Maple Hollow's guide channel chosen.
    const { FEATURE_SPECS } = await import(pathToFileURL(path.join(ctx.root, 'core/feature-config-spec.js')).href);
    const s = FEATURE_SPECS.orientation;
    ctx.stub(/^\/api\/guilds\/\d+\/feature-config\/orientation$/, () => ({
        success: true, rows: [],
        config: { ...Object.fromEntries(s.fields.map((f) => [f.key, f.default ?? null])), channel_id: channel['bot-commands'].id },
        spec: { key: 'orientation', label: s.label, icon: s.icon, iconPack: s.iconPack || 'fas', colour: s.colour, blurb: s.blurb, commands: s.commands || [], category: s.category || null, note: s.note || null, unwired: s.unwired || null,
            fields: s.fields.map((f) => ({ ...f, wired: f.wired !== false })), hasList: !!s.list, listTitle: s.list?.title || null, listLabels: s.list?.labels || null },
    }));
    manage('orientation-page', 'orientation', {}, {
        alt: 'The Orientation page on the dashboard: the guide channel to post the server guide in, and the commands that post, refresh and remove it.',
        guides: ['orientation'],
    });
}
