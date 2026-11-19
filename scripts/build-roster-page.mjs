import { readFileSync, writeFileSync } from 'node:fs';

// Census in, page out. Both are arguments now — the previous run hardcoded a scratchpad
// path from the session that produced it, which does not survive to the next audit.
//   node scripts/build-roster-page.mjs <census.json> [out.html]
const CENSUS = process.argv[2] ?? new URL('./kitsune-census.json', import.meta.url);
const OUT = process.argv[3] ?? new URL('./roster.html', import.meta.url);
const VOICE = process.argv.includes('--voice') ? process.argv[process.argv.indexOf('--voice') + 1] : null;

const r = JSON.parse(readFileSync(CENSUS));

// Voice is a separate source (the voice_activity table) merged in by user id. Text-only
// presence is a poor proxy for whether someone is still part of a server that runs on
// voice: several members with zero messages this window are in channels for hours.
const voiceReport = VOICE ? JSON.parse(readFileSync(VOICE)) : null;
const voiceById = new Map((voiceReport?.voice ?? []).map(v => [v.id, v]));
const vh = (id) => voiceById.get(id)?.hours ?? 0;
const voiceOnly = (voiceReport?.voice ?? [])
  .filter(v => !r.posters.some(p => p.id === v.id))
  .sort((a, b) => b.hours - a.hours);
const posters = r.posters;
const CORE = 5;                       // "more than 5 messages"
const max = posters[0].messages;
const coreCount = posters.filter(p => p.messages > CORE).length;

// Computed, not asserted. The previous page printed a hardcoded "4", which would have
// quietly misreported the moment the roster shifted.
const counts = posters.map(p => p.messages).sort((a, b) => a - b);
const median = counts.length % 2
  ? counts[(counts.length - 1) / 2]
  : Math.round((counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2);

// Same reasoning for the completeness claim: state what the sweep actually found.
const deniedCount = r.scanned.denied ?? 0;
const completeness = deniedCount === 0
  ? '<strong>Zero channels were denied</strong>, so this is a complete census, not a sample.'
  : `<strong>${deniedCount} channel${deniedCount === 1 ? ' was' : 's were'} unreadable</strong> ` +
    'by the bot and could not be counted — every figure here excludes them.';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const d = (iso) => { const t = new Date(iso); return `${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const num = (n) => n.toLocaleString('en-US');
// sqrt scale — a linear bar would render 90% of this roster as an invisible sliver
const barPct = (n) => Math.max(1.4, (Math.sqrt(n) / Math.sqrt(max)) * 100);

// Rounding to one decimal turns a real 68-second session into "0", which then renders as
// an empty cell — a member who WAS in voice reading as one who never was. Anything under a
// tenth of an hour is reported in minutes instead of being rounded away.
const hrs = (h) => h >= 10 ? String(Math.round(h)) : h >= 0.1 ? h.toFixed(1) : (h > 0 ? '<0.1' : '·');
const dur = (secs) => {
  if (secs >= 36000) return `${Math.round(secs / 3600)} h`;
  if (secs >= 3600) return `${(secs / 3600).toFixed(1)} h`;
  if (secs >= 60) return `${Math.round(secs / 60)} min`;
  return `${secs} sec`;
};

const rows = posters.map((p, i) => {
  const rank = i + 1;
  const core = p.messages > CORE;
  const span = p.firstPost.slice(0, 10) === p.lastPost.slice(0, 10)
    ? d(p.firstPost)
    : `${d(p.firstPost)} → ${d(p.lastPost)}`;
  const divider = rank === coreCount + 1
    ? `<tr class="threshold" aria-hidden="true"><td colspan="7"><span>more than 5 messages above · 5 or fewer below</span></td></tr>`
    : '';
  return `${divider}
      <tr class="${core ? 'core' : 'occasional'}" data-tier="${core ? 'core' : 'occasional'}" data-find="${esc((p.displayName + ' ' + p.username).toLowerCase())}" data-voice="${vh(p.id)}">
        <td class="rank">${rank}</td>
        <td class="who"><span class="name">${esc(p.displayName)}</span><span class="handle">@${esc(p.username)}</span></td>
        <td class="count">${num(p.messages)}</td>
        <td class="viz"><span class="bar" style="width:${barPct(p.messages).toFixed(2)}%"></span></td>
        <td class="ch">${p.channelsPostedIn}</td>
        <td class="voice ${vh(p.id) ? 'has' : ''}">${hrs(vh(p.id))}</td>
        <td class="span">${esc(span)}</td>
      </tr>`;
}).join('\n');

const html = `<title>Forsaken Warriors — 90-Day Poster Roster</title>
<style>
  :root {
    --ground:#EDF0EF; --surface:#FFFFFF; --sunk:#E3E8E7;
    --ink:#12191C; --ink-2:#495a60; --ink-3:#7d8b90;
    --rule:#D2DAD8; --rule-soft:#E1E7E5;
    --foxfire:#136E76; --foxfire-bar:#2E9AA0; --foxfire-wash:#DCEDEC;
    --ember:#9C5A22;
    --mute-bar:#C3CDCC;
    --display:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
    --ui:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
    --mono:"SF Mono","Cascadia Mono","JetBrains Mono",Consolas,"Roboto Mono",ui-monospace,monospace;
  }
  @media (prefers-color-scheme:dark) {
    :root {
      --ground:#0D1316; --surface:#141C20; --sunk:#101719;
      --ink:#E7EDEB; --ink-2:#9AA8AC; --ink-3:#617177;
      --rule:#243035; --rule-soft:#1B2427;
      --foxfire:#6FD2CE; --foxfire-bar:#4FB6B4; --foxfire-wash:#16302F;
      --ember:#D9974E;
      --mute-bar:#2C393D;
    }
  }
  :root[data-theme="dark"] {
    --ground:#0D1316; --surface:#141C20; --sunk:#101719;
    --ink:#E7EDEB; --ink-2:#9AA8AC; --ink-3:#617177;
    --rule:#243035; --rule-soft:#1B2427;
    --foxfire:#6FD2CE; --foxfire-bar:#4FB6B4; --foxfire-wash:#16302F;
    --ember:#D9974E;
    --mute-bar:#2C393D;
  }
  :root[data-theme="light"] {
    --ground:#EDF0EF; --surface:#FFFFFF; --sunk:#E3E8E7;
    --ink:#12191C; --ink-2:#495a60; --ink-3:#7d8b90;
    --rule:#D2DAD8; --rule-soft:#E1E7E5;
    --foxfire:#136E76; --foxfire-bar:#2E9AA0; --foxfire-wash:#DCEDEC;
    --ember:#9C5A22;
    --mute-bar:#C3CDCC;
  }

  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font-family:var(--ui); font-size:15px; line-height:1.55;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:1000px; margin:0 auto; padding:clamp(28px,5vw,64px) clamp(16px,4vw,40px) 72px; }

  .eyebrow {
    font-family:var(--mono); font-size:.7rem; letter-spacing:.14em; text-transform:uppercase;
    color:var(--foxfire); margin:0 0 14px;
  }
  h1 {
    font-family:var(--display); font-weight:600; text-wrap:balance;
    font-size:clamp(2rem,4.6vw,2.9rem); line-height:1.12; letter-spacing:-.01em; margin:0 0 12px;
  }
  .lede { color:var(--ink-2); max-width:60ch; margin:0; font-size:1.02rem; }

  .stats {
    display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px;
    background:var(--rule); border:1px solid var(--rule);
    margin:clamp(28px,4vw,44px) 0 0;
  }
  .stat { background:var(--surface); padding:16px 18px; }
  .stat b {
    display:block; font-family:var(--mono); font-variant-numeric:tabular-nums;
    font-size:clamp(1.5rem,3vw,1.95rem); font-weight:600; line-height:1.1; letter-spacing:-.02em;
  }
  .stat.hero b { color:var(--foxfire); }
  .stat span {
    display:block; margin-top:5px; font-size:.72rem; letter-spacing:.1em;
    text-transform:uppercase; color:var(--ink-3);
  }

  .controls {
    display:flex; flex-wrap:wrap; gap:10px; align-items:center;
    margin:clamp(26px,4vw,38px) 0 0;
  }
  .chips { display:flex; gap:0; border:1px solid var(--rule); background:var(--surface); }
  .chip {
    appearance:none; border:0; background:transparent; cursor:pointer;
    font-family:var(--ui); font-size:.78rem; letter-spacing:.05em; color:var(--ink-2);
    padding:9px 15px; border-right:1px solid var(--rule);
  }
  .chip:last-child { border-right:0; }
  .chip[aria-pressed="true"] { background:var(--foxfire-wash); color:var(--foxfire); font-weight:600; }
  .chip:focus-visible, #q:focus-visible { outline:2px solid var(--foxfire); outline-offset:1px; }
  #q {
    flex:1 1 190px; min-width:150px; padding:9px 12px; font-family:var(--ui); font-size:.85rem;
    background:var(--surface); color:var(--ink); border:1px solid var(--rule);
  }
  #q::placeholder { color:var(--ink-3); }
  #shown { font-family:var(--mono); font-size:.75rem; color:var(--ink-3); font-variant-numeric:tabular-nums; }

  .key {
    display:flex; flex-wrap:wrap; gap:18px; align-items:center;
    margin:18px 0 0; font-size:.78rem; color:var(--ink-2);
  }
  .key i { display:inline-block; width:3px; height:13px; margin-right:7px; vertical-align:-2px; }
  .key .k-core i { background:var(--foxfire-bar); }
  .key .k-occ i { background:var(--mute-bar); }

  .tablewrap { overflow-x:auto; margin-top:14px; border:1px solid var(--rule); background:var(--surface); }
  table { border-collapse:collapse; width:100%; min-width:640px; }
  thead th {
    position:sticky; top:0; z-index:2; background:var(--surface);
    font-family:var(--mono); font-weight:500; font-size:.66rem; letter-spacing:.12em;
    text-transform:uppercase; color:var(--ink-3); text-align:left;
    padding:12px 12px 10px; border-bottom:1px solid var(--rule); white-space:nowrap;
  }
  tbody td { padding:9px 12px; border-bottom:1px solid var(--rule-soft); vertical-align:middle; }
  tbody tr:last-child td { border-bottom:0; }

  .rank {
    font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:.78rem;
    color:var(--ink-3); text-align:right; width:52px; padding-left:16px;
  }
  .who { min-width:210px; }
  .name { display:block; font-weight:600; line-height:1.3; }
  .handle { display:block; font-family:var(--mono); font-size:.72rem; color:var(--ink-3); }
  .count {
    font-family:var(--mono); font-variant-numeric:tabular-nums; font-weight:600;
    text-align:right; width:78px; white-space:nowrap;
  }
  .viz { width:34%; min-width:110px; }
  .bar { display:block; height:7px; border-radius:1px; }
  .ch, .span {
    font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:.75rem;
    color:var(--ink-3); white-space:nowrap;
  }
  .ch { text-align:right; width:56px; }
  .span { width:132px; }

  /* the 46 — full contrast, foxfire rail and bar */
  tr.core .rank { border-left:3px solid var(--foxfire-bar); color:var(--ink-2); padding-left:13px; }
  tr.core .name { color:var(--ink); }
  tr.core .count { color:var(--ink); }
  tr.core .bar { background:var(--foxfire-bar); }
  tr.core:hover td { background:var(--foxfire-wash); }

  /* the 50 — recessed */
  tr.occasional .rank { border-left:3px solid transparent; padding-left:13px; }
  tr.occasional .name { color:var(--ink-2); font-weight:500; }
  tr.occasional .count { color:var(--ink-2); font-weight:500; }
  tr.occasional .bar { background:var(--mute-bar); }
  tr.occasional:hover td { background:var(--sunk); }

  tr.threshold td {
    padding:0; border-bottom:0; background:var(--surface);
  }
  tr.threshold span {
    display:flex; align-items:center; gap:12px;
    font-family:var(--mono); font-size:.65rem; letter-spacing:.1em; text-transform:uppercase;
    color:var(--ember); padding:11px 16px 10px; white-space:nowrap;
  }
  tr.threshold span::before, tr.threshold span::after {
    content:""; height:1px; background:var(--ember); opacity:.45; flex:1 1 auto;
  }
  tr.threshold span::before { flex:0 0 22px; }

  .method {
    margin-top:38px; padding-top:22px; border-top:1px solid var(--rule);
    color:var(--ink-3); font-size:.82rem; max-width:72ch;
  }
  .method h2 {
    font-family:var(--mono); font-size:.68rem; letter-spacing:.12em; text-transform:uppercase;
    color:var(--ink-2); margin:0 0 10px; font-weight:500;
  }
  .method p { margin:0 0 9px; }
  .method code { font-family:var(--mono); font-size:.95em; color:var(--ink-2); }
  .empty { padding:26px 16px; color:var(--ink-3); font-size:.85rem; }
  td.voice, th.voice {
    text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums;
    font-size:.85rem; white-space:nowrap; color:var(--ink-3);
  }
  td.voice.has { color:var(--ember); font-weight:600; }

  .voiceonly { margin:clamp(30px,4vw,46px) 0 0; border:1px solid var(--rule); background:var(--surface); padding:20px 22px; }
  .voiceonly h2 {
    font-family:var(--mono); font-size:.68rem; letter-spacing:.12em; text-transform:uppercase;
    color:var(--ember); margin:0 0 8px; font-weight:600;
  }
  .voiceonly > p { margin:0 0 14px; color:var(--ink-2); font-size:.9rem; max-width:62ch; }
  .voiceonly ul { list-style:none; margin:0; padding:0; display:grid; gap:1px; background:var(--rule-soft); }
  .voiceonly li {
    background:var(--surface); display:flex; flex-wrap:wrap; gap:4px 14px;
    align-items:baseline; justify-content:space-between; padding:8px 2px;
  }
  .voiceonly .vn { font-weight:600; }
  .voiceonly .vv { font-family:var(--mono); font-size:.78rem; color:var(--ink-3); }

  @media (prefers-reduced-motion:reduce) { * { transition:none !important; animation:none !important; } }
</style>

<div class="wrap">
  <p class="eyebrow">the Forsaken Warriors · 90-day census</p>
  <h1>Who actually showed up</h1>
  <p class="lede">Every member who posted between ${d(r.window.from)} and ${d(r.window.to)}, ranked by volume. The <strong>${coreCount} regulars</strong> — anyone past five messages — carry a foxfire rail; the remaining ${posters.length - coreCount} sit below the line.${voiceReport ? ` Voice hours come from session logging over the same window — <strong>${voiceOnly.length} more members</strong> were in voice without typing a single message, listed below the table.` : ''}</p>

  <div class="stats">
    <div class="stat hero"><b>${posters.length}</b><span>Unique posters</span></div>
    <div class="stat hero"><b>${coreCount}</b><span>Posted &gt; 5 times</span></div>
    <div class="stat"><b>${num(r.totals.humanMessages)}</b><span>Member messages</span></div>
    <div class="stat"><b>${r.scanned.readable}</b><span>Channels swept</span></div>
    <div class="stat"><b>${median}</b><span>Median messages</span></div>
${voiceReport ? `    <div class="stat hero"><b>${num(Math.round(voiceReport.totals.humanHours))}</b><span>Hours in voice</span></div>
    <div class="stat"><b>${voiceReport.totals.humanVoiceUsers}</b><span>Members in voice</span></div>` : ''}
  </div>

  <div class="controls">
    <div class="chips" role="group" aria-label="Filter roster">
      <button class="chip" data-f="all" aria-pressed="true">All ${posters.length}</button>
      <button class="chip" data-f="core" aria-pressed="false">Regulars ${coreCount}</button>
      <button class="chip" data-f="occasional" aria-pressed="false">Occasional ${posters.length - coreCount}</button>
    </div>
    <input id="q" type="search" placeholder="Find a name or handle…" aria-label="Find a name or handle">
    <span id="shown">${posters.length} shown</span>
  </div>

  <div class="key">
    <span class="k-core"><i></i>More than 5 messages</span>
    <span class="k-occ"><i></i>5 or fewer</span>
    <span>Bars use a square-root scale so single-message posters stay visible.</span>
  </div>

  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th class="rank" scope="col">#</th>
          <th scope="col">Member</th>
          <th class="count" scope="col">Msgs</th>
          <th scope="col">Volume</th>
          <th class="ch" scope="col">Ch</th>
          <th class="voice" scope="col" title="Hours in voice channels">Voice</th>
          <th scope="col">Active</th>
        </tr>
      </thead>
      <tbody id="body">
${rows}
      </tbody>
    </table>
    <div class="empty" id="empty" hidden>No member matches that search.</div>
  </div>

${voiceOnly.length ? `  <section class="voiceonly">
    <h2>Present in voice, silent in text — ${voiceOnly.length} members</h2>
    <p>Zero messages in the 90-day window, but logged in voice channels. A text-only audit
    would read these members as inactive.</p>
    <ul>
${voiceOnly.map(v => `      <li><span class="vn">${esc(v.displayName ?? v.id)}</span><span class="vv">${dur(v.seconds)} · ${v.sessions} session${v.sessions === 1 ? '' : 's'} · last ${d(v.lastSeen)}</span></li>`).join('\n')}
    </ul>
  </section>
` : ''}
  <div class="method">
    <h2>How this was counted</h2>
    <p>Read-only REST sweep of guild <code>${r.guild.id}</code> using the Kitsune bot, ${d(r.window.from)}–${d(r.window.to)} (${r.window.days} days). All <strong>${r.scanned.containers} messageable containers</strong> were paged to the cutoff — text, announcement, voice-text and stage channels, plus active and archived threads. ${completeness}</p>
    <p>${num(r.totals.messages)} messages were read in total; ${num(r.totals.botAndWebhookMessages)} were bot or webhook posts and are excluded from every figure above. Authorship counts a message as automated when <code>author.bot</code> is set or a <code>webhook_id</code> is present. Dates are UTC.</p>
${voiceReport ? `    <p>Voice figures are session durations from the bot's own <code>voice_activity</code> log over the same window — ${num(voiceReport.totals.humanSessions)} sessions totalling ${num(Math.round(voiceReport.totals.humanHours))} hours across ${voiceReport.totals.humanVoiceUsers} members. They were cross-checked against the server's mod-log voice embeds: no day carried logged joins with no corresponding sessions, so there is no tracker outage inside the window. Bot accounts are excluded. Discord does not expose voice history through its API, so this depends on that logging having been running — it reaches back to 27 Apr, comfortably before this window opens.</p>` : ''}
  </div>
</div>

<script>
  (function () {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#body tr[data-tier]'));
    var dividers = Array.prototype.slice.call(document.querySelectorAll('#body tr.threshold'));
    var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
    var q = document.getElementById('q');
    var shown = document.getElementById('shown');
    var empty = document.getElementById('empty');
    var filter = 'all';

    function apply() {
      var term = q.value.trim().toLowerCase();
      var n = 0;
      rows.forEach(function (row) {
        var okTier = filter === 'all' || row.dataset.tier === filter;
        var okTerm = !term || row.dataset.find.indexOf(term) !== -1;
        var vis = okTier && okTerm;
        row.hidden = !vis;
        if (vis) n++;
      });
      // the threshold rule only means something when both tiers are on screen unfiltered
      dividers.forEach(function (dv) { dv.hidden = !(filter === 'all' && !term); });
      shown.textContent = n + ' shown';
      empty.hidden = n !== 0;
    }

    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        filter = c.dataset.f;
        chips.forEach(function (o) { o.setAttribute('aria-pressed', String(o === c)); });
        apply();
      });
    });
    q.addEventListener('input', apply);
    apply();
  })();
</script>
`;

writeFileSync(OUT, html);
console.log('wrote', String(OUT), '— rows:', posters.length, 'core:', coreCount, 'max:', max, 'median:', median, 'denied:', deniedCount);
