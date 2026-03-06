import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

export const PET_TYPES = ['dog', 'cat', 'dragon', 'fox', 'bird', 'bunny'];

const PET_EMOJIS = {
    dog: '\ud83d\udc15',
    cat: '\ud83d\udc31',
    dragon: '\ud83d\udc09',
    fox: '\ud83e\udd8a',
    bird: '\ud83d\udc26',
    bunny: '\ud83d\udc30'
};

function calculateStats(pet) {
    const now = Date.now();
    const lastFed = pet.last_fed ? new Date(pet.last_fed).getTime() : now;
    const lastPlayed = pet.last_played ? new Date(pet.last_played).getTime() : now;
    const lastSlept = pet.last_slept ? new Date(pet.last_slept).getTime() : now;

    const hoursSinceFed = (now - lastFed) / (1000 * 60 * 60);
    const hoursSincePlayed = (now - lastPlayed) / (1000 * 60 * 60);
    const hoursSinceSlept = (now - lastSlept) / (1000 * 60 * 60);

    return {
        hunger: Math.min(100, pet.hunger + Math.floor(hoursSinceFed * 5)),
        happiness: Math.max(0, pet.happiness - Math.floor(hoursSincePlayed * 3)),
        energy: Math.max(0, pet.energy - Math.floor(hoursSinceSlept * 4))
    };
}

async function getPet(userId, guildId) {
    const [[pet]] = await pool.execute(
        'SELECT * FROM user_pets WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
    );
    return pet;
}

export async function handleAdopt(interaction) {
    const petType = interaction.options.getString('type');
    const petName = interaction.options.getString('name');

    await interaction.deferReply();

    const existing = await getPet(interaction.user.id, interaction.guild.id);

    if (existing) {
        return interaction.editReply({
            content: `\u274c You already have a pet named **${existing.pet_name}**! You can only have one pet per server.`
        });
    }

    await pool.execute(
        `INSERT INTO user_pets (user_id, guild_id, pet_name, pet_type, last_fed, last_played, last_slept)
         VALUES (?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [interaction.user.id, interaction.guild.id, petName, petType]
    );

    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('\ud83c\udf89 Pet Adopted!')
        .setDescription(`Congratulations! You've adopted **${petName}** the ${petType}!`)
        .addFields(
            { name: '\u2764\ufe0f Happiness', value: '100/100', inline: true },
            { name: '\ud83c\udf56 Hunger', value: '0/100', inline: true },
            { name: '\u26a1 Energy', value: '100/100', inline: true }
        )
        .setFooter({ text: 'Take good care of your pet!' });

    return interaction.editReply({ embeds: [embed] });
}

export async function handleView(interaction) {
    const pet = await getPet(interaction.user.id, interaction.guild.id);

    if (!pet) {
        return interaction.reply({
            content: '\u274c You don\'t have a pet yet! Adopt one with `/economy pet adopt`',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    const stats = calculateStats(pet);
    const emoji = PET_EMOJIS[pet.pet_type] || '\ud83d\udc3e';

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`${emoji} ${pet.pet_name}`)
        .setDescription(`Level ${pet.level} ${pet.pet_type}`)
        .addFields(
            { name: '\u2764\ufe0f Happiness', value: `${stats.happiness}/100`, inline: true },
            { name: '\ud83c\udf56 Hunger', value: `${stats.hunger}/100`, inline: true },
            { name: '\u26a1 Energy', value: `${stats.energy}/100`, inline: true },
            { name: '\u2b50 XP', value: `${pet.xp}/${pet.level * 100}`, inline: true },
            { name: '\ud83c\udfc6 Level', value: pet.level.toString(), inline: true }
        )
        .setFooter({ text: 'Use /economy pet feed, play, or sleep to care for your pet!' });

    return interaction.editReply({ embeds: [embed] });
}

export async function handleFeed(interaction) {
    const pet = await getPet(interaction.user.id, interaction.guild.id);

    if (!pet) {
        return interaction.reply({
            content: '\u274c You don\'t have a pet yet! Adopt one with `/economy pet adopt`',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    const stats = calculateStats(pet);

    if (stats.hunger < 20) {
        return interaction.editReply({
            content: `\u274c **${pet.pet_name}** isn't hungry right now!`
        });
    }

    const hunger = Math.max(0, stats.hunger - 40);
    const energy = Math.min(100, stats.energy + 10);
    const xpGain = 10;

    await pool.execute(
        'UPDATE user_pets SET hunger = ?, energy = ?, xp = xp + ?, last_fed = NOW() WHERE id = ?',
        [hunger, energy, xpGain, pet.id]
    );

    return interaction.editReply({
        content: `\ud83c\udf56 You fed **${pet.pet_name}**! (+${xpGain} XP)\nHunger: ${hunger}/100 | Energy: ${energy}/100`
    });
}

export async function handlePlay(interaction) {
    const pet = await getPet(interaction.user.id, interaction.guild.id);

    if (!pet) {
        return interaction.reply({
            content: '\u274c You don\'t have a pet yet! Adopt one with `/economy pet adopt`',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    const stats = calculateStats(pet);

    if (stats.energy < 20) {
        return interaction.editReply({
            content: `\u274c **${pet.pet_name}** is too tired to play! Let them sleep first.`
        });
    }

    const happiness = Math.min(100, stats.happiness + 30);
    const energy = Math.max(0, stats.energy - 20);
    const xpGain = 15;

    await pool.execute(
        'UPDATE user_pets SET happiness = ?, energy = ?, xp = xp + ?, last_played = NOW() WHERE id = ?',
        [happiness, energy, xpGain, pet.id]
    );

    return interaction.editReply({
        content: `\ud83c\udfbe You played with **${pet.pet_name}**! (+${xpGain} XP)\nHappiness: ${happiness}/100 | Energy: ${energy}/100`
    });
}

export async function handleSleep(interaction) {
    const pet = await getPet(interaction.user.id, interaction.guild.id);

    if (!pet) {
        return interaction.reply({
            content: '\u274c You don\'t have a pet yet! Adopt one with `/economy pet adopt`',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    const stats = calculateStats(pet);

    if (stats.energy > 80) {
        return interaction.editReply({
            content: `\u274c **${pet.pet_name}** isn't sleepy yet!`
        });
    }

    const energy = 100;
    const happiness = Math.min(100, stats.happiness + 10);
    const xpGain = 5;

    await pool.execute(
        'UPDATE user_pets SET energy = ?, happiness = ?, xp = xp + ?, last_slept = NOW() WHERE id = ?',
        [energy, happiness, xpGain, pet.id]
    );

    return interaction.editReply({
        content: `\ud83d\ude34 **${pet.pet_name}** took a nap! (+${xpGain} XP)\nEnergy: ${energy}/100 | Happiness: ${happiness}/100`
    });
}
