/*
 * Stream bot import: what CertiFried cannot do yet, by source feature, with the phase that should build it
 * (design doc §1 and §6). The parsers tag every effect, sub-action, trigger, variable and integration they could
 * not map with one of these keys; the report counts them and the design doc's "Parity gaps" list is built from
 * the same keys.
 *
 * Phases: 2b = CertiFried Studio additions; 3 = overlays and alerts; 4 = chat and stream management on the
 * engine; 5 = lights; 6 = YouTube and the rest; never = will not be built (running a streamer's own code); done = built
 * since the gap was found (kept so older reports still have a label); importer = the engine can do it, the importer
 * does not map it yet.
 */

const g = (label, phase, why = '') => Object.freeze({ label, phase, why });

export const GAPS = Object.freeze({
    // ── effects / sub-actions ──
    'overlay.image': g('Show an image on stream', 'done', 'Imported as Show an image or video on stream (overlay.media); upload the file under Overlays, Images and videos (design doc section 9.9).'),
    'overlay.text': g('Show text on stream', 'done', 'Imported as Show text on stream (overlay.text) on your default overlay (design doc section 9.9).'),
    'overlay.video': g('Play a video on stream', 'done', 'Imported as Show an image or video on stream (overlay.media); upload the file under Overlays, Images and videos.'),
    'overlay.html': g('Show custom HTML on stream', '3', 'Overlays (browser sources) arrive in Phase 3.'),
    'chat.announcement': g('Chat announcement (highlighted message)', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'chat.whisper': g('Whisper a viewer', '4', 'Twitch whispers need their own scope and send path.'),
    'chat.slash': g('Chat moderation command typed as a message (/clear, /ban, /timeout …)', '4', 'Twitch no longer runs slash commands sent by bots; they need the moderation API.'),
    'chat.clear': g('Clear chat', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'chat.delete': g('Delete a chat message', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'mod.timeout': g('Time out or ban a viewer', '4', 'Needs the moderation API.'),
    'stream.clip': g('Create a clip', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'stream.title': g('Change the stream title', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'stream.category': g('Change the stream category', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'stream.shoutout': g('Twitch shoutout', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'stream.raid': g('Start a raid', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'stream.ad': g('Run an ad', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'counter.effects': g('Effects that run when a counter changes', 'done', 'Update effects map to "Counter or variable changed" (design doc section 7.5); effects at a maximum or minimum still have no trigger.'),
    'flow.conditional': g('If / else inside an action list', 'importer', 'The engine has If / then / otherwise (design doc section 7.3); the importer does not translate Firebot or Streamer.bot conditions into it yet.'),
    'flow.sequential': g('Sequential effect (next item each run)', '4', 'Only random choice exists.'),
    'flow.queue': g('Effect queues', '4', 'Runs are not queued per automation.'),
    'web.request': g('HTTP request other than an HTTPS POST', '4', 'The webhook action only sends an HTTPS POST to an allow-listed host.'),
    'discord.webhook': g('Post through a Discord webhook URL', '4', 'Use the Post in Discord action instead; webhook URLs are credentials and are never imported.'),
    'tts.speak': g('Text to speech', '2b', 'CertiFried Studio does not speak text yet.'),
    'currency.change': g('Viewer currency / loyalty points', '6', 'Stream loyalty points are not built.'),
    'quotes': g('Stream quotes (!quote)', '4', 'Quotes on Twitch and Kick are not built; Discord quotes are a separate feature.'),
    'variable.argument': g('Temporary arguments inside an action', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'obs.transform': g('Move, resize or rotate an OBS source', '2b', 'Studio has no transform action yet.'),
    'obs.media': g('Control an OBS media source', '2b', 'Studio has no media source action yet.'),
    'code': g('Run custom code (C#, JavaScript)', 'never', 'CertiFried never runs code from an import.'),
    'spotify': g('Spotify song requests and playback', 'done', 'Imported as song requests: Streamer.bot Spotify extension commands become the song request commands of the Music page (design doc §8).'),
    'sound.folder': g('Play a random sound from a folder', '2b', 'Studio plays one named sound.'),
    'unknown.effect': g('Effect or sub-action of a type the importer does not know', '-', 'Listed with its type so it can be added.'),
    // ── triggers ──
    'trigger.speech': g('Speech-to-text voice commands', 'done', 'Available: CertiFried Studio voice commands (trigger voice.phrase, Studio 0.2.4); imported as those.'),
    'trigger.power_up': g('Bits power-up redemptions', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'trigger.app_started': g('"App started" trigger', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'trigger.first_words': g('First message of a viewer', '4', 'No first-chatter trigger on the engine (the channel bot has its own first-chatter feature).'),
    'trigger.viewer_arrived': g('Viewer arrived / present viewers', '4', 'The engine does not track who is watching.'),
    'trigger.timed': g('Timed actions (run an action list on a timer)', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'trigger.hotkey': g('Hotkey that runs an action list', '2b', 'Studio runs an automation from a hotkey you set in Studio; imported hotkeys are listed, not bound.'),
    'trigger.youtube': g('YouTube events', '6', 'YouTube Live is Phase 6.'),
    'trigger.other': g('Trigger with no CertiFried equivalent', '-', 'Listed with its name so it can be added.'),
    'trigger.test': g('Manual "test" trigger', '-', 'Use the automation\'s Test button instead.'),
    // ── commands and timers ──
    'command.use_count': g('Command use count variable ($count, %counter%)', '4', 'Channel commands count uses but the count is not a variable.'),
    'command.regex_trigger': g('Commands triggered by a pattern anywhere in the message', '4', 'Covered by a chat automation with a pattern; channel commands match the first word only.'),
    'command.subcommands': g('Sub-commands (!cmd add …)', '4', 'Not built; each sub-command needs its own automation.'),
    'command.roles': g('Command permissions beyond broadcaster / moderator', '4', 'Channel commands know broadcaster and moderator only; VIP and subscriber limits become automations.'),
    'timer.twitch': g('Timed messages on Twitch', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'timer.chat_lines': g('Timer "only after N chat lines"', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'timer.live_only': g('Timer "only while live"', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'timer.multi': g('Timers with more than one message or other effects', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'variable.stream_info': g('Stream title / category variables', 'done', 'Available since the Phase 4 build (design doc section 7); the importer maps it.'),
    'variable.other': g('Variable with no CertiFried equivalent', '4', 'Listed with its name.'),
    'moderation.words': g('Banned words imported into chat moderation', 'done', 'Saved in CertiFried as a pending list, not applied: Kick automod turns its word rule on as soon as it has words, so they go in only when you press "Apply to Kick automod" on the Import page. Twitch blocked terms are switched on as they are added and the Stream bot connection cannot manage them, so the page lists them to add on Twitch.'),
    'moderation.patterns': g('Banned patterns (regular expressions)', '4', 'Kick automod matches words and * wildcards, not regular expressions.'),
    'moderation.urls': g('Link moderation with an allow-list', '4', 'Kick automod blocks all links; there is no per-domain allow-list.'),
    'moderation.emotes': g('Emote limit', '4', 'Not built.'),
    'rewards.manage': g('Create and edit channel point rewards from CertiFried', '4', 'Rewards made by Firebot or Streamer.bot can only be edited by them (Twitch rule); CertiFried can recreate them.'),
    'viewer.watchtime': g('Watch time and viewer stats', '4', 'No watch-time tracking for stream viewers.'),
});

export const gapInfo = (key) => GAPS[key] || GAPS['unknown.effect'];

/** Integrations named in Firebot/Streamer.bot settings → what to do in CertiFried (by service name only). */
export const INTEGRATIONS = Object.freeze({
    twitch: { label: 'Twitch', todo: 'Connect Twitch on Stream bot → Connections (Stream bot grant).', have: true },
    kick: { label: 'Kick', todo: 'Link your Kick channel on Stream bot → Connections.', have: true },
    youtube: { label: 'YouTube', todo: 'Not available yet (Phase 6).', have: false },
    obs: { label: 'OBS', todo: 'Install CertiFried Studio and enter the OBS websocket host and port below; type the password into Studio yourself.', have: true },
    streamelements: { label: 'StreamElements', todo: 'Add StreamElements as a tip source on Stream bot → Connections.', have: true },
    streamlabs: { label: 'Streamlabs', todo: 'Add Streamlabs as a tip source on Stream bot → Connections.', have: true },
    kofi: { label: 'Ko-fi', todo: 'Set up Ko-fi in your server dashboard, then add it as a tip source.', have: true },
    fourthwall: { label: 'Fourthwall', todo: 'Set up Fourthwall in your server dashboard, then add it as a tip source.', have: true },
    throne: { label: 'Throne', todo: 'Link Throne on your profile, then add it as a tip source.', have: true },
    spotify: { label: 'Spotify', todo: 'Song requests on the Music page (Stream bot → Music): imported Spotify commands become its song request commands. Music plays through OBS, not Spotify.', have: true },
    discord: { label: 'Discord', todo: 'Use the Post in Discord action with a server where CertiFried is.', have: true },
    pulsoid: { label: 'Pulsoid', todo: 'Not available yet (heart-rate overlay, Phase 3).', have: false },
    hyperate: { label: 'HypeRate', todo: 'Not available yet (heart-rate overlay, Phase 3).', have: false },
    voicemod: { label: 'Voicemod', todo: 'Not available yet.', have: false },
    vtubestudio: { label: 'VTube Studio', todo: 'Not available yet.', have: false },
    streamdeck: { label: 'Stream Deck', todo: 'Planned for CertiFried Studio (Phase 2b).', have: false },
    websocket: { label: 'Local websocket / HTTP server', todo: 'Not needed: CertiFried Studio connects to CertiFried.', have: true },
    lumia: { label: 'Lumia Stream', todo: 'Lights arrive in Phase 5.', have: false },
    crowdcontrol: { label: 'Crowd Control', todo: 'Not available.', have: false },
    tts: { label: 'Text to speech', todo: 'Not available yet (Phase 2b).', have: false },
});

/** Import categories, in the order the page shows them. */
export const CATEGORIES = Object.freeze([
    { key: 'commands', label: 'Chat commands' },
    { key: 'automations', label: 'Events and actions' },
    { key: 'timers', label: 'Timed messages' },
    { key: 'counters', label: 'Counters' },
    { key: 'rewards', label: 'Channel point rewards and power-ups' },
    { key: 'quotes', label: 'Quotes' },
    { key: 'moderation', label: 'Chat moderation' },
    { key: 'hotkeys', label: 'Hotkeys' },
    { key: 'integrations', label: 'Connected services' },
    { key: 'viewers', label: 'Viewer stats', optIn: true },
]);

export default { GAPS, gapInfo, INTEGRATIONS, CATEGORIES };
