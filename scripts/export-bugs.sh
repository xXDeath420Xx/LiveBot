#!/bin/bash

# Export bugs to markdown report
# Usage: ./scripts/export-bugs.sh [output-file]

cd "$(dirname "$0")/.." || exit 1

# Generate timestamp for filename
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="${1:-bugs-report-${TIMESTAMP}.md}"

echo "Generating bug report..."
node scripts/export-bugs.js 2>/dev/null | sed -r "s/\x1B\[[0-9;]*[mK]//g" | grep -v "^\[" | grep -v "^  " > "$OUTPUT_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Bug report generated successfully!"
    echo "📄 File: $OUTPUT_FILE"
    echo ""
    echo "To view the report:"
    echo "  cat $OUTPUT_FILE"
    echo ""
    echo "To use with Claude:"
    echo "  Open Claude Code and run: cat $OUTPUT_FILE"
else
    echo "❌ Error generating bug report"
    exit 1
fi
