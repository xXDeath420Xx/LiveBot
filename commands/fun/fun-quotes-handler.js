import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

async function buildQuoteEmbed(quote) {
  const embed = new EmbedBuilder()
    .setColor('#9B59B6')
    .setAuthor({ name: quote.author_name })
    .setDescription(quote.content)
    .addFields(
      { name: 'Quote ID', value: `#${quote.id}`, inline: true },
      { name: 'Saved', value: `<t:${Math.floor(new Date(quote.saved_at).getTime() / 1000)}:R>`, inline: true }
    );
  if (quote.quote_name) embed.setTitle(`"${quote.quote_name}"`);
  embed.setURL(`https://discord.com/channels/${quote.guild_id}/${quote.channel_id}/${quote.message_id}`);
  return embed;
}

export async function handleSave(interaction) {
  await interaction.deferReply();
  const messageId = interaction.options.getString('message_id', true);
  const name = interaction.options.getString('name');
  const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (!message) return interaction.editReply({ content: '❌ Could not find a message with that ID in this channel.' });
  if (!message.content && message.embeds.length === 0 && message.attachments.size === 0) return interaction.editReply({ content: '❌ That message has no quotable content.' });

  const [result] = await pool.execute(
    `INSERT INTO quotes_enhanced (guild_id, channel_id, message_id, author_id, author_name, content, quote_name, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [interaction.guild.id, interaction.channel.id, messageId, message.author.id, message.author.tag, message.content || '[Embed or Attachment]', name || null, interaction.user.id]
  );

  const embed = new EmbedBuilder()
    .setColor('#5865F2').setTitle('✅ Quote Saved').setDescription(`Quote #${result.insertId} has been saved!`)
    .addFields({ name: 'Author', value: message.author.tag, inline: true }, { name: 'Content Preview', value: (message.content || '[Embed/Attachment]').slice(0, 100) + (message.content?.length > 100 ? '...' : ''), inline: false });
  if (name) embed.addFields({ name: 'Name', value: name, inline: true });
  return interaction.editReply({ embeds: [embed] });
}

export async function handleGet(interaction) {
  await interaction.deferReply();
  const quoteId = interaction.options.getInteger('id', true);
  const [quotes] = await pool.execute('SELECT * FROM quotes_enhanced WHERE id = ? AND guild_id = ?', [quoteId, interaction.guild.id]);
  if (quotes.length === 0) return interaction.editReply({ content: `❌ Quote #${quoteId} not found in this server.` });
  return interaction.editReply({ embeds: [await buildQuoteEmbed(quotes[0])] });
}

export async function handleRandom(interaction) {
  await interaction.deferReply();
  const [quotes] = await pool.execute('SELECT * FROM quotes_enhanced WHERE guild_id = ? ORDER BY RAND() LIMIT 1', [interaction.guild.id]);
  if (quotes.length === 0) return interaction.editReply({ content: '❌ No quotes saved in this server yet. Use `/fun quotes save` to add one!' });
  return interaction.editReply({ embeds: [await buildQuoteEmbed(quotes[0])] });
}

export async function handleSearchQuotes(interaction) {
  await interaction.deferReply();
  const query = interaction.options.getString('query', true);
  const [quotes] = await pool.execute('SELECT * FROM quotes_enhanced WHERE guild_id = ? AND (content LIKE ? OR quote_name LIKE ? OR author_name LIKE ?) LIMIT 10', [interaction.guild.id, `%${query}%`, `%${query}%`, `%${query}%`]);
  if (quotes.length === 0) return interaction.editReply({ content: `❌ No quotes found matching "${query}".` });

  const embed = new EmbedBuilder()
    .setColor('#5865F2').setTitle(`🔍 Search Results for "${query}"`)
    .setDescription(quotes.map(q => { const preview = q.content.slice(0, 50) + (q.content.length > 50 ? '...' : ''); return `**#${q.id}** ${q.quote_name ? `"${q.quote_name}" ` : ''}- ${q.author_name}\n${preview}`; }).join('\n\n'))
    .setFooter({ text: `Found ${quotes.length} quote${quotes.length !== 1 ? 's' : ''}` });
  return interaction.editReply({ embeds: [embed] });
}

export async function handleListQuotes(interaction) {
  await interaction.deferReply();
  const limit = interaction.options.getInteger('limit') || 10;
  const [quotes] = await pool.execute('SELECT * FROM quotes_enhanced WHERE guild_id = ? ORDER BY saved_at DESC LIMIT ?', [interaction.guild.id, limit]);
  if (quotes.length === 0) return interaction.editReply({ content: '❌ No quotes saved in this server yet. Use `/fun quotes save` to add one!' });

  const embed = new EmbedBuilder()
    .setColor('#5865F2').setTitle('📋 Recent Quotes')
    .setDescription(quotes.map(q => { const preview = q.content.slice(0, 60) + (q.content.length > 60 ? '...' : ''); const name = q.quote_name ? `"${q.quote_name}" ` : ''; return `**#${q.id}** ${name}- ${q.author_name}\n${preview}`; }).join('\n\n'))
    .setFooter({ text: `Showing ${quotes.length} most recent quote${quotes.length !== 1 ? 's' : ''}` });
  return interaction.editReply({ embeds: [embed] });
}

export async function handleDelete(interaction) {
  await interaction.deferReply();
  const quoteId = interaction.options.getInteger('id', true);
  const [quotes] = await pool.execute('SELECT * FROM quotes_enhanced WHERE id = ? AND guild_id = ?', [quoteId, interaction.guild.id]);
  if (quotes.length === 0) return interaction.editReply({ content: `❌ Quote #${quoteId} not found in this server.` });

  const quote = quotes[0];
  const isAuthor = quote.saved_by === interaction.user.id;
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);
  if (!isAuthor && !isAdmin) return interaction.editReply({ content: '❌ You can only delete quotes you saved, unless you have Manage Messages permission.' });

  await pool.execute('DELETE FROM quotes_enhanced WHERE id = ?', [quoteId]);
  return interaction.editReply({ content: `✅ Quote #${quoteId} has been deleted.` });
}
