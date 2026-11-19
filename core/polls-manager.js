import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { getOrCreateUserEconomy, getEconomyConfig, logTransaction, formatMoney, economyStatus, ECONOMY_DISABLED_MESSAGE } from './economy-manager.js';
import { pickWinner, settleBets as settleBetMath, betError, HOUSE_RAKE } from './poll-bet-math.js';

const ENDS_FIELD = '⏰ Ends';
// Betting polls carry one field with the limits and the live pot. Older polls used the second name.
const BET_FIELD = '💰 Betting';
const OLD_BET_FIELD = '💰 Betting Enabled';
const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

class PollsManager {
  constructor(client) {
    this.client = client;
    this.checkInterval = null;
    logger.info('[PollsManager] Polls manager initialized');
  }

  startScheduler() {
    // Check every minute for polls that need to end
    this.checkInterval = setInterval(() => {
      this.checkExpiredPolls();
    }, 60 * 1000);

    logger.info('[PollsManager] Poll scheduler started (60s interval)');
  }

  stopScheduler() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      logger.info('[PollsManager] Poll scheduler stopped');
    }
  }

  /**
   * Whether this bot should act on a guild's polls. Every bot (default + custom) runs the minute
   * check over the whole polls table; each poll is ended by a bot that can see its guild (the
   * default bot sweeps guilds no bot can see). endPoll's guarded claim stops two bots that share
   * a guild from both ending — and paying out — the same poll.
   */
  servesGuild(guildId) {
    if (this.client?.guilds?.cache?.has(guildId)) return true;
    const manager = global.botManager;
    if (!manager?.clients || !manager.getClientForGuild) return true; // single-bot process
    return manager.getClientForGuild(guildId) === this.client;
  }

  async checkExpiredPolls() {
    try {
      const [polls] = await pool.execute(
        'SELECT id, guild_id FROM polls WHERE status = "active" AND ends_at IS NOT NULL AND ends_at <= NOW()'
      );

      const mine = polls.filter(p => this.servesGuild(p.guild_id));
      if (mine.length) {
        logger.info(`[PollsManager] Found ${mine.length} expired polls`);
        for (const poll of mine) {
          await this.endPoll(poll.id, 'Poll duration expired');
        }
      }
    } catch (error) {
      logger.error(`[PollsManager] Error checking expired polls: ${error.message}`);
    }

    await this.settleUnsettledBets();
  }

  /**
   * Restart safety for betting: an ended poll whose bets are still 'pending' (the process stopped
   * between ending the poll and paying out, or a payout failed) is settled here. Settlement is
   * idempotent per bet, and the winner is recomputed from the stored votes, which no longer change.
   */
  async settleUnsettledBets() {
    try {
      const [rows] = await pool.execute(
        `SELECT DISTINCT p.id, p.guild_id FROM polls p JOIN poll_bets b ON b.poll_id = p.id
          WHERE p.status <> 'active' AND b.payout_status = 'pending' LIMIT 20`
      );
      for (const row of rows) {
        if (!this.servesGuild(row.guild_id)) continue;
        const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [row.id]);
        if (poll) await this.settleBets(poll);
      }
    } catch (error) {
      logger.error(`[PollsManager] Error settling unsettled poll bets: ${error.message}`);
    }
  }

  async createPoll(guildId, channelId, creatorId, question, options, duration = null, allowMultiple = false, anonymous = false, allowWriteIn = false, bettingEnabled = false, minBet = 10, maxBet = 1000, hideResults = false) {
    try {
      if (options.length < 2 || options.length > 10) {
        throw new Error('Polls must have between 2 and 10 options');
      }

      // Betting is only allowed for single-choice polls
      if (bettingEnabled && allowMultiple) {
        throw new Error('Betting is only available for single-choice polls');
      }

      // Betting shows per-option pot distribution, which would leak the vote split
      // a hidden-results poll is meant to conceal — the two options are incompatible.
      if (bettingEnabled && hideResults) {
        throw new Error('Hidden results and betting can\'t be combined — a betting pot would reveal the vote split');
      }

      if (bettingEnabled) {
        // Bets are paid from the server's economy wallets, so the economy must not be switched off.
        if (await economyStatus(guildId) === 'disabled') {
          throw new Error('Betting needs the server economy, which is turned off');
        }
        minBet = Math.floor(Number(minBet));
        maxBet = Math.floor(Number(maxBet));
        if (!Number.isSafeInteger(minBet) || !Number.isSafeInteger(maxBet) || minBet < 1 || maxBet < minBet) {
          throw new Error('Bet limits must be whole numbers with 1 <= minimum <= maximum');
        }
      }

      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) throw new Error('Guild not found');

      const channel = guild.channels.cache.get(channelId);
      if (!channel) throw new Error('Channel not found');

      // Calculate end time
      const endsAt = duration ? new Date(Date.now() + duration * 1000) : null;

      logger.info(`[PollsManager] Duration calculation:`, {
        duration_seconds: duration,
        current_time: new Date(),
        ends_at: endsAt,
        duration_minutes: duration ? (duration / 60) : null
      });

      // Create embed
      const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('📊 ' + question)
        .setDescription(hideResults ? this.formatHiddenPollOptions(options) : this.formatPollOptions(options, {}))
        .setFooter({
          text: `Created by ${(await guild.members.fetch(creatorId)).user.tag}`
        });

      if (allowMultiple) {
        embed.addFields({ name: 'ℹ️ Voting', value: 'You can select multiple options' });
      }

      if (anonymous) {
        embed.addFields({ name: '🕵️ Privacy', value: 'Votes are anonymous' });
      }

      if (hideResults) {
        embed.addFields({ name: '🔒 Results', value: 'Hidden until the poll ends' });
      }

      if (allowWriteIn) {
        embed.addFields({ name: '✍️ Write-In', value: 'You can submit your own custom answer' });
      }

      this.setEndsField(embed, endsAt);

      if (bettingEnabled) {
        const economyConfig = await getEconomyConfig(guildId);
        this.setBetField(embed, { min_bet: minBet, max_bet: maxBet, status: 'active' }, { bets: 0, pot: 0 }, economyConfig);
      }

      // Create buttons
      const rows = this.createPollButtons(options, allowWriteIn, bettingEnabled);

      // Send poll message
      const message = await channel.send({ embeds: [embed], components: rows });

      // Save to database
      const [result] = await pool.execute(`
        INSERT INTO polls (guild_id, channel_id, message_id, creator_id, question, options, allow_multiple, anonymous, hide_results, allow_write_in, betting_enabled, min_bet, max_bet, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        guildId,
        channelId,
        message.id,
        creatorId,
        question,
        JSON.stringify(options),
        allowMultiple ? 1 : 0,
        anonymous ? 1 : 0,
        hideResults ? 1 : 0,
        allowWriteIn ? 1 : 0,
        bettingEnabled ? 1 : 0,
        minBet,
        maxBet,
        endsAt
      ]);

      logger.info(`[PollsManager] Created poll "${question}" in guild ${guildId}`, {
        guildId,
        pollId: result.insertId,
        optionCount: options.length,
        allowWriteIn
      });

      void logFeatureEvent(() => (guild), 'poll.created', () => ({
        title: '📊 Poll Created',
        description: `**${question}**`,
        fields: [
          ['Options', `${options.length}: ${options.slice(0, 3).join(', ')}${options.length > 3 ? ', …' : ''}`],
          ['Ends', endsAt ? `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` : 'No time limit'],
          ['Creator', userLabel(creatorId)], ['Channel', `<#${channel.id}>`],
          ['Settings', [allowMultiple && 'multiple choice', anonymous && 'anonymous', hideResults && 'hidden results', allowWriteIn && 'write-ins', bettingEnabled && `betting ${minBet}–${maxBet}`].filter(Boolean).join(', ')],
        ],
        url: message.url,
        avoidChannelIds: [channel.id],
      }));

      return { pollId: result.insertId, messageId: message.id };
    } catch (error) {
      logger.error(`[PollsManager] Failed to create poll: ${error.message}`);
      throw error;
    }
  }

  /**
   * The row under the vote buttons: write-in and/or "Place bet". Null when the poll has neither.
   */
  createControlRow(allowWriteIn = false, bettingEnabled = false) {
    if (!allowWriteIn && !bettingEnabled) return null;
    const row = new ActionRowBuilder();
    if (allowWriteIn) {
      row.addComponents(new ButtonBuilder()
        .setCustomId('poll_write_in')
        .setLabel('Write Your Own Answer')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✍️'));
    }
    if (bettingEnabled) {
      row.addComponents(new ButtonBuilder()
        .setCustomId('poll_bet')
        .setLabel('Place a Bet')
        .setStyle(ButtonStyle.Success)
        .setEmoji('💰'));
    }
    return row;
  }

  /** Show the betting limits and the live pot in the poll embed (one field, replaced in place). */
  setBetField(embed, poll, pot, economyConfig) {
    const money = (n) => (economyConfig ? formatMoney(Number(n) || 0, economyConfig) : `${(Number(n) || 0).toLocaleString()} coins`);
    const fields = (embed.data.fields || []).filter(f => f.name !== BET_FIELD && f.name !== OLD_BET_FIELD);
    const lines = [`Bets: ${money(poll.min_bet)} – ${money(poll.max_bet)} • one bet each`];
    lines.push(`Pot: ${money(pot.pot)} from ${pot.bets} ${pot.bets === 1 ? 'bet' : 'bets'}`);
    if (poll.status === 'active') lines.push(`Winners split the pot (${Math.round(HOUSE_RAKE * 100)}% house cut); a tie or no votes refunds every bet.`);
    fields.push({ name: BET_FIELD, value: lines.join('\n') });
    embed.setFields(fields);
    return embed;
  }

  async getPot(pollId) {
    const [[row]] = await pool.execute(
      'SELECT COUNT(*) AS bets, COALESCE(SUM(bet_amount), 0) AS pot FROM poll_bets WHERE poll_id = ?',
      [pollId]
    );
    return { bets: Number(row?.bets) || 0, pot: Number(row?.pot) || 0 };
  }

  createPollButtons(options, allowWriteIn = false, bettingEnabled = false) {
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let buttonsInRow = 0;

    const emojis = NUMBER_EMOJIS;

    for (let i = 0; i < options.length; i++) {
      if (buttonsInRow >= 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
        buttonsInRow = 0;
      }

      const button = new ButtonBuilder()
        .setCustomId(`poll_vote_${i}`)
        .setLabel(options[i])
        .setStyle(ButtonStyle.Primary)
        .setEmoji(emojis[i]);

      currentRow.addComponents(button);
      buttonsInRow++;
    }

    if (buttonsInRow > 0) rows.push(currentRow);

    // Write-in and betting buttons share one row under the vote buttons
    const control = this.createControlRow(allowWriteIn, bettingEnabled);
    if (control) rows.push(control);

    return rows;
  }

  async handleVote(interaction) {
    // The "Place a Bet" button reaches us through the same fallback as the vote buttons.
    if (interaction.customId === 'poll_bet') return this.showBetModal(interaction);
    if (!interaction.customId.startsWith('poll_vote_')) return false;

    try {
      await interaction.deferReply({ ephemeral: true });

      const optionIndex = parseInt(interaction.customId.replace('poll_vote_', ''));

      const [[poll]] = await pool.execute(
        'SELECT * FROM polls WHERE message_id = ? AND status = "active"',
        [interaction.message.id]
      );

      if (!poll) {
        await interaction.editReply('❌ This poll is no longer active.');
        return true;
      }

      // Parse votes
      const votes = poll.votes ? JSON.parse(poll.votes) : {};
      const userVotes = [].concat(votes[interaction.user.id] ?? []);

      // Check if already voted for this option
      if (userVotes.includes(optionIndex)) {
        await interaction.editReply('❌ You have already voted for this option!');
        return true;
      }

      // Handle single vs multiple choice
      if (!poll.allow_multiple && userVotes.length > 0) {
        await interaction.editReply('❌ You have already voted! This poll allows only one choice.');
        return true;
      }

      // Add vote
      userVotes.push(optionIndex);
      votes[interaction.user.id] = userVotes;

      // Update database
      await pool.execute(
        'UPDATE polls SET votes = ? WHERE id = ?',
        [JSON.stringify(votes), poll.id]
      );

      // Update poll display
      await this.updatePollDisplay(poll, votes);

      await interaction.editReply('✅ Your vote has been recorded!');

      logger.info(`[PollsManager] User ${interaction.user.tag} voted in poll ${poll.id}`, {
        guildId: poll.guild_id,
        pollId: poll.id,
        optionIndex
      });

      return true;
    } catch (error) {
      logger.error(`[PollsManager] Vote handling error: ${error.message}`);
      if (!interaction.replied) {
        await interaction.editReply('❌ An error occurred while processing your vote.').catch(() => {});
      }
      return true;
    }
  }

  async updatePollDisplay(poll, votes) {
    try {
      await this.renderPoll(poll, votes);
    } catch (error) {
      logger.error(`[PollsManager] Failed to update poll display: ${error.message}`);
    }
  }


  calculateVoteCounts(optionCount, votes) {
    const counts = Array(optionCount).fill(0);
    for (const userVotes of Object.values(votes)) {
      for (const index of [].concat(userVotes)) { // older rows stored a bare index
        if (index < optionCount) counts[index]++;
      }
    }
    return counts;
  }

  formatPollOptions(options, voteCounts = {}, totalVotes = 0, anonymous = false) {
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    return options.map((option, i) => {
      const count = voteCounts[i] || 0;
      const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      const bar = this.createProgressBar(percentage);

      return `${emojis[i]} **${option}**\n${bar} ${percentage}% (${count} ${count === 1 ? 'vote' : 'votes'})`;
    }).join('\n\n');
  }

  /**
   * Render options for a hide-results poll while it is still active. Shows the
   * option labels and a sealed-looking placeholder bar — no counts, no %, no
   * total — so viewers can't deduce the current split. On close, renderPoll
   * swaps back to formatPollOptions so the full tally lands in the same embed.
   */
  formatHiddenPollOptions(options) {
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const sealed = '░'.repeat(10);
    return options.map((option, i) => `${emojis[i]} **${option}**\n${sealed} 🔒 hidden`).join('\n\n');
  }

  createProgressBar(percentage, length = 10) {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  /** Option label by index across standard options and write-ins. */
  optionLabel(poll, index) {
    const standardOptions = JSON.parse(poll.options);
    const writeIns = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : [];
    if (index < standardOptions.length) return standardOptions[index];
    const w = writeIns[index - standardOptions.length];
    return w ? `"${w.answer}" (write-in)` : `Option ${index + 1}`;
  }

  /** Vote counts per option (standard + write-ins) and the single winner (null on a tie / no votes). */
  tally(poll) {
    const votes = poll.votes ? JSON.parse(poll.votes) : {};
    const standardOptions = JSON.parse(poll.options);
    const writeIns = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : [];
    const voteCounts = this.calculateVoteCounts(standardOptions.length + writeIns.length, votes);
    return { votes, voteCounts, winnerIndex: pickWinner(voteCounts), totalVotes: Object.keys(votes).length };
  }

  /**
   * @param {Object|null} [actor=null] who ended it (User/GuildMember/id); null = the scheduler ('Automatic')
   */
  async endPoll(pollId, reason = 'Manually ended', actor = null) {
    try {
      // Claim the poll: of two concurrent enders (the minute check on two bots, a moderator and the
      // timer) exactly one gets affectedRows = 1, so results and bet payouts happen once.
      const [claim] = await pool.execute(
        'UPDATE polls SET status = "ended", is_active = 0 WHERE id = ? AND status = "active"',
        [pollId]
      );
      if (claim.affectedRows === 0) return false;

      const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [pollId]);
      if (!poll) return false;

      const { votes, voteCounts, winnerIndex, totalVotes } = this.tally(poll);

      // Final display (no buttons on an ended poll)
      await this.updatePollDisplay(poll, votes);

      // Post results
      const guild = this.client.guilds.cache.get(poll.guild_id);
      const channel = guild?.channels.cache.get(poll.channel_id);
      if (channel) {
        let resultLine;
        if (winnerIndex !== null) {
          const n = voteCounts[winnerIndex];
          resultLine = `🏆 **Winner:** ${this.optionLabel(poll, winnerIndex)} (${n} ${n === 1 ? 'vote' : 'votes'})`;
        } else {
          const max = Math.max(0, ...voteCounts);
          if (max === 0) {
            resultLine = '🤷 **No votes were cast.**';
          } else {
            const tied = voteCounts.map((n, i) => (n === max ? this.optionLabel(poll, i) : null)).filter(Boolean);
            resultLine = `🤝 **Tie** between ${tied.join(', ')} (${max} ${max === 1 ? 'vote' : 'votes'} each)`;
          }
        }

        const embed = new EmbedBuilder()
          .setColor(themeColor(guild?.id, 'success'))
          .setTitle('📊 Poll Ended')
          .setDescription(`**${poll.question}**\n\n${resultLine}`)
          .addFields({ name: 'Reason', value: reason })
          .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(error =>
          logger.warn(`[PollsManager] Could not post results for poll ${pollId}: ${error.message}`));
      }

      // Settle bets (refunds on a tie / no votes). Idempotent; the minute sweep retries leftovers.
      if (poll.betting_enabled) {
        await this.settleBets(poll);
      }

      logger.info(`[PollsManager] Ended poll ${pollId}`, { pollId, reason, winnerIndex });

      // guild is undefined when the default bot sweeps a guild it can't see — nothing to log to then
      const topVotes = Math.max(0, ...voteCounts);
      void logFeatureEvent(() => (guild), 'poll.ended', () => ({
        title: '📊 Poll Ended',
        description: `**${poll.question}**`,
        fields: [
          ['Result', winnerIndex !== null ? `🏆 ${this.optionLabel(poll, winnerIndex)} (${voteCounts[winnerIndex]})`
            : topVotes === 0 ? 'No votes' : `Tie (${topVotes} each)`],
          ['Votes', totalVotes], ['Reason', reason], ['Ended By', userLabel(actor)], ['Channel', `<#${poll.channel_id}>`],
        ],
        url: `https://discord.com/channels/${poll.guild_id}/${poll.channel_id}/${poll.message_id}`,
        avoidChannelIds: [poll.channel_id],
      }));
      return true;
    } catch (error) {
      logger.error(`[PollsManager] Failed to end poll: ${error.message}`, { pollId });
      return false;
    }
  }

  async getActivePoll(messageId) {
    try {
      const [[poll]] = await pool.execute(
        'SELECT * FROM polls WHERE message_id = ? AND status = "active"',
        [messageId]
      );
      return poll || null;
    } catch (error) {
      logger.error(`[PollsManager] Failed to get poll: ${error.message}`);
      return null;
    }
  }

  /**
   * Show the end time as an embed field. Footers don't render <t:…> timestamps, so older
   * polls carried a raw "Ends <t:123:R>" in the footer — that part is stripped here.
   */
  setEndsField(embed, endsAt) {
    const fields = (embed.data.fields || []).filter(f => f.name !== ENDS_FIELD);
    if (endsAt) {
      const ts = Math.floor(new Date(endsAt).getTime() / 1000);
      fields.push({ name: ENDS_FIELD, value: `<t:${ts}:F> (<t:${ts}:R>)` });
    }
    embed.setFields(fields);

    const footer = embed.data.footer?.text;
    if (footer && / • Ends <t:\d+:R>/.test(footer)) embed.setFooter({ ...embed.data.footer, text: footer.replace(/ • Ends <t:\d+:R>/, '') });
    return embed;
  }

  /**
   * Edit an active poll's question and options in place.
   *
   * `edits` is an ordered list of { orig, text }: `orig` is the option's current index, or
   * null for a newly added option. Omitted options are removed — only allowed while they
   * hold no votes and no bets. Votes and bets are keyed by option index, so every stored
   * index (write-ins sit after the standard options) is remapped to its new position.
   *
   * `endsAt`: undefined leaves the end time alone, null removes the time limit, a Date
   * moves it (must be in the future — use endPoll to close a poll now). The minute
   * scheduler reads ends_at from the DB, so there is no timer to reschedule.
   *
   * `actor`: who edited it (User/GuildMember/id) for the server log; null = 'Automatic'.
   * `attempt` is internal (the retry below).
   */
  async editPoll(pollId, guildId, question, edits, endsAt = undefined, actor = null, attempt = 0) {
    const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ? AND guild_id = ?', [pollId, guildId]);
    if (!poll) throw new Error('Poll not found');
    if (poll.status !== 'active') throw new Error('Only active polls can be edited');

    question = String(question || '').trim();
    if (!question) throw new Error('Question cannot be empty');
    if (question.length > 250) throw new Error('Question must be 250 characters or fewer');

    const oldOptions = JSON.parse(poll.options);
    const votes = {};
    for (const [userId, v] of Object.entries(poll.votes ? JSON.parse(poll.votes) : {})) votes[userId] = [].concat(v);
    const writeIns = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : [];

    const newOptions = edits.map(e => String(e.text || '').trim());
    if (newOptions.length < 2 || newOptions.length > 10) throw new Error('Polls must have between 2 and 10 options');
    if (newOptions.some(t => !t)) throw new Error('Options cannot be empty');
    if (newOptions.some(t => t.length > 80)) throw new Error('Options must be 80 characters or fewer (Discord button limit)');

    if (endsAt !== undefined && endsAt !== null) {
      if (!(endsAt instanceof Date) || isNaN(endsAt)) throw new Error('Invalid end time');
      if (endsAt.getTime() < Date.now() + 60 * 1000) throw new Error('End time must be at least a minute from now — use End to close the poll now');
    }
    const newEndsAt = endsAt === undefined ? poll.ends_at : endsAt;
    const endsChanged = (newEndsAt ? new Date(newEndsAt).getTime() : null) !== (poll.ends_at ? new Date(poll.ends_at).getTime() : null);

    const kept = edits.map(e => e.orig).filter(o => o !== null && o !== undefined);
    if (kept.some(o => !Number.isInteger(o) || o < 0 || o >= oldOptions.length) || new Set(kept).size !== kept.length) {
      throw new Error('Invalid option mapping');
    }

    // old index -> new index, write-ins shifted to follow the new standard options
    const indexMap = new Map();
    edits.forEach((e, newIdx) => { if (e.orig !== null && e.orig !== undefined) indexMap.set(e.orig, newIdx); });
    writeIns.forEach((_, i) => indexMap.set(oldOptions.length + i, newOptions.length + i));

    const [bets] = poll.betting_enabled
      ? await pool.execute('SELECT DISTINCT option_index FROM poll_bets WHERE poll_id = ?', [pollId])
      : [[]];

    for (let i = 0; i < oldOptions.length; i++) {
      if (indexMap.has(i)) continue;
      const voted = Object.values(votes).some(v => v.includes(i));
      const bet = bets.some(b => b.option_index === i);
      if (voted || bet) throw new Error(`"${oldOptions[i]}" already has ${voted ? 'votes' : 'bets'} and can't be removed — rename it instead`);
    }

    const newVotes = {};
    for (const [userId, userVotes] of Object.entries(votes)) {
      const mapped = userVotes.map(i => indexMap.get(i)).filter(i => i !== undefined);
      if (mapped.length) newVotes[userId] = mapped;
    }

    const optionsChanged = JSON.stringify(newOptions) !== JSON.stringify(oldOptions);
    if (!optionsChanged && !endsChanged && question === poll.question) return { changed: false };

    // Guard on what we remapped: a vote or write-in landing mid-edit must not be overwritten
    const [result] = await pool.execute(
      'UPDATE polls SET question = ?, options = ?, votes = ?, ends_at = ? WHERE id = ? AND status = "active" AND votes <=> ? AND write_in_answers <=> ?',
      [question, JSON.stringify(newOptions), JSON.stringify(newVotes), newEndsAt, pollId, poll.votes, poll.write_in_answers]
    );
    if (result.affectedRows === 0) {
      // Re-read and remap against the newer votes; a poll that ended meanwhile is refused above
      if (attempt < 3) return this.editPoll(pollId, guildId, question, edits, endsAt, actor, attempt + 1);
      throw new Error('The poll is getting votes too fast to save right now — try again in a moment');
    }

    const moved = [...indexMap].filter(([from, to]) => from !== to);
    if (poll.betting_enabled && moved.length) {
      const cases = moved.map(() => 'WHEN ? THEN ?').join(' ');
      await pool.execute(
        `UPDATE poll_bets SET option_index = CASE option_index ${cases} ELSE option_index END WHERE poll_id = ?`,
        [...moved.flat(), pollId]
      );
    }

    const updated = { ...poll, question, options: JSON.stringify(newOptions), votes: JSON.stringify(newVotes), ends_at: newEndsAt };
    const rendered = await this.renderPoll(updated, newVotes, writeIns);

    logger.info(`[PollsManager] Edited poll ${pollId}`, { guildId, pollId, optionCount: newOptions.length, rendered });

    void logFeatureEvent(() => (this.client?.guilds?.cache?.get(guildId)), 'poll.edited', () => ({
      title: '✏️ Poll Edited',
      description: `**${question}**`,
      fields: [
        ['Changed', [question !== poll.question && 'question', optionsChanged && 'options', endsChanged && 'end time'].filter(Boolean).join(', ')],
        ['Previous Question', question !== poll.question ? poll.question : null],
        ['Options', optionsChanged ? newOptions.join(', ') : null],
        ['Ends', endsChanged ? (newEndsAt ? `<t:${Math.floor(new Date(newEndsAt).getTime() / 1000)}:R>` : 'No time limit') : null],
        ['Edited By', userLabel(actor)],
      ],
      url: `https://discord.com/channels/${poll.guild_id}/${poll.channel_id}/${poll.message_id}`,
    }));
    return { changed: true, rendered };
  }

  /**
   * Redraw a poll message: title, option list with write-ins, vote count, end time and every
   * vote button. The one renderer for votes, edits and write-in submissions — separate ones
   * drifted, and a vote redraw dropped write-ins from the list while their buttons stayed.
   * Other embed fields (voting mode, privacy, betting) are kept as they are.
   */
  async renderPoll(poll, votes, writeIns = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : []) {
    const channel = this.client.guilds.cache.get(poll.guild_id)?.channels.cache.get(poll.channel_id);
    const message = channel ? await channel.messages.fetch(poll.message_id).catch(() => null) : null;
    if (!message) return false;

    const options = JSON.parse(poll.options);
    const voteCounts = this.calculateVoteCounts(options.length + writeIns.length, votes);
    const totalVotes = Object.keys(votes).length;
    const active = (poll.status ?? 'active') === 'active';
    // Hidden-results polls conceal tallies while active; once ended, the full result is revealed.
    const concealTally = !!poll.hide_results && active;

    let description;
    if (concealTally) {
      description = this.formatHiddenPollOptions(options);
      if (writeIns.length) {
        // Show the write-in TEXT so people see what was submitted; conceal the vote count.
        const lines = await Promise.all(writeIns.map(async (w) => {
          const author = w.user_id ? await Promise.resolve(this.client.users?.fetch(w.user_id)).catch(() => null) : null;
          return `🔹 **${w.answer}**${author ? ` *(by ${author.username})*` : ''}\n${'░'.repeat(10)} 🔒 hidden`;
        }));
        description += '\n\n**✍️ Write-In Answers:**\n\n' + lines.join('\n\n');
      }
    } else {
      description = this.formatPollOptions(options, voteCounts, totalVotes);
      if (writeIns.length) {
        const lines = await Promise.all(writeIns.map(async (w, i) => {
          const count = voteCounts[options.length + i];
          const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
          const author = w.user_id ? await Promise.resolve(this.client.users?.fetch(w.user_id)).catch(() => null) : null;
          return `🔹 **${w.answer}**${author ? ` *(by ${author.username})*` : ''}\n${this.createProgressBar(percentage)} ${percentage}% (${count} ${count === 1 ? 'vote' : 'votes'})`;
        }));
        description += '\n\n**✍️ Write-In Answers:**\n\n' + lines.join('\n\n');
      }
    }

    // Footer: an active hidden poll shows a sealed indicator instead of a vote count,
    // so a slow reveal from "0 votes" to a specific number can't betray the pace of voting.
    const footerText = concealTally
      ? '🔒 Results hidden until the poll ends'
      : `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}${active ? '' : ' • poll ended'}`;
    const embed = (message.embeds[0] ? EmbedBuilder.from(message.embeds[0]) : new EmbedBuilder().setColor(themeColor(poll.guild_id, 'primary')))
      .setTitle('📊 ' + poll.question)
      .setDescription(description.slice(0, 4096))
      .setFooter({ text: footerText });
    this.setEndsField(embed, poll.ends_at);

    if (poll.betting_enabled) {
      try {
        this.setBetField(embed, poll, await this.getPot(poll.id), await getEconomyConfig(poll.guild_id));
      } catch (error) {
        logger.warn(`[PollsManager] Could not read the pot for poll ${poll.id}: ${error.message}`);
      }
    }

    // An ended poll keeps its results but loses its buttons.
    let components = [];
    if (active) {
      const rows = this.createPollButtons(options, false);
      let row = rows[rows.length - 1];
      writeIns.forEach((w, i) => {
        if (row.components.length >= 5) { row = new ActionRowBuilder(); rows.push(row); }
        row.addComponents(new ButtonBuilder()
          .setCustomId(`poll_vote_${options.length + i}`)
          .setLabel(w.answer.substring(0, 80))
          .setStyle(ButtonStyle.Success)
          .setEmoji('🔹'));
      });
      // Keep the write-in / bet row even when write-ins fill the vote rows (5 rows max).
      const control = this.createControlRow(!!poll.allow_write_in, !!poll.betting_enabled);
      components = control ? [...rows.slice(0, 4), control] : rows.slice(0, 5);
    }

    try {
      await message.edit({ embeds: [embed], components });
      return true;
    } catch (error) {
      logger.error(`[PollsManager] Failed to redraw poll ${poll.id}: ${error.message}`);
      return false;
    }
  }

  /**
   * Place a bet on a poll option.
   * The stake leaves the bettor's user_economy wallet and the bet row is written in one transaction
   * that also locks the poll row — endPoll's claim takes the same lock, so a bet can never land on a
   * poll after it ended. poll_bets has UNIQUE (poll_id, user_id): one bet per member per poll.
   */
  async placeBet(pollId, userId, optionIndex, betAmount) {
    try {
      const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [pollId]);

      if (!poll || poll.status !== 'active') {
        return { success: false, error: 'This poll is no longer active.' };
      }

      if (!poll.betting_enabled) {
        return { success: false, error: 'Betting is not enabled for this poll.' };
      }

      if (await economyStatus(poll.guild_id) === 'disabled') {
        return { success: false, error: ECONOMY_DISABLED_MESSAGE };
      }

      const optionCount = JSON.parse(poll.options).length + (poll.write_in_answers ? JSON.parse(poll.write_in_answers).length : 0);
      const invalid = betError({
        optionIndex, amount: betAmount, optionCount,
        minBet: Number(poll.min_bet) || 1, maxBet: Number(poll.max_bet) || 1,
      });
      if (invalid) return { success: false, error: invalid };

      const [[existingBet]] = await pool.execute(
        'SELECT option_index, bet_amount FROM poll_bets WHERE poll_id = ? AND user_id = ?',
        [pollId, userId]
      );
      if (existingBet) {
        return { success: false, error: `You already bet ${Number(existingBet.bet_amount).toLocaleString()} on option ${existingBet.option_index + 1} in this poll.` };
      }

      // Bets are paid from the guild's live economy wallet (user_economy)
      const economyConfig = await getEconomyConfig(poll.guild_id);
      await getOrCreateUserEconomy(poll.guild_id, userId, economyConfig);

      let walletBefore;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        const [[locked]] = await connection.execute('SELECT status FROM polls WHERE id = ? FOR UPDATE', [pollId]);
        if (!locked || locked.status !== 'active') {
          await connection.rollback();
          return { success: false, error: 'This poll just ended.' };
        }

        const [walletRows] = await connection.execute(
          'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ? FOR UPDATE',
          [poll.guild_id, userId]
        );
        walletBefore = Number(walletRows[0]?.wallet ?? 0);

        if (walletBefore < betAmount) {
          await connection.rollback();
          return { success: false, error: `You only have ${formatMoney(walletBefore, economyConfig)} in your wallet.` };
        }

        await connection.execute(
          'UPDATE user_economy SET wallet = wallet - ?, total_spent = total_spent + ? WHERE guild_id = ? AND user_id = ?',
          [betAmount, betAmount, poll.guild_id, userId]
        );

        await connection.execute(
          'INSERT INTO poll_bets (poll_id, user_id, option_index, bet_amount) VALUES (?, ?, ?, ?)',
          [pollId, userId, optionIndex, betAmount]
        );

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        if (error?.code === 'ER_DUP_ENTRY') return { success: false, error: 'You have already placed a bet on this poll.' };
        throw error;
      } finally {
        connection.release();
      }

      // Bookkeeping after the money moved: failures are logged, never surfaced as a failed bet
      try {
        await logTransaction(poll.guild_id, userId, 'gamble', -betAmount, walletBefore, walletBefore - betAmount,
          `Poll #${pollId} bet on option ${optionIndex + 1}`);
      } catch (error) {
        logger.error(`[PollsManager] Failed to log bet transaction: ${error.message}`, { pollId, userId, betAmount });
      }

      try {
        await pool.execute(
          `INSERT INTO poll_betting_stats (poll_id, total_bets, total_wagered)
           VALUES (?, 1, ?)
           ON DUPLICATE KEY UPDATE
             total_bets = total_bets + 1,
             total_wagered = total_wagered + ?`,
          [pollId, betAmount, betAmount]
        );
      } catch (error) {
        logger.error(`[PollsManager] Failed to update betting stats: ${error.message}`, { pollId });
      }

      logger.info(`[PollsManager] User ${userId} placed bet of ${betAmount} on option ${optionIndex}`, {
        pollId,
        userId,
        optionIndex,
        betAmount
      });

      return { success: true, poll, walletAfter: walletBefore - betAmount };
    } catch (error) {
      logger.error(`[PollsManager] Failed to place bet: ${error.message}`, { pollId, userId });
      return { success: false, error: 'An error occurred while placing your bet.' };
    }
  }

  /**
   * "Place a Bet" button: open the bet form for the poll on this message.
   */
  async showBetModal(interaction) {
    try {
      const poll = await this.getActivePoll(interaction.message.id);
      if (!poll || !poll.betting_enabled) {
        await interaction.reply({ content: '❌ This poll is not taking bets any more.', ephemeral: true });
        return true;
      }
      if (await economyStatus(poll.guild_id) === 'disabled') {
        await interaction.reply({ content: ECONOMY_DISABLED_MESSAGE, ephemeral: true });
        return true;
      }
      const [[existing]] = await pool.execute(
        'SELECT option_index, bet_amount FROM poll_bets WHERE poll_id = ? AND user_id = ?',
        [poll.id, interaction.user.id]
      );
      if (existing) {
        await interaction.reply({
          content: `You already bet ${Number(existing.bet_amount).toLocaleString()} on **${this.optionLabel(poll, existing.option_index)}**.`,
          ephemeral: true
        });
        return true;
      }

      const options = JSON.parse(poll.options);
      const writeIns = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : [];
      const all = [...options, ...writeIns.map(w => w.answer)];
      const legend = all.map((o, i) => `${i + 1} ${o}`).join(' · ');

      const modal = new ModalBuilder()
        .setCustomId(`poll_bet_modal:${poll.id}`)
        .setTitle('Place a bet');
      const optionInput = new TextInputBuilder()
        .setCustomId('option')
        .setLabel(`Option number (1-${all.length})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3)
        .setPlaceholder(legend.slice(0, 100));
      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Bet amount')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(12)
        .setPlaceholder(`${Number(poll.min_bet).toLocaleString()} - ${Number(poll.max_bet).toLocaleString()}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(optionInput),
        new ActionRowBuilder().addComponents(amountInput)
      );
      await interaction.showModal(modal);
      return true;
    } catch (error) {
      logger.error(`[PollsManager] Bet button failed: ${error.message}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Could not open the bet form — try again.', ephemeral: true }).catch(() => {});
      }
      return true;
    }
  }

  /**
   * Bet form submitted (modal customId poll_bet_modal:<pollId>).
   */
  async handleBetModal(interaction) {
    const pollId = parseInt(interaction.customId.split(':')[1], 10);
    const optionRaw = String(interaction.fields.getTextInputValue('option') || '').trim();
    const amountRaw = String(interaction.fields.getTextInputValue('amount') || '').replace(/[,\s]/g, '');
    const optionNumber = /^\d+$/.test(optionRaw) ? parseInt(optionRaw, 10) : NaN;
    const amount = /^\d+$/.test(amountRaw) ? parseInt(amountRaw, 10) : NaN;

    if (!Number.isInteger(pollId)) {
      return interaction.reply({ content: '❌ That bet form is no longer valid.', ephemeral: true });
    }
    if (!Number.isInteger(optionNumber) || !Number.isSafeInteger(amount)) {
      return interaction.reply({ content: '❌ Type the option as a number (e.g. 2) and the bet as a whole number (e.g. 100).', ephemeral: true });
    }

    const result = await this.placeBet(pollId, interaction.user.id, optionNumber - 1, amount);
    if (!result.success) {
      return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    }

    const economyConfig = await getEconomyConfig(result.poll.guild_id);
    await interaction.reply({
      content: `💰 You bet ${formatMoney(amount, economyConfig)} on **${this.optionLabel(result.poll, optionNumber - 1)}**. `
        + 'If it wins you share the pot with the other winners; a tie or no votes refunds you.',
      ephemeral: true
    });

    const [[fresh]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [pollId]);
    if (fresh) await this.updatePollDisplay(fresh, fresh.votes ? JSON.parse(fresh.votes) : {});
  }

  /**
   * Settle every still-pending bet of an ended poll (idempotent; safe to call again).
   * Winners split the pot pro rata after the house rake; a tie or no votes refunds every stake;
   * if nobody backed the winner every bet is lost. Each bet is claimed (payout_status 'pending' ->
   * outcome) in the same transaction that credits the wallet, so nobody is paid twice.
   */
  async settleBets(poll) {
    try {
      const { winnerIndex } = this.tally(poll);
      const [bets] = await pool.execute(
        'SELECT id, user_id, option_index, bet_amount, payout_status FROM poll_bets WHERE poll_id = ?',
        [poll.id]
      );
      if (bets.length === 0) return null;

      const result = settleBetMath(bets, winnerIndex);
      let settledNow = 0;
      for (const bet of bets) {
        if (bet.payout_status !== 'pending') continue;
        try {
          if (await this.applyBetOutcome(poll, bet, result.outcomes.get(bet.id))) settledNow++;
        } catch (error) {
          logger.error(`[PollsManager] Settling bet ${bet.id} failed (retried by the minute check): ${error.message}`, {
            pollId: poll.id, userId: bet.user_id
          });
        }
      }

      try {
        await pool.execute(
          `INSERT INTO poll_betting_stats (poll_id, total_bets, total_wagered, total_paid_out, house_profit)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE total_bets = VALUES(total_bets), total_wagered = VALUES(total_wagered),
                                   total_paid_out = VALUES(total_paid_out), house_profit = VALUES(house_profit)`,
          [poll.id, bets.length, result.totalWagered, result.totalPaid, result.houseProfit]
        );
      } catch (error) {
        logger.error(`[PollsManager] Failed to update betting stats: ${error.message}`, { pollId: poll.id });
      }

      if (settledNow > 0) await this.announcePayouts(poll, bets, result, winnerIndex);

      logger.info(`[PollsManager] Settled ${settledNow} bet(s) for poll ${poll.id}`, {
        pollId: poll.id, winnerIndex, refunded: result.refunded, totalWagered: result.totalWagered, totalPaid: result.totalPaid
      });
      return result;
    } catch (error) {
      logger.error(`[PollsManager] Failed to settle bets: ${error.message}`, { pollId: poll?.id });
      return null;
    }
  }

  /**
   * Apply one bet's outcome: claim the row and credit the wallet together.
   * @returns {Promise<boolean>} true when this call settled it
   */
  async applyBetOutcome(poll, bet, outcome) {
    if (!outcome) return false;
    const payout = Math.max(0, Math.floor(Number(outcome.payout) || 0));
    const stake = Number(bet.bet_amount) || 0;
    let before = null;
    let claimed = false;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [claim] = await connection.execute(
        `UPDATE poll_bets SET payout_status = ?, payout_amount = ?, paid_out = ?, paid_out_at = IF(? > 0, NOW(), NULL)
          WHERE id = ? AND payout_status = 'pending'`,
        [outcome.status, payout, payout > 0 ? 1 : 0, payout, bet.id]
      );
      claimed = claim.affectedRows === 1;
      if (claimed && payout > 0) {
        const [w] = await connection.execute(
          'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ? FOR UPDATE',
          [poll.guild_id, bet.user_id]
        );
        if (!w.length) {
          await connection.execute(
            'INSERT IGNORE INTO user_economy (guild_id, user_id, wallet, bank) VALUES (?, ?, 0, 0)',
            [poll.guild_id, bet.user_id]
          );
        }
        before = Number(w[0]?.wallet ?? 0);
        const profit = outcome.status === 'won' ? Math.max(0, payout - stake) : 0;
        await connection.execute(
          'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
          [payout, profit, poll.guild_id, bet.user_id]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    if (before !== null) {
      try {
        // A refund is not winnings: it is logged as a plain credit so it doesn't count toward
        // "earn coins" challenges; real winnings stay 'gamble' like the stake.
        const refunded = outcome.status === 'refunded';
        await logTransaction(poll.guild_id, bet.user_id, refunded ? 'reward' : 'gamble', payout, before, before + payout,
          refunded ? `Poll #${poll.id} bet refunded (tie or no votes)` : `Poll #${poll.id} bet won`);
      } catch (error) {
        logger.error(`[PollsManager] Failed to log payout transaction: ${error.message}`, { pollId: poll.id, userId: bet.user_id, payout });
      }
    }
    return claimed;
  }

  async announcePayouts(poll, bets, result, winnerIndex) {
    const guild = this.client.guilds.cache.get(poll.guild_id);
    const channel = guild?.channels.cache.get(poll.channel_id);
    if (!channel) return;
    try {
      const economyConfig = await getEconomyConfig(poll.guild_id);
      const money = (n) => formatMoney(Number(n) || 0, economyConfig);
      const winners = [...result.outcomes.entries()].filter(([, o]) => o.status === 'won');
      let summary;
      if (result.refunded) summary = 'No clear winner — every bet has been refunded.';
      else if (!winners.length) summary = `Nobody backed **${this.optionLabel(poll, winnerIndex)}** — the house keeps the pot.`;
      else summary = `Bets on **${this.optionLabel(poll, winnerIndex)}** split the pot.`;

      const embed = new EmbedBuilder()
        .setColor(themeColor(guild?.id, 'warning'))
        .setTitle('💰 Betting Payouts Processed')
        .setDescription(`**${poll.question}**\n${summary}`)
        .addFields(
          { name: 'Total Wagered', value: money(result.totalWagered), inline: true },
          { name: result.refunded ? 'Refunded' : 'Winners', value: result.refunded ? `${bets.length} ${bets.length === 1 ? 'bet' : 'bets'}` : `${winners.length} ${winners.length === 1 ? 'person' : 'people'}`, inline: true },
          { name: result.refunded ? 'Total Refunded' : 'Total Paid Out', value: money(result.totalPaid), inline: true }
        )
        .setTimestamp();

      if (winners.length) {
        const byId = new Map(bets.map(b => [b.id, b]));
        const lines = winners
          .sort((a, b) => b[1].payout - a[1].payout)
          .slice(0, 15)
          .map(([id, o]) => `<@${byId.get(id)?.user_id}> — ${money(o.payout)}`);
        embed.addFields({ name: 'Payouts', value: lines.join('\n').slice(0, 1024) });
      }

      await channel.send({ embeds: [embed], allowedMentions: { users: [] } });
    } catch (error) {
      logger.warn(`[PollsManager] Could not post bet payouts for poll ${poll.id}: ${error.message}`);
    }
  }

  /**
   * Refund every pending bet of a poll — call BEFORE deleting a betting poll (poll_bets rows
   * cascade-delete with the poll, so the stakes would otherwise vanish). Idempotent.
   * @returns {Promise<number>} bets refunded
   */
  async refundBets(pollId, reason = 'Poll removed') {
    const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [pollId]);
    if (!poll) return 0;
    const [bets] = await pool.execute(
      'SELECT id, user_id, option_index, bet_amount, payout_status FROM poll_bets WHERE poll_id = ? AND payout_status = "pending"',
      [pollId]
    );
    let n = 0;
    for (const bet of bets) {
      try {
        if (await this.applyBetOutcome(poll, bet, { status: 'refunded', payout: Number(bet.bet_amount) || 0 })) n++;
      } catch (error) {
        logger.error(`[PollsManager] Refunding bet ${bet.id} failed: ${error.message}`, { pollId, userId: bet.user_id });
      }
    }
    if (n) logger.info(`[PollsManager] Refunded ${n} bet(s) on poll ${pollId}: ${reason}`);
    return n;
  }

  /**
   * Get betting stats for a poll
   */
  async getBettingStats(pollId) {
    try {
      const [[stats]] = await pool.execute(
        'SELECT * FROM poll_betting_stats WHERE poll_id = ?',
        [pollId]
      );

      const [bets] = await pool.execute(
        'SELECT option_index, COUNT(*) as bet_count, SUM(bet_amount) as total_on_option FROM poll_bets WHERE poll_id = ? GROUP BY option_index',
        [pollId]
      );

      return {
        stats: stats || null,
        optionBets: bets
      };
    } catch (error) {
      logger.error(`[PollsManager] Failed to get betting stats: ${error.message}`);
      return { stats: null, optionBets: [] };
    }
  }
}

export default PollsManager;
