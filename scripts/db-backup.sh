#!/bin/bash
# Database Backup Script — runs weekly via cron
# Creates a compressed mysqldump and keeps the last 4 weekly backups

set -e

BACKUP_DIR="/home/death/CertiFriedUtility/backups"
ENV_FILE="/home/death/CertiFriedUtility/.env"
MAX_BACKUPS=4

# Read DB creds from .env
DB_HOST=$(grep '^DB_HOST=' "$ENV_FILE" | cut -d= -f2 | tr -d '"')
DB_USER=$(grep '^DB_USER=' "$ENV_FILE" | cut -d= -f2 | tr -d '"')
DB_PASS=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2 | tr -d '"')
DB_NAME=$(grep '^DB_NAME=' "$ENV_FILE" | cut -d= -f2 | tr -d '"')

DATE=$(date +%Y-%m-%d_%H%M)
FILENAME="db_backup_${DATE}.sql.gz"

echo "[DB Backup] Starting dump of ${DB_NAME} at $(date)"

# Dump and compress
mysqldump -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" \
    --single-transaction --quick --lock-tables=false \
    --routines --triggers --events \
    "$DB_NAME" | gzip > "${BACKUP_DIR}/${FILENAME}"

SIZE=$(du -sh "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "[DB Backup] Created ${FILENAME} (${SIZE})"

# Prune old backups (keep last MAX_BACKUPS)
cd "$BACKUP_DIR"
ls -t db_backup_*.sql.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | while read OLD; do
    echo "[DB Backup] Pruning old backup: ${OLD}"
    rm -f "$OLD"
done

TOTAL=$(ls -1 db_backup_*.sql.gz 2>/dev/null | wc -l)
echo "[DB Backup] Done. ${TOTAL} backup(s) retained."
