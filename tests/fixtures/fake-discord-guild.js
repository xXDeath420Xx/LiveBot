/**
 * An in-memory Discord guild with the discord.js surface core/backup-restore.js uses (roles, channels,
 * permission overwrites, positions, members, emojis, stickers, bans). Never talks to Discord.
 *
 *   const g = fakeGuild({ roles: [...], channels: [...], botTop: 50 });
 *   g.calls      every mutating call in order: ['createRole', name], ['deleteChannel', id], ...
 *   g.failNext('createRole', { status: 429, retryAfter: 0.001 })   the next call of that kind throws once
 *   g.failAlways('createChannel', { status: 403, code: 50013 }, (opts) => opts.name === 'x')
 */
import { Collection } from 'discord.js';

let seq = 900000000000000000n;
export const nextId = () => String(++seq);

const bits = (v) => ({ bitfield: BigInt(v ?? 0) });

export function fakeGuild({ id = '100000000000000001', name = 'Test Guild', roles = [], channels = [], members = [], botTop = 100, emojis = [], stickers = [], bans = [] } = {}) {
    const calls = [];
    const once = new Map();
    const always = [];
    const maybeFail = (op, opts) => {
        if (once.has(op)) { const e = once.get(op); once.delete(op); throw Object.assign(new Error(e.message || `${op} failed`), e); }
        for (const f of always) if (f.op === op && (!f.when || f.when(opts))) throw Object.assign(new Error(f.err.message || `${op} failed`), f.err);
    };

    const guild = {
        id, name, calls,
        description: null, verificationLevel: 0, defaultMessageNotifications: 0, explicitContentFilter: 0,
        afkTimeout: 300, premiumProgressBarEnabled: false, systemChannelFlags: { bitfield: 0 },
        afkChannelId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null,
        failNext(op, err) { once.set(op, err); },
        failAlways(op, err, when) { always.push({ op, err, when }); },
        async edit(opts) { maybeFail('editGuild', opts); calls.push(['editGuild', Object.keys(opts).filter(k => k !== 'reason').sort().join(',')]); for (const [k, v] of Object.entries(opts)) if (k !== 'reason') guild[k.endsWith('Channel') ? `${k}Id` : k] = v; return guild; },
    };

    // ── roles ──
    function makeRole(r) {
        const role = {
            id: r.id || nextId(), name: r.name, color: r.color ?? 0, hoist: !!r.hoist, mentionable: !!r.mentionable,
            permissions: bits(r.permissions ?? 0), position: r.position ?? 1, managed: !!r.managed,
            async edit(o) {
                maybeFail('editRole', { ...o, id: role.id });
                calls.push(['editRole', role.name, Object.keys(o).filter(k => k !== 'reason').sort().join(',')]);
                for (const k of ['name', 'color', 'hoist', 'mentionable']) if (o[k] !== undefined) role[k] = o[k];
                if (o.permissions !== undefined) role.permissions = bits(o.permissions);
                return role;
            },
            async delete() { maybeFail('deleteRole', role); calls.push(['deleteRole', role.name]); roleCache.delete(role.id); },
        };
        return role;
    }
    const everyone = makeRole({ id, name: '@everyone', position: 0, permissions: r0(roles) });
    function r0(list) { return list.find(r => r.everyone)?.permissions ?? 1024; }
    const roleCache = new Collection([[id, everyone]]);
    const botRole = makeRole({ id: '100000000000000099', name: 'CertiFried', position: botTop, managed: true, permissions: 8 });
    roleCache.set(botRole.id, botRole);
    for (const r of roles.filter(x => !x.everyone)) { const role = makeRole(r); roleCache.set(role.id, role); }
    guild.roles = {
        cache: roleCache, everyone,
        async create(o) {
            maybeFail('createRole', o);
            calls.push(['createRole', o.name]);
            // Discord puts a new role at position 1 and moves every other non-@everyone role up one
            for (const r of roleCache.values()) if (r.position >= 1) r.position += 1;
            const role = makeRole({ ...o, permissions: o.permissions, position: 1 });
            roleCache.set(role.id, role);
            return role;
        },
        async setPositions(list) {
            maybeFail('setRolePositions', list);
            calls.push(['setRolePositions', list.length]);
            for (const { role, position } of list) { const r = roleCache.get(role); if (r.position >= botRole.position || position >= botRole.position) throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 }); r.position = position; }
        },
    };

    // ── channels ──
    function makeOverwrites(list) {
        const cache = new Collection((list || []).map(o => [String(o.id), { id: String(o.id), type: o.type, allow: bits(o.allow), deny: bits(o.deny) }]));
        return {
            cache,
            async set(next) {
                maybeFail('setOverwrites', next);
                calls.push(['setOverwrites', next.length]);
                cache.clear();
                for (const o of next) cache.set(String(o.id), { id: String(o.id), type: o.type, allow: bits(o.allow), deny: bits(o.deny) });
            },
        };
    }
    function makeChannel(c) {
        const ch = {
            id: c.id || nextId(), name: c.name, type: c.type ?? 0, parentId: c.parentId ?? c.parent ?? null,
            rawPosition: c.position ?? 0, topic: c.topic ?? null, nsfw: !!c.nsfw, rateLimitPerUser: c.rateLimitPerUser ?? 0,
            bitrate: c.bitrate ?? null, userLimit: c.userLimit ?? null,
            permissionOverwrites: makeOverwrites(c.permissionOverwrites || c.overwrites),
            isThread: () => false,
            get position() { return ch.rawPosition; },
            async edit(o) {
                maybeFail('editChannel', { ...o, id: ch.id, name: ch.name });
                calls.push(['editChannel', ch.name, Object.keys(o).filter(k => k !== 'reason').sort().join(',')]);
                for (const k of ['name', 'topic', 'nsfw', 'rateLimitPerUser', 'bitrate', 'userLimit']) if (o[k] !== undefined) ch[k] = o[k];
                if ('parent' in o) ch.parentId = o.parent ?? null;
                return ch;
            },
            async delete() { maybeFail('deleteChannel', ch); calls.push(['deleteChannel', ch.name]); chanCache.delete(ch.id); },
        };
        return ch;
    }
    const chanCache = new Collection();
    for (const c of channels) { const ch = makeChannel(c); chanCache.set(ch.id, ch); }
    guild.channels = {
        cache: chanCache,
        async create(o) {
            maybeFail('createChannel', o);
            if (o.parent && !chanCache.has(o.parent)) throw Object.assign(new Error('Unknown parent'), { status: 400 });
            for (const ow of o.permissionOverwrites || []) {
                if (ow.type === 0 && !roleCache.has(String(ow.id))) throw Object.assign(new Error(`Unknown role in overwrite ${ow.id}`), { status: 400 });
            }
            calls.push([o.type === 4 ? 'createCategory' : 'createChannel', o.name]);
            const siblings = [...chanCache.values()].filter(x => (x.type === 4) === (o.type === 4) && (x.parentId || null) === (o.parent || null));
            const ch = makeChannel({ ...o, parentId: o.parent || null, position: siblings.length ? Math.max(...siblings.map(s => s.rawPosition)) + 1 : 0 });
            chanCache.set(ch.id, ch);
            return ch;
        },
        async setPositions(list) {
            maybeFail('setChannelPositions', list);
            calls.push(['setChannelPositions', list.length]);
            for (const { channel, position } of list) chanCache.get(channel).rawPosition = position;
        },
    };

    // ── members ──
    const memberCache = new Collection();
    for (const m of members) {
        const rc = new Collection((m.roles || []).map(rid => [rid, roleCache.get(rid)]));
        memberCache.set(m.id, {
            id: m.id, user: { id: m.id, username: m.username || `user${m.id}` },
            roles: { cache: rc, async add(ids) { maybeFail('addMemberRoles', ids); calls.push(['addMemberRoles', m.id, [].concat(ids).length]); for (const rid of [].concat(ids)) rc.set(rid, roleCache.get(rid)); } },
        });
    }
    const banCache = new Collection(bans.map(b => [b.userId, { user: { id: b.userId } }]));
    guild.members = {
        cache: memberCache,
        me: { roles: { highest: botRole } },
        async fetch(id) { if (id) return memberCache.get(id) ?? null; return memberCache; },
        async ban(userId) { maybeFail('ban', userId); calls.push(['ban', userId]); banCache.set(userId, { user: { id: userId } }); },
    };
    guild.bans = { async fetch() { return banCache; } };
    guild.emojis = { cache: new Collection(emojis.map(e => [nextId(), { name: e }])), async create(o) { maybeFail('createEmoji', o); calls.push(['createEmoji', o.name]); guild.emojis.cache.set(nextId(), { name: o.name }); } };
    guild.stickers = { cache: new Collection(stickers.map(s => [nextId(), { name: s }])), async create(o) { maybeFail('createSticker', o); calls.push(['createSticker', o.name]); guild.stickers.cache.set(nextId(), { name: o.name }); } };

    // helpers for assertions
    guild.roleByName = (n) => [...roleCache.values()].find(r => r.name === n);
    guild.channelByName = (n, type) => [...chanCache.values()].find(c => c.name === n && (type === undefined || c.type === type));
    guild.orderedRoleNames = () => [...roleCache.values()].filter(r => r.id !== id && !r.managed).sort((a, b) => b.position - a.position).map(r => r.name);
    guild.childrenOf = (catId) => [...chanCache.values()].filter(c => c.type !== 4 && (c.parentId || null) === catId).sort((a, b) => a.rawPosition - b.rawPosition).map(c => c.name);
    guild.categoryNames = () => [...chanCache.values()].filter(c => c.type === 4).sort((a, b) => a.rawPosition - b.rawPosition).map(c => c.name);
    return guild;
}
