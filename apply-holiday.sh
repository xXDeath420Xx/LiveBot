#!/usr/bin/env bash
# Applies holiday-countdown changes on the server. Run via ssh.
set -euo pipefail
cd /home/death/CertiFriedUtility

STAMP=$(date +%s)
BAK="backups/pre-holiday-${STAMP}"
mkdir -p "$BAK"
cp dashboard/server.js "$BAK/server.js.bak"
cp dashboard/views/manage-tailwind.ejs "$BAK/manage-tailwind.ejs.bak"
cp dashboard/views/manage-classic.ejs "$BAK/manage-classic.ejs.bak"
echo "backup created in $BAK"

# ── 1. dashboard/server.js: import + mount public countdown router ────────────
# Insert import line after the pricing import.
if ! grep -q "publicCountdownRouter" dashboard/server.js; then
    perl -i -pe "s{^(import publicPricingRouter from '\./routes/public/pricing\.js';\n)}{\$1import publicCountdownRouter from './routes/public/countdown.js';\n}m" dashboard/server.js
fi

# Mount after the pricing mount.
if ! grep -q "app.use('/', publicCountdownRouter)" dashboard/server.js; then
    perl -i -pe "s{(app\.use\('/pricing', publicPricingRouter\);\n)}{\$1\n    // Public holiday countdown pages — /countdown/\:slug (HTML, OG unfurl), .png, .json.\n    // Mounted at '/' because the router owns the full /countdown/* path prefix.\n    app.use('/', publicCountdownRouter);\n}" dashboard/server.js
fi

# ── 2. POST handlers for /manage/\:guildId/holidays/pin and /unpin ─────────────
# Append just before an existing manage-area block. We'll insert ahead of
# the first `app.get('/manage/:guildId/forms/question-types'` as a safe anchor.
if ! grep -q "/manage/:guildId/holidays/pin" dashboard/server.js; then
    # Build the insert into a temp file, then splice it in.
    cat > /tmp/holiday-handlers.js <<'JS'

    // ── Holiday countdowns ────────────────────────────────────────────────────
    // POST pin: either create or re-point a live countdown message in a channel.
    app.post('/manage/:guildId/holidays/pin', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const slug = String(req.body?.slug || '').toLowerCase();
        const channelId = String(req.body?.channel_id || '').trim();
        try {
            const { pinCountdownMessage } = await import('../core/holiday-manager.js');
            const guild = req.guildObject;
            const client = guild.client;
            await pinCountdownMessage(client, { guildId, slug, channelId });
            res.redirect(`/manage/${guildId}?page=holidays`);
        } catch (e) {
            logger.warn('[Manage/holidays] pin failed', { guildId, slug, err: e.message });
            res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent(e.message)}`);
        }
    });

    // POST unpin: delete the pinned message (best effort) and remove the row.
    app.post('/manage/:guildId/holidays/unpin', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const slug = String(req.body?.slug || '').toLowerCase();
        try {
            const { unpinCountdownMessage } = await import('../core/holiday-manager.js');
            const guild = req.guildObject;
            const client = guild.client;
            await unpinCountdownMessage(client, { guildId, slug });
            res.redirect(`/manage/${guildId}?page=holidays`);
        } catch (e) {
            logger.warn('[Manage/holidays] unpin failed', { guildId, slug, err: e.message });
            res.redirect(`/manage/${guildId}?page=holidays&err=${encodeURIComponent(e.message)}`);
        }
    });
JS
    # Splice: find the anchor line number, insert file right before it.
    LINE=$(grep -n "app.get('/manage/:guildId/forms/question-types'" dashboard/server.js | head -1 | cut -d: -f1)
    if [ -z "$LINE" ]; then echo "ANCHOR MISSING"; exit 1; fi
    head -n $((LINE - 1)) dashboard/server.js > /tmp/sj.pre
    tail -n +$LINE dashboard/server.js > /tmp/sj.post
    cat /tmp/sj.pre /tmp/holiday-handlers.js /tmp/sj.post > dashboard/server.js
    rm -f /tmp/sj.pre /tmp/sj.post /tmp/holiday-handlers.js
fi

# ── 3. manage-tailwind.ejs: add label + pageMap entry ─────────────────────────
if ! grep -q "'holidays': 'Holiday" dashboard/views/manage-tailwind.ejs; then
    perl -i -pe "s{(^\s*'rejoin': 'Rejoin Limit',\n)}{\$1        'holidays': 'Holiday Countdowns',\n}m" dashboard/views/manage-tailwind.ejs
fi
if ! grep -q "'holidays':.*partial: 'holidays'" dashboard/views/manage-tailwind.ejs; then
    perl -i -pe "s{('rejoin': \{ partial: 'rejoin', data: \{ guild, rejoin: typeof rejoin !== 'undefined' \? rejoin : null, channels \} \},\n)}{\$1                    'holidays': { partial: 'holidays', data: { guild, channels, holidays: typeof holidays !== 'undefined' ? holidays : [] } },\n}m" dashboard/views/manage-tailwind.ejs
fi

# ── 4. manage-classic.ejs: same two inserts ───────────────────────────────────
if ! grep -q "'holidays': 'Holiday" dashboard/views/manage-classic.ejs; then
    perl -i -pe "s{(^\s*'rejoin': 'Rejoin Limit',\n)}{\$1        'holidays': 'Holiday Countdowns',\n}m" dashboard/views/manage-classic.ejs
fi
if ! grep -q "'holidays':.*partial: 'holidays'" dashboard/views/manage-classic.ejs; then
    perl -i -pe "s{('rejoin': \{ partial: 'rejoin', data: \{ guild, rejoin: typeof rejoin !== 'undefined' \? rejoin : null, channels \} \},\n)}{\$1                    'holidays': { partial: 'holidays', data: { guild, channels, holidays: typeof holidays !== 'undefined' ? holidays : [] } },\n}m" dashboard/views/manage-classic.ejs
fi

echo "patches applied"
echo "pre-flight: counting new occurrences"
grep -c "'holidays'" dashboard/views/manage-tailwind.ejs
grep -c "'holidays'" dashboard/views/manage-classic.ejs
grep -c "publicCountdownRouter" dashboard/server.js
grep -c "holidays/pin" dashboard/server.js
