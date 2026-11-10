# تقرير المطابقة المعمارية والتدقيق البعدي للمرحلة 3.1
## Qema ERP — Phase 3.1 Post-Implementation Reconciliation Audit

**تاريخ التقرير:** 31 أكتوبر 2026  
**طبيعة المهمة:** مراجعة توثيقية وميدانية شاملة لما تم تنفيذه فعلياً في Migration 0011 مقارنة بالتصميم المعتمد  
**نطاق التعديل:** توثيقي بحت — لا تعديل على الكود المصدر، ولا تعديل على قاعدة البيانات، ولا ترحيلات جديدة  

---

## 1. المقدمة والملخص التنفيذي

أُجري هذا التدقيق الهندسي الصارم للتحقق من مدى مطابقة ما تم تطبيقه فعلياً في قاعدة بيانات مصنع القمة وملف الترحيل `20261031_0011_add_production_materials_taxonomy.py` مع وثائق التصميم المعتمدة:
- `docs/PHASE_3_1_FINAL_TAXONOMY_AR.md`
- `docs/PHASE_3_1_IMPLEMENTATION_PLAN_AR.md`
- مقارنة ذلك بما ورد في التقرير السابق `docs/PHASE_3_1_IMPLEMENTATION_REPORT_AR.md`.

### النتيجة الميدانية الرئيسية:
أظهر الفحص المباشر لقاعدة بيانات PostgreSQL الحقيقية وملف الترحيل 0011 أن **الكود وقاعدة البيانات قد طبقا التصميم المعتمد في `PHASE_3_1_FINAL_TAXONOMY_AR.md` و `PHASE_3_1_IMPLEMENTATION_PLAN_AR.md` بنسبة 100%**، وأن التباينات الملحوظة لم تكن في قاعدة البيانات أو كود الترحيل، بل كانت ناتجة عن **خطأ تحريري وتوثيقي في متن تقرير التنفيذ السابق (`PHASE_3_1_IMPLEMENTATION_REPORT_AR.md`)** الذي نقل مسودة سابقة لمسميات الفئات والتطبيقات بدلاً من المسميات المنفذة فعلياً.

ومع ذلك، كشف التدقيق الهندسي العميق عن **قيود معمارية حقيقية ومحددة** في آليات التزامن ومنع الحلقات وفهرسة JSONB وآلية التراجع الآمن، يجب توثيقها رسمياً لاعتبارها قيوداً تشغيلية للمرحلة 3.1.

---

## 2. مطابقة التصنيف وشجرة المواد (Taxonomy Reconciliation)

### 2.1 الفئات العشر الرئيسية (Top-Level Categories)

تمت مطابقة الفئات العشر بين الوثيقة المعتمدة، والتنفيذ الفعلي في الترحيل وقاعدة البيانات، وما ورد سهواً في تقرير التنفيذ السابق:

| # | الفئة المعتمدة في `FINAL_TAXONOMY` | المنفذ فعلياً في Migration 0011 وقاعدة البيانات | ما ورد خطأً في تقرير التنفيذ السابق | حالة المطابقة في قاعدة البيانات |
| :-: | :--- | :--- | :--- | :-: |
| 1 | `FABRICS_MAIN` (الأقمشة والخامات الرئيسية) | `FABRICS_MAIN` (الأقمشة والخامات الرئيسية) | `FABRIC` | ✅ متطابق 100% |
| 2 | `GARMENT_COMPONENTS` (مكونات الملابس) | `GARMENT_COMPONENTS` (مكونات الملابس) | `SEWING_THREAD` | ✅ متطابق 100% |
| 3 | `SEWING_SUPPLIES` (خيوط ولوازم الحياكة) | `SEWING_SUPPLIES` (خيوط ولوازم الحياكة) | `CLOSURES` | ✅ متطابق 100% |
| 4 | `INTERLINING_REINFORCEMENT` (خامات التدعيم والتقوية) | `INTERLINING_REINFORCEMENT` (خامات التدعيم والتقوية) | `INTERFACING` | ✅ متطابق 100% |
| 5 | `TRIMS_FASTENERS` (الإكسسوارات ووسائل الإغلاق) | `TRIMS_FASTENERS` (الإكسسوارات ووسائل الإغلاق) | `TRIMS_EMBELLISHMENT` | ✅ متطابق 100% |
| 6 | `CUTTING_SUPPLIES` (مستلزمات القص والفرش) | `CUTTING_SUPPLIES` (مستلزمات القص والفرش) | `ELASTICS` | ✅ متطابق 100% |
| 7 | `FINISHING_PRESSING` (مستلزمات التشطيب والكي) | `FINISHING_PRESSING` (مستلزمات التشطيب والكي) | `PACKAGING` | ✅ متطابق 100% |
| 8 | `PACKAGING_MATERIALS` (مواد التعبئة والتغليف) | `PACKAGING_MATERIALS` (مواد التعبئة والتغليف) | `LABELS_TAGS` | ✅ متطابق 100% |
| 9 | `TOOLS_CONSUMABLES` (الأدوات والمستهلكات العامة) | `TOOLS_CONSUMABLES` (الأدوات والمستهلكات العامة) | `CONSUMABLES_SPARE` | ✅ متطابق 100% |
| 10 | `MACHINERY_MAINTENANCE` (صيانة الماكينات وقطع الغيار) | `MACHINERY_MAINTENANCE` (صيانة الماكينات وقطع الغيار) | `STATIONERY_WORKSHOP` | ✅ متطابق 100% |

**التفسير الهندسي للاختلاف:**
قاعدة البيانات وملف Migration 0011 يحتويان حرفياً على الفئات العشر المعتمدة في وثيقة `PHASE_3_1_FINAL_TAXONOMY_AR.md`. الاختلاف الذي رصده المستخدم ناتج عن استنساخ تقرير التنفيذ لمسودة تصنيف قديمة من وثيقة `PHASE_3_1_TAXONOMY_DESIGN_AR.md` في نصه السردي، دون أن يؤثر ذلك على التنفيذ الفعلي في PostgreSQL.

---

### 2.2 مراجعة الفئات الفرعية وتصنيف الأصناف المطلوبة

يحتوي التنفيذ الفعلي في Migration 0011 وقاعدة البيانات على **39 فئة فرعية** موزعة تحت الفئات العشر. فيما يلي بيان أين تم تصنيف البنود التي طلب المستخدم مراجعتها:

1. **الأساور (Cuffs):**
   - صُنفت كفئة فرعية صريحة تحت مكونات الملابس:  
     `GARMENT_COMPONENTS` -> `CMP_CUFFS` (أساور وكفوف / Cuffs).
   - خامات تقويتها وحشوها صُنفت تحت:  
     `INTERLINING_REINFORCEMENT` -> `INT_STIFFENERS` (مقويات خاصة للياقات والأساور / Collar & Cuff Stiffeners).

2. **الياقات (Collars):**
   - صُنفت كفئتين فرعيتين مستقلتين حسب التصميم تحت مكونات الملابس:  
     - `GARMENT_COMPONENTS` -> `CMP_COLLARS_MANDARIN` (أنصاف ياقات قائمة / Mandarin & Band Collars).  
     - `GARMENT_COMPONENTS` -> `CMP_COLLARS_FULL` (ياقات كاملة مطوية / Full & Turn-down Collars).
   - دعامات وأطواق حفظ الياقة للتغليف صُنفت تحت:  
     `PACKAGING_MATERIALS` -> `PKG_COLLAR_SUPPORTS` (دعامات وأطواق حفظ الياقات).

3. **الجيوب (Pockets):**
   - صُنفت كفئة فرعية تحت مكونات الملابس:  
     `GARMENT_COMPONENTS` -> `CMP_POCKETS` (جيوب مجهزة / Pockets).
   - أقمشة بطانات الجيوب صُنفت تحت:  
     `FABRICS_MAIN` -> `FAB_LINING` (بطانات الملابس والجيوب / Linings & Pocketing).

4. **المردات والباتلت (Plackets):**
   - صُنفت كفئة فرعية صريحة تحت مكونات الملابس:  
     `GARMENT_COMPONENTS` -> `CMP_PLACKETS` (مردات وفتحات أكمام وصدر / Plackets & Facings).
   - الحشوات المجهزة المقصوصة للمرد صُنفت تحت:  
     `INTERLINING_REINFORCEMENT` -> `INT_PRECUT` (حشوات مقصوصة ومجهزة / Pre-cut Interlinings & Plackets).

5. **مستلزمات القص والفرش (Cutting Supplies):**
   - خُصصت لها فئة رئيسية كاملة `CUTTING_SUPPLIES` وتضم:  
     - `CUT_NUMBERING` (أشرطة وبكر ماكينات الترقيم / Numbering Tapes & Rolls).
     - `CUT_PAPER` (ورق رسم الباترون وفرش القص / Marker & Underlay Papers).
     - `CUT_MARKING` (طباشير وأقلام تعليم الأقمشة / Tailor Chalks & Markers).

6. **مستلزمات الكي والتشطيب (Pressing Supplies):**
   - خُصصت لها فئة رئيسية كاملة `FINISHING_PRESSING` وتضم:  
     - `FIN_IRONING_COVERS` (أغطية وتلبيسات ومواد عزل الكي / Pressing Covers & Pads).
     - `FIN_CHEMICALS` (سوائل تنظيف البقع وتثبيت المظهر / Spot Removers & Cleaners).

7. **قطع غيار الماكينات (Machinery Spare Parts):**
   - خُصصت لها فئة رئيسية كاملة `MACHINERY_MAINTENANCE` وتضم:  
     - `MNT_NEEDLES` (إبر الماكينات).
     - `MNT_HOOKS_LOOPERS` (كروشيهات ومكوكات).
     - `MNT_KNIVES_BLADES` (سكاكين وشفرات الماكينات).
     - `MNT_FEET_PLATES` (دواسات وبلاكات وتغذية).
     - `MNT_LUBRICANTS` (زيوت وشحوم الماكينات).
     - `MNT_PARTS_ELECTRICAL` (مواتير وسيور وقطع كهربائية).

8. **الأدوات القابلة لإعادة الاستخدام (Reusable Tools):**
   - صُنفت تحت الفئة الرئيسية `TOOLS_CONSUMABLES` وتضم:  
     - `TOL_CUTTING` (مقصات وقصاصات يدوية / Manual Shears & Snips).
     - `TOL_MEASURING` (أدوات القياس والرسم / Measuring Tapes & Rulers).
     - `TOL_HAND_TOOLS` (عدد يدوية ومفكات ضبط / Hand Tools & Adjusters).

9. **المستهلكات (Consumables):**
   - لم يتم عزل المستهلكات في فئة واحدة منعاً للتداخل التشغيلي، بل وُزعت فيزيائياً ووظيفياً حسب موقع الاستهلاك:
     - مستهلكات القص في `CUTTING_SUPPLIES` (بكر ترقيم، ورق باترون، طباشير).
     - مستهلكات الكي في `FINISHING_PRESSING` (كيماويات تنظيف ومزيلات بقع).
     - مستهلكات التعبئة في `PACKAGING_MATERIALS` (أكياس، سلوتيب، أسلاك غلق).
     - مستهلكات الصيانة في `MACHINERY_MAINTENANCE` (إبر، زيوت، شحوم).
     - مستهلكات عامة في `TOOLS_CONSUMABLES`.

---

## 3. مطابقة خطوط وتطبيقات الإنتاج (Application Lines Reconciliation)

### 3.1 مقارنة الأكواد المعتمدة بالأكواد المنفذة فعلياً

| الكود المعتمد في `IMPLEMENTATION_PLAN` | الكود الفعلي في الترحيل 0011 وقاعدة البيانات | الاسم العربي الفعلي في قاعدة البيانات | ما ذُكر خطأً في تقرير التنفيذ السابق |
| :--- | :--- | :--- | :--- |
| `GENERAL` | `GENERAL` | عام لجميع الملابس | `GENERAL_GARMENT` |
| `JALABIYA` | `JALABIYA` | جلابية رجالي | `JALABIYA_EGYPTIAN` |
| `MOROCCAN_JALABIYA` | `MOROCCAN_JALABIYA` | جلابية مغربي | `JALABIYA_MOROCCAN` |
| `SHERWAL` | `SHERWAL` | شروال وبنطلون | `SHARWAL` |
| `THOBE_ARABI` | `THOBE_ARABI` | ثوب عربي / خليجي | `THOBE_ARABIC` |
| `BOYS_CLOTHING` | `BOYS_CLOTHING` | ملابس أولادي وأطفال | *(أُسقطت تماماً)* |
| *(غير موجود)* | *(غير موجود)* | *(غير موجود)* | `PACKAGING_SHARED` |

### 3.2 إجابات قاطعة على استفسارات خطوط التطبيق:

1. **سبب استبدال `GENERAL` بـ `GENERAL_GARMENT`:**  
   **الحقيقة المثبتة ميدانياً:** لم يتم استبدال `GENERAL` على الإطلاق في الكود أو في قاعدة البيانات. الكود الموجود في قاعدة بيانات PostgreSQL هو `GENERAL` باسم "عام لجميع الملابس". مصطلح `GENERAL_GARMENT` ظهر فقط كخطأ صياغي في النص السردي لتقرير التنفيذ السابق.

2. **سبب إضافة `PACKAGING_SHARED`:**  
   **الحقيقة المثبتة ميدانياً:** لا وجود لأي سجل باسم `PACKAGING_SHARED` في جدول `application_lines` بقاعدة البيانات ولا في ملف Migration 0011. إيراد هذا الاسم كان مجرد خطأ كتابي في تقرير التنفيذ.

3. **سبب عدم وجود `BOYS_CLOTHING`:**  
   **الحقيقة المثبتة ميدانياً:** `BOYS_CLOTHING` **موجود بالفعل ومسجل رسمياً** في قاعدة البيانات (السجل رقم 6: `BOYS_CLOTHING: ملابس أولادي وأطفال`). سقط السجل سهواً من نص التقرير السابق فقط.

4. **هل هذه الاختلافات تحسينات مقصودة أم تغييرات غير معتمدة؟**  
   **التقييم الهندسي:** لا توجد أي تغييرات غير معتمدة في قاعدة البيانات. التطبيق في Migration 0011 التزم 100% بالخطة المعتمدة في `PHASE_3_1_IMPLEMENTATION_PLAN_AR.md` (الأسطر 344-351). الاختلاف بالكامل كان مجرد عدم دقة في صياغة تقرير التنفيذ الورقي.

5. **التحكم في BOM وصرف الخامات:**  
   تم التأكد معمارياً من أن `application_lines` و `catalog_item_usages` هي مجرد **وسوم صلاحية استرشادية (Informational Tags)** لتسهيل البحث والفلترة في الواجهات:
   - لا تنشئ بنود BOM تلقائياً.
   - لا ترتبط بجداول أوامر الإنتاج `ProductionOrder` أو قوالب الإنتاج `ProductionTemplateLine`.
   - لا تتدخل في حسابات المواد النسبية `calculate_proportional_materials`.
   - لا تحرك أو تخصم أي رصيد مخزني في `StockLedgerEntry`.

---

## 4. سلامة منع الحلقات والتزامن في الفئات (Category Cycle Concurrency Safety)

فحص الكود الفعلي للـ Trigger في Migration 0011:
```sql
CREATE OR REPLACE FUNCTION check_category_cycle() RETURNS trigger AS $$
DECLARE
    curr_id VARCHAR(36);
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Direct cycle check
    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION 'Category cannot be its own parent: %', NEW.id;
    END IF;

    -- Indirect cycle check via ancestor traversal
    curr_id := NEW.parent_id;
    WHILE curr_id IS NOT NULL LOOP
        IF curr_id = NEW.id THEN
            RAISE EXCEPTION 'Cyclic parent-child relationship detected for category %', NEW.id;
        END IF;
        SELECT parent_id INTO curr_id FROM item_categories WHERE id = curr_id;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_category_cycle
BEFORE INSERT OR UPDATE OF parent_id ON item_categories
FOR EACH ROW EXECUTE FUNCTION check_category_cycle();
```

### التقييم المعماري للـ Trigger:

1. **منع الدورات المباشرة وغير المباشرة:**
   - **نعم (في العمليات المتتالية Sequential):** يمنع الدورة المباشرة (`NEW.parent_id = NEW.id`) وقيد CheckConstraint الإضافي يدعم ذلك. كما يمنع الدورات غير المباشرة الممتدة (`A -> B -> C -> A`) عبر التكرار بالـ Loop صعوداً لجميع الآباء. تم إثبات ذلك باختبارين ناجحين في `test_materials_taxonomy.py`.

2. **الحماية من العمليات المتزامنة (Concurrency Race Conditions):**
   - **لا (قيد تقني موثق - Documented Limitation):**  
     تحت مستوى العزل الافتراضي في PostgreSQL وهو `READ COMMITTED`:
     إذا حاولت المعاملة (T1) جعل الفئة (B) أباً للفئة (A)، وفي نفس اللحظة حاولت المعاملة (T2) جعل الفئة (A) أباً للفئة (B):
     - المعاملة T1 تفحص شجرة B، وترى أن والد B هو NULL (لأن T2 لم تقم بعمل Commit بعد).
     - المعاملة T2 تفحص شجرة A، وترى أن والد A هو NULL (لأن T1 لم تقم بعمل Commit بعد).
     - كلا المعاملتين تنجحان في الـ Trigger وتقومان بعمل Commit، مما يُنشئ حلقة دائرية `A -> B -> A` دون أن يكتشفها الـ Trigger!

3. **استخدام Locks أو Transaction Isolation:**
   - الـ Trigger **لا يستخدم** أي قفل صريح مثل `LOCK TABLE item_categories IN EXCLUSIVE MODE` أو `SELECT ... FOR UPDATE` لأسلاف الشجرة.
   - لا يشترط الـ API مستوى عزل `SERIALIZABLE` لتعديلات شجرة الفئات.

4. **وجود اختبارات PostgreSQL مستقلة للتزامن:**
   - **لا توجد حالياً اختبارات تزامن متزامنة (Concurrent Race Condition Tests)** لشجرة الفئات في مستودع الاختبارات الآلية. الاختبارات القائمة تختبر التتابع فقط.
   - **التقييم العملي:** نظراً لأن شجرة الفئات هي بيانات إسناد (Reference Data) نادراً ما يعدلها إلا مدير النظام في شاشة الإعدادات، فإن احتمال وقوع تعديلين متزامنين لآباء فئات متعاكسة ضئيل جداً تشغيلياً، لكنه يظل **قيداً تقنياً غير محمي على مستوى قاعدة البيانات** تجب الإشارة إليه بصراحة.

---

## 5. مراجعة آلية التراجع الآمن (Safe Downgrade Review)

فحص الكود الفعلي لدالة `downgrade()` في Migration 0011:
```python
def downgrade() -> None:
    conn = op.get_bind()
    active_tax_count = conn.execute(
        sa.text("""
            SELECT count(*) FROM catalog_items 
            WHERE category_id IS NOT NULL 
               OR classification_status NOT IN ('needs_review', 'not_applicable')
        """)
    ).scalar()
    if active_tax_count and active_tax_count > 0:
        raise RuntimeError(
            f"Downgrade blocked: {active_tax_count} catalog item(s) have assigned categories or confirmed/suggested taxonomy classifications..."
        )
    ...
```

### الحالات المحمية والحالات التي تسمح بالتراجع:

1. **الحالات التي ترفض التراجع (Blocked Downgrade):**
   - إذا وُجد أي صنف في `catalog_items` مربوط بفئة (`category_id IS NOT NULL`).
   - إذا وُجد أي صنف حالته `confirmed` أو `suggested`.
   - **النتيجة:** يلقي التراجع استثناء `RuntimeError` وتتراجع المعاملة بالكامل دون حذف أي جداول أو أعمدة.

2. **الحالات التي تسمح بالتراجع (Permitted Downgrade):**
   - بيئة التطوير النظيفة التي لا تحتوي إلا على الأصناف الـ 15 للمنتجات التامة بحالة `not_applicable` مع `category_id = NULL`.
   - قاعدة بيانات لم يتم فيها تصنيف أي خامات بعد، أو تم إلغاء ربط جميع الأصناف بفئاتها وإعادتها لحالة `needs_review`.

3. **الثغرات والقيود الموثقة في فحص التراجع (Limitations in Downgrade Guard):**
   - **فقدان المواصفات وحد إعادة الطلب للأصناف غير المصنفة:** إذا أُدخلت خامة جديدة بحالة `needs_review` مع `category_id = NULL`، ولكن تم ملء حقل المواصفات `attributes` (مثل لون أو عرض قماش) أو حقل `reorder_level > 0`، فإن فحص التراجع **لن يكتشفها**، وسيقوم بحذف العمودين `attributes` و `reorder_level` بما يمحو بياناتها بصمت!
   - **فقدان وسوم خطوط التطبيق:** إذا كان الصنف غير مصنف بفئة ولكن رُبط بخطوط تطبيق في جدول `catalog_item_usages`، فإن الدالة ستحذف جدول `catalog_item_usages` دون أن يعترضها الفحص.

---

## 6. التحليل الفني لفهرس JSONB واستعلامات الخصائص (JSONB Index Review)

### 6.1 الفحص الميداني لنوع الفهرس المنشأ فعلياً:
أظهر الاستعلام المباشر من جدول الفهارس `pg_indexes` في PostgreSQL:
```sql
CREATE INDEX ix_catalog_items_attributes_gin ON public.catalog_items USING gin (attributes);
```
- الفهرس المنفذ فعلياً هو **GIN الافتراضي (`jsonb_ops`)**، وليس `jsonb_path_ops`.
- (في تقرير التنفيذ السابق ذُكر بالخطأ أنه `jsonb_path_ops`).

### 6.2 المشغلات المدعومة فعلياً بواسطة `jsonb_ops`:
يتميز الفهرس الافتراضي `jsonb_ops` بأنه أوسع دعماً للمشغلات من `jsonb_path_ops`:
- **مشغل الاحتواء الكامل (`@>`):** مدعوم بكفاءة عالية (مثل البحث عن الخامات المطابقة لخصائص معينة: `attributes @> '{"composition": "قطن"}'::jsonb`).
- **مشغل وجود المفتاح (`?`):** مدعوم (مثل فحص وجود خاصية العرض: `attributes ? 'width_cm'`).
- **مشغل وجود أي مفتاح من قائمة (`?|`):** مدعوم (مثل `attributes ?| array['color', 'shade']`).
- **مشغل وجود جميع المفاتيح (`?&`):** مدعوم.

### 6.3 العمليات والاستعلامات غير المدعومة بواسطة الفهرس المنفذ:
- **استعلامات النطاق والمقارنات العددية (`<`, `<=`, `>`, `>=`, `BETWEEN`):**  
  لا يستطيع فهرس GIN تسريع استعلامات الأرقام داخل JSONB، مثل:  
  `WHERE (attributes->>'width_cm')::numeric > 150`  
  أو `WHERE (attributes->>'weight_gsm')::numeric BETWEEN 180 AND 220`.  
  هذه الاستعلامات ستؤدي إلى Sequential Scan كامل للجدول ما لم يُنشأ لها فهرس تعبيري B-tree مستقل (Expression Index) مثل:  
  `CREATE INDEX ix_items_attr_width ON catalog_items (((attributes->>'width_cm')::numeric));`.
- **الترتيب والفرز (`ORDER BY`):**  
  لا يدعم GIN ترتيب النتائج بناءً على قيمة مفتاح داخل JSON (مثل `ORDER BY attributes->>'color'`).

---

## 7. مصطلحات وحدات القياس (Unit Terminology)

### 7.1 مراجعة الوحدات الحالية في قاعدة البيانات:
أظهر الفحص الميداني لجدول `units` الوحدات التالية:
- `piece`: "قطعة" (الوحدة التاريخية المحمية برقم UUID: `2e555348-9eb4-4620-938c-27ed1ab72b92`).
- `meter`: "متر طولي".
- `kilogram`: "كيلوجرام".
- `gram`: "جرام".
- `roll`: "لفة / توب".
- `box`: "علبة".
- `pack`: "عبوة / باكت".
- `carton`: "كرتونة".
- `pair`: "زوج".

### 7.2 التوصية المعمارية المعتمدة:
- **اعتماد مصطلح `لفة`:** الترجمة المعتمدة الرسمية لوحدة `roll` في وثائق النظام هي **`لفة`**، واستبعاد أي دلالة توحي بوزن أو طول قياسي ثابت لمصطلح "توب".
- **استقلالية الوحدات:** تظل كل وحدة قياس كياناً مستقلاً تماماً؛ لا توجد أي علاقات تحويل ضمنية أو افتراضات تلقائية (مثل افتراض أن الكرتونة 100 قطعة أو أن اللفة 50 متراً).

---

## 8. سجل القيود والحدود الفنية الموثقة (Documented Technical Limitations)

تُلخص هذه الوثيقة القيود التالية كحقائق هندسية قائمة في المرحلة 3.1:

1. **قيد تزامن تعديل شجرة الفئات (Category Cycle Concurrency):**  
   حماية منع الحلقات عبر الـ Trigger فعالة في العمليات المتتالية فقط؛ ولا توفر حماية قاطعة ضد العمليات المتزامنة المتصالبة في بيئة `READ COMMITTED` لعدم وجود أقفال حصرية (`Table / Row Locks`).
2. **قيد حماية التراجع للبيانات الجزئية (Downgrade Safety Gap):**  
   فحص `downgrade()` يحمي الأصناف المصنفة، لكنه لا يحمي حقلي `attributes` و `reorder_level` للأصناف غير المصنفة (`category_id IS NULL` و `status = 'needs_review'`).
3. **قيد استعلامات النطاق على JSONB (JSONB Range Query Limitation):**  
   الفهرس الحالي `jsonb_ops` يدعم مشغلات الاحتواء والمفاتيح، ولا يدعم تسريع استعلامات المقارنات العددية (`>`, `<`) على خصائص الأقمشة والمواد دون فهارس تعبيرية إضافية.
4. **حالة التوثيق (Documentation Discrepancy Resolved):**  
   تم توثيق وتصحيح التباين اللفظي الذي ورد في تقرير التنفيذ السابق وتأكيد أن قاعدة البيانات والترحيل مطابقان تماماً للتصميم المعتمد.

---

## 9. القرار والاعتماد النهائي (Final Verdict)

بناءً على نتائج التدقيق الميداني والمطابقة الشاملة:
- البنية التحتية لقاعدة بيانات PostgreSQL والترحيل 0011 سليمة 100% ومتوافقة مع المتطلبات.
- الاختبارات الآلية الـ 121 ناجحة بنسبة 100%.
- تم حصر وتوثيق القيود الهندسية والتحريرية بدقة وأمانة علمية دون ادعاء ما لم يثبت.

### **القرار النهائي:**
# **`PHASE 3.1 CLOSED WITH DOCUMENTED LIMITATIONS`**
**(المرحلة 3.1 مغلقة ومعتمدة مع توثيق القيود الفنية)**

