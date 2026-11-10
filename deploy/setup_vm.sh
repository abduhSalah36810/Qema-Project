#!/usr/bin/env bash
# تجهيز سيرفر Google e2-micro (Debian/Ubuntu) لتشغيل Qema ERP API — يُشغَّل مرة واحدة بصلاحية sudo.
# الاستخدام: sudo bash deploy/setup_vm.sh
set -euo pipefail

echo "== تحديث النظام وتثبيت Docker =="
apt-get update -y
apt-get install -y ca-certificates curl git unattended-upgrades
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "== تحديثات الأمان التلقائية =="
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "== ذاكرة تبديل 1 جيجا (السيرفر ذاكرته 1 جيجا فقط) =="
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== مجلد النسخ الاحتياطية =="
install -d -m 700 /var/backups/qema

echo "تم. الخطوة التالية: انسخ deploy/.env.example إلى deploy/.env واملأه، ثم: bash deploy/update.sh"
