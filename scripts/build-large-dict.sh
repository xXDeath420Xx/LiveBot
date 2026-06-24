#!/usr/bin/env bash
# Regenerate data/words/english-large.txt — the full-dictionary breadth merged into the
# word games for VALIDATION (word-bank.js merges it; it is NOT used to generate/plant
# random words, so its long tail never appears as a puzzle answer).
#
# Union of three freely-distributable English word sources:
#   - /usr/share/dict/web2  (Webster's 2nd International, 1934 — public domain)
#   - aspell `en` master, affix-expanded (GNU)
#   - dwyl words_alpha (Unlicense / public domain)
# minus what we already ship (english.txt + the curated english-extra.txt).
#
# Usage: bash scripts/build-large-dict.sh   (then: pm2 restart CertiFriedUtility)
set -euo pipefail
cd "$(dirname "$0")/.."

norm() { tr 'A-Z' 'a-z' | tr -d '\r' | grep -E '^[a-z]+$'; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# words_alpha (download if not cached)
ALPHA="${TMP}/words_alpha.txt"
[ -f /tmp/words_alpha.txt ] && cp /tmp/words_alpha.txt "$ALPHA" \
  || curl -sL -o "$ALPHA" "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt"

{
  norm < /usr/share/dict/web2 2>/dev/null || true
  aspell -d en dump master 2>/dev/null | aspell -l en expand 2>/dev/null | tr ' ' '\n' | norm || true
  norm < "$ALPHA"
} | sort -u > "${TMP}/full.txt"

cat data/words/english.txt data/words/english-extra.txt | norm | sort -u > "${TMP}/have.txt"
comm -23 "${TMP}/full.txt" "${TMP}/have.txt" > data/words/english-large.txt

echo "english-large.txt: $(wc -l < data/words/english-large.txt) words"
echo "total dictionary:  $(cat "${TMP}/have.txt" data/words/english-large.txt | sort -u | wc -l) words"
