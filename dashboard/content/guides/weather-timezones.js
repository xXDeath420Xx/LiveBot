// Checked against: dashboard/views/partials/manage/weather.ejs, dashboard/server.js (weather page loader),
// commands/info/weather.js, core/weather-manager.js (checkAlerts, alert types, DMs), index.js (weather timer, 180 s),
// commands/tools/timezone.js, core/timezone-manager.js (detection, clock reaction, DM, zone board),
// events/messageCreate.js, events/messageReactionAdd.js, dashboard/views/partials/manage/utilities.ejs (Auto publisher),
// core/auto-publisher.js, docs/command-split-2026-11-18.md (/weather and /timezone are slash), core/manage-nav.js.
export default {
    slug: 'weather-timezones',
    title: 'Weather alerts, time zones and auto-publish',
    area: 'tools',
    summary: 'Send members severe weather alerts for their area, convert times people mention in chat, and publish announcement posts automatically.',
    result: {
        image: 'weather-timezones-discord',
        caption: 'A member mentions a time and the bot replies with it in each zone on the server\'s zone board.',
    },
    before: [
        '**Weather** and **Utilities** are on the dashboard under **Scheduling & automation** and need **Manage Server**. `/timezone server` and the zone board need **Manage Server** too. Members set their own weather location and time zone.',
    ],
    steps: [
        {
            title: 'Turn on weather alerts',
            text: [
                'On the **Weather** page, turn on the switch at the top and press **Save**, or use `/weather check config` (Administrator). Alerts come from the US National Weather Service, so they only cover US ZIP codes.',
            ],
            command: '/weather check config enabled:True',
            image: 'weather-timezones-page',
        },
        {
            title: 'Members save their ZIP code',
            text: [
                'Each member who wants alerts runs `/weather check setlocation` with a 5-digit US ZIP code. `/weather check location` shows what they saved and `/weather check removelocation` stops the alerts.',
                'The bot checks for new alerts every 3 minutes and sends each one once, by direct message, to the members whose area it covers. It sends tornado, severe thunderstorm, tropical storm, hurricane, flash flood and winter storm watches and warnings, and blizzard warnings.',
            ],
            command: '/weather check setlocation zipcode:12345',
        },
        {
            title: 'Convert times mentioned in chat',
            text: [
                'Time detection is off until someone with Manage Server sets it up with `/timezone server`. `autodetect:react` makes the bot add a clock reaction to messages that mention a time, such as "raid at 8pm"; anyone who clicks it gets a direct message with that time in their own zone. `autodetect:list` replies in the channel with the time in every zone on the server\'s zone board instead.',
                'Add up to 10 zones to the board with `/timezone list add`. `zone:` on `/timezone server` is the fallback for members who have not set a zone, and `clock:` picks 12- or 24-hour times.',
            ],
            command: '/timezone server autodetect:react zone:America/New_York',
        },
        {
            title: 'Members set their own zone',
            text: [
                'Members run `/timezone set` with a zone such as `Europe/London` or an abbreviation such as `PST`. `/timezone time` shows their time, or someone else\'s with `user:`. `/timezone me` changes their clock, hides their zone name from others with `private:True` (their times still convert), or deletes their settings with `reset:True`.',
            ],
            command: '/timezone set zone:Europe/London',
        },
        {
            title: 'Publish announcement posts automatically',
            text: [
                'On the **Utilities** page, switch on **Publish announcements automatically** and press **Save**. Messages members post in an announcement channel are then published, so servers that follow the channel get them too. Posts by bots, polls and system messages are not published.',
            ],
        },
    ],
    notes: [
        'Weather alerts and time conversions arrive by direct message, so members with direct messages closed get neither.',
        '`/weather check current` shows the current weather for any city or ZIP code, and `/weather air quality` the air quality.',
        'The other two parts of the **Utilities** page are autoroles, covered in the role tools guide, and temporary voice channels, covered in the voice channels guide.',
    ],
    related: ['reminders-utilities', 'roles-tools', 'voice-channels'],
};
