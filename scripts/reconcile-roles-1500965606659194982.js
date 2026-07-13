/**
 * Reconcile role usage in guild 1500965606659194982:
 *   - Use existing Owner role 1502751525728948366 (instead of duplicate I created)
 *   - Use existing Admin role 1502737822245978253 (instead of duplicate I created)
 *   - Migrate every channel permission overwrite from my duplicates to the existing roles
 *   - Delete the duplicate roles I created
 */
import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';

const EXISTING_OWNER_ROLE = '1502751525728948366';
const EXISTING_ADMIN_ROLE = '1502737822245978253';
const DUPLICATE_OWNER_ROLE = '1502814367597592596'; // "👑 Owner"
const DUPLICATE_ADMIN_ROLE = '1502814368549699754'; // "🛡️ Admin"

async function main() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
    await client.login(token);
    await new Promise(r => client.once('ready', r));
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();

    const log = (m) => console.log(`[Reconcile] ${m}`);

    const ownerExisting = guild.roles.cache.get(EXISTING_OWNER_ROLE);
    const adminExisting = guild.roles.cache.get(EXISTING_ADMIN_ROLE);
    if (!ownerExisting || !adminExisting) {
        console.error('Existing roles not found in guild');
        process.exit(1);
    }
    log(`Existing Owner: ${ownerExisting.name} (${ownerExisting.id})`);
    log(`Existing Admin: ${adminExisting.name} (${adminExisting.id})`);

    const dupOwner = guild.roles.cache.get(DUPLICATE_OWNER_ROLE);
    const dupAdmin = guild.roles.cache.get(DUPLICATE_ADMIN_ROLE);
    log(`Duplicate Owner present: ${dupOwner ? 'yes' : 'no'}`);
    log(`Duplicate Admin present: ${dupAdmin ? 'yes' : 'no'}`);

    // Walk every channel and migrate any overwrite from the duplicates to the existing roles.
    let migrated = 0, removed = 0;
    for (const [, ch] of guild.channels.cache) {
        for (const [dupId, existingRole] of [[DUPLICATE_OWNER_ROLE, ownerExisting], [DUPLICATE_ADMIN_ROLE, adminExisting]]) {
            const dup = ch.permissionOverwrites?.cache?.get(dupId);
            if (!dup) continue;
            // Read current allow/deny from the duplicate; replicate them onto the existing role.
            const allow = dup.allow.bitfield;
            const deny  = dup.deny.bitfield;
            try {
                await ch.permissionOverwrites.edit(existingRole.id, {
                    ViewChannel: allow & PermissionFlagsBits.ViewChannel ? true : (deny & PermissionFlagsBits.ViewChannel ? false : null),
                    SendMessages: allow & PermissionFlagsBits.SendMessages ? true : (deny & PermissionFlagsBits.SendMessages ? false : null),
                    EmbedLinks: allow & PermissionFlagsBits.EmbedLinks ? true : null,
                    Connect: allow & PermissionFlagsBits.Connect ? true : (deny & PermissionFlagsBits.Connect ? false : null),
                }, { reason: 'Reconcile: migrate overwrite from duplicate to existing role' });
                await ch.permissionOverwrites.delete(dupId, 'Reconcile: drop duplicate role overwrite').catch(() => {});
                migrated++;
                log(`  migrated ${ch.name}: ${dupId} -> ${existingRole.id}`);
            } catch (e) {
                log(`  ! failed to migrate ${ch.name} for ${dupId}: ${e.message}`);
            }
        }
    }
    log(`Migrated ${migrated} channel overwrites`);

    // Delete the duplicate roles
    for (const dup of [dupOwner, dupAdmin]) {
        if (!dup) continue;
        try {
            await dup.delete('Duplicate of existing role; reconciling');
            removed++;
            log(`  deleted duplicate role ${dup.name} (${dup.id})`);
        } catch (e) {
            log(`  ! failed to delete role ${dup?.name}: ${e.message}`);
        }
    }
    log(`Deleted ${removed} duplicate roles`);

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
