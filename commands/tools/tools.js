import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import * as generateHandlers from './tools-generate-handler.js';
import * as convertHandlers from './tools-convert-handler.js';
import * as colorHandlers from './tools-color-handler.js';
import * as qrHandlers from './tools-qr-handler.js';
import * as translateHandlers from './tools-translate-handler.js';
import * as codeHandlers from './tools-code-handler.js';
import * as ttsHandlers from './tools-tts-handler.js';

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('tools')
        .setDescription('Utility tools, converters, colors, QR codes, and translation')

        // ── Generate group (from old tools.js) ──
        .addSubcommandGroup(group =>
            group
                .setName('generate')
                .setDescription('Generate data, passwords, UUIDs, hashes, and more')
                .addSubcommand(sub =>
                    sub.setName('data')
                        .setDescription('Generate random test data')
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Type of data to generate').setRequired(true)
                                .addChoices(
                                    { name: 'User Profile', value: 'user' },
                                    { name: 'Email Address', value: 'email' },
                                    { name: 'Phone Number', value: 'phone' },
                                    { name: 'Address', value: 'address' },
                                    { name: 'Credit Card', value: 'card' },
                                    { name: 'Lorem Ipsum Text', value: 'lorem' }
                                )
                        )
                        .addIntegerOption(opt =>
                            opt.setName('count').setDescription('Number of items to generate (1-10)').setMinValue(1).setMaxValue(10)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('password')
                        .setDescription('Generate a secure random password')
                        .addIntegerOption(opt =>
                            opt.setName('length').setDescription('Password length (8-64)').setMinValue(8).setMaxValue(64)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('symbols').setDescription('Include special symbols')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('uuid')
                        .setDescription('Generate UUID (Universally Unique Identifier)')
                        .addIntegerOption(opt =>
                            opt.setName('count').setDescription('Number of UUIDs to generate (1-10)').setMinValue(1).setMaxValue(10)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('hash')
                        .setDescription('Generate hash of text')
                        .addStringOption(opt =>
                            opt.setName('text').setDescription('Text to hash').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('base64')
                        .setDescription('Encode or decode base64')
                        .addStringOption(opt =>
                            opt.setName('action').setDescription('Encode or decode').setRequired(true)
                                .addChoices(
                                    { name: 'Encode', value: 'encode' },
                                    { name: 'Decode', value: 'decode' }
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('text').setDescription('Text to encode/decode').setRequired(true)
                        )
                )
        )

        // ── Convert group (from old converter.js) ──
        .addSubcommandGroup(group =>
            group
                .setName('convert')
                .setDescription('Convert units, currencies, timezones, and number bases')
                .addSubcommand(sub =>
                    sub.setName('unit')
                        .setDescription('Convert between units')
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Type of conversion').setRequired(true)
                                .addChoices(
                                    { name: 'Length', value: 'length' },
                                    { name: 'Weight', value: 'weight' },
                                    { name: 'Temperature', value: 'temperature' },
                                    { name: 'Volume', value: 'volume' },
                                    { name: 'Area', value: 'area' },
                                    { name: 'Speed', value: 'speed' },
                                    { name: 'Data', value: 'data' },
                                    { name: 'Time', value: 'time' }
                                )
                        )
                        .addNumberOption(opt =>
                            opt.setName('value').setDescription('Value to convert').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('from').setDescription('Unit to convert from').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('to').setDescription('Unit to convert to').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('currency')
                        .setDescription('Convert between currencies')
                        .addNumberOption(opt =>
                            opt.setName('amount').setDescription('Amount to convert').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('from').setDescription('Currency code (e.g., USD, EUR, GBP)').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('to').setDescription('Currency code (e.g., USD, EUR, GBP)').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('timezone')
                        .setDescription('Convert time between timezones')
                        .addStringOption(opt =>
                            opt.setName('time').setDescription('Time in HH:MM format (24-hour)').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('from').setDescription('From timezone (e.g., America/New_York, Europe/London)').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('to').setDescription('To timezone (e.g., Asia/Tokyo, Australia/Sydney)').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('base')
                        .setDescription('Convert between number bases (binary, decimal, hex)')
                        .addStringOption(opt =>
                            opt.setName('number').setDescription('Number to convert').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('from').setDescription('From base').setRequired(true)
                                .addChoices(
                                    { name: 'Binary (Base 2)', value: '2' },
                                    { name: 'Octal (Base 8)', value: '8' },
                                    { name: 'Decimal (Base 10)', value: '10' },
                                    { name: 'Hexadecimal (Base 16)', value: '16' }
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('to').setDescription('To base').setRequired(true)
                                .addChoices(
                                    { name: 'Binary (Base 2)', value: '2' },
                                    { name: 'Octal (Base 8)', value: '8' },
                                    { name: 'Decimal (Base 10)', value: '10' },
                                    { name: 'Hexadecimal (Base 16)', value: '16' }
                                )
                        )
                )
        )

        // ── Color group (from old colors.js utilities) ──
        .addSubcommandGroup(group =>
            group
                .setName('color')
                .setDescription('Color conversion, info, palettes, and gradients')
                .addSubcommand(sub =>
                    sub.setName('convert')
                        .setDescription('Convert between color formats')
                        .addStringOption(opt =>
                            opt.setName('color').setDescription('Color in hex format (e.g., #FF0000 or FF0000)').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Get detailed information about a color')
                        .addStringOption(opt =>
                            opt.setName('color').setDescription('Color in hex format (e.g., #FF0000 or FF0000)').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('palette')
                        .setDescription('Generate a color palette')
                        .addStringOption(opt =>
                            opt.setName('base').setDescription('Base color in hex format').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Type of palette')
                                .addChoices(
                                    { name: 'Analogous', value: 'analogous' },
                                    { name: 'Complementary', value: 'complementary' },
                                    { name: 'Triadic', value: 'triadic' },
                                    { name: 'Monochromatic', value: 'monochromatic' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('random')
                        .setDescription('Generate a random color')
                )
                .addSubcommand(sub =>
                    sub.setName('gradient')
                        .setDescription('Generate a gradient between two colors')
                        .addStringOption(opt =>
                            opt.setName('color1').setDescription('First color in hex format').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('color2').setDescription('Second color in hex format').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('steps').setDescription('Number of steps (2-10)').setMinValue(2).setMaxValue(10)
                        )
                )
        )

        // ── Color Role group (from old colors.js role group) ──
        .addSubcommandGroup(group =>
            group
                .setName('colorrole')
                .setDescription('Manage your color role')
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Set your color role')
                        .addStringOption(opt =>
                            opt.setName('hex').setDescription('Hex color code (e.g., #FF0000 for red)')
                                .setRequired(true).setMinLength(6).setMaxLength(7)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove your color role')
                )
        )

        // ── QR group (from old qr.js) ──
        .addSubcommandGroup(group =>
            group
                .setName('qr')
                .setDescription('QR code generation and decoding')
                .addSubcommand(sub =>
                    sub.setName('generate')
                        .setDescription('Generate a QR code from text or URL')
                        .addStringOption(opt =>
                            opt.setName('content').setDescription('Text or URL to encode in QR code').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('size').setDescription('Size of QR code in pixels (default: 300)').setMinValue(100).setMaxValue(1000)
                        )
                        .addStringOption(opt =>
                            opt.setName('color').setDescription('QR code color in hex (e.g., FF0000 for red)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('decode')
                        .setDescription('Decode a QR code from an image URL')
                        .addStringOption(opt =>
                            opt.setName('url').setDescription('URL of the QR code image').setRequired(true)
                        )
                )
        )

        // ── Translate group (from old translate.js) ──
        .addSubcommandGroup(group =>
            group
                .setName('translate')
                .setDescription('Translate text and detect languages')
                .addSubcommand(sub =>
                    sub.setName('text')
                        .setDescription('Translate text to another language')
                        .addStringOption(opt =>
                            opt.setName('text').setDescription('Text to translate').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('to').setDescription('Target language').setRequired(true)
                                .addChoices(
                                    { name: 'Spanish', value: 'es' },
                                    { name: 'French', value: 'fr' },
                                    { name: 'German', value: 'de' },
                                    { name: 'Italian', value: 'it' },
                                    { name: 'Portuguese', value: 'pt' },
                                    { name: 'Russian', value: 'ru' },
                                    { name: 'Japanese', value: 'ja' },
                                    { name: 'Korean', value: 'ko' },
                                    { name: 'Chinese (Simplified)', value: 'zh' },
                                    { name: 'Arabic', value: 'ar' },
                                    { name: 'Hindi', value: 'hi' },
                                    { name: 'Turkish', value: 'tr' },
                                    { name: 'Dutch', value: 'nl' },
                                    { name: 'Polish', value: 'pl' },
                                    { name: 'Swedish', value: 'sv' },
                                    { name: 'Norwegian', value: 'no' },
                                    { name: 'Danish', value: 'da' },
                                    { name: 'Finnish', value: 'fi' },
                                    { name: 'Greek', value: 'el' },
                                    { name: 'Czech', value: 'cs' },
                                    { name: 'Vietnamese', value: 'vi' },
                                    { name: 'Thai', value: 'th' },
                                    { name: 'Indonesian', value: 'id' },
                                    { name: 'English', value: 'en' }
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('from').setDescription('Source language (auto-detect if not specified)')
                                .addChoices(
                                    { name: 'Auto Detect', value: 'auto' },
                                    { name: 'English', value: 'en' },
                                    { name: 'Spanish', value: 'es' },
                                    { name: 'French', value: 'fr' },
                                    { name: 'German', value: 'de' },
                                    { name: 'Italian', value: 'it' },
                                    { name: 'Portuguese', value: 'pt' },
                                    { name: 'Russian', value: 'ru' },
                                    { name: 'Japanese', value: 'ja' },
                                    { name: 'Korean', value: 'ko' },
                                    { name: 'Chinese (Simplified)', value: 'zh' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('detect')
                        .setDescription('Detect the language of text')
                        .addStringOption(opt =>
                            opt.setName('text').setDescription('Text to detect language').setRequired(true)
                        )
                )
        )

        // ── Code group (from old code.js) ──
        .addSubcommandGroup(group =>
            group
                .setName('code')
                .setDescription('Developer tools - execute code in 50+ languages')
                .addSubcommand(sub =>
                    sub.setName('run')
                        .setDescription('Execute code in 50+ programming languages')
                        .addStringOption(opt =>
                            opt.setName('language').setDescription('Programming language').setRequired(true)
                                .addChoices(
                                    { name: 'JavaScript', value: 'javascript' }, { name: 'Python', value: 'python' },
                                    { name: 'Java', value: 'java' }, { name: 'C++', value: 'cpp' },
                                    { name: 'C', value: 'c' }, { name: 'C#', value: 'csharp' },
                                    { name: 'Go', value: 'go' }, { name: 'Rust', value: 'rust' },
                                    { name: 'PHP 8.3', value: 'php' }, { name: 'PHP 7.4', value: 'php7' },
                                    { name: 'Ruby', value: 'ruby' }, { name: 'Swift', value: 'swift' },
                                    { name: 'Kotlin', value: 'kotlin' }, { name: 'TypeScript', value: 'typescript' },
                                    { name: 'R', value: 'r' }, { name: 'Bash', value: 'bash' },
                                    { name: 'SQL', value: 'sql' }, { name: 'Scala', value: 'scala' },
                                    { name: 'Perl', value: 'perl' }, { name: 'Lua', value: 'lua' }
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('code').setDescription('Code to execute').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('input').setDescription('Standard input for the program')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('languages')
                        .setDescription('List all supported programming languages')
                )
        )

        // ── TTS group (from old tts.js) ──
        .addSubcommandGroup(group =>
            group
                .setName('tts')
                .setDescription('Text-to-Speech using PiperTTS with 30+ languages')
                .addSubcommand(sub =>
                    sub.setName('speak')
                        .setDescription('Convert text to speech')
                        .addStringOption(opt =>
                            opt.setName('text').setDescription('Text to convert to speech (max 1000 characters)').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('voice').setDescription('Voice to use for synthesis').setAutocomplete(true)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('play').setDescription('Play the TTS in your current voice channel')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('voices')
                        .setDescription('List all available TTS voices')
                        .addStringOption(opt =>
                            opt.setName('language').setDescription('Filter by language code (e.g., en_US, fr_FR, de_DE)').setAutocomplete(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('preview')
                        .setDescription('Preview a voice with sample text')
                        .addStringOption(opt =>
                            opt.setName('voice').setDescription('Voice to preview').setRequired(true).setAutocomplete(true)
                        )
                )
        )

        // ── AFK flat subcommand (from old afk.js) ──
        .addSubcommand(sub =>
            sub.setName('afk')
                .setDescription('Set or remove your AFK status')
                .addStringOption(opt =>
                    opt.setName('message').setDescription('The AFK message to display when mentioned (leave empty to remove AFK)')
                )
        ),

    async autocomplete(interaction) {
        const group = interaction.options.getSubcommandGroup();
        if (group === 'tts') {
            return await ttsHandlers.handleAutocomplete(interaction);
        }
    },

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            // Handle flat subcommands (no group)
            if (!group) {
                switch (subcommand) {
                    case 'afk': {
                        const message = interaction.options.getString('message');
                        const afkManager = interaction.client.afkManager;
                        if (!afkManager) return interaction.reply({ content: 'AFK system is not available.', ephemeral: true });

                        await interaction.deferReply({ ephemeral: true });
                        const userId = interaction.user.id;
                        const guildId = interaction.guild.id;

                        if (!message) {
                            const isAFK = afkManager.isAFK(userId);
                            if (isAFK) {
                                const success = await afkManager.removeAFK(userId, guildId);
                                return interaction.editReply({ content: success ? 'Your AFK status has been removed.' : 'Failed to remove your AFK status. Please try again.' });
                            }
                            return interaction.editReply({ content: 'You are not currently AFK. Use this command with a message to set yourself as AFK.' });
                        }

                        const success = await afkManager.setAFK(userId, guildId, message);
                        if (success) {
                            const embed = new EmbedBuilder()
                                .setColor('#FFA500')
                                .setTitle('AFK Status Set')
                                .setDescription(`You are now AFK with the message:\n\n*${message}*`)
                                .setFooter({ text: 'Send any message to remove your AFK status' })
                                .setTimestamp();
                            return interaction.editReply({ embeds: [embed] });
                        }
                        return interaction.editReply({ content: 'Failed to set your AFK status. Please try again.' });
                    }
                }
                return;
            }

            switch (group) {
                case 'generate':
                    switch (subcommand) {
                        case 'data': return await generateHandlers.handleDataGenerator(interaction);
                        case 'password': return await generateHandlers.handlePassword(interaction);
                        case 'uuid': return await generateHandlers.handleUUID(interaction);
                        case 'hash': return await generateHandlers.handleHash(interaction);
                        case 'base64': return await generateHandlers.handleBase64(interaction);
                    }
                    break;

                case 'convert':
                    switch (subcommand) {
                        case 'unit': return await convertHandlers.handleUnitConversion(interaction);
                        case 'currency': return await convertHandlers.handleCurrencyConversion(interaction);
                        case 'timezone': return await convertHandlers.handleTimezoneConversion(interaction);
                        case 'base': return await convertHandlers.handleBaseConversion(interaction);
                    }
                    break;

                case 'color':
                    switch (subcommand) {
                        case 'convert': return await colorHandlers.handleColorConvert(interaction);
                        case 'info': return await colorHandlers.handleColorInfo(interaction);
                        case 'palette': return await colorHandlers.handleColorPalette(interaction);
                        case 'random': return await colorHandlers.handleColorRandom(interaction);
                        case 'gradient': return await colorHandlers.handleColorGradient(interaction);
                    }
                    break;

                case 'colorrole':
                    switch (subcommand) {
                        case 'set': return await colorHandlers.handleColorRoleSet(interaction);
                        case 'remove': return await colorHandlers.handleColorRoleRemove(interaction);
                    }
                    break;

                case 'qr':
                    switch (subcommand) {
                        case 'generate': return await qrHandlers.handleQrGenerate(interaction);
                        case 'decode': return await qrHandlers.handleQrDecode(interaction);
                    }
                    break;

                case 'translate':
                    switch (subcommand) {
                        case 'text': return await translateHandlers.handleTranslateText(interaction);
                        case 'detect': return await translateHandlers.handleTranslateDetect(interaction);
                    }
                    break;

                case 'code':
                    switch (subcommand) {
                        case 'run': return await codeHandlers.handleRun(interaction);
                        case 'languages': return await codeHandlers.handleLanguages(interaction);
                    }
                    break;

                case 'tts':
                    switch (subcommand) {
                        case 'speak': return await ttsHandlers.handleSpeak(interaction);
                        case 'voices': return await ttsHandlers.handleVoices(interaction);
                        case 'preview': return await ttsHandlers.handlePreview(interaction);
                    }
                    break;
            }
        } catch (error) {
            console.error('[Tools Command Error]', error);
            const method = interaction.deferred ? 'editReply' : 'reply';
            return interaction[method]({
                content: '\u274c Tool operation failed. Please try again.',
                ephemeral: true
            });
        }
    }
};
