// Screenshots for the task-lists guide. Formats copied from: commands/admin/todo.js (buildTodoEmbed: amber 0xFBBF24
// while tasks are open, "1. ✅ ~~task~~" lines, "n/m completed" footer, and the "Marked task #n as complete ✅"
// reply). The page is dashboard/views/partials/manage/todo.ejs, which loads GET /api/guilds/:id/todo
// (dashboard/routes/api/features/todo.js) after rendering; that answer is stubbed below.
export default async function ({ manage, discord, ctx, demo }) {
    const { guild, channel, channels, member: M } = demo;
    // An invented channel for the list (fake id range).
    const movieNight = { id: '100400000000000071', name: 'movie-night' };
    const ctxNames = {
        channels: [...channels, movieNight].map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const origin = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: 'CertiFried Utility', avatarUrl: `${origin()}/images/CertiFried.png`, ...extra });

    const tasks = [
        ['Pick the film', 1], ['Book the Campfire voice channel', 1], [`Post the start time in <#${channel.announcements.id}>`, 0],
        ['Make the watch-party playlist', 0], ['Remind everyone an hour before', 0],
    ];
    discord('task-lists-discord', () => ({
        channel: movieNight.name, ctx: ctxNames,
        messages: [
            bot({
                embeds: [{
                    color: '#FBBF24', title: 'Movie night prep', timestamp: true,
                    description: tasks.map(([t, done], i) => `${i + 1}. ${done ? '✅' : '⏳'} ${done ? `~~${t}~~` : t}`).join('\n'),
                    footer: `${tasks.filter(([, d]) => d).length}/${tasks.length} completed`,
                }],
            }),
            bot({ usedBy: { name: M.juniper.displayName, command: '/todo done' }, ephemeral: true, time: 'Today at 7:44 PM', content: 'Marked task #2 as complete ✅' }),
        ],
    }), {
        alt: 'A task list called Movie night prep with five tasks, two ticked and crossed out, "2/5 completed", and the private reply to /todo done.',
        guides: ['task-lists'],
    });

    ctx.stub(/^\/api\/guilds\/\d+\/todo$/, () => ({
        success: true,
        lists: [
            { id: 7, guild_id: guild.id, channel_id: movieNight.id, channel_name: movieNight.name, title: 'Movie night prep',
                items: tasks.map(([t, done], i) => ({ id: 70 + i, task: t.replace(/<#\d+>/, '#announcements'), completed: done, position: i + 1 })) },
            { id: 6, guild_id: guild.id, channel_id: channel['mod-log'].id, channel_name: 'mod-log', title: 'Server clean-up',
                items: [['Archive the old event channels', 1], ['Merge the two art channels', 0], ['Check the bot permissions', 0]]
                    .map(([t, done], i) => ({ id: 60 + i, task: t, completed: done, position: i + 1 })) },
        ],
    }));
    manage('task-lists-page', 'todo', {}, {
        alt: 'The Task lists page: the form for a new list, then the Movie night prep list with two of its five tasks done and buttons to undo, tick or remove each.',
        guides: ['task-lists'], height: 900, scrollTo: '#todo-new-title',
    });
}
