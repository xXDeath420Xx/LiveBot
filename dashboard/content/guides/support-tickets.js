// Checked against: commands/admin/support.js + support/ticket.js, interactions/buttons/ticket_create.js,
// core/ticket-manager.js, dashboard/views/partials/manage/tickets.ejs.
export default {
    slug: 'support-tickets',
    title: 'Support tickets',
    area: 'moderation',
    summary: 'A button members press to open a private channel with your support team.',
    result: {
        image: 'tickets-discord',
        caption: 'The ticket panel, and the first message in a new ticket channel.',
    },
    before: [
        'You need **Manage Server** for the dashboard, or **Manage Messages** for `/support`. Create a category for ticket channels and a role for the people who answer them.',
    ],
    steps: [
        {
            title: 'Create a ticket panel',
            text: [
                'On the dashboard, open **Tickets, forms & support**, then **Tickets**, and select **New panel**. The **Panel name**, **Ticket category** and **Support role** are required; the **Panel channel** is where the button is posted.',
                'Set the **Title**, **Description**, **Colour**, **Button text** and **Button emoji** members see. **Ticket channel name** can use `{username}`, `{number}` and `{id}`; the default is `ticket-{username}`.',
            ],
            image: 'tickets-page',
        },
        {
            title: 'Pick log and alert channels, and transcripts',
            text: [
                'The panel\'s **Log channel** gets a post each time a ticket closes. With **Save transcripts** on, the conversation is saved when the ticket closes and linked in that post. Openings, claims and transfers are logged under **Tickets** on the **Logging** page.',
                'The panel\'s **Alert channel** gets a **New Ticket Opened** post each time a ticket opens, with a **Join Ticket** button for staff. The **Default panel** form has its own.',
            ],
        },
        {
            title: 'Or set it up from Discord',
            text: [
                'Run `/support ticket setup` with the support role and category, then `/support ticket panel` in the channel where the button should go. Setup takes an optional log channel and alert channel; the panel takes an optional title, description and form.',
            ],
            command: '/support ticket setup support-role:@Moderators category:Support tickets log-channel:#mod-log',
        },
        {
            title: 'Answer tickets',
            text: [
                'A new ticket is a private channel only the member and the support role can see. In it, staff can use `/support ticket claim`, `unclaim`, `transfer member:`, `add user:` and `remove user:`.',
                'Close it with the **Close Ticket** button or `/support ticket close reason:`. The member gets a DM asking them to rate the help from 1 to 5 stars, and the channel is deleted a few seconds later.',
            ],
            command: '/support ticket claim',
        },
        {
            title: 'Ask questions up front with a form',
            text: [
                'A form asks the member questions before the ticket opens, and the answers are shown in the ticket. Create one with `/support forms create name:`, add questions with `/support forms add-question`, and attach it to a panel with `form-name:` on `/support ticket panel`.',
            ],
        },
    ],
    notes: [
        'A member can have one open ticket per server at a time.',
        'Ticket numbers count up per server (#1, #2, ...) and are never reused. The welcome message, `{number}` in the channel name, the close log, the rating DM and the transcript all show the same number.',
        'The dashboard has six panel templates to start from.',
        'A transcript link opens only for the member who opened the ticket and the server\'s admins, after they log in. Closed tickets and their transcripts are deleted a year after the ticket closed, and closed modmail conversations a year after they closed. Open ones are kept.',
    ],
    related: ['moderation', 'privacy', 'raid-protection'],
};
