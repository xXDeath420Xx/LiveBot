/**
 * Replace Dyno integrations in CruciCafe Fam (877253051994501130)
 * with Cafe Utility bot (1473622894138491007).
 *
 * Steps:
 *   1. Fetch full rules embed text
 *   2. Delete all 8 Dyno webhooks
 *   3. Delete old Dyno reaction role messages
 *   4. Create new reaction role panels via ReactionRoleManager
 *   5. Delete old Dyno rules message & recreate from Cafe Utility
 *   6. Clear leveling_ignored_channels for the guild
 *
 * Usage: node scripts/replace-cafe-integrations.js
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import ReactionRoleManager from '../core/reaction-role-manager.js';

const GUILD_ID  = '877253051994501130';
const BOT_ID    = '1473622894138491007';

const CHANNELS = {
  rules:      '877254515244552232',   // 📄┊rules
  reactRoles: '904428293846098011',   // 😎┊react-roles
};

const DYNO_WEBHOOK_IDS = [
  '929808077341995039',   // dyno-updates changelogs
  '929814141638680586',   // join-leave-logs
  '929814141785505842',   // role-logs
  '929826784541831178',   // member-logs
  '930169549268074516',   // message-logs
  '939064550861447200',   // voice-logs
  '956853762935357481',   // mod-logs
  '957638631902814298',   // channel-logs
];

const DYNO_REACTION_ROLE_MSGS = [
  '929818025983619182',   // "Are you a Streamer?" panel
  '929814101574701067',   // "Color Roles:" panel
];

const RULES_MSG_ID = '929809153944334406';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getBotToken() {
  const [bots] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    [BOT_ID]
  );
  if (!bots.length) throw new Error(`Bot ${BOT_ID} not found in custom_bots`);
  return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildWebhooks,
  ],
});

client.once('ready', async () => {
  console.log('='.repeat(80));
  console.log('  CRUCICAFE FAM — REPLACE DYNO INTEGRATIONS');
  console.log('  Bot:', client.user.tag);
  console.log('='.repeat(80));

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('ERROR: Bot is not in the guild', GUILD_ID);
    process.exit(1);
  }

  const summary = [];

  try {
    // ─── STEP 1: Fetch full rules embed text ──────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log('STEP 1: Fetch full rules embed text');
    console.log('─'.repeat(60));

    const rulesChannel = await guild.channels.fetch(CHANNELS.rules);
    let rulesMessage;
    try {
      rulesMessage = await rulesChannel.messages.fetch(RULES_MSG_ID);
    } catch (e) {
      console.error('  Could not fetch rules message:', e.message);
    }

    let rulesEmbedDescription = '';
    let rulesEmbedTitle = '';
    if (rulesMessage && rulesMessage.embeds.length > 0) {
      const embed = rulesMessage.embeds[0];
      rulesEmbedTitle = embed.title || 'Community Rules:';
      rulesEmbedDescription = embed.description || '';
      console.log(`  Title: ${rulesEmbedTitle}`);
      console.log(`  Description length: ${rulesEmbedDescription.length} characters`);
      console.log('  --- FULL EMBED DESCRIPTION ---');
      console.log(rulesEmbedDescription);
      console.log('  --- END EMBED DESCRIPTION ---');
      summary.push(`Fetched rules embed: ${rulesEmbedDescription.length} chars`);
    } else {
      console.log('  WARNING: No embed found on rules message or message missing');
      summary.push('Rules embed: NOT FOUND');
    }

    // ─── STEP 2: Delete all 8 Dyno webhooks ──────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log('STEP 2: Delete Dyno webhooks');
    console.log('─'.repeat(60));

    let webhooks;
    try {
      webhooks = await guild.fetchWebhooks();
    } catch (e) {
      console.error('  Failed to fetch webhooks:', e.message);
      webhooks = new Map();
    }

    let deletedWebhooks = 0;
    for (const whId of DYNO_WEBHOOK_IDS) {
      const wh = webhooks.get(whId);
      if (wh) {
        try {
          await wh.delete('Replacing Dyno integrations with Cafe Utility');
          console.log(`  DELETED webhook ${whId} (${wh.name})`);
          deletedWebhooks++;
        } catch (e) {
          console.error(`  FAILED to delete webhook ${whId}: ${e.message}`);
        }
      } else {
        console.log(`  Webhook ${whId} not found (already deleted?)`);
      }
      await sleep(500);
    }
    summary.push(`Deleted ${deletedWebhooks}/${DYNO_WEBHOOK_IDS.length} Dyno webhooks`);

    // ─── STEP 3: Delete old Dyno reaction role messages ───────────────
    console.log('\n' + '─'.repeat(60));
    console.log('STEP 3: Delete old Dyno reaction role messages');
    console.log('─'.repeat(60));

    const reactChannel = await guild.channels.fetch(CHANNELS.reactRoles);
    let deletedReactMsgs = 0;
    for (const msgId of DYNO_REACTION_ROLE_MSGS) {
      try {
        const msg = await reactChannel.messages.fetch(msgId);
        await msg.delete();
        console.log(`  DELETED message ${msgId}`);
        deletedReactMsgs++;
      } catch (e) {
        console.error(`  FAILED to delete message ${msgId}: ${e.message}`);
      }
      await sleep(500);
    }
    summary.push(`Deleted ${deletedReactMsgs}/${DYNO_REACTION_ROLE_MSGS.length} Dyno reaction role messages`);

    // ─── STEP 4: Create new reaction role panels ──────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log('STEP 4: Create new reaction role panels');
    console.log('─'.repeat(60));

    const rrManager = new ReactionRoleManager(client);

    // Panel 1 — Streamer Role
    console.log('  Creating Streamer panel...');
    const streamerPanel = await rrManager.createReactionPanel(
      GUILD_ID,
      CHANNELS.reactRoles,
      'Streamer Role',
      'toggle',
      'button',
      [
        {
          roleId: '916381900065628200',
          emoji: '🎮',
          label: 'Streamer',
          name: 'Streamer',
          description: 'Get the Streamer role to let us know you stream!',
        },
      ],
      {
        title: 'Are you a Streamer?',
        description: "Click below to get the Streamer role and let everyone know when you're live!",
        color: '#f51111',
      }
    );
    if (streamerPanel) {
      console.log(`  Streamer panel created — message ${streamerPanel.messageId}, panel ${streamerPanel.panelId}`);
      summary.push(`Created Streamer reaction panel (msg ${streamerPanel.messageId})`);
    } else {
      console.error('  FAILED to create Streamer panel');
      summary.push('Streamer reaction panel: FAILED');
    }

    await sleep(1000);

    // Panel 2 — Color Roles
    console.log('  Creating Color Roles panel...');
    const colorPanel = await rrManager.createReactionPanel(
      GUILD_ID,
      CHANNELS.reactRoles,
      'Color Roles',
      'toggle',
      'button',
      [
        { roleId: '896495546053836861', emoji: '🔴', label: 'Red', name: 'Red' },
        { roleId: '896495711233917059', emoji: '🟠', label: 'Orange', name: 'Orange' },
        { roleId: '896495743618146324', emoji: '🔵', label: 'Blue', name: 'Blue' },
        { roleId: '896495764086353950', emoji: '🟣', label: 'Purple', name: 'Purple' },
        { roleId: '904429530167521321', emoji: '🟢', label: 'Green', name: 'Green' },
        { roleId: '904429670781575220', emoji: '🟡', label: 'Yellow', name: 'Yellow' },
      ],
      {
        title: 'Color Roles',
        description: 'Pick a color to display in the member list!',
        color: '#5865F2',
      }
    );
    if (colorPanel) {
      console.log(`  Color Roles panel created — message ${colorPanel.messageId}, panel ${colorPanel.panelId}`);
      summary.push(`Created Color Roles reaction panel (msg ${colorPanel.messageId})`);
    } else {
      console.error('  FAILED to create Color Roles panel');
      summary.push('Color Roles reaction panel: FAILED');
    }

    // ─── STEP 5: Delete old Dyno rules message & recreate ─────────────
    console.log('\n' + '─'.repeat(60));
    console.log('STEP 5: Replace Dyno rules embed with Cafe Utility');
    console.log('─'.repeat(60));

    if (rulesMessage) {
      try {
        await rulesMessage.delete();
        console.log(`  DELETED old rules message ${RULES_MSG_ID}`);
      } catch (e) {
        console.error(`  FAILED to delete old rules message: ${e.message}`);
      }
      await sleep(500);
    }

    if (rulesEmbedDescription) {
      const newRulesEmbed = new EmbedBuilder()
        .setColor('#8B4513')
        .setTitle(rulesEmbedTitle || 'Community Rules:')
        .setDescription(rulesEmbedDescription);

      try {
        const newRulesMsg = await rulesChannel.send({ embeds: [newRulesEmbed] });
        await newRulesMsg.react('👍');
        console.log(`  Sent new rules embed — message ${newRulesMsg.id}`);
        summary.push(`Created new rules embed (msg ${newRulesMsg.id})`);
      } catch (e) {
        console.error(`  FAILED to send new rules embed: ${e.message}`);
        summary.push('New rules embed: FAILED');
      }
    } else {
      console.log('  Skipping rules embed recreation — no description captured');
      summary.push('Rules embed recreation: SKIPPED (no description)');
    }

    // ─── STEP 6: Set leveling channel config ──────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log('STEP 6: Leveling channel configuration');
    console.log('─'.repeat(60));

    try {
      await pool.execute(
        "UPDATE guilds SET leveling_ignored_channels = NULL WHERE guild_id = ?",
        [GUILD_ID]
      );
      console.log('  Cleared leveling_ignored_channels for guild');
      summary.push('Cleared leveling_ignored_channels');
    } catch (e) {
      console.error(`  FAILED to update leveling config: ${e.message}`);
      summary.push('Leveling config update: FAILED');
    }

    // Note: There is no leveling_channel_id column in the guilds table.
    // The XP system uses leveling_enabled, leveling_xp_rate, leveling_xp_cooldown,
    // leveling_ignored_channels, and leveling_ignored_roles columns.
    console.log('  Note: No leveling_channel_id column exists. XP announcements');
    console.log('  are controlled by leveling_enabled, leveling_xp_rate, etc.');

    // ─── SUMMARY ──────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(80));
    console.log('  SUMMARY');
    console.log('='.repeat(80));
    for (const line of summary) {
      console.log(`  • ${line}`);
    }
    console.log('='.repeat(80));

  } catch (err) {
    console.error('FATAL ERROR:', err);
  } finally {
    client.destroy();
    await pool.end();
    process.exit(0);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    const token = await getBotToken();
    console.log('Logging in with Cafe Utility bot...');
    await client.login(token);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();
