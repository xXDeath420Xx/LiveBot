/*
 * The stream bot Import page (/stream/bot/import) filled with invented Maple Hollow data, for the theme audit
 * (scripts/theme-audit/pages.mjs) and tests/stream-bot-import-page.test.js. The preview is built by the real parser,
 * mapper and report code from the invented fixtures in tests/fixtures/stream-bot-import.js, so the page shows what a
 * real upload shows.
 *
 *   importPage(demo, { root }) -> Promise<{ template, locals }>
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const IMPORT_PAGE_ID = 'stream-bot-import';

export async function importPage(demo, { root }) {
    const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
    const [fx, fb, sbp, mapper, report, catalog] = await Promise.all([
        imp('tests/fixtures/stream-bot-import.js'), imp('core/stream-bot/import/firebot.js'), imp('core/stream-bot/import/streamerbot.js'),
        imp('core/stream-bot/import/mapper.js'), imp('core/stream-bot/import/report.js'), imp('core/stream-bot/import/catalog.js'),
    ]);
    const bundles = [fb.parseFirebot({ files: fx.firebotFiles(), wantViewers: true }), sbp.parseStreamerbot({ files: fx.streamerbotFiles() })];
    const ctx = {
        channels: [{ platform: 'twitch', platformUserId: '700000001' }, { platform: 'kick', platformUserId: '700000002' }],
        channelBots: [{ id: 1, platform: 'kick', channelId: '700000002' }, { id: 2, platform: 'twitch', channelId: '700000001' }], builtins: new Set(['so']),
    };
    const plan = mapper.buildPlan(bundles, ctx);
    const preview = {
        id: 'demo', files: { firebot: { name: 'Main.zip', kind: 'firebot-profile', skipped: [{ path: 'auth-twitch.json', reason: 'holds logins or tokens (not read)' }] },
            streamerbot: { name: 'data.zip', kind: 'streamerbot-data', skipped: [] } },
        stripped: { firebot: bundles[0].stripped, streamerbot: bundles[1].stripped }, report: report.reportOf(plan),
        viewers: { firebot: { count: bundles[0].viewers.count, fields: bundles[0].viewers.fields }, streamerbot: { count: bundles[1].viewers.count, fields: bundles[1].viewers.fields } },
    };
    const D = demo.D;
    return {
        template: 'stream-bot/import',
        locals: {
            active: 'import', pageTitle: 'Import', profile: { id: 7 },
            channels: [{ id: 1, platform: 'twitch', login: 'maplehollow_tv' }, { id: 2, platform: 'kick', login: 'maplehollow_kick' }],
            history: [{ id: 3, sources: 'firebot,streamerbot', fileNames: 'Main.zip, data.zip', categories: [], summary: { counts: { commands: { created: 4 }, automations: { created: 6 } } }, createdAt: D(2026, 11, 18, 21, 4) }],
            rewards: [
                { id: 21, title: 'Hydrate', kind: 'channel_points', cost: 300, costUnit: 'points', prompt: 'Drink water', enabled: true, createdBy: 'Firebot', recreated: null, source: 'firebot' },
                { id: 22, title: 'Confetti', kind: 'power_up', cost: 500, costUnit: 'bits', prompt: '', enabled: true, createdBy: 'Firebot', recreated: null, source: 'firebot' },
                { id: 23, title: 'Mystery box', kind: 'channel_points', cost: 1000, costUnit: 'points', prompt: 'Open it', enabled: true, createdBy: 'Streamer.bot', recreated: { id: 'x' }, source: 'streamerbot' },
            ],
            // A saved banned word list (H-742): pending on the Kick channel until the owner presses Apply.
            words: [{ id: 31, source: 'firebot', words: ['mapleword', 'spoilers', 'sap*'], wasOn: true, channels: [{ id: 1, channelId: '700000002', name: 'maplehollow_kick', pending: 3, applied: null }] }],
            categories: catalog.CATEGORIES, canRecreate: true, uploadMb: 20,
            importData: report.pageJson({ preview, categories: catalog.CATEGORIES }),
        },
    };
}

/** The stream bot's Twitch commands page (/stream/bot/commands/:channelId) with invented Maple Hollow data. */
export const CHANNEL_COMMANDS_PAGE_ID = 'stream-bot-channel-commands';
export function channelCommandsPage() {
    const imported = 'Imported from Firebot';
    return {
        template: 'stream-bot/channel-commands',
        locals: {
            active: 'commands', pageTitle: 'Commands for maplehollow_tv', bots: [],
            channel: { id: 2, channel_id: '700000001', channel_name: 'maplehollow_tv', platform: 'twitch', features_enabled: '{"commands":false}' },
            commands: [
                { command_key: 'so', default_aliases: null, description: 'Shout out another streamer', category: 'community', cooldown_default: 30, mod_only: 1 },
                { command_key: 'trivia', default_aliases: null, description: 'Start a trivia round', category: 'games', cooldown_default: 60, mod_only: 0 },
            ],
            channelCommands: [{ command_key: 'trivia', is_enabled: 0, custom_aliases: null, custom_response: null, cooldown_override: null, mod_only: 0 }],
            customCommands: [
                { id: 31, command_name: 'lurk', response: '{{username}} is lurking in the grove', cooldown: 0, mod_only: 0, is_enabled: 0, use_count: 0, created_by: imported },
                { id: 32, command_name: 'socials', response: 'Find us at maplehollow.example', cooldown: 30, mod_only: 0, is_enabled: 0, use_count: 0, created_by: imported },
                { id: 33, command_name: 'rules', response: 'Be kind to the trees.', cooldown: 5, mod_only: 1, is_enabled: 1, use_count: 12, created_by: 'Juniper' },
            ],
        },
    };
}
