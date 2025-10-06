const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const db = require('../utils/db');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const NITTER_INSTANCE = 'https://nitter.net';

async function fetchLatestYouTube(guildId, channelName) {
    const [[feed]] = await db.execute('SELECT youtube_channel_id FROM youtube_feeds WHERE guild_id = ? AND channel_name = ?', [guildId, channelName]);
    if (!feed) return { error: 'No YouTube feed is configured for that channel name.' };

    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${feed.youtube_channel_id}`;
    const response = await axios.get(feedUrl);
    const parser = new XMLParser({ ignoreAttributes: false });
    const result = parser.parse(response.data);
    const latestVideo = Array.isArray(result.feed.entry) ? result.feed.entry[0] : result.feed.entry;

    return {
        embed: new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle(latestVideo.title)
            .setURL(latestVideo.link['@_href'])
            .setAuthor({ name: `${latestVideo.author.name} just uploaded a new video!`, iconURL: 'https://i.imgur.com/k2EXDBl.png' })
            .setImage(latestVideo['media:group']['media:thumbnail']['@_url'])
            .setTimestamp(new Date(latestVideo.published)),
    };
}

async function fetchLatestTwitter(guildId, username) {
    const [[feed]] = await db.execute('SELECT twitter_username FROM twitter_feeds WHERE guild_id = ? AND twitter_username = ?', [guildId, username]);
    if (!feed) return { error: 'No Twitter feed is configured for that username.' };

    const feedUrl = `${NITTER_INSTANCE}/${feed.twitter_username}/rss`;
    const response = await axios.get(feedUrl);
    const parser = new XMLParser({ ignoreAttributes: false });
    const result = parser.parse(response.data);
    const latestTweet = result.rss.channel.item[0];

    return {
        embed: new EmbedBuilder()
            .setColor('#1DA1F2')
            .setAuthor({ name: `@${feed.twitter_username}`, iconURL: 'https://i.imgur.com/t340K8c.png', url: `${NITTER_INSTANCE}/${feed.twitter_username}` })
            .setDescription(latestTweet.description.replace(/<br>/g, '\n').substring(0, 4096))
            .setTimestamp(new Date(latestTweet.pubDate)),
    };
}


module.exports = {
    data: new SlashCommandBuilder()
        .setName('latest')
        .setDescription('Fetches the latest post from a configured social media feed.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.SendMessages)
        .addSubcommand(subcommand =>
            subcommand
                .setName('youtube')
                .setDescription('Fetches the latest video from a tracked YouTube channel.')
                .addStringOption(option => option.setName('channel-name').setDescription('The name of the YouTube channel.').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('twitter')
                .setDescription('Fetches the latest tweet from a tracked Twitter account.')
                .addStringOption(option => option.setName('username').setDescription('The Twitter @username.').setRequired(true).setAutocomplete(true))
        ),

    async autocomplete(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const focusedValue = interaction.options.getFocused();

        if (subcommand === 'youtube') {
            const [feeds] = await db.execute('SELECT DISTINCT channel_name FROM youtube_feeds WHERE guild_id = ? AND channel_name LIKE ?', [interaction.guild.id, `${focusedValue}%`]);
            await interaction.respond(feeds.filter(f => f.channel_name).map(f => ({ name: f.channel_name, value: f.channel_name })));
        } else if (subcommand === 'twitter') {
            const [feeds] = await db.execute('SELECT DISTINCT twitter_username FROM twitter_feeds WHERE guild_id = ? AND twitter_username LIKE ?', [interaction.guild.id, `${focusedValue}%`]);
            await interaction.respond(feeds.map(f => ({ name: `@${f.twitter_username}`, value: f.twitter_username })));
        }
    },

    async execute(interaction) {
        await interaction.deferReply();
        const subcommand = interaction.options.getSubcommand();

        try {
            let result;
            if (subcommand === 'youtube') {
                const channelName = interaction.options.getString('channel-name');
                result = await fetchLatestYouTube(interaction.guild.id, channelName);
            } else if (subcommand === 'twitter') {
                const username = interaction.options.getString('username');
                result = await fetchLatestTwitter(interaction.guild.id, username);
            }

            if (result.error) {
                return interaction.editReply({ content: result.error, ephemeral: true });
            }

            await interaction.editReply({ embeds: [result.embed] });

        } catch (error) {
            console.error('[Latest Command Error]', error);
            await interaction.editReply('An error occurred while fetching the latest post. The feed may be misconfigured or the service is temporarily down.');
        }
    },
};