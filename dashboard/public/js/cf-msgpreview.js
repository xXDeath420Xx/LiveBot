/*
 * cf-msgpreview.js — THE dashboard's Discord message preview. Every page that shows how a message the
 * bot posts will look draws it with this file and /css/cf-msgpreview.css (the .cf-dc classes), so the
 * preview looks and parses the same everywhere.
 *
 * It replaced three versions built in parallel (2026-11-18, register H-115): /js/cf-preview.js
 * (CFPreview), partials/kit/_discord-preview.ejs (cfDiscordPreview) and the .gk-dc markup of
 * partials/manage/_game-kit.ejs. Their APIs are kept below as thin adapters, so pages written for them
 * work unchanged; new pages use CFMsgPreview.
 *
 * Everything is built with createElement/textContent: nothing typed on a page or stored in the database
 * can become markup. Links are shown, never followed.
 *
 *   CFMsgPreview.render(target, msg, ctx)   replaces target's children with one message:
 *     msg  { username, avatarUrl, bot (default true: the APP tag), content, vars,
 *            embeds: [{ color, author: { name, iconUrl } | 'name', title, url, description,
 *                       fields: [{ name, value, inline }], thumbnail, image, footer: { text } | 'text',
 *                       timestamp }],
 *            attachments: [{ placeholder: 'clip.mp4' }],
 *            buttons: [{ label, style }]   style primary|success|danger|secondary; none = a link button,
 *            reactions: [{ emoji, count, mine }]   emoji: unicode, or <:name:id> / <a:name:id>,
 *            note: a quiet line under the message, emptyText: shown when there is nothing to send }
 *          image / thumbnail: an http(s) URL, true for a grey box, { placeholder: 'text' }, or a DOM node
 *          (image only). vars: {name} in every text is replaced first (see fill).
 *     ctx  names for mentions; lists or maps both work:
 *          { channels: [{ id, name }] | { id: name }, roles: [{ id, name, color }] | { id: { name, color } },
 *            users: [{ id, name }] | { id: name } }
 *   CFMsgPreview.fill(text, vars)       {name} becomes vars[name]; unknown {tokens} stay as typed
 *   CFMsgPreview.mention(label)         a value for vars/content that shows as a mention pill
 *   CFMsgPreview.markdown(text, ctx)    Discord block markdown as an element (headings, -# small text,
 *                                       quotes, lists, line breaks)
 *   CFMsgPreview.inline(text, ctx, node) inline markdown appended to node: **bold**, *italic*, ***both***,
 *                                       __underline__, ~~strike~~, ||spoiler||, `code`, [text](url),
 *                                       links, <#channel>, <@&role>, <@user>, @everyone / @here
 *   CFMsgPreview.clip(text, max), .colour(value, fallback)
 */
(function () {
    'use strict';
    if (window.CFMsgPreview) return;

    var CSS_HREF = '/css/cf-msgpreview.css';
    var OPEN = '', CLOSE = '';   // mention() markers (private-use characters)
    var CUSTOM_EMOJI = /^<(a?):(\w+):(\d{5,25})>$/;

    function ensureCss() {
        if (document.querySelector('link[data-cf-msgpreview], link[href^="' + CSS_HREF + '"]')) return;
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = CSS_HREF;
        l.setAttribute('data-cf-msgpreview', '');
        (document.head || document.documentElement).appendChild(l);
    }
    ensureCss();

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }
    function isNode(v) { return !!v && typeof v === 'object' && typeof v.nodeType === 'number'; }
    function safeUrl(u) { var s = String(u == null ? '' : u).trim(); return /^https?:\/\/\S+$/i.test(s) ? s : null; }
    function clip(t, max) { t = String(t == null ? '' : t); return t.length > max ? t.slice(0, max - 1) + '…' : t; }
    function colour(value, fallback) {
        if (typeof value === 'number' && isFinite(value)) return '#' + Math.max(0, value).toString(16).padStart(6, '0').slice(-6);
        var m = String(value == null ? '' : value).trim().match(/^#?([0-9a-f]{6})$/i);
        return m ? '#' + m[1].toLowerCase() : (fallback === undefined ? null : fallback);
    }
    function clock() { return 'Today at ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    function fill(text, vars) {
        var v = vars || {};
        return String(text == null ? '' : text).replace(/\{([a-zA-Z_][\w.]*)\}/g, function (all, k) {
            return Object.prototype.hasOwnProperty.call(v, k) && v[k] != null ? String(v[k]) : all;
        });
    }
    function mention(label) { return OPEN + String(label == null ? '' : label) + CLOSE; }

    // ---- names for mentions -------------------------------------------------------------------
    function lookup(source, id) {
        if (!source) return null;
        if (Array.isArray(source)) {
            for (var i = 0; i < source.length; i++) {
                if (source[i] && String(source[i].id) === id) return { name: source[i].name, color: source[i].color };
            }
            return null;
        }
        var hit = Object.prototype.hasOwnProperty.call(source, id) ? source[id] : null;
        if (hit == null) return null;
        return typeof hit === 'object' ? { name: hit.name, color: hit.color } : { name: hit };
    }
    function pill(text, roleColour) {
        var n = el('span', 'cf-dc-mention', text);
        var c = colour(roleColour);
        if (c && c !== '#000000') {
            n.style.color = c;
            n.style.background = 'color-mix(in srgb, ' + c + ' 18%, transparent)';
        }
        return n;
    }

    // ---- inline markdown ----------------------------------------------------------------------
    var INLINE = [
        { re: /^([^]*)?/, kind: 'pill' },
        { re: /^<#(\d{5,25})>/, kind: 'channel' },
        { re: /^<@&(\d{5,25})>/, kind: 'role' },
        { re: /^<@!?(\d{5,25})>/, kind: 'user' },
        { re: /^@(everyone|here)\b/, kind: 'everyone' },
        { re: /^`([^`\n]+)`/, kind: 'code' },
        { re: /^\*\*\*([\s\S]+?)\*\*\*/, kind: 'bi' },
        { re: /^\*\*([\s\S]+?)\*\*/, kind: 'b' },
        { re: /^__([\s\S]+?)__/, kind: 'u' },
        { re: /^~~([\s\S]+?)~~/, kind: 's' },
        { re: /^\|\|([\s\S]+?)\|\|/, kind: 'spoiler' },
        { re: /^\*([^*\s][^*\n]*?)\*/, kind: 'i' },
        { re: /^_([^_\n]+?)_(?![a-z0-9])/i, kind: 'i' },
        { re: /^\[([^\]\n]{1,256})\]\((https?:\/\/[^)\s]+)\)/, kind: 'mlink' },
        { re: /^(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/, kind: 'link' },
        { re: /^\\([\\*_~`|#>\-[\]()])/, kind: 'escape' }
    ];
    var TRIGGERS = '<@`*_~|[h\\';

    function inline(text, ctx, out) {
        ctx = ctx || {};
        out = out || document.createDocumentFragment();
        text = String(text == null ? '' : text);
        var buf = '';
        function flush() { if (buf) { out.appendChild(document.createTextNode(buf)); buf = ''; } }
        var i = 0;
        while (i < text.length) {
            var ch = text.charAt(i);
            var kind = null, m = null;
            if (TRIGGERS.indexOf(ch) !== -1) {
                var rest = text.slice(i);
                for (var k = 0; k < INLINE.length; k++) {
                    m = rest.match(INLINE[k].re);
                    if (m) { kind = INLINE[k].kind; break; }
                }
            }
            if (!kind) { buf += ch; i++; continue; }
            flush();
            var node, hit;
            switch (kind) {
                case 'pill': node = pill(m[1]); break;
                case 'channel': hit = lookup(ctx.channels, m[1]); node = pill('#' + (hit && hit.name ? hit.name : 'unknown-channel')); break;
                case 'role': hit = lookup(ctx.roles, m[1]); node = pill('@' + (hit && hit.name ? hit.name : 'unknown-role'), hit && hit.color); break;
                case 'user': hit = lookup(ctx.users, m[1]); node = pill('@' + (hit && hit.name ? hit.name : 'member')); break;
                case 'everyone': node = pill('@' + m[1]); break;
                case 'code': node = el('code', 'cf-dc-code', m[1]); break;
                case 'bi': node = el('strong'); node.appendChild(inline(m[1], ctx, el('em'))); break;
                case 'b': node = inline(m[1], ctx, el('strong')); break;
                case 'u': node = inline(m[1], ctx, el('u')); break;
                case 's': node = inline(m[1], ctx, el('s')); break;
                case 'i': node = inline(m[1], ctx, el('em')); break;
                case 'spoiler':
                    node = inline(m[1], ctx, el('span', 'cf-dc-spoiler'));
                    node.addEventListener('click', function () { this.classList.add('is-shown'); });
                    break;
                case 'mlink': node = inline(m[1], ctx, el('span', 'cf-dc-link')); node.title = m[2]; break;
                case 'link': node = el('span', 'cf-dc-link', m[1]); break;
                default: node = document.createTextNode(m[1]); break;   // an escaped character
            }
            out.appendChild(node);
            i += m[0].length;
        }
        flush();
        return out;
    }

    // ---- block markdown -----------------------------------------------------------------------
    function markdown(text, ctx, cls) {
        ctx = ctx || {};
        var root = el('div', cls || 'cf-dc-md');
        var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
        lines.forEach(function (line, idx) {
            var m;
            if ((m = line.match(/^(#{1,3}) (.+)$/))) inline(m[2], ctx, root.appendChild(el('div', 'cf-dc-h cf-dc-h' + m[1].length)));
            else if ((m = line.match(/^-# (.+)$/))) inline(m[1], ctx, root.appendChild(el('div', 'cf-dc-sub')));
            else if ((m = line.match(/^> ?(.*)$/))) inline(m[1] || ' ', ctx, root.appendChild(el('div', 'cf-dc-quote')));
            else if ((m = line.match(/^\s*[-*] (.+)$/))) {
                var li = root.appendChild(el('div', 'cf-dc-li'));
                li.appendChild(document.createTextNode('• '));
                inline(m[1], ctx, li);
            } else {
                inline(line, ctx, root);
                var next = lines[idx + 1];
                if (idx < lines.length - 1 && !/^(#{1,3} |-# |> ?|\s*[-*] )/.test(next)) root.appendChild(document.createElement('br'));
            }
        });
        return root;
    }

    // ---- message ------------------------------------------------------------------------------
    function media(spec, cls, fallback, ctx) {
        if (!spec) return null;
        if (isNode(spec)) return spec;
        var url = typeof spec === 'string' ? safeUrl(spec) : null;
        if (url) {
            var img = el('img', cls);
            img.alt = '';
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            img.src = url;
            img.addEventListener('error', function () { img.replaceWith(el('div', cls + ' cf-dc-ph', fallback)); });
            return img;
        }
        var label = (spec && typeof spec === 'object' && spec.placeholder != null) ? spec.placeholder
            : (typeof spec === 'string' ? spec : fallback);
        return inline(label, ctx, el('div', cls + ' cf-dc-ph'));
    }

    function hasEmbed(e) {
        return !!(e && (e.title || e.description || e.text || (e.author && (e.author.name || typeof e.author === 'string'))
            || (e.footer && (e.footer.text || typeof e.footer === 'string')) || e.image || e.thumbnail
            || (e.fields && e.fields.some(function (f) { return f && (f.name || f.value); }))));
    }

    function embed(e, ctx, vars) {
        var box = el('div', 'cf-dc-embed');
        // No colour: Discord's plain dark bar. (Markup written by a page defaults to the blurple in the CSS.)
        // No colour: Discord's plain embed edge, which differs between its dark and light themes (cf-msgpreview.css).
        box.style.setProperty('--cf-dc-bar', colour(e.color != null ? e.color : e.colour) || 'var(--cf-dc-bar-none, #1e1f22)');
        var thumb = media(e.thumbnail, 'cf-dc-thumb', '', ctx);
        if (thumb) { box.classList.add('has-thumb'); box.appendChild(thumb); }
        var author = typeof e.author === 'string' ? { name: e.author } : e.author;
        if (author && author.name) {
            var a = el('div', 'cf-dc-author');
            var icon = safeUrl(author.iconUrl || author.icon_url);
            if (icon) { var ai = el('img'); ai.alt = ''; ai.referrerPolicy = 'no-referrer'; ai.src = icon; a.appendChild(ai); }
            inline(clip(fill(author.name, vars), 256), ctx, a);
            box.appendChild(a);
        }
        if (e.title) {
            var t = el('div', 'cf-dc-title' + (safeUrl(e.url) ? ' is-link' : ''));
            inline(clip(fill(e.title, vars), 256), ctx, t);
            box.appendChild(t);
        }
        var desc = e.description != null ? e.description : e.text;
        if (desc) box.appendChild(markdown(clip(fill(desc, vars), 4096), ctx, 'cf-dc-md cf-dc-desc'));
        var fields = (e.fields || []).filter(function (f) { return f && (f.name || f.value); });
        if (fields.length) {
            var grid = el('div', 'cf-dc-fields');
            fields.slice(0, 25).forEach(function (f) {
                var cell = el('div', 'cf-dc-field' + (f.inline ? '' : ' is-wide'));
                inline(clip(fill(f.name || '', vars), 256), ctx, cell.appendChild(el('div', 'cf-dc-fname')));
                cell.appendChild(markdown(clip(fill(f.value || '', vars), 1024), ctx, 'cf-dc-md cf-dc-fvalue'));
                grid.appendChild(cell);
            });
            box.appendChild(grid);
        }
        var image = media(e.image, 'cf-dc-image', 'Image', ctx);
        if (image) box.appendChild(image);
        var foot = [];
        var ft = typeof e.footer === 'string' ? e.footer : (e.footer && e.footer.text);
        if (ft) foot.push(clip(fill(ft, vars), 2048));
        if (e.timestamp) foot.push(clock());
        if (foot.length) box.appendChild(el('div', 'cf-dc-footer', foot.join(' • ')));
        return box;
    }

    function emojiNode(e) {
        var m = String(e == null ? '' : e).match(CUSTOM_EMOJI);
        if (!m) return document.createTextNode(String(e == null ? '' : e));
        var img = el('img');
        img.src = 'https://cdn.discordapp.com/emojis/' + m[3] + '.' + (m[1] ? 'gif' : 'png') + '?size=32';
        img.alt = ':' + m[2] + ':';
        img.referrerPolicy = 'no-referrer';
        return img;
    }

    function render(target, msg, ctx) {
        if (!target) return;
        msg = msg || {};
        ctx = ctx || {};
        var vars = msg.vars || {};
        var root = el('div', 'cf-dc');
        root.setAttribute('aria-label', 'Message preview');
        var name = String(msg.username || 'CertiFried Utility');
        var avatar = safeUrl(msg.avatarUrl);
        if (avatar) {
            var av = el('img', 'cf-dc-av');
            av.alt = '';
            av.referrerPolicy = 'no-referrer';
            av.src = avatar;
            av.addEventListener('error', function () { av.replaceWith(el('span', 'cf-dc-av is-blank', name.trim().charAt(0).toUpperCase() || 'C')); });
            root.appendChild(av);
        } else {
            root.appendChild(el('span', 'cf-dc-av is-blank', name.trim().charAt(0).toUpperCase() || 'C'));
        }
        var head = el('div', 'cf-dc-head');
        head.appendChild(el('span', 'cf-dc-name', name));
        if (msg.bot !== false) head.appendChild(el('span', 'cf-dc-tag', 'APP'));
        head.appendChild(el('span', 'cf-dc-time', clock()));
        root.appendChild(head);

        var shown = 0;
        if (msg.content && String(msg.content).trim()) {
            root.appendChild(markdown(clip(fill(msg.content, vars), 2000), ctx, 'cf-dc-md cf-dc-text'));
            shown++;
        }
        (msg.attachments || []).forEach(function (f) {
            root.appendChild(el('div', 'cf-dc-attachment cf-dc-ph', (f && f.placeholder) || 'Attachment'));
            shown++;
        });
        (msg.embeds || []).filter(hasEmbed).slice(0, 10).forEach(function (e) { root.appendChild(embed(e, ctx, vars)); shown++; });
        if (msg.buttons && msg.buttons.length) {
            var row = el('div', 'cf-dc-buttons');
            msg.buttons.forEach(function (b) {
                var style = b && b.style && b.style !== 'link' ? b.style : null;
                var bt = el('span', 'cf-dc-btn' + (style && style !== 'secondary' ? ' is-' + style : ''), clip(b && b.label || 'Link', 80));
                if (!style) {
                    var ic = el('i', 'fas fa-arrow-up-right-from-square');
                    ic.setAttribute('aria-hidden', 'true');
                    bt.appendChild(ic);
                }
                row.appendChild(bt);
            });
            root.appendChild(row);
            shown++;
        }
        if (msg.reactions && msg.reactions.length) {
            var rrow = el('div', 'cf-dc-reacts');
            msg.reactions.forEach(function (r) {
                var chip = el('span', 'cf-dc-react' + (r && r.mine ? ' is-mine' : ''));
                chip.appendChild(emojiNode(r && r.emoji));
                chip.appendChild(document.createTextNode(String(r && r.count != null ? r.count : 1)));
                rrow.appendChild(chip);
            });
            root.appendChild(rrow);
        }
        if (!shown) root.appendChild(el('div', 'cf-dc-empty', msg.emptyText || 'Nothing to send yet.'));
        if (msg.note) inline(msg.note, ctx, root.appendChild(el('p', 'cf-dc-note')));
        target.replaceChildren(root);
    }

    window.CFMsgPreview = {
        render: render, fill: fill, mention: mention, markdown: markdown, inline: inline, clip: clip, colour: colour
    };

    // ---- the older APIs, kept so pages written for them work unchanged ------------------------

    // CFPreview (was /js/cf-preview.js): render(box, { content, embed: { colour, author, title, text,
    // fields: [{ name, value, wide }], thumb, image, foot }, buttons: [{ label, style }], reactions, note }).
    if (!window.CFPreview) {
        window.CFPreview = {
            render: function (box, m) {
                m = m || {};
                var e = m.embed;
                render(box, {
                    username: m.username,
                    avatarUrl: m.avatarUrl,
                    content: m.content,
                    embeds: e ? [{
                        color: colour(e.colour != null ? e.colour : e.color, '#5865f2'),
                        author: e.author ? { name: e.author } : null,
                        title: e.title,
                        description: e.text,
                        fields: (e.fields || []).map(function (f) { return { name: f.name, value: f.value, inline: !f.wide }; }),
                        thumbnail: e.thumb ? (safeUrl(e.thumb) || true) : null,
                        image: e.image == null || e.image === '' ? null
                            : (isNode(e.image) || safeUrl(e.image) ? e.image : { placeholder: String(e.image) }),
                        footer: e.foot ? { text: e.foot } : null
                    }] : [],
                    buttons: (m.buttons || []).map(function (b) { return { label: b.label, style: b.style || 'secondary' }; }),
                    reactions: m.reactions,
                    note: m.note,
                    emptyText: 'Nothing to show yet.'
                }, {});
            },
            fill: fill, mention: mention, clip: clip, colour: colour
        };
    }

    // cfDiscordPreview (was partials/kit/_discord-preview.ejs): render(box, { content, embeds, names,
    // vars, botName, emptyText }) and markdown(text, names, vars) for a page that draws its own frame.
    if (!window.cfDiscordPreview) {
        window.cfDiscordPreview = {
            render: function (box, opts) {
                opts = opts || {};
                render(box, {
                    username: opts.botName || 'CertiFried Utility',
                    avatarUrl: opts.avatarUrl,
                    content: opts.content,
                    vars: opts.vars || {},
                    embeds: (opts.embeds || []).map(function (e) {
                        return {
                            color: e.color,
                            author: e.author && e.author.name ? { name: e.author.name, iconUrl: e.author.icon_url || e.author.iconUrl } : null,
                            title: e.title,
                            url: e.url,
                            description: e.description,
                            fields: e.fields,
                            thumbnail: safeUrl(e.thumbnail),
                            image: safeUrl(e.image),
                            footer: e.footer,
                            timestamp: e.timestamp
                        };
                    }),
                    emptyText: opts.emptyText || 'The message shows here as you type.'
                }, opts.names || {});
            },
            markdown: function (text, names, vars) {
                var frag = document.createDocumentFragment();
                var root = markdown(fill(text, vars || {}), names || {});
                while (root.firstChild) frag.appendChild(root.firstChild);
                return frag;
            }
        };
    }
})();
