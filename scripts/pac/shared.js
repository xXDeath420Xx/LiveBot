// Shared context + helpers for the Welcome-to-The-Pac migration scripts.
import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';

export const GUILD_ID = '1099732505243959407';
export const BOT_ID = '1409904443125665875';
export const OWNER_USER_ID = '365905620060340224';

// Role ids already present / created previously
export const ROLES_EXISTING = {
    Certified:        '1496234803786289245',  // managed bot role
    BotManager:       '1496340359532515459',
    FemaleAlpha:      '1430735303236124743',  // pre-existing live role
    Beta:             '1429161590879551619',  // mod admin
    Pups:             '1429163022760284170',
    PacMember:        '1430692704022560908',
    Purple:           '1457188709559566519',
    Orange:           '1457188698876805347',
    Green:            '1457188700038627390',
    Red:              '1457188701938520198',
    Yellow:           '1457188703465115790',
    Blue:             '1457188705218330695',
    Verified:         '1457183768186982485',
    unverified:       '1457183002458062933',
};

// Channel ids already present
export const CHANNELS_EXISTING = {
    welcome:             '1439738089277886617',
    verification:        '1457183772821688474',
    pacRules:            '1439738126057603122',
    wolfCategory:        '1439733487673282802',
    wolfLive:            '1439738546373263461',
    wolfLinks:           '1439738375929069709',
    pacsPartyCategory:   '1412158772868022372',
    twitchLive:          '1491159495219613726',
    adminModLive:        '1491118105190203564',
    pacSupport:          '1412159776523026595',
    partyRaid:           '1412160008581415113',
    pacCollabs:          '1456057304242716724',
    pacEvents:           '1456057618542887058',
    polls:               '1485821778172448798',
    appreciation:        '1412159226641387551',
    gamesCategory:       '1412161909536591992',
    arcRaiders:          '1457186892993794213',
    callOfDuty:          '1412162731502473317',
    horrorGames:         '1412162491349336196',
    marvel:              '1412162116017848350',
    wow:                 '1412162819767664680',
    fortnite:            '1483901892995322037',
    adminModsCategory:   '1430702702064832572',
    adminModChat:        '1439738949462392902',
    logging:             '1439739127728701571',
    discordUpdates:      '1439754875087884379',
    welcomeCategory:     '1439734352878501928',
    roles:               '1456056474097680394',
    introductions:       '1439846360626233374',
    announcements:       '1439738183645401268',
    birthdays:           '1457195020749901875',
    levels:              '1439845927031672994',
    achievements:        '1466200600067838175',
    communityCategory:   '1412154574021722262',
    general:             '1412154940192981223',
    memes:               '1439738673280061603',
    nsfw:                '1457203034244255774',
    mentalHealth:        '1412163694846021684',
    photos:              '1412165063736950804',
    pets:                '1412164722865737899',
    foodies:             '1412156221942661171',
    artMusicAnime:       '1412156612025647155',
    suggestions:         '1439883826473205851',
    streamerEducation:   '1490854515069419550',
    voiceCategory:       '1099732506045067297',
    vcGaming:            '1412161011514998854',
    vcGeneral:           '1412160774436032514',
    vcLobby:             '1099732506045067298',
    vcPrivate1:          '1425890213309452409',
    vcPrivate2:          '1439728893664690176',
};

export function createPool() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
}

export async function connectClient() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN missing in env');
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.GuildWebhooks,
            GatewayIntentBits.GuildEmojisAndStickers,
            GatewayIntentBits.GuildScheduledEvents,
            GatewayIntentBits.MessageContent,
        ],
    });
    await client.login(token);
    await new Promise(r => client.once('ready', r));
    return client;
}

export async function getGuild(client) {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.roles.fetch();
    await guild.channels.fetch();
    return guild;
}

export function log(label, msg) {
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`[${stamp}] ${label}: ${msg}`);
}
