// Diagnostic: resolve a Spotify playlist exactly how the bot does (Player.search with
// YtDlp + Spotify extractors) and report what each track resolves to + what it bridges
// to on YouTube. REST/subprocess only — no gateway login, safe alongside PM2.
//
//   node scripts/diag-spotify-playlist.mjs "<spotify playlist url>"

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { Player } from 'discord-player';

const URL = process.argv[2] || 'https://open.spotify.com/playlist/5GGmxpd0eZqWXtvXdyjMbg';

const client = new Client({ intents: [GatewayIntentBits.Guilds] }); // never .login()
const player = new Player(client, {});

const { YtDlpExtractor } = await import('../core/ytdlp-extractor.js');
await player.extractors.register(YtDlpExtractor, {});
const { SpotifyExtractor } = await import('@discord-player/extractor');
await player.extractors.register(SpotifyExtractor, {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

console.log('Registered extractors:', [...player.extractors.store.keys()].join(', '));
console.log('Searching:', URL, '\n');

const res = await player.search(URL, {});
console.log('hasTracks:', res.hasTracks(), '| total tracks:', res.tracks.length);
console.log('playlist?:', res.playlist ? `"${res.playlist.title}" (${res.playlist.tracks?.length} tracks, type=${res.playlist.type})` : 'NONE');
console.log('resolved by extractor:', res.extractor?.identifier || '(none)');
console.log('');

const sample = res.tracks.slice(0, 6);
for (const [i, t] of sample.entries()) {
    console.log(`#${i + 1} ${t.title} — ${t.author}`);
    console.log(`    track.url    : ${t.url}`);
    console.log(`    source       : ${t.source} | extractor: ${t.extractor?.identifier || '?'} | durMS: ${t.durationMS}`);
    console.log(`    raw.source   : ${t.raw?.source || ''} | bridgedUrl: ${t.bridgedUrl || t.metadata?.bridge?.url || '(not bridged yet)'}`);
}

// Now actually bridge the first track the way playback does, to see the YouTube target.
if (sample.length) {
    const first = sample[0];
    console.log(`\n--- Bridging #1 "${first.title}" to a playable source ---`);
    try {
        const ytExt = player.extractors.store.get(YtDlpExtractor.identifier);
        const bridged = await ytExt.bridge(first, first.extractor);
        console.log('    bridge() returned:', bridged ? (typeof bridged === 'string' ? bridged : JSON.stringify(bridged).slice(0, 200)) : 'NULL');
    } catch (e) {
        console.log('    bridge() threw:', e.message);
    }
}

process.exit(0);
