import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

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

  async checkExpiredPolls() {
    try {
      const [polls] = await pool.execute(
        'SELECT * FROM polls WHERE status = "active" AND ends_at IS NOT NULL AND ends_at <= NOW()'
      );

      if (polls.length === 0) return;

      logger.info(`[PollsManager] Found ${polls.length} expired polls`);

      for (const poll of polls) {
        await this.endPoll(poll.id, 'Poll duration expired');
      }
    } catch (error) {
      logger.error(`[PollsManager] Error checking expired polls: ${error.message}`);
    }
  }

  async createPoll(guildId, channelId, creatorId, question, options, duration = null, allowMultiple = false, anonymous = false, allowWriteIn = false, bettingEnabled = false, minBet = 10, maxBet = 1000) {
    try {
      if (options.length < 2 || options.length > 10) {
        throw new Error('Polls must have between 2 and 10 options');
      }

      // Betting is only allowed for single-choice polls
      if (bettingEnabled && allowMultiple) {
        throw new Error('Betting is only available for single-choice polls');
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
        .setColor('#5865F2')
        .setTitle('📊 ' + question)
        .setDescription(this.formatPollOptions(options, {}))
        .setFooter({
          text: `Created by ${(await guild.members.fetch(creatorId)).user.tag}${endsAt ? ` • Ends <t:${Math.floor(endsAt.getTime() / 1000)}:R>` : ''}`
        });

      if (allowMultiple) {
        embed.addFields({ name: 'ℹ️ Voting', value: 'You can select multiple options' });
      }

      if (anonymous) {
        embed.addFields({ name: '🕵️ Privacy', value: 'Votes are anonymous' });
      }

      if (allowWriteIn) {
        embed.addFields({ name: '✍️ Write-In', value: 'You can submit your own custom answer' });
      }

      if (bettingEnabled) {
        embed.addFields({ name: '💰 Betting Enabled', value: `Place bets: ${minBet.toLocaleString()} - ${maxBet.toLocaleString()} coins` });
      }

      // Create buttons
      const rows = this.createPollButtons(options, allowWriteIn);

      // Send poll message
      const message = await channel.send({ embeds: [embed], components: rows });

      // Save to database
      const [result] = await pool.execute(`
        INSERT INTO polls (guild_id, channel_id, message_id, creator_id, question, options, allow_multiple, anonymous, allow_write_in, betting_enabled, min_bet, max_bet, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        guildId,
        channelId,
        message.id,
        creatorId,
        question,
        JSON.stringify(options),
        allowMultiple ? 1 : 0,
        anonymous ? 1 : 0,
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

      return { pollId: result.insertId, messageId: message.id };
    } catch (error) {
      logger.error(`[PollsManager] Failed to create poll: ${error.message}`);
      throw error;
    }
  }

  createPollButtons(options, allowWriteIn = false) {
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let buttonsInRow = 0;

    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

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

    // Add write-in button if enabled
    if (allowWriteIn) {
      const writeInRow = new ActionRowBuilder();
      const writeInButton = new ButtonBuilder()
        .setCustomId('poll_write_in')
        .setLabel('Write Your Own Answer')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✍️');

      writeInRow.addComponents(writeInButton);
      rows.push(writeInRow);
    }

    return rows;
  }

  async handleVote(interaction) {
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
      const userVotes = votes[interaction.user.id] || [];

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
      const guild = this.client.guilds.cache.get(poll.guild_id);
      if (!guild) return;

      const channel = guild.channels.cache.get(poll.channel_id);
      if (!channel) return;

      const message = await channel.messages.fetch(poll.message_id).catch(() => null);
      if (!message) return;

      const options = JSON.parse(poll.options);
      const voteCounts = this.calculateVoteCounts(options.length, votes);
      const totalVotes = Object.keys(votes).length;

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('📊 ' + poll.question)
        .setDescription(this.formatPollOptions(options, voteCounts, totalVotes, poll.anonymous === 1))
        .setFooter({ text: `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}` });

      await message.edit({ embeds: [embed] });
    } catch (error) {
      logger.error(`[PollsManager] Failed to update poll display: ${error.message}`);
    }
  }

  calculateVoteCounts(optionCount, votes) {
    const counts = Array(optionCount).fill(0);
    for (const userVotes of Object.values(votes)) {
      for (const index of userVotes) {
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

  createProgressBar(percentage, length = 10) {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  async endPoll(pollId, reason = 'Manually ended') {
    try {
      const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [pollId]);
      if (!poll || poll.status !== 'active') return false;

      // Mark as ended
      await pool.execute('UPDATE polls SET status = "ended", is_active = 0 WHERE id = ?', [pollId]);

      // Update final display
      const votes = poll.votes ? JSON.parse(poll.votes) : {};
      await this.updatePollDisplay(poll, votes);

      // Post results
      const guild = this.client.guilds.cache.get(poll.guild_id);
      if (guild) {
        const channel = guild.channels.cache.get(poll.channel_id);
        if (channel) {
          const standardOptions = JSON.parse(poll.options);
          const writeInAnswers = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : [];

          // Calculate total option count (standard + write-ins)
          const totalOptionCount = standardOptions.length + writeInAnswers.length;
          const voteCounts = this.calculateVoteCounts(totalOptionCount, votes);
          const totalVotes = Object.keys(votes).length;
          const winnerIndex = voteCounts.indexOf(Math.max(...voteCounts));

          // Determine winner option text
          let winnerText;
          if (winnerIndex < standardOptions.length) {
            winnerText = standardOptions[winnerIndex];
          } else {
            const writeInIndex = winnerIndex - standardOptions.length;
            winnerText = `"${writeInAnswers[writeInIndex].answer}" (write-in)`;
          }

          const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('📊 Poll Ended')
            .setDescription(`**${poll.question}**\n\n🏆 **Winner:** ${winnerText} (${voteCounts[winnerIndex]} ${voteCounts[winnerIndex] === 1 ? 'vote' : 'votes'})`)
            .addFields({ name: 'Reason', value: reason })
            .setTimestamp();

          await channel.send({ embeds: [embed] });
        }
      }

      // Process betting payouts if betting was enabled
      if (poll.betting_enabled) {
        await this.processBettingPayouts(poll, winnerIndex);
      }

      logger.info(`[PollsManager] Ended poll ${pollId}`, { pollId, reason });
      return true;
    } catch (error) {
      logger.error(`[PollsManager] Failed to end poll: ${error.message}`);
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
   * Place a bet on a poll option
   */
  async placeBet(pollId, userId, optionIndex, betAmount) {
    try {
      // Get poll details
      const [[poll]] = await pool.execute('SELECT * FROM polls WHERE id = ?', [pollId]);

      if (!poll || poll.status !== 'active') {
        return { success: false, error: 'Poll is not active' };
      }

      if (!poll.betting_enabled) {
        return { success: false, error: 'Betting is not enabled for this poll' };
      }

      // Validate bet amount
      if (betAmount < poll.min_bet || betAmount > poll.max_bet) {
        return { success: false, error: `Bet must be between ${poll.min_bet} and ${poll.max_bet} coins` };
      }

      // Check if user already has a bet
      const [[existingBet]] = await pool.execute(
        'SELECT * FROM poll_bets WHERE poll_id = ? AND user_id = ?',
        [pollId, userId]
      );

      if (existingBet) {
        return { success: false, error: 'You have already placed a bet on this poll' };
      }

      // Check user's balance
      const [[economy]] = await pool.execute(
        'SELECT balance FROM economy WHERE user_id = ?',
        [userId]
      );

      const balance = economy ? economy.balance : 0;
      if (balance < betAmount) {
        return { success: false, error: 'Insufficient balance' };
      }

      // Deduct bet amount from user's balance
      await pool.execute(
        'UPDATE economy SET balance = balance - ? WHERE user_id = ?',
        [betAmount, userId]
      );

      // Place the bet
      await pool.execute(
        'INSERT INTO poll_bets (poll_id, user_id, option_index, bet_amount) VALUES (?, ?, ?, ?)',
        [pollId, userId, optionIndex, betAmount]
      );

      // Update stats
      await pool.execute(
        `INSERT INTO poll_betting_stats (poll_id, total_bets, total_wagered)
         VALUES (?, 1, ?)
         ON DUPLICATE KEY UPDATE
           total_bets = total_bets + 1,
           total_wagered = total_wagered + ?`,
        [pollId, betAmount, betAmount]
      );

      logger.info(`[PollsManager] User ${userId} placed bet of ${betAmount} on option ${optionIndex}`, {
        pollId,
        userId,
        optionIndex,
        betAmount
      });

      return { success: true };
    } catch (error) {
      logger.error(`[PollsManager] Failed to place bet: ${error.message}`);
      return { success: false, error: 'An error occurred while placing your bet' };
    }
  }

  /**
   * Process betting payouts when poll ends
   */
  async processBettingPayouts(poll, winningOptionIndex) {
    try {
      // Get all bets
      const [bets] = await pool.execute(
        'SELECT * FROM poll_bets WHERE poll_id = ?',
        [poll.id]
      );

      if (bets.length === 0) {
        logger.info(`[PollsManager] No bets to process for poll ${poll.id}`);
        return;
      }

      // Calculate total wagered and bets on winning option
      const totalWagered = bets.reduce((sum, bet) => sum + bet.bet_amount, 0);
      const winningBets = bets.filter(bet => bet.option_index === winningOptionIndex);
      const totalWinningBets = winningBets.reduce((sum, bet) => sum + bet.bet_amount, 0);

      if (winningBets.length === 0) {
        // No one bet on the winning option - house wins all
        await pool.execute(
          'UPDATE poll_bets SET payout_status = "lost" WHERE poll_id = ?',
          [poll.id]
        );

        await pool.execute(
          'UPDATE poll_betting_stats SET house_profit = ? WHERE poll_id = ?',
          [totalWagered, poll.id]
        );

        logger.info(`[PollsManager] House wins all bets for poll ${poll.id} (${totalWagered} coins)`);
        return;
      }

      // Calculate payouts (distribute total pot among winners proportionally)
      // House takes 5% rake
      const houseRake = Math.floor(totalWagered * 0.05);
      const payoutPool = totalWagered - houseRake;

      let totalPaidOut = 0;

      // Pay out winners
      for (const bet of winningBets) {
        const proportion = bet.bet_amount / totalWinningBets;
        const payout = Math.floor(payoutPool * proportion);

        await pool.execute(
          `UPDATE poll_bets
           SET payout_amount = ?, payout_status = "won", paid_out = TRUE, paid_out_at = NOW()
           WHERE id = ?`,
          [payout, bet.id]
        );

        await pool.execute(
          'UPDATE economy SET balance = balance + ? WHERE user_id = ?',
          [payout, bet.user_id]
        );

        totalPaidOut += payout;

        logger.info(`[PollsManager] Paid out ${payout} coins to user ${bet.user_id}`, {
          pollId: poll.id,
          userId: bet.user_id,
          betAmount: bet.bet_amount,
          payout
        });
      }

      // Mark losers
      await pool.execute(
        'UPDATE poll_bets SET payout_status = "lost" WHERE poll_id = ? AND option_index != ?',
        [poll.id, winningOptionIndex]
      );

      // Update stats
      await pool.execute(
        'UPDATE poll_betting_stats SET total_paid_out = ?, house_profit = ? WHERE poll_id = ?',
        [totalPaidOut, houseRake, poll.id]
      );

      // Send payout notification
      const guild = this.client.guilds.cache.get(poll.guild_id);
      if (guild) {
        const channel = guild.channels.cache.get(poll.channel_id);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('💰 Betting Payouts Processed')
            .addFields(
              { name: 'Total Wagered', value: `${totalWagered.toLocaleString()} coins`, inline: true },
              { name: 'Winners', value: `${winningBets.length} ${winningBets.length === 1 ? 'person' : 'people'}`, inline: true },
              { name: 'Total Paid Out', value: `${totalPaidOut.toLocaleString()} coins`, inline: true }
            )
            .setTimestamp();

          await channel.send({ embeds: [embed] });
        }
      }

      logger.info(`[PollsManager] Processed ${winningBets.length} winning bets for poll ${poll.id}`);
    } catch (error) {
      logger.error(`[PollsManager] Failed to process betting payouts: ${error.message}`);
    }
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
