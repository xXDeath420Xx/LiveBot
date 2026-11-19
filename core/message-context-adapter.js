import logger from '../utils/logger.js';

/** Thrown when a prefix-invoked command tries to open a modal (needs a real interaction). */
export class ModalUnsupportedError extends Error {
    constructor(commandName) {
        super(`/${commandName} opens a popup form and can only be used as a slash command.`);
        this.name = 'ModalUnsupportedError';
        this.commandName = commandName;
    }
}

/**
 * Wraps a Discord Message to look like a ChatInputCommandInteraction.
 * Allows existing slash command handlers to work with prefix commands.
 */
export class MessageContextAdapter {
    /**
     * @param meta {{subcommand?: string, subcommandGroup?: string}} set when a slash
     *   command is reached through the universal prefix bridge, so handlers that call
     *   `interaction.options.getSubcommand()` behave identically.
     */
    constructor(message, commandName, parsedArgs = {}, meta = {}) {
        this.message = message;
        this.commandName = commandName;
        this._parsedArgs = parsedArgs;
        this._meta = meta;
        this._replied = false;
        this._deferred = false;
        this._replyMessage = null;

        // Mirror interaction properties
        this.member = message.member;
        this.user = message.author;
        this.guild = message.guild;
        this.channel = message.channel;
        this.channelId = message.channelId;
        this.guildId = message.guildId;
        this.client = message.client;
        this.id = message.id;
        this.createdTimestamp = message.createdTimestamp;

        // Options resolver
        this.options = new PrefixOptionsResolver(parsedArgs, message, meta);
    }

    get deferred() { return this._deferred; }
    get replied() { return this._replied; }

    /**
     * Discord resolves this per-channel on a real interaction. A message gives us the
     * member's channel-aware permissions, which is the same thing every caller wants.
     * Without it, `interaction.memberPermissions?.has(...)` is silently `undefined` —
     * so an admin using `!command` would be told they lack permission.
     */
    get memberPermissions() {
        if (!this.guild || !this.member) return null;
        return this.channel?.permissionsFor?.(this.member) ?? this.member.permissions ?? null;
    }

    isRepliable() { return true; }

    /**
     * Private replies from chat. A chat message cannot answer ephemerally, so a private reply is
     * normally posted in the channel like any other. Paths that reply with something only the member
     * should see (core/command-registration.js PRIVATE_TEXT_PATHS; the bridge sets meta.privateDm)
     * send it by DM instead, with a one-line note in the channel. If the DM fails, the content is NOT
     * posted publicly; the member is told to open their DMs.
     * @returns {Promise<import('discord.js').Message|null|undefined>} undefined when not private
     */
    async _sendPrivate(options) {
        if (!this._meta?.privateDm) return undefined;
        const o = typeof options === 'string' ? { content: options } : (options || {});
        const flags = Number(o.flags) || 0;
        if (!(o.ephemeral === true || (flags & 64) === 64)) return undefined;
        const payload = { ...o };
        delete payload.ephemeral;
        delete payload.flags;
        try {
            const dm = await this.user.send(payload);
            if (!this._privateNoted) {
                this._privateNoted = true;
                this._replied = true;
                this._replyMessage = await this.message.reply({ content: 'Sent you the result by DM.', allowedMentions: { repliedUser: false } }).catch(() => null);
            }
            return dm;
        } catch {
            this._replied = true;
            if (!this._privateNoted) {
                this._privateNoted = true;
                this._replyMessage = await this.message.reply({
                    content: 'That reply is private, but your DMs are closed. Allow DMs from server members and try again.',
                    allowedMentions: { repliedUser: false },
                }).catch(() => null);
            }
            return null;
        }
    }

    inGuild() { return !!this.guildId; }
    inCachedGuild() { return !!this.guild; }

    /**
     * Modals need a real interaction token — a chat message has none. Throw a
     * recognizable error so the caller can tell the user to use the slash command.
     */
    async showModal() { throw new ModalUnsupportedError(this.commandName); }

    isCommand() { return true; }
    isChatInputCommand() { return true; }
    isButton() { return false; }
    isSelectMenu() { return false; }
    isModalSubmit() { return false; }
    isAutocomplete() { return false; }

    async deferReply({ ephemeral, flags } = {}) {
        if (this._deferred || this._replied) return;
        this._deferred = true;
        this._deferredPrivate = ephemeral === true || ((Number(flags) || 0) & 64) === 64;
        // Show typing indicator as the "deferred" equivalent
        await this.channel.sendTyping().catch(() => {});
    }

    async reply(options) {
        const priv = await this._sendPrivate(options);
        if (priv !== undefined) return priv;
        if (this._replied) return this.followUp(options);
        this._replied = true;

        const payload = typeof options === 'string' ? { content: options } : { ...options };

        // Strip ephemeral flag — prefix commands can't do ephemeral
        delete payload.ephemeral;
        delete payload.flags;

        try {
            this._replyMessage = await this.message.reply(payload);
            return this._replyMessage;
        } catch (error) {
            // If reply fails (e.g., message deleted), try sending to channel
            logger.warn('[PrefixCmd] reply() failed, sending to channel', { error: error.message });
            this._replyMessage = await this.channel.send(payload);
            return this._replyMessage;
        }
    }

    /**
     * The message we replied with. Commands that attach a button session key it on this id,
     * so it must be the same message the buttons will arrive on.
     */
    async fetchReply() {
        return this._replyMessage ?? null;
    }

    async editReply(options) {
        // A deferred private reply (deferReply({ ephemeral: true }) then editReply) is private too.
        if (this._meta?.privateDm && this._deferredPrivate && typeof options === 'object' && !options.ephemeral && !options.flags) {
            options = { ...options, ephemeral: true };
        } else if (this._meta?.privateDm && this._deferredPrivate && typeof options === 'string') {
            options = { content: options, ephemeral: true };
        }
        const priv = await this._sendPrivate(options);
        if (priv !== undefined) return priv;
        const payload = typeof options === 'string' ? { content: options } : { ...options };
        delete payload.ephemeral;
        delete payload.flags;

        if (this._replyMessage) {
            try {
                return await this._replyMessage.edit(payload);
            } catch {
                // Message may have been deleted
                this._replyMessage = await this.channel.send(payload);
                return this._replyMessage;
            }
        }
        // No reply yet — just send
        this._replied = true;
        this._replyMessage = await this.message.reply(payload);
        return this._replyMessage;
    }

    async followUp(options) {
        const priv = await this._sendPrivate(options);
        if (priv !== undefined) return priv;
        const payload = typeof options === 'string' ? { content: options } : { ...options };
        delete payload.ephemeral;
        delete payload.flags;
        return this.channel.send(payload);
    }

    async deleteReply() {
        if (this._replyMessage) {
            await this._replyMessage.delete().catch(() => {});
        }
    }
}

/**
 * Mimics interaction.options for prefix commands.
 * Maps named args (from the command definition) to parsed values.
 */
class PrefixOptionsResolver {
    constructor(parsedArgs, message, meta = {}) {
        this._args = parsedArgs;
        this._message = message;
        this._meta = meta;
    }

    /** Pull a snowflake out of <@123>, <@!123>, <#123>, <@&123>, or a bare id. */
    static _id(val) {
        const m = String(val).match(/^<(?:@[!&]?|#)(\d+)>$/);
        return m ? m[1] : (/^\d{17,20}$/.test(val) ? val : null);
    }

    getString(name) {
        return this._args[name] ?? null;
    }

    getInteger(name) {
        const val = this._args[name];
        if (val == null) return null;
        const num = parseInt(val, 10);
        return isNaN(num) ? null : num;
    }

    getNumber(name) {
        const val = this._args[name];
        if (val == null) return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
    }

    getBoolean(name) {
        const val = this._args[name]?.toLowerCase();
        if (val == null) return null;
        return ['true', 'yes', '1', 'on', 'enable'].includes(val);
    }

    getUser(name) {
        const val = this._args[name];
        if (!val) return null;
        const id = PrefixOptionsResolver._id(val);
        if (id) {
            // message.mentions is already resolved; the global cache may not be.
            return this._message.mentions.users.get(id)
                ?? this._message.client.users.cache.get(id)
                ?? null;
        }
        // Bare name/tag — match against members we can see.
        const needle = String(val).toLowerCase();
        const member = this._message.guild?.members.cache.find(m =>
            m.user.username.toLowerCase() === needle || m.displayName.toLowerCase() === needle);
        return member?.user ?? null;
    }

    getMember(name) {
        const user = this.getUser(name);
        if (!user) return null;
        return this._message.guild?.members.cache.get(user.id) ?? null;
    }

    getChannel(name) {
        const val = this._args[name];
        if (!val) return null;
        const id = PrefixOptionsResolver._id(val);
        if (id) {
            return this._message.mentions.channels.get(id)
                ?? this._message.guild?.channels.cache.get(id)
                ?? null;
        }
        const needle = String(val).toLowerCase().replace(/^#/, '');
        return this._message.guild?.channels.cache.find(c => c.name.toLowerCase() === needle) ?? null;
    }

    getRole(name) {
        const val = this._args[name];
        if (!val) return null;
        const id = PrefixOptionsResolver._id(val);
        if (id) {
            return this._message.mentions.roles.get(id)
                ?? this._message.guild?.roles.cache.get(id)
                ?? null;
        }
        const needle = String(val).toLowerCase().replace(/^@/, '');
        return this._message.guild?.roles.cache.find(r => r.name.toLowerCase() === needle) ?? null;
    }

    getMentionable(name) {
        return this.getUser(name) ?? this.getRole(name);
    }

    // `required` mirrors discord.js: throw rather than silently return null.
    getSubcommand(required = false) {
        const sub = this._meta.subcommand ?? null;
        if (!sub && required) throw new TypeError('No subcommand was provided.');
        return sub;
    }

    getSubcommandGroup(required = false) {
        const group = this._meta.subcommandGroup ?? null;
        if (!group && required) throw new TypeError('No subcommand group was provided.');
        return group;
    }

    // parseOptions (core/universal-commands.js) gives each file option its own attachment, in order.
    getAttachment(name) {
        const val = this._args[name];
        if (val && typeof val === 'object') return val;
        return this._message.attachments?.first?.() ?? null;
    }
}

export default MessageContextAdapter;
