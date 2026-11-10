# وثيقة تصميم دورة تشغيل الخامات وتتبعها في الورشة
# Qema ERP — Minimum Commercial-Grade WIP Lifecycle & Traceability Specification

**تاريخ التحديث:** 2026-11-01  
**الإصدار:** 2.0 (Phase 4.3 Final Preparation Blueprint)  
**المرجعية المعمارية:**  
- `docs/PRODUCTION_INVENTORY_TRACEABILITY_REVIEW_AR.md`  
- `docs/OPEN_DECISIONS_AR.md`  
- `docs/PHASE_4_2_PREPARATION_REPORT_AR.md`  
**الهدف:** وضع المواصفة التشغيلية والمحاسبية الدقيقة لدورة حركة الخامات من مخزن الخامات الرئيسي عبر مخزن تحت التشغيل (WIP) وحتى مخزن المنتج التام، تضمن التتبع الكامل والمحاسبة الصارمة والإغلاق المنضبط للأوامر دون تعقيد غير مبرر في مرحلة الإطلاق التجريبي (Pilot).

---

## 1. فحص الواقع الفعلي المثبت في الكود (Current State Analysis)

تم تتبع مسارات حركة الخامات داخل الكود الفعلي للمشروع من خلال النماذج (`models.py`)، والخدمات (`service.py`)، ونقاط النهاية (`endpoints/production.py`)، وجاءت الإجابات الدقيقة عن الأسئلة التشغيلية العشرة كالتالي:

### إجابات الأسئلة التشغيلية العشرة من واقع الكود:

1. **كيف يتم تسجيل الكميات المصروفة من المخزن الرئيسي؟**
   - **الملف والدالة:** [`dispatch_order_materials`](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L327) عبر المسار `POST /api/v1/production/orders/{order_id}/dispatch`.
   - **الآلية الفعلية:** قفل رصيد الخامات في مخزن الخامات الرئيسي تصاعدياً بالأصناف عبر [`lock_stock_balance`](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L311). يُنشأ مستند تحويل [`WarehouseTransfer`](file:///d:/Qema%20Project/apps/api/app/modules/production/models.py#L338) بحالة `in_transit`. يُدرج قيدان في دفتر الأستاذ: قيد صرف سالب (`-quantity`) في `main_raw_materials`، وقيد طريق موجب (`+quantity`) في موقع افتراضي (`location_type = 'in_transit'`) برقم التحويل في `bucket_reference`. تتحول حالة أمر التشغيل إلى `materials_dispatched`.

2. **كيف يتم تسجيل الكميات المستلمة فعلياً في الورشة؟**
   - **الملف والدالة:** [`confirm_warehouse_receipt`](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L448) عبر المسار `POST /api/v1/production/orders/{order_id}/receive`.
   - **الآلية الفعلية:** يُسجل أمين المخزن أو مسؤول الورشة الكميات الفعلية المستلمة لكل صنف. يتم قفل أصناف مخزن الوجهة عبر `lock_stock_balance`. يُدرج قيدان: قيد سالب من موقع الطريق (`-dispatched_quantity`)، وقيد موجب بالكمية المقبولة في مخزن تحت التشغيل (`+received_quantity`) في `work_in_progress`. تتحول حالة التحويل إلى `received_confirmed`، وأمر التشغيل إلى `in_production`.

3. **كيف يتم تسجيل فروق الاستلام (Discrepancies)؟**
   - في حال وجود فرق بين المصروف والمستلم (`rec_qty != dispatched_quantity`)، يُحسب الفرق `disc_qty = rec_qty - dispatched_quantity`. يُنشأ قيد أستاذ ثالث مستقل بنوع حركة `receipt_discrepancy` في موقع افتراضي مخصص للفروقات (`location_type = 'discrepancy'`) بقيمة `-disc_qty`. يتم تحديث سطر لقطة الخامات في الأمر لتصبح حالته `received_with_discrepancy`. توازن الحركات محقق تماماً: $\Delta_{\text{transit}} + \Delta_{\text{wip}} + \Delta_{\text{discrepancy}} = (-D) + (R) + (-(R - D)) = 0$.

4. **هل يمكن معرفة رصيد كل صنف داخل WIP وربطه بأمر تشغيل محدد؟**
   - **رصيد الصنف داخل WIP إجمالاً:** نعم، عبر الاستعلام عن مجموع قيود الأستاذ للصنف في مخزن `work_in_progress`.
   - **ربطه بأمر تشغيل محدد:** القيود المسجلة حالياً تحمل `reference_doc_type = 'warehouse_transfer'` و `reference_doc_id = transfer.id` المرتبط بـ `order_id`. **ولكن:** عمود `bucket_reference` في قيد مخزن WIP لا يُسجل فيه معرّف الأمر حالياً (قيمته `NULL`)، وبالتالي لا يظهر الرصيد مفصولاً كـ "سلة مستقلة للأمر" في استعلامات الأرصدة التجميعية.

5. **هل يمكن معرفة الخامات التي تخص أمر تشغيل معين دون خلطها بأوامر أخرى؟**
   - **نعم وبدقة عالية على مستوى المستندات:** جدول `production_order_materials` يحتوي على لقطة مجمدة ومستقلة تماماً لكل أمر تشغيل توضح: المخطط، والمصروف، والمستلم، والفروقات، وحالة البند. هذه اللقطة لا تختلط إطلاقاً بأوامر أخرى.

6. **ماذا يحدث لرصيد WIP عند اكتمال أمر التشغيل؟**
   - **الواقع الفعلي في الكود الحالي:** **لا يحدث أي شيء إطلاقاً!** عند استلام المنتجات التامة عبر `receive_finished_goods`، يتم فقط إضافة المنتجات التامة إلى مخزن `finished_goods`. الخامات التي دخلت مخزن `work_in_progress` تظل متراكمة فيه دفترياً للأبد دون خصم أو استهلاك.

7. **هل حالة `completed` تعني انتهاء التصنيع فقط أم استلام كل المنتجات التامة بالمخزن؟**
   - **ازدواجية في الكود الحالي:**
     - في [service.py:631](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L631): إذا اكتملت مرحلة التعبئة والتغليف (`packing -> completed`)، يتحول أمر التشغيل تلقائياً إلى `order.status = 'completed'`، حتى لو لم يتم استلام أي قطعة في مخزن المنتج التام!
     - في [endpoints/production.py:927](file:///d:/Qema%20Project/apps/api/app/api/v1/endpoints/production.py#L927): إذا تم استلام كامل الكمية في مخزن التام (`already_received + accepted >= target_quantity`)، يتحول أمر التشغيل أيضاً إلى `order.status = 'completed'`.
     - يثبت هذا غياب الفصل بين "انتهاء التصنيع بالورشة"، و"استلام المخزن"، و"الإغلاق المحاسبي والتشغيلي للأمر".

8. **هل يدعم النظام استلام المنتجات التامة على دفعات؟**
   - **نعم، مدعوم بالكامل ومحصن برمجياً:** مسار `receive_finished_goods` يفحص الكميات المستلمة تراكمياً، ويسمح بالاستلام الجزئي مع إرجاع `receipt_status = 'partial'` طالما أن المجموع أقل من المستهدف.

9. **هل توجد أي آلية حالية لتسجيل الاستهلاك أو الفائض أو المرتجعات؟**
   - **لا توجد أي آلية حالياً.** لا توجد شاشات أو مسارات API لخصم استهلاك الخامات، أو إثبات الهالك الصناعي، أو إعادة الفائض من الورشة إلى مخزن الخامات. جدول `production_defects` يسجل العيوب وصفياً فقط دون أي أثر مخزني.

10. **هل يمكن استخراج كشف يوضح مصير كل كمية خامات تم صرفها؟**
    - **حالياً:** يمكن تتبع الكمية من مخزن الخامات إلى باب الورشة فقط؛ وبمجرد دخولها الورشة تصبح داخل "صندوق أسود" لا توضح التقارير ما استُهلك منها أو هُدر أو رُد.

---

## 2. العمليات التشغيلية التسع لدورة التشغيل المستهدفة (The 9 Lifecycle Operations)

تم تصميم الدورة التشغيلية الرشيدة بأقل قدر من التعقيد، مع **إعادة استخدام الجداول والكيانات القائمة** (`StockLedgerEntry`, `WarehouseTransfer`, `ProductionOrderMaterial`, `ProductionDefect`):

| # | العملية التشغيلية | المستند المرجعي | الصلاحية المطلوبة | الفاعل المسؤول | الاعتماد المطلوب | الأثر على دفتر أستاذ المخزون | انتقال الحالة المشترط | سلوك عدم التكرار (Idempotency) | استراتيجية التصحيح والعكس | متطلبات التزامن والأقفال |
| :-: | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **تخطيط الخامات**<br>(Material Planning) | `ProductionOrder`<br>`ProductionTemplateVersion` | `production:orders:create` | مخطط الإنتاج / المدير العام | لا يوجد | لا يوجد أثر مخزني (إنشاء لقطة خامات مجمدة في `production_order_materials`) | إنشاء الأمر بحالة `draft` | قفل السجل ومنع تكرار رقم الأمر عبر Unique Constraint | تعديل أسطر المسودة متاح فقط قبل الصرف عبر `remove_material_from_draft_order` | لا تتطلب أقفال مخزنية |
| **2** | **صرف الخامات**<br>(Material Dispatch) | `WarehouseTransfer`<br>(نوع: raw_to_wip) | `warehouse:dispatch` | أمين مخزن الخامات الرئيسي | لا يوجد | 1. `-qty` من `main_raw_materials`<br>2. `+qty` إلى `in_transit` برقم التحويل في `bucket_reference` | تحول حالة التحويل إلى `in_transit`، والأمر إلى `materials_dispatched` | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | قيد عكسي تعويضي وإلغاء سند التحويل قبل استلام الورشة | `lock_stock_balance(raw_wh, item_id)` مرتبة تصاعدياً بـ `item_id` |
| **3** | **استلام الورشة والفروقات**<br>(Workshop Receipt) | `WarehouseTransfer` | `warehouse:confirm_receipt` | مشرف الورشة / مسؤول الاستلام | لا يوجد (اعتماد فوري) | 1. `-dispatched` من `in_transit`<br>2. `+rec_qty` إلى `work_in_progress` مع `bucket_reference = f"order:{order_id}"`<br>3. `+/-disc_qty` في `discrepancy` | تحول حالة التحويل إلى `received_confirmed`، والأمر إلى `in_production` | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | قيود تسوية فروق عكسية بمحضر رسمي | `lock_stock_balance(wip_wh, item_id)` |
| **4** | **تسجيل الاستهلاك الفعلي**<br>(Actual Consumption) | سند استهلاك خامات التشغيل<br>(`reference_doc_type = 'production_order_consumption'`) | `production:consumption:record` | فني القص / مشرف صالة التشغيل | مدير الإنتاج / المدير العام (إذا تجاوز الانحراف السقف المسموح) | `-consumed_qty` من `work_in_progress` بنفس سلة الأمر `bucket_reference = f"order:{order_id}"` | يبقى الأمر في حالة `in_production` | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | قيد عكسي موجب في سلة الأمر مع تسجيل سبب التصحيح ورقم سند الاستهلاك الأصلي | `lock_stock_balance(wip_wh, item_id)` |
| **5** | **إرجاع فائض الخامات**<br>(Surplus Material Return) | `WarehouseTransfer`<br>(نوع: wip_to_raw) | `production:orders:manage`<br>+ `warehouse:confirm_receipt` | مشرف الورشة (مُرسل)<br>أمين مخزن الخامات (مُستلم) | اعتماد أمين المخزن للكمية المستلمة | 1. `-qty` من `work_in_progress` بسلة الأمر<br>2. `+qty` إلى مخزن الخامات الرئيسي الحر | لا يغير حالة الأمر (يحدث حقل `returned_quantity` بالأمر) | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | سند تحويل عكسي تعويضي | `lock_stock_balance` على المخزنين تصاعدياً |
| **6** | **إثبات الهالك المعتمد**<br>(Approved Scrap) | محضر هالك صناعي<br>(`reference_doc_type = 'production_order_scrap'`) | `production:scrap:record` | مسؤول الجودة / مشرف الورشة | مدير الإنتاج (ضمن النسبة المسموحة) أو المدير العام | 1. `-scrap_qty` من `work_in_progress` بسلة الأمر<br>2. `+scrap_qty` في موقع افتراضي `location_type = 'scrap'` | لا يغير حالة الأمر (يحدث حقل `scrap_quantity` بالأمر) | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | قيد تسوية عكسي تعويضي معتمد بمحضر إلغاء هالك | `lock_stock_balance(wip_wh, item_id)` |
| **7** | **صرف خامات إصلاح إضافية**<br>(Rework Material Issue) | `WarehouseTransfer`<br>(نوع: rework_issue) مرتبط بـ `defect_id` | `production:orders:manage` | مدير الإنتاج (مُقدم الطلب)<br>المدير العام (مُعتمد) | اعتماد خطي من المدير العام | 1. `-qty` من `main_raw_materials`<br>2. `+qty` إلى `work_in_progress` بسلة الأمر | يبقى الأمر في حالة `in_production` دون تغيير لقطة الـ BOM الأساسية | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | قيد عكسي تعويضي | `lock_stock_balance` على المخزنين |
| **8** | **استلام المنتج التام بالمخزن**<br>(Finished Goods Receipt) | سند استلام منتج تام<br>(`reference_doc_type = 'production_order_finished_receipt'`) | `warehouse:confirm_receipt` | أمين مخزن المنتج التام | لا يوجد (اعتماد الفحص الظاهري والتعبئة) | `+accepted_qty` في `finished_goods` بكود الصنف المعياري `FG-VAR-*` | تحول حالة الاستلام إلى `partial` أو `complete`؛ وتحول حالة الأمر إلى `receipt_completed` | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | قيد تسوية عكسي سالب بمحضر إرجاع منتج تام معيب للورشة | `lock_stock_balance(fg_wh, fg_catalog_item_id)` |
| **9** | **التسوية والإغلاق النهائي**<br>(Reconciliation & Closure) | محضر تسوية وإغلاق أمر التشغيل<br>(Order Reconciliation Summary) | `production:orders:close` | المدير المالي / المدير العام | المدير العام حصراً | لا يوجد أثر مخزني جديد (أو قيد تسوية فروق قياس طفيفة معتمد) | تحول حالة أمر التشغيل إلى `closed` | Header: `Idempotency-Key`<br>محرك `IdempotentRequest` | إعادة فتح الأمر بحالة `reopened` بقرار استثنائي من المدير العام مع تسجيل السبب | قفل صف أمر التشغيل بـ `with_for_update()` |

---

## 3. تصحيح دلالات ومراحل دورة حياة أمر التشغيل (Corrected Lifecycle Semantics)

لفك التداخل والازدواجية في معنى حالة `completed` الحالية، نعتمد نموذجاً تشغيلياً دقيقاً يفصل بين المحطات التشغيلية والمخزنية والمحاسبية:

```
[draft] مسودة أمر التشغيل
   │
   ▼ (صرف الخامات من المخزن)
[materials_dispatched] الخامات بالطريق للورشة
   │
   ▼ (تأكيد استلام الورشة)
[in_production] جارٍ التصنيع على خطوط الورشة (قص، تشطيب، كبسولة، كي، تعبئة)
   │
   ▼ (اكتمال التعبئة والتغليف بالورشة)
[manufacturing_completed] اكتمل التصنيع بالورشة (بانتظار استلام المخزن)
   │
   ▼ (استلام المنتجات التامة بالمخزن - جزئي أو كلي)
[receipt_completed] تم استلام كافة المنتجات التامة بمخزن التام
   │
   ▼ (تسوية الخامات وإبراء الذمة: استهلاك + مرتجع + هالك)
[closed] مغلق نهائياً ومسوى محاسبياً
```

### التعريف الدقيق للمحطات التشغيلية:
1. **`in_production` (قيد التصنيع):** الخامات داخل الورشة، والعمليات الفنية جارية تتابعياً عبر المراحل الخمس.
2. **`manufacturing_completed` (اكتمل التصنيع الميداني):** انتهت كافة العمليات الحرفية في صالة الإنتاج واكتملت مرحلة التعبئة والتغليف (`packing -> completed`)، والجلاليب جاهزة للنقل والتسليم لمخزن المنتج التام.
3. **`receipt_completed` (اكتمل الاستلام المخزني):** دخلت الجلاليب عهدة مخزن المنتج التام بالكامل (`cumulative_accepted >= target_quantity`) وأصبحت جاهزة للمبيعات والتسليم للعملاء.
4. **`closed` (مغلق نهائياً ومسوى):** تمت تسوية كافة خامات WIP بالكامل، وتحدد المصير المعتمد لكل كمية، وأُقفل ملف الأمر محاسبياً وتشغيلياً.

---

## 4. قواعد ومعادلات اتزان المخزون والتسوية (Inventory Conservation Rules)

### أ. معادلة تسوية النقل والصرف (Transfer Reconciliation):
$$\text{Dispatched Qty} = \text{Accepted Qty} + \text{Confirmed Discrepancy} + \text{Unresolved In-Transit Qty}$$
- **الشرط الرقابي:** لا يجوز إغلاق أمر التشغيل نهائياً إذا كانت هناك كمية بالطريق معلقة ($\text{Unresolved In-Transit} > 0$)، ويجب أن تكون كافة فروق الاستلام ($\text{Confirmed Discrepancy}$) قد اعتُمدت وسُوّيت رسمياً.

### ب. معادلة تسوية خامات التشغيل لكل أمر وصنف (WIP Reconciliation per Order & Item):
$$\text{Opening WIP} + \text{Accepted Receipts} + \text{Adjustments In} = \text{Actual Consumption} + \text{Approved Scrap} + \text{Returns to Raw} + \text{Adjustments Out} + \text{Remaining WIP}$$

حيث:
- للأوامر الجديدة: $\text{Opening WIP} = 0$.
- $\text{Accepted Receipts}$: ما دخل سلة الأمر في WIP فعلياً من سندات التحويل.
- $\text{Actual Consumption}$: ما استُهلك في تصنيع المنتجات التامة المقبولة والمعيبة.
- $\text{Approved Scrap}$: الفواقد والتوالف الصناعية المعتمدة رسمياً.
- $\text{Returns to Raw}$: الفائض وبواقي القماش المعادة بسند تحويل لمخزن الخامات.
- $\text{Adjustments}$: تسويات معتمدة بالزيادة أو النقص.
- $\text{Remaining WIP}$: الرصيد المتبقي على طاولات الورشة.

### ج. شرط الإغلاق النهائي المنضبط (Approved Disposition Closure Rule):
> [!IMPORTANT]
> **تصحيح جوهري لافتراض المرحلة 4.2 السابقة:**  
> لا يُشترط أن يصبح رصيد كل صنف في WIP صفراً عددياً بحتاً ($\text{Zero}$) لإغلاق الأمر؛ بل **الشرط الحقيقي هو أن يكون لكامل الكميات مصير صريح وموثق ومعتمد بموجب سياسة المصنع (Explicit, Documented & Approved Disposition)**.  
> فإذا تبقى مثلاً 0.5 متر قماش نتيجة تفاوت القياس أو فضلات قص غير قابلة للإرجاع، يجوز إغلاق الأمر إذا اعتُمدت هذه الكمية رسمياً كـ "انحراف قياس مسموح به" (Allowed Measurement Tolerance Variance) أو "نُقلت لرصيد فضلات الورشة العام".

### د. معادلة تسوية إنتاج المنتج التام (Finished Goods Production Reconciliation):
$$\text{Planned Target Qty} = \text{Accepted Good Qty} + \text{Rejected Qty} + \text{Incomplete Shortfall Qty} + \text{Production Variance}$$
- **ممنوع الخلط إطلاقاً:** تُحسب المنتجات التامة بوحدة القطعة (جلابية)، وتُحسب الخامات بوحداتها الأصلية (متر قماش، قطعة زرار، بكرة خيط).
- **انحراف الاستهلاك المعياري (Yield Variance):**
  $$\text{Standard Allowed Fabric} = \text{Accepted Good Qty} \times \text{BOM Ratio per Piece}$$
  $$\text{Fabric Consumption Variance} = \text{Actual Consumed Fabric} - \text{Standard Allowed Fabric}$$

---

## 5. متطلبات التتبع المالي والتاريخي التجاري (Commercial-Grade Traceability)

تلتزم بنية التنفيذ القادمة بالمحددات الصارمة التالية:
1. **هوية الفاعل (Actor Identity):** كل حركة أستاذ أو اعتماد أو تعديل يسجل هوية المستخدم المعتمدة المستخرجة من JWT Token (`sub`) في حقل `created_by`.
2. **التوقيت الموحد (UTC Timestamps):** استخدام توقيت الخادم الموحد `DateTime(timezone=True)` عبر دالة `utc_now()`.
3. **الربط المستندي والنسبي (Source Document & Lineage):** كل قيد ليدجر يرتبط بنوع المستند المرجعي (`reference_doc_type`) ومعرّفه (`reference_doc_id`) وسطر التحويل (`transfer_line_id`).
4. **عزل سلة الأمر (Order Bucket Reference):** إلزام تمرير `bucket_reference = f"order:{order.id}"` في كافة قيود مخزن `work_in_progress` لتمكين الاستعلام عن رصيد الأمر بدقة متناهية.
5. **حصانة السجلات التاريخية (Append-Only Enforcement):** منع التعديل والحذف بقوة التريجر المفعل على مستوى محرك PostgreSQL (`trg_stock_ledger_entries_prevent_update_delete`).
6. **التصحيح بالقيد العكسي التعويضي (Compensating Corrections):** معالجة أي خطأ بإدراج قيد جديد معاكس يربط بالمستند الأصلي مع بيان السبب واسم المعتمد، دون مسح الحركة السابقة.
7. **منع التكرار الشامل (Strict Idempotency):** تطبيق محرك `IdempotentRequest` مع ترويسة `Idempotency-Key` وبصمة SHA-256 على كافة عمليات الصرف، والاستلام، والاستهلاك، والهالك، والتسوية.
8. **أمان التزامن ومنع الأرصدة السالبة:** استخدام أقفال المعاملات الاستشارية [`lock_stock_balance`](file:///d:/Qema%20Project/apps/api/app/modules/production/service.py#L311) على مستوى الصنف والمخزن قبل أي فحص أو تعديل للرصيد.
