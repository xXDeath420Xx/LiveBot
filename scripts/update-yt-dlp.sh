#!/usr/bin/env bash
set -euo pipefail
# yt-dlp was user-installed via pip into ~/.local/bin. System pip on this host
# is PEP 668 externally-managed, so --break-system-packages is required to
# upgrade the user install cleanly.
pip3 install --user --upgrade --break-system-packages yt-dlp
/home/death/.local/bin/yt-dlp --version
