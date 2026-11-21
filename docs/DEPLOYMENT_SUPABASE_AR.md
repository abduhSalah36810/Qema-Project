# دليل الجاهزية والنشر على Supabase والإنتاج — مصنع القمة

> **ملاحظة أمنية أساسية:**
> قاعدة بيانات الإنتاج تبدأ فارغة تماماً. جميع البيانات المتداولة حالياً في بيئة التطوير هي بيانات اختبارية أو اصطناعية.
> لا يُنقل أي سجل تجريبي إلى قاعدة الإنتاج.

---

## 1. متغيرات البيئة للإنتاج (Environment Variables)

### أ. خادم الـ API الخلفي (FastAPI)

| المتغير | النوع | الوصف | مثال توضيحي (قيم وهمية) |
| :--- | :--- | :--- | :--- |
| `APP_ENV` | **إلزامي** | بيئة التشغيل؛ يجب أن تكون `production` حصراً. | `production` |
| `DATABASE_URL` | **إلزامي** | رابط الاتصال بقاعدة Supabase (عبر مجمع الاتصالات Supavisor في وضع Transaction أو الاتصال المباشر). | `postgresql+asyncpg://postgres.projectref:your-strong-db-password@aws-0-region.pooler.supabase.com:6543/postgres` |
| `DB_POOL_MODE` | **إلزامي** عند استخدام Supavisor | تعطيل كاش العبارات المعدة (`statement_cache_size=0`) لمنع أخطاء Supavisor. | `transaction` |
| `CORS_ALLOWED_ORIGINS` | **إلزامي** | نطاق الواجهة الأمامية الموثوق حصراً (يُمنع استخدام `*` أو `localhost`). | `https://erp.qemma-factory.com` |
| `SUPABASE_URL` | **إلزامي** | عنوان مشروع Supabase للتحقق من هوية المستخدمين. | `https://xxxxxx.supabase.co` |
| `SUPABASE_JWKS_URL` | اختياري | رابط مفاتيح JWKS للتحقق غير المتماثل (يُشتق تلقائياً إن لم يُحدد). | `https://xxxxxx.supabase.co/auth/v1/.well-known/jwks.json` |
| `SUPABASE_JWT_ISSUER` | اختياري | جهة إصدار التوكن المتوقعة (تُشتق تلقائياً). | `https://xxxxxx.supabase.co/auth/v1` |
| `SUPABASE_JWT_AUDIENCE`| اختياري | نطاق التوكنات المعتمدة (الافتراضي: `authenticated`). | `authenticated` |
| `DEV_AUTH_ENABLED` | **ممنوع/غير مفعل** | يجب أن يكون غير موجود أو `false`. | `false` |
| `SQL_ECHO` | اختياري | طباعة استعلامات SQL؛ يُترك `false` في الإنتاج لحماية خصوصية الرواتب والعملاء. | `false` |
| `LOG_LEVEL` | اختياري | مستوى السجلات في الإنتاج. | `info` |

### ب. الواجهة الأمامية (Vite / React)

| المتغير | النوع | الوصف | مثال توضيحي |
| :--- | :--- | :--- | :--- |
| `VITE_API_BASE_URL` | **إلزامي** | رابط الـ API الخلفي المنشور لمصنع القمة. | `https://api.qemma-factory.com` |
| `VITE_SUPABASE_URL` | **إلزامي** | عنوان مشروع Supabase للمصادقة وتغيير كلمة المرور. | `https://xxxxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | **إلزامي** | المفتاح العام (Anon/Publishable Key) لاستخدامه في عميل المتصفح. | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |
| `VITE_APP_ENV` | اختياري | بيئة تشغيل الواجهة؛ عند ضبطه على `production` يُخفي شريط العرض التجريبي (DEMO) نهائياً. | `production` |

> [!CAUTION]
> **تحذير حاسم حول أمان الأسرار:**
> لا تضع أبداً `SUPABASE_SERVICE_ROLE_KEY` أو كلمة مرور قاعدة البيانات أو مفاتيح سرية داخل أي متغير يبدأ بـ `VITE_`.
> متغيرات `VITE_*` تُدمج في كود الجافاسكربت وتصل إلى متصفح العميل ويمكن لأي شخص قراءتها.

---

## 2. آليات الحماية التلقائية عند `APP_ENV=production`

عند ضبط `APP_ENV=production`، يفعل الخادم الضوابط الأمنية التالية تلقائياً:

1. **رفض الإقلاع الفوري مع `DEV_AUTH_ENABLED`:**
   إذا وُجد `DEV_AUTH_ENABLED=true` في بيئة الإنتاج، يفشل الخادم في بدء التشغيل فوراً ويرمي استثناء `ValueError: حظر أمني: لا يمكن تفعيل المصادقة المحلية في بيئة الإنتاج`.
2. **إغلاق مسار الدخول المحلي (`404 Not Found`):**
   نقطة النهاية `POST /api/v1/auth/local-login` تُعيد `404 Not Found` تلقائياً في بيئة الإنتاج، مما يمنع توليد أي توكنات محلية دون المرور بـ Supabase Auth.
3. **التحقق الصارم من CORS:**
   يتحقق الخادم من أن `CORS_ALLOWED_ORIGINS` لا يحتوي على أي عنوان محلي (`localhost` أو `127.0.0.1`) أو رمز عام (`*`).
4. **عزل الصلاحيات واستبعاد الحسابات الوهمية:**
   لا تُعتمد أي أدوار افتراضية أو تجريبية؛ تُقرأ الصلاحيات والأدوار الفعلية للمستخدم حصرياً من جدول `user_roles` في قاعدة البيانات.
5. **حظر سكربتات التجريب وإعادة الضبط:**
   ترفض جميع سكربتات البيانات التجريبية (`seed_e2e_dataset.py`, `seed_pilot_demo.py`, `reset_pilot_demo_db.py`, `setup_test_db.py`) العمل وتخرج فوراً إذا كان `APP_ENV=production`.
6. **حجب شريط العرض التجريبي في الواجهة:**
   عند ضبط `VITE_APP_ENV=production` يُخفي شريط التنبيه التجريبي في الواجهة نهائياً لمنع أي التباس لدى مستخدمي المصنع.
7. **مطابقة الحسابات المالية للتدشين (GL Account Mapping):**
   - **1010:** الخزينة الرئيسية (نقدية بالصندوق).
   - **1020:** العهد النقدية للموظفين (Petty Cash Custody) — لا تُدرج في القيد الافتتاحي العام وتُصرف لاحقاً.
   - **1030:** الحساب البنكي المعتمد لمصنع القمة (Bank Account).
   - **3900:** حساب وسيط تسوية الأرصدة الافتتاحية (Opening Balances Clearing Account) — يُصفّى ويصل إلى 0.00 بمجرد اكتمال توازن أصول والتزامات وحقوق ملكية يوم القطع.

---

## 3. تسلسل إعداد قاعدة البيانات الجديدة من الصفر (Fresh Production Bootstrap)

عند إطلاق بيئة الإنتاج لأول مرة على Supabase، يُتبع هذا التسلسل الصارم خطوة بخطوة:

### الخطوة 1: تطبيق ترحيلات قاعدة البيانات (Alembic Migrations)
تشغيل آخر إصدار من الترحيلات لإنشاء الجداول والقيود وقواعد أمان RLS:
```bash
cd apps/api
alembic upgrade head
```

### الخطوة 2: تهيئة البنية الأساسية فقط (`bootstrap_factory_db.py`)
تشغيل سكربت التهيئة النظيفة الذي ينشئ فقط الهياكل المؤسسية بدون أي بيانات أصناف أو مخزون:
```bash
python scripts/bootstrap_factory_db.py
```
**ما ينشئه السكربت فقط:**
- الأدوار الأربعة الأساسية في جدول `roles`: (`general_manager`, `warehouse_manager`, `production_manager`, `finance_manager`).
- المخازن الثلاثة الرئيسية في جدول `warehouses`:
  - مخزن الخامات الرئيسي (`CANONICAL_RAW_MATERIALS_WAREHOUSE_ID`).
  - مخزن تحت التشغيل ودفعات الإنتاج (`CANONICAL_WIP_WAREHOUSE_ID`).
  - مخزن المنتج التام (`CANONICAL_FINISHED_GOODS_WAREHOUSE_ID`).
- حساب الخزينة الرئيسي في جدول `cash_accounts` (`CANONICAL_TREASURY_ID`).
- حساب البنك الرئيسي في جدول `cash_accounts` (`CANONICAL_BANK_ID`).
- وحدة القياس الافتراضية في جدول `units`: `قطعة` (`piece`).
- **لا ينشئ:** أي أصناف دليل، أي كميات مخزون، أي قيود افتتاحية، ولا أي مستخدمين.

### الخطوة 3: إنشاء حساب المدير العام الأولي (Initial General Manager)
1. من لوحة تحكم Supabase Dashboard، انتقل إلى **Authentication -> Users** واضغط **Add user -> Create user**.
2. أدخل البريد الإلكتروني المعتمد للمدير العام (مثال: `gm@qemma-factory.com`) وكلمة مرور قوية.
3. انسخ الـ `User UID` المولد من Supabase (مثال: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`).
4. في **SQL Editor** داخل Supabase Dashboard، نفّذ الاستعلام التالي لربط المستخدم بدور المدير العام:
```sql
-- ربط مستخدم المدير العام الأولي بدور الإدارة العامة
INSERT INTO public.user_roles (id, user_id, role_id, created_at)
SELECT 
    gen_random_uuid(),
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid, -- استبدل بالـ UID الفعلي لمستخدم المدير العام
    r.id,
    NOW()
FROM public.roles r
WHERE r.name = 'general_manager'
ON CONFLICT (user_id, role_id) DO NOTHING;
```

---

## 4. قفل الـ Data API ومستويات أمان Supabase

### أ. حجب Schema `public` عن PostgREST
بما أن النظام مصمم بالكامل بحيث تمر جميع طلبات القراءة والكتابة والتحقق المالي حصرياً عبر خادم **FastAPI**، يُحظر الوصول المباشر من المتصفح إلى جداول قاعدة البيانات:
1. في لوحة تحكم Supabase، انتقل إلى **Settings -> API**.
2. تحت **Exposed schemas**، تأكد من إزالة `public` (أو تركها بدون أي Policies).
3. تفعيل **Row Level Security (RLS)** تم برمجياً عبر Migration رقم `20261116_0037` على جميع جداول schema `public` بدون إنشاء أي Policies، مما يعني:
   - أي محاولة وصول عبر `anon` أو `authenticated` من خارج الـ API الخلفي تُرفض تلقائياً (`Default Deny`).
   - خادم FastAPI يتصل بصفته مالك الجداول أو عبر المستخدم المفوّض الذي يتجاوز RLS تلقائياً (`BYPASSRLS`).

---

## 5. خطة النسخ الاحتياطي والاسترجاع (Backup & Recovery Plan)

### أ. مواعيد أخذ النسخ الاحتياطية
1. **النسخة الصفرية (Pre-Cutover Backup):**
   تؤخذ فور الانتهاء من تهيئة البنية الأساسية (`bootstrap_factory_db`) وقبل إدخال أي رصيد افتتاحي.
   ```bash
   pg_dump "postgresql://postgres.xxx:pass@host:5432/postgres" -F c -b -v -f qemma_pre_cutover_clean.dump
   ```
2. **نسخة يوم القطع (Post-Cutover Backup):**
   تؤخذ فور اعتماد الجرد الافتتاحي، فواتير الموردين الافتتاحية، وأرصدة العملاء، وترحيل القيد الافتتاحي العام وقفل الأرصدة.
   ```bash
   pg_dump "postgresql://postgres.xxx:pass@host:5432/postgres" -F c -b -v -f qemma_day0_cutover_locked.dump
   ```

### ب. خطة التراجع (Rollback Strategy)
> [!IMPORTANT]
> **قاعدة قطعية:** إذا حدث خطأ جسيم أثناء يوم القطع الافتتاحي وتطلب التراجع، **يُمنع استخدام Alembic downgrade للتراجع عن البيانات**.
> التراجع الصحيح يكون حصرياً باسترجاع النسخة الاحتياطية النظيفة (`qemma_pre_cutover_clean.dump`):
```bash
# 1. إيقاف خادم FastAPI
# 2. استرجاع النسخة النظيفة:
pg_restore -d "postgresql://postgres.xxx:pass@host:5432/postgres" --clean --no-owner qemma_pre_cutover_clean.dump
# 3. إعادة تشغيل خادم FastAPI
```

---

## 6. إرشادات تشغيل FastAPI خلف Reverse Proxy (Uvicorn & Nginx/Cloudflare)

عند تشغيل خادم FastAPI في بيئة الإنتاج:

1. **أمر تشغيل Uvicorn مع Workers متعددة:**
   ```bash
   uvicorn app.main:app \
     --host 0.0.0.0 \
     --port 8000 \
     --workers 4 \
     --proxy-headers \
     --forwarded-allow-ips "*" \
     --timeout-keep-alive 65
   ```
2. **تمرير ترويسات البروكسي (Proxy Headers):**
   - `--proxy-headers`: ضروري لقراءة عنوان الـ IP الحقيقي للعميل وبروتوكول الاتصال (`https`) من Cloudflare / Nginx.
   - التأكد من إرسال ترويسات `X-Forwarded-For` و `X-Forwarded-Proto` من البروكسي العكسي.
3. **مهلة الاستجابة (Timeouts):**
   - ضبط `timeout-keep-alive 65` ليتناسب مع مهلة اتصالات Cloudflare (60 ثانية) لمنع أخطاء 520 / 524.
