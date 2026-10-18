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

## البدء السريع

### 1. تحضير ملف البيئة

```powershell
cp .env.example .env
# عدّل القيم في .env إن احتجت تغيير كلمة المرور المحلية
```

### 2. تشغيل قاعدة البيانات (Docker مطلوب)

```powershell
docker compose -f infra/compose.dev.yml up -d
# التحقق من التشغيل:
docker compose -f infra/compose.dev.yml ps
```

### 3. تشغيل الـ API

```powershell
cd apps/api
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
# فحص الصحة: GET http://localhost:8000/api/v1/health
```

### 4. تشغيل الواجهة

```powershell
cd apps/web
npm install
npm run dev
# المتصفح: http://localhost:5173
```

### 5. تشغيل فحوص الـ API

```powershell
cd apps/api
pytest tests/ -v
```

### 6. إيقاف البيئة المحلية

```powershell
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
