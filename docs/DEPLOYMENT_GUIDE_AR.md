# دليل نشر Qema ERP أونلاين (مجاني) — لمسؤول النظام

الهدف: النظام يعمل على الإنترنت 24 ساعة لثلاثة موظفين، بتكلفة صفر، دون أن «ينام» الخادم.

| الجزء | الخدمة | ملاحظات |
|---|---|---|
| قاعدة البيانات وتسجيل الدخول | Supabase (الخطة المجانية) | 500 ميجا؛ لا نسخ احتياطي تلقائي (نأخذها نحن ليلياً) |
| الخادم (API) | Google Cloud — سيرفر e2-micro (Always Free) | شغال دائماً؛ في us-central1 أو us-east1 أو us-west1 فقط ليبقى مجانياً |
| الواجهة | Cloudflare Pages | مجاني ومسموح تجارياً |
| الكود | GitHub (مستودع خاص) | مصدر النشر |

> لا توضع أي كلمة مرور أو مفتاح سري في GitHub أو في الواجهة. الأسرار تبقى في `deploy/.env` على السيرفر وعند مسؤول النظام.

---

## 1. GitHub
1. أنشئ مستودعاً **خاصاً** وارفع الكود إليه (ملفات `.env` مستبعدة تلقائياً).

## 2. Supabase
1. أنشئ مشروعاً جديداً (اختر منطقة قريبة، مثل Frankfurt). احفظ كلمة مرور قاعدة البيانات في مكان آمن.
2. **Authentication ← Sign In / Providers ← Email:** فعّل الدخول بالبريد، و**أوقف «Allow new users to sign up»** حتى لا يسجل أحد نفسه. (حتى لو سجل أحد، لا يحصل على أي صلاحية بلا دور.)
3. خذ من **Project Settings**:
   - `Project URL` ← يُستخدم في `SUPABASE_URL` و`VITE_SUPABASE_URL`.
   - `anon / publishable key` ← للواجهة فقط (`VITE_SUPABASE_ANON_KEY`).
   - `service_role key` ← **سري**؛ لسكربت إنشاء الحسابات فقط، لا يوضع في الواجهة أو السيرفر.
   - **Database ← Connection string ← Session pooler** ← رابط القاعدة (IPv4). حوّل بدايته إلى `postgresql+asyncpg://`.

## 3. سيرفر Google (الخادم)
1. أنشئ حساب Google Cloud (يطلب كارتاً للتحقق؛ لا خصم داخل حدود المجاني). **فعّل تنبيه ميزانية 1 دولار.**
2. Compute Engine ← VM جديد: النوع **e2-micro**، المنطقة **us-central1** (أو us-east1 / us-west1)، النظام Debian 12، القرص **Standard persistent disk 30 جيجا**، وفعّل HTTP و HTTPS.
3. اجعل الـ IP الخارجي **ثابتاً (Static)**، وأضف في DNS سجل `A` لنطاق الـ API (مثل `api.example.com`) يشير إليه.
4. على السيرفر:
   ```
   sudo git clone <رابط المستودع الخاص> /opt/qema && cd /opt/qema
   sudo bash deploy/setup_vm.sh
   cp deploy/.env.example deploy/.env && nano deploy/.env   # املأ القيم
   ```

## 4. تجهيز قاعدة المصنع (من السيرفر)
1. **هيكل القاعدة:** `bash deploy/migrate.sh` — يعرض القاعدة المستهدفة، ويطلب كتابة اسمها واسمك كموافق، ويأخذ نسخة احتياطية، ثم يطبق التحديثات ويسجلها في `/var/log/qema-migrations.log`. هذا هو المسار الوحيد المسموح لتحديث قاعدة الإنتاج؛ أي طريق آخر مرفوض.
2. **البيانات الأساسية النظيفة (بلا أي بيانات تجريبية):**
   ```
   cd deploy && sudo docker compose --env-file .env run --rm api python scripts/bootstrap_factory_db.py --confirm-db postgres
   ```
   ينشئ الأدوار الأربعة والمخازن الثلاثة ووحدة «قطعة» فقط.
3. **تشغيل الخادم:** `bash deploy/update.sh`. Caddy يصدر شهادة HTTPS تلقائياً. افتح `https://api.example.com/health` ← يجب أن يظهر `{"status":"ok"}`.

## 5. حسابات الموظفين
لا توجد شاشة لإدارة المستخدمين داخل النظام. مسؤول النظام ينشئ كل حساب بأمر واحد من السيرفر (المفتاح السري يُكتب عند الطلب ولا يُحفظ):
```
cd /opt/qema/deploy
read -rs -p "service_role key: " SRK; echo
sudo docker compose --env-file .env run --rm -e SUPABASE_SERVICE_ROLE_KEY="$SRK" api   python scripts/create_factory_user.py --email name@factory.com --role finance_manager
unset SRK
```
- الأدوار: `general_manager` (المدير العام)، `warehouse_manager` (أمين المخزن)، `production_manager` (مسؤول الإنتاج)، `finance_manager` (المدير المالي).
- السكربت ينشئ الحساب مؤكداً، ويسند الدور، ويعرض **كلمة مرور مؤقتة مرة واحدة**؛ تُسلَّم للموظف يداً بيد.
- الموظف يدخل من صفحة الدخول بالبريد وكلمة المرور، ثم من نافذة الجلسة: **«تغيير كلمة المرور»**.
- نسي كلمة المرور؟ نفس الأمر مع `--reset-password`.
- تغيير دور موظف: نفس الأمر بالدور الجديد (الدور السابق يُستبدل).
- إيقاف موظف ترك العمل: من لوحة Supabase ← Authentication ← Users ← حذف أو حظر المستخدم.

## 6. التشغيل اليومي على السيرفر
1. **النسخ الاحتياطي الليلي:** `sudo crontab -e` وأضف:
   ```
   30 2 * * * bash /opt/qema/deploy/backup.sh >> /var/log/qema-backup.log 2>&1
   ```
   يحتفظ بآخر 14 نسخة في `/var/backups/qema`. يُفضّل تنزيل نسخة أسبوعياً لجهاز آخر.
2. **التحديث لاحقاً:** `cd /opt/qema && bash deploy/update.sh`، وإن كان التحديث فيه تغيير لهيكل القاعدة: `bash deploy/migrate.sh` قبله.

## 7. الواجهة على Cloudflare Pages
1. Workers & Pages ← Create ← Pages ← ربط مستودع GitHub.
2. الإعدادات:
   - Root directory: `apps/web`
   - Build command: `npm ci && npm run build`
   - Output directory: `dist`
   - متغيرات البيئة: `VITE_API_BASE_URL=https://api.example.com`، `VITE_SUPABASE_URL`، `VITE_SUPABASE_ANON_KEY` (المفتاح العام فقط).
3. ضع عنوان الواجهة الناتج (مثل `https://qema-erp.pages.dev`) في `CORS_ALLOWED_ORIGINS` داخل `deploy/.env` ثم `bash deploy/update.sh`.

## 8. قبل التشغيل الفعلي
- دخول كل موظف بحسابه وتغيير كلمة المرور.
- دورة صغيرة كاملة للتجربة، ثم الرصيد الافتتاحي (سند قبض «رصيد افتتاحي» + جرد افتتاحي)، ثم قائمة `ADMIN_HANDOVER_CHECKLIST_AR.md`.
