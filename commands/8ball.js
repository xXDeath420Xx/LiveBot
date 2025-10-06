const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const answers = [
    // Affirmative Answers
    'It is certain.',
    'It is decidedly so.',
    'Without a doubt.',
    'Yes – definitely.',
    'You may rely on it.',
    'As I see it, yes.',
    'Most likely.',
    'Outlook good.',
    'Yes.',
    'Signs point to yes.',
    // Non-committal Answers
    'Reply hazy, try again.',
    'Ask again later.',
    'Better not tell you now.',
    'Cannot predict now.',
    'Concentrate and ask again.',
    // Negative Answers
    "Don't count on it.",
    'My reply is no.',
    'My sources say no.',
    'Outlook not so good.',
    'Very doubtful.'
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('8ball')
        .setDescription('Asks the magic 8-ball a question.')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('The yes-or-no question you want to ask.')
                .setRequired(true)
        ),

    async execute(interaction) {
        const question = interaction.options.getString('question');
        const answer = answers[Math.floor(Math.random() * answers.length)];

        const embed = new EmbedBuilder()
            .setColor('#2C2F33') // A dark, neutral color
            .setTitle('🎱 Magic 8-Ball')
            .addFields(
                { name: 'Your Question', value: question },
                { name: 'The 8-Ball Says...', value: `**${answer}**` }
            );

        await interaction.reply({ embeds: [embed] });
    },
};