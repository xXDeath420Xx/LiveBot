// Checked against: core/starboard-manager.js, commands/admin/community.js (starboard), core/suggestion-manager.js,
// commands/community/engage-suggest-handler.js, core/birthday-manager.js, jobs/birthday-scheduler.js,
// dashboard/views/partials/manage/starboard.ejs, suggestions.ejs, birthday.ejs.
export default {
    slug: 'community',
    title: 'Starboard, suggestions and birthdays',
    area: 'community',
    summary: 'Highlight popular messages, collect suggestions members vote on, and celebrate birthdays.',
    result: {
        image: 'community-discord',
        caption: 'A starboard repost, a suggestion with its vote buttons, and a birthday announcement.',
    },
    steps: [
        {
            title: 'Set up a starboard',
            text: [
                'On the dashboard, open **Levels & engagement**, then **Starboard**. Pick the **Starboard channel**, the **Reaction emoji** (empty means a star) and **Reactions needed** (3 by default). A message that reaches that many reactions is reposted with a link back to the original.',
                'Members\' reactions to their own messages are not counted unless you turn on **Count self-reactions**. A server can have up to 10 boards, each with its own channel, emoji and threshold.',
            ],
            command: '/community starboard setup channel:#starboard threshold:3',
            image: 'starboard-page',
        },
        {
            title: 'Collect suggestions',
            text: [
                'Open **Events, polls & giveaways**, then **Suggestions**, and choose the **Suggestions channel**. Members post with `/engage suggest submit`; each suggestion gets a number and up and down vote buttons.',
                'Staff answer with `/engage suggest approve id:`, `reject id: reason:` (a reason is required) and `implement id:`. These need Manage Server or the **Staff role** set on the page. **Tags** sort suggestions into groups.',
                'Turn on **Require staff approval** to check suggestions first. A new suggestion then waits in the **Staff review channel** with Approve and Reject buttons, and is only posted for voting once approved; a rejected one is never posted. The dashboard list and the commands work too.',
            ],
            command: '/engage suggest submit suggestion:A weekly screenshot contest channel',
            image: 'suggestions-page',
        },
        {
            title: 'Announce birthdays',
            text: [
                'Open **Levels & engagement**, then **Birthdays**. Turn on **Birthday announcements**, pick the **Announcement channel**, and optionally a **Birthday role** and your own **Birthday message** (`{user}`, `{username}`, `{server}` and `{age}` work in it).',
                'Members save their birthday as month and day; the year is optional and only used to show their age. `/engage birthday panel` posts buttons members can use instead.',
            ],
            command: '/engage birthday set date:11-21',
            image: 'birthday-page',
        },
    ],
    notes: [
        'Birthdays are announced at midnight New York time (America/New_York) for every server. The birthday role is taken back 24 hours after the announcement.',
        'A 29 February birthday is announced on 28 February in years without a 29th.',
        '`/engage birthday setup` only changes what you give it: leaving out `role:` or `message:` keeps the role and message already saved.',
        'Starboard posts from age-restricted channels only go to boards in age-restricted channels.',
    ],
    related: ['levels', 'reaction-roles', 'welcome'],
};
