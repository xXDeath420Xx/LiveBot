import { EmbedBuilder } from 'discord.js';
import { translate } from '@vitalets/google-translate-api';

function detectLanguage(text) {
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
    const hasKorean = /[\uAC00-\uD7AF]/.test(text);
    const hasChinese = /[\u4E00-\u9FFF]/.test(text);
    const hasArabic = /[\u0600-\u06FF]/.test(text);
    const hasHindi = /[\u0900-\u097F]/.test(text);
    const hasCyrillic = /[\u0400-\u04FF]/.test(text);

    if (hasJapanese) return 'ja';
    if (hasKorean) return 'ko';
    if (hasChinese) return 'zh';
    if (hasArabic) return 'ar';
    if (hasHindi) return 'hi';
    if (hasCyrillic) return 'ru';

    const lowerText = text.toLowerCase();
    if (/\b(the|is|are|and|of|to|a|in)\b/.test(lowerText)) return 'en';
    if (/\b(el|la|los|las|de|que|y|es)\b/.test(lowerText)) return 'es';
    if (/\b(le|la|les|de|et|un|une)\b/.test(lowerText)) return 'fr';
    if (/\b(der|die|das|und|ist|ein)\b/.test(lowerText)) return 'de';
    if (/\b(il|la|di|che|e|un|una)\b/.test(lowerText)) return 'it';
    if (/\b(o|a|os|as|de|que|e|\u00e9)\b/.test(lowerText)) return 'pt';

    return 'unknown';
}

function getLanguageName(code) {
    const names = {
        'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
        'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese',
        'ko': 'Korean', 'zh': 'Chinese', 'ar': 'Arabic', 'hi': 'Hindi',
        'tr': 'Turkish', 'nl': 'Dutch', 'pl': 'Polish', 'sv': 'Swedish',
        'no': 'Norwegian', 'da': 'Danish', 'fi': 'Finnish', 'el': 'Greek',
        'cs': 'Czech', 'vi': 'Vietnamese', 'th': 'Thai', 'id': 'Indonesian'
    };
    return names[code] || code.toUpperCase();
}

const LANGUAGE_FLAGS = {
    'es': 'Spanish \ud83c\uddea\ud83c\uddf8', 'fr': 'French \ud83c\uddeb\ud83c\uddf7',
    'de': 'German \ud83c\udde9\ud83c\uddea', 'it': 'Italian \ud83c\uddee\ud83c\uddf9',
    'pt': 'Portuguese \ud83c\uddf5\ud83c\uddf9', 'ru': 'Russian \ud83c\uddf7\ud83c\uddfa',
    'ja': 'Japanese \ud83c\uddef\ud83c\uddf5', 'ko': 'Korean \ud83c\uddf0\ud83c\uddf7',
    'zh': 'Chinese \ud83c\udde8\ud83c\uddf3', 'ar': 'Arabic \ud83c\uddf8\ud83c\udde6',
    'hi': 'Hindi \ud83c\uddee\ud83c\uddf3', 'tr': 'Turkish \ud83c\uddf9\ud83c\uddf7',
    'nl': 'Dutch \ud83c\uddf3\ud83c\uddf1', 'pl': 'Polish \ud83c\uddf5\ud83c\uddf1',
    'sv': 'Swedish \ud83c\uddf8\ud83c\uddea', 'no': 'Norwegian \ud83c\uddf3\ud83c\uddf4',
    'da': 'Danish \ud83c\udde9\ud83c\uddf0', 'fi': 'Finnish \ud83c\uddeb\ud83c\uddee',
    'el': 'Greek \ud83c\uddec\ud83c\uddf7', 'cs': 'Czech \ud83c\udde8\ud83c\uddff',
    'vi': 'Vietnamese \ud83c\uddfb\ud83c\uddf3', 'th': 'Thai \ud83c\uddf9\ud83c\udded',
    'id': 'Indonesian \ud83c\uddee\ud83c\udde9', 'en': 'English \ud83c\uddfa\ud83c\uddf8'
};

const LANGUAGE_DETECT_NAMES = {
    'en': 'English \ud83c\uddfa\ud83c\uddf8', 'es': 'Spanish \ud83c\uddea\ud83c\uddf8',
    'fr': 'French \ud83c\uddeb\ud83c\uddf7', 'de': 'German \ud83c\udde9\ud83c\uddea',
    'it': 'Italian \ud83c\uddee\ud83c\uddf9', 'pt': 'Portuguese \ud83c\uddf5\ud83c\uddf9',
    'ru': 'Russian \ud83c\uddf7\ud83c\uddfa', 'ja': 'Japanese \ud83c\uddef\ud83c\uddf5',
    'ko': 'Korean \ud83c\uddf0\ud83c\uddf7', 'zh': 'Chinese \ud83c\udde8\ud83c\uddf3',
    'ar': 'Arabic \ud83c\uddf8\ud83c\udde6', 'hi': 'Hindi \ud83c\uddee\ud83c\uddf3',
    'unknown': 'Unknown'
};

export async function handleTranslateText(interaction) {
    await interaction.deferReply();

    const text = interaction.options.getString('text');
    const targetLang = interaction.options.getString('to');
    const sourceLang = interaction.options.getString('from') || 'auto';

    if (text.length > 5000) {
        return interaction.editReply({
            content: '\u274c Text is too long. Please limit to 5000 characters.',
            ephemeral: true
        });
    }

    try {
        const result = await translate(text, { from: sourceLang, to: targetLang });
        const translatedText = result.text;
        const detectedLang = result.from?.language?.iso || sourceLang;

        if (!translatedText) {
            return interaction.editReply({
                content: '\u274c Translation failed. Please try again.',
                ephemeral: true
            });
        }

        const textLower = text.toLowerCase().trim();
        const translatedLower = translatedText.toLowerCase().trim();

        if (textLower === translatedLower && detectedLang === targetLang) {
            return interaction.editReply({
                content: `\u2139\ufe0f The text appears to already be in ${getLanguageName(targetLang)}.\n\nText: "${text}"`,
                ephemeral: true
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('\ud83c\udf10 Translation')
            .addFields(
                { name: '\ud83d\udcdd Original Text', value: text.length > 1024 ? text.substring(0, 1021) + '...' : text, inline: false },
                { name: `\ud83d\udd04 Translated to ${LANGUAGE_FLAGS[targetLang] || targetLang}`, value: translatedText.length > 1024 ? translatedText.substring(0, 1021) + '...' : translatedText, inline: false }
            )
            .setFooter({ text: 'Powered by Google Translate' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    } catch (translateError) {
        console.error('[Translate] Google Translate error:', translateError);
        return interaction.editReply({
            content: '\u274c Translation service is temporarily unavailable. Please try again in a moment.',
            ephemeral: true
        });
    }
}

export async function handleTranslateDetect(interaction) {
    await interaction.deferReply();

    const text = interaction.options.getString('text');

    if (text.length > 500) {
        return interaction.editReply({
            content: '\u274c Text is too long. Please limit to 500 characters.',
            ephemeral: true
        });
    }

    const detectedLang = detectLanguage(text);

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('\ud83d\udd0d Language Detection')
        .addFields(
            { name: '\ud83d\udcdd Text', value: text.length > 1024 ? text.substring(0, 1021) + '...' : text, inline: false },
            { name: '\ud83c\udf0d Detected Language', value: LANGUAGE_DETECT_NAMES[detectedLang] || 'Unknown', inline: false }
        )
        .setFooter({ text: 'Simple pattern-based detection' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}
