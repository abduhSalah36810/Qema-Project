# دليل التثبيت والتشغيل والنشر والنسخ الاحتياطي — نظام ERP مصنع القمة

هذا الدليل لمسؤول النظام/المطور. دليل الموظفين في `docs/USER_GUIDE_AR.md`، والقيود المعروفة في `docs/KNOWN_LIMITATIONS_AR.md`.

---

## 1. المتطلبات

| المكون | الإصدار |
|---|---|
| Python | 3.12 |
| Node.js | 20 |
| PostgreSQL | 16 (محلياً عبر Docker أو خدمة مُدارة مثل Supabase) |

---

## 2. التشغيل المحلي (بيئة التطوير)

```powershell
# من جذر المستودع
Copy-Item .env.example .env          # ثم عدّل القيم محلياً (الملف لا يُرفع إلى Git)
docker compose -f infra/compose.dev.yml up -d
```

```powershell
cd apps/api
python -m venv .venv
.\.venv\Scripts\activate
pip install -e ".[dev]"
alembic upgrade head                  # حتى 20261108_0017
uvicorn app.main:app --reload --port 8000
```

```powershell
cd apps/web
npm ci
npm run dev                           # http://localhost:5173
```

تسجيل الدخول المحلي (اختيار الدور بدون كلمة مرور) يعمل فقط عند `DEV_AUTH_ENABLED=true` و`APP_ENV=development` أو `testing`، ومع `LOCAL_JWT_SECRET` بطول 32 حرفاً على الأقل. **ممنوع في أي بيئة مشتركة.**

---

## 3. متغيرات البيئة

| المتغير | الاستخدام | ملاحظات |
|---|---|---|
| `DATABASE_URL` | رابط PostgreSQL (`postgresql+asyncpg://…`) | سر — لا يوضع في الواجهة أو في Git |
| `APP_ENV` | `development` / `testing` / `staging` / `production` | أي قيمة أخرى توقف الخادم عمداً |
| `LOG_LEVEL` | `info` افتراضياً | |
| `SQL_ECHO` | `true` لطباعة استعلامات SQL | اتركه مغلقاً؛ يكشف قيماً حساسة في السجلات |
| `CORS_ALLOWED_ORIGINS` | نطاقات الواجهة المسموح بها | في الإنتاج: نطاق الواجهة فقط (لا localhost) |
| `DEV_AUTH_ENABLED`, `LOCAL_JWT_SECRET` | الدخول المحلي للتطوير | مرفوض خارج development/testing |
| `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE` | التحقق من توكنات Supabase | لا تضع مفتاح service_role في أي مكان بالواجهة |
| `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | إعدادات الواجهة العامة | قيم عامة فقط |

---

## 4. المستخدمون والأدوار (مهم قبل التشغيل الفعلي)

الأدوار الأربعة المعتمدة: `general_manager`، `warehouse_manager`، `production_manager`، `finance_manager`.

- الخادم يحدد الأدوار من جدول `user_roles` (ومن `app_metadata` في Supabase الذي لا يعدله إلا الخادم). **لا يُقرأ `user_metadata` إطلاقاً** لأن المستخدم يستطيع تعديله بنفسه.
- لا توجد حالياً شاشة لإدارة المستخدمين؛ يُسند الدور بأمر SQL يُنفذه مسؤول النظام بعد إنشاء المستخدم في Supabase Auth (المعرّف = `sub` في التوكن):

```sql
INSERT INTO user_roles (id, user_id, role_id, assigned_at, assigned_by)
SELECT gen_random_uuid()::text, '<SUPABASE_USER_ID>', r.id, NOW(), '<اسم المسؤول>'
FROM roles r WHERE r.name = 'warehouse_manager';
```

- قاعدة الاعتماد المالي: المدير المالي هو المسؤول المالي النهائي ولا توجد جهة اعتماد فوقه؛ مستنداته النقدية تُعتمد وتُرحَّل لحظة حفظها بعد التحقق من الرصيد (وأي خطأ بعد الحفظ يُصحَّح بمستند عكسي). أما المستندات أو طلبات السداد التي ينشئها الآخرون (أمين المخزن، المدير العام، وغيرهم) فتبقى معلقة حتى يعتمدها المدير المالي من شاشة الخزينة، ولا يعتمد منشئ المستند ما أنشأه.

---

## 5. البيانات الأولية قبل أول يوم تشغيل

1. المخازن الثلاثة (`main_raw_materials`، `work_in_progress`، `finished_goods`) والوحدات والخزنة الرئيسية تُنشأ بالترحيلات/البذر الأولي.
2. **الأرصدة الافتتاحية للمخزون**: النظام لا يوفر شاشة "رصيد افتتاحي"، والطريق الموثق حالياً هو جرد افتتاحي لكل مخزن (جرد كامل) تُعتمد فروقاته وتُرحّل. ملاحظة: تكلفة الزيادة في الجرد تُقيّم بمتوسط التكلفة الحالي وقد تكون صفراً للأصناف الجديدة — راجع القيود المعروفة.
3. **رصيد الخزنة الافتتاحي**: مستند قبض (إيراد) على الخزنة الرئيسية بوصف واضح (رصيد افتتاحي) يسجله المدير المالي فيُعتمد فوراً (أو ينشئه مستخدم آخر فيعتمده المدير المالي من شاشة الخزينة).
4. أصناف الدليل يجب اعتمادها (approval) قبل استخدامها في فواتير الموردين أو أوامر التشغيل.

---

## 6. الاختبارات

قاعدة الاختبار معزولة إجبارياً (localhost واسم يحتوي `test`)؛ لا تُشغّل الاختبارات على قاعدة التطوير أو الإنتاج.

```powershell
# مرة واحدة: إنشاء القاعدة وترحيلها وبذر البيانات المرجعية
psql -h localhost -U qemma_dev -d qemma_erp_dev -c "CREATE DATABASE qemma_test_db;"
cd apps/api
$env:DATABASE_URL="postgresql+asyncpg://qemma_dev:<كلمة المرور>@localhost:5432/qemma_test_db"; $env:APP_ENV="testing"
alembic upgrade head
$env:TEST_DATABASE_URL=$env:DATABASE_URL
python scripts/setup_test_db.py

# تشغيل كل اختبارات الخادم
python -m pytest tests/ -q

# سيناريو الدورة الكاملة للمصنع (مشتريات → إنتاج بمقاسين → مبيعات → خزينة → جرد → صلاحيات)
python -m pytest tests/test_operational_cycle_e2e.py -v
```

```powershell
cd apps/web
npm run test
npm run type-check
npm run lint
npm run build
```

خط CI (`.github/workflows/ci.yml`) ينشئ `qemma_test_db` ويرحّلها ويبذرها قبل تشغيل الاختبارات.

---

## 7. النشر (Staging ثم Production)

ترتيب آمن لكل إصدار:

1. **نسخة احتياطية كاملة** من قاعدة البيانات (القسم 8) والتحقق من إمكانية استعادتها.
2. نشر الكود على بيئة staging متصلة بنسخة من البيانات، ثم `alembic upgrade head` هناك والتحقق من:
   `GET /api/v1/health` و`GET /api/v1/ready` وتشغيل دورة يدوية قصيرة (فاتورة مورد ← استلام ← صرف لأمر تشغيل).
3. في الإنتاج: إيقاف الكتابة (نافذة صيانة)، نسخة احتياطية، `alembic upgrade head` (حارس الترحيلات يرفض ترحيل الإنتاج من الجهاز المحلي؛ نفّذه من بيئة النشر المعتمدة)، ثم تشغيل الخادم.
4. إعدادات الإنتاج الإلزامية: `APP_ENV=production`، `DEV_AUTH_ENABLED=false`، `CORS_ALLOWED_ORIGINS` = نطاق الواجهة فقط، اتصال قاعدة البيانات مشفر (SSL)، توثيق Supabase مفعل مع تعطيل التسجيل الذاتي (sign-ups) إلا عند الحاجة.
5. الواجهة: `npm run build` ونشر مجلد `apps/web/dist` على الاستضافة الثابتة مع `VITE_API_BASE_URL` الصحيح.

### ملاحظة عن ترحيل 0017 على بيانات قائمة
- يحول أعمدة الرواتب إلى أرقام عشرية دقيقة (تقريب لخانتين).
- يضيف قيداً فريداً (فترة، موظف) على كشوف الرواتب: إذا كانت هناك كشوف مكررة سابقة سيفشل الترحيل ويجب تنظيفها يدوياً بعد مراجعتها.
- يجعل دفتر النقدية وسطور القيود غير قابلة للتعديل أو الحذف (Trigger). أي تصحيح يتم بمستند جديد.
- التحصيلات القديمة تُعتبر "معتمدة" (لأنها كانت تدخل الخزنة مباشرة).

---

## 8. النسخ الاحتياطي والاستعادة

### نسخة احتياطية يومية

```bash
pg_dump --format=custom --no-owner --file="qemma_$(date +%Y%m%d_%H%M).dump" "$DATABASE_URL_PLAIN"
```

حيث `DATABASE_URL_PLAIN` بصيغة `postgresql://user:pass@host:5432/dbname` (بدون `+asyncpg`).
- احفظ نسخة خارج الخادم (تخزين سحابي مشفر) واحتفظ بآخر 30 نسخة يومية و12 نسخة شهرية على الأقل.
- عند استخدام Supabase: فعّل النسخ الاحتياطي اليومي/PITR من لوحة المشروع إضافة إلى النسخة اليدوية قبل كل نشر.

### الاستعادة (على قاعدة جديدة فارغة)

```bash
createdb -h <host> -U <user> qemma_restore_check
pg_restore --no-owner --dbname="postgresql://user:pass@host:5432/qemma_restore_check" qemma_YYYYMMDD_HHMM.dump
```

- اختبر الاستعادة شهرياً على قاعدة منفصلة وتحقق من: عدد المستندات، رصيد الخزنة (`GET /api/v1/finance/accounts`)، أرصدة المخزون (`GET /api/v1/inventory/stock`).
- لا تستعد فوق قاعدة الإنتاج مباشرة إلا بقرار مكتوب وبعد أخذ نسخة من الحالة الحالية.

---

## 9. المراقبة اليومية المقترحة

- `/api/v1/ready` كل دقيقة (تنبيه عند الفشل).
- مراجعة سجلات `qemma.rbac` (محاولات وصول مرفوضة) و`role_lookup_failed`.
- قائمة المستندات المعلقة في شاشة الخزينة يومياً (لا تترك تحصيلات أو دفعات معلقة لأيام).
