/**
 * Insomniac Crew — Replace Carl bot reaction roles with Steve
 *
 * Guild: 538201414367707137 | Bot: 1469972857701273716 (Steve)
 *
 * This script:
 * 1. Creates missing roles (SWITCH, pronouns, notifications, game roles)
 * 2. Sends clean embeds to #rules and #roles channels
 * 3. Registers all panels in reaction_role_panels + reaction_role_mappings
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder
} from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '538201414367707137';
const BOT_ID = '1469972857701273716';
const RULES_CHANNEL = '868256979343274014';
const ROLES_CHANNEL = '1407625323377590272';

let pool, client;

// ─── Helper: Create a role if it doesn't exist ──────────────────────────────
async function ensureRole(guild, name, color, reason) {
    const existing = guild.roles.cache.find(r => r.name === name);
    if (existing) {
        console.log(`  ✓ Role exists: ${name} (${existing.id})`);
        return existing;
    }
    const role = await guild.roles.create({ name, color, reason, mentionable: false });
    console.log(`  + Created role: ${name} (${role.id})`);
    return role;
}

// ─── Helper: Register panel in DB ────────────────────────────────────────────
async function registerPanel(guildId, channelId, messageId, panelName, description, mode, type, roles) {
    const [result] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, panel_mode, interaction_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [guildId, channelId, messageId, panelName, description, mode, type]
    );
    const panelId = result.insertId;

    for (const r of roles) {
        await pool.execute(
            `INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id) VALUES (?, ?, ?)`,
            [panelId, r.emojiId, r.roleId]
        );
    }
    console.log(`  DB: Panel "${panelName}" (id=${panelId}) with ${roles.length} role mappings`);
    return panelId;
}

// ─── Helper: Build button rows ───────────────────────────────────────────────
function buildButtons(roles) {
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let count = 0;

    for (const r of roles) {
        if (count >= 5) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder();
            count = 0;
        }
        const btn = new ButtonBuilder()
            .setCustomId(`rr_${r.roleId}`)
            .setLabel(r.label)
            .setStyle(r.style || ButtonStyle.Secondary);
        if (r.emoji) btn.setEmoji(r.emoji);
        currentRow.addComponents(btn);
        count++;
    }
    if (count > 0) rows.push(currentRow);
    return rows;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    pool = mysql.createPool({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        charset: 'utf8mb4', waitForConnections: true, connectionLimit: 5, timezone: '+00:00'
    });

    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const tokenData = typeof bots[0].bot_token === 'string' ? JSON.parse(bots[0].bot_token) : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
    });
    await client.login(token);
    await new Promise(r => { if (client.isReady()) r(); else client.once('ready', r); });
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();

    console.log('='.repeat(70));
    console.log('  STEP 1: Creating missing roles');
    console.log('='.repeat(70));

    // Gaming platform
    const switchRole = await ensureRole(guild, 'SWITCH 🎮', '#e4000f', 'Reaction role setup');
    const xboxId = '1407877328549183599';
    const psId = '1407877661790965780';
    const pcId = '1407877767441285210';

    // Pronouns
    const heHim = await ensureRole(guild, 'He/Him', '#3498db', 'Pronoun role');
    const sheHer = await ensureRole(guild, 'She/Her', '#e91e63', 'Pronoun role');
    const theyThem = await ensureRole(guild, 'They/Them', '#9b59b6', 'Pronoun role');

    // Notifications
    const announceRole = await ensureRole(guild, '📢 Announcements', '#f1c40f', 'Notification role');
    const gameNightRole = await ensureRole(guild, '🎮 Game Night', '#2ecc71', 'Notification role');
    const movieNightRole = await ensureRole(guild, '🍿 Movie Night', '#e74c3c', 'Notification role');
    const streamAlertRole = await ensureRole(guild, '🔴 Stream Alerts', '#9b59b6', 'Notification role');

    // Game-specific
    const minecraftRole = await ensureRole(guild, 'Minecraft', '#55a630', 'Game role');
    const codRole = await ensureRole(guild, 'COD', '#4a4a4a', 'Game role');
    const fortniteRole = await ensureRole(guild, 'Fortnite', '#1890ff', 'Game role');
    const apexRole = await ensureRole(guild, 'Apex Legends', '#cd3333', 'Game role');
    const marvelRole = await ensureRole(guild, 'Marvel Rivals', '#7b2d8b', 'Game role');
    const helldiversRole = await ensureRole(guild, 'Helldivers 2', '#ffe135', 'Game role');

    // Existing substance role IDs
    const botanistId = '1407252253601169439';
    const oilWorkerId = '1407252298064728205';
    const alcoholismId = '1407251001366286387';
    const noneForMeId = '1418506747680784424';

    // ─── STEP 2: Rules channel — Members react role ──────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('  STEP 2: Sending rules embed to #rules');
    console.log('='.repeat(70));

    const rulesChannel = await guild.channels.fetch(RULES_CHANNEL);

    const rulesEmbed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('📜 Server Rules')
        .setDescription('Welcome to **Insomniac Crew**! Please read and follow these rules to keep the community a chill and fun place for everyone.')
        .addFields(
            {
                name: '1. Respect Everyone',
                value: 'No offensive messages, nicknames, or harassment of any kind. This includes sexual harassment, excessive messages, and unwanted DMs. Report issues to a moderator.',
                inline: false
            },
            {
                name: '2. No Spam',
                value: 'No message spam, @mention spam, character spam, image spam, or loud/obnoxious noises in voice channels.',
                inline: false
            },
            {
                name: '3. No NSFW Content',
                value: 'This is an all-ages community. NSFW material is not permitted. Cannabis discussion is allowed in designated channels. One warning only.',
                inline: false
            },
            {
                name: '4. Use the Right Channels',
                value: 'Keep conversations in the appropriate channels. Stream links belong in <#875775051885064223> and <#870231634715213824> only.',
                inline: false
            },
            {
                name: '5. No Self/User Bots',
                value: 'No unauthorized bots. Use the bots already available in the server.',
                inline: false
            },
            {
                name: '6. No Unsolicited Discord Links',
                value: 'Do not share server invites without moderator approval. You may invite people via DM — treat Discord links like unsolicited pics: don\'t send them.',
                inline: false
            },
            {
                name: '7. Swearing is Fine',
                value: 'Just don\'t direct it at other members.',
                inline: false
            },
            {
                name: '8. Mod Discretion',
                value: 'Situations not covered by these rules are handled at moderator discretion. Complaints about staff go directly to the server owner.',
                inline: false
            }
        )
        .setFooter({ text: 'React with 👍 below to confirm you\'ve read the rules and gain access to the server.' })
        .setTimestamp();

    const rulesMsg = await rulesChannel.send({ embeds: [rulesEmbed] });
    await rulesMsg.react('👍');
    console.log(`  Sent rules embed: ${rulesMsg.id}`);

    // Register as reaction-based panel
    await registerPanel(
        GUILD_ID, RULES_CHANNEL, rulesMsg.id,
        'Rules Agreement', 'React to accept rules and get Members role',
        'normal', 'reaction',
        [{ emojiId: '👍', roleId: '870228845784080454' }]
    );

    // ─── STEP 3: Roles channel — Platform roles (buttons) ───────────────
    console.log('\n' + '='.repeat(70));
    console.log('  STEP 3: Sending role panels to #roles');
    console.log('='.repeat(70));

    const rolesChannel = await guild.channels.fetch(ROLES_CHANNEL);

    // ── Panel 1: Gaming Platform ──
    const platformEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎮 Gaming Platform')
        .setDescription('What do you play on? Select your platform(s) below. Click again to remove.');

    const platformRoles = [
        { roleId: xboxId, label: 'XBOX', emoji: '🟢', style: ButtonStyle.Success },
        { roleId: psId, label: 'PlayStation', emoji: '🔵', style: ButtonStyle.Primary },
        { roleId: pcId, label: 'PC', emoji: '🖥️', style: ButtonStyle.Danger },
        { roleId: switchRole.id, label: 'Switch', emoji: '🔴', style: ButtonStyle.Secondary }
    ];

    const platformMsg = await rolesChannel.send({
        embeds: [platformEmbed],
        components: buildButtons(platformRoles)
    });
    console.log(`  Sent platform panel: ${platformMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, platformMsg.id,
        'Gaming Platform', 'Select your gaming platform(s)',
        'normal', 'button',
        platformRoles.map(r => ({ emojiId: r.emoji, roleId: r.roleId }))
    );

    // ── Panel 2: Substance Preference ──
    const substanceEmbed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🌿 What\'s Your Vibe?')
        .setDescription('Do you chop up the devil\'s lettuce? Yearn for honey? Prefer a cold one? Or none of the above?');

    const substanceRoles = [
        { roleId: botanistId, label: 'Botanist', emoji: '🌲', style: ButtonStyle.Success },
        { roleId: oilWorkerId, label: 'Oil Worker', emoji: '🍯', style: ButtonStyle.Primary },
        { roleId: alcoholismId, label: 'Alcoholism', emoji: '🍻', style: ButtonStyle.Secondary },
        { roleId: noneForMeId, label: 'None for Me', emoji: '🚫', style: ButtonStyle.Danger }
    ];

    const substanceMsg = await rolesChannel.send({
        embeds: [substanceEmbed],
        components: buildButtons(substanceRoles)
    });
    console.log(`  Sent substance panel: ${substanceMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, substanceMsg.id,
        'Substance Preference', 'Select your vibe',
        'normal', 'button',
        substanceRoles.map(r => ({ emojiId: r.emoji, roleId: r.roleId }))
    );

    // ── Panel 3: Pronouns ──
    const pronounEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('💬 Pronouns')
        .setDescription('Let people know your preferred pronouns.');

    const pronounRoles = [
        { roleId: heHim.id, label: 'He/Him', emoji: '🔵', style: ButtonStyle.Primary },
        { roleId: sheHer.id, label: 'She/Her', emoji: '🩷', style: ButtonStyle.Secondary },
        { roleId: theyThem.id, label: 'They/Them', emoji: '🟣', style: ButtonStyle.Secondary }
    ];

    const pronounMsg = await rolesChannel.send({
        embeds: [pronounEmbed],
        components: buildButtons(pronounRoles)
    });
    console.log(`  Sent pronouns panel: ${pronounMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, pronounMsg.id,
        'Pronouns', 'Select your pronouns',
        'normal', 'button',
        pronounRoles.map(r => ({ emojiId: r.emoji, roleId: r.roleId }))
    );

    // ── Panel 4: Notifications ──
    const notifEmbed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🔔 Notification Roles')
        .setDescription('Opt in to get pinged for events and updates. Click again to unsubscribe.');

    const notifRoles = [
        { roleId: announceRole.id, label: 'Announcements', emoji: '📢', style: ButtonStyle.Primary },
        { roleId: gameNightRole.id, label: 'Game Night', emoji: '🎮', style: ButtonStyle.Success },
        { roleId: movieNightRole.id, label: 'Movie Night', emoji: '🍿', style: ButtonStyle.Danger },
        { roleId: streamAlertRole.id, label: 'Stream Alerts', emoji: '🔴', style: ButtonStyle.Secondary }
    ];

    const notifMsg = await rolesChannel.send({
        embeds: [notifEmbed],
        components: buildButtons(notifRoles)
    });
    console.log(`  Sent notifications panel: ${notifMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, notifMsg.id,
        'Notifications', 'Opt into notifications',
        'normal', 'button',
        notifRoles.map(r => ({ emojiId: r.emoji, roleId: r.roleId }))
    );

    // ── Panel 5: Games ──
    const gamesEmbed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🕹️ What Are You Playing?')
        .setDescription('Pick the games you play so others can find you for squads.');

    const gameRoles = [
        { roleId: minecraftRole.id, label: 'Minecraft', emoji: '⛏️', style: ButtonStyle.Success },
        { roleId: codRole.id, label: 'COD', emoji: '🔫', style: ButtonStyle.Secondary },
        { roleId: fortniteRole.id, label: 'Fortnite', emoji: '🌈', style: ButtonStyle.Primary },
        { roleId: apexRole.id, label: 'Apex Legends', emoji: '🏥', style: ButtonStyle.Danger },
        { roleId: marvelRole.id, label: 'Marvel Rivals', emoji: '🦸', style: ButtonStyle.Primary },
        { roleId: helldiversRole.id, label: 'Helldivers 2', emoji: '🌍', style: ButtonStyle.Success }
    ];

    const gamesMsg = await rolesChannel.send({
        embeds: [gamesEmbed],
        components: buildButtons(gameRoles)
    });
    console.log(`  Sent games panel: ${gamesMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, gamesMsg.id,
        'Games', 'Select the games you play',
        'normal', 'button',
        gameRoles.map(r => ({ emojiId: r.emoji, roleId: r.roleId }))
    );

    // ── Panel 6: NFL Teams (select menu) ──
    const nflEmbed = new EmbedBuilder()
        .setColor(0x013369)
        .setTitle('🏈 NFL Team')
        .setDescription('Rep your team! Pick one from the dropdown below.');

    const nflTeams = [
        { roleId: '1407626359483928686', label: 'Dallas Cowboys', emoji: '⭐' },
        { roleId: '1407626632042123295', label: 'New Orleans Saints', emoji: '⚜️' },
        { roleId: '1407626719791284327', label: 'Detroit Lions', emoji: '🦁' },
        { roleId: '1407626803232903180', label: 'Baltimore Ravens', emoji: '🐦' },
        { roleId: '1407626910707613707', label: 'Seattle Seahawks', emoji: '🐥' },
        { roleId: '1407627002210553876', label: 'Atlanta Falcons', emoji: '🔴' },
        { roleId: '1407886175980621895', label: 'Cincinnati Bengals', emoji: '🐯' },
        { roleId: '1407886507624103978', label: 'Las Vegas Raiders', emoji: '♟️' },
        { roleId: '1407886851876061336', label: 'New York Jets', emoji: '✈️' },
        { roleId: '1407887133376647239', label: 'Miami Dolphins', emoji: '🐬' }
    ];

    const nflSelect = new StringSelectMenuBuilder()
        .setCustomId('rr_select')
        .setPlaceholder('Choose your NFL team...')
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(nflTeams.map(t => ({
            label: t.label,
            value: t.roleId,
            emoji: t.emoji
        })));

    const nflMsg = await rolesChannel.send({
        embeds: [nflEmbed],
        components: [new ActionRowBuilder().addComponents(nflSelect)]
    });
    console.log(`  Sent NFL panel: ${nflMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, nflMsg.id,
        'NFL Teams', 'Rep your team',
        'unique', 'select_menu',
        nflTeams.map(t => ({ emojiId: t.emoji, roleId: t.roleId }))
    );

    // ── Panel 7: Naruto Characters (select menu) ──
    const narutoEmbed = new EmbedBuilder()
        .setColor(0xFF6600)
        .setTitle('🍥 Naruto Character')
        .setDescription('Which Naruto character do you identify with? Pick one.');

    const narutoChars = [
        { roleId: '1408290953457963089', label: 'Tobi', emoji: '🎭' },
        { roleId: '1407293049750556793', label: 'Konahamaru', emoji: '🧒' },
        { roleId: '1407293627134119967', label: 'Tobirama', emoji: '💧' },
        { roleId: '1407294071021637683', label: 'Killer Bee', emoji: '🐝' },
        { roleId: '1407294891255402548', label: 'Neji', emoji: '👁️' },
        { roleId: '1407295486431465482', label: 'Shisui', emoji: '⚡' },
        { roleId: '1407296424961507379', label: 'Hashirama', emoji: '🌲' },
        { roleId: '1407296786342871071', label: 'Kiba', emoji: '🐕' },
        { roleId: '1407297116082016287', label: 'Ramen Guy', emoji: '🍜' },
        { roleId: '1407440582992728186', label: 'Tsunade', emoji: '💎' }
    ];

    const narutoSelect = new StringSelectMenuBuilder()
        .setCustomId('rr_select')
        .setPlaceholder('Choose your Naruto character...')
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(narutoChars.map(c => ({
            label: c.label,
            value: c.roleId,
            emoji: c.emoji
        })));

    const narutoMsg = await rolesChannel.send({
        embeds: [narutoEmbed],
        components: [new ActionRowBuilder().addComponents(narutoSelect)]
    });
    console.log(`  Sent Naruto panel: ${narutoMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, narutoMsg.id,
        'Naruto Character', 'Pick your character',
        'unique', 'select_menu',
        narutoChars.map(c => ({ emojiId: c.emoji, roleId: c.roleId }))
    );

    // ── Panel 8: Personality / Fun roles (select menu, multi) ──
    const personalityEmbed = new EmbedBuilder()
        .setColor(0xE91E63)
        .setTitle('🎭 Personality Roles')
        .setDescription('Pick the vibes that match your energy. Select as many as you want from the dropdown.');

    const personalityRoles = [
        { roleId: '1407253165912490035', label: 'Weeb', emoji: '🍥' },
        { roleId: '1407283628551045142', label: 'Potty Mouth', emoji: '🤬' },
        { roleId: '1400344626455379979', label: 'Dain Bramage', emoji: '🧠' },
        { roleId: '1400344771482095686', label: 'Feral', emoji: '🐺' },
        { roleId: '1400345745588228178', label: 'Gooner', emoji: '👀' },
        { roleId: '1407254959279444060', label: 'Music', emoji: '🎶' },
        { roleId: '1407255339539107920', label: 'Horny Bonk', emoji: '🪧' },
        { roleId: '1407255618284163113', label: 'Vault Dweller', emoji: '🏚️' },
        { roleId: '1407252376313790494', label: 'Christmas Ham', emoji: '🎄' },
        { roleId: '1407252595675758643', label: 'Hamburglar', emoji: '🍔' },
        { roleId: '1407252684561580134', label: 'Stormtrooper', emoji: '⚪' },
        { roleId: '1407253664959172648', label: 'Starfish Kisser', emoji: '⭐' },
        { roleId: '1407254101686747156', label: 'Cheese', emoji: '🧀' },
        { roleId: '1407254517711507538', label: 'Buddah', emoji: '☮️' },
        { roleId: '1407257086810919014', label: '"I HAVE IT!!"', emoji: '🎉' }
    ];

    // Select menus max 25 options, we're at 15, good
    const personalitySelect = new StringSelectMenuBuilder()
        .setCustomId('rr_select')
        .setPlaceholder('Choose your personality roles...')
        .setMinValues(0)
        .setMaxValues(personalityRoles.length)
        .addOptions(personalityRoles.map(p => ({
            label: p.label,
            value: p.roleId,
            emoji: p.emoji
        })));

    const personalityMsg = await rolesChannel.send({
        embeds: [personalityEmbed],
        components: [new ActionRowBuilder().addComponents(personalitySelect)]
    });
    console.log(`  Sent personality panel: ${personalityMsg.id}`);

    await registerPanel(
        GUILD_ID, ROLES_CHANNEL, personalityMsg.id,
        'Personality Roles', 'Pick your vibes',
        'normal', 'select_menu',
        personalityRoles.map(p => ({ emojiId: p.emoji, roleId: p.roleId }))
    );

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('  SETUP COMPLETE');
    console.log('='.repeat(70));
    console.log('\n  Panels created:');
    console.log('    1. Rules Agreement (reaction, #rules)');
    console.log('    2. Gaming Platform (buttons, #roles)');
    console.log('    3. Substance Preference (buttons, #roles)');
    console.log('    4. Pronouns (buttons, #roles)');
    console.log('    5. Notifications (buttons, #roles)');
    console.log('    6. Games (buttons, #roles)');
    console.log('    7. NFL Teams (select menu, #roles)');
    console.log('    8. Naruto Character (select menu, #roles)');
    console.log('    9. Personality Roles (select menu, #roles)');
    console.log('\n  NEXT STEPS:');
    console.log('    1. Delete the old Carl bot messages manually (or leave them)');
    console.log('    2. Restart the bot: pm2 restart CertiFriedUtility');
    console.log('    3. Test each panel by clicking buttons / selecting options');
    console.log('\n');

    client.destroy();
    await pool.end();
}

main().catch(err => {
    console.error('FATAL:', err);
    if (client) client.destroy();
    if (pool) pool.end();
    process.exit(1);
});
