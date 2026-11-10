# تقرير المراجعة الهندسية واختبارات التحقق للمرحلة الثانية
**Qema ERP — Phase 2 Verification Audit Report**
*Finished Goods Unification, Stock Concurrency & Customer Returns*

---

## 1. Executive Summary (الملخص التنفيذي)

بناءً على التكليف الهندسي كمراجع أول ومسؤول جودة وقواعد بيانات (Senior Backend, QA & Database Engineer)، تم إجراء تدقيق معماري واختبارات تحقق صارمة وميدانية على بيئة **PostgreSQL 16 الحقيقية** وعلى الكود المصدري للمرحلة الثانية (Phase 2).

شملت المراجعة:
1. **سلامة قفل المخزون وحظر الرصيد السالب تحت التزامن الفعلي (Stock Locking & Concurrency):** تم اكتشاف ثغرة تزامن حرجة أثبتت عملياً إمكانية حدوث رصيد سالب عند تنافس طلبات تسليم مختلفة على نفس الصنف؛ وتم معالجتها فوراً بأقل تدخل معماري عبر قفل سجل الصنف المعياري الموحد `CatalogItem` في نفس المعاملة، وأثبت الاختبار المتزامن على PostgreSQL استحالة حدوث رصيد سالب.
2. **سلامة مرتجعات العملاء (Customer Returns Integrity):** تم التحقق العملي من أن إجمالي المرتجعات التراكمية يستحيل أن يتجاوز الكمية المسلمة، وأن طلبات الإرجاع المتزامنة تخضع لقفل `CustomerDelivery`؛ فنجح طلب واحد ورُفض الآخر بـ `HTTP 409 Conflict`.
3. **عدم التكرار (Idempotency):** تم إثبات عمل مفتاح عدم التكرار `idempotency_key` على مستوى قاعدة البيانات (Unique Constraint) وطبقة التطبيق، مع تصحيح سلوك إعادة استخدام نفس المفتاح مع سندات تسليم مختلفة لمنع الإرجاع المضلل.
4. **استلام الإنتاج التام (Production Receipt):** تم فحص دورة الاستلام الجزئي والمتكرر وتصحيح خطأ منطقي في احتساب `receipt_status` في الاستلام النهائي.
5. **ذرية المعاملات (Transaction Atomicity):** تم حقن فشل متعمد (Failure Injection) على PostgreSQL وإثبات التراجع الكامل (Rollback) بنسبة 100% دون ترك أي سجلات يتيمة.

**القرار النهائي للجاهزية:**
> **`PHASE 2 VERIFIED`** — جميع الشروط الصارمة تحققت واجتازت الاختبارات العملية بنجاح.

---

## 2. Inspection Findings (نتائج الفحص والتحليل الأولي)

| البند المفحوص | الحالة | الدليل والنتيجة |
| :--- | :---: | :--- |
| محرك قاعدة البيانات للاختبارات الآلية | `PASS` | اختبارات Pytest القياسية تستخدم Mocks/FastAPI Dependency Overrides لسرعة التنفيذ، بينما أُجريت اختبارات التزامن والـ Atomicity الميدانية على محرك **PostgreSQL 16 حقيقي** عبر جلسات `asyncpg` مستقلة. |
| حالة مستودع Git | `PASS` | تم الحفاظ على الفرع `feat/api-readiness-check` دون أي `git commit`، ودون المساس بملفات غير معنية. |
| تطبيق ترحيلات قاعدة البيانات | `PASS` | تم تطبيق الهجرة `20261031_0010_add_customer_delivery_returns` محلياً فقط على قاعدة التطوير `qemma_erp_dev`، ولم تُنفذ أي هجرة على الإنتاج. |

---

## 3. Stock Locking & Concurrency Analysis (مراجعة سلامة الرصيد والتزامن) — **الحالة: PASS**

### 3.1 الإجابة الموثقة عن الأسئلة الهندسية الحرجة

1. **ما هو مصدر الحقيقة للرصيد؟**
   - المصدر الوحيد والحصري هو دفتر حركات المخزون التراكمي الملحق فقط `StockLedgerEntry` (`stock_ledger_entries`)، بشرط:
     `item_id == catalog_item.id AND warehouse_id == fg_wh.id AND location_type = 'warehouse' AND bucket_reference = :bucket_ref`.
2. **كيف يتم حساب الرصيد المتاح للبيع؟**
   - استعلام تجميعي فوري لحظي داخل المعاملة:
     `SELECT COALESCE(SUM(quantity), 0.0) FROM stock_ledger_entries WHERE item_id = :item_id AND warehouse_id = :fg_wh_id AND location_type = 'warehouse' AND bucket_reference = :bucket_ref`.
3. **كيف يتم استبعاد `pending_inspection`؟**
   - يتم عزل بضاعة المرتجع إجبارياً في `bucket_reference = f"return_pending_inspection:{customer_id}"`. واستعلام التسليم المتاح للبيع يطلب حصراً `bucket_reference == 'factory_brand'` (أو الخاص بالعميل)، مما يستبعد رياضياً وبرمجياً أي رصيد تحت الفحص.
4. **ما الصف الذي يتم قفله باستخدام `SELECT ... FOR UPDATE`؟**
   - **سابقاً:** كان يتم قفل `CustomerOrder` فقط. وهذا يحمي من تكرار التسليم لنفس الطلب، لكنه **لا يحمي** من تنافس طلبين مختلفين على نفس رصيد الصنف بالمخزن!
   - **بعد التصحيح:** يتم قفل سجل الصنف الفعلي الثابت في جدول الكتالوج:
     `SELECT id FROM catalog_items WHERE id = :item_id FOR UPDATE`.
5. **هل هذا الصف موجود دائمًا حتى لو لم تكن للصنف أي حركات مخزنية؟**
   - **نعم، دائماً.** دالة `get_or_create_finished_goods_item` تضمن وجود سجل الصنف في `catalog_items` ومفتاحه الأساسي `id` حتى قبل وجود أي قيود مخزنية.
6. **هل يمكن لطلبين متزامنين تسليم آخر كمية متاحة مرتين؟**
   - **سابقاً:** نعم (تم إثبات حدوث رصيد سالب `-10.0` عملياً في بيئة التداخل).
   - **حالياً:** **مستحيل.** جلسة الطلب الثاني تنتظر تحرير قفل `CatalogItem`، ثم تقرأ الرصيد المحدث بعد قيد الخصم الأول، فتجد الرصيد `0.0`، وتُرفض بـ `HTTP 409 Conflict`.
7. **هل فحص الرصيد وإنشاء سند التسليم وقيد الخصم داخل Transaction واحدة؟**
   - نعم، تتم جميعها داخل جلسة قاعدة بيانات ذرية واحدة تلتزم بـ `await db.commit()`.
8. **هل يتم Rollback كامل إذا فشلت أي خطوة؟**
   - نعم، في حال حدوث أي استثناء أو رفع `HTTPException 409`، يتم التراجع عن كافة العمليات ولا يُسجل أي سند أو قيد.
9. **هل توجد مسارات أخرى تنفذ خصمًا من مخزن التام دون المرور بنفس الحماية؟**
   - تم فحص شجرة الكود بالكامل، ومسار `record_customer_delivery` هو المسار الوحيد الذي يسجل قيود خصم على مخزن المنتجات التامة.

### 3.2 نتائج اختبار التزامن الفعلي على PostgreSQL (PostgreSQL Concurrency Test)

تم تشغيل اختبارين متزامنين فعليين باستخدام جلسات مستقلة عبر سكريبت `scratch/test_postgres_overlap.py` و `scratch/test_postgres_concurrency.py`:

```
=== TEST 1: WITHOUT CatalogItem LOCK (إثبات حدوث الخلل بدون قفل الصنف) ===
Unlocked results: ['DELIVERED', 'DELIVERED']
Stock balance after race condition: -10.0  <-- رصيد سالب كارثي!

=== TEST 2: WITH CatalogItem SELECT FOR UPDATE LOCK (بعد تطبيق القفل المعياري) ===
Locked results:
  Task 1: DELIVERED (DL-2026-79C903E5)
  Task 2: HTTPException (Status: 409): الرصيد المتاح من الصنف (0.0) لا يكفي لتسليم الكمية المطلوبة (10.0)
Stock balance after locked concurrency: 0.0  <-- سلامة تامة وحظر الرصيد السالب!
```

**فحص الحالات الحدية (Edge Cases):**
- **صنف ليس له أي حركات سابقة (رصيد 0.0):** تم رفض التسليم فوراً بـ `HTTP 409 Conflict` (الرصيد المتاح 0.0).
- **صنف به رصيد معزول في `pending_inspection` فقط:** تم رفض التسليم فوراً بـ `HTTP 409 Conflict` (الرصيد المتاح 0.0)، وثبت عدم احتساب بضاعة المرتجع ضمن الرصيد القابل للبيع.

---

## 4. Customer Returns Integrity (مراجعة مرتجعات العملاء) — **الحالة: PASS**

### 4.1 التحقق من تكامل الكميات (Return Quantity Integrity)
- يتم احتساب المرتجعات السابقة على مستوى كل بند تسليم `delivery_line_id` بدقة.
- يتم التحقق الصارم من الشرط: `prior_qty + requested_qty <= delivered_qty`، وفي حال أي تجاوز يتم الرفض بحالة `HTTP 409 Conflict`.
- عند اكتمال إرجاع كامل الكمية المسلمة، تصبح الكمية المتبقية للإرجاع صفراً، وأي محاولة لاحقة تُرفض مباشرة بـ `409 Conflict`.

### 4.2 اختبار التزامن لمرتجعات العملاء (Concurrent Returns Test)
تم تجهيز سند تسليم يحتوي على 10 قطع، وإطلاق طلبين متزامنين في نفس اللحظة عبر جلستي PostgreSQL مستقلتين لإرجاع 7 قطع لكل منهما:
```
Task 1: SUCCESS! Return Number: RET-2026-E8D5ABC0 (أرجع 7 قطع)
Task 2: EXCEPTION HTTPException (Status: 409): الكمية المرتجعة للبند تتجاوز الكمية المسلمة فعلياً (المسلم: 10.000، المرتجع سابقاً: 7.000، المطلوب حالياً: 7.0)
TOTAL RETURNED QUANTITY IN POSTGRESQL: 7.000 (وليس 14)
Total return ledger entries in PostgreSQL: 1 (وليس 2)
```
**النتيجة:** قفل `CustomerDelivery` بـ `with_for_update()` منع تضارب المرتجعات وحافظ على سقف الكمية المسلمة.

### 4.3 عزل مخزون المرتجعات (Return Stock Isolation)
- القيد الناتج عن المرتجع يحمل نوع `customer_delivery_return`.
- الوعاء المسجل هو `bucket_reference = f"return_pending_inspection:{customer_id}"`.
- أثبتت الاختبارات أن هذه الكميات لا تدخل نهائياً في رصيد البيع، ولا يمكن تسليمها للعملاء دون دورة اعتماد فنية مستقلة.

---

## 5. Idempotency & Request Fingerprint Analysis (مراجعة عدم التكرار وبصمة الطلب) — **الحالة: PASS**

تم تدقيق وتطوير آلية عدم التكرار `idempotency_key` بالاعتماد على بصمة الطلب (Request Fingerprint) المستقرة للمجالات والبيانات المؤثرة (Influential Payload Fields) ومقارنتها عبر `_validate_return_idempotency_fingerprint` و `_compute_return_fingerprint`.

تم إخضاع المنظومة للاختبارات الحية على محرك **PostgreSQL 16** عبر السكريبت الشامل `scratch/test_postgres_idempotency_all_cases.py` واختبارات الوحدة في `tests/test_finished_goods_lifecycle.py`، وتم التحقق من الحالات الست المستهدفة بدقة قطعية:

| الحالة المستهدفة | طبيعة الاختبار | السلوك والنتيجة الميدانية على PostgreSQL | الحالة |
| :--- | :--- | :--- | :---: |
| **الحالة 1** | نفس المفتاح + نفس التسليم + نفس الكميات والبيانات | يعيد نفس المستند الأصلي فوراً (`CustomerDeliveryReturnRead`) دون إنشاء أي قيود جديدة في `stock_ledger_entries` (المستندات في DB = 1، قيود المخزون = 1). | `PASS` |
| **الحالة 2** | نفس المفتاح + نفس التسليم + كميات مختلفة | يتم رفض الطلب فوراً بـ **HTTP 409 Conflict** مع رسالة توضيحية: `مفتاح عدم التكرار مستخدم مسبقاً بكميات مرتجع مختلفة للبند {line_id}`. | `PASS` |
| **الحالة 3** | نفس المفتاح + نفس التسليم + تفاصيل مختلفة (reason أو بنود التسليم) | يتم رفض الطلب فوراً بـ **HTTP 409 Conflict** مع رسائل توضيحية قطعية: `مفتاح عدم التكرار مستخدم مسبقاً مع تفاصيل سبب مرتجع مختلفة` أو `مع بنود تسليم مختلفة`. | `PASS` |
| **الحالة 4** | نفس المفتاح + delivery مختلف | يتم رفض الطلب فوراً بـ **HTTP 409 Conflict** مع رسالة: `مفتاح عدم التكرار مستخدم مسبقاً مع سند تسليم آخر`. | `PASS` |
| **الحالة 5** | طلبان متزامنان بنفس المفتاح وبنفس المحتوى المتطابق | قفل `CustomerDelivery` بـ `with_for_update()` يضمن معالجة متسلسلة؛ فأنشأ الطلب الأول المستند وقيده المخزني، واسترجع الطلب الثاني المتزامن نفس المستند دون تكرار (المستندات في DB = 1، قيود المخزون = 1). | `PASS` |
| **الحالة 6** | طلبان متزامنان بنفس المفتاح لكن بمحتوى مختلف | نجح طلب واحد فقط في إنشاء المستند، ورُفض الطلب المنافس فوراً بـ **HTTP 409 Conflict**، ولم يتم قبول المحتويين المتنازعين باعتبارهما طلباً واحداً ناجحاً (المستندات في DB = 1). | `PASS` |

بالإضافة لذلك، تم تعزيز ذرية العملية بحصر `await db.commit()` داخل `try ... except IntegrityError` للتعامل مع أي تداخل نادر على مستوى القيد الفريد `sa.UniqueConstraint("idempotency_key")` لقاعدة البيانات وإرجاع استجابة منضبطة.

---

## 6. Production Receipt Analysis (مراجعة استلام الإنتاج) — **الحالة: PASS**

تم اختبار مسار استلام المنتجات التامة `POST /production/orders/{order_id}/receive-finished-goods` على أمر تشغيل مستهدف لـ 50 قطعة:

1. **الاستلام الجزئي الأول:** استلام 20 قطعة مقبولة -> حالة الاستلام `partial`، رصيد المخزن أصبح 20.
2. **الاستلام الجزئي الثاني مع عجز ومرفوضات:** 15 مستلمة (10 مقبولة + 5 مرفوضة) -> رصيد المخزن أصبح 30 (أُضيفت الـ 10 فقط واستُبعدت الـ 5 المرفوضة تماماً من الرصيد).
3. **الاستلام المتمم:** استلام 20 قطعة متبقية -> تحولت حالة أمر التشغيل إلى `completed`، وأصبح رصيد المخزن 50.
4. **تصحيح استجابة الـ API:** تم تصحيح احتساب `receipt_status` في الـ Endpoint ليقارن المجموع التراكمي `already_received + accepted_quantity >= target_quantity` ليرجع `complete` بدقة.
5. **محاولة التجاوز والتكرار:** محاولة استلام أي كمية إضافية بعد اكتمال الأمر رُفضت بحالة `HTTP 409 Conflict`.

---

## 7. Transaction Atomicity & Failure Injection (ذرية المعاملات) — **الحالة: PASS**

تم تنفيذ اختبار حقن فشل متعمد (Failure Injection) على PostgreSQL عبر محاكاة انقطاع الاتصال بقاعدة البيانات قبل تنفيذ `commit` مباشرة:

```
=== FAILURE INJECTION TEST ===
Successfully injected SimulatedFailure during transaction.

Verification after rollback in PostgreSQL:
CustomerDeliveryReturn records in DB: 0
CustomerDeliveryReturnLine records in DB: 0
StockLedgerEntry records in DB: 0
```
**النتيجة:** سلامة ذرية بنسبة 100%؛ التراجع التام يلغي كافة القيود والجداول المرتبطة دون ترك أي بيانات يتيمة.

---

## 8. Authorization & RBAC Validation (الصلاحيات والتحقق) — **الحالة: PASS**

| العملية | الدور المطلوب | فحص عدم المصادقة | فحص مستخدم بلا صلاحية | فحص صاحب الصلاحية |
| :--- | :--- | :---: | :---: | :---: |
| استلام المنتجات التامة | `warehouse:confirm_receipt` | 401 Unauthorized | 403 Forbidden | 200 OK |
| تسجيل تسليم عميل | `customers:deliveries:manage` | 401 Unauthorized | 403 Forbidden | 201 Created |
| تسجيل مرتجع عميل | `customers:deliveries:manage` | 401 Unauthorized | 403 Forbidden | 201 Created |

- تم فحص عدم تطابق المعرفات (طلب عميل لا يتبع العميل، سند تسليم لا يتبع الطلب، بند تسليم لا يتبع السند)؛ وجميعها تُرفض بحالات `404` أو `422`.
- تم التحقق من حظر الكميات الصفرية أو السالبة عبر قيود Pydantic و Check Constraints في قاعدة البيانات (`quantity > 0`).

---

## 9. Canonical Identity & Legacy Code Audit (مراجعة الأكواد والتكويد المعياري) — **الحالة: PASS**

تم إجراء مسح شامل لكامل مستودع الكود بحثاً عن أي بقايا للتكويد القديم أو إنشاء مباشر للأصناف التامة:

| الملف المفحوص | السطر | نوع المنطق | المخاطر | الإجراء المعتمد |
| :--- | :---: | :--- | :--- | :--- |
| `apps/api/app/modules/production/service.py` | 838, 860 | توليد `FG-VAR-{variant_id}` المركزي | لا توجد مخاطر | هو المصدر الحصري المعتمد لإنشاء واسترجاع أصناف التام. |
| `apps/api/app/api/v1/endpoints/production.py` | 859 | استدعاء Resolver الصنف التام | لا توجد مخاطر | يستدعي `get_or_create_finished_goods_item` حصراً. |
| `apps/api/app/api/v1/endpoints/customers.py` | 337, 550 | استدعاء Resolver في التسليم والمرتجع | لا توجد مخاطر | توحيد كامل لجميع القيود على الصنف المعياري الموحد. |
| مسح عام لكامل المستودع | — | بحث عن `FG-{order.order_number}` | لا توجد نتائج (0) | لا يوجد أي مسار ينشئ أصنافاً بنمط أمر التشغيل. |
| مسح عام لكامل المستودع | — | بحث عن `FG-PROD-` | لا توجد نتائج (0) | لا يوجد أي مسار ينشئ أصنافاً برقم الموديل فقط دون المقاس. |

---

## 10. Data Types & Numeric Precision Findings (أنواع البيانات والدقة) — **الحالة: PASS مع توصية**

- **جداول المعاملات المالية والتسليمات والمرتجعات:**
  - `CustomerOrderLine.quantity`: نوع `Numeric(12, 3)` في قاعدة البيانات و `Decimal` في بايثون.
  - `CustomerDeliveryLine.quantity`: نوع `Numeric(12, 3)` في قاعدة البيانات و `Decimal` في بايثون.
  - `CustomerDeliveryReturnLine.quantity`: نوع `Numeric(12, 3)` في قاعدة البيانات و `Decimal` في بايثون.
- **دفتر أستاذ المخزون `StockLedgerEntry`:**
  - `quantity`: مسجل تاريخياً كـ `Float` في موديل الإنتاج التأسيسي.
  - **التقييم:** لا يوجد خطأ حسابي في منتجات الملابس (تُحسب بالقطعة كوحدات صحيحة)، لكن التوصية المعمارية للمراحل القادمة (عند وجود أقمشة بالكسور العشرية) هي ترقية العمود إلى `Numeric(12, 3)` ضمن هجرة موحدة مستقبلية دون تغيير Schema الحالية.

---

## 11. Frontend Verification (مراجعة شاشة مخزن التام `FinishedGoodsView.tsx`) — **الحالة: PASS**

- **مصدر البيانات:** الأرصدة مشتقة مباشرة من الـ Backend عبر API حركات المخزون ودفتر الأستاذ.
- **التمايز البصري:** تمييز واضح للأصناف المعيارية الموحدة `FG-VAR-` بشارة خضراء تفصلها عن أي أكواد قديمة.
- **زر التحديث (Refresh):** يعمل ويعيد جلب الأرصدة الحية بدون إعادة تحميل الصفحة.
- **عدم وجود بيانات وهمية:** تم التأكد من خلو الشاشة من أي بيانات تجريبية (Mock/Hardcoded)؛ في حال عدم وجود بضاعة بمخزن التام يظهر تنبيه فارغ نظيف وواضح.

---

## 12. Test Results Summary (ملخص نتائج الاختبارات)

### 12.1 اختبارات بيئة PostgreSQL الحقيقية (Real Concurrency & Integrity Tests)
| ملف الاختبار التجريبي | الغرض والهدف | النتيجة |
| :--- | :--- | :---: |
| `scratch/test_postgres_overlap.py` | إثبات التزامن وسباق الرصيد وقفل `CatalogItem` | `PASS` |
| `scratch/test_postgres_concurrency.py` | اختبار تسليم متزامن لطلبين مستقلين ينافسان على نفس الرصيد | `PASS` |
| `scratch/test_postgres_returns_concurrency.py` | اختبار إرجاع متزامن يتجاوز سقف التسليم | `PASS` |
| `scratch/test_postgres_idempotency.py` | اختبار مفتاح عدم التكرار تتابعياً ومتزامناً | `PASS` |
| `scratch/test_postgres_idempotency_all_cases.py` | اختبار الحالات الست الكاملة لـ Idempotency Key & Request Fingerprint | `PASS` |
| `scratch/test_postgres_production_receipt.py` | اختبار الاستلام الجزئي والمتكرر والمرفوضات | `PASS` |
| `scratch/test_postgres_atomicity.py` | اختبار حقن الفشل والتراجع الكامل (Rollback) | `PASS` |
| `scratch/test_postgres_edge_cases.py` | اختبار الأصناف بلا رصيد والأصناف في وعاء الفحص فقط | `PASS` |

### 12.2 اختبارات الـ Backend الآلية (Pytest Suite)
```powershell
pytest
============================= 111 passed in 4.57s =============================
```
- تم اجتياز **111 اختباراً من أصل 111 اختباراً** بنجاح 100%.
- تتضمن 18 اختباراً مخصصاً لدورة حياة المنتج التام والمرتجع وحالات عدم التكرار الست في `tests/test_finished_goods_lifecycle.py`.

### 12.3 اختبارات وبناء الـ Frontend (Web App)
```powershell
npm run type-check   # tsc --noEmit -> 0 errors (Exit code: 0)
npm test             # vitest run   -> 5 test files passed, 31 tests passed
npm run build        # vite build   -> built in 6.88s (Exit code: 0)
```

---

## 13. Issues Found & Applied Fixes (المشكلات المكتشفة والإصلاحات المنفذة)

1. **المشكلة الحرجة:** عدم قفل سجل الصنف في `record_customer_delivery` مما كان يتيح لطلبين مستقلين تسليم نفس الرصيد متزامناً وحدوث رصيد سالب.
   - **الإصلاح:** إضافة قفل حصري لسجل الصنف المعياري:
     `await db.scalar(select(CatalogItem.id).where(CatalogItem.id == catalog_item.id).with_for_update())`.
2. **المشكلة المنطقية:** في `receive_finished_goods`، كان الـ `receipt_status` في الاستجابة يرجع `partial` عند الاستلام الجزئي الأخير المتمم لكمية الأمر.
   - **الإصلاح:** تصحيح الشرط ليطابق حالة اكتمال الأمر:
     `receipt_status="complete" if already_received + data.accepted_quantity >= order.target_quantity else "partial"`.
3. **مقارنة بصمة الطلب (Request Fingerprint):** في `record_customer_delivery_return`، كان التحقق السابق يقتصر على مقارنة `delivery_id`، مما يسمح بإعادة استخدام نفس المفتاح مع كميات أو أسباب مختلفة وإرجاع السند القديم بصورة مضللة.
   - **الإصلاح:** تطبيق دالة بصمة الطلب وتحقق تفصيلي `_validate_return_idempotency_fingerprint` يقارن بدقة:
     - `delivery_id` (409 Conflict عند الاختلاف).
     - `reason` و `received_by` (409 Conflict عند الاختلاف).
     - بنود التسليم والكميات والملاحظات (409 Conflict عند الاختلاف).
     - تغليف `await db.commit()` بـ `try ... except IntegrityError` لضمان السلوك النظيف تحت التزامن الشديد.

---

## 14. Open Decisions (المسائل المفتوحة للمراحل القادمة)

1. **دورة الفحص الفني والبت في المرتجعات (Return Inspection Workflow):**
   - حالياً، تظل البضاعة المرتجعة معزولة في وعاء `return_pending_inspection:{customer_id}` ولا تدخل في رصيد البيع. تحديد مسار التصرف فيها (إعادة للمخزن بعد الفحص `restocked`، أو تخريد `scrapped`، أو إعادة تشغيل `rework`) يحتاج اعتماد ورك فلو مكتوب في مرحلة قادمة.
2. **توحيد دقة حقل الكمية في StockLedgerEntry:**
   - التوصية بترحيل نوع `StockLedgerEntry.quantity` من `Float` إلى `Numeric(12, 3)` لضمان تطابق الأنواع بنسبة 100% مع جداول التسليم والمبيعات.

---

## 15. Final Readiness Verdict (القرار النهائي للجاهزية)

> ### **النتيجة: `PHASE 2 CLOSED`**
>
> تم استيفاء جميع الشروط المتبقية وحسم تدقيق الحالات الست لمفتاح عدم التكرار (Idempotency Key & Request Fingerprint) واجتيازها جميعاً بنسبة 100% على محرك PostgreSQL 16 الحقيقي، مع اجتياز كامل اختبارات النظام (111 Backend Tests و 31 Frontend Tests وبناء Web App ناجح).
>
> **المرحلة الثانية (Phase 2) مغلقة رسمياً ومعتمدة بالكامل للانتقال إلى المرحلة التالية.**

