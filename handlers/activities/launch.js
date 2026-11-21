// /movie (and /watch) with Watch Together, the Discord Activity (docs/activities.md).
//
// A server whose Cinema page says "Watch Together" (cinema_config.watch_mode = 'activity') no longer starts the Go Live
// stream: the same pickers run, and their Start button launches the Activity in the member's voice channel with the
// title already chosen (an intent the Activity picks up when it opens; core/activities/intents.js). LAUNCH_ACTIVITY is
// the interaction's reply, so it must come within Discord's 3 seconds.
// /movie is a text command (core/command-registration.js): a typed message cannot launch an Activity, so /movie open
// answers with a button that does.
// A server run by a custom-branded bot: that bot is another Discord application and cannot open CertiFried's Activity,
// so it says how to open it from the voice channel (members add CertiFried to their own account once, User Install);
// a title picked with /movie play is still saved as the intent and starts when they open it.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { activityConfig, activityProblem } from '../../core/activities/config.js';
import { setIntent } from '../../core/activities/intents.js';
import { getWatchSessions } from '../../core/activities/watch/registry.js';
import { createJellyfinMedia } from '../../core/activities/watch/jellyfin-media.js';
import { USER_INSTALL_URL } from '../../core/activities/watch/guild-config.js';

const NOT_READY = 'Watch Together (the Discord Activity) is not switched on yet. Ask the bot owner.';

export const activitiesReady = () => !activityProblem(activityConfig());

/** Did this interaction come to another application (a custom-branded bot) than the one the Activity belongs to? */
export function fromOtherApp(interaction, appId = activityConfig().appId) {
    return !!appId && !!interaction?.applicationId && String(interaction.applicationId) !== String(appId);
}

/** What a custom-branded bot says instead of opening the Activity. */
export function openItYourself(kind = 'watch', { saved = false } = {}) {
    const what = kind === 'greenhouse' ? 'Greenhouse Tycoon' : 'Watch Together';
    return [
        `${saved ? 'Your pick is saved for 10 minutes. ' : ''}This server's bot can't open ${what} itself. In your voice channel, press the Activities button (the rocket), find **CertiFried** and open it${saved ? '; your pick starts there' : ''}.`,
        `Not in the list? Add CertiFried to your Discord account once (no server permissions needed): <${USER_INSTALL_URL}>`,
    ].join('\n');
}

/** The button that opens an Activity: activity_open:watch | activity_open:greenhouse. */
export function openActivityRow(kind = 'watch') {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`activity_open:${kind}`)
        .setStyle(ButtonStyle.Success)
        .setLabel(kind === 'greenhouse' ? 'Play Greenhouse Tycoon' : 'Open Watch Together'));
}

function inVoice(interaction) {
    const vc = interaction.member?.voice?.channel;
    return !!vc && vc.isVoiceBased?.();
}

async function launch(interaction, { kind = 'watch', saved = false } = {}) {
    if (fromOtherApp(interaction)) {
        await interaction.reply({ content: openItYourself(kind, { saved }), ephemeral: true }).catch(() => {});
        return true;
    }
    try {
        await interaction.launchActivity();
        return true;
    } catch (e) {
        const msg = /activit|embedded/i.test(String(e?.message)) ? NOT_READY : 'Discord would not open the Activity. Try again.';
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        return true;
    }
}

/** The activity_open:<kind> button. */
export async function handleActivityOpen(interaction) {
    if (!interaction.customId?.startsWith('activity_open:')) return false;
    if (!activitiesReady()) { await interaction.reply({ content: NOT_READY, ephemeral: true }); return true; }
    const kind = interaction.customId.split(':')[1] === 'greenhouse' ? 'greenhouse' : 'watch';
    if (!interaction.guildId || !inVoice(interaction)) {
        await interaction.reply({ content: 'Join a voice channel first, then press the button again.', ephemeral: true });
        return true;
    }
    if (kind === 'greenhouse') setIntent(interaction.guildId, interaction.user.id, { kind: 'greenhouse' });
    return launch(interaction, { kind });
}

/**
 * The cinema picker's Start button in a Watch Together server: remember the pick, launch the Activity.
 * sel: { itemId, audioIndex, subIndex, queue: [{ itemId, label }] | null, libraryId, clear() }
 */
export async function launchWatchFromPicker(interaction, sel) {
    if (!activitiesReady()) { await interaction.reply({ content: NOT_READY, ephemeral: true }); return true; }
    if (!inVoice(interaction)) {
        await interaction.reply({ content: 'Join a voice channel first: Watch Together opens in the channel you are in.', ephemeral: true });
        return true;
    }
    // The server's chosen library (the Activity checks again before it plays). Skipped when Jellyfin is slow: the
    // launch must answer within Discord's 3 seconds.
    if (sel.libraryId) {
        const check = createJellyfinMedia({ cfg: activityConfig() }).getItem(sel.itemId, sel.libraryId).then(() => 'ok', (e) => (e?.code === 'NOT_FOUND' ? 'missing' : 'unknown'));
        const verdict = await Promise.race([check, new Promise((r) => setTimeout(() => r('slow'), 1500))]);
        if (verdict === 'missing') {
            await interaction.reply({ content: 'That title is not in the library this server watches from.', ephemeral: true });
            return true;
        }
    }
    setIntent(interaction.guildId, interaction.user.id, {
        kind: 'watch', itemId: sel.itemId,
        audioIndex: Number.isInteger(sel.audioIndex) ? sel.audioIndex : null,
        subIndex: Number.isInteger(sel.subIndex) ? sel.subIndex : null,
        queue: Array.isArray(sel.queue) && sel.queue.length > 1 ? sel.queue.slice(0, 200) : null,
    });
    sel.clear?.();
    return launch(interaction, { saved: true });
}

/** /movie and /watch in a Watch Together server (config: the cinema_config row). */
export async function handleMovieActivity(interaction, sub, config) {
    const sessions = getWatchSessions();
    const here = sessions ? sessions.inGuild(interaction.guildId) : [];
    if (sub === 'open') {
        if (!activitiesReady()) return interaction.reply({ content: NOT_READY, ephemeral: true });
        if (fromOtherApp(interaction)) return interaction.reply({ content: openItYourself('watch') });
        return interaction.reply({ content: '🎬 Watch Together opens in your voice channel. Everyone in the channel can join it from the Activity button.', components: [openActivityRow('watch')] });
    }
    if (sub === 'status') {
        if (!here.length) return interaction.reply({ content: 'Nothing is playing. Use `/movie open` (or `/movie play`) to start Watch Together.', ephemeral: true });
        const lines = here.map((s) => {
            const v = sessions.view(s);
            return `🎬 ${v.media ? `**${v.media.label}**` : 'Watch Together (nothing picked yet)'} in <#${s.channelId}>: ${v.viewers.length} watching${v.media ? (v.playback.paused ? ', paused' : '') : ''}`;
        });
        return interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
    }
    if (sub === 'stop') {
        const member = interaction.member;
        const manager = member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
        const controller = manager || (config?.control_role_id && member?.roles?.cache?.has?.(config.control_role_id));
        const mine = here.filter((s) => controller || s.hostId === interaction.user.id);
        if (!mine.length) return interaction.reply({ content: here.length ? 'Only the host or a mod can stop Watch Together.' : 'Nothing is playing in this server.', ephemeral: true });
        for (const s of mine) await sessions.end(s, 'stopped from Discord');
        return interaction.reply({ content: `⏹ Stopped ${mine.length === 1 ? 'Watch Together' : `${mine.length} Watch Together sessions`}.`, ephemeral: true });
    }
    if (sub === 'skip' || sub === 'queue') {
        return interaction.reply({ content: 'In Watch Together the queue and the skip button are in the Activity (the Queue tab).', ephemeral: true });
    }
    return null; // 'play': the caller runs the usual pickers; their Start button launches the Activity
}

