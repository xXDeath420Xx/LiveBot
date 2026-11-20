// Checked against: commands/admin/todo.js, core/todo-limits.js, dashboard/routes/api/features/todo.js,
// dashboard/views/partials/manage/todo.ejs, docs/command-split-2026-11-18.md (todo is a slash command), core/manage-nav.js.
export default {
    slug: 'task-lists',
    title: 'Task lists',
    area: 'tools',
    summary: 'A checklist the bot posts in a channel and edits as tasks are added and ticked off.',
    result: {
        image: 'task-lists-discord',
        caption: 'A task list in Discord: open tasks show an hourglass, finished ones are ticked and crossed out.',
    },
    before: [
        'On the dashboard you need **Manage Server**: open **Tickets, forms & support**, then **Task lists**. In Discord, `/todo` needs **Manage Messages**, so other members can read a list but not change it.',
    ],
    steps: [
        {
            title: 'Create a list',
            text: [
                'Under **New task list**, enter a **Title** (it is "Task List" if you leave it empty), pick the **Channel** and press **Create list**. The bot posts the list there straight away. Each channel can have one list.',
                'In Discord, run `/todo create` in the channel you want it in.',
            ],
            command: '/todo create title:Movie night prep',
        },
        {
            title: 'Add tasks',
            text: [
                'Under **Your lists**, type in **Add a task** and press **Add**, or use `/todo add` in the list\'s channel. A task can be up to 200 characters and a list holds up to 50 tasks.',
            ],
            command: '/todo add task:Pick the film',
            image: 'task-lists-page',
        },
        {
            title: 'Tick tasks off',
            text: [
                'On the page, point at a task to show its **Complete**, **Undo** and **Remove** buttons. In Discord, `/todo done`, `/todo undo` and `/todo remove` take the task\'s number on the list. Removing a task moves the ones below it up a number.',
                'The list is amber while anything is open and turns green when everything is done. Its footer counts them, for example "3/5 completed".',
            ],
            command: '/todo done number:2',
        },
        {
            title: 'Tidy up or delete the list',
            text: [
                '`/todo clear` deletes every finished task. **Delete list** on the page, or `/todo reset` in the channel, deletes the list and its message.',
            ],
        },
    ],
    notes: [
        'Every `/todo` command works on the list in the channel you use it in.',
        'If the list message is deleted, the bot posts a new one the next time the list changes.',
        'Clearing all finished tasks at once is only in Discord; the page removes them one by one.',
        'A list title can be up to 256 characters.',
    ],
    related: ['reminders-utilities', 'support-tickets', 'announcements'],
};
