#!/usr/bin/env bash
# نسخة احتياطية ليلية لقاعدة Supabase (الخطة المجانية لا تأخذ نسخاً تلقائية).
# تحفظ ملفاً مضغوطاً في /var/backups/qema وتحتفظ بآخر 14 نسخة.
# التفعيل (مرة واحدة): sudo crontab -e  ثم أضف السطر:
#   30 2 * * * bash /opt/qema/deploy/backup.sh >> /var/log/qema-backup.log 2>&1
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT=/var/backups/qema
KEEP=14

# رابط القاعدة من deploy/.env بصيغة pg_dump (بدون +asyncpg)
DB_URL="$(grep -E '^DATABASE_URL=' "$DIR/.env" | head -1 | cut -d= -f2- | sed 's#postgresql+asyncpg://#postgresql://#')"
if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL غير موجود في deploy/.env" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M)"
FILE="$OUT/qema-$STAMP.dump"
docker run --rm --network host -e PGURL="$DB_URL" -v "$OUT:/out" postgres:17-alpine \
  sh -c 'pg_dump --format=custom --no-owner --no-privileges --dbname="$PGURL" --file=/out/'"$(basename "$FILE")"
chmod 600 "$FILE"
echo "$(date -Is) نسخة: $FILE ($(du -h "$FILE" | cut -f1))"

# حذف ما زاد عن آخر 14 نسخة
ls -1t "$OUT"/qema-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
