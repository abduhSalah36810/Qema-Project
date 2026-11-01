# تقرير التحضير والتصميم المعماري للمرحلة 4.2
# Qema ERP — Phase 4.2 Preparation: WIP Lifecycle, Traceability Verification & Factory Readiness

**تاريخ الإنجاز:** 2026-11-01  
**حالة التقرير:** نهائي ومكتمل (Completed & Verified)  
**المرجعية المعمارية:**  
- `docs/PRODUCTION_INVENTORY_TRACEABILITY_REVIEW_AR.md`  
- `docs/WIP_LIFECYCLE_DESIGN_AR.md`  
- `docs/OPEN_DECISIONS_AR.md`  

---

## 1. ما تم فحصه وتدقيقه (Scope of Inspection & Verification)

تم إجراء مراجعة كودية وتشغيلية دقيقة وشاملة للمنظومة الحالية في قاعدة البيانات والكود البرمجي وحزم الاختبارات، وركز الفحص على محورين رئيسيين:

---

### أ. جدول تغطية أقفال الأرصدة المخزنية (Stock Lock Coverage Table)

تم حصر وتدقيق **كافة المسارات والخدمات في النظام التي تُنشئ قيود أستاذ المخزون (`StockLedgerEntry`) أو تؤثر في أرصدة المخازن الثلاثة**:

| اسم العملية التشغيلية | المسار / الدالة البرمجية | المخزن والصنف المتأثران | هل تستخدم `lock_stock_balance`؟ | هل يوجد قفل بديل موثق؟ | حماية إضافية تمنع الرصيد السالب؟ | هل توجد فجوة فعلية؟ |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **صرف خامات أمر التشغيل (Dispatch Materials)** | `POST /production/orders/{id}/dispatch`<br>[`dispatch_order_materials`](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L327) | **مخزن الخامات الرئيسي** (`main_raw_materials`)<br>الصنف: خام/مستلزم<br>الموقع: `in_transit` | **نعم**<br>(أقفال استشارية مرتبة تصاعدياً بـ `item_id`) | نعم، `select(ProductionOrder).with_for_update()` | نعم، فحص رصيد الأستاذ المتاح والمقارنة الصارمة بالكمية المطلوبة والرفض بـ 409 عند النقص. | **لا توجد فجوة**<br>(المسار محصن بالكامل) |
| **تأكيد استلام الخامات بالورشة (Confirm Receipt)** | `POST /production/orders/{id}/receive`<br>[`confirm_warehouse_receipt`](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L448) | **موقع الطريق** (`in_transit`)<br>**مخزن تحت التشغيل** (`work_in_progress`)<br>**موقع الفروقات** (`discrepancy`) | **نعم**<br>(على أصناف مخزن WIP الوجهة) | نعم، `select(WarehouseTransfer).with_for_update()` | الحركة خصم من رصيد الطريق الخاص بهذا السند تحديداً (`bucket_reference = transfer.id`) وإيداع موجب في WIP. | **لا توجد فجوة**<br>(المسار محصن بالكامل) |
| **استلام وتأكيد المنتج التام (Receive Finished Goods)** | `POST /production/orders/{id}/finished-receipt`<br>[`receive_finished_goods`](file:///d:/Qema%20Project/apps/api/app/api/v1/endpoints/production.py#L848) | **مخزن المنتج التام** (`finished_goods`)<br>الصنف: منتج تام معياري `FG-VAR-*` | **نعم**<br>(قفل استشاري للصنف بمخزن التام) | نعم، `select(ProductionOrder).with_for_update()` | العملية إضافة رصيد موجب للمنتج التام، مع التحقق من عدم تجاوز كمية أمر التشغيل المستهدفة. | **لا توجد فجوة**<br>(المسار محصن بالكامل) |
| **تسليم طلبيات العملاء (Customer Delivery)** | `POST /customers/{cid}/orders/{oid}/deliver`<br>[`record_customer_delivery`](file:///d:/Qema%20Project/apps/api/app/api/v1/endpoints/customers.py#L302) | **مخزن المنتج التام** (`finished_goods`)<br>الصنف: منتج تام معياري `FG-VAR-*` | **نعم**<br>(قفل استشاري للصنف بمخزن التام) | نعم، قفل الطلب وقفل سطر الصنف بـ `with_for_update()` | نعم، فحص رصيد السلة الفعلي المتاح والمقارنة الصارمة والرفض الفوري بـ 409 عند عدم الكفاية. | **لا توجد فجوة**<br>(المسار محصن بالكامل) |
| **مرتجع تسليم العميل (Customer Delivery Return)** | `POST /customers/.../deliveries/{id}/return`<br>[`record_customer_delivery_return`](file:///d:/Qema%20Project/apps/api/app/api/v1/endpoints/customers.py#L497) | **مخزن المنتج التام** (`finished_goods`)<br>سلة: `return_pending_inspection` | **لا**<br>(إضافة موجبة لسلة فحص معزولة) | نعم، قفل الطلب وسند التسليم بـ `with_for_update()` | الحركة إضافة موجبة معزولة تحت الفحص؛ والتحقق يمنع تجاوز الكمية المسلمة فعلياً ناقص المرتجع سابقاً. | **لا توجد فجوة**<br>(لا يوجد خطر رصيد سالب) |
| **استلام فاتورة المورد (Supplier Receipt)** | `POST /finance/supplier-invoices/{id}/receive`<br>[`confirm_supplier_receipt`](file:///d:/Qema%20Project/apps/api/app/api/v1/endpoints/finance.py#L200) | **مخزن الخامات الرئيسي** (`main_raw_materials`)<br>الصنف: خامات/مستلزمات | **لا**<br>(إضافة موجبة) | نعم، قفل الفاتورة والأسطر والمخزن بـ `with_for_update()` | الحركة إيداع رصيد موجب بالكامل؛ ومحمية بقفل الفاتورة وانتقال الحالة الصارم `awaiting_receipt -> received`. | **لا توجد فجوة**<br>(لا يوجد خطر رصيد سالب) |

**خلاصة تدقيق الأقفال:**  
كافة المسارات التي تقوم بعمليات **خصم** من رصيد المخزون (صرف خامات الإنتاج، تسليمات منتجات العملاء) تستخدم أقفال `lock_stock_balance` الاستشارية المعاملاتية، مدعومة بأقفال الصفوف `with_for_update()`، ومدعومة بفحص الأرصدة المتاحة قبل الخصم، مما يضمن استحالة وصول الأرصدة لقيم سالبة تحت أي ظروف تزامن.

---

### ب. جدول تغطية منع التكرار (Idempotency Coverage Table)

تم فحص مدى حماية العمليات التشغيلية ضد مخاطر التكرار الناتج عن انقطاع الاتصال أو إعادة المحاولة:

| العملية التشغيلية | آلية منع التكرار المطبقة | الترويسة / الحقل المستخدم | معالجة تكرار نفس المفتاح والبيانات | معالجة نفس المفتاح مع بيانات مختلفة | سلامة المعاملة والبيانات الجزئية |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **صرف خامات الإنتاج (Dispatch)** | **محرك Idempotency الموحد** (`IdempotentRequest`) | Header:<br>`Idempotency-Key` | يعيد نفس النتيجة السابقة بدقة مع منع تكرار قيود الأستاذ | يرفض فوراً بـ `409 Conflict` لاختلاف بصمة الطلب (SHA-256) | ذرية تامة (Atomic)؛ فشل المعاملة يلغي قيد Idempotency ويلغي قيود الأستاذ |
| **استلام خامات الورشة (Workshop Receipt)** | **محرك Idempotency الموحد** (`IdempotentRequest`) | Header:<br>`Idempotency-Key` | يعيد نفس النتيجة السابقة بدقة مع منع تكرار قيود الأستاذ | يرفض فوراً بـ `409 Conflict` لاختلاف بصمة الطلب (SHA-256) | ذرية تامة؛ لا يترك أي قيود يتيمة |
| **استلام المنتج التام (FG Receipt)** | **محرك Idempotency الموحد** (`IdempotentRequest`) | Header:<br>`Idempotency-Key` | يعيد نفس النتيجة السابقة بدقة مع منع تكرار قيود الأستاذ | يرفض فوراً بـ `409 Conflict` لاختلاف بصمة الطلب (SHA-256) | ذرية تامة؛ فحص السقف يمنع تجاوز الكمية المستهدفة |
| **مرتجع تسليم العميل (Delivery Return)** | **تحقق فريد ببصمة الطلب** (`CustomerDeliveryReturn`) | Body:<br>`idempotency_key` | يعيد نفس سند المرتجع السابق بدقة دون تكرار | يرفض فوراً بـ `409 Conflict` مع بيان الحقل المختلف (كمية/سبب/بنود) | ذرية تامة داخل المعاملة |
| **تسليم طلبية العميل (Customer Delivery)** | **انتقال الحالة وقفل السجل** (State Transition & Row Locks) | يعتمد على قفل الطلب ورصيد البنود المتبقي | إذا كرر العميل نفس الطلب، ترفضه المعادلة بـ `409` لأن الكمية المتبقية أصبحت صفراً | يرفض تلقائياً لتجاوز الرصيد المتبقي | ذرية تامة؛ لا تُنشأ قيود تسليم مكررة |
| **استلام فاتورة المورد (Supplier Receipt)** | **انتقال الحالة الصارم** (Strict State Transition) | يعتمد على فحص `invoice.status == 'awaiting_receipt'` | الطلب الثاني يُرفض فوراً بـ `409 Conflict` لأن حالة الفاتورة تحولت إلى `received` | يرفض بـ 409 | ذرية تامة |

---

## 2. ما تم تعديله فعلياً (Actual Modifications)

انطلاقاً من القواعد الإلزامية للمهمة ("لا تنشئ Models أو APIs أو Migrations لمجرد أن التصميم يبدو أكثر احترافية... لا تبدأ تنفيذ WIP Consumption أو Scrap أو Rework في هذه المهمة"):
- **لم يتم تعديل كود الـ Backend أو إنشاء Migrations جديدة** في هذه الجولة، لأن البنية التي تم إنشاؤها وتثبيتها في Phase 4.1 تعمل بنجاح 100%، ولا توجد فجوة أمان تستدعي تدخلاً استباقياً غير معتمد من إدارة المصنع.
- تم حصر التعديلات حصراً في الوثائق المعمارية والتصميمية وتجهيز قرارات المصنع:
  1. إنشاء وثيقة التصميم الشاملة: [`docs/WIP_LIFECYCLE_DESIGN_AR.md`](file:///d:/Qema%20Project/docs/WIP_LIFECYCLE_DESIGN_AR.md).
  2. تحديث سجل القرارات المفتوحة بالقرارات العشرة وقائمة الاستيضاحات: [`docs/OPEN_DECISIONS_AR.md`](file:///d:/Qema%20Project/docs/OPEN_DECISIONS_AR.md).
  3. إعداد تقرير الإغلاق والتحضير الحالي: [`docs/PHASE_4_2_PREPARATION_REPORT_AR.md`](file:///d:/Qema%20Project/docs/PHASE_4_2_PREPARATION_REPORT_AR.md).

---

## 3. نتائج الاختبارات التشغيلية الفعلية (Test Verification Results)

تم التحقق من استقرار النظام عبر تشغيل حزم الاختبارات المرتبطة بحصانة المخزون والتزامن واستلام المنتجات والتقارير على قاعدة `qemma_test_db`:

```text
============================= test session starts =============================
platform win32 -- Python 3.12.1, pytest-9.1.1, pluggy-1.7.0
rootdir: D:\Qema Project\apps\api

apps/api/tests/test_inventory_integrity.py::test_stock_ledger_entries_immutability_rejects_update_and_delete PASSED [  2%]
apps/api/tests/test_inventory_integrity.py::test_idempotency_duplicate_request_returns_cached_and_prevents_duplicate_entries PASSED [  5%]
apps/api/tests/test_inventory_integrity.py::test_idempotency_key_reused_with_different_payload_is_rejected PASSED [  8%]
apps/api/tests/test_inventory_integrity.py::test_concurrent_duplicate_idempotency_requests PASSED [ 11%]
apps/api/tests/test_inventory_integrity.py::test_concurrent_stock_depletion_prevents_negative_balance PASSED [ 14%]
apps/api/tests/test_inventory_integrity.py::test_transaction_rollback_leaves_no_orphaned_ledger_entries PASSED [ 17%]
apps/api/tests/test_finished_goods_lifecycle.py::test_canonical_resolver_creates_fg_var_item PASSED [ 20%]
apps/api/tests/test_finished_goods_lifecycle.py::test_canonical_resolver_returns_existing_item_without_duplicates PASSED [ 23%]
apps/api/tests/test_finished_goods_lifecycle.py::test_canonical_resolver_rejects_variant_belonging_to_another_product PASSED [ 26%]
apps/api/tests/test_finished_goods_lifecycle.py::test_canonical_resolver_rejects_nonexistent_entities PASSED [ 29%]
apps/api/tests/test_finished_goods_lifecycle.py::test_production_completion_posts_stock_ledger_entry PASSED [ 32%]
apps/api/tests/test_finished_goods_lifecycle.py::test_production_completion_rejects_exceeding_target_quantity PASSED [ 35%]
apps/api/tests/test_finished_goods_lifecycle.py::test_production_completion_rejects_duplicate_when_fully_received PASSED [ 38%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_records_deduction_when_stock_available PASSED [ 41%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_strict_no_negative_stock_blocks_insufficient PASSED [ 44%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_rejects_exceeding_order_quantity PASSED [ 47%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_creates_segregated_stock_entry PASSED [ 50%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_rejects_exceeding_delivered_quantity PASSED [ 52%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_idempotency_prevents_duplicate_entries PASSED [ 55%]
apps/api/tests/test_finished_goods_lifecycle.py::test_returned_stock_in_inspection_bucket_not_counted_for_new_deliveries PASSED [ 58%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_rejects_idempotency_key_on_different_delivery PASSED [ 61%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_rejects_idempotency_key_with_different_quantity PASSED [ 64%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_rejects_idempotency_key_with_different_reason PASSED [ 67%]
apps/api/tests/test_finished_goods_lifecycle.py::test_customer_delivery_return_rejects_idempotency_key_with_different_lines PASSED [ 70%]
apps/api/tests/test_reports.py::test_get_summary_report PASSED           [ 73%]
apps/api/tests/test_reports.py::test_get_inventory_report PASSED         [ 76%]
apps/api/tests/test_reports.py::test_get_financial_report PASSED         [ 79%]
apps/api/tests/test_reports.py::test_unauthenticated_requests_return_401 PASSED [ 82%]
apps/api/tests/test_reports.py::test_general_manager_can_access_all_reports PASSED [ 85%]
apps/api/tests/test_reports.py::test_finance_manager_permissions PASSED  [ 88%]
apps/api/tests/test_reports.py::test_warehouse_manager_permissions PASSED [ 91%]
apps/api/tests/test_reports.py::test_unauthorized_role_gets_403_on_all_reports PASSED [ 94%]
apps/api/tests/test_reports.py::test_real_db_empty_state_returns_zeroes PASSED [ 97%]
apps/api/tests/test_reports.py::test_real_db_revenue_and_expense_query_accuracy PASSED [100%]

============================= 34 passed in 6.75s ==============================
```

---

## 4. الفجوات المثبتة في دورة الإنتاج الحالية (Identified Gaps)

أثبت الفحص الكودي الدقيق وجود **أربع فجوات جوهرية** في دورة الإنتاج الحالية:

### 1. انحباس خامات WIP دفترياً للأبد (WIP Balance Trapped):
الخامات المصروفة والمستلمة بالورشة تُودع في مخزن `work_in_progress` عبر `confirm_warehouse_receipt`؛ ولكن عند اكتمال الإنتاج واستلام المنتجات التامة، **لا يتم خصم أي خامة من مخزن WIP إطلاقاً**. هذا يؤدي إلى تضخم دفتري مستمر لرصيد الخامات في الورشة دون معرفة ما استُهلك منها فعلاً.

### 2. ازدواجية وتحول حالة الاكتمال المبكر (`order.status = 'completed'`):
- إذا اكتملت مرحلة التعبئة والتغليف (`packing -> completed`)، يتحول أمر التشغيل فورياً إلى `completed`، حتى لو لم يتم استلام أي قطعة في مخزن المنتج التام!
- إذا استلم أمين المخزن المنتج التام (`already_received + accepted >= target_quantity`)، يتحول الأمر أيضاً إلى `completed`، دون اشتراط اكتمال مراحل الإنتاج.
- هذا التداخل يلغي التمييز بين الإنجاز الميداني والاستلام المخزني.

### 3. إمكانية إغلاق الأمر مع بقاء فروق استلام معلقة:
إذا حدث عجز عند استلام الخامات بالورشة (`received_with_discrepancy`)، يمكن للأمر أن يمر بجميع مراحله ويكتمل دون أي خطوة تلزم بتسوية العجز أو محاسبة المتسبب.

### 4. اقتراح الحالات التشغيلية المنضبطة (Proposed Lifecycle States):
نوصي بفصل الحالات التشغيلية بدلاً من تحميل حالة `completed` وحدها كل المعاني:
1. `in_production`: أمر التشغيل قيد التصنيع في الورشة.
2. `manufacturing_completed`: انتهت كافة المراحل الخمس في الورشة (بما فيها التعبئة)، وبانتظار نقل البضاعة واستلامها بالمخزن.
3. `receipt_pending` / `partially_received`: استُلمت دفعات جزئية بمخزن المنتج التام وما زالت هناك دفعات أخرى بانتظار التسليم.
4. `reconciliation_pending`: استُلمت كامل المنتجات التامة بالمخزن، وبانتظار تسوية خامات WIP المتبقية (إثبات استهلاك/مرتجع/هالك).
5. `closed` (مغلق نهائياً): تم استلام كل المنتجات التامة، ورصيد سلة خامات الأمر في WIP أصبح صفراً تماماً.

---

## 5. القرارات التشغيلية المطلوبة من إدارة المصنع (Factory Decisions Summary)

تم إدراج القرارات العشرة في [`docs/OPEN_DECISIONS_AR.md`](file:///d:/Qema%20Project/docs/OPEN_DECISIONS_AR.md#L184)، وملخصها التنفيذي الموجه للمناقشة:

1. **طريقة حساب الاستهلاك (DEC-WIP-01):** هل نخصم الخامات آلياً بناءً على معادلة الـ BOM عند استلام المنتج التام، أم يسجل مشرف القص الأمتار المستهلكة فعلياً؟ (التوصية: نموذج هجين، قياس فعلي للقماش، وتلقائي للمستلزمات).
2. **المسؤولية الوظيفية (DEC-WIP-02):** من المخول بتسجيل الاستهلاك؟ (مشرف الورشة أم أمين المخزن أم مدير الإنتاج).
3. **الخامات الفائضة (DEC-WIP-03):** هل تعود إجبارياً لمخزن الخامات، أم تتاح مناقلتها لأمر تشغيل آخر في الورشة؟
4. **بواقي الأثواب وفضلات القص (DEC-WIP-04):** هل تُقبل الأطوال القصيرة (أقل من 3 أمتار) في مخزن الخامات بنفس الكود، أم تُكود كصنف بواقي، أم تعتبر هالكاً؟
5. **صلاحية الهالك (DEC-WIP-05):** هل يُسمح بنسبة هالك قص طبيعي (مثلاً 2-3%) يعتمدها المشرف، وما زاد يتطلب المدير العام؟
6. **خامات الإصلاح والمعيب (DEC-WIP-06):** كيف تُصرف الخامات الإضافية لإصلاح العيوب (سند إضافي لنفس الأمر أم عهدة صيانة)؟
7. **شرط إغلاق الأمر (DEC-WIP-07):** هل يُمنع إغلاق الأمر نهائياً طالما هناك خامات في WIP لم تُسوَّ مصائرها؟ (التوصية: نعم، حظر برمجي صارم).
8. **استلام المنتج التام (DEC-WIP-08):** هل يستمر الاستلام الجزئي على دفعات يومية؟ (التوصية: نعم).
9. **فحص الجودة (DEC-WIP-09):** هل الجلاليب التامة تتاح للبيع فوراً بعد التعبئة، أم تُعزل في سلة فحص جودة بالمخزن؟
10. **تمايز الأصناف (DEC-WIP-10):** هل نفصل إجراءات تدقيق الأقمشة عن المستلزمات الصغيرة لتسهيل العمل؟

---

## 6. التوصية الواضحة بالخطوة التالية (Next Step Recommendation)

بناءً على نتائج هذا التحضير:
1. **عرض قائمة الاستيضاحات الميدانية (`Factory Clarification Checklist`)** على إدارة المصنع في الاجتماع القادم لحسم النقاط العشر، وبالأخص طريقة احتساب الاستهلاك (DEC-WIP-01) وسياسة الفائض والهالك.
2. **بدء تنفيذ المرحلة Phase 4.2 في جلسة تنفيذية واحدة محددة** بعد ورود إفادات المصنع، بحيث تشمل:
   - إضافة سلة الأمر `bucket_reference = f"order:{order.id}"` في قيد استلام الورشة.
   - بناء مسار وحيد لتسوية خامات الأمر `POST /orders/{order_id}/reconcile-materials` يعتمد طريقة الاستهلاك المعتمدة.
   - ربط إغلاق الأمر بشرط تصفير سلة الـ WIP بالكامل.
   - ضبط تتابع الحالات بين اكتمال التصنيع واستلام المخزن والإغلاق التشغيلي.

---

## 7. قائمة الملفات المنشأة والمحدثة في هذه المهمة (Files Summary)

| الملف | النوع | الوصف والهدف |
| :--- | :---: | :--- |
| [`docs/WIP_LIFECYCLE_DESIGN_AR.md`](file:///d:/Qema%20Project/docs/WIP_LIFECYCLE_DESIGN_AR.md) | **جديد** | وثيقة التصميم المعماري والتشغيلي لدورة خامات WIP ومعادلات الاتزان والحصانة. |
| [`docs/OPEN_DECISIONS_AR.md`](file:///d:/Qema%20Project/docs/OPEN_DECISIONS_AR.md) | **محدث** | إضافة قرارات المرحلة 4.2 العشرة وقائمة استيضاحات إدارة المصنع الميدانية. |
| [`docs/PHASE_4_2_PREPARATION_REPORT_AR.md`](file:///d:/Qema%20Project/docs/PHASE_4_2_PREPARATION_REPORT_AR.md) | **جديد** | التقرير النهائي الشامل للتحضير وجداول الفحص والجاهزية والتوصيات. |

