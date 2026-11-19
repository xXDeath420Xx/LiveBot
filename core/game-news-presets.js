/*
 * Curated catalogue of game news / patch-note sources.
 *
 * This is what the dashboard and `/gamenews` offer by name, so a server picks "Destiny 2"
 * instead of hunting down a feed URL. Each preset resolves to a provider + provider_config
 * that `core/game-patch-watcher-manager.js` already knows how to poll — adding a title here
 * requires no new code.
 *
 * Provider choice, in order of preference:
 *   steam-news  — the game is on Steam and the publisher posts patch notes there. Most
 *                 reliable option by a wide margin: official API, stable ids, no scraping.
 *   rss         — the publisher ships an RSS/Atom feed.
 *   <bespoke>   — only where neither exists (cod-blog, fortnite-news).
 *
 * `feeds: ['steam_community_announcements']` narrows Steam to the feed that actually carries
 * patch notes; without it you also get press blurbs and third-party news reposts.
 */

/** @typedef {{key:string,label:string,platform:string,provider:string,config:object,color?:number,note?:string}} Preset */

/** @type {Preset[]} */
export const GAME_NEWS_PRESETS = [
  // ---- Bespoke scrapers (publisher ships no usable feed) ----
  { key: 'call-of-duty', label: 'Call of Duty', platform: 'Multi-platform', provider: 'cod-blog', color: 0xC72C41,
    config: { include: ['black-ops', 'warzone'], exclude: ['mobile'] },
    note: 'Scrapes callofduty.com/blog. Tune include/exclude to pick which sub-titles you follow.' },
  { key: 'fortnite', label: 'Fortnite', platform: 'Multi-platform', provider: 'fortnite-news', color: 0x751F1F,
    config: { maxArticles: 6 },
    note: 'Renders fortnite.com/news with a headless browser — heavier than the other providers.' },

  // ---- Valve ----
  { key: 'counter-strike-2', label: 'Counter-Strike 2', platform: 'Steam', provider: 'steam-news', color: 0xF0A70A,
    config: { appid: 730, feeds: ['steam_community_announcements'] } },
  { key: 'dota-2', label: 'Dota 2', platform: 'Steam', provider: 'steam-news', color: 0xC23C2A,
    config: { appid: 570, feeds: ['steam_community_announcements'] } },
  { key: 'team-fortress-2', label: 'Team Fortress 2', platform: 'Steam', provider: 'steam-news', color: 0xB8383B,
    config: { appid: 440, feeds: ['steam_community_announcements'] } },
  { key: 'half-life-alyx', label: 'Half-Life: Alyx', platform: 'Steam', provider: 'steam-news', color: 0xEE802F,
    config: { appid: 546560, feeds: ['steam_community_announcements'] } },
  { key: 'deadlock', label: 'Deadlock', platform: 'Steam', provider: 'steam-news', color: 0xC9A227,
    config: { appid: 1422450, feeds: ['steam_community_announcements'] } },

  // ---- Riot ----
  // Riot publishes no RSS/Atom feed for any of its titles and none of them are on Steam,
  // so these relay the official accounts. Verified live rather than assumed.
  { key: 'league-of-legends', label: 'League of Legends', platform: 'PC', provider: 'twitter-rss', color: 0xC89B3C,
    config: { username: 'LeagueOfLegends' } },
  { key: 'valorant', label: 'VALORANT', platform: 'Multi-platform', provider: 'twitter-rss', color: 0xFF4655,
    config: { username: 'VALORANT' } },
  { key: 'teamfight-tactics', label: 'Teamfight Tactics', platform: 'Multi-platform', provider: 'twitter-rss', color: 0x1BC7B1,
    config: { username: 'TFT' } },
  { key: 'legends-of-runeterra', label: 'Legends of Runeterra', platform: 'Multi-platform', provider: 'twitter-rss', color: 0x0A1428,
    config: { username: 'PlayRuneterra' } },

  // ---- Bungie / Destiny ----
  { key: 'destiny-2', label: 'Destiny 2', platform: 'Multi-platform', provider: 'steam-news', color: 0x00A2FF,
    config: { appid: 1085660, feeds: ['steam_community_announcements'] } },

  // ---- Mojang ----
  { key: 'minecraft', label: 'Minecraft', platform: 'Multi-platform', provider: 'rss', color: 0x62B47A,
    config: { url: 'https://www.minecraft.net/en-us/feeds/community-content/rss' } },

  // ---- Survival / sandbox (Steam) ----
  { key: 'rust', label: 'Rust', platform: 'Steam', provider: 'steam-news', color: 0xCD412B,
    config: { appid: 252490, feeds: ['steam_community_announcements'] } },
  { key: 'ark-survival-ascended', label: 'ARK: Survival Ascended', platform: 'Steam', provider: 'steam-news', color: 0x2E6E9E,
    config: { appid: 2399830, feeds: ['steam_community_announcements'] } },
  { key: 'valheim', label: 'Valheim', platform: 'Steam', provider: 'steam-news', color: 0x4F7942,
    config: { appid: 892970, feeds: ['steam_community_announcements'] } },
  { key: 'terraria', label: 'Terraria', platform: 'Steam', provider: 'steam-news', color: 0x8FD032,
    config: { appid: 105600, feeds: ['steam_community_announcements'] } },
  { key: 'palworld', label: 'Palworld', platform: 'Steam', provider: 'steam-news', color: 0x4FC3F7,
    config: { appid: 1623730, feeds: ['steam_community_announcements'] } },
  { key: 'seven-days-to-die', label: '7 Days to Die', platform: 'Steam', provider: 'steam-news', color: 0x8B4513,
    config: { appid: 251570, feeds: ['steam_community_announcements'] } },
  { key: 'project-zomboid', label: 'Project Zomboid', platform: 'Steam', provider: 'steam-news', color: 0x6B8E23,
    config: { appid: 108600, feeds: ['steam_community_announcements'] } },
  { key: 'dayz', label: 'DayZ', platform: 'Steam', provider: 'steam-news', color: 0x5A6B3C,
    config: { appid: 221100, feeds: ['steam_community_announcements'] } },
  { key: 'satisfactory', label: 'Satisfactory', platform: 'Steam', provider: 'steam-news', color: 0xFA9549,
    config: { appid: 526870, feeds: ['steam_community_announcements'] } },
  { key: 'stardew-valley', label: 'Stardew Valley', platform: 'Steam', provider: 'steam-news', color: 0x8FBC5A,
    config: { appid: 413150, feeds: ['steam_community_announcements'] } },
  { key: 'no-mans-sky', label: "No Man's Sky", platform: 'Steam', provider: 'steam-news', color: 0xE8562A,
    config: { appid: 275850, feeds: ['steam_community_announcements'] } },

  // ---- Shooters / competitive (Steam) ----
  { key: 'apex-legends', label: 'Apex Legends', platform: 'Steam', provider: 'steam-news', color: 0xDA292A,
    config: { appid: 1172470, feeds: ['steam_community_announcements'] } },
  { key: 'pubg', label: 'PUBG: BATTLEGROUNDS', platform: 'Steam', provider: 'steam-news', color: 0xF2A900,
    config: { appid: 578080, feeds: ['steam_community_announcements'] } },
  { key: 'rainbow-six-siege', label: 'Rainbow Six Siege', platform: 'Steam', provider: 'steam-news', color: 0x1B1B1B,
    config: { appid: 359550, feeds: ['steam_community_announcements'] } },
  { key: 'escape-from-tarkov', label: 'Escape from Tarkov', platform: 'PC', provider: 'twitter-rss', color: 0x9A8866,
    config: { username: 'tarkov' } },
  { key: 'hunt-showdown', label: 'Hunt: Showdown 1896', platform: 'Steam', provider: 'steam-news', color: 0x6E4B3A,
    config: { appid: 594650, feeds: ['steam_community_announcements'] } },
  { key: 'the-finals', label: 'THE FINALS', platform: 'Steam', provider: 'steam-news', color: 0xD31F3C,
    config: { appid: 2073850, feeds: ['steam_community_announcements'] } },
  { key: 'delta-force', label: 'Delta Force', platform: 'Steam', provider: 'steam-news', color: 0x4A5D23,
    config: { appid: 2507950, feeds: ['steam_community_announcements'] } },
  { key: 'marvel-rivals', label: 'Marvel Rivals', platform: 'Steam', provider: 'steam-news', color: 0xED1D24,
    config: { appid: 2767030, feeds: ['steam_community_announcements'] } },
  { key: 'helldivers-2', label: 'HELLDIVERS 2', platform: 'Steam', provider: 'steam-news', color: 0xFFD700,
    config: { appid: 553850, feeds: ['steam_community_announcements'] } },
  { key: 'war-thunder', label: 'War Thunder', platform: 'Steam', provider: 'steam-news', color: 0x4B6A2F,
    config: { appid: 236390, feeds: ['steam_community_announcements'] } },
  { key: 'world-of-tanks', label: 'World of Tanks', platform: 'PC', provider: 'rss', color: 0xB8A054,
    config: { url: 'https://worldoftanks.com/en/rss/news/' } },

  // ---- MMO / live service ----
  { key: 'final-fantasy-xiv', label: 'Final Fantasy XIV', platform: 'Multi-platform', provider: 'rss', color: 0x2B5797,
    config: { url: 'https://na.finalfantasyxiv.com/lodestone/news/news.xml' } },
  { key: 'guild-wars-2', label: 'Guild Wars 2', platform: 'PC', provider: 'steam-news', color: 0xA6270F,
    config: { appid: 1284210, feeds: ['steam_community_announcements'] } },
  { key: 'elder-scrolls-online', label: 'The Elder Scrolls Online', platform: 'Steam', provider: 'steam-news', color: 0x2E5E3E,
    config: { appid: 306130, feeds: ['steam_community_announcements'] } },
  { key: 'path-of-exile-2', label: 'Path of Exile 2', platform: 'Steam', provider: 'steam-news', color: 0x8B0000,
    config: { appid: 2694490, feeds: ['steam_community_announcements'] } },
  { key: 'path-of-exile', label: 'Path of Exile', platform: 'Steam', provider: 'steam-news', color: 0x654321,
    config: { appid: 238960, feeds: ['steam_community_announcements'] } },
  { key: 'warframe', label: 'Warframe', platform: 'Steam', provider: 'steam-news', color: 0x2C3E50,
    config: { appid: 230410, feeds: ['steam_community_announcements'] } },
  { key: 'albion-online', label: 'Albion Online', platform: 'Steam', provider: 'steam-news', color: 0xC0A062,
    config: { appid: 761890, feeds: ['steam_community_announcements'] } },
  { key: 'runescape', label: 'RuneScape', platform: 'PC', provider: 'rss', color: 0x8B7355,
    config: { url: 'https://secure.runescape.com/m=news/latest_news.rss' } },
  { key: 'old-school-runescape', label: 'Old School RuneScape', platform: 'PC', provider: 'rss', color: 0xC4A464,
    config: { url: 'https://secure.runescape.com/m=news/latest_news.rss?oldschool=true' } },
  { key: 'eve-online', label: 'EVE Online', platform: 'PC', provider: 'steam-news', color: 0x0D1B2A,
    config: { appid: 8500, feeds: ['steam_community_announcements'] } },

  // ---- Sim / racing / sport ----
  { key: 'euro-truck-simulator-2', label: 'Euro Truck Simulator 2', platform: 'Steam', provider: 'steam-news', color: 0x0F4C81,
    config: { appid: 227300, feeds: ['steam_community_announcements'] } },
  { key: 'american-truck-simulator', label: 'American Truck Simulator', platform: 'Steam', provider: 'steam-news', color: 0xB22222,
    config: { appid: 270880, feeds: ['steam_community_announcements'] } },
  { key: 'assetto-corsa-competizione', label: 'Assetto Corsa Competizione', platform: 'Steam', provider: 'steam-news', color: 0xE10600,
    config: { appid: 805550, feeds: ['steam_community_announcements'] } },
  { key: 'rocket-league', label: 'Rocket League', platform: 'Multi-platform', provider: 'twitter-rss', color: 0x0A64C8,
    config: { username: 'RocketLeague' } },
  { key: 'football-manager', label: 'Football Manager', platform: 'Steam', provider: 'steam-news', color: 0x00A650,
    config: { appid: 2252570, feeds: ['steam_community_announcements'] } },

  // ---- Co-op / party / other ----
  { key: 'dead-by-daylight', label: 'Dead by Daylight', platform: 'Steam', provider: 'steam-news', color: 0x8B0000,
    config: { appid: 381210, feeds: ['steam_community_announcements'] } },
  { key: 'phasmophobia', label: 'Phasmophobia', platform: 'Steam', provider: 'steam-news', color: 0x2F4F4F,
    config: { appid: 739630, feeds: ['steam_community_announcements'] } },
  { key: 'deep-rock-galactic', label: 'Deep Rock Galactic', platform: 'Steam', provider: 'steam-news', color: 0xE8A33D,
    config: { appid: 548430, feeds: ['steam_community_announcements'] } },
  { key: 'lethal-company', label: 'Lethal Company', platform: 'Steam', provider: 'steam-news', color: 0x556B2F,
    config: { appid: 1966720, feeds: ['steam_community_announcements'] } },
  { key: 'among-us', label: 'Among Us', platform: 'Steam', provider: 'steam-news', color: 0xC51111,
    config: { appid: 945360, feeds: ['steam_community_announcements'] } },
  { key: 'baldurs-gate-3', label: "Baldur's Gate 3", platform: 'Steam', provider: 'steam-news', color: 0x7B2D26,
    config: { appid: 1086940, feeds: ['steam_community_announcements'] } },
  { key: 'cyberpunk-2077', label: 'Cyberpunk 2077', platform: 'Steam', provider: 'steam-news', color: 0xFCEE0A,
    config: { appid: 1091500, feeds: ['steam_community_announcements'] } },
  { key: 'elden-ring', label: 'ELDEN RING', platform: 'Steam', provider: 'steam-news', color: 0xC5A253,
    config: { appid: 1245620, feeds: ['steam_community_announcements'] } },
  { key: 'gta-v', label: 'Grand Theft Auto V', platform: 'Steam', provider: 'steam-news', color: 0x00A86B,
    config: { appid: 271590, feeds: ['steam_community_announcements'] } },
  { key: 'red-dead-redemption-2', label: 'Red Dead Redemption 2', platform: 'Steam', provider: 'steam-news', color: 0x8B2500,
    config: { appid: 1174180, feeds: ['steam_community_announcements'] } },
  { key: 'sea-of-thieves', label: 'Sea of Thieves', platform: 'Steam', provider: 'steam-news', color: 0x1F6F8B,
    config: { appid: 1172620, feeds: ['steam_community_announcements'] } },
  { key: 'the-sims-4', label: 'The Sims 4', platform: 'Steam', provider: 'steam-news', color: 0x00B140,
    config: { appid: 1222670, feeds: ['steam_community_announcements'] } },

  // ---- Platform / industry news (not a single game) ----
  { key: 'steam-blog', label: 'Steam — official blog', platform: 'Steam', provider: 'rss', color: 0x1B2838,
    config: { url: 'https://store.steampowered.com/feeds/news.xml' } },
  { key: 'xbox-wire', label: 'Xbox Wire', platform: 'Xbox', provider: 'rss', color: 0x107C10,
    config: { url: 'https://news.xbox.com/en-us/feed/' } },
  { key: 'playstation-blog', label: 'PlayStation Blog', platform: 'PlayStation', provider: 'rss', color: 0x0070D1,
    config: { url: 'https://blog.playstation.com/feed/' } },
  { key: 'nintendo-life', label: 'Nintendo — Nintendo Life', platform: 'Nintendo', provider: 'rss', color: 0xE60012,
    config: { url: 'https://www.nintendolife.com/feeds/latest' } },
  // Epic and GOG both 403 / serve HTML at their advertised feed paths, so relay the accounts.
  { key: 'epic-games-news', label: 'Epic Games — news', platform: 'Epic Games', provider: 'twitter-rss', color: 0x0078F2,
    config: { username: 'EpicGames' } },
  { key: 'gog-news', label: 'GOG — news', platform: 'GOG', provider: 'twitter-rss', color: 0x86328A,
    config: { username: 'GOGcom' } },
  { key: 'pc-gamer', label: 'PC Gamer', platform: 'Industry', provider: 'rss', color: 0xE4002B,
    config: { url: 'https://www.pcgamer.com/rss/' } },
  { key: 'eurogamer', label: 'Eurogamer', platform: 'Industry', provider: 'rss', color: 0x5C2D91,
    config: { url: 'https://www.eurogamer.net/feed' } },
  { key: 'rock-paper-shotgun', label: 'Rock Paper Shotgun', platform: 'Industry', provider: 'rss', color: 0xE8542F,
    config: { url: 'https://www.rockpapershotgun.com/feed' } },
  { key: 'ign', label: 'IGN', platform: 'Industry', provider: 'rss', color: 0xBF1313,
    config: { url: 'https://feeds.ign.com/ign/games-all' } },
  { key: 'gamespot', label: 'GameSpot', platform: 'Industry', provider: 'rss', color: 0xF3C300,
    config: { url: 'https://www.gamespot.com/feeds/game-news/' } },
  { key: 'pcgamesn', label: 'PCGamesN', platform: 'Industry', provider: 'rss', color: 0x00B4D8,
    config: { url: 'https://www.pcgamesn.com/mainrss.xml' } },
  { key: 'kotaku', label: 'Kotaku', platform: 'Industry', provider: 'rss', color: 0x00AA4F,
    config: { url: 'https://kotaku.com/rss' } },
];

const BY_KEY = new Map(GAME_NEWS_PRESETS.map(p => [p.key, p]));

export function getPreset(key) {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

export function presetColor(key) {
  return getPreset(key)?.color ?? null;
}

/** Presets grouped by platform, for the dashboard's picker. */
export function presetsByPlatform() {
  const out = new Map();
  for (const p of GAME_NEWS_PRESETS) {
    if (!out.has(p.platform)) out.set(p.platform, []);
    out.get(p.platform).push(p);
  }
  for (const list of out.values()) list.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Substring search over label + key, for slash-command autocomplete. */
export function searchPresets(query, limit = 25) {
  const q = (query || '').toLowerCase().trim();
  const hits = q
    ? GAME_NEWS_PRESETS.filter(p => p.label.toLowerCase().includes(q) || p.key.includes(q))
    : GAME_NEWS_PRESETS.slice();
  return hits.sort((a, b) => a.label.localeCompare(b.label)).slice(0, limit);
}

export default GAME_NEWS_PRESETS;
