// Screenshots for the discord-events guide. Formats copied from: core/event-reminder-manager.js (announceStart),
// core/feature-config-spec.js ('event-reminders', the generated page's fields and list), core/guild-theme.js (default colours).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function ({ manage, discord, ctx, demo }) {
    const { channel, channels, voiceChannels, member: M } = demo;
    const spec = await import(pathToFileURL(path.join(ctx.root, 'core/feature-config-spec.js')).href);
    const s = spec.FEATURE_SPECS['event-reminders'];

    // Invented for this guide only.
    const gameNight = { id: '100300000000000099', name: 'Game night', hexColor: '#c0763a' };

    // The Event Reminders page (generated from the spec; it loads its settings from the feature-config API).
    ctx.stub(/^\/api\/guilds\/\d+\/feature-config\/event-reminders$/, () => ({
        success: true,
        config: {
            dm_reminders_enabled: true, reminder_minutes: 30, announce_enabled: true,
            announce_channel_id: channel.announcements.id, announce_role_id: gameNight.id,
        },
        rows: [{ id: 3, template_name: 'Friday game night', next_scheduled: '2026-12-04T20:00:00.000Z', active: 1, last_error: null }],
        spec: {
            key: 'event-reminders', label: s.label, icon: s.icon, iconPack: s.iconPack || 'fas', colour: s.colour, blurb: s.blurb,
            commands: s.commands || [], category: s.category || null, note: s.note || null, unwired: s.unwired || null,
            fields: s.fields.map((f) => ({ ...f, wired: f.wired !== false })), hasList: !!s.list, listTitle: s.list?.title || null, listLabels: s.list?.labels || null,
        },
    }));
    manage('discord-events-reminders', 'event-reminders', {
        roles: [...demo.roles, { ...gameNight, color: 0xc0763a, position: 0, managed: false, memberCount: 31 }],
    }, {
        alt: 'The Event Reminders page: DM reminders on, 30 minutes before the start, start announcements in #announcements pinging Game night, and one repeating event.',
        guides: ['discord-events'], height: 1300,
    });

    // The start announcement (announceStart): role ping, success colour, title, description, Where field, Open event link.
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const campfire = voiceChannels[0];
    discord('discord-events-discord', () => ({
        channel: 'announcements',
        ctx: {
            channels: [...channels, ...voiceChannels].map((c) => ({ id: c.id, name: c.name })),
            roles: [...demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })), { id: gameNight.id, name: gameNight.name, color: gameNight.hexColor }],
            users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
        },
        messages: [{
            username: 'CertiFried Utility', avatarUrl: `${B()}/images/CertiFried.png`,
            time: 'Today at 8:00 PM',
            content: `<@&${gameNight.id}>`,
            embeds: [{
                color: '#57F287',
                title: '📅 Friday game night is starting now!',
                description: `Party games in ${campfire.name} with ${M.rowan.displayName} hosting. Bring a snack.`,
                fields: [{ name: 'Where', value: `<#${campfire.id}>`, inline: true }],
                timestamp: true,
            }],
            buttons: [{ label: 'Open event' }],
        }],
    }), {
        alt: 'A post in #announcements pinging Game night: "Friday game night is starting now!", where it happens (the Campfire voice channel) and an Open event button.',
        guides: ['discord-events'],
    });
}
