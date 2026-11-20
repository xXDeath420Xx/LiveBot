// Watch Together: one shared player per voice channel's Activity.
//
// The server owns the clock ({ paused, position, at }) and the title; this page follows it (sync.js): it loads the
// title's HLS stream (hls.js, or the platform's own HLS on iOS), starts at the shared position, and every half second
// steers the player towards it — 5 % faster or slower for small drift, a jump for large drift. The host (and the
// server's control role, Manage Server) can play, pause, jump and pick titles; everyone can change their own volume
// and subtitles. Live changes arrive on the event stream; if that goes quiet the page polls instead.
import Hls from 'hls.js/dist/hls.light.mjs';
import { h, fill, fmtTime, sleep, avatarUrl, initials, icon } from './dom.js';
import { openEvents } from './api.js';
import { targetPosition, clockOffset, correction } from './sync.js';
import { createWatchDiag } from './watch-diag.js';

const VOL_KEY = 'cf.watch.volume';
const readVol = () => { try { const v = Number(localStorage.getItem(VOL_KEY)); return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 80; } catch { return 80; } };
const saveVol = (v) => { try { localStorage.setItem(VOL_KEY, String(v)); } catch { /* private mode */ } };

export function openWatch(root, ctx, { back, intent = null, demo = null }) {
    const me = ctx.user;
    let state = null;
    let you = { canStart: false, canControl: false };
    let samples = [];
    let offset = 0;
    let hls = null;
    let loadedSrc = null;
    let nudging = false;
    let blocked = false;
    let dragging = false;
    let mediaRecover = 0;
    let reloadTimer = null;
    let lastEventAt = Date.now();
    let reportedBuffering = false;
    let lastReportAt = 0;
    let preferredSub = Number.isInteger(intent?.subIndex) ? intent.subIndex : null;
    let pendingIntent = intent && intent.kind === 'watch' ? intent : null;
    let closed = false;
    let shownPaused = null;
    let autoplayMuted = false; // the browser refused sound: the film plays muted until a tap (Android often does)
    let playPending = false;
    const timers = [];
    let events = null;

    // ── layout ──────────────────────────────────────────────────────────────────────────────
    const video = h('video', { class: 'player', playsinline: true, preload: 'auto', 'aria-label': 'Film' });
    video.volume = readVol() / 100;
    const poster = h('div', { class: 'demo-frame', hidden: true });
    const overlay = h('div', { class: 'stage-overlay', hidden: true });
    const soundBtn = h('button', { type: 'button', class: 'btn btn-primary sound-btn', hidden: true, on: { click: () => unmute() } }, icon('volume', 18), 'Tap for sound');
    const stage = h('div', { class: 'stage' }, video, poster, overlay, soundBtn);

    const playBtn = h('button', { type: 'button', class: 'ctl', 'aria-label': 'Play', on: { click: () => onPlayPause() } }, icon('play'));
    const nextBtn = h('button', { type: 'button', class: 'ctl', 'aria-label': 'Next in the queue', title: 'Next', hidden: true, on: { click: () => onNext() } }, icon('next'));
    const seek = h('input', { type: 'range', class: 'seek', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Position in the film',
        on: { input: () => { dragging = true; showTime(seekValue()); }, change: () => onSeekCommit() } });
    const timeEl = h('span', { class: 'time', 'aria-live': 'off' }, '0:00 / 0:00');
    const vol = h('input', { type: 'range', class: 'vol', min: '0', max: '100', value: String(readVol()), 'aria-label': 'Your volume',
        on: { input: () => { video.volume = Number(vol.value) / 100; video.muted = Number(vol.value) === 0; if (!video.muted) autoplayMuted = false; saveVol(vol.value); updateSoundBtn(); } } });
    const subSel = h('select', { class: 'sel', 'aria-label': 'Your subtitles', on: { change: () => { preferredSub = subSel.value === '' ? null : Number(subSel.value); applySubs(); } } });
    const fsBtn = h('button', { type: 'button', class: 'ctl', 'aria-label': 'Full screen', title: 'Full screen',
        on: { click: () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.())?.catch?.(() => {}) } }, icon('fullscreen'));
    const syncDot = h('span', { class: 'sync', role: 'img', 'aria-label': 'Connecting' });
    const controls = h('div', { class: 'controls' }, playBtn, nextBtn, timeEl, seek, h('span', { class: 'vol-wrap' }, icon('volume', 16), vol), subSel, fsBtn, syncDot);

    // Sound help: Activity sound plays through the device's own output, not Discord's voice output setting.
    const soundHelp = h('details', { class: 'sound-help' }, h('summary', null, "Can't hear anything?"),
        h('ul', null,
            h('li', null, 'Check the volume slider here, next to the speaker icon. If you see Tap for sound, tap it.'),
            h('li', null, "On Windows, the film plays through Discord's output in the Windows volume mixer, not the output picked in Discord's Voice settings. Open Settings → System → Sound → Volume mixer, find Discord and check its output device and volume."),
            h('li', null, 'On a phone, turn up the media volume with the volume buttons while the film plays.')));

    const titleEl = h('div', { class: 'w-title' }, 'Watch Together');
    const hostEl = h('div', { class: 'w-host muted' });
    const banner = h('div', { class: 'banner', role: 'status', hidden: true });

    const tabs = ['library', 'queue', 'people'];
    let tab = 'library';
    const tabBtns = Object.fromEntries(tabs.map((t) => [t, h('button', { type: 'button', role: 'tab', class: 'tab', on: { click: () => setTab(t) } }, { library: 'Library', queue: 'Queue', people: 'People' }[t])]));
    const panelBody = h('div', { class: 'panel-body', role: 'tabpanel' });
    const panel = h('aside', { class: 'panel' }, h('div', { class: 'tabs', role: 'tablist' }, tabs.map((t) => tabBtns[t])), panelBody);

    fill(root, h('div', { class: 'watch' },
        h('header', { class: 'w-bar' },
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => { close(); back(); } } }, '← Activities'),
            h('div', { class: 'w-heading' }, titleEl, hostEl)),
        banner,
        h('main', { class: 'w-main' }, h('section', { class: 'w-player' }, stage, controls, soundHelp), panel)));

    // ── helpers ─────────────────────────────────────────────────────────────────────────────
    const serverNow = () => Date.now() + offset;
    const runtime = () => state?.media?.runtimeSec || 0;
    const currentTarget = () => targetPosition(state?.playback, serverNow(), runtime() || Infinity);
    const meView = () => state?.viewers?.find((v) => v.id === me.id);
    const canControl = () => {
        if (demo) return !!demo.you?.canControl;
        if (!state) return you.canStart;
        if (state.host?.id === me.id || meView()?.controller) return true;
        const hostHere = state.viewers?.some((v) => v.id === state.host?.id);
        return !state.media && !hostHere && you.canStart;
    };
    const seekValue = () => (Number(seek.value) / 1000) * runtime();
    function showTime(pos) { timeEl.textContent = `${fmtTime(pos)} / ${fmtTime(runtime())}`; }
    function say(msg, kind = 'info') {
        if (!msg) { banner.hidden = true; return; }
        banner.hidden = false;
        banner.className = `banner banner-${kind}`;
        banner.textContent = msg;
    }
    function showOverlay(content) {
        if (!content) { overlay.hidden = true; overlay.replaceChildren(); return; }
        overlay.hidden = false;
        fill(overlay, content);
    }

    // ── sound ───────────────────────────────────────────────────────────────────────────────
    const diag = createWatchDiag(video, { send: (body) => (demo ? null : ctx.api.post('api/watch/diag', body).catch(() => {})) });

    function updateSoundBtn() {
        const playing = !demo && !video.hidden && !!state?.media && !video.paused;
        soundBtn.hidden = !(autoplayMuted || (playing && (video.muted || video.volume === 0)));
    }
    for (const ev of ['volumechange', 'play', 'playing', 'pause', 'emptied']) video.addEventListener(ev, updateSoundBtn);
    video.addEventListener('playing', () => diag.started());

    /** Starts the film; if the browser refuses sound (NotAllowedError), plays it muted and offers Tap for sound. */
    function tryPlay() {
        if (playPending) return;
        playPending = true;
        video.play().then(() => { playPending = false; updateSoundBtn(); }).catch((e) => {
            if (e?.name === 'NotAllowedError' && !video.muted) {
                diag.noteAutoplay('NotAllowedError: retried muted');
                autoplayMuted = true;
                video.muted = true;
                return video.play().then(() => { playPending = false; updateSoundBtn(); })
                    .catch(() => { playPending = false; diag.noteAutoplay('NotAllowedError: muted too'); blocked = true; joinOverlay(); });
            }
            playPending = false;
            blocked = true;
            joinOverlay();
        });
    }

    /** One tap: sound on (at the saved volume, or 80 % if it was at 0) and play. */
    function unmute() {
        autoplayMuted = false;
        if (Number(vol.value) === 0) { vol.value = '80'; saveVol(80); }
        video.volume = Number(vol.value) / 100;
        video.muted = false;
        blocked = false;
        if (overlay.querySelector('.join')) showOverlay(null);
        video.play().then(updateSoundBtn).catch(() => { blocked = true; joinOverlay(); });
        updateSoundBtn();
    }

    function addSample(data, t) {
        if (!Number.isFinite(data?.serverNow)) return;
        samples.push({ serverNow: data.serverNow, at: t.at, rtt: t.rtt });
        samples = samples.slice(-8);
        offset = clockOffset(samples);
    }

    async function refreshState() {
        if (demo) return;
        try {
            const t = await ctx.api.timed('api/watch/state');
            addSample(t.data, t);
            you = t.data.you || you;
            applyState(t.data.state);
        } catch (e) {
            if (e.status === 403) { say(e.message, 'warn'); }
        }
    }

    // ── the player ──────────────────────────────────────────────────────────────────────────
    function unload() {
        if (hls) { try { hls.destroy(); } catch { /* gone */ } hls = null; }
        for (const t of [...video.querySelectorAll('track')]) t.remove();
        video.removeAttribute('src');
        try { video.load(); } catch { /* nothing loaded */ }
        loadedSrc = null;
        mediaRecover = 0;
        diag.reset();
        updateSoundBtn();
    }

    function reloadSoon() {
        if (reloadTimer) return;
        say('Reconnecting to the film…', 'warn');
        reloadTimer = setTimeout(async () => {
            reloadTimer = null;
            loadedSrc = null;
            await refreshState();
            say(null);
        }, 3000);
    }

    function load(m) {
        unload();
        loadedSrc = m.src;
        blocked = false;
        if (demo) {
            video.hidden = true;
            poster.hidden = false;
            fill(poster, h('div', { class: 'demo-art' }), h('p', { class: 'demo-caption' }, m.label));
            return;
        }
        const start = currentTarget();
        for (const t of m.subtitles || []) video.append(h('track', { kind: 'subtitles', src: t.src, label: t.label, srclang: (t.language || 'und').slice(0, 8) }));
        if (Hls.isSupported()) {
            hls = new Hls({ startPosition: start, maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30, enableWorker: true, fragLoadingMaxRetry: 6, manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4 });
            hls.on(Hls.Events.ERROR, (_e, d) => {
                if (!d?.fatal) return;
                if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecover < 2) { mediaRecover++; hls.recoverMediaError(); return; }
                reloadSoon();
            });
            diag.attachHls(hls, Hls);
            hls.loadSource(m.src);
            hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            diag.native();
            video.src = m.src;
            video.addEventListener('loadedmetadata', () => { try { video.currentTime = currentTarget(); } catch { /* not seekable yet */ } }, { once: true });
            video.addEventListener('error', () => reloadSoon(), { once: true });
        } else {
            showOverlay(h('p', null, 'This device cannot play the film stream.'));
        }
        applySubs();
    }

    function applySubs() {
        const tracks = [...(video.textTracks || [])];
        const want = state?.media?.subtitles?.find((s) => s.index === preferredSub);
        for (const t of tracks) t.mode = want && t.label === want.label ? 'showing' : 'disabled';
    }

    function renderSubs() {
        const subs = state?.media?.subtitles || [];
        fill(subSel, h('option', { value: '' }, subs.length ? 'Subtitles off' : 'No subtitles'),
            subs.map((s) => h('option', { value: String(s.index), selected: s.index === preferredSub }, s.label)));
        subSel.disabled = !subs.length;
    }

    function joinOverlay() {
        showOverlay(h('button', { type: 'button', class: 'btn btn-primary join', on: { click: () => {
            blocked = false;
            showOverlay(null);
            // A tap allows sound, so a film started muted by the browser gets its sound back here.
            if (autoplayMuted && Number(vol.value) > 0) { autoplayMuted = false; video.muted = false; }
            video.play().then(updateSoundBtn).catch(() => { blocked = true; joinOverlay(); });
        } } }, '▶ Join the film'));
    }

    function report(buffering) {
        if (demo || buffering === reportedBuffering) return;
        const now = Date.now();
        if (now - lastReportAt < 2000) return;
        lastReportAt = now;
        reportedBuffering = buffering;
        ctx.api.post('api/watch/report', { buffering }).catch(() => {});
    }
    video.addEventListener('waiting', () => report(true));
    video.addEventListener('playing', () => report(false));
    video.addEventListener('canplaythrough', () => report(false));

    function tick() {
        if (closed) return;
        const m = state?.media;
        if (!m) return;
        const t = currentTarget();
        if (!dragging) {
            seek.value = String(runtime() ? Math.round((t / runtime()) * 1000) : 0);
            showTime(t);
        }
        if (shownPaused !== state.playback.paused) {
            shownPaused = state.playback.paused;
            fill(playBtn, icon(shownPaused ? 'play' : 'pause'));
            playBtn.setAttribute('aria-label', shownPaused ? 'Play' : 'Pause');
        }
        if (demo) { syncDot.className = 'sync ok'; syncDot.setAttribute('aria-label', 'In sync'); return; }
        if (video.readyState < 1) return;
        const paused = state.playback.paused;
        if (paused && !video.paused) video.pause();
        if (!paused && video.paused && !blocked) tryPlay();
        const c = correction({ current: video.currentTime, target: t, paused, nudging });
        if (c.seek !== null) { try { video.currentTime = c.seek; } catch { /* not seekable yet */ } nudging = false; } else nudging = c.rate !== 1;
        if (video.playbackRate !== c.rate) video.playbackRate = c.rate;
        const drift = Math.abs(video.currentTime - t);
        syncDot.className = `sync ${drift < 0.6 ? 'ok' : 'drift'}`;
        syncDot.setAttribute('aria-label', drift < 0.6 ? 'In sync' : 'Catching up');
    }

    // ── state ───────────────────────────────────────────────────────────────────────────────
    function applyState(st) {
        if (closed) return;
        state = st;
        renderHeader();
        renderControls();
        if (tab !== 'library') renderPanel();
        if (!st || !st.media) {
            if (loadedSrc) unload();
            video.hidden = true;
            poster.hidden = true;
            showOverlay(h('div', { class: 'empty' },
                h('p', { class: 'empty-title' }, 'Nothing is playing'),
                h('p', { class: 'muted' }, canControl() ? 'Pick a film or an episode from the library.' : 'The host picks what plays. It starts here for everyone.')));
            return;
        }
        if (!demo) video.hidden = false;
        if (overlay.querySelector('.empty')) showOverlay(null);
        if (loadedSrc !== st.media.src) load(st.media);
        renderSubs();
        applySubs();
        tick();
        if (st.ended) ended();
    }

    function renderHeader() {
        titleEl.textContent = state?.media?.label || 'Watch Together';
        const host = state?.viewers?.find((v) => v.id === state?.host?.id);
        hostEl.textContent = state ? `${host ? `Host: ${host.name}` : 'The host is away'} · ${state.viewers.length} watching` : '';
    }

    function renderControls() {
        const ctl = canControl();
        for (const el of [playBtn, seek, nextBtn]) el.disabled = !ctl || !state?.media;
        nextBtn.hidden = !(state && state.queueIndex + 1 < (state.queue?.length || 0));
        seek.title = ctl ? '' : 'Only the host can jump';
    }

    function ended() {
        unload();
        events?.stop();
        showOverlay(h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, 'This Watch Together has ended'),
            h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => ctx.reload() } }, 'Start a new one')));
    }

    // ── controls ────────────────────────────────────────────────────────────────────────────
    async function send(path, body) {
        if (demo) return;
        try {
            const t0 = Date.now();
            const r = await ctx.api.post(path, body);
            if (r?.state) {
                if (Number.isFinite(r.state.serverNow)) addSample(r.state, { at: (t0 + Date.now()) / 2, rtt: Date.now() - t0 });
                applyState(r.state);
            }
            say(null);
            return r;
        } catch (e) {
            say(e.message, 'warn');
            return null;
        }
    }
    const onPlayPause = () => canControl() && state?.media && send('api/watch/control', { action: state.playback.paused ? 'play' : 'pause' });
    const onNext = () => canControl() && send('api/watch/next', {});
    function onSeekCommit() {
        const pos = seekValue();
        dragging = false;
        if (canControl() && state?.media) send('api/watch/control', { action: 'seek', position: pos });
    }
    const keys = (e) => {
        if (closed || !canControl() || !state?.media || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName)) return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); onPlayPause(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            send('api/watch/control', { action: 'seek', position: Math.max(0, currentTarget() + (e.key === 'ArrowRight' ? 10 : -10)) });
        }
    };
    document.addEventListener('keydown', keys);

    // ── the panel ───────────────────────────────────────────────────────────────────────────
    function setTab(t) {
        tab = t;
        for (const [k, b] of Object.entries(tabBtns)) { b.setAttribute('aria-selected', String(k === t)); b.classList.toggle('active', k === t); }
        renderPanel();
    }

    const lib = { kind: 'all', search: '', page: 0, item: null, season: null };
    let searchTimer = null;

    function posterEl(img, name, cls = 'poster') {
        return img ? h('img', { class: cls, src: img, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: `${cls} poster-blank`, 'aria-hidden': 'true' }, initials(name));
    }

    async function renderLibrary() {
        if (lib.item) return renderItem();
        const search = h('input', { type: 'search', class: 'input', placeholder: 'Search the library', value: lib.search, 'aria-label': 'Search the library',
            on: { input: () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { lib.search = search.value; lib.page = 0; loadGrid(); }, 300); } } });
        const kinds = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['movies', 'Films'], ['shows', 'Shows']].map(([k, label]) =>
            h('button', { type: 'button', class: ['seg-btn', lib.kind === k && 'active'], 'aria-pressed': String(lib.kind === k), on: { click: () => { lib.kind = k; lib.page = 0; renderLibrary(); } } }, label)));
        const grid = h('div', { class: 'grid', 'aria-busy': 'true' });
        const pager = h('div', { class: 'pager' });
        fill(panelBody, h('div', { class: 'lib-tools' }, search, kinds), grid, pager,
            h('p', { class: 'fine muted' }, 'Films come from this server\'s own library. Showing them is the server owner\'s responsibility.'));
        async function loadGrid() {
            grid.setAttribute('aria-busy', 'true');
            let r;
            try {
                r = demo ? demo.library : await ctx.api.get(`api/watch/library?kind=${lib.kind}&page=${lib.page}&search=${encodeURIComponent(lib.search)}`);
            } catch (e) {
                fill(grid, h('p', { class: 'muted' }, e.message));
                return;
            }
            grid.setAttribute('aria-busy', 'false');
            fill(grid, r.items.length ? r.items.map((i) => h('button', { type: 'button', class: 'card', on: { click: () => { lib.item = i.id; lib.season = null; renderLibrary(); } } },
                posterEl(i.image, i.name), h('span', { class: 'card-name' }, i.name), h('span', { class: 'card-meta muted' }, [i.type === 'Series' ? 'Show' : 'Film', i.year].filter(Boolean).join(' · '))))
                : h('p', { class: 'muted' }, lib.search ? 'Nothing matches that.' : 'The library is empty.'));
            fill(pager, r.pages > 1 ? [
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: lib.page <= 0, on: { click: () => { lib.page--; loadGrid(); } } }, '‹ Back'),
                h('span', { class: 'muted' }, `Page ${lib.page + 1} of ${r.pages}`),
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: lib.page + 1 >= r.pages, on: { click: () => { lib.page++; loadGrid(); } } }, 'More ›'),
            ] : []);
        }
        loadGrid();
    }

    async function renderItem() {
        fill(panelBody, h('p', { class: 'muted' }, 'Loading…'));
        let item;
        try { item = demo ? demo.item : (await ctx.api.get(`api/watch/item/${encodeURIComponent(lib.item)}`)).item; } catch (e) {
            fill(panelBody, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => { lib.item = null; renderLibrary(); } } }, '‹ Library'), h('p', { class: 'muted' }, e.message));
            return;
        }
        const ctl = canControl();
        const head = h('div', { class: 'item-head' }, posterEl(item.image, item.name, 'poster poster-lg'),
            h('div', null, h('h2', { class: 'item-name' }, item.name), h('p', { class: 'muted' }, [item.year, item.runtimeSec ? fmtTime(item.runtimeSec) : null].filter(Boolean).join(' · ')),
                item.overview ? h('p', { class: 'overview' }, item.overview) : null));
        const backBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => { lib.item = null; renderLibrary(); } } }, '‹ Library');
        const note = ctl ? null : h('p', { class: 'muted small' }, 'Only the host can pick what plays.');
        if (item.type === 'Series') {
            const seasons = item.seasons || [];
            const sel = h('select', { class: 'sel', 'aria-label': 'Season', on: { change: () => { lib.season = sel.value; loadEps(); } } },
                seasons.map((s) => h('option', { value: s.id, selected: s.id === lib.season }, s.name)));
            const list = h('div', { class: 'eps' });
            fill(panelBody, backBtn, head, note, seasons.length ? sel : h('p', { class: 'muted' }, 'No seasons in the library.'), list);
            async function loadEps() {
                fill(list, h('p', { class: 'muted' }, 'Loading episodes…'));
                let eps;
                try { eps = demo ? [] : (await ctx.api.get(`api/watch/show/${encodeURIComponent(item.id)}/episodes?season=${encodeURIComponent(sel.value)}`)).episodes; } catch (e) { fill(list, h('p', { class: 'muted' }, e.message)); return; }
                fill(list, eps.map((ep) => h('div', { class: 'ep' },
                    h('span', { class: 'ep-name' }, `${ep.episode}. ${ep.name}`),
                    h('span', { class: 'ep-actions' },
                        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: !ctl, on: { click: () => pickTitle(ep.id, { queue: null }) } }, 'Play'),
                        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: !ctl, title: 'Play this and the rest of the season', on: { click: () => pickTitle(ep.id, { queue: 'season' }) } }, 'Play from here')))));
            }
            if (!lib.season && seasons.length) lib.season = seasons[0].id;
            if (seasons.length) { sel.value = lib.season; loadEps(); }
            return;
        }
        const audio = h('select', { class: 'sel', 'aria-label': 'Audio' }, (item.audio || []).map((a) => h('option', { value: String(a.index), selected: a.isDefault }, a.label)));
        const pictureSubs = (item.subtitles || []).filter((s) => !s.text);
        const burn = pictureSubs.length ? h('select', { class: 'sel', 'aria-label': 'Burned-in subtitles' },
            h('option', { value: '' }, 'No burned-in subtitles'), pictureSubs.map((s) => h('option', { value: String(s.index) }, `${s.label} (burned in)`))) : null;
        fill(panelBody, backBtn, head, note,
            h('div', { class: 'field' }, h('label', null, 'Audio'), audio),
            burn ? h('div', { class: 'field' }, h('label', null, 'Picture subtitles'), burn, h('p', { class: 'muted small' }, 'Picture subtitles are drawn into the video for everyone. Text subtitles are each viewer\'s own choice under the player.')) : null,
            h('button', { type: 'button', class: 'btn btn-primary', disabled: !ctl, on: { click: () => pickTitle(item.id, {
                audioIndex: audio.value === '' ? null : Number(audio.value), burnSubtitleIndex: burn && burn.value !== '' ? Number(burn.value) : null,
                queue: item.type === 'Episode' ? 'season' : null,
            }) } }, item.type === 'Episode' ? '▶ Play (and the rest of the season)' : '▶ Play for everyone'));
    }

    async function pickTitle(itemId, opts) {
        say('Starting…');
        const r = await send('api/watch/play', { itemId, ...opts });
        if (r) { say(null); setTab('queue'); }
    }

    function renderQueue() {
        const q = state?.queue || [];
        const ctl = canControl();
        fill(panelBody,
            q.length ? h('ol', { class: 'queue' }, q.map((item, i) => h('li', { class: ['q-item', item.current && 'current'] },
                h('span', null, item.label),
                ctl && !item.current ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => send('api/watch/next', { index: i }) } }, 'Play') : null)))
                : h('p', { class: 'muted' }, 'Nothing is queued.'),
            ctl && state?.media ? h('button', { type: 'button', class: 'btn btn-danger btn-sm', on: { click: () => send('api/watch/control', { action: 'stop' }) } }, 'Stop for everyone') : null);
    }

    function renderPeople() {
        const vs = state?.viewers || [];
        fill(panelBody, h('ul', { class: 'people' }, vs.map((v) => {
            const src = avatarUrl(v, 64);
            return h('li', { class: 'person' },
                src ? h('img', { class: 'avatar', src, alt: '', width: '28', height: '28' }) : h('span', { class: 'avatar avatar-blank', 'aria-hidden': 'true' }, initials(v.name)),
                h('span', { class: 'person-name' }, v.name),
                v.id === state.host?.id ? h('span', { class: 'badge' }, 'Host') : v.controller ? h('span', { class: 'badge badge-soft' }, 'Can control') : null,
                v.buffering ? h('span', { class: 'muted small' }, 'loading…') : null);
        })), vs.length ? null : h('p', { class: 'muted' }, 'Nobody is connected.'));
    }

    function renderPanel() {
        if (tab === 'library') renderLibrary();
        else if (tab === 'queue') renderQueue();
        else renderPeople();
    }

    // ── start ───────────────────────────────────────────────────────────────────────────────
    function close() {
        closed = true;
        events?.stop();
        for (const t of timers) clearInterval(t);
        document.removeEventListener('keydown', keys);
        unload();
        diag.stop();
    }

    setTab(intent ? 'queue' : 'library');
    timers.push(setInterval(tick, 500));

    if (demo) {
        you = demo.you || you;
        offset = (Number(demo.state?.serverNow) || Date.now()) - Date.now(); // the demo's clock, so the times shown are the demo's
        applyState(demo.state);
        if (demo.tab) setTab(demo.tab);
        return close;
    }

    (async () => {
        // Three timed reads for the clock offset (and the state, and what this person may do).
        for (let i = 0; i < 3 && !closed; i++) { await refreshState(); await sleep(150); }
        events = openEvents('api/watch/events', ctx.session, {
            onEvent: (type, data) => {
                lastEventAt = Date.now();
                if (type === 'state') applyState(data);
                else if (type === 'ended') ended();
                else if (type === 'reauth') ctx.reload();
                else if (type === 'error' && data?.message) say(data.message, 'warn');
            },
            onStatus: (s) => { if (s === 'reconnecting') syncDot.className = 'sync drift'; },
            onSignedOut: () => ctx.reload(),
        });
        // The event stream can go quiet (a proxy holding it): fall back to polling until it speaks again.
        timers.push(setInterval(() => { if (Date.now() - lastEventAt > 35_000) refreshState(); }, 5000));
        timers.push(setInterval(async () => {
            try { const t = await ctx.api.timed('api/watch/state'); addSample(t.data, t); } catch { /* next time */ }
        }, 60_000));
        if (pendingIntent) {
            const it = pendingIntent;
            pendingIntent = null;
            if (!state?.media || canControl()) {
                await pickTitle(it.itemId, { audioIndex: Number.isInteger(it.audioIndex) ? it.audioIndex : null, burnSubtitleIndex: Number.isInteger(it.subIndex) ? it.subIndex : null, queue: Array.isArray(it.queue) && it.queue.length > 1 ? it.queue : null });
            } else {
                say('Someone is already hosting here, so your pick was not started. Ask the host.', 'warn');
            }
        }
    })();
    return close;
}
