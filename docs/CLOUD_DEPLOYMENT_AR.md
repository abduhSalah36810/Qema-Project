# ربط خدمات التشغيل السحابية

## الاختيار المبدئي المقترح

استخدموا خدمة واحدة واضحة لكل وظيفة؛ لا نحتاج Firebase وSupabase وNeon معًا. المقترح الحالي مناسب لتطبيق ويب تشغيلي صغير يبدأ قليلًا ويكبر دون نقل مكونات متعددة:

| الوظيفة | الخدمة المقترحة | المسؤولية | حالة القرار |
|---|---|---|---|
| مستودع الكود والتاريخ | GitHub private | Git، Pull Requests، نسخ المشروع ومراجعة التغييرات | يلزم إنشاء/ربط الريبو من حساب المالك |
| واجهة React/Vite | Vercel | بناء ونشر static frontend ومعاينات للفروع | يربط بعد تهيئة apps/web |
| FastAPI | Render Web Service | تشغيل API وdeploy عند الدمج إلى فرع معتمد | يربط بعد إنشاء apps/api |
| PostgreSQL والهوية | Supabase | PostgreSQL مُدارة وAuth/JWT | بيئة staging ثم production منفصلتان |
| DNS واسم النطاق | Cloudflare (اختياري) | إدارة DNS وشهادات/حماية النطاق بحسب الإعداد | لا يلزم قبل شراء النطاق |
| تتبع الأعطال | Sentry (اختياري) | التقاط أخطاء الواجهة والخادم | يؤجل؛ يمنع إرسال بيانات رواتب أو بيانات شخصية |
| CI | GitHub Actions | فحوص الكود والمهاجرات والاختبارات على الفروع | يبدأ قبل أول ميزة إنتاجية |

هذه الخطة لا تتطلب تخزين ملفات في Cloud Storage؛ Excel وPDF يمكن توليدهما من API وقت الطلب. إذا ظهرت لاحقًا مرفقات، نقرر bucket خاصًا وسياسة وصول ونسخ منفصلة. لا نضيف SMS أو بريد آلي الآن.

## تدفق الاتصال

1. متصفح المستخدم يطلب واجهة Vercel على HTTPS.
2. الواجهة تسجل الدخول عبر Supabase Auth وتحصل على جلسة مستخدم. تبعث access token إلى FastAPI عبر HTTPS.
3. FastAPI يتحقق من توقيع/issuer/audience/expiry للـJWT، ثم يطابق user id مع أدوار النظام. كل إذن يتأكد في API.
4. FastAPI يتصل بقاعدة Supabase عبر TLS وSQLAlchemy. يستخدم connection pooler المناسب لطريقة تشغيل الخدمة بعد اختبار إعداد الاتصال؛ لا توضع بيانات الاتصال في الواجهة.
5. تتصل الواجهة بعنوان API في `VITE_API_BASE_URL`. يسمح الـAPI بـCORS فقط لعناوين Vercel المعتمدة واسم النطاق النهائي.

راجعوا توثيق Vercel لنشر Vite وRender لنشر FastAPI وSupabase للاتصال/تجميع اتصالات PostgreSQL قبل الإعداد؛ تفاصيل واجهات الخدمات وحدودها تتغير.

## ترتيب الإعداد من دون خلط بيئات التطوير والإنتاج

### 1. GitHub

- إنشاء private repository باسم مناسب، ثم ربط checkout المحلي بعد مراجعة `.gitignore` وعدم تضمين `.env` أو `node_modules` أو سجلات.
- تسمية الفرع الافتراضي `main`، واستخدام فروع مثل `feat/inventory-receipts` و`fix/stock-balance`.
- تفعيل Pull Request requirement وفحوص CI قبل الدمج. إعداد بيئة production المحمية بموافقة مالك المشروع.
- لا ترفع بيانات المصنع أو ملفات أجور أو أي مفاتيح إلى GitHub.

### 2. Supabase

- إنشاء مشروع staging منفصل عن production؛ اختيار المنطقة بعد مراجعة أماكن الخدمة المتاحة، متطلبات مكان البيانات، وتجربة زمن الاستجابة من مصر.
- إنشاء قاعدة البيانات والـAuth، وضبط redirect URLs محليًا وstaging وإنتاجًا كل على حدة.
- حفظ كلمة مرور قاعدة البيانات و`SUPABASE_JWT_SECRET`/المفاتيح السرية في إعدادات الخادم فقط.
- استخدام قاعدة/مشروع إنتاج مستقل، وتفعيل خطة نسخ مناسبة قبل تخزين السجلات الحقيقية.
- أخذ نسخة خارجية دورية ومشفرة واختبار استعادتها؛ نسخ قاعدة البيانات لا تتضمن ملفات Storage المخزنة كأجسام، إذا أضيفت لاحقًا.

### 3. Render

- ربط خدمة API بمجلد `apps/api` في الريبو وتحديد أمر البناء والتشغيل وفق ملف المشروع الفعلي.
- إضافة الأسرار في Environment Settings للخدمة، وليس في ملفات Git أو أوامر Antigravity. تعيين `DATABASE_URL`, بيانات التحقق من JWT, `CORS_ALLOWED_ORIGINS`, `APP_ENV`.
- استخدام خدمة مدفوعة لا تدخل في sleep عند الاستخدام الحقيقي؛ الخطة المجانية للتجربة فقط وليست معيار تشغيل.
- ضبط health check ومراجعة logs، وعدم تسجيل payloads الحساسة.

### 4. Vercel

- ربط الريبو بمشروع واجهة وحده، وتحديد Root Directory إلى `apps/web`، build command وoutput حسب Vite.
- إضافة متغيرات واجهة عامة فقط: `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- لا تستخدم أي مفتاح service role أو اتصال قاعدة بيانات أو أسرار API ضمن `VITE_*`؛ متغيرات Vite المسبوقة بـVITE تذهب للمتصفح.
- معاينة branch للاختبار، وإنتاج بعد اعتماد Pull Request فقط.

### 5. النطاق والدومين (اختياري)

- شراء النطاق وتحديد مالكه ومن يدفع التجديد قبل إعداد DNS.
- DNS مقترح: `app.<domain>` للواجهة و`api.<domain>` للـAPI. لا تغيّر MX أو بريد الشركة الحالي أثناء إعداد سجلات الويب.
- تفعيل TLS ثم مراجعة CORS وAuth redirect URLs وملفات cookies بعد اختيار نمط جلسة المصادقة.
- لا تفعّل Cloudflare proxy أو caching لطلبات API/auth قبل اختبار رؤوس التوثيق وcookies وtimeouts.

### 6. GitHub Actions والمراقبة

- عند كل Pull Request: تثبيت من lockfiles، lint، type check، build، واختبارات frontend/backend وmigration checks.
- عند الدمج إلى فرع staging: نشر staging تلقائيًا إذا ضبطت المنصة لذلك.
- نشر الإنتاج محمي ببيئة GitHub تتطلب موافقة. لا تشغل migration منتجة ضمن CI دون خطة مراجعة وتراجع.
- عند إضافة Sentry، احجب البريد والهاتف والأجور ومحتوى الطلبات من breadcrumbs وrequest payloads.

## الأسرار والملفات المحلية

يحتوي `.env.example` أسماء متغيرات وقيم شرح فقط. أنشئ ملف `.env` محليًا من المثال واحفظه في `.gitignore`. كل مزود له مدير أسرار خاص به. لا ترسل كلمة مرور أو token في المحادثة أو إلى Antigravity؛ أدخلها مباشرة في لوحة الخدمة، ولا تشاركها كملف.

## النسخ والاستعادة

- لا تعتمد على قاعدة البيانات كنسخة وحيدة. يُحفظ dump مشفر خارج مشروع قاعدة البيانات وفق مدة يحتفظ بها المصنع.
- Supabase تعرض نسخًا يومية على الخطط المدفوعة، لكن الملفات المخزنة عبر Storage لا تدخل في نسخ قاعدة البيانات؛ راجعوا الخدمة والإعداد الفعلي قبل إطلاق بيانات حقيقية.
- يسجل اختبار استعادة كامل على staging: التاريخ، نسخة المصدر، مدة الاستعادة، وعدد سجلات تحقق.
- تحدد الإدارة هدف فقد بيانات مقبول (RPO) ومدة رجوع الخدمة (RTO)؛ بعدها نقارن تكلفة التكرار/النسخ بخطر توقف المصنع.

## ما لم يتم تنفيذه الآن

لا يوجد ربط حسابات سحابي أو repo على GitHub أو secrets أو deploy منشأ حتى الآن. المستودع المحلي جاهز لتوثيق البنية، لكن تفاصيل الوصول تحتاج مالك الحساب يسجل دخوله ويختار/يعتمد الخدمات. لا نرفع الكود ولا ننشئ موارد مدفوعة إلا بعد تثبيت اختيار المزود والنطاق والميزانية والموافقة على خطوات الإنشاء.

## مراجع المزودين الرسمية

- [Antigravity rules and workspace files](https://www.antigravity.google/docs/rules/)
- [Vercel Vite deployment](https://vercel.com/docs/frameworks/frontend/vite)
- [Render FastAPI deployment](https://render.com/docs/deploy-fastapi)
- [Supabase PostgreSQL overview and connection methods](https://supabase.com/docs/guides/database/overview)
- [Supabase connection pooling](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits)
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [GitHub deployment environments and protected secrets](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
