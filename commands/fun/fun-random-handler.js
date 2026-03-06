import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

export async function handleNumber(interaction) {
  const min = interaction.options.getInteger('min');
  const max = interaction.options.getInteger('max');
  const count = interaction.options.getInteger('count') || 1;
  if (min >= max) return interaction.reply({ content: '❌ Minimum value must be less than maximum value.', ephemeral: true });

  const numbers = Array.from({ length: count }, () => Math.floor(Math.random() * (max - min + 1)) + min);
  const embed = new EmbedBuilder()
    .setColor('#E91E63').setTitle('🎲 Random Number Generator')
    .addFields(
      { name: '🎯 Result', value: count === 1 ? `**${numbers[0]}**` : numbers.map((n, i) => `**#${i + 1}:** ${n}`).join('\n'), inline: false },
      { name: '📊 Range', value: `${min} to ${max}`, inline: true },
      { name: '🔢 Count', value: count.toString(), inline: true }
    );
  if (count > 1) {
    const sum = numbers.reduce((a, b) => a + b, 0);
    embed.addFields({ name: '📈 Statistics', value: `**Sum:** ${sum}\n**Average:** ${(sum / count).toFixed(2)}\n**Min:** ${Math.min(...numbers)}\n**Max:** ${Math.max(...numbers)}`, inline: false });
  }
  return interaction.reply({ embeds: [embed] });
}

export async function handleChoice(interaction) {
  const options = interaction.options.getString('options').split(',').map(o => o.trim()).filter(o => o.length > 0);
  if (options.length < 2) return interaction.reply({ content: '❌ Please provide at least 2 options separated by commas.\n\n**Example:** pizza, burgers, tacos, sushi', ephemeral: true });
  const chosen = options[Math.floor(Math.random() * options.length)];
  const embed = new EmbedBuilder()
    .setColor('#9C27B0').setTitle('🎯 Random Choice Picker')
    .addFields({ name: '✨ I choose...', value: `**${chosen}**` }, { name: '📋 All Options', value: options.map((o, i) => `${i + 1}. ${o}`).join('\n') })
    .setFooter({ text: `Picked from ${options.length} options` });
  return interaction.reply({ embeds: [embed] });
}

export async function handleCoin(interaction) {
  const count = interaction.options.getInteger('count') || 1;
  const flips = Array.from({ length: count }, () => Math.random() < 0.5 ? 'Heads' : 'Tails');
  const heads = flips.filter(f => f === 'Heads').length;
  const embed = new EmbedBuilder()
    .setColor('#FFC107').setTitle(`${flips[0] === 'Heads' ? '🪙' : '🌑'} Coin Flip`)
    .addFields({ name: '🎯 Result', value: count === 1 ? `**${flips[0]}!**` : flips.map((f, i) => `**Flip ${i + 1}:** ${f}`).join('\n') });
  if (count > 1) embed.addFields({ name: '📊 Summary', value: `**Heads:** ${heads} (${((heads / count) * 100).toFixed(1)}%)\n**Tails:** ${count - heads} (${(((count - heads) / count) * 100).toFixed(1)}%)` });
  return interaction.reply({ embeds: [embed] });
}

export async function handleDice(interaction) {
  const notation = interaction.options.getString('notation') || '1d6';
  const match = notation.match(/^(\d+)d(\d+)$/i);
  if (!match) return interaction.reply({ content: '❌ Invalid dice notation. Use format like: 1d6, 2d20, 3d10', ephemeral: true });
  const numDice = parseInt(match[1]);
  const numSides = parseInt(match[2]);
  if (numDice < 1 || numDice > 20) return interaction.reply({ content: '❌ Number of dice must be between 1 and 20.', ephemeral: true });
  if (numSides < 2 || numSides > 100) return interaction.reply({ content: '❌ Number of sides must be between 2 and 100.', ephemeral: true });

  const rolls = Array.from({ length: numDice }, () => Math.floor(Math.random() * numSides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);
  const embed = new EmbedBuilder()
    .setColor('#673AB7').setTitle(`🎲 Dice Roll: ${notation}`)
    .addFields({ name: '🎯 Rolls', value: numDice === 1 ? `**${rolls[0]}**` : rolls.map((r, i) => `**Die ${i + 1}:** ${r}`).join('\n') }, { name: '➕ Total', value: `**${total}**`, inline: true });
  if (numDice > 1) embed.addFields({ name: '📊 Stats', value: `**Average:** ${(total / numDice).toFixed(2)}\n**Highest:** ${Math.max(...rolls)}\n**Lowest:** ${Math.min(...rolls)}`, inline: true });
  return interaction.reply({ embeds: [embed] });
}

export async function handlePercent(interaction) {
  const percent = Math.floor(Math.random() * 101);
  const [emoji, message] = percent === 0 ? ['😱', 'Absolute zero!'] : percent === 100 ? ['🎉', 'Perfect score!'] : percent >= 90 ? ['🌟', 'Very high!'] : percent >= 70 ? ['📈', 'Pretty good!'] : percent >= 50 ? ['⚖️', 'About average'] : percent >= 30 ? ['📉', 'Below average'] : ['🔻', 'Pretty low'];
  const embed = new EmbedBuilder()
    .setColor('#00BCD4').setTitle(`${emoji} Random Percentage`)
    .addFields({ name: '🎯 Result', value: `**${percent}%**\n${message}` })
    .setFooter({ text: 'Generated a random number from 0-100%' });
  return interaction.reply({ embeds: [embed] });
}

export async function handleLetter(interaction) {
  const count = interaction.options.getInteger('count') || 1;
  const uppercase = interaction.options.getBoolean('uppercase') ?? true;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letters = Array.from({ length: count }, () => { let l = alphabet[Math.floor(Math.random() * alphabet.length)]; return uppercase ? l : l.toLowerCase(); });
  const embed = new EmbedBuilder()
    .setColor('#4CAF50').setTitle('🔤 Random Letter Generator')
    .addFields({ name: '✨ Result', value: count === 1 ? `**${letters[0]}**` : letters.join(' ') })
    .setFooter({ text: `Generated ${count} random letter${count > 1 ? 's' : ''}` });
  return interaction.reply({ embeds: [embed] });
}

export async function handleFact(interaction) {
  await interaction.deferReply();
  const category = interaction.options.getString('category') || 'number';
  try {
    let url;
    if (category === 'number') { const num = Math.floor(Math.random() * 1000); url = `http://numbersapi.com/${num}/trivia?json`; }
    else if (category === 'date') { url = `http://numbersapi.com/${Math.floor(Math.random() * 12) + 1}/${Math.floor(Math.random() * 28) + 1}/date?json`; }
    else { url = `http://numbersapi.com/${Math.floor(Math.random() * 2024) + 1}/year?json`; }
    const response = await axios.get(url, { timeout: 10000 });
    const embed = new EmbedBuilder().setColor('#FF5722').setTitle('📚 Random Fact').setDescription(response.data.text).setFooter({ text: 'Powered by Numbers API' }).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  } catch { return interaction.editReply({ content: '❌ Failed to fetch random fact. Please try again later.' }); }
}

export async function handleActivity(interaction) {
  await interaction.deferReply();
  const type = interaction.options.getString('type') || 'any';
  try {
    let url = 'https://www.boredapi.com/api/activity';
    if (type !== 'any') url += `?type=${type}`;
    const response = await axios.get(url, { timeout: 10000 });
    const activity = response.data;
    const typeEmojis = { education: '📚', recreational: '🎮', social: '👥', diy: '🔨', charity: '❤️', cooking: '🍳', relaxation: '🧘', music: '🎵', busywork: '📋' };
    const embed = new EmbedBuilder()
      .setColor('#8BC34A').setTitle(`${typeEmojis[activity.type] || '✨'} Random Activity Suggestion`).setDescription(`**${activity.activity}**`)
      .addFields(
        { name: '🎭 Type', value: activity.type.charAt(0).toUpperCase() + activity.type.slice(1), inline: true },
        { name: '👥 Participants', value: activity.participants === 1 ? 'Solo activity' : `${activity.participants} participants`, inline: true },
        { name: '💰 Cost', value: activity.price === 0 ? 'Free' : activity.price < 0.3 ? 'Low cost' : activity.price < 0.7 ? 'Moderate cost' : 'Higher cost', inline: true },
        { name: '♿ Accessibility', value: activity.accessibility === 0 ? 'Very accessible' : activity.accessibility < 0.3 ? 'Quite accessible' : activity.accessibility < 0.7 ? 'Moderately accessible' : 'May require planning', inline: true }
      ).setFooter({ text: 'Powered by Bored API • Get inspired!' }).setTimestamp();
    if (activity.link) embed.addFields({ name: '🔗 Learn More', value: activity.link });
    return interaction.editReply({ embeds: [embed] });
  } catch { return interaction.editReply({ content: '❌ Failed to fetch activity suggestion. Please try again later.' }); }
}

export async function handleYesNo(interaction) {
  await interaction.deferReply();
  const question = interaction.options.getString('question');
  try {
    const response = await axios.get('https://yesno.wtf/api', { timeout: 10000 });
    const { answer, image } = response.data;
    const colors = { yes: '#4CAF50', no: '#F44336', maybe: '#FF9800' };
    const emojis = { yes: '✅', no: '❌', maybe: '🤔' };
    const embed = new EmbedBuilder().setColor(colors[answer] || '#9E9E9E').setTitle(`${emojis[answer]} ${answer.toUpperCase()}!`).setImage(image).setTimestamp();
    if (question) embed.setDescription(`**Your question:** ${question}`);
    embed.setFooter({ text: 'Powered by yesno.wtf' });
    return interaction.editReply({ embeds: [embed] });
  } catch {
    const localAnswer = Math.random() < 0.45 ? 'yes' : Math.random() < 0.9 ? 'no' : 'maybe';
    const emojis = { yes: '✅', no: '❌', maybe: '🤔' };
    const colors = { yes: '#4CAF50', no: '#F44336', maybe: '#FF9800' };
    const embed = new EmbedBuilder().setColor(colors[localAnswer]).setTitle(`${emojis[localAnswer]} ${localAnswer.toUpperCase()}!`).setTimestamp();
    if (question) embed.setDescription(`**Your question:** ${question}`);
    return interaction.editReply({ embeds: [embed] });
  }
}
