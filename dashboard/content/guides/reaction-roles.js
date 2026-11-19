// Checked against: core/reaction-role-manager.js (panel message, clicks), core/reaction-role-bulk.js (limits),
// commands/community/manage.js (roles group), dashboard/views/partials/manage/reaction-roles.ejs.
export default {
    slug: 'reaction-roles',
    title: 'Reaction roles',
    area: 'community',
    summary: 'Post a panel where members pick their own roles with buttons, a dropdown or emoji reactions.',
    result: {
        image: 'reaction-roles-discord',
        caption: 'A button panel, and the private reply a member gets after picking a role.',
    },
    before: [
        'You need **Manage Server**, and the bot needs **Manage Roles** with its own role above every role on the panel.',
    ],
    steps: [
        {
            title: 'Create a panel',
            text: [
                'On the dashboard, open **Roles**, then **Reaction roles**, and select **Create panel**. Start from a template (Blank, Name colours, Pronouns, Notifications or Regions) or from scratch.',
                'Give it a **Panel name** (the heading members see), the **Channel**, **Embed text** and an **Embed colour**.',
            ],
            command: '/manage roles create-panel channel:#roles name:Pick your roles type:button mode:normal',
            image: 'reaction-roles-page',
        },
        {
            title: 'Choose how members pick',
            text: [
                '**How members pick** is Buttons, Dropdown menu or Reactions (emoji). **Panel mode** is Several roles, or One role at a time, where picking a new role removes the previous one.',
            ],
        },
        {
            title: 'Add the roles',
            text: [
                'For each role, set the **Emoji**, the **Role** and the **Button text**, and for buttons a **Button colour**. **Add several at once** fills in a list in one go.',
            ],
        },
        {
            title: 'Post it',
            text: [
                'Once the panel has at least one role, select **Post to Discord**. The panel list then marks it Posted. **Repost** replaces the message with a fresh copy, for example after you change the roles.',
                'Members select a button to get the role and select it again to remove it; the bot answers privately each time.',
            ],
        },
    ],
    notes: [
        'A panel holds up to 25 buttons, 25 dropdown options or 20 reactions.',
        'A dropdown works like the buttons: picking a role you do not have adds it, and picking one you already have removes it. The menu clears after each pick. In One role at a time mode, picking your current role drops it.',
        'To add a role to a panel from Discord: `/manage roles add-role message-id:<panel message ID> role:@Artists emoji:🎨`.',
    ],
    related: ['welcome', 'levels', 'go-live-alerts'],
};
