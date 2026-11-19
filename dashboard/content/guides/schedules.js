// Checked against: commands/community/schedule.js, dashboard/routes/public-schedule.js, dashboard/views/public-schedule.ejs,
// dashboard/views/partials/manage/schedule.ejs and streaming.ejs (Twitch schedules), core/schedule-calendar*.js.
export default {
    slug: 'schedules',
    title: 'Event schedules and the public schedule page',
    area: 'streams',
    summary: 'Plan a marathon or event as a list of runs, share it on a public page, and post updates in Discord.',
    result: {
        image: 'schedules-public',
        caption: 'The public page for an event: the run before, the run now and the next one, then the full run order.',
    },
    before: [
        'Creating events, schedules and runs needs **Manage Server**.',
    ],
    steps: [
        {
            title: 'Create the event',
            text: [
                'The slug becomes the web address: this event will be at `/schedule/mh-marathon-2026`. You can also create events on the dashboard under **Scheduling & automation**, then **Schedules**.',
            ],
            command: '/schedule event create name:Maple Hollow Charity Marathon slug:mh-marathon-2026',
            image: 'schedule-page',
        },
        {
            title: 'Add a schedule for each day or block',
            text: [
                'An event holds one or more schedules, such as Saturday and Sunday. Give each one a start time so the page can show when each run should begin and "starting soon" posts go out: `start:` (and `timezone:`, UTC if left out) when you create it, `/schedule list set-start` later, or **Starts at** on the dashboard.',
            ],
            command: '/schedule list create event:mh-marathon-2026 name:Saturday slug:saturday start:2026-12-05 15:00 timezone:America/New_York',
        },
        {
            title: 'Add the runs',
            text: [
                'Each run has a game and, if you like, a category, runners, an estimate and setup time. Estimates are written like `1:30:00` or `45m`.',
            ],
            command: '/schedule run add schedule_id:21 game:Celeste category:Any% runners:Bramble estimate:33m setup:5m',
        },
        {
            title: 'Share the page and run the day',
            text: [
                'Send people to `/schedule/` followed by the event slug. [All events](/schedule) are listed by month.',
                'On the day, mark runs with `/schedule run start run_id:` and `/schedule run complete run_id:`; `/schedule run list` shows each run\'s ID. `/schedule link event:mh-marathon-2026 type:announcements` in a channel posts there when a run is about to start.',
            ],
            command: '/schedule run start run_id:102',
        },
        {
            title: 'Post your Twitch schedule as a poster (optional)',
            text: [
                'For a regular streaming week, the **Twitch schedules** page under Stream alerts posts your Twitch schedule as an image in a channel and keeps it up to date. The **Schedule calendar** page lets you edit the month and post it as a poster like this one.',
            ],
            image: 'schedules-poster',
        },
    ],
    notes: [
        'An event slug can only be used once across all servers, because it is the web address.',
        '`/schedule ticker event:` shows the current and next runs in Discord; anyone can use it.',
        'Recurring Discord events, such as a weekly game night, are made with `/schedule discord recurring-add`, which needs Manage Events.',
    ],
    related: ['go-live-alerts', 'community', 'social-feeds'],
};
