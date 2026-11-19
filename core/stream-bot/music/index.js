/*
 * Stream bot music (song requests through CertiFried's music pipeline). Design: docs/superpowers/specs/2026-11-19-stream-bot-design.md §7.
 *
 *   text.js      commands, reply texts, input parsing (pure)        settings.js  the Music page's settings (pure)
 *   store.js     SQL (migration 457 tables, stream rows of music_play_log)
 *   resolve.js   songs and audio through core/spotify-resolver.js and core/ytdlp-extractor.js (resolvers, bridge, prefetch)
 *   player.js    the queue and the OBS browser-source player, behind the VOD gate
 *   audio.js     overlay key, signed audio links, the audio proxy
 *   service.js   requests, approvals, bans, playlists, Studio's VOD status, replies
 *   commands.js  the chat commands                                  register.js  action, trigger and variables for the engine
 *   seed.js      the commands as automations                         privacy.js   /privacy export and delete
 *   spotify-direct.js  real Spotify audio from the streamer's go-librespot session (opt-in), MP3 through the same audio link
 *
 *   createMusic({ db, store, hub, ingest, encryption, logger, resolver?, signer?, prefix? })
 *     → { service, commands, mstore }   (core/stream-bot/index.js builds one and hands it to the engine through register.js)
 */
import { createMusicStore } from './store.js';
import { createResolver } from './resolve.js';
import { createSigner, defaultSecret } from './audio.js';
import { createMusicService } from './service.js';
import { createCommands } from './commands.js';
import { createSpotifyDirect } from './spotify-direct.js';

export function createMusic({ db, store, hub = null, ingest = null, encryption = null, logger = null, resolver = null, signer = null, direct = undefined, playLogTable = 'music_play_log', now = () => Date.now() } = {}) {
    const mstore = createMusicStore({ db, prefix: store.prefix, playLogTable });
    const service = createMusicService({
        db, store, mstore, hub, ingest, encryption, logger, now,
        resolver: resolver || createResolver({ logger }),
        signer: signer || createSigner({ secret: defaultSecret(), now }),
        direct: direct === undefined ? createSpotifyDirect({ logger, now }) : direct,
    });
    const commands = createCommands(service);
    return { service, commands, mstore, templateValues: service.templateValues };
}

export default { createMusic };
