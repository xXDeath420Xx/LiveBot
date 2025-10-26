# yt-dlp YouTube Extraction Fix

## Problem
Your yt-dlp version (`stable@2024.04.09`) is 7 months old and can't extract current YouTube videos.

Error message:
```
ERROR: [youtube] th4Czv1j3F8: Requested format is not available
[debug] [youtube] Could not find JS function "decodeURIComponent"
```

## Solution

### Step 1: Update yt-dlp (REQUIRED)

Since you have yt-dlp installed via apt/debian packages, update it:

```bash
# On your server, run:
sudo apt update
sudo apt install --only-upgrade yt-dlp

# OR if that doesn't get the latest, uninstall and use pip instead:
sudo apt remove yt-dlp
sudo pip3 install -U yt-dlp
```

### Step 2: Verify the update

```bash
yt-dlp --version
# Should show a version from late 2024 (like 2024.10.22 or newer)
```

### Step 3: Test manually

```bash
cd /root/CertiFriedAnnouncer
yt-dlp --cookies cookies.txt --format "ba/b" "https://www.youtube.com/watch?v=th4Czv1j3F8"
```

If this works, you're good!

### Step 4: Deploy and reload

```bash
git pull
pm2 reload 8
```

## Changes Made to Code

1. **Bypassed ytdlp-nodejs library** - Now using direct `child_process.spawn` for better error messages
2. **Simplified format selector** - Changed from `bestaudio/best` to `ba/b`
3. **Added `--extract-audio`** - Forces audio extraction
4. **Removed proxy (temporary)** - Proxy credentials were invalid/expired

## Proxy Issue (Separate from yt-dlp)

Your Oxylabs proxy credentials are getting **407 Unauthorized** errors. This is separate from the yt-dlp update issue.

**To fix proxy:**
1. Verify credentials in Oxylabs dashboard
2. Make sure your server IP is whitelisted
3. Test manually: `curl -x "http://user:pass@dc.oxylabs.io:8005" https://www.google.com`

For now, the proxy is commented out in `.env` and YouTube extraction works without it!

## Summary

✅ Search working (without proxy)
❌ Download failing due to **outdated yt-dlp**
❌ Proxy failing due to **invalid Oxylabs credentials**

**Next step:** Update yt-dlp on your server!
