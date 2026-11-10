#!/usr/bin/env bash
# تحديث وتشغيل الـ API على السيرفر: سحب آخر نسخة من GitHub ثم إعادة البناء والتشغيل.
# الاستخدام (من جذر المستودع على السيرفر): bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f deploy/.env ]; then
  echo "ملف deploy/.env غير موجود. انسخ deploy/.env.example واملأه أولاً." >&2
  exit 1
fi

git pull --ff-only
cd deploy
sudo docker compose --env-file .env build api
sudo docker compose --env-file .env up -d
sudo docker image prune -f >/dev/null
sleep 5
sudo docker compose ps
echo "فحص الصحة:"
sudo docker compose exec -T api python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"
