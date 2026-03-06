import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'search':
                return await handleSearch(interaction);
            case 'bygenre':
                return await handleByGenre(interaction);
            case 'bestsellers':
                return await handleBestsellers(interaction);
            case 'random':
                return await handleRandom(interaction);
        }
    } catch (error) {
        console.error('[Books Command Error]', error);
        const method = interaction.deferred ? 'editReply' : 'reply';
        return interaction[method]({
            content: '❌ Failed to fetch book data. Please try again later.',
            ephemeral: true
        });
    }
}

async function handleSearch(interaction) {
    await interaction.deferReply();

    const query = interaction.options.getString('query');

    try {
        const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&orderBy=relevance`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data.items || response.data.items.length === 0) {
            return interaction.editReply({
                content: `❌ No books found for "${query}". Try a different search term.`
            });
        }

        const book = response.data.items[0].volumeInfo;
        const embed = createBookEmbed(book);

        if (response.data.items.length > 1) {
            const otherBooks = response.data.items.slice(1, 5).map((item, index) => {
                const b = item.volumeInfo;
                return `${index + 2}. **${b.title}** by ${b.authors ? b.authors.join(', ') : 'Unknown'}`;
            }).join('\n');

            embed.addFields({ name: '📚 Other Results', value: otherBooks, inline: false });
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Books Search Error]', error);
        return interaction.editReply({
            content: '❌ Failed to search books. Google Books API may be temporarily unavailable.',
            ephemeral: true
        });
    }
}

async function handleByGenre(interaction) {
    await interaction.deferReply();

    const genre = interaction.options.getString('genre');

    try {
        const url = `https://www.googleapis.com/books/v1/volumes?q=subject:${genre}&maxResults=10&orderBy=relevance`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data.items || response.data.items.length === 0) {
            return interaction.editReply({ content: `❌ No books found in the ${genre} genre.` });
        }

        const book = response.data.items[0].volumeInfo;
        const embed = createBookEmbed(book);
        embed.setTitle(`📚 ${genre.replace('+', ' ')} Recommendation`);

        if (response.data.items.length > 1) {
            const otherBooks = response.data.items.slice(1, 6).map((item, index) => {
                const b = item.volumeInfo;
                const rating = b.averageRating ? ` ⭐ ${b.averageRating}` : '';
                return `${index + 2}. **${b.title}**${rating}`;
            }).join('\n');

            embed.addFields({ name: `📖 More ${genre.replace('+', ' ')} Books`, value: otherBooks, inline: false });
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Books By Genre Error]', error);
        return interaction.editReply({
            content: '❌ Failed to fetch books by genre. Please try again later.',
            ephemeral: true
        });
    }
}

async function handleBestsellers(interaction) {
    await interaction.deferReply();

    try {
        const url = `https://www.googleapis.com/books/v1/volumes?q=subject:fiction&orderBy=newest&maxResults=10&printType=books`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data.items || response.data.items.length === 0) {
            return interaction.editReply({ content: '❌ Failed to fetch bestsellers.' });
        }

        const embed = new EmbedBuilder()
            .setColor('#F39C12')
            .setTitle('🏆 Popular Recent Books')
            .setDescription('Recently published and highly rated books')
            .setFooter({ text: 'Powered by Google Books' })
            .setTimestamp();

        const books = response.data.items.slice(0, 8);
        books.forEach((item, index) => {
            const book = item.volumeInfo;
            const rating = book.averageRating ? ` ⭐ ${book.averageRating}/5` : '';
            const authors = book.authors ? ` by ${book.authors[0]}` : '';
            const year = book.publishedDate ? ` (${book.publishedDate.substring(0, 4)})` : '';

            embed.addFields({
                name: `${index + 1}. ${book.title}`,
                value: `${authors}${year}${rating}`,
                inline: true
            });
        });

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Books Bestsellers Error]', error);
        return interaction.editReply({
            content: '❌ Failed to fetch bestsellers. Please try again later.',
            ephemeral: true
        });
    }
}

async function handleRandom(interaction) {
    await interaction.deferReply();

    try {
        const genres = ['fiction', 'mystery', 'science+fiction', 'fantasy', 'biography', 'history'];
        const randomGenre = genres[Math.floor(Math.random() * genres.length)];

        const url = `https://www.googleapis.com/books/v1/volumes?q=subject:${randomGenre}&maxResults=40&orderBy=relevance`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data.items || response.data.items.length === 0) {
            return interaction.editReply({ content: '❌ Failed to find a random book. Please try again.' });
        }

        const randomBook = response.data.items[Math.floor(Math.random() * response.data.items.length)];
        const book = randomBook.volumeInfo;

        const embed = createBookEmbed(book);
        embed.setTitle('🎲 Random Book Recommendation');

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Books Random Error]', error);
        return interaction.editReply({
            content: '❌ Failed to get random book. Please try again later.',
            ephemeral: true
        });
    }
}

function createBookEmbed(book) {
    const embed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle(`📖 ${book.title}`)
        .setFooter({ text: 'Powered by Google Books' })
        .setTimestamp();

    if (book.authors) {
        embed.addFields({ name: '✍️ Author(s)', value: book.authors.join(', '), inline: true });
    }
    if (book.publishedDate) {
        embed.addFields({ name: '📅 Published', value: book.publishedDate.substring(0, 4), inline: true });
    }
    if (book.pageCount) {
        embed.addFields({ name: '📄 Pages', value: book.pageCount.toString(), inline: true });
    }
    if (book.averageRating) {
        embed.addFields({ name: '⭐ Rating', value: `${book.averageRating}/5 (${book.ratingsCount || 0} ratings)`, inline: true });
    }
    if (book.categories && book.categories.length > 0) {
        embed.addFields({ name: '📚 Genre', value: book.categories.slice(0, 3).join(', '), inline: true });
    }
    if (book.publisher) {
        embed.addFields({ name: '🏢 Publisher', value: book.publisher, inline: true });
    }
    if (book.description) {
        const description = book.description.length > 500
            ? book.description.substring(0, 497) + '...'
            : book.description;
        embed.setDescription(description.replace(/<[^>]*>/g, ''));
    }
    if (book.imageLinks?.thumbnail) {
        embed.setThumbnail(book.imageLinks.thumbnail);
    }
    if (book.infoLink) {
        embed.addFields({ name: '🔗 More Info', value: `[View on Google Books](${book.infoLink})`, inline: false });
    }

    return embed;
}
