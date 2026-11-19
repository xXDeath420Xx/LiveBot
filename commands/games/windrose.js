// /windrose — Discord front-end for the Windrose server panel.
//
// Deliberately imports the SAME permission module the web panel uses
// (dashboard/services/windrose-perms.js). A role must mean exactly the same
// thing in chat as it does in a browser; two implementations of "who may
// restart the server" is two chances to get it wrong, and the lax one wins.
//
// Everything here goes through windrose-agent over localhost, so the bot
// process never touches the Docker socket either.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import windroseAgent from '../../dashboard/services/windrose-client.js';
import { getRole, roleAtLeast, audit, isCommandAllowed, catalogNames } from '../../dashboard/services/windrose-perms.js';
import logger from '../../utils/logger.js';
import { announce, messages } from '../../dashboard/services/windrose-announce.js';

const BRASS = 0xd4a04a;
const PANEL_URL = 'https://certifriedmultitool.com/windrose';

function fail(message) {
    return { embeds: [new EmbedBuilder().setColor(0xf87171).setDescription(`❌ ${message}`)], flags: MessageFlags.Ephemeral };
}

/** Resolve the caller's role, or reject with a message pointing at the panel. */
async function requireAtLeast(interaction, minimum) {
    const role = await getRole(interaction.user.id);
    if (!roleAtLeast(role, minimum)) {
        return { role, denied: fail(`This needs the **${minimum}** role — you have **${role}**. Ask an owner at ${PANEL_URL}.`) };
    }
    return { role, denied: null };
}

export default {
    category: 'games',
    data: new SlashCommandBuilder()
        .setName('windrose')
        .setDescription('CertiFried Windrose server')
        .addSubcommand(s => s.setName('status').setDescription('Server status and who is online'))
        .addSubcommand(s => s.setName('join').setDescription('How to connect'))
        .addSubcommand(s => s.setName('players').setDescription('Who is sailing right now'))
        .addSubcommand(s => s.setName('restart').setDescription('Restart the server (admin) — warns players first'))
        .addSubcommand(s => s.setName('backup').setDescription('Take a world snapshot (admin)'))
        .addSubcommand(s => s
            .setName('rcon')
            .setDescription('Run a wp.* command (admin)')
            .addStringOption(o => o.setName('command').setDescription('e.g. wp.status').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        try {
            // Everything here talks to the agent and often to RCON (~4s), which
            // is well past Discord's 3s window.
            // 'join' can carry the password, so it is ephemeral like 'rcon'.
            const ephemeral = sub === 'rcon' || sub === 'join';
            await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });

            if (sub === 'join') {
                // Role decides whether the password is included, so this reply
                // is ephemeral either way — a join password in a public channel
                // defeats the point of having one.
                const role = await getRole(interaction.user.id);
                const status = await windroseAgent.status();
                const d = status.ok ? status.data : null;
                const addr = d?.connectAddress || 'windrose.certifriedmultitool.com:7777';
                const conn = d?.connection || {};
                // Only ever advertise the mode that is actually live — the two
                // are mutually exclusive and a dead code just wastes attempts.
                const inviteActive = conn.useDirectConnection === false;

                const embed = new EmbedBuilder()
                    .setColor(BRASS)
                    .setTitle('⚓ Join ' + (d?.world?.name || 'Windrose'));

                if (inviteActive && conn.inviteCode) {
                    embed.setDescription(`**Join Server → Join Code**, then enter:\n\`\`\`\n${conn.inviteCode}\n\`\`\``);
                } else {
                    // Two boxes in-game, and the first is labelled "IP" even
                    // though a hostname is what belongs in it.
                    const host = conn.host || addr.split(':')[0];
                    const port = conn.port || addr.split(':')[1] || 7777;
                    embed.setDescription('**Join Server → Direct Connection** — two separate boxes:')
                        .addFields(
                            { name: 'IP', value: `\`${host}\``, inline: true },
                            { name: 'Port', value: `\`${port}\``, inline: true },
                        );
                }
                // Answer the question rather than redirecting. The old text
                // sent people to the panel, and the panel sent them back to
                // Discord to ask an admin — a loop that helped nobody.
                if (conn.passwordProtected) {
                    if (roleAtLeast(role, 'player')) {
                        const secret = await windroseAgent.joinSecret();
                        embed.addFields({
                            name: 'Password',
                            value: secret.ok && secret.data.password ? `\`${secret.data.password}\`` : `See ${PANEL_URL}`,
                        });
                        await audit(interaction.user.id, 'join.password.view', { via: 'discord' }, 'ok');
                    } else {
                        embed.addFields({
                            name: 'Password',
                            value: 'You are not on the crew list yet. Ask an owner to add your Discord account — '
                                + `the password then shows automatically here and at ${PANEL_URL}`,
                        });
                    }
                }
                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'status' || sub === 'players') {
                const { denied } = await requireAtLeast(interaction, 'viewer');
                if (denied) return interaction.editReply(denied);

                const status = await windroseAgent.status();
                if (!status.ok) return interaction.editReply(fail(status.error || 'The server agent is not responding.'));

                const d = status.data;
                const server = d.server || {};
                const players = d.players || [];
                const state = d.healthy ? '🟢 Online' : d.container?.running ? '🟡 Starting' : '🔴 Offline';

                if (sub === 'players') {
                    const names = players.map((p) => `• ${p.name || p.player_name || 'Unknown sailor'}`).join('\n');
                    return interaction.editReply({
                        embeds: [new EmbedBuilder().setColor(BRASS).setTitle('🧭 Crew aboard')
                            .setDescription(players.length ? names : '*Nobody is sailing right now.*')
                            .setFooter({ text: `${server.player_count ?? 0}/${server.max_players ?? '?'}` })],
                    });
                }

                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(BRASS)
                        .setTitle('🧭 ' + ((d.world && d.world.name) || 'Windrose'))
                        .addFields(
                            { name: 'Status', value: state, inline: true },
                            { name: 'Players', value: `${server.player_count ?? 0}/${server.max_players ?? '?'}`, inline: true },
                            { name: 'Windrose+', value: server.windrose_plus ? `v${server.windrose_plus}` : '—', inline: true },
                            { name: 'Connect', value: `\`${d.connectAddress}\`` },
                            ...(d.world?.name ? [{ name: 'Server', value: server.name || '—', inline: true }] : []),
                        )
                        .setFooter({ text: 'certifriedmultitool.com/windrose' })],
                });
            }

            if (sub === 'restart') {
                const { role, denied } = await requireAtLeast(interaction, 'admin');
                if (denied) return interaction.editReply(denied);

                await audit(interaction.user.id, 'lifecycle.restart', { via: 'discord', role }, 'ok');
                // Graceful path runs for ~5 minutes; fire it and acknowledge.
                windroseAgent.restart(false).catch((err) => logger.error(`windrose discord restart: ${err.message}`));
                // Tell the people who are NOT in the game. In-game players get
                // the RCON warnings; this covers Discord.
                announce(interaction.client, messages.restartWarning(5))
                    .catch((err) => logger.warn(`windrose announce failed: ${err.message}`));
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(BRASS)
                        .setDescription('🔄 Restart started. Players get warnings at 5 minutes and 1 minute, and a snapshot is taken first.')],
                });
            }

            if (sub === 'backup') {
                const { role, denied } = await requireAtLeast(interaction, 'admin');
                if (denied) return interaction.editReply(denied);

                const out = await windroseAgent.snapshot({ kind: 'manual', createdBy: interaction.user.id, label: 'discord' });
                await audit(interaction.user.id, 'backup.snapshot', { via: 'discord', role }, out.ok ? 'ok' : 'error');
                if (!out.ok) return interaction.editReply(fail(out.error));
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0x34d399)
                        .setDescription(`💾 Snapshot saved — \`${out.data.filename}\` (${(out.data.sizeBytes / 1024).toFixed(1)} KB)`)],
                });
            }

            if (sub === 'rcon') {
                const { role, denied } = await requireAtLeast(interaction, 'admin');
                if (denied) return interaction.editReply(denied);

                const command = interaction.options.getString('command');
                // Same allowlist as the web console, including the owner-only
                // introspection families.
                const catalog = await windroseAgent.commands();
                const verdict = isCommandAllowed(role, command, catalog.ok ? catalogNames(catalog.data) : null);
                if (!verdict.allowed) {
                    await audit(interaction.user.id, 'rcon.denied', { via: 'discord', command, reason: verdict.reason }, 'denied');
                    return interaction.editReply(fail(verdict.reason));
                }

                const out = await windroseAgent.rcon(command);
                await audit(interaction.user.id, 'rcon', { via: 'discord', command: verdict.command }, out.ok ? 'ok' : 'error');
                if (!out.ok) return interaction.editReply(fail(out.error));

                const body = (out.data.message || '(no output)').slice(0, 1800);
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(BRASS).setTitle(`> ${verdict.command}`)
                        .setDescription(`\`\`\`\n${body}\n\`\`\``)],
                });
            }

            return interaction.editReply(fail('Unknown subcommand.'));
        } catch (err) {
            logger.error(`/arcade windrose ${sub} failed: ${err.message}`);
            const payload = fail('Something went wrong talking to the Windrose server.');
            return interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload);
        }
    },
};
