#!/usr/bin/env node
/*
 * Re-run the owner's Firebot + Streamer.bot import from the sanitized bundle kept on the server
 * (docs/superpowers/specs/2026-11-19-stream-bot-design.md §6.6).
 *
 *   node scripts/stream-bot-import-owner.mjs [--dry-run] [--bundle <file>] [--owner <discord id>] [--only cat,cat] [--json]
 *                                            [--link source:kind:sourceId=automationId ...]
 *                                            [--viewers-firebot <users.db>] [--viewers-streamerbot <users.dat>]
 *
 * The bundle was parsed on the owner's PC, stripped of credentials and scanned clean before it was copied here
 * (default STREAM_BOT_IMPORT_DIR/owner-<discord id>.json, outside git, mode 600). It is scanned again before use.
 * Everything is created switched off; items already imported are left alone (stream_bot_import_items), so this is
 * safe to run again after new action types or triggers land: items the mapper now supports are filled in, nothing
 * is created twice. No chat, OBS or Twitch calls are made.
 *
 * Viewer stats (H-747): the bundle holds no viewer rows. --viewers-firebot / --viewers-streamerbot read Firebot's db/users.db and
 * Streamer.bot's users.dat (copied from the owner's PC, mode 600, outside git; delete them afterwards), parse them with the
 * importer's own parsers, scan them, and import them into Viewers with the category viewers (the owner approved this on
 * 2026-11-19). Importing again replaces what the last import added (core/stream-bot/viewers/store.js importRows).
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { createStore } from '../core/stream-bot/store.js';
import { createImportStore, applyPlan } from '../core/stream-bot/import/apply.js';
import { buildPlan } from '../core/stream-bot/import/mapper.js';
import { reportOf } from '../core/stream-bot/import/report.js';
import { scanForSecrets } from '../core/stream-bot/import/secrets.js';
import { channelBuiltins } from '../core/stream-bot/import/index.js';
import { CATEGORIES } from '../core/stream-bot/import/catalog.js';
import { parseFirebot } from '../core/stream-bot/import/firebot.js';
import { parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OWNER = opt('owner', '365905620060340224');
const DIR = process.env.STREAM_BOT_IMPORT_DIR || '/home/death/certifried-data/stream-bot-import';
const FILE = opt('bundle', path.join(DIR, `owner-${OWNER}.json`));
const DRY = args.includes('--dry-run');
const ONLY = opt('only') ? opt('only').split(',') : CATEGORIES.map((c) => c.key).filter((k) => k !== 'viewers');
const VIEWERS_FB = opt('viewers-firebot');
const VIEWERS_SB = opt('viewers-streamerbot');

async function main() {
    const { bundles } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const b of bundles) { if (b.viewers) b.viewers.rows = []; }
    // Viewer files given: their bundles replace the (empty) viewer part of the saved bundle.
    const viewerBundles = [];
    if (VIEWERS_FB) viewerBundles.push(parseFirebot({ files: new Map([['db/users.db', fs.readFileSync(VIEWERS_FB)]]), wantViewers: true }));
    if (VIEWERS_SB) viewerBundles.push(parseStreamerbot({ files: new Map([['users.dat', fs.readFileSync(VIEWERS_SB)]]), wantViewers: true }));
    if (viewerBundles.length) {
        for (const b of bundles) delete b.viewers;
        for (const vb of viewerBundles) {
            if (scanForSecrets(vb).length) throw new Error(`the ${vb.source} viewer file scans as holding credential-shaped values; refusing`);
            console.log(`${vb.source}: ${vb.viewers?.count || 0} viewers in the file, ${vb.viewers?.rows?.length || 0} rows to import`);
            bundles.push(vb);   // only users.db / users.dat were given, so the bundle holds viewers and nothing else
        }
    }
    const leaks = scanForSecrets(bundles);
    if (leaks.length) throw new Error(`the bundle scans as holding ${leaks.length} credential-shaped values; refusing`);
    const store = createStore({ db: pool, encryption });
    const profile = await store.getProfileByOwner(OWNER);
    if (!profile) throw new Error(`no stream bot profile for ${OWNER}`);
    const importStore = createImportStore({ db: pool, prefix: store.prefix });
    const channels = (await store.listChannels(profile.id)).map((c) => ({ platform: c.platform, platformUserId: c.platform_user_id, login: c.login }));
    const channelBots = await importStore.channelBotsFor(channels);
    // --link source:kind:sourceId=automationId (repeatable): an automation built by hand for that source item. It is
    // recorded as the item's target with `keep`, so imports never create a second one and never overwrite it.
    const links = args.flatMap((a, i) => (a === '--link' ? [args[i + 1]] : [])).filter(Boolean);
    for (const l of links) {
        const m = String(l).match(/^(firebot|streamerbot):([a-z_]{1,24}):([^=]{1,191})=(\d{1,15})$/);
        if (!m) throw new Error(`bad --link ${l}`);
        const auto = await store.getAutomation(profile.id, Number(m[4]));
        if (!auto) throw new Error(`automation ${m[4]} is not in profile ${profile.id}`);
        if (!DRY) await importStore.upsertItem(profile.id, { importId: null, source: m[1], kind: m[2], sourceId: m[3], name: auto.name, status: 'changed', targetKind: 'automation', targetRef: `automation:${auto.id}`, data: { keep: true, linkedBy: 'hand' } });
        console.log(`${DRY ? 'would link' : 'linked'} ${m[1]}:${m[2]}:${m[3]} -> automation ${auto.id} (${auto.name})`);
    }
    const plan = buildPlan(bundles, { channels, channelBots, builtins: await channelBuiltins(pool), wantViewers: viewerBundles.length > 0 && ONLY.includes('viewers') });
    const pages = new Map(channelBots.map((c) => [c.id, c.platform === 'kick' ? `/kick/channel/${encodeURIComponent(c.channelId)}/commands` : `/stream/bot/commands/${encodeURIComponent(c.channelId)}`]));
    if (DRY) {
        const r = reportOf(plan, { categories: ONLY });
        if (args.includes('--json')) console.log(JSON.stringify(r, null, 1));
        else console.log(JSON.stringify({ profileId: profile.id, channels: channels.map((c) => `${c.platform}:${c.login}`), channelBots: channelBots.map((c) => `${c.platform}#${c.id}`), counts: r.counts }, null, 1));
        return;
    }
    const out = await applyPlan({ store, importStore, profileId: profile.id, plan, categories: ONLY,
        meta: { sources: bundles.map((b) => b.source).join(','), fileNames: 'owner PC (Firebot profile Main, Streamer.bot data)' }, channelPageHref: (c) => pages.get(c.id) || null });
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
    else console.log(JSON.stringify({ profileId: profile.id, importId: out.importId, counts: out.counts, failed: out.results.filter((r) => r.result === 'failed') }, null, 1));
}

main().catch((err) => { console.error(`[stream-bot-import-owner] ${err.message}`); process.exitCode = 1; }).finally(() => pool.end().catch(() => {}));
