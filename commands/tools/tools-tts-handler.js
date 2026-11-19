import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { synthesizeDetailed, getAvailableVoices, getVoicesByLanguage, getVoiceInfo } from '../../utils/piper-tts.js';
import { checkTTS, markUsed } from '../../core/tts-config.js';
import { getUserVoice } from '../../core/voice-reader-manager.js';
import logger from '../../utils/logger.js';
import fs from 'fs';
import { themeColor } from '../../core/guild-theme.js';

/** How a voice is named to people: "Michael (Kokoro, US)" for Kokoro, the id for Piper. */
const shownName = (voice) => voice.displayName || voice.name;
/** A voice someone may pick now (a Kokoro voice only while its model is installed). */
const usable = (info) => !!info && info.installed !== false;

function createTTSEmbed(voiceInfo, text) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎙️ Text-to-Speech')
    .setDescription(`**Text:** ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`)
    .addFields(
      { name: 'Voice', value: `${voiceInfo.flag} ${shownName(voiceInfo)}`, inline: true },
      { name: 'Language', value: voiceInfo.locale, inline: true },
      { name: 'Quality', value: voiceInfo.quality, inline: true },
      { name: 'Gender', value: voiceInfo.gender, inline: true },
      { name: 'Description', value: voiceInfo.description, inline: false }
    )
    .setFooter({ text: voiceInfo.engine === 'kokoro' ? 'Powered by Kokoro' : 'Powered by PiperTTS' })
    .setTimestamp();
}

/** Synthesize, and describe the voice that actually spoke (a Kokoro voice may have fallen back). */
async function speak(text, voiceName) {
  const out = await synthesizeDetailed(text, voiceName);
  return { audioPath: out.path, voiceInfo: getVoiceInfo(out.voice) || getVoiceInfo(voiceName) };
}

async function sendTTSFile(interaction, audioPath, voiceInfo, text) {
  const attachment = new AttachmentBuilder(audioPath, {
    name: 'tts_output.wav',
    description: `TTS: ${text.substring(0, 100)}`
  });
  const embed = createTTSEmbed(voiceInfo, text);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], files: [attachment] });
  } else {
    await interaction.reply({ embeds: [embed], files: [attachment] });
  }
}

export async function handleSpeak(interaction) {
  await interaction.deferReply();

  const text = interaction.options.getString('text');
  const playInVoice = interaction.options.getBoolean('play') || false;

  // Per-guild gating: enabled, channel/role allow- and block-lists, max length, cooldown.
  // Fail-open by design — see core/tts-config.js.
  const gate = await checkTTS(interaction, text);
  if (!gate.allowed) {
    return await interaction.editReply({ content: `❌ ${gate.reason}` });
  }

  // Voice: the one picked for this message, else the member's own voice (/voice reader my-voice, the
  // same Piper/Kokoro voices), else the server default. A saved voice that no longer exists is skipped.
  const picked = interaction.options.getString('voice');
  const ownVoice = await getUserVoice(interaction.user.id).catch(() => null);
  const voiceName = picked
    || (ownVoice && getVoiceInfo(ownVoice) ? ownVoice : null)
    || gate.config.default_voice || 'ryan';

  const chosenInfo = getVoiceInfo(voiceName);
  if (!chosenInfo || (picked && !usable(chosenInfo))) {
    return await interaction.editReply({
      content: `❌ Voice "${voiceName}" not found. Use \`/tools tts voices\` to see available voices.`
    });
  }

  logger.info(`[TTS] Synthesizing text for ${interaction.user.tag}: "${text.substring(0, 50)}..." using voice: ${voiceName}`);

  try {
    const { audioPath, voiceInfo } = await speak(text, voiceName);

    // Start the cooldown only once synthesis actually succeeded — a failed attempt should not
    // cost the user their next turn.
    if (interaction.guild) markUsed(interaction.guild.id, interaction.user.id);

    if (playInVoice) {
      const member = interaction.guild.members.cache.get(interaction.user.id);
      let voiceChannel = member?.voice?.channel;

      if (!voiceChannel && interaction.user.id === process.env.BOT_OWNER_ID) {
        const availableChannels = interaction.guild.channels.cache.filter(
          channel => channel.isVoiceBased() && channel.members.size > 0
        );
        if (availableChannels.size > 0) {
          voiceChannel = availableChannels.first();
          logger.info(`[TTS] Super-Admin override: Playing into ${voiceChannel.name} without being in channel`);
        } else {
          await sendTTSFile(interaction, audioPath, voiceInfo, text);
          await interaction.followUp({ content: '⚠️ No voice channels with users found in this server.', ephemeral: true });
          return;
        }
      } else if (!voiceChannel) {
        await sendTTSFile(interaction, audioPath, voiceInfo, text);
        await interaction.followUp({ content: '⚠️ You need to be in a voice channel to play TTS audio.', ephemeral: true });
        return;
      }

      try {
        const player = interaction.client.player;
        if (!player) throw new Error('Music player not initialized for this bot');

        await player.play(voiceChannel, audioPath, {
          nodeOptions: {
            metadata: { channel: interaction.channel, client: interaction.client, requestedBy: interaction.user }
          }
        });

        await interaction.editReply({
          content: `🔊 Playing TTS in ${voiceChannel.name}`,
          embeds: [createTTSEmbed(voiceInfo, text)]
        });
      } catch (playerError) {
        logger.error('[TTS] Voice playback error:', playerError);
        await sendTTSFile(interaction, audioPath, voiceInfo, text);
        await interaction.followUp({ content: '⚠️ Could not play in voice channel, sending audio file instead.', ephemeral: true });
      }
    } else {
      await sendTTSFile(interaction, audioPath, voiceInfo, text);
    }

    setTimeout(() => {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }, 30000);
  } catch (error) {
    logger.error('[TTS] Synthesis error:', error);
    throw new Error(`Failed to synthesize speech: ${error.message}`);
  }
}

export async function handleVoices(interaction) {
  const languageFilter = interaction.options.getString('language');
  const voicesByLang = getVoicesByLanguage();

  const embed = new EmbedBuilder()
    .setColor(themeColor(interaction.guildId, 'primary'))
    .setTitle('🎙️ Available TTS Voices')
    .setFooter({ text: 'Use /tools tts speak voice:<name> to use a voice' })
    .setTimestamp();

  if (languageFilter) {
    const voices = voicesByLang[languageFilter] || [];
    if (voices.length === 0) {
      return await interaction.reply({ content: `❌ No voices found for language: ${languageFilter}`, ephemeral: true });
    }
    // Piper first (the default engine), then Kokoro; an embed description holds 4096 characters.
    const line = v => v.engine === 'kokoro'
      ? `• **${v.name}** - ${shownName(v)}, ${v.gender}`
      : `• **${v.name}** - ${v.description} (${v.gender}, ${v.quality})`;
    const piper = voices.filter(v => v.engine !== 'kokoro').map(line);
    const kokoro = voices.filter(v => v.engine === 'kokoro').map(line);
    let body = piper.join('\n');
    if (kokoro.length) body += `${body ? '\n\n' : ''}**Kokoro (more natural)**\n${kokoro.join('\n')}`;
    if (body.length > 3900) body = `${body.slice(0, 3900).replace(/\n[^\n]*$/, '')}\n…`;
    embed.setDescription(`**${voices[0].flag} ${languageFilter}**\n\n${body}`);
  } else {
    const languageSummary = Object.entries(voicesByLang)
      .map(([locale, voices]) => `${voices[0]?.flag || ''} **${locale}**: ${voices.length} voice${voices.length > 1 ? 's' : ''}`)
      .join('\n');
    embed.setDescription(
      `**${Object.keys(voicesByLang).length} languages with ${getAvailableVoices().length} total voices**\n\n` +
      languageSummary + '\n\n*Use the language filter to see specific voices*'
    );
  }

  await interaction.reply({ embeds: [embed] });
}

export async function handlePreview(interaction) {
  await interaction.deferReply();

  const voiceName = interaction.options.getString('voice');
  const chosenInfo = getVoiceInfo(voiceName);

  if (!usable(chosenInfo)) {
    return await interaction.editReply({ content: `❌ Voice "${voiceName}" not found. Use \`/tools tts voices\` to see available voices.` });
  }

  const sampleTexts = {
    en_US: 'Hello! This is a sample of my voice. How do I sound?',
    en_GB: 'Hello! This is a sample of my voice. How do I sound?',
    ar_JO: 'مرحبا! هذه عينة من صوتي', ca_ES: 'Hola! Aquesta és una mostra de la meva veu',
    cs_CZ: 'Ahoj! Toto je ukázka mého hlasu', da_DK: 'Hej! Dette er en prøve af min stemme',
    de_DE: 'Hallo! Das ist eine Probe meiner Stimme', el_GR: 'Γεια σας! Αυτό είναι ένα δείγμα της φωνής μου',
    es_ES: '¡Hola! Esta es una muestra de mi voz', es_MX: '¡Hola! Esta es una muestra de mi voz',
    fi_FI: 'Hei! Tämä on näyte äänestäni', fr_FR: 'Bonjour! Ceci est un échantillon de ma voix',
    hu_HU: 'Helló! Ez egy minta a hangomból', is_IS: 'Halló! Þetta er sýnishorn af rödd minni',
    it_IT: 'Ciao! Questo è un campione della mia voce', ja_JP: 'こんにちは！これは私の声のサンプルです',
    ka_GE: 'გამარჯობა! ეს ჩემი ხმის ნიმუშია', kk_KZ: 'Сәлем! Бұл менің дауысымның үлгісі',
    ko_KR: '안녕하세요! 이것은 제 목소리의 샘플입니다', lb_LU: 'Moien! Dëst ass e Muster vun menger Stëmm',
    ne_NP: 'नमस्ते! यो मेरो आवाजको नमूना हो', nl_NL: 'Hallo! Dit is een voorbeeld van mijn stem',
    no_NO: 'Hei! Dette er en prøve av stemmen min', pl_PL: 'Cześć! To jest próbka mojego głosu',
    pt_BR: 'Olá! Esta é uma amostra da minha voz', pt_PT: 'Olá! Esta é uma amostra da minha voz',
    ro_RO: 'Bună! Aceasta este o mostră a vocii mele', ru_RU: 'Привет! Это образец моего голоса',
    sk_SK: 'Ahoj! Toto je ukážka môjho hlasu', sl_SI: 'Pozdravljeni! To je vzorec mojega glasu',
    sr_RS: 'Здраво! Ово је узорак мог гласа', sv_SE: 'Hej! Detta är ett prov på min röst',
    sw_CD: 'Habari! Hii ni sampuli ya sauti yangu', tr_TR: 'Merhaba! Bu benim sesimin bir örneği',
    uk_UA: 'Привіт! Це зразок мого голосу', vi_VN: 'Xin chào! Đây là mẫu giọng nói của tôi',
    zh_CN: '你好！这是我的声音样本'
  };

  const sampleText = sampleTexts[chosenInfo.locale] || sampleTexts.en_US;

  try {
    const { audioPath, voiceInfo } = await speak(sampleText, voiceName);
    await sendTTSFile(interaction, audioPath, voiceInfo, sampleText);
    setTimeout(() => {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }, 30000);
  } catch (error) {
    logger.error('[TTS Preview] Error:', error);
    throw new Error(`Failed to generate preview: ${error.message}`);
  }
}

export async function handleAutocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name === 'voice') {
    const voices = getAvailableVoices();
    const searchTerm = focusedOption.value.toLowerCase();
    const priorityLocales = ['en_US', 'en_GB', 'de_DE', 'fr_FR', 'es_ES', 'it_IT', 'pt_BR', 'ru_RU', 'ja_JP', 'zh_CN'];
    const piper = voices.filter(v => v.engine !== 'kokoro');
    const kokoro = voices.filter(v => v.engine === 'kokoro');   // already best-graded first

    // Discord shows at most 25. Unfiltered: Piper's usual first 15, then the 10 best Kokoro voices
    // (typing "kokoro" lists only Kokoro's). Filtered: matches on id, name, description or language.
    let filtered;
    if (searchTerm.length === 0) {
      const sorted = piper.sort((a, b) => {
        const aPriority = priorityLocales.indexOf(a.locale);
        const bPriority = priorityLocales.indexOf(b.locale);
        const aP = aPriority === -1 ? 999 : aPriority;
        const bP = bPriority === -1 ? 999 : bPriority;
        if (aP !== bP) return aP - bP;
        return a.name.localeCompare(b.name);
      });
      filtered = kokoro.length ? [...sorted.slice(0, 15), ...kokoro.slice(0, 10)] : sorted;
    } else {
      filtered = [...piper, ...kokoro].filter(voice =>
        voice.name.toLowerCase().includes(searchTerm) ||
        String(voice.displayName || '').toLowerCase().includes(searchTerm) ||
        voice.description.toLowerCase().includes(searchTerm) ||
        voice.locale.toLowerCase().includes(searchTerm)
      );
    }

    await interaction.respond(
      filtered.slice(0, 25).map(voice => ({
        name: (voice.engine === 'kokoro'
          ? `${voice.flag} ${shownName(voice)} - ${voice.gender}`
          : `${voice.flag} ${voice.name} - ${voice.description}`).substring(0, 100),
        value: voice.name
      }))
    );
  } else if (focusedOption.name === 'language') {
    const voicesByLang = getVoicesByLanguage();
    const languages = Object.keys(voicesByLang)
      .filter(locale => locale.toLowerCase().includes(focusedOption.value.toLowerCase()))
      .slice(0, 25)
      .map(locale => {
        const voices = voicesByLang[locale];
        return { name: `${voices[0]?.flag || ''} ${locale} (${voices.length} voice${voices.length > 1 ? 's' : ''})`, value: locale };
      });
    await interaction.respond(languages);
  }
}
