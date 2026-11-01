# نقطة استئناف المشروع الهندسية (Project Resume Checkpoint)
## Qema ERP — Engineering Handover & Resume Guide

**تاريخ الإعداد والاعتماد:** 1 نوفمبر 2026  
**المشروع:** نظام ERP مصنع القمة للملابس (Qema ERP)  
**الحالة الحالية:** إغلاق وتوثيق Phase 3.5 بالكامل بعد استيفاء إصلاحات الإغلاق النهائية (Final Closure Fixes)  
**المرحلة المكتملة:** **Phase 3.5 — Factory-Owned Catalog Governance** تحت القرار المعماري: `PHASE 3.5 CLOSED & FULLY VERIFIED`

---

## 1. أين وصلنا بالضبط؟ (Where We Are Exactly)

وصل مشروع **Qema ERP** إلى حالة إغلاق هندسي متكامل ومحكم لحوكمة دليل الأصناف:
- **البنية الأساسية لقاعدة البيانات (Database Schema):** مستقرة ومحدثة إلى **Migration 0013** (`20261101_0013`):
  - قيد قاعدة بيانات مصحح وصارم: `ck_catalog_items_active_consistency` = `NOT is_active OR approval_status = 'approved'`.
  - الأصناف غير المعتمدة (`draft`, `pending_review`, `rejected`) لا يمكن تفعيلها إطلاقاً (`is_active = FALSE`).
  - فقط الأصناف المعتمدة (`approved`) يمكن تفعيلها أو تعطيلها.
  - إضافة عمود `item_name_snapshot` (VARCHAR 128) إلى جدول `production_order_materials` لحماية وثائق الإنتاج التاريخية وتجميد مسميات الخامات وقت صدور الأمر.
  - إدراج أحداث تدقيق توضيحية بنوع `legacy_clarification` في جدول `catalog_approval_history` للأصناف التاريخية الـ 7.
- **حوكمة تعديل الأصناف وحماية الوثائق التاريخية:**
  - حظر التعديل المباشر على الأصناف المعتمدة وإلزام مسار طلبات التعديل (`catalog_item_revisions`).
  - حظر تعديل الاسم بالعربية (`name_ar`) عبر طلبات التعديل لأي صنف ارتبط بمعاملات تاريخية (`stock_ledger_entries`, `production_order_materials`, `supplier_invoice_lines`) مع إرجاع `409 Conflict` لحماية الوثائق التاريخية من التشويه بأثر رجعي.
  - منع تعدد طلبات التعديل المفتوحة لنفس الصنف عبر فهرس فريد جزئي (`uq_catalog_item_single_open_revision`).
  - حماية سجل التدقيق التاريخي من أي تعديل أو مسح نهائياً عبر Trigger PostgreSQL.
  - حظر الاعتماد الذاتي (Anti-Self-Approval) برمجياً على كافة المستويات.
- **الاعتماد التشغيلي الانتقالي (Legacy Grandfathering):**
  - الأصناف التاريخية الـ 7 (`LED_*`) معتمدة تشغيلياً فقط لضمان استمرارية المخزون وعدم تعطيل العمليات الجارية.
  - تظل مواصفاتها الفنية وتصنيفها النهائي بحالة `needs_review` مع `approved_by = NULL`.
  - تعرض واجهة المستخدم تحذيراً توضيحياً بصفة الاعتماد الانتقالي، ومراجعة مواصفاتها مسجلة كقرار مفتوح قيد الدراسة في `docs/OPEN_DECISIONS_AR.md`.
- **دليل أصناف الورشة (Workshop Materials):**
  - مسودة الـ 58 صنفاً محفوظة وجاهزة في `docs/WORKSHOP_MATERIALS_MASTER_DRAFT_AR.md` و`docs/workshop_materials_preview.csv`.
  - **حظر الاستيراد التلقائي تام ومستمر:** لم يتم استيراد أي صنف منها لقاعدة البيانات بانتظار استعراضها وتدقيقها خطوة بخطوة عبر شاشات النظام بواسطة فريق المصنع.

---

## 2. ما آخر مرحلة مكتملة؟ (Last Completed Phase)

> **المرحلة المكتملة والمغلقة رسمياً هي:**  
> **Phase 3.5 — Factory-Owned Catalog Governance (مع Migration 0013 والإصلاحات النهائية)**  
> تحت القرار الهندسي الرسمي:  
> **`PHASE 3.5 CLOSED & FULLY VERIFIED WITH DOCUMENTED LIMITATIONS`**

---

## 3. ما الذي يجب قراءته قبل استئناف العمل في الجلسة القادمة؟

عند العودة إلى المشروع، يجب على المطور قراءة المستندات التالية بالترتيب:

1. [docs/PROJECT_RESUME_CHECKPOINT_AR.md](file:///d:/Qema%20Project/docs/PROJECT_RESUME_CHECKPOINT_AR.md) *(هذه الوثيقة — لفهم الموقف الهندسي الحالي).*
2. [docs/DATA_MODEL.md](file:///d:/Qema%20Project/docs/DATA_MODEL.md) *(مخطط البيانات المحدث بعد Migration 0013).*
3. [docs/OPEN_DECISIONS_AR.md](file:///d:/Qema%20Project/docs/OPEN_DECISIONS_AR.md) *(سجل القرارات المفتوحة وموقف بنود الورشة والأصناف التاريخية).*
4. [docs/PHASE_3_5_COMPLETION_REPORT_AR.md](file:///d:/Qema%20Project/docs/PHASE_3_5_COMPLETION_REPORT_AR.md) *(تقرير إنجاز وحوكمة المرحلة 3.5).*
5. [docs/WORKSHOP_MATERIALS_REVIEW_QUESTIONS_AR.md](file:///d:/Qema%20Project/docs/WORKSHOP_MATERIALS_REVIEW_QUESTIONS_AR.md) *(أسئلة المصنع الميدانية).*

---

## 4. ما أول مهمة محددة عند العودة؟ (First Action Upon Return)

> [!IMPORTANT]
> **نقطة البداية للجلسة القادمة هي أحد مسارين بحسب قرار إدارة المصنع:**
> 1. **المسار التشغيلي:** البدء في مراجعة وتدقيق وإدخال أصناف الورشة الـ 58 صنفاً عبر واجهة المستخدم بملكية المصنع (Catalog UI)، واستيفاء إجابات أسئلة الاستقصاء الـ 18.
> 2. **المسار البرمجي:** البدء في التخطيط والتصميم المعماري للمرحلة القادمة: **Phase 4 — مشتريات الموردين وحركات المخزن المتقدمة (Purchasing & Warehouse Inbound/Outbound Operations)**.

---

## 5. ما الذي يجب عدم لمسه حالياً؟ (Strict "DO NOT TOUCH" Zones)

للحفاظ على استقرار النظام وحماية المشروع، يُحظر العبث بالعناصر التالية:
- ❌ **لا تستورد الأصناف الـ 58 إلى قاعدة البيانات** بأي سكربت آلي عشوائي؛ الإدخال يتم بملكية المصنع عبر واجهة النظام.
- ❌ **لا تعدل أكواد المنتجات التامة `FG-VAR-*`** أو تخلط بينها وبين أكواد خامات ومستلزمات الإنتاج.
- ❌ **لا تغير في أرصدة المخازن أو تنشئ حركات مخزنية** وهمية في `stock_ledger_entries`.
- ❌ **لا تخترع أي تحويل تلقائي بين وحدات القياس** دون موافقة معتمدة.
- ❌ **لا تنفذ أي `git commit` أو `git push`** إلى المستودع البعيد.
- ❌ **لا تنفذ ترحيلات Migrations على بيئة الإنتاج** دون موافقة كتابية صريحة.

---

## 6. أوامر الفحص والتشغيل المتحقق منها عملياً (Verified Commands)

كافة حزم الاختبارات الآلية المستهدفة نجحت بنسبة 100%:

### أ. اختبارات حوكمة دليل الأصناف (Governance Tests):
```powershell
Set-Location 'd:\Qema Project'
.\apps\api\.venv\Scripts\pytest.exe apps/api/tests/test_catalog_governance.py -v
# النتيجة المتحققة: 8 passed in 6.43s (100% Passed)
```

### ب. اختبارات واجهات دليل الأصناف (Catalog APIs):
```powershell
Set-Location 'd:\Qema Project'
.\apps\api\.venv\Scripts\pytest.exe apps/api/tests/test_catalog_api.py -v
# النتيجة المتحققة: 11 passed in 5.68s (100% Passed)
```

### ج. اختبارات واجهة المستخدم (Catalog Frontend Vitest):
```powershell
Set-Location 'd:\Qema Project\apps\web'
npm run test -- src/features/catalog/catalog.test.tsx --run
# النتيجة المتحققة: 7 passed in 2.03s (100% Passed)
```

---

## 7. ملخص حالة فروع Git والملفات غير المتتبعة (Git Status Snapshot)

- **الفرع الحالي:** `feat/api-readiness-check`
- **حالة قاعدة البيانات:** Alembic Version `20261101_0013` (Migrations 0011, 0012, 0013 مطبقة بالكامل).
- **ملفات التوثيق المركزية:** محدثة ومتطابقة (`docs/DATA_MODEL.md`, `docs/OPEN_DECISIONS_AR.md`, `docs/PROJECT_RESUME_CHECKPOINT_AR.md`).
- **لا توجد أي تغييرات غير موثقة أو مفقودة.**
