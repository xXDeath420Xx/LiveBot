// Screenshots for the custom-commands guide. Formats copied from: core/custom-command-handler.js (handleCustomPrefixCommand:
// a plain reply to the member's message), core/custom-command-vars.js ({sender}, {db:incr:…}), core/auto-response-manager.js
// (text reply, {user} and {#channel} variables), dashboard/routes/api/features/custom-commands.js (GET /templates, /reference).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function ({ manage, discord, ctx, demo }) {
    const { role, channel, channels, member: M } = demo;
    const imp = (rel) => import(pathToFileURL(path.join(ctx.root, rel)).href);
    const [tpl, vars] = await Promise.all([imp('core/custom-command-templates.js'), imp('core/custom-command-vars.js')]);

    // The page loads its templates and the Variables / API reference after rendering. The variable list's
    // sample values (names and ids) are swapped for Maple Hollow ones: the screenshot shows nothing real.
    const sample = (text) => String(text)
        .replace(/\b\d{17,20}\b/g, (n) => (/^3/.test(n) ? M.juniper.id : n.endsWith('999') ? demo.guild.id : channel.general.id))
        .replace(/deathdealer/g, M.juniper.username).replace(/@Death\b/g, `@${M.juniper.displayName}`).replace(/^Death$/, M.juniper.displayName)
        .replace(/Northwind Gaming/g, demo.guild.name).replace(/Kestrel/g, M.wren.displayName.split(' ')[0]);
    const variables = vars.TEMPLATE_VARIABLES.map((v) => ({ ...v, example: v.example == null ? v.example : sample(v.example) }));
    ctx.stub(/^\/api\/guilds\/\d+\/custom-commands\/templates$/, () => ({
        success: true, templates: tpl.TEMPLATES, categories: tpl.templateCategories(), variables,
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/custom-commands\/reference$/, () => ({
        success: true,
        variables,
        aliases: vars.ALIAS_VARIABLES,
        limits: { maxApiCalls: vars.MAX_API_CALLS, apiOutputMax: vars.API_OUTPUT_MAX, timeoutSeconds: 5, ...vars.RATE_LIMITS },
        storage: { maxOps: vars.MAX_DB_OPS, keyMax: vars.DB_KEY_MAX, valueMax: vars.DB_VALUE_MAX, incrMax: vars.DB_INCR_MAX,
            userKeys: vars.DB_USER_KEYS, serverKeys: vars.DB_SERVER_KEYS, retainDays: 400 },
    }));

    const ids = (list) => JSON.stringify(list);
    manage('custom-commands-page', 'custom-commands', {
        customCommands: [
            { id: 1, command_name: 'cookie', response: '{sender} has {db:incr:cookies} cookies', action_type: 'reply', action_content: null, required_roles: null, allowed_channels: ids([channel['bot-commands'].id]), use_count: 412 },
            { id: 2, command_name: 'artist', response: '', action_type: 'add_role', action_content: role.artists.id, required_roles: ids([role.verified.id]), allowed_channels: null, use_count: 57 },
            { id: 3, command_name: 'dadjoke-for', response: '{touser}, here is one for you: {api:https://icanhazdadjoke.com/}', action_type: 'reply', action_content: null, required_roles: null, allowed_channels: null, use_count: 138 },
            { id: 4, command_name: 'nodmads', response: '{user.mention}, please do not send members advertising in DMs. Report it to the moderators instead.', action_type: 'reply', action_content: null, required_roles: ids([role.moderators.id]), allowed_channels: null, use_count: 9 },
        ],
    }, {
        alt: 'The Custom commands page: 4 commands used 616 times in all, run with the ! prefix, the templates to start from and the Variables panel.',
        guides: ['custom-commands'],
    });

    // Chat: a custom command, then an auto-response (trigger "where do i get roles", match: contains).
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: 'CertiFried Utility', avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const person = (k, content, time) => ({ username: M[k].displayName, avatarUrl: ctx.av(k), bot: false, content, time });
    discord('custom-commands-discord', () => ({
        channel: 'bot-commands',
        ctx: {
            channels: channels.map((c) => ({ id: c.id, name: c.name })),
            roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
            users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
        },
        messages: [
            person('pip', '!cookie', 'Today at 7:41 PM'),
            bot({ content: `${M.pip.displayName} has 13 cookies`, time: 'Today at 7:41 PM' }),
            person('wren', 'where do i get roles?', 'Today at 7:44 PM'),
            bot({ content: `<@${M.wren.id}>, pick yours in <#${channel.roles.id}>. Click a button again to remove one.`, time: 'Today at 7:44 PM' }),
        ],
    }), {
        alt: 'Pip types !cookie and the bot answers "Pip Calloway has 13 cookies"; Wren asks where to get roles and an auto-response points to #roles.',
        guides: ['custom-commands'],
    });
}
