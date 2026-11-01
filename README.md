# نظام ERP مصنع القمة للملابس

نظام ويب تشغيلي لإدارة خامات الإنتاج والدفعات والمخازن والمبيعات والرواتب في مصنع القمة للملابس.

---

## المكدس التقني

| الطبقة | التقنية |
|---|---|
| الواجهة | React 18 · TypeScript · Vite · CSS RTL |
| الـ API | Python 3.12 · FastAPI · SQLAlchemy (async) |
| قاعدة البيانات | PostgreSQL 16 |
| الترحيلات | Alembic |
| التطوير المحلي | Docker Compose (Postgres) |

---

## البنية

```
qemma-erp/
├── apps/
│   ├── web/          # واجهة React + TypeScript + Vite
│   └── api/          # FastAPI — Modular Monolith
├── docs/             # وثائق المشروع (مصادر الحقيقة)
├── frontend/         # مرجع التصميم البصري (HTML تجريبي)
└── infra/            # Docker Compose للتطوير المحلي
```

---

## البدء السريع (بيئة التطوير المحلية)

> **تنبيه أمني وبيئي:** هذه الخطوات مخصصة للتطوير المحلي فقط عبر Docker Compose. لا تُستخدم هذه الإعدادات أو كلمات المرور في بيئة الإنتاج السحابية، حيث تتطلب بيئة الإنتاج اتصالات مشفرة وأسراراً تُدار عبر لوحة المزود المعتمد وراية تأكيد صريحة للترحيلات (`ALLOW_PROD_MIGRATIONS=1`).

### 1. تحضير ملف البيئة المحلي (.env)

الخادم يتطلب تعريفاً صريحاً لرابط قاعدة البيانات `DATABASE_URL` في ملف `.env` (لا توجد كلمة مرور افتراضية مدمجة في الكود):

```powershell
Copy-Item .env.example .env
# ملف .env محمي ومدرج في .gitignore ولن يُرفع إلى Git
```

### 2. تشغيل قاعدة البيانات المحلية (PostgreSQL 16 عبر Docker)

```powershell
docker compose -f infra/compose.dev.yml up -d
# التحقق من حالة الحاوية:
docker compose -f infra/compose.dev.yml ps
```

### 3. إعداد بيئة الـ API وتشغيل الترحيلات

```powershell
cd apps/api
# تفعيل البيئة الافتراضية (Windows):
.\.venv\Scripts\activate
# تثبيت الحزم التأسيسية:
pip install -e ".[dev]"

# التحقق من حالة ترحيلات Alembic (لا توجد جداول أعمال حالياً بانتظار اعتماد قرارات المصنع):
alembic current
# تطبيق الترحيلات عند توفرها:
alembic upgrade head
```

### 4. تشغيل خادم الـ API المحلي

```powershell
# من داخل apps/api:
uvicorn app.main:app --reload --port 8000

# فحص صحة العملية (Liveness - مستقل تماماً عن قاعدة البيانات):
# Invoke-RestMethod http://localhost:8000/api/v1/health

# فحص جاهزية الخادم والاتصال بقاعدة البيانات (Readiness):
# Invoke-RestMethod http://localhost:8000/api/v1/ready
```

### 5. تشغيل واجهة المستخدم (Web)

```powershell
# في نافذة PowerShell جديدة:
cd apps/web
npm install
npm run dev
# المتصفح: http://localhost:5173
```

### 6. تشغيل فحوصات الـ API الآلية

```powershell
cd apps/api
pytest tests/ -v
```

### 7. إيقاف البيئة المحلية

```powershell
# إيقاف حاوية قاعدة البيانات بعد انتهاء العمل:
docker compose -f infra/compose.dev.yml down
```

---

## القرارات المفتوحة

قبل تنفيذ أي وحدة عمل (مخزون · إنتاج · رواتب · صلاحيات)، راجع:

- [`docs/OPEN_DECISIONS_AR.md`](docs/OPEN_DECISIONS_AR.md) — سجل القرارات التي ينبغي أن يعتمدها المصنع
- [`docs/PRODUCT_REQUIREMENTS_AR.md`](docs/PRODUCT_REQUIREMENTS_AR.md) — النطاق والمواصفات

---

## تعليمات المساهمة

- لا تعمل مباشرة على `main`. استخدم فرع قصير لكل مهمة.
- لا ترفع ملف `.env` أو مفاتيح سرية إلى Git.
- راجع [`AGENTS.md`](AGENTS.md) لقواعد العمل مع Antigravity.
