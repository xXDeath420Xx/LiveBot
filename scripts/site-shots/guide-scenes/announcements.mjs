// Screenshots for the announcements guide. Formats copied from: dashboard/views/partials/manage/announce.ejs
// (the form, its preview and the list from /api/guilds/:id/announce), dashboard/views/partials/manage/
// scheduled-messages.ejs and dashboard/routes/api/features/scheduled-messages.js (the list from
// /api/guilds/:id/scheduled-messages, summaries as core/scheduled-announcements-manager.js describeSchedule writes them).
export default async function ({ manage, ctx, demo }) {
    const { guild, role, roles, channel, channels, member: M, D } = demo;

    // ── Announce: the form filled in, so the preview on the right shows the post ──
    await ctx.file('announcements-art.png', () => ctx.artwork({ from: '#3f8f6b', to: '#c0763a', caption: 'Maple Hollow Autumn Fair', seed: 7 }));
    ctx.stub(/^\/api\/guilds\/\d+\/announce\/?$/, () => ({
        posts: [
            { channel_id: channel.announcements.id, message_id: '100700000000000041', title: 'Movie night moves to Fridays', channel_name: 'announcements',
                created_at: D(2026, 11, 12, 18).toISOString(), updated_at: null, source: 'dashboard', url: 'https://discord.com/channels/0/0/0' },
            { channel_id: channel.announcements.id, message_id: '100700000000000040', title: 'New roles in #roles', channel_name: 'announcements',
                created_at: D(2026, 11, 3, 17).toISOString(), updated_at: null, source: 'command', url: 'https://discord.com/channels/0/0/0' },
        ],
    }));
    async function fillAnnounce(arg) {
        const $ = (id) => document.getElementById(id);
        const set = (id, v, ev = 'input') => { $(id).value = v; $(id).dispatchEvent(new Event(ev)); };
        set('annChannel', arg.channel, 'change');
        set('annTitle', arg.title);
        set('annBody', arg.body);
        set('annFooter', arg.footer);
        set('annPing', arg.ping, 'change');
        set('annColor', arg.color);
        const blob = await (await fetch(arg.image)).blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'autumn-fair.png', { type: 'image/png' }));
        $('annImage').files = dt.files;
        $('annImage').dispatchEvent(new Event('change'));
        await new Promise((r) => { const img = $('pvImage'); if (img.complete && img.naturalWidth) r(); else img.onload = r; setTimeout(r, 2000); });
        document.querySelectorAll('.cf-toasts, #reconnectBanner, .reconnect-banner').forEach((n) => { n.style.display = 'none'; });
        const grid = document.querySelector('#announcePage .ann-grid');
        window.scrollTo(0, Math.max(0, grid.getBoundingClientRect().top + window.scrollY - 76));
    }
    manage('announcements-page', 'announce', { guild, channels, roles }, {
        alt: 'The Announce page: an Autumn Fair announcement with a picture, text, small print and a ping for Regulars, and its preview on the right.',
        guides: ['announcements'], height: 860,
        prepare: {
            fn: fillAnnounce,
            arg: {
                channel: channel.announcements.id, ping: role.regulars.id, color: '#C0763A', image: '/__demo/announcements-art.png',
                title: 'Autumn Fair this Saturday',
                body: 'Stalls, a pumpkin carving contest and live music in the Campfire voice channel from 6pm.\n\nBring your best screenshot for the photo wall in <#' + channel.general.id + '>. Prizes for the top three.',
                footer: 'Questions? Ask in #support.',
            },
        },
    });

    // ── Scheduled messages: the list, loaded from the API ──
    const tz = 'Europe/London';
    ctx.stub(/^\/api\/guilds\/\d+\/scheduled-messages\/?$/, () => ({
        posts: [
            { id: 1, name: 'Rules reminder', channel_id: channel.general.id, message_content: 'A quick reminder: read <#' + channel.rules.id + '> before posting links.', embed: null, ping_role_id: '',
                schedule_type: 'weekly', schedule_value: '1 09:00', summary: 'Mondays at 09:00', next_run: D(2026, 11, 23, 9).toISOString(), last_run: D(2026, 11, 16, 9).toISOString(),
                run_count: 12, max_runs: null, end_at: null, enabled: true, last_error: null },
            { id: 2, name: 'Movie night', channel_id: channel.announcements.id, message_content: 'Movie night starts in one hour in the Campfire channel.', embed: null, ping_role_id: role.regulars.id,
                schedule_type: 'weekly', schedule_value: '5 19:00', summary: 'Fridays at 19:00', next_run: D(2026, 11, 20, 19).toISOString(), last_run: D(2026, 11, 13, 19).toISOString(),
                run_count: 6, max_runs: 10, end_at: null, enabled: true, last_error: null },
            { id: 3, name: 'Bump the server', channel_id: channel['bot-commands'].id, message_content: 'Time to bump Maple Hollow again.', embed: null, ping_role_id: '',
                schedule_type: 'interval', schedule_value: '120', summary: 'Every 2 hours', next_run: D(2026, 11, 19, 20).toISOString(), last_run: D(2026, 11, 19, 18).toISOString(),
                run_count: 41, max_runs: null, end_at: null, enabled: true, last_error: null },
            { id: 4, name: 'Monthly art contest', channel_id: channel.announcements.id, message_content: '', embed: { title: 'This month\'s art contest is open' }, ping_role_id: role.artists.id,
                schedule_type: 'monthly', schedule_value: '1 12:00', summary: 'Day 1 of every month at 12:00', next_run: D(2026, 12, 1, 12).toISOString(), last_run: D(2026, 11, 1, 12).toISOString(),
                run_count: 3, max_runs: null, end_at: null, enabled: true, last_error: null },
            { id: 5, name: 'Halloween countdown', channel_id: channel.general.id, message_content: 'Halloween party in one week.', embed: null, ping_role_id: '',
                schedule_type: 'once', schedule_value: '', summary: 'Once', next_run: null, last_run: D(2026, 10, 24, 18).toISOString(),
                run_count: 1, max_runs: null, end_at: null, enabled: false, last_error: null },
        ],
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: roles.map((r) => ({ id: r.id, name: r.name })),
        timezone: tz, timezoneLabel: 'GMT',
        limits: { maxPosts: 50, minIntervalMinutes: 10 },
    }));
    manage('announcements-scheduled', 'scheduled-messages', { guild }, {
        alt: 'The Scheduled messages page with five messages: a Monday rules reminder, Friday movie night, a bump every 2 hours, a monthly art contest and a one-off that has posted.',
        guides: ['announcements'], height: 900, scrollTo: '#sm-list-title',
    });
}
