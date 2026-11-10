#!/usr/bin/env bash
# تطبيق تحديثات هيكل قاعدة البيانات (Alembic) على قاعدة المصنع — المسار الوحيد المسموح لترحيلات الإنتاج.
# يطلب كتابة اسم القاعدة واسم من يوافق يدوياً، ويأخذ نسخة احتياطية قبل التطبيق إن كانت بالقاعدة بيانات.
# الاستخدام (على السيرفر من جذر المستودع): bash deploy/migrate.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ملف deploy/.env غير موجود." >&2
  exit 1
fi
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's#^[^/]*//[^/]*/##; s#\?.*$##')"
DB_HOST="$(printf '%s' "$DB_URL" | sed -E 's#^[^@]*@##; s#[:/].*$##')"

echo "سيتم تطبيق تحديثات هيكل القاعدة على:"
echo "  المستضيف: $DB_HOST"
echo "  القاعدة : $DB_NAME"
read -r -p "اكتب اسم القاعدة للتأكيد: " CONFIRM_DB
if [ "$CONFIRM_DB" != "$DB_NAME" ]; then
  echo "الاسم غير مطابق. أُلغيت العملية." >&2
  exit 1
fi
read -r -p "اسمك (يُسجل كموافق على التحديث): " APPROVER
if [ -z "${APPROVER// /}" ]; then
  echo "اسم الموافق مطلوب." >&2
  exit 1
fi

echo "== نسخة احتياطية قبل التحديث =="
if ! bash ./backup.sh; then
  read -r -p "تعذرت النسخة الاحتياطية (طبيعي في قاعدة جديدة فارغة). متابعة؟ اكتب نعم: " GO
  [ "$GO" = "نعم" ] || { echo "أُلغيت العملية."; exit 1; }
fi

echo "== تطبيق التحديثات =="
sudo docker compose --env-file .env build api
sudo docker compose --env-file .env run --rm \
  -e APP_ENV=production \
  -e QEMMA_DEPLOY_PIPELINE=vm-deploy-v1 \
  -e PROD_MIGRATION_CONFIRM_DB="$CONFIRM_DB" \
  -e PROD_MIGRATION_APPROVED_BY="$APPROVER" \
  api alembic upgrade head
echo "$(date -Is) migrate db=$DB_NAME approved_by=$APPROVER" | sudo tee -a /var/log/qema-migrations.log >/dev/null
sudo docker compose --env-file .env run --rm api alembic current
echo "تم. أعد تشغيل الخادم بالنسخة الجديدة: bash deploy/update.sh"
