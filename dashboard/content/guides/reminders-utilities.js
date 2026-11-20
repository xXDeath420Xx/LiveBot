// Checked against: dashboard/views/partials/manage/reminders.ejs, dashboard/server.js (create-reminder,
// delete-reminder, the reminders page loader), core/reminder-manager.js (the post, DM fallback), commands/tools/notes.js
// (/notes remind, /notes timecapsule), core/universal-commands.js (parseOptions: how typed options are read),
// docs/command-split-2026-11-18.md (/notes is text, /holiday is slash), dashboard/views/partials/manage/timecapsules.ejs,
// jobs/time-capsule-scheduler.js, commands/community/holiday.js, core/holiday-manager.js (catalogue, pin refresh),
// jobs/holiday-day-announcer.js, dashboard/views/partials/manage/holidays.ejs, core/manage-nav.js.
export default {
    slug: 'reminders-utilities',
    title: 'Reminders, time capsules and holiday countdowns',
    area: 'tools',
    summary: 'Post a reminder in a channel once or on repeat, let members seal messages that open on a later date, and keep live countdowns to holidays.',
    result: {
        image: 'reminders-utilities-discord',
        caption: 'A channel reminder, then a time capsule opening a month after it was sealed.',
    },
    before: [
        'The pages are on the dashboard under **Scheduling & automation**: **Reminders**, **Time capsules** and **Holiday countdowns**. They need **Manage Server**, and so does `/holiday`.',
    ],
    steps: [
        {
            title: 'Post a reminder in a channel',
            text: [
                'On **Reminders**, press **New reminder**. Write the **Message**, set **When** as a time from now (`30m`, `2h`, `1d` or `1w`, up to a year) and pick the **Channel**.',
                'To repeat it, choose **Repeat** (every hour, day, week, 2 weeks or 4 weeks) and how many **Times** to post it in all, from 2 to 1000. Leave **Times** empty to repeat it until you delete it.',
                'It is posted as an embed headed `Reminder!` that mentions you. **Upcoming reminders** lists the ones still to come, with times in UTC and a **Delete** button.',
            ],
            image: 'reminders-utilities-page',
        },
        {
            title: 'Let members set their own',
            text: [
                'Anyone can type `/notes remind me` as a message, with the time and then the text. Add `dm:true` to get it by direct message instead of in the channel. `/notes remind list` shows your reminders and `/notes remind delete id:` removes one.',
                'Reminders sent by direct message stay private: they are not on the dashboard.',
            ],
            command: '/notes remind me 2h stretch',
        },
        {
            title: 'Seal a time capsule',
            text: [
                'Members type `/notes timecapsule create` as a message, with `duration:` first (`1d`, `1w`, `1mo`, `3mo`, `6mo` or `1y`) and then the message, up to 1,000 characters.',
                'When its date comes, the capsule is posted in the channel it was made in, headed `Time Capsule Revealed!`, with who made it and when. The bot checks every hour. `/notes timecapsule list` shows the next 10 to open, without their text.',
                'The **Time capsules** page shows what is waiting to open and what has opened. **Delete** stops a capsule from being posted.',
            ],
            command: '/notes timecapsule create duration:1mo Open this after the winter event',
        },
        {
            title: 'Pin a holiday countdown',
            text: [
                '**Holiday countdowns** lists 23 holidays, nearest first, from Christmas and Halloween to Diwali, Ramadan and 4/20. Press **Edit** on one to pin its countdown in a channel; a pinned countdown edits itself every few hours.',
                'In the same place you can rename it (**Name**, **Emoji**), switch it off with **On in this server**, and turn on **Post on the day** to post `Today is <name>!` once on the date, from 9:00 in the server\'s time zone, with an optional **Ping a role**.',
            ],
            command: '/holiday pin holiday:Christmas channel:#announcements',
        },
        {
            title: 'Share a countdown',
            text: [
                '`/holiday countdown` shows one countdown and `/holiday list` all of them, nearest first. `/holiday share` posts a countdown with a public link that shows a preview wherever it is pasted. **Copy link** on the page copies that link.',
                'Add a channel under **Auto-reply channels**, and when someone posts a countdown link there, the bot replies with a countdown that keeps itself up to date.',
            ],
        },
    ],
    notes: [
        'Typed as a message, `/notes remind me 2h Stretch your legs` takes everything after the time as the reminder text; add `dm:true` or `repeat:` by name.',
        'If a reminder\'s channel has been deleted, it is sent to the person who made it by direct message.',
        'Reminders and time capsules cannot be edited. Delete one and make it again.',
        '`/holiday unpin` removes a pinned countdown. A holiday that is switched off stops updating its pin.',
    ],
    related: ['task-lists', 'weather-timezones', 'schedules'],
};
