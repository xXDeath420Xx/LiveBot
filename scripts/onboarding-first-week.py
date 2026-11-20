#!/usr/bin/env python3
"""First-week feature adoption vs 30-day retention. Counts only; no server names leave this script.
Live servers: DB (dbq.sh) + Discord bot join dates (joined.json). Departed servers: the 2026-11-18 cleanup dumps."""
import json, gzip, re, subprocess, os, datetime as dt
from collections import defaultdict
W = os.path.expanduser("~/docs-work-2026-11-20")
BK = os.path.expanduser("~/CertiFriedUtility/backups/departed-guild-cleanup-2026-11-18")
DBQ = os.path.expanduser("~/deploy-backups/2026-10-05-db-audit/dbq.sh")
NOW = dt.datetime(2026, 11, 20)


def q(sql):
    out = subprocess.run([DBQ, sql], capture_output=True, text=True, check=True).stdout
    return [l.split("\t") for l in out.splitlines() if l]


def ts(s):
    if s in (None, "", "NULL"):
        return None
    s = str(s).replace("T", " ")
    for f, n in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d", 10)):
        try:
            return dt.datetime.strptime(s[:n], f)
        except ValueError:
            pass
    return None


def parse_tuples(s):
    i, n, out = 0, len(s), []
    while i < n:
        if s[i] != "(":
            i += 1
            continue
        i += 1
        vals, cur = [], None
        while i < n:
            c = s[i]
            if c == "'":
                i += 1
                buf = []
                while i < n:
                    if s[i] == "\\":
                        buf.append(s[i + 1]); i += 2; continue
                    if s[i] == "'":
                        if i + 1 < n and s[i + 1] == "'":
                            buf.append("'"); i += 2; continue
                        break
                    buf.append(s[i]); i += 1
                cur = "".join(buf); i += 1
            elif c == ",":
                vals.append(cur); cur = None; i += 1
            elif c == ")":
                vals.append(cur); i += 1
                break
            else:
                j = i
                while i < n and s[i] not in ",)":
                    i += 1
                tok = s[j:i].strip()
                cur = None if tok == "NULL" else tok
        out.append(vals)
    return out


_dump_cache = {}


def dump_rows(table):
    if table in _dump_cache:
        return _dump_cache[table]
    p = os.path.join(BK, table + ".sql.gz")
    rows = []
    if os.path.exists(p):
        with gzip.open(p, "rt", encoding="utf-8", errors="replace") as f:
            cols = None
            for line in f:
                if line.startswith("INSERT INTO"):
                    cols = re.findall(r"`([^`]+)`", line.split("VALUES")[0])[1:]
                    body = line.split("VALUES", 1)[1]
                elif line.startswith("(") and cols:
                    body = line
                else:
                    continue
                for tup in parse_tuples(body):
                    rows.append(dict(zip(cols, tup)))
    _dump_cache[table] = rows
    return rows


# ---- population ----
joined = json.load(open(os.path.join(W, "joined.json")))
live = {r[0] for r in q("SELECT guild_id FROM guilds WHERE left_at IS NULL")}
audit_live = {r[0]: (ts(r[1]), ts(r[2])) for r in q("SELECT guild_id, MIN(timestamp), MAX(timestamp) FROM audit_logs GROUP BY guild_id")}
assigned = {r[0]: ts(r[1]) for r in q("SELECT guild_id, MIN(assigned_at) FROM guild_bot_mapping GROUP BY guild_id")}
g = {}
for gid in live:
    j = ts(joined.get(gid))
    src = "discord"
    if not j:
        cands = [x for x in (assigned.get(gid), (audit_live.get(gid) or (None, None))[0]) if x]
        j = min(cands) if cands else None
        src = "earliest-row"
    last = (audit_live.get(gid) or (None, None))[1]
    g[gid] = {"join": j, "src": src, "left": None, "last": last, "live": True}

dep_guilds = {r["guild_id"]: r for r in dump_rows("guilds")}
dep_audit = defaultdict(list)
for r in dump_rows("audit_logs"):
    t = ts(r.get("timestamp"))
    if t:
        dep_audit[r["guild_id"]].append(t)
for gid, r in dep_guilds.items():
    if gid in g or not r.get("guild_name") or not r.get("left_at"):
        continue
    a = dep_audit.get(gid) or []
    g[gid] = {"join": min(a) if a else None, "src": "earliest-row", "left": ts(r["left_at"]), "last": max(a) if a else None, "live": False}

LOG_START = dt.datetime(2025, 11, 26)   # audit_logs begins 2025-11-19; an "earliest row" before this is not a join date


def cohort(x):
    j = x["join"]
    if not j:
        return False
    if x["src"] != "discord" and j < LOG_START:
        return False
    return j <= NOW - dt.timedelta(days=30)


def retained(x):
    """Still in the server 30 days after the join, with logged activity on or after day 30."""
    cut = x["join"] + dt.timedelta(days=30)
    if x["left"] and x["left"] < cut:
        return False
    return bool(x["last"] and x["last"] >= cut)


on = lambda col: (lambda r: str(r.get(col)) == "1")
always = lambda r: True
F = [
    ("Welcome messages", "welcome_settings", lambda r: bool(r.get("channel_id")), "created_at"),
    ("Server log channel", "logging_config", on("enabled"), "created_at"),
    ("Raid detection", "raid_detection_config", on("enabled"), "created_at"),
    ("Phishing and scam links", "phishing_config", on("enabled"), "created_at"),
    ("Global ban network", "global_ban_config", on("enabled"), "created_at"),
    ("Commission-spam filter", "commission_spam_config", on("enabled"), "created_at"),
    ("Self-bot detection", "selfbot_detection_config", on("enabled"), "created_at"),
    ("Adaptive spam filter", "adaptive_spam_config", on("enabled"), "created_at"),
    ("Verification", "verify_config", on("enabled"), "created_at"),
    ("Self-promo rules", "self_promo_config", on("enabled"), "created_at"),
    ("Support tickets", "ticket_panels", always, "created_at"),
    ("Go-live alerts (first alert)", "live_announcements", always, "created_at"),
    ("Streamer auto-track", "guild_streamer_auto_track", on("enabled"), "created_at"),
    ("Level role rewards", "level_role_rewards", always, "created_at"),
    ("Music (first song)", "music_play_log", always, "logged_at"),
    ("Free games alerts", "free_games_subscriptions", on("is_enabled"), "created_at"),
    ("Counting", "counting_channels", on("is_active"), "created_at"),
    ("Stat display channels", "stat_display_channels", always, "created_at"),
    ("Custom embeds", "custom_embeds", always, "created_at"),
    ("Question of the day", "qotd_channels", on("enabled"), "created_at"),
    ("Timezones", "tz_guild_config", on("enabled"), "created_at"),
    ("Word games", "word_game_channels", on("enabled"), "created_at"),
    ("Pokemon spawns", "pokemon_settings", on("spawn_enabled"), "created_at"),
    ("Critters", "critter_config", on("enabled"), "created_at"),
    ("AI DJ", "ai_dj_config", on("enabled"), "created_at"),
    ("Invite link filter", "invite_filter_config", on("enabled"), "created_at"),
    ("Discord event reminders", "scheduled_events_config", always, "created_at"),
    ("Auto-responses", "autoresponders", on("enabled"), "created_at"),
    ("Forms", "form_panels", always, "created_at"),
    ("Bluesky feeds", "bluesky_feeds", always, "created_at"),
    ("Twitch clip feeds", "twitch_clip_feeds", on("enabled"), "created_at"),
    ("Suggestions (first suggestion)", "suggestions", always, "created_at"),
    ("Moderation (first warning or infraction)", "infractions", always, "created_at"),
    ("Economy (first transaction)", "economy_transactions", always, "created_at"),
    ("Orientation message (auto-posted)", "orientation_config", lambda r: bool(r.get("channel_id")), "created_at"),
]


def first_times(table, cond, col):
    res = {}
    cols = [c[0] for c in q(f"SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='{table}'")]
    need = [c for c in ("enabled", "is_enabled", "is_active", "spawn_enabled", "channel_id") if c in cols and c != col]
    names = ["guild_id", col] + need
    sel = ", ".join(f"`{c}`" for c in names)
    for row in q(f"SELECT {sel} FROM `{table}`"):
        r = {k: (None if v == "NULL" else v) for k, v in zip(names, row)}
        t = ts(r[col])
        if t and cond(r) and (r["guild_id"] not in res or t < res[r["guild_id"]]):
            res[r["guild_id"]] = t
    for r in dump_rows(table):
        t = ts(r.get(col))
        if t and cond(r) and (r["guild_id"] not in res or t < res[r["guild_id"]]):
            res[r["guild_id"]] = t
    return res


C = {k: v for k, v in g.items() if cohort(v)}
n = len(C)
kept = sum(retained(v) for v in C.values())
pop = {"servers_known": len(g), "live": sum(v["live"] for v in g.values()), "departed_real": sum(not v["live"] for v in g.values()),
       "cohort": n, "cohort_live": sum(v["live"] for v in C.values()), "cohort_departed": sum(not v["live"] for v in C.values()),
       "retained_30d": kept, "join_source": {s: sum(v["src"] == s for v in C.values()) for s in ("discord", "earliest-row")}}
feats = []
for label, table, cond, col in F:
    ft = first_times(table, cond, col)
    wk = [gid for gid, v in C.items() if gid in ft and dt.timedelta(days=-1) <= ft[gid] - v["join"] <= dt.timedelta(days=7)]
    ever = [gid for gid in C if gid in ft]
    auto = [gid for gid in wk if abs((ft[gid] - C[gid]["join"]).total_seconds()) <= 120]
    others = [x for x in C if x not in wk]
    feats.append({"feature": label, "table": table, "first_week": len(wk), "first_week_retained": sum(retained(C[x]) for x in wk),
                  "rest": len(others), "rest_retained": sum(retained(C[x]) for x in others), "ever": len(ever), "auto_at_join": len(auto)})
feats.sort(key=lambda f: -f["first_week"])
json.dump({"population": pop, "features": feats}, open(os.path.join(W, "onboarding.json"), "w"), indent=1)
print(json.dumps(pop))
pct = lambda a, b: ("%4.0f%%" % (100 * a / b)) if b else "    -"
print("%-44s %4s %8s %5s %9s %5s %4s" % ("feature", "wk1", "wk1 kept", "rest", "rest kept", "ever", "auto"))
for f in feats:
    print("%-44s %4d %8s %5d %9s %5d %4d" % (f["feature"], f["first_week"], pct(f["first_week_retained"], f["first_week"]), f["rest"],
                                             pct(f["rest_retained"], f["rest"]), f["ever"], f["auto_at_join"]))
