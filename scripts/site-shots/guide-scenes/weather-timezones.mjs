// Screenshots for the weather-timezones guide. Formats copied from: core/timezone-manager.js handleTimeMessage ('list'
// mode: "**<time>** (<t:unix:f>)" then "• <zone> — <formatIn>" per zone on the board; formatIn's
// 'ddd, MMM D · h:mm A z' pattern). The <t:unix:f> tag is written as Discord shows it to a viewer in New York.
// The page is dashboard/views/partials/manage/weather.ejs with weatherConfig and weatherStats as the loader passes them.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, member: M } = demo;
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const origin = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: 'CertiFried Utility', avatarUrl: `${origin()}/images/CertiFried.png`, ...extra });

    // 8 PM on Friday 20 November 2026 in New York (EST, UTC-5) is 01:00 UTC on the 21st.
    const board = [
        ['America/New_York', 'Fri, Nov 20 · 8:00 PM EST'],
        ['America/Los_Angeles', 'Fri, Nov 20 · 5:00 PM PST'],
        ['Europe/London', 'Sat, Nov 21 · 1:00 AM GMT'],
        ['Australia/Sydney', 'Sat, Nov 21 · 12:00 PM AEDT'],
    ];
    discord('weather-timezones-discord', () => ({
        channel: 'general', ctx: ctxNames,
        messages: [
            { username: M.rowan.displayName, avatarUrl: ctx.av('rowan'), bot: false, time: 'Today at 6:41 PM',
                content: 'Movie night starts at 8pm tonight, see you in the Campfire channel' },
            bot({ time: 'Today at 6:41 PM', content: `**8pm** (November 20, 2026 8:00 PM)\n${board.map(([z, t]) => `• ${z} — ${t}`).join('\n')}` }),
        ],
    }), {
        alt: 'Rowan Pike says movie night starts at 8pm, and the bot replies with that time in New York, Los Angeles, London and Sydney.',
        guides: ['weather-timezones'],
    });

    manage('weather-timezones-page', 'weather', {
        weatherConfig: { enabled: 1, check_interval: 60 },
        weatherStats: { totalUsers: 14, activeAlerts: 9, alertsSent: 27 },
    }, {
        alt: 'The Weather page: weather alerts switched on, how alerts are sent, and the commands members use to save their ZIP code.',
        guides: ['weather-timezones'],
    });
}
