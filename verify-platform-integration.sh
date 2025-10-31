#!/bin/bash
# Platform Integration Verification Script

echo "=== CertiFried Announcer Platform Integration Verification ==="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

success_count=0
fail_count=0

# Function to check file exists
check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $2"
        ((success_count++))
        return 0
    else
        echo -e "${RED}✗${NC} $2"
        ((fail_count++))
        return 1
    fi
}

# Function to check string in file
check_string() {
    if grep -q "$2" "$1" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $3"
        ((success_count++))
        return 0
    else
        echo -e "${RED}✗${NC} $3"
        ((fail_count++))
        return 1
    fi
}

echo "Checking TypeScript API Files:"
check_file "/root/CertiFriedAnnouncer/utils/youtube-api.ts" "YouTube API TypeScript module"
check_file "/root/CertiFriedAnnouncer/utils/tiktok-api.ts" "TikTok API TypeScript module"
check_file "/root/CertiFriedAnnouncer/utils/trovo-api.ts" "Trovo API TypeScript module"

echo ""
echo "Checking Compiled JavaScript Files:"
check_file "/root/CertiFriedAnnouncer/utils/youtube-api.js" "YouTube API compiled module"
check_file "/root/CertiFriedAnnouncer/utils/tiktok-api.js" "TikTok API compiled module"
check_file "/root/CertiFriedAnnouncer/utils/trovo-api.js" "Trovo API compiled module"

echo ""
echo "Checking Stream Manager Integration:"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "import.*youtube-api" "YouTube API import"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "import.*tiktok-api" "TikTok API import"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "import.*trovo-api" "Trovo API import"

echo ""
echo "Checking Platform Registry:"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "youtube: youtubeApi" "YouTube in platformModules"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "tiktok: tiktokApi" "TikTok in platformModules"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "trovo: trovoApi" "Trovo in platformModules"

echo ""
echo "Checking Platform Colors:"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "youtube: 0xFF0000" "YouTube color (red)"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "tiktok: 0x000000" "TikTok color (black)"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "trovo: 0x1DBF73" "Trovo color (green)"

echo ""
echo "Checking Platform URLs:"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "youtube.com/channel" "YouTube URL format"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "tiktok.com/@" "TikTok URL format"
check_string "/root/CertiFriedAnnouncer/core/stream-manager.ts" "trovo.live/s/" "Trovo URL format"

echo ""
echo "Checking API Functions:"
check_string "/root/CertiFriedAnnouncer/utils/youtube-api.ts" "isStreamerLive" "YouTube isStreamerLive function"
check_string "/root/CertiFriedAnnouncer/utils/youtube-api.ts" "getStreamDetails" "YouTube getStreamDetails function"
check_string "/root/CertiFriedAnnouncer/utils/tiktok-api.ts" "isStreamerLive" "TikTok isStreamerLive function"
check_string "/root/CertiFriedAnnouncer/utils/tiktok-api.ts" "getStreamDetails" "TikTok getStreamDetails function"
check_string "/root/CertiFriedAnnouncer/utils/trovo-api.ts" "isStreamerLive" "Trovo isStreamerLive function"
check_string "/root/CertiFriedAnnouncer/utils/trovo-api.ts" "getStreamDetails" "Trovo getStreamDetails function"

echo ""
echo "Checking Browser Integration:"
check_string "/root/CertiFriedAnnouncer/utils/youtube-api.ts" "checkYouTube" "YouTube uses browser automation"
check_string "/root/CertiFriedAnnouncer/utils/tiktok-api.ts" "checkTikTok" "TikTok uses browser automation"
check_string "/root/CertiFriedAnnouncer/utils/trovo-api.ts" "checkTrovo" "Trovo uses browser automation"

echo ""
echo "Checking Documentation:"
check_file "/root/CertiFriedAnnouncer/PLATFORM_SUPPORT_SUMMARY.md" "Platform Support Summary"
check_file "/root/CertiFriedAnnouncer/PLATFORM_USAGE_GUIDE.md" "Platform Usage Guide"

echo ""
echo "================================================================"
echo -e "Results: ${GREEN}${success_count} passed${NC}, ${RED}${fail_count} failed${NC}"
echo ""

if [ $fail_count -eq 0 ]; then
    echo -e "${GREEN}✓ All platform integrations verified successfully!${NC}"
    echo ""
    echo "Supported Platforms:"
    echo "  1. Twitch (API-based)"
    echo "  2. Kick (API-based)"
    echo "  3. YouTube (Browser-based) ⭐ NEW"
    echo "  4. TikTok (Browser-based) ⭐ NEW"
    echo "  5. Trovo (Browser-based) ⭐ NEW"
    echo "  6. Facebook Gaming (Browser-based)"
    echo "  7. Instagram Live (Browser-based)"
    echo ""
    echo "Next Steps:"
    echo "  1. Restart the bot to load new modules"
    echo "  2. Add test streamers using /streamer add command"
    echo "  3. Monitor logs for detection issues"
    echo "  4. Verify announcements work correctly"
    exit 0
else
    echo -e "${RED}✗ Some checks failed. Please review the output above.${NC}"
    exit 1
fi
