#!/usr/bin/env bash
# Nightly backup: the same zip as Download backup on /admin, kept in /var/data/backups (newest 7).
# Installed as /usr/local/sbin/seller-assistants-backup; run by seller-assistants-backup.timer as user bot.
set -euo pipefail
dir="${DATA_DIR:-/var/data}/backups"
mkdir -p "$dir"
file="$dir/seller-assistants-backup-$(date -u +%F-%H%M).zip"
# The password goes through a netrc on a pipe, so it never shows in the process list.
curl -fsS --max-time 600 --netrc-file <(printf 'machine 127.0.0.1 login backup password %s\n' "$ADMIN_PASSWORD") \
  -o "$file.tmp" "http://127.0.0.1:${PORT:-3000}/admin/backup"
mv "$file.tmp" "$file"
echo "[backup] wrote $file ($(du -h "$file" | cut -f1))"
ls -1t "$dir"/seller-assistants-backup-*.zip | tail -n +8 | xargs -r rm -f
