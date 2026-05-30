# Voice Camp ("always stay") Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bot permanently occupy a configured "camp" voice channel per guild — joining on startup, following requesters to play music then returning home, and reconnecting if knocked out.

**Architecture:** Reuse the existing unused `music_config.default_voice_channel_id` column as the camp channel id. A new `core/voice-camp-manager.js` owns the camp lifecycle (join on ready, return-to-camp on queue empty, rejoin on disconnect); pure decision logic lives in `core/voice-camp-helpers.js` for testability. `index.js` calls into the manager from three existing player hooks. A `/music settings camp` admin subcommand configures it per guild.

**Tech Stack:** Node.js (ESM), discord.js v14, discord-player v7, MySQL (`utils/db.js`), Node built-in test runner (`node --test`).

---

### Task 1: Pure camp decision helpers (TDD)

Pure functions with no DB/Discord imports so the test runs without side effects (mirrors `core/fourthwall-helpers.js`).

**Files:**
- Create: `core/voice-camp-helpers.js`
- Test: `tests/voice-camp-helpers.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/voice-camp-helpers.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReturnToCamp, isVoiceChannelType } from '../core/voice-camp-helpers.js';
import { ChannelType } from 'discord.js';

test('shouldReturnToCamp: no camp configured -> false', () => {
    assert.equal(shouldReturnToCamp('A', null), false);
    assert.equal(shouldReturnToCamp(null, null), false);
});

test('shouldReturnToCamp: connected elsewhere -> true', () => {
    assert.equal(shouldReturnToCamp('A', 'CAMP'), true);
});

test('shouldReturnToCamp: already in camp -> false', () => {
    assert.equal(shouldReturnToCamp('CAMP', 'CAMP'), false);
});

test('shouldReturnToCamp: not connected but camp set -> true', () => {
    assert.equal(shouldReturnToCamp(null, 'CAMP'), true);
});

test('isVoiceChannelType: accepts voice and stage', () => {
    assert.equal(isVoiceChannelType(ChannelType.GuildVoice), true);
    assert.equal(isVoiceChannelType(ChannelType.GuildStageVoice), true);
});

test('isVoiceChannelType: rejects text', () => {
    assert.equal(isVoiceChannelType(ChannelType.GuildText), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/voice-camp-helpers.test.js`
Expected: FAIL — `Cannot find module '../core/voice-camp-helpers.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/voice-camp-helpers.js
import { ChannelType } from 'discord.js';

/**
 * Decide whether the bot should relocate to its camp channel.
 * Pure channel-id comparison; queue-state (idle) checks live in the manager.
 *
 * @param {string|null|undefined} currentChannelId  where the bot is now
 * @param {string|null|undefined} campChannelId      configured camp, or null
 * @returns {boolean}
 */
export function shouldReturnToCamp(currentChannelId, campChannelId) {
    if (!campChannelId) return false;        // no camp configured
    if (!currentChannelId) return true;      // not connected -> go to camp
    return currentChannelId !== campChannelId; // elsewhere -> return home
}

/** True if a Discord channel type can host a voice connection. */
export function isVoiceChannelType(type) {
    return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/voice-camp-helpers.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add core/voice-camp-helpers.js tests/voice-camp-helpers.test.js
git commit -m "feat(voice-camp): add pure camp decision helpers with tests"
```

---

### Task 2: Voice camp manager (lifecycle)

The stateful camp operations. Depends on Task 1 helpers and existing `getMusicConfig`.

**Files:**
- Create: `core/voice-camp-manager.js`

- [ ] **Step 1: Write the implementation**

```javascript
// core/voice-camp-manager.js
import { PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import { getMusicConfig } from '../utils/music_helpers.js';
import { shouldReturnToCamp, isVoiceChannelType } from './voice-camp-helpers.js';

/** Delay before reconnecting after an involuntary disconnect (ms). */
export const CAMP_REJOIN_DELAY_MS = 3000;

/** Read the configured camp channel id for a guild, or null. */
export async function getCampChannelId(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.default_voice_channel_id || null;
}

/**
 * Resolve + validate a guild's camp channel on a given client.
 * Returns the channel, or null (with a logged reason) if unusable.
 */
async function resolveCampChannel(client, guildId) {
    const campId = await getCampChannelId(guildId);
    if (!campId) return null;

    const channel = await client.channels.fetch(campId).catch(() => null);
    if (!channel || !isVoiceChannelType(channel.type)) {
        logger.warn(`[VoiceCamp] Camp channel ${campId} for guild ${guildId} is missing or not a voice channel`);
        return null;
    }

    const me = channel.guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) {
        logger.warn(`[VoiceCamp] Missing Connect permission for camp channel ${campId} in guild ${guildId}`);
        return null;
    }
    return channel;
}

/** Connect idle to a guild's camp channel (creating a queue if needed). */
export async function rejoinCamp(client, player, guildId) {
    const channel = await resolveCampChannel(client, guildId);
    if (!channel) return;

    try {
        const queue = player.nodes.get(guildId) ?? player.nodes.create(channel.guild, {
            metadata: { camp: true },
            selfDeaf: true,
            leaveOnEmpty: false,
            leaveOnEnd: false
        });
        if (queue.channel?.id === channel.id) return; // already there
        await queue.connect(channel);
        logger.info(`[VoiceCamp] Connected to camp channel ${channel.id} in guild ${guildId}`);
    } catch (err) {
        logger.error(`[VoiceCamp] Failed to join camp in guild ${guildId}: ${err.message}`);
    }
}

/** On client ready: join every configured camp channel in this client's own guilds. */
export async function joinCampChannels(client, player) {
    // Each client only sees its own guild subset — iterate this client's cache only.
    for (const [guildId] of client.guilds.cache) {
        await rejoinCamp(client, player, guildId);
    }
}

/**
 * Move an idle queue back to its guild's camp channel.
 * No-op if music is still active, no camp is set, or it's already in camp.
 * @returns {Promise<boolean>} whether it relocated
 */
export async function returnToCamp(player, queue) {
    const guildId = queue?.guild?.id;
    if (!guildId) return false;
    if (queue.isPlaying() || queue.tracks.size > 0) return false; // not idle yet

    const campId = await getCampChannelId(guildId);
    if (!shouldReturnToCamp(queue.channel?.id, campId)) return false;

    const client = player.client;
    const channel = await resolveCampChannel(client, guildId);
    if (!channel) return false;

    try {
        await queue.connect(channel);
        logger.info(`[VoiceCamp] Returned to camp channel ${channel.id} in guild ${guildId}`);
        return true;
    } catch (err) {
        logger.error(`[VoiceCamp] Failed to return to camp in guild ${guildId}: ${err.message}`);
        return false;
    }
}
```

- [ ] **Step 2: Verify it parses**

Run: `node --check core/voice-camp-manager.js`
Expected: no output (exit 0)

- [ ] **Step 3: Verify the existing test suite still passes**

Run: `node --test tests/voice-camp-helpers.test.js`
Expected: PASS (6 tests) — confirms the import graph loads.

- [ ] **Step 4: Commit**

```bash
git add core/voice-camp-manager.js
git commit -m "feat(voice-camp): add camp lifecycle manager (join/return/rejoin)"
```

---

### Task 3: Wire the manager into index.js player hooks

Three insertions inside `initializeManagers` (the `if (!client.player)` music block). `player` and `client` are both in scope at each site.

**Files:**
- Modify: `index.js` (startup join ~line 654; `emptyQueue` ~line 539; `disconnect` ~line 463)

- [ ] **Step 1: Add startup join after music panels load**

Find (around line 652-654):

```javascript
      } catch (error) {
        logger.error('[Music] Error loading music panels:', error);
      }

      logger.info('[Music] Music system fully initialized');
```

Replace with:

```javascript
      } catch (error) {
        logger.error('[Music] Error loading music panels:', error);
      }

      // Voice camp: join configured camp channels for this client's guilds (best-effort).
      try {
        const { joinCampChannels } = await import('./core/voice-camp-manager.js');
        await joinCampChannels(client, player);
      } catch (error) {
        logger.error('[VoiceCamp] Error joining camp channels on startup:', error);
      }

      logger.info('[Music] Music system fully initialized');
```

- [ ] **Step 2: Add return-to-camp in the emptyQueue handler**

Find (around line 535-539):

```javascript
          // 24/7 Mode: Don't disconnect even if queue is empty
          const is247 = await is247Enabled(queue.guild.id);
          if (is247) {
            logger.info(`[24/7] Keeping connection alive in guild ${queue.guild.id}`);
          }
```

Replace with:

```javascript
          // 24/7 Mode: Don't disconnect even if queue is empty
          const is247 = await is247Enabled(queue.guild.id);
          if (is247) {
            logger.info(`[24/7] Keeping connection alive in guild ${queue.guild.id}`);
          }

          // Voice camp: if a camp channel is configured, return home when idle.
          const { returnToCamp } = await import('./core/voice-camp-manager.js');
          await returnToCamp(player, queue);
```

- [ ] **Step 3: Add rejoin in the disconnect handler**

Find (around line 457-464):

```javascript
      player.events.on('disconnect', async (queue) => {
        logger.info(`[Music] Disconnected from voice in guild ${queue.guild.id}`);
        client.musicStatusManager?.removeMusicSession(queue.guild.id);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel();
        // 24/7 is now enforced by prevention: when enabled, the queue's leave
        // timers are never armed (see getLeaveOptions), so the bot never reaches
        // this handler from an empty channel/queue. No post-disconnect rejoin needed.
      });
```

Replace with:

```javascript
      player.events.on('disconnect', async (queue) => {
        logger.info(`[Music] Disconnected from voice in guild ${queue.guild.id}`);
        client.musicStatusManager?.removeMusicSession(queue.guild.id);
        client.musicPanelManager?.get(queue.guild.id)?.updatePanel();

        // Voice camp: if this guild has a camp channel, reconnect to it shortly after.
        // resolveCampChannel returns null for non-camp guilds, so this is a no-op there.
        const guildId = queue.guild.id;
        try {
          const { rejoinCamp, CAMP_REJOIN_DELAY_MS } = await import('./core/voice-camp-manager.js');
          setTimeout(() => {
            rejoinCamp(client, player, guildId).catch((err) =>
              logger.error(`[VoiceCamp] Rejoin after disconnect failed in guild ${guildId}: ${err.message}`)
            );
          }, CAMP_REJOIN_DELAY_MS);
        } catch (error) {
          logger.error(`[VoiceCamp] Error scheduling camp rejoin in guild ${guildId}: ${error.message}`);
        }
      });
```

- [ ] **Step 4: Verify index.js parses**

Run: `node --check index.js`
Expected: no output (exit 0)

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(voice-camp): wire camp join/return/rejoin into player hooks"
```

---

### Task 4: `handleCamp` settings handler

Admin-only handler in `controls.js` alongside `handle247`. Sets/clears `default_voice_channel_id`, and on set, immediately joins the channel via the manager. `ChannelType`, `EmbedBuilder`, `PermissionsBitField`, `updateMusicConfig` are already imported in this file.

**Files:**
- Modify: `handlers/music/controls.js` (add import; add `handleCamp` after `handle247`, which ends ~line 165)

- [ ] **Step 1: Extend the music_helpers import**

Find:

```javascript
import { checkMusicPermissions, updateMusicConfig, getMusicConfig, isVoteSkipEnabled, getVoteSkipPercentage, applyLeaveOptionsToQueue } from '../../utils/music_helpers.js';
```

Replace with:

```javascript
import { checkMusicPermissions, updateMusicConfig, getMusicConfig, isVoteSkipEnabled, getVoteSkipPercentage, applyLeaveOptionsToQueue } from '../../utils/music_helpers.js';
import { rejoinCamp } from '../../core/voice-camp-manager.js';
import { isVoiceChannelType } from '../../core/voice-camp-helpers.js';
```

- [ ] **Step 2: Add the handler immediately after `handle247`'s closing brace**

Insert after the `handle247` function (the `}` that closes it, around line 165, before the `handleAutoplay` JSDoc):

```javascript

/**
 * Handles the camp ("always stay") voice channel setting.
 * /music settings camp channel:<voice channel>  -> set + join
 * /music settings camp off                       -> clear
 */
export async function handleCamp(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions to configure the camp channel.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel'); // null => disable

    try {
        if (!channel) {
            await updateMusicConfig(interaction.guildId, { default_voice_channel_id: null });
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Camp Channel')
                .setDescription('Camp mode is now **disabled**. The bot will no longer be forced to stay in a voice channel.')
                .setTimestamp();
            logger.info(`[Camp] Disabled for guild ${interaction.guildId} by ${interaction.user.tag}`);
            return interaction.reply({ embeds: [embed] });
        }

        if (!isVoiceChannelType(channel.type)) {
            return interaction.reply({ content: 'Please select a voice channel.', ephemeral: true });
        }

        await updateMusicConfig(interaction.guildId, { default_voice_channel_id: channel.id });
        await rejoinCamp(interaction.client, interaction.client.player, interaction.guildId);

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Camp Channel')
            .setDescription(`Camp mode is now **enabled** for ${channel}. The bot will stay there and return after playing music.`)
            .setTimestamp();
        logger.info(`[Camp] Set to ${channel.id} for guild ${interaction.guildId} by ${interaction.user.tag}`);
        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        logger.error(`[Camp] Error: ${error.message}`);
        await interaction.reply({ content: `Failed to update camp channel: ${error.message}`, ephemeral: true });
    }
}
```

- [ ] **Step 3: Verify it parses**

Run: `node --check handlers/music/controls.js`
Expected: no output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add handlers/music/controls.js
git commit -m "feat(voice-camp): add /music settings camp handler"
```

---

### Task 5: `/music settings camp` subcommand (builder + dispatch)

Add the subcommand to the existing `settings` group and route it. `controlsHandlers` is already imported in `music.js`.

**Files:**
- Modify: `commands/music/music.js` (import ~line 1; builder ~line 116; dispatch ~line 225)

- [ ] **Step 1: Import ChannelType for the channel-type restriction**

Find:

```javascript
import { SlashCommandBuilder } from 'discord.js';
```

Replace with:

```javascript
import { SlashCommandBuilder, ChannelType } from 'discord.js';
```

- [ ] **Step 2: Add the subcommand builder after the `247` subcommand**

Find:

```javascript
                .addSubcommand(subcommand =>
                    subcommand.setName('247').setDescription('Toggle 24/7 mode (bot stays in voice channel)')
                        .addStringOption(option =>
                            option.setName('toggle').setDescription('Enable or disable 24/7 mode').setRequired(true)
                                .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })))
```

Replace with:

```javascript
                .addSubcommand(subcommand =>
                    subcommand.setName('247').setDescription('Toggle 24/7 mode (bot stays in voice channel)')
                        .addStringOption(option =>
                            option.setName('toggle').setDescription('Enable or disable 24/7 mode').setRequired(true)
                                .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })))
                .addSubcommand(subcommand =>
                    subcommand.setName('camp').setDescription('Set a voice channel the bot always stays in (leave empty to disable)')
                        .addChannelOption(option =>
                            option.setName('channel').setDescription('Voice channel to camp in (omit to disable)')
                                .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                                .setRequired(false)))
```

- [ ] **Step 3: Route the subcommand in the settings switch**

Find:

```javascript
                    case '247': await controlsHandlers.handle247(interaction); break;
```

Replace with:

```javascript
                    case '247': await controlsHandlers.handle247(interaction); break;
                    case 'camp': await controlsHandlers.handleCamp(interaction); break;
```

- [ ] **Step 4: Verify it parses**

Run: `node --check commands/music/music.js`
Expected: no output (exit 0)

- [ ] **Step 5: Commit**

```bash
git add commands/music/music.js
git commit -m "feat(voice-camp): add /music settings camp subcommand"
```

---

### Task 6: Configure the target guild + deploy

Set the camp channel for guild `844406178799943730` (VC `869428255223074886`) and deploy the new command. **Do not run a one-off bot session while PM2 is running** — only DB writes here, plus a deploy + restart.

**Files:**
- None (operational)

- [ ] **Step 1: Set the camp channel in the DB (safe while PM2 runs — config-only write)**

Run:

```bash
node --input-type=module -e "
import pool from './utils/db.js';
import { invalidateMusicConfigCache } from './utils/music_helpers.js';
await pool.execute('UPDATE music_config SET default_voice_channel_id = ? WHERE guild_id = ?', ['869428255223074886', '844406178799943730']);
invalidateMusicConfigCache('844406178799943730');
const [r] = await pool.query('SELECT guild_id, default_voice_channel_id, twenty_four_seven FROM music_config WHERE guild_id = ?', ['844406178799943730']);
console.log(JSON.stringify(r[0]));
process.exit(0);
"
```

Expected: `{"guild_id":"844406178799943730","default_voice_channel_id":"869428255223074886","twenty_four_seven":1}`

- [ ] **Step 2: Identify the bot serving the guild and deploy commands to it**

Guild `844406178799943730` maps to bot `1438897897289552054` (per `guild_bot_mapping`). If that is the default bot, deploy globally; if it is a custom bot, deploy guild-specific:

```bash
# Default bot (global):
node deploy-commands.js
# OR custom bot (guild-specific) — use the bot id:
node scripts/deploy-commands-to-bot.js 1438897897289552054
```

Expected: deploy script logs the music command among those registered.

- [ ] **Step 3: Restart the bot so startup join runs**

Run: `pm2 restart CertiFriedUtility`
Expected: PM2 shows the process restarted; logs include `[VoiceCamp] Connected to camp channel 869428255223074886 in guild 844406178799943730`.

- [ ] **Step 4: Manual verification (in Discord)**

- Bot is sitting in VC `869428255223074886` after restart.
- `/play` from a different VC → bot follows and plays; when the queue ends it returns to `869428255223074886`.
- Manually drag the bot out → within ~3s it rejoins `869428255223074886`.
- `/music settings camp` (no channel) → camp disabled; bot no longer forced to stay.

- [ ] **Step 5: Commit any notes (if applicable)**

No code changes in this task. If you updated operational docs, commit them; otherwise skip.

---

## Notes for the implementer

- **discord-player specifics:** `player.nodes.create(guild, opts)` returns a `GuildQueue`; `queue.connect(channelResolvable)` both joins and *moves* an existing connection (used for return-to-camp); `queue.channel` is the current voice channel or `null`. These are v7 APIs verified against `node_modules/discord-player/dist/index.d.ts`.
- **Why return-to-camp guards on `isPlaying()`/`tracks.size`:** the `emptyQueue` event also fires right before autoplay adds tracks. Relocating only when genuinely idle avoids yanking the bot away mid-autoplay.
- **Multi-bot safety:** `joinCampChannels` iterates `client.guilds.cache` (this client's own subset only) — never the shared `guilds` table.
- **PM2 rule:** never start a competing bot session (a script using a bot token) while PM2 runs. Task 6 Step 1 is a plain DB write and is safe; the actual voice join happens inside the already-running/restarted PM2 process.
