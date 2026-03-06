import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

function generateEmail() {
    const names = ['john', 'jane', 'bob', 'alice', 'charlie', 'emma', 'david', 'sarah'];
    const domains = ['example.com', 'test.com', 'demo.com', 'sample.net', 'mail.com'];
    const name = names[Math.floor(Math.random() * names.length)];
    const number = Math.floor(Math.random() * 999);
    const domain = domains[Math.floor(Math.random() * domains.length)];
    return `${name}${number}@${domain}`;
}

function generatePhone() {
    const area = Math.floor(Math.random() * 900) + 100;
    const prefix = Math.floor(Math.random() * 900) + 100;
    const line = Math.floor(Math.random() * 9000) + 1000;
    return `(${area}) ${prefix}-${line}`;
}

function generateAddress() {
    const numbers = Math.floor(Math.random() * 9999) + 1;
    const streets = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Pine Rd', 'Elm St'];
    const cities = ['Springfield', 'Riverdale', 'Fairview', 'Georgetown', 'Madison'];
    const states = ['CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH'];
    const zip = Math.floor(Math.random() * 90000) + 10000;
    return `${numbers} ${streets[Math.floor(Math.random() * streets.length)]}, ${cities[Math.floor(Math.random() * cities.length)]}, ${states[Math.floor(Math.random() * states.length)]} ${zip}`;
}

function generateCreditCard() {
    const card = '4' + Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
    const formatted = card.match(/.{1,4}/g).join(' ');
    const exp = `${Math.floor(Math.random() * 12) + 1}/${new Date().getFullYear() + Math.floor(Math.random() * 5) + 1}`;
    const cvv = Math.floor(Math.random() * 900) + 100;
    return `**Card:** ${formatted}\n**Exp:** ${exp}\n**CVV:** ${cvv}\n\u26a0\ufe0f **TEST DATA - NOT VALID**`;
}

function generateLorem() {
    return 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export async function handleDataGenerator(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const type = interaction.options.getString('type');
    const count = interaction.options.getInteger('count') || 1;

    try {
        const results = [];

        for (let i = 0; i < count; i++) {
            switch (type) {
                case 'user': {
                    const userResponse = await axios.get('https://randomuser.me/api/', { timeout: 10000 });
                    const user = userResponse.data.results[0];
                    results.push(`**Name:** ${user.name.first} ${user.name.last}\n**Email:** ${user.email}\n**Phone:** ${user.phone}\n**Address:** ${user.location.street.number} ${user.location.street.name}, ${user.location.city}, ${user.location.state} ${user.location.postcode}`);
                    break;
                }
                case 'email':
                    results.push(generateEmail());
                    break;
                case 'phone':
                    results.push(generatePhone());
                    break;
                case 'address':
                    results.push(generateAddress());
                    break;
                case 'card':
                    results.push(generateCreditCard());
                    break;
                case 'lorem':
                    results.push(generateLorem());
                    break;
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`\ud83d\udd27 Generated ${count} ${type === 'user' ? 'User Profile' : type === 'lorem' ? 'Lorem Ipsum' : type.charAt(0).toUpperCase() + type.slice(1)}${count > 1 ? 's' : ''}`)
            .setDescription(results.join('\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n'))
            .setFooter({ text: '\u26a0\ufe0f Test data only - Not for real use' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Data Generator Error]', error);
        return interaction.editReply({
            content: '\u274c Failed to generate data. Please try again later.'
        });
    }
}

export async function handlePassword(interaction) {
    const length = interaction.options.getInteger('length') || 16;
    const includeSymbols = interaction.options.getBoolean('symbols') !== false;

    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    if (includeSymbols) {
        chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
    }

    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars[Math.floor(Math.random() * chars.length)];
    }

    const embed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('\ud83d\udd10 Generated Password')
        .setDescription(`\`\`\`${password}\`\`\``)
        .addFields(
            { name: '\ud83d\udcca Length', value: `${length} characters`, inline: true },
            { name: '\ud83d\udd23 Symbols', value: includeSymbols ? 'Yes' : 'No', inline: true },
            { name: '\ud83d\udca1 Tip', value: 'Store this password securely in a password manager!', inline: false }
        )
        .setFooter({ text: 'This message will self-destruct in 60 seconds for security' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });

    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch (error) {
            // Message may already be deleted
        }
    }, 60000);
}

export async function handleUUID(interaction) {
    const count = interaction.options.getInteger('count') || 1;

    const uuids = [];
    for (let i = 0; i < count; i++) {
        uuids.push(generateUUID());
    }

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle(`\ud83c\udd94 Generated ${count} UUID${count > 1 ? 's' : ''}`)
        .setDescription('```\n' + uuids.join('\n') + '\n```')
        .setFooter({ text: 'Universally Unique Identifier (Version 4)' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleHash(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const text = interaction.options.getString('text');
    const crypto = await import('crypto');

    const md5 = crypto.createHash('md5').update(text).digest('hex');
    const sha1 = crypto.createHash('sha1').update(text).digest('hex');
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');

    const embed = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('\ud83d\udd12 Generated Hashes')
        .addFields(
            { name: 'MD5', value: `\`\`\`${md5}\`\`\``, inline: false },
            { name: 'SHA-1', value: `\`\`\`${sha1}\`\`\``, inline: false },
            { name: 'SHA-256', value: `\`\`\`${sha256}\`\`\``, inline: false }
        )
        .setFooter({ text: 'Cryptographic hash functions' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

export async function handleBase64(interaction) {
    const action = interaction.options.getString('action');
    const text = interaction.options.getString('text');

    try {
        let result;
        if (action === 'encode') {
            result = Buffer.from(text, 'utf-8').toString('base64');
        } else {
            result = Buffer.from(text, 'base64').toString('utf-8');
        }

        const embed = new EmbedBuilder()
            .setColor('#F39C12')
            .setTitle(`\ud83d\udd04 Base64 ${action === 'encode' ? 'Encoded' : 'Decoded'}`)
            .addFields(
                { name: 'Input', value: `\`\`\`${text.substring(0, 500)}\`\`\``, inline: false },
                { name: 'Output', value: `\`\`\`${result.substring(0, 500)}\`\`\``, inline: false }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        return interaction.reply({
            content: '\u274c Invalid base64 string. Please check your input.',
            ephemeral: true
        });
    }
}
