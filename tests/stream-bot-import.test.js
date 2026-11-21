import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets, scanForSecrets, looksSecret, isSecretField } from '../core/stream-bot/import/secrets.js';
import { translateFirebot, translateStreamerbot, toChannelCommand, slugKey } from '../core/stream-bot/import/variables.js';
import { readZip, ImportError } from '../core/stream-bot/import/zip.js';
import { parseFirebot } from '../core/stream-bot/import/firebot.js';
import { parseStreamerbot, decodeImportString, voicePhrases } from '../core/stream-bot/import/streamerbot.js';
import { buildPlan } from '../core/stream-bot/import/mapper.js';
import { reportOf } from '../core/stream-bot/import/report.js';
import { readUpload } from '../core/stream-bot/import/index.js';
import { GAPS } from '../core/stream-bot/import/catalog.js';
import { FAKE, firebotFiles, firebotSetup, streamerbotFiles, streamerbotData, sbImportString, makeZip } from './fixtures/stream-bot-import.js';

/*
 * Stream bot import (core/stream-bot/import, design §6), without a database: secret stripping and the leak scan, the
 * variable translator, the ZIP reader, the Firebot and Streamer.bot parsers, the mapper's decisions and the upload
 * entry point. Fixtures are invented (tests/fixtures/stream-bot-import.js); the fake secrets in them have real shapes.
 */

const ctx = () => ({
    channels: [{ platform: 'twitch', platformUserId: '900000001' }, { platform: 'kick', platformUserId: '800000001' }],
    channelBots: [{ id: 11, platform: 'kick', channelId: '800000001' }, { id: 12, platform: 'twitch', channelId: '900000001' }],
    builtins: new Set(['so', 'lit']),
});
const noSecrets = (value, label) => {
    const text = JSON.stringify(value);
    for (const s of Object.values(FAKE)) assert.equal(text.includes(s), false, `${label}: a fake secret survived`);
    assert.deepEqual(scanForSecrets(value), [], `${label}: scan is clean`);
};

// ── secrets ─────────────────────────────────────────────────────────────────────────────────
test('secret stripping: credential fields and credential-shaped values go, ordinary text stays', () => {
    const input = {
        access_token: FAKE.oauth, refreshToken: FAKE.refresh, password: 'x', obs: { authPassword: 'hunter22' }, key: 'F1',
        accountId: 'abcdef0123456789abcdef01', message: `Bearer ${FAKE.refresh}`, note: FAKE.jwt, hook: FAKE.webhook,
        prompt: 'View it on Blerp - https://blerp.com/soundbites/60e64a568aeda0001416a7f8', title: 'Hydrate', guid: '2e0ed629-a0b5-4bc9-ba3a-7b88150dbf51',
        nested: [{ apiKey: 'abc' }, { text: 'Find us at https://maplehollow.example/links' }],
    };
    const { value, stripped } = stripSecrets(input);
    assert.equal(value.access_token, undefined);
    assert.equal(value.refreshToken, undefined);
    assert.equal(value.password, undefined);
    assert.equal(value.obs.authPassword, undefined);
    assert.equal(value.key, 'F1', 'a short hotkey key is kept');
    assert.equal(value.accountId, undefined, 'a long id-shaped account value goes');
    assert.equal(value.message, undefined);
    assert.equal(value.note, undefined);
    assert.equal(value.hook, undefined);
    assert.equal(value.title, 'Hydrate');
    assert.match(value.prompt, /blerp\.com/, 'a URL path is not a token');
    assert.equal(value.guid, input.guid, 'a GUID is not a token');
    assert.equal(value.nested[0].apiKey, undefined);
    assert.equal(value.nested[1].text, input.nested[1].text);
    assert.ok(stripped.fields >= 6 && stripped.values >= 3, JSON.stringify(stripped));
    assert.deepEqual(scanForSecrets(value), []);
    assert.ok(scanForSecrets(input).length >= 8, 'the scan sees the originals');
    assert.equal(looksSecret('Thanks for the follow!'), false);
    assert.equal(isSecretField('hotkey', 'Ctrl+F1'), false);
    assert.equal(isSecretField('webhookUrl', 'https://x'), true);
});

// ── variables ───────────────────────────────────────────────────────────────────────────────
test('Firebot variables become CertiFried tokens; unknown ones are listed and kept as written', () => {
    const r = translateFirebot('$user rolled $randomNumber[1,6] on $arg[2]: $count $streamTitle $readApi[https://api.example/x, data.text] $counter[Deaths] $allArgs', { counterKey: (n) => (n === 'Deaths' ? 'deaths' : null) });
    assert.equal(r.text, '{user.name} rolled {random:1-6} on {arg2}: $count {stream.title} {api.json:https://api.example/x|data.text} {sdb:get:deaths} {args}');
    assert.deepEqual(r.unsupported.sort(), ['$count']);
    assert.equal(translateFirebot('$arg[all] / $category / $uptime').text, '{args} / {stream.category} / {stream.uptime}');
    assert.equal(translateFirebot('$target').text, '{arg1}');
    assert.equal(translateFirebot('$target').changes.length, 1, '$target notes the @');
    assert.equal(translateFirebot('cost: $5 and $$').text, 'cost: $5 and $$', 'dollar amounts are left alone');
    assert.equal(translateFirebot('$counter[Unknown]').unsupported[0], '$counter');
});

test('Streamer.bot arguments become CertiFried tokens', () => {
    const r = translateStreamerbot('%user% gave %bits% bits: %rawInput% / %input0% %input2% %counter% 100%');
    assert.equal(r.text, '{user.name} gave {amount} bits: {args} / {arg1} {arg3} %counter% 100%');
    assert.deepEqual(r.unsupported, ['%counter%']);
});

test('channel command syntax: only when every token has an equivalent', () => {
    assert.deepEqual(toChannelCommand('Hi {user.name}, you said {args} in {channel.name}'), { ok: true, text: 'Hi {{username}}, you said {{args}} in {{channel_name}}' });
    assert.equal(toChannelCommand('Roll {random:1-6}').ok, false);
    assert.equal(toChannelCommand('{{username}} raw').ok, false, 'literal double braces are refused');
    assert.equal(slugKey('  Pokémon Catches! '), 'pokemon_catches');
});

// ── ZIP ─────────────────────────────────────────────────────────────────────────────────────
test('ZIP reader: reads in memory, skips programs and scripts unread, refuses unsafe archives', () => {
    const zip = makeZip([['Main/chat/commands.json', '{}'], ['Main/scripts/custom.js', 'console.log(1)'], ['Main/tool.dat', Buffer.from([0x4d, 0x5a, 0x90, 0])], ['../evil.json', '{}'], ['Main/notes.md', 'hi']]);
    const { files, skipped } = readZip(zip);
    assert.deepEqual([...files.keys()], ['Main/chat/commands.json']);
    const reasons = Object.fromEntries(skipped.map((s) => [s.path, s.reason]));
    assert.match(reasons['Main/scripts/custom.js'], /program or script/);
    assert.match(reasons['Main/tool.dat'], /program or script/, 'MZ bytes are caught whatever the name');
    assert.match(reasons['../evil.json'], /unsafe path/);
    assert.match(reasons['Main/notes.md'], /not a file/);
    assert.throws(() => readZip(Buffer.from('not a zip')), (e) => e instanceof ImportError && e.code === 'not_zip');
    const bomb = makeZip([['big.json', Buffer.alloc(5 * 1024 * 1024, 32)]]);
    assert.throws(() => readZip(bomb), (e) => e.code === 'ratio', 'a suspicious compression ratio is refused');
    assert.throws(() => readZip(makeZip([['a.json', '{}'], ['b.json', '{}']], { deflate: false }), { entries: 1 }), (e) => e.code === 'too_many');
});

// ── Firebot ─────────────────────────────────────────────────────────────────────────────────
test('Firebot profile: commands, events, timers, counters, rewards, moderation, OBS, viewers; no secrets', () => {
    const b = parseFirebot({ files: firebotFiles(), wantViewers: true });
    noSecrets(b, 'firebot bundle');
    assert.equal(b.commands.length, 6);
    const socials = b.commands.find((c) => c.name === '!socials');
    assert.deepEqual(socials.triggers, ['!socials', '!links']);
    assert.deepEqual(socials.actions, [{ type: 'chat.send', platform: 'event', text: 'Find {user.name} on maplehollow.example' }]);
    const death = b.commands.find((c) => c.name === '!death');
    assert.deepEqual(death.roles, ['broadcaster', 'moderator']);
    assert.deepEqual(death.actions[0], { type: 'variable.increment', scope: 'channel', key: 'deaths', by: 1 });
    assert.equal(death.actions[1].text, 'Deaths: {sdb:get:deaths}');
    const alert = b.commands.find((c) => c.name === '!alert');
    assert.equal(alert.enabled, false);
    assert.deepEqual(alert.actions.map((a) => a.type), ['sound.play', 'webhook.post']);
    assert.equal(alert.actions[0].sound, 'airhorn');
    assert.equal(alert.actions[0].volume, 70);
    assert.ok(alert.gaps.some((g) => g.gap === 'discord.webhook'));
    assert.deepEqual(b.media.map((m) => m.kind).sort(), ['image', 'sound']);
    assert.equal(b.automations.length, 5, 'the counter effect, three events (viewer-arrived has no trigger) and the reward');
    assert.equal(b.dropped[0].gap, 'trigger.viewer_arrived');
    const spam = b.automations.find((a) => a.name === 'Spam words');
    assert.deepEqual(spam.trigger.config.match, { mode: 'regex', text: '(cheap viewers|buy followers)', caseSensitive: false }, '"any of" text filters became one pattern');
    const follow = b.automations.find((a) => a.name === 'Scene sounds');
    assert.deepEqual(follow.actions.map((a) => a.type), ['obs.scene', 'random', 'overlay.media']);
    // Phase 3 overlays (design doc §9.9): an image becomes overlay.media named like the media library names it
    assert.deepEqual(follow.actions[2], { type: 'overlay.media', overlay: '', media: 'leaf', position: 'top-right', size: 'small', durationMs: 4000, volume: 80, animation: 'pop', queueSeconds: 120 });
    assert.ok(follow.notes.some((n) => /Upload the image as "leaf" under Overlays → Images and videos/.test(n)));
    // show text: HTML stripped, counter to {sdb:get:…}, font 80px → large, custom position → centre, a timer shows it for a minute
    const display = b.timers.find((t) => t.name === 'Deaths display');
    assert.deepEqual(display.actions, [{ type: 'overlay.text', overlay: '', text: 'Deaths: {sdb:get:deaths}', position: 'center', size: 'large', durationMs: 60000, animation: 'fade', queueSeconds: 120 }]);
    assert.ok(display.notes.some((n) => /every 1.1 seconds/.test(n)));
    assert.equal(b.timers.length, 3);
    assert.deepEqual(b.counters, [{ sourceId: 'k1', name: 'Deaths', key: 'deaths', value: 7, min: null, max: null, gaps: [] }]);
    assert.deepEqual(b.rewards.map((r) => [r.kind, r.title]), [['channel_points', 'Hydrate'], ['power_up', 'Confetti']]);
    assert.equal(b.automations.find((a) => a.kind === 'reward').trigger.conditions[0].value, 'r1');
    assert.deepEqual(b.moderation.bannedWords, ['mapleword']);
    assert.deepEqual(b.obs, { host: '127.0.0.1', port: 4455 });
    assert.deepEqual(b.integrations.map((i) => i.service).sort(), ['obs', 'streamelements']);
    assert.equal(b.viewers.count, 2);
    assert.equal(b.viewers.rows[0].watchMinutes, 1200);
    assert.ok(b.stripped.fields >= 2, 'the OBS password and the account id were stripped');
});

test('Firebot setup file', () => {
    const b = parseFirebot({ setup: firebotSetup() });
    assert.equal(b.format, 'setup');
    assert.equal(b.version, '5.67.0');
    assert.deepEqual(b.commands.map((c) => c.name), ['!socials']);
});

// ── Streamer.bot ────────────────────────────────────────────────────────────────────────────
test('Streamer.bot data folder: voice commands, commands, code refused, random groups, rewards, OBS; no secrets', () => {
    const b = parseStreamerbot({ files: streamerbotFiles() });
    noSecrets(b, 'streamer.bot bundle');
    const voice = b.automations.find((a) => a.kind === 'speech');
    // Streamer.bot speech commands become CertiFried Studio voice commands (voice.phrase, Studio 0.2.4).
    assert.equal(voice.trigger.type, 'voice.phrase');
    assert.deepEqual(voice.trigger.config, { phrases: ['Lets play a game'] });
    assert.deepEqual(voice.trigger.conditions, []);
    assert.equal(voice.gaps.some((g) => g.gap === 'trigger.speech'), false);
    // 413 SlobsSourceMuteState and 42 ObsSourceMuteState (0 Muted, 1 Not muted), 401 SlobsSourceVisibility (1 Hidden):
    // names and numbers from Streamer.bot's own sub-action enum (core/stream-bot/import/streamerbot-types.js).
    assert.deepEqual(voice.actions, [{ type: 'obs.scene', scene: 'Gaming' }, { type: 'obs.mute', input: 'Mic', state: 'unmute' },
        { type: 'obs.mute', input: 'Discord', state: 'mute' }, { type: 'obs.source', scene: 'Gaming', source: 'Cam', visible: 'hide' }]);
    assert.ok(voice.notes.some((n) => /Streamlabs Desktop step became an OBS step/.test(n)));
    const lurk = b.commands.find((c) => c.name === '!lurk');
    assert.deepEqual(lurk.triggers, ['!lurk', '!afk']);
    assert.equal(lurk.actions[0].text, '{user.name} is lurking');
    const song = b.commands.find((c) => c.name === '!song');
    assert.deepEqual(song.actions, []);
    assert.equal(song.gaps[0].gap, 'code');
    assert.ok(!JSON.stringify(b).includes('TVqQ'), 'compiled code is not kept');
    const follow = b.automations.find((a) => a.name === 'Thanks follow');
    assert.equal(follow.trigger.type, 'follow');
    assert.equal(follow.actions[0].type, 'random');
    assert.equal(follow.actions[0].branches.length, 2);
    assert.ok(b.dropped.some((d) => d.gap === 'trigger.test'));
    const mystery = b.automations.find((a) => a.name === 'Mystery');
    assert.equal(mystery.trigger.type, 'redemption');
    assert.ok(mystery.gaps.some((g) => g.gap === 'unknown.effect' && /777/.test(g.detail)), 'an unknown sub-action keeps its number');
    assert.deepEqual(b.rewards.map((r) => r.title), ['Mystery box']);
    assert.equal(b.quotes.length, 1);
    assert.deepEqual(b.obs, { host: '127.0.0.1', port: 4455 });
    assert.ok(b.integrations.some((i) => i.service === 'websocket'));
    assert.equal(b.viewers.count, 1);
    assert.ok(b.skippedFiles.some((f) => f.path === 'globals.db'));
});

test('voice phrases: new lines and ; split, duplicates dropped, at most 20 of 100 characters', () => {
    const NL = String.fromCharCode(13, 10);
    assert.deepEqual(voicePhrases(`Lets play${NL}let us play; LETS PLAY ;  `), ['Lets play', 'let us play']);
    const many = Array.from({ length: 30 }, (_, i) => `phrase ${i} ${'x'.repeat(120)}`).join(NL);
    const out = voicePhrases(many);
    assert.equal(out.length, 20);
    assert.ok(out.every((p) => p.length <= 100));
    assert.deepEqual(voicePhrases(''), []);
});

test('Streamer.bot import string (SBAE + gzip) and plain export JSON', () => {
    const exp = { meta: { name: 'Maple pack' }, data: { actions: streamerbotData()['actions.json'].actions, commands: streamerbotData()['commands.json'].commands }, exportedFrom: '1.0.7' };
    const decoded = decodeImportString(sbImportString(exp));
    assert.equal(decoded.meta.name, 'Maple pack');
    const b = parseStreamerbot({ exported: decoded });
    assert.equal(b.format, 'export');
    assert.equal(b.version, '1.0.7');
    assert.ok(b.commands.some((c) => c.name === '!lurk'));
    assert.throws(() => decodeImportString('hello world!'), ImportError);
});

// ── mapper ──────────────────────────────────────────────────────────────────────────────────
test('mapper: plain replies go to channel commands, the rest to automations; built-ins and unsupported are reported', () => {
    const plan = buildPlan([parseFirebot({ files: firebotFiles() }), parseStreamerbot({ files: streamerbotFiles() })], ctx());
    const by = (name, source = 'firebot') => plan.items.find((i) => i.name === name && i.source === source);
    const socials = by('!socials');
    assert.equal(socials.target.system, 'channel_command');
    assert.deepEqual(socials.target.names, ['socials', 'links']);
    assert.equal(socials.target.response, 'Find {{username}} on maplehollow.example');
    assert.deepEqual(socials.target.channels.map((c) => c.id), [11, 12]);
    assert.equal(socials.status, 'changed', 'aliases are a change');
    assert.equal(by('!death').target.system, 'automation');
    assert.equal(by('!death').target.draft.enabled, false);
    assert.deepEqual(by('!death').target.draft.trigger_config.match, { mode: 'command', text: '!death', caseSensitive: false });
    const hug = by('!hug');
    assert.equal(hug.target.system, 'automation', 'VIP-only and {arg1} need an automation');
    assert.deepEqual(hug.target.draft.conditions, [{ type: 'role', roles: ['vip'], mode: 'any' }, { type: 'cooldown', scope: 'user', seconds: 10 }]);
    // Phase 4 actions (design doc §7.3): a clip command now imports.
    assert.deepEqual(by('!clip').target.draft.actions, [{ type: 'stream.clip' }, { type: 'chat.send', platform: 'event', text: 'Clipped!' }]);
    assert.equal(by('!so').status, 'skipped');
    assert.match(by('!so').why[0], /built-in !so/);
    assert.equal(by('!song', 'streamerbot').status, 'skipped');
    // "send !lurk to chat" became the lurk command's reply (a channel command), because the bot ignores itself
    const mystery = by('Mystery', 'streamerbot');
    assert.equal(mystery.target.draft.actions[0].text, '{user.name} is lurking');
    // Timers are stream bot timers now (design doc §7.6): Firebot timers post on Twitch, templates included.
    const t1 = by('Discord');
    assert.equal(t1.target.system, 'bot_timer');
    assert.deepEqual(t1.target.timer, { name: 'Discord', intervalMin: 15, onlyLive: false, minChatLines: 0, platforms: 'twitch', rotation: 'rotate', messages: ['Join the grove on Discord'], automationRef: null });
    assert.deepEqual(by('Dice').target.timer.messages, ['You rolled {random:1-6}']);
    // custom power-ups (Streamer.bot 496): matched by the power-up's id (EventSub custom_power_up.reward_id, 2026-11-20)
    const confetti = by('Confetti thanks', 'streamerbot');
    assert.equal(confetti.target.draft.trigger_type, 'bits.used');
    assert.equal(confetti.target.draft.trigger_config.bitsKind, 'custom_power_up');
    assert.deepEqual(confetti.target.draft.conditions, [{ type: 'metadata', path: 'powerUpId', op: 'eq', value: 'p1' }]);
    assert.ok(confetti.why.some((w) => /"Confetti" \(500 Bits\)/.test(w)));
    assert.deepEqual(confetti.target.draft.actions, [{ type: 'stream.announce', text: 'Confetti for {user.name}!', color: 'purple' }]);
    // counter update effects: "Counter or variable changed" on the counter's key
    const deaths = by('Counter Deaths changed');
    assert.equal(deaths.target.draft.trigger_type, 'variable.changed');
    assert.deepEqual(deaths.target.draft.trigger_config, { key: 'deaths', scope: 'channel' });
    assert.deepEqual(deaths.target.draft.actions, [{ type: 'stream.announce', text: 'Deaths: {sdb:get:deaths}', color: 'purple' }]);
    // Streamer.bot Spotify extension commands become the Music page's song request commands (design doc §8)
    const skip = by('!skip', 'streamerbot');
    assert.equal(skip.status, 'changed');
    assert.match(skip.why[0], /^Covered by song requests/);
    assert.equal(skip.target.trusted, true);
    assert.equal(skip.target.draft.name, 'Song requests: !skip');
    assert.equal(skip.target.draft.adoptByName, true);
    assert.equal(skip.target.draft.enabled, false);
    assert.deepEqual(skip.target.draft.actions, [{ type: 'music.command', command: 'skip', input: '', reply: 'yes' }]);
    assert.deepEqual(skip.target.draft.trigger_config.match, { mode: 'regex', text: '^(?:!skip|!next)(?:\\s|$)', caseSensitive: false });
    assert.match(by('[SPOTIFY & SB] [#] 1 - Authorization', 'streamerbot').why[0], /^Covered by song requests/, 'the extension\'s own actions are covered');
    assert.equal(plan.gaps.some((g) => g.key === 'spotify' || (g.key === 'code' && g.examples.some((e) => /SPOTIFY/.test(e)))), false, 'covered items count no gap');
    // a command whose work is C# code stays skipped, whatever else it does
    assert.equal(by('!song', 'streamerbot').status, 'skipped');
    assert.equal(by('Deaths').target.system, 'variable');
    assert.equal(by('Hydrate').target.system, 'reward_definition');
    for (const it of plan.items) if (it.target?.system === 'automation') assert.equal(it.target.draft.enabled, false, `${it.name} is off`);
    for (const g of plan.gaps) assert.ok(GAPS[g.key], `gap ${g.key} is in the catalogue`);
    const rep = reportOf(plan);
    assert.ok(rep.groups.as_is.length + rep.groups.changed.length > 5);
    assert.equal(rep.counts.commands.skipped, 2, '!so (built in) and !song (C# code)');
});

test('mapper: without a channel bot, plain replies become chat automations', () => {
    const plan = buildPlan([parseFirebot({ files: firebotFiles() })], { channels: [], channelBots: [], builtins: new Set() });
    const s = plan.items.find((i) => i.name === '!socials');
    assert.equal(s.target.system, 'automation');
    assert.deepEqual(s.target.draft.trigger_config.match, { mode: 'regex', text: '^(?:!socials|!links)(?:\\s|$)', caseSensitive: false });
    assert.equal(plan.items.find((i) => i.name === 'Discord').status, 'skipped', 'timers need a linked channel');
});

// ── upload entry point ──────────────────────────────────────────────────────────────────────
test('readUpload: profile zips, setup files and import strings; executables and credential files refused', async () => {
    const fbZip = makeZip([...firebotFiles()].map(([k, v]) => [k, v]), { prefix: 'Main/' });
    const a = await readUpload({ name: 'Main.zip', buffer: fbZip });
    assert.equal(a.kind, 'firebot-profile');
    assert.ok(a.skipped.some((s) => s.path === 'Main/auth-twitch.json' && /tokens/.test(s.reason)), 'the login file is dropped unread');
    noSecrets(a.bundle, 'firebot upload');
    const sbZip = makeZip([...streamerbotFiles()].map(([k, v]) => [k, v]), { prefix: 'data/' });
    const b = await readUpload({ name: 'data.zip', buffer: sbZip });
    assert.equal(b.kind, 'streamerbot-data');
    noSecrets(b.bundle, 'streamer.bot upload');
    const c = await readUpload({ name: 'pack.sb', buffer: Buffer.from(sbImportString({ data: { actions: [], commands: [] } })) });
    assert.equal(c.kind, 'streamerbot-export');
    const d = await readUpload({ name: 'maple.firebotsetup', buffer: Buffer.from(JSON.stringify(firebotSetup())) });
    assert.equal(d.kind, 'firebot-setup');
    await assert.rejects(readUpload({ name: 'x.exe', buffer: Buffer.from([0x4d, 0x5a, 1, 2, 3]) }), (e) => e.code === 'executable');
    await assert.rejects(readUpload({ name: 'x.zip', buffer: makeZip([['readme.json', '{}']]) }), (e) => e.code === 'unknown_zip');
    await assert.rejects(readUpload({ name: 'e', buffer: Buffer.alloc(0) }), (e) => e.code === 'empty');
});

// ── Phase 5: lights (core/stream-bot/import/lights.js) ──────────────────────────────────────
test('Firebot Hue and Elgato effects and Streamer.bot Lumia sub-actions become light steps on All lights, with a note to pick the light', async () => {
    const { convertEffects } = await import('../core/stream-bot/import/firebot.js');
    const { convertSubActions } = await import('../core/stream-bot/import/streamerbot.js');
    const { validateActions } = await import('../core/stream-bot/actions.js');
    const fb = convertEffects([
        { type: 'hue:control-light', lightId: '3', updateActivated: true, activationAction: 'on', updateBrightness: true, brightnessPercentage: '40%', updateColor: true, color: '#FF8800',
            triggerAlert: true, alertType: 'short', triggerEffectAnimation: true, effectAnimationType: 'colorloop', transitionType: 'slow' },
        { type: 'hue:control-light', lightId: '4', updateActivated: true, activationAction: 'off' },
        { type: 'hue:scenes', sceneId: 'Ab3xYz' },
        { type: 'elgato:key-lights', selectedLights: { 'Key Light Left': { light: { name: 'Key Light Left' }, options: { toggleType: 'enable', brightness: '30', temperature: '5600' } },
            'Key Light Right': { light: { name: 'Key Light Right' }, options: { toggleType: 'disable' } } } },
        { type: 'elgato:light-strips', selectedLights: { Strip: { light: { name: 'Strip' }, options: { color: 'rgb(0, 128, 255)', brightness: '80' } } } },
    ], {});
    assert.deepEqual(fb.actions.map((a) => a.type), ['light.set', 'light.flash', 'light.power', 'light.white', 'light.power', 'light.set']);
    assert.deepEqual(fb.actions[0], { type: 'light.set', device: '', color: '#ff8800', brightness: 40, durationMs: 0, queueSeconds: 120 });
    assert.deepEqual(fb.actions[1], { type: 'light.flash', device: '', color: '#ff8800', brightness: 40, times: 1, periodMs: 1000, mode: 'pulse', queueSeconds: 120 });
    assert.deepEqual(fb.actions[3], { type: 'light.white', device: '', kelvin: 5600, brightness: 30, durationMs: 0, queueSeconds: 120 });
    assert.equal(fb.actions[5].color, '#0080ff');
    assert.ok(fb.notes.some((n) => /Hue light 3/.test(n)) && fb.notes.some((n) => /Key Light Left/.test(n)), 'notes name the source lights');
    assert.deepEqual(fb.gaps.map((g) => g.gap).sort(), ['light.effect', 'light.hue_scene']);
    const v = validateActions(fb.actions);
    assert.equal(v.ok, true, v.errors.join('; '));

    const sb = convertSubActions([
        { type: 6002, index: 0, color: '#FF00FF00', brightness: 70, duration: 5 },
        { type: 6003, index: 1, brightness: 25 },
        { type: 6004, index: 2 },
        { type: 6001, index: 3, command: 'party mode' },
        { type: 6002, index: 4, color: 'not a colour' },
    ]);
    assert.deepEqual(sb.actions, [
        { type: 'light.set', device: '', color: '#00ff00', brightness: 70, durationMs: 5000, queueSeconds: 120 },
        { type: 'light.brightness', device: '', brightness: 25, durationMs: 0, queueSeconds: 120 },
    ]);
    assert.deepEqual(sb.gaps.map((g) => g.gap), ['lumia.default', 'lumia.command', 'lumia.command']);
    assert.ok(sb.gaps.every((g) => /Streamer\.bot sub-action LumiaStream/.test(g.detail)));
    assert.equal(validateActions(sb.actions).ok, true);
    for (const k of ['light.effect', 'light.hue_scene', 'lumia.command', 'lumia.default']) assert.ok(GAPS[k], k);
});

// Streamer.bot state numbers (2026-11-20). The owner's "Go Live" ({"type":33,"state":1}) reads "Start Streaming" in Streamer.bot's
// UI; the importer had it as Stop. Evidence for every number is in convertSubActions (core/stream-bot/import/streamerbot.js).
test('Streamer.bot "Go Live": message, clear chat, START streaming, scene START (type 33 state 1 is Start)', async () => {
    const { convertSubActions } = await import('../core/stream-bot/import/streamerbot.js');
    const { validateActions } = await import('../core/stream-bot/actions.js');
    const { attentionFor } = await import('../core/stream-bot/switchover.js');
    // The owner's sub-actions, in their order (listed out of order to check they are sorted by index).
    const out = convertSubActions([
        { type: 33, index: 2, state: 1, enabled: true },
        { type: 10, index: 0, text: '!reset', useBot: true, enabled: true },
        { type: 34, index: 3, sceneName: 'START', enabled: true },
        { type: 510, index: 1, enabled: true },
    ]);
    assert.deepEqual(out.actions, [
        { type: 'chat.send', platform: 'twitch', text: '!reset', _commandText: '!reset' },
        { type: 'chat.clear' },
        { type: 'obs.stream', state: 'start' },
        { type: 'obs.scene', scene: 'START' },
    ]);
    assert.deepEqual(out.gaps, []);
    assert.equal(out.notes.some((n) => /stop/i.test(n)), false, 'no "Stop streaming" note');
    const { _commandText, ...send } = out.actions[0];
    assert.equal(validateActions([send, ...out.actions.slice(1)]).ok, true);
    // Nothing about it holds it back at the switchover.
    assert.deepEqual(attentionFor({ actions: out.actions }, { notes: out.notes }), []);
});

test('Streamer.bot streaming state: 0 is Stop (held at the switchover), other numbers are not guessed', async () => {
    const { convertSubActions, SB_STREAMING } = await import('../core/stream-bot/import/streamerbot.js');
    const { attentionFor } = await import('../core/stream-bot/switchover.js');
    assert.deepEqual({ ...SB_STREAMING }, { 0: 'stop', 1: 'start' });
    const stop = convertSubActions([{ type: 33, index: 0, state: 0 }]);
    assert.deepEqual(stop.actions, [{ type: 'obs.stream', state: 'stop' }]);
    assert.ok(stop.notes.some((n) => /Stop streaming; check that is what you want/.test(n)));
    assert.ok(attentionFor({ actions: stop.actions }, { notes: stop.notes }).includes('It stops your stream.'));
    for (const state of [2, 7, undefined, 'x']) {
        const odd = convertSubActions([{ type: 33, index: 0, state }]);
        assert.deepEqual(odd.actions, [], `state ${state}`);
        assert.equal(odd.gaps.length, 1);
        assert.match(odd.gaps[0].detail, /ObsStreaming \(33\) \(state /);
    }
});

test('Streamer.bot source visibility: 0 show, 1 hide, 2 toggle ("Kill Counters" / "Lets Have Counters")', async () => {
    const { convertSubActions } = await import('../core/stream-bot/import/streamerbot.js');
    const kill = convertSubActions([{ type: 401, index: 0, sceneName: 'IN-GAME', sourceName: 'Firebot', state: 1, display: '' }]);
    const have = convertSubActions([{ type: 401, index: 0, sceneName: 'IN-GAME', sourceName: 'Firebot', state: 0, display: '' }]);
    const flip = convertSubActions([{ type: 30, index: 0, sceneName: 'IN-GAME', sourceName: 'Cam', state: 2 }]);
    assert.deepEqual(kill.actions, [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'hide' }]);
    assert.deepEqual(have.actions, [{ type: 'obs.source', scene: 'IN-GAME', source: 'Firebot', visible: 'show' }]);
    assert.deepEqual(flip.actions, [{ type: 'obs.source', scene: 'IN-GAME', source: 'Cam', visible: 'toggle' }]);
});

test('Streamer.bot mute: 0 mute, 1 unmute, 2 toggle ("I\'m HERE" unmutes with 1, the "Toggle" actions use 2)', async () => {
    const { convertSubActions } = await import('../core/stream-bot/import/streamerbot.js');
    const st = (type, state) => convertSubActions([{ type, index: 0, sceneName: 'IN-GAME', sourceName: 'Base Mic', state }]).actions[0]?.state;
    for (const type of [42, 413]) {
        assert.equal(st(type, 0), 'mute');
        assert.equal(st(type, 1), 'unmute');
        assert.equal(st(type, 2), 'toggle');
    }
});

test('Streamer.bot replay buffer: 0 start, 1 stop, 2 save; filters: 0 on, 1 off, 2 toggle; recording stays a gap', async () => {
    const { convertSubActions, SB_REPLAY } = await import('../core/stream-bot/import/streamerbot.js');
    const { validateActions } = await import('../core/stream-bot/actions.js');
    assert.deepEqual({ ...SB_REPLAY }, { 0: 'start', 1: 'stop', 2: 'save' });
    const rb = convertSubActions([0, 1, 2, 9].map((state, index) => ({ type: 321, index, state })));
    assert.deepEqual(rb.actions, [{ type: 'obs.replay', state: 'start' }, { type: 'obs.replay', state: 'stop' }, { type: 'obs.replay', state: 'save' }]);
    assert.equal(rb.gaps.length, 1, 'an unknown replay buffer state is not guessed');
    const f = convertSubActions([
        { type: 35, index: 0, sceneName: 'IN-GAME', sourceName: 'Cam', filterName: 'Blur', state: 0 },
        { type: 35, index: 1, sceneName: 'IN-GAME', sourceName: 'Cam', filterName: 'Blur', state: 1 },
        { type: 47, index: 2, sceneName: 'BRB', filterName: 'Fade', state: 2 },
        { type: 35, index: 3, sceneName: 'IN-GAME', state: 0 },
    ]);
    assert.deepEqual(f.actions, [
        { type: 'obs.filter', source: 'Cam', filter: 'Blur', state: 'enable' },
        { type: 'obs.filter', source: 'Cam', filter: 'Blur', state: 'disable' },
        { type: 'obs.filter', source: 'BRB', filter: 'Fade', state: 'toggle' },
    ]);
    assert.equal(f.gaps.length, 1, 'a filter step without source and filter names is a gap');
    assert.equal(validateActions([...rb.actions, ...f.actions]).ok, true);
    const rec = convertSubActions([{ type: 45, index: 0, state: 1 }, { type: 415, index: 1, state: 0 }]);
    assert.deepEqual(rec.actions, []);
    assert.deepEqual(rec.gaps.map((g) => g.gap), ['unknown.effect', 'unknown.effect']);
});
