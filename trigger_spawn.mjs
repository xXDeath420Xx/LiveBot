import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', async () => {
    console.log('Bot ready, sending spawn message...');

    try {
        const guildId = '844406178799943730';
        const channelId = '1422169378933440535';

        // Get the spawn data
        const [rows] = await pool.execute(
            `SELECT s.*, p.* FROM pokemon_spawns s
             JOIN pokemon_data p ON s.pokemon_id = p.id
             WHERE s.guild_id = ? AND s.channel_id = ?`,
            [guildId, channelId]
        );

        if (rows.length === 0) {
            console.log('No spawn found!');
            process.exit(0);
        }

        const spawn = rows[0];
        const channel = await client.channels.fetch(channelId);

        // Get Pokemon image from PokeAPI
        const imageUrl = spawn.is_shiny
            ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/${spawn.pokemon_id}.png`
            : `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${spawn.pokemon_id}.png`;

        const shinyText = spawn.is_shiny ? '✨ **SHINY** ' : '';

        const embed = new EmbedBuilder()
            .setColor(spawn.is_shiny ? 0xFFD700 : 0x3498db)
            .setTitle(`A wild ${shinyText}Pokémon has appeared!`)
            .setDescription(`Guess the Pokémon and type \`/pokemon catch <name>\` to catch it!`)
            .setImage(imageUrl)
            .setFooter({ text: 'This Pokémon will remain until caught or a new one spawns!' })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log(`Sent spawn message for ${spawn.name} (#${spawn.pokemon_id})`);

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
});

client.login(process.env.DISCORD_TOKEN);
