# المعمارية وبنية مستودع العمل

## القرار التقني المبدئي

- الواجهة: React + TypeScript + Vite، تطبيق ويب Arabic RTL.
- الـAPI: Python + FastAPI؛ Modular Monolith واحد في النسخة الأولى.
- البيانات: PostgreSQL؛ SQLAlchemy للتعامل مع البيانات وAlembic للترحيلات.
- الهوية: Supabase Auth لإدارة المستخدمين وتسجيل الدخول واستعادة كلمة المرور. يرسل التطبيق access token إلى الـAPI؛ الـAPI يتحقق من صحة الرمز والدور قبل كل عملية.
- الواجهة لا تتصل بقاعدة البيانات مباشرة ولا تستخدم Supabase service-role key. كل قواعد المخزون والرواتب والتنفيذ موجودة على الخادم.
- التواصل: REST JSON API عبر HTTPS. لاحقًا يمكن إضافة مهام خلفية أو طوابير إذا ظهر احتياج فعلي.

## رسم الاتصال

```text
متصفح الموظف
  ├── واجهة React المنشورة على Vercel
  └── HTTPS REST API → FastAPI على Render
                         ├── تحقق هوية من Supabase Auth (JWT)
                         └── SQLAlchemy → PostgreSQL على Supabase

GitHub خاص → مراجعة الفروع/الدمج → CI → معاينة Vercel + نشر API على Render
Cloudflare DNS (اختياري عند شراء نطاق) → app.example.com / api.example.com
Sentry (اختياري) ← أخطاء منزوعة البيانات الحساسة
```

Supabase هنا قاعدة بيانات PostgreSQL وخدمة هوية؛ لا نستخدم Firebase بالتوازي، ولا نخزن قاعدة واحدة في عدة مزودين. Render يشغل FastAPI، وVercel يستضيف الملفات الثابتة للواجهة. كل خدمة لها مسؤولية واحدة لتقليل التعقيد.

## بنية الريبو المستهدفة

```text
qemma-erp/
├── AGENTS.md                         # سياق ثابت وقواعد Antigravity
├── README.md                         # بدء التشغيل ومؤشرات المشروع
├── .gitignore
├── .env.example                      # أسماء متغيرات فقط دون أسرار
├── docs/
│   ├── PRODUCT_REQUIREMENTS_AR.md
│   ├── COMPANY_WORKFLOWS_AR.md
│   ├── IMPLEMENTATION_PLAN_AR.md
│   ├── CLOUD_DEPLOYMENT_AR.md
│   ├── ACCEPTANCE_CRITERIA_AR.md
│   ├── OPEN_DECISIONS_AR.md
│   ├── DATA_MODEL.md
│   └── AI_START_HERE_AR.md
├── .agents/
│   └── rules/
│       ├── frontend.md
│       └── backend.md
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/                 # router, providers, layouts
│   │   │   ├── components/           # عناصر عامة
│   │   │   ├── features/             # modules: inventory, production...
│   │   │   ├── lib/                  # API client, auth, formatting
│   │   │   ├── styles/
│   │   │   └── main.tsx
│   │   ├── public/
│   │   ├── index.html
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── api/
│       ├── app/
│       │   ├── api/v1/               # HTTP routes only
│       │   ├── core/                 # config, auth, logging
│       │   ├── db/                   # session, base, migrations glue
│       │   ├── modules/
│       │   │   ├── identity/
│       │   │   ├── catalog/
│       │   │   ├── inventory/
│       │   │   ├── production/
│       │   │   ├── sales/
│       │   │   ├── payroll/
│       │   │   ├── reports/
│       │   │   └── audit/
│       │   └── main.py
│       ├── alembic/
│       ├── tests/                    # unit + integration + API permissions
│       └── pyproject.toml
├── infra/
│   ├── compose.dev.yml                # PostgreSQL محلي فقط
│   ├── render.yaml                    # إعداد خدمة API بعد الاعتماد
│   └── docs/                          # إجراءات النشر والاستعادة
├── scripts/
│   ├── dev.ps1                        # تشغيل محلي لاحقًا
│   └── backup/                        # نسخ احتياطي مشفر بعد اعتماد سياسة الحفظ
├── frontend/
│   ├── index.html                     # اتجاهات لوحة المؤشرات، مرجع بصري فقط
│   └── operations-board.html          # التصميم المعتمد مبدئيًا، مرجع بصري فقط
└── .github/
    └── workflows/                     # CI بعد تثبيت lockfiles وخطوات البناء
```

لا يلزم أن توجد كل هذه المجلدات من اليوم. ينشئ Antigravity ما تحتاجه أول مرحلة فقط؛ لا تضع مجلدات مليئة بملفات فارغة. النماذج في `frontend/` مرجع بصري، ويعاد تنفيذها داخل `apps/web` بعد بدء مشروع الواجهة.

## تنظيم وحدات الـAPI

كل وحدة تحتوي بحسب الحاجة:
- `models.py`: SQLAlchemy models وعلاقات قاعدة البيانات.
- `schemas.py`: نماذج request/response والتحقق.
- `repository.py`: استعلامات محددة ومركزة.
- `service.py`: قواعد العمل والمعاملات.
- `router.py`: مسارات HTTP وفحص الهوية والصلاحيات.
- `tests/`: اختبارات الوحدات وتدفقات API.

لا تجعل router يحوي معادلات تكلفة أو راتب. لا تنسخ قاعدة العمل نفسها في React وFastAPI.

## معايير البيانات والتصميم

- كل كمية لها وحدة قياس، وكل مبلغ له دقة وcurrency واضحة؛ الحسابات تستخدم Decimal.
- المستند المعتمد append-only من ناحية التدقيق: لا محو صامت لحركة. التصحيح يتم بعكس موثق.
- تحديث حركة ورصيدها في database transaction واحدة. نستخدم قفلًا/تحققًا لمنع الصرف المتزامن الذي يتجاوز الرصيد.
- أرقام المستندات لا تعتمد على عدّ الصفوف من الواجهة؛ يولدها الخادم بطريقة آمنة.
- timestamps تخزن UTC وتعرض بتوقيت المصنع المعتمد.
- معاملات الصرف والتحويل والاستلام وإغلاق الدفعة تتطلب idempotency/منع التكرار حيث يلزم.
- جميع API responses تخفي تفاصيل الأسرار والبنية الداخلية. طلبات التصدير والتقارير تطبق نفس صلاحيات العرض.

## متغيرات البيئة المقترحة

واجهة الويب (قيم عامة فقط): `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

API (أسرار server-only): `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWKS_URL` أو آلية تحقق JWT يثبتها التصميم، `CORS_ALLOWED_ORIGINS`, `APP_ENV`, `LOG_LEVEL`.

كل القيم الحقيقية تحفظ في إعدادات مزود الخدمة. لا تضع في `VITE_*` مفاتيح سرية، `DATABASE_URL` أو `service_role`.
