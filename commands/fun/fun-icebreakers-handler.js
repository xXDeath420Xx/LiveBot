import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

export async function handleIcebreaker(interaction) {
  const category = interaction.options.getString('category') || 'fun';
  const icebreakers = {
    fun: ["If you could have dinner with any historical figure, who would it be?", "What's the weirdest food combination you actually enjoy?", "If you could instantly master any skill, what would it be?", "What's your go-to karaoke song?", "If you could live in any fictional universe, which would you choose?", "What's the most useless talent you have?", "If you could only eat one food for the rest of your life, what would it be?", "What's the best piece of advice you've ever received?", "If you won the lottery tomorrow, what's the first thing you'd do?", "What's your most unpopular opinion?"],
    deep: ["What life experience has shaped who you are today?", "What do you think is the meaning of a good life?", "What's something you're grateful for that you often take for granted?", "What's a belief you held strongly that you've since changed your mind about?", "What does success mean to you personally?", "What's the most important lesson you've learned from failure?", "If you could give your younger self one piece of advice, what would it be?", "What values are most important to you in relationships?", "What legacy do you want to leave behind?", "What's something you wish people understood about you?"],
    wyr: ["Would you rather be able to fly or be invisible?", "Would you rather know how you die or when you die?", "Would you rather have unlimited money or unlimited time?", "Would you rather be famous now or be remembered after death?", "Would you rather lose all your memories or never be able to make new ones?", "Would you rather have the ability to read minds or see the future?", "Would you rather have no internet or no phone?", "Would you rather live in space or under the ocean?"],
    tot: ["Coffee or Tea?", "Beach or Mountains?", "Morning person or Night owl?", "Books or Movies?", "Cats or Dogs?", "Summer or Winter?", "Sweet or Savory?", "Texting or Calling?", "Introvert or Extrovert?", "Pizza or Burgers?", "City or Countryside?", "Netflix or YouTube?"],
    creative: ["If your life was a movie genre, what would it be and why?", "Create a superpower that nobody has thought of before.", "If you could invent a new holiday, what would it celebrate?", "What would be the title of your autobiography?", "If you could redesign any everyday object, what would you improve?", "What would your dream job be if money didn't matter?", "If you could combine any two animals, what would you create?", "What would your personal theme song be?"]
  };
  const categoryEmojis = { fun: '🎉', deep: '💭', wyr: '🤔', tot: '⚡', creative: '🎨' };
  const categoryNames = { fun: 'Fun & Casual', deep: 'Deep & Meaningful', wyr: 'Would You Rather', tot: 'This or That', creative: 'Creative' };
  const questions = icebreakers[category] || icebreakers.fun;

  const embed = new EmbedBuilder()
    .setColor('#FF6B9D')
    .setTitle(`${categoryEmojis[category]} Icebreaker: ${categoryNames[category]}`)
    .setDescription(`**${questions[Math.floor(Math.random() * questions.length)]}**`)
    .addFields({ name: '💬 How to Use', value: 'Answer this question to start a conversation!' })
    .setFooter({ text: 'Use /fun icebreakers icebreaker again for a new question!' })
    .setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleProfile(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const interests = interaction.options.getString('interests');
  const bio = interaction.options.getString('bio') || '';
  const interestList = interests.split(',').map(i => i.trim()).filter(i => i.length > 0);
  if (interestList.length === 0 || interestList.length > 10) return interaction.editReply({ content: '❌ Please provide between 1-10 interests, separated by commas.' });
  if (bio.length > 200) return interaction.editReply({ content: '❌ Bio is too long. Please limit to 200 characters.' });

  await pool.execute(`CREATE TABLE IF NOT EXISTS social_profiles (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, user_id VARCHAR(20) NOT NULL, interests TEXT NOT NULL, bio TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY unique_user (guild_id, user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.execute(`INSERT INTO social_profiles (guild_id, user_id, interests, bio) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE interests = VALUES(interests), bio = VALUES(bio), updated_at = CURRENT_TIMESTAMP`, [interaction.guild.id, interaction.user.id, interestList.join(','), bio]);

  const embed = new EmbedBuilder()
    .setColor('#2ECC71').setTitle('✅ Social Profile Updated!').setDescription('Your profile has been saved.')
    .addFields({ name: '🎯 Your Interests', value: interestList.map(i => `• ${i}`).join('\n') })
    .setFooter({ text: 'Use /fun icebreakers findmatch to find users with similar interests!' }).setTimestamp();
  if (bio) embed.addFields({ name: '📝 Your Bio', value: bio });
  return interaction.editReply({ embeds: [embed] });
}

export async function handleViewProfile(interaction) {
  await interaction.deferReply();
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const [[profile]] = await pool.execute('SELECT interests, bio, created_at FROM social_profiles WHERE guild_id = ? AND user_id = ?', [interaction.guild.id, targetUser.id]);
  if (!profile) return interaction.editReply({ content: `❌ ${targetUser.id === interaction.user.id ? 'You haven\'t' : `${targetUser.username} hasn't`} created a social profile yet. Use \`/fun icebreakers profile\` to create one!` });

  const embed = new EmbedBuilder()
    .setColor('#9B59B6').setTitle(`👤 ${targetUser.username}'s Social Profile`).setThumbnail(targetUser.displayAvatarURL())
    .addFields({ name: '🎯 Interests', value: profile.interests.split(',').map(i => `• ${i}`).join('\n') })
    .setFooter({ text: `Profile created ${new Date(profile.created_at).toLocaleDateString()}` }).setTimestamp();
  if (profile.bio) embed.addFields({ name: '📝 Bio', value: profile.bio });
  return interaction.editReply({ embeds: [embed] });
}

export async function handleFindMatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const [[userProfile]] = await pool.execute('SELECT interests FROM social_profiles WHERE guild_id = ? AND user_id = ?', [interaction.guild.id, interaction.user.id]);
  if (!userProfile) return interaction.editReply({ content: '❌ You need to create a social profile first! Use `/fun icebreakers profile`' });

  const userInterests = userProfile.interests.split(',').map(i => i.trim().toLowerCase());
  const [allProfiles] = await pool.execute('SELECT user_id, interests FROM social_profiles WHERE guild_id = ? AND user_id != ?', [interaction.guild.id, interaction.user.id]);
  if (allProfiles.length === 0) return interaction.editReply({ content: '❌ No other users have created social profiles yet.' });

  const matches = allProfiles.map(profile => {
    const theirInterests = profile.interests.split(',').map(i => i.trim().toLowerCase());
    const commonInterests = userInterests.filter(interest => theirInterests.some(their => their.includes(interest) || interest.includes(their)));
    return { userId: profile.user_id, commonInterests, matchScore: commonInterests.length };
  }).filter(m => m.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore);

  if (matches.length === 0) return interaction.editReply({ content: '❌ No matches found with similar interests.' });

  const embed = new EmbedBuilder().setColor('#E91E63').setTitle('💫 Your Social Matches').setDescription('Users with similar interests!').setTimestamp();
  for (const match of matches.slice(0, 5)) {
    const user = await interaction.guild.members.fetch(match.userId).catch(() => null);
    if (!user) continue;
    embed.addFields({ name: `${user.user.username} - ${match.matchScore} common interest${match.matchScore > 1 ? 's' : ''}`, value: `Shared: ${match.commonInterests.join(', ')}` });
  }
  return interaction.editReply({ embeds: [embed] });
}
