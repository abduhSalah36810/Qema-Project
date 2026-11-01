# خريطة بيانات ومخطط نماذج ERP مصنع القمة

## الخزنة والعهدة (تنفيذ أولي)

- `cash_accounts`: الخزنة الرئيسية وعهد يومية تابعة لها. يُنشأ حساب الخزنة برصيد صفري في الترحيل؛ لا توجد أرصدة افتتاحية فعلية مرحّلة.
- `cash_documents`: مستندات إيراد أو مصروف أو تحويل، بحالات انتظار الاعتماد/اعتماد/رفض. يحتفظ المستند بمنشئه ومعتمده وتاريخ القرار ومرجع المصدر عند ربطه بوحدة أخرى.
- `cash_ledger_entries`: أثر غير قابل للتعديل عبر API، لا يُنشأ إلا عند اعتماد المستند؛ التحويل ينشئ قيدًا سالبًا للمصدر وموجبًا للوجهة ضمن المعاملة نفسها.
- الرصيد مشتق من مجموع قيود الحساب. يعتمد مدير المالية المستند، ويُرفض الاعتماد عند عدم كفاية رصيد المصدر. لا يمحو الرفض أو التصحيح مستندًا سابقًا.
- هذا سجل نقدي تشغيلي وليس دفتر أستاذ أو محاسبة عامة. ربط فواتير الموردين والرواتب والتحصيلات الحالية يبقى لاحقًا مع منع التكرار بمراجع المصدر.

## دفتر حركة المخزون (تنفيذ أولي)

- `stock_ledger_entries`: كل سطر حركة غير قابل للتعديل عبر API، مرتبط بالصنف والوحدة والمستند والمنفذ. يُحسب رصيد المخزن من مجموع السطور ذات `location_type = warehouse`.
- صرف خامة أمر التشغيل يسجل خروجًا من مخزن الخامات وإيداعًا في سلة «بالطريق». تأكيد الاستلام يسجل الخروج من سلة الطريق، وإيداع الكمية المقبولة في مخزن تحت التشغيل، وسطرًا منفصلًا للفارق.
- الأرصدة غير المسجلة تبقى غير مثبتة حتى إدخال حركة؛ لا تُنشأ أرصدة افتتاحية افتراضية. الرصيد السالب ممنوع عند صرف الإنتاج؛ سياسة اعتماد التسويات والأرصدة الافتتاحية ما زالت مفتوحة.

## الموردون وفواتير الخامات (تنفيذ أولي)

- `suppliers`: دليل الموردين وبيانات الاتصال اللازمة.
- `supplier_invoices` و`supplier_invoice_lines`: رقم فاتورة المورد، مبلغها كما ورد من المصدر، الكميات والأسعار المدونة لكل صنف، والكمية المقبولة فعليًا.
- يسجل المالي الفاتورة؛ ويؤكد أمين المخزن الكمية الفعلية. الاستلام المؤكد فقط ينشئ حركة موجبة في مخزن الخامات، ويُحفظ المستخدم والوقت والمرجع.
- `supplier_payments` ترتبط بمستند صرف الخزنة. لا ينخفض المستحق إلا بعد اعتماد الصرف؛ المدفوعات المعلقة تحجز من المتبقي لمنع طلبات تتجاوز إجمالي الفاتورة.
- الأسعار تحفظ كبيانات فاتورة ولا تستخدم لحساب تقييم المخزون أو تكلفة الإنتاج.

> [!NOTE]
> هذا المخطط يمثل الأساس الهيكلي الموحد لقاعدة البيانات العلائقية (PostgreSQL).
> القواعد التشغيلية والافتراضات الواردة هنا هي **مسودات مؤقتة للمراجعة في اجتماع إدارة المصنع**، وليست سياسات نهائية معتمدة.

---

## 1. الهوية والأدوار والصلاحيات (Identity, Roles & Permissions)

تعتمد إدارة المستخدمين على ربط هوية Supabase Auth مع صلاحيات النظام وفق مبدأ الحظر الافتراضي (Deny-by-default):

- `roles`:
  - `id`: المعرف الفريد (UUID / String).
  - `name`: اسم الدور التقني الفريد (`general_manager`, `warehouse_manager`, `finance_manager`).
  - `display_name_ar`: الاسم المعروض بالعربية (المدير العام، أمين المخزن، المدير المالي).
  - `description`: وصف مسؤوليات الدور.
- `permissions`:
  - `id`: المعرف الفريد.
  - `code`: كود الصلاحية (مثل `production:manage`, `inventory:receive`, `finance:manage`).
  - `module`: الوحدة التابعة لها (production, inventory, sales, finance).
  - `description`: بيان الصلاحية.
- `role_permissions`:
  - جدول الربط المتعدد بين `role_id` و`permission_id`.
- `user_roles`:
  - جدول ربط هوية المستخدم `user_id` مع `role_id`.
  - التعيين يتم عبر إجراءات إدارية من الخادم (Administrative/Seeding)، ولا يوجد مسار عام يتيح للمستخدم إسناد دور لنفسه.

---

## 2. الدليل، الأصناف، والمخازن (Catalog, Items & Warehouses)

- `warehouses`:
  - المخازن التشغيلية الثلاثة الثابتة:
    1. `main_raw_materials`: مخزن الخامات الرئيسي.
    2. `work_in_progress`: مخزن تحت التشغيل ودفعات الإنتاج.
    3. `finished_goods`: مخزن المنتج التام.
  - `name_ar`, `code`, `is_active`.
- `units`:
  - وحدات القياس المعتمدة التسع (دون أي تحويلات ضمنية):
    - `piece`: قطعة
    - `meter`: متر
    - `kg`: كيلو جرام
    - `gram`: جرام
    - `roll`: لفة / رول
    - `box`: علبة
    - `pack`: عبوة / باكيت
    - `carton`: كرتونة
    - `pair`: زوج
  - الحقول: `id`, `code`, `name_ar`, `name_en`, `is_active`, `created_at`.
- `item_categories`:
  - شجرة تصنيفات المواد والخامات (10 فئات رئيسية و39 فئة فرعية هرمية):
  - الحقول: `id`, `code`, `name_ar`, `name_en`, `description`, `parent_id` (علاقة ذاتية للشجرة), `is_active`, `created_at`.
- `application_lines`:
  - خطوط وتطبيقات استخدام الملابس الستة المعتمدة:
    - `GENERAL`: عام ومشترك
    - `JALABIYA`: جلابية بلدي / تقليدي
    - `MOROCCAN_JALABIYA`: جلابية مغربي
    - `SHERWAL`: شروال
    - `THOBE_ARABI`: ثوب عربي
    - `BOYS_CLOTHING`: ملابس أولادي
  - الحقول: `id`, `code`, `name_ar`, `name_en`, `description`, `is_active`, `created_at`.
- `catalog_item_usages`:
  - جدول ربط متعدد لمتعدد يربط الصنف بخطوط الاستخدام المطبقة عليه كوسوم تنظيمية (لا تمثل BOM):
  - الحقول: `item_id`, `application_line_id`, `created_at`.
- `catalog_items`:
  - كود الصنف، الاسم بالعربية (`name_ar`)، الوحدة الأساسية (`unit_id`).
  - التصنيف الهيكلي (`category_id`): مفتاح أجنبي يشير إلى `item_categories.id`.
  - حالة التصنيف (`classification_status`):
    - `confirmed`: معتمد هيكلياً ولغوياً.
    - `suggested`: مقترح ويحتاج تثبيت مواصفة.
    - `needs_review`: قيد التدقيق والاستيضاح الإلزامي.
    - `not_applicable`: غير مطابق.
  - المواصفات الفنية (`attributes`): عمود من نوع `JSONB` لتخزين الأبعاد والخصائص المتغيرة (مثل: `width_cm`, `weight_gsm`, `material`).
  - حد إعادة الطلب (`reorder_level`): حقل رقمي لتنبيهات النقص؛ القيمة 0 تعني تعطيل التنبيه.
  - تصنيف نوع الصنف (`item_type`):
    - `fabric`: أقمشة وخامات أساسية.
    - `accessory`: إكسسوارات ومستهلكات تشغيل ومكونات ملابس مقصوصة (أزرار، خيوط، كباسين، أساور، ياقات).
    - `maintenance_supply`: مستلزمات الصيانة والآلات (زيوت، إبر، قطع غيار).
    - `reusable_tool`: أدوات عمل قابلة لإعادة الاستخدام كالأصول والعهد (مقصات يد، باترونات).
    - `packaging`: مواد تعبئة وتغليف (كراتين، أكياس، علب، أشرطة لاصقة).
    - `finished_garment`: ملابس جاهزة ومنتج تام (يقتصر على جدول الأصناف ولا يتداخل مع أكواد `FG-VAR-*`).
  - `is_consumable`: حقل منطقي يحدد هل الصنف يستهلك بالدفعة تلقائياً أم يُعاد استخدامه (الأدوات والباترونات لها `is_consumable = False`).
  - `is_active`: حالة تفعيل الصنف تشغيلياً.
  - **قيد اتساق التفعيل والاعتماد (Migration 0013):**
    - `ck_catalog_items_active_consistency` = `NOT is_active OR approval_status = 'approved'`.
    - الأصناف غير المعتمدة (`draft`, `pending_review`, `rejected`) لا يمكن أن تكون نشطة إطلاقاً (`is_active = FALSE`).
    - فقط الأصناف المعتمدة (`approved`) يمكن تفعيلها (`is_active = TRUE`) أو تعطيلها (`is_active = FALSE`).
  - حقول حوكمة دورة الاعتماد (Migrations 0012 & 0013):
    - `approval_status`: حالة الاعتماد الرسمية (`draft`, `pending_review`, `approved`, `rejected`).
    - `rejection_reason`: نص سبب الرفض الإلزامي عند رفض الاعتماد من الإدارة.
    - `submitted_at`, `submitted_by`: تاريخ ومُعرّف مقدم الصنف للمراجعة.
    - `approved_at`, `approved_by`: تاريخ ومُعرّف معتمد الصنف (يكون `NULL` للأصناف التاريخية المعتمدة تشغيلياً فقط).
- `catalog_item_revisions`:
  - جدول طلبات تعديل الأصناف المعتمدة (Pending Revisions Model):
  - الحقول: `id`, `item_id`, `revision_number`, `status` (`pending_review`, `applied`, `rejected`, `cancelled`), `proposed_changes` (`JSONB`), `change_summary`, `base_fingerprint`, `submitted_by`, `submitted_at`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `created_at`.
  - الفهرس الفريد الجزئي لمنع التعدد المفتوح: `uq_catalog_item_single_open_revision` على `(item_id) WHERE status = 'pending_review'`.
  - **قيد حماية الوثائق التاريخية:** يُحظر تماماً تقديم أو اعتماد طلب تعديل يتضمن تغيير الاسم بالعربية (`name_ar`) لأي صنف ارتبط بحركات مخزنية أو فواتير موردين أو أوامر تشغيل سابقة (HTTP 409 Conflict)، لحماية سلامة المستندات التاريخية من التشويه بأثر رجعي.
- `catalog_approval_history`:
  - السجل التاريخي الكامل وغير القابل للتعديل أو المسح لحركات اعتماد ومراجعات الأصناف (Append-Only Audit History):
  - الحقول: `id`, `item_id`, `revision_id`, `event_type`, `from_status`, `to_status`, `actor_id`, `actor_role`, `reason`, `before_snapshot` (`JSONB`), `after_snapshot` (`JSONB`), `created_at`.
  - أنواع الأحداث المعتمدة (`event_type`):
    - `created`, `submitted`, `approved`, `rejected`, `reopened`, `deactivated`, `reactivated`, `revision_submitted`, `revision_approved`, `revision_rejected`, `revision_cancelled`.
    - `legacy_clarification` (Migration 0013): توثيق الاعتماد التشغيلي الانتقالي للأصناف التاريخية لضمان استمرارية المخزون مع إبقاء اعتماد المواصفات معلقاً بانتظار قرار المصنع.
  - محمي بواسطة PostgreSQL Trigger: `trg_catalog_approval_history_prevent_update_delete` لمنع أي عمليات `UPDATE` أو `DELETE`.
- `stock_ledger_entries`:
  - السجل التاريخي غير القابل للتعديل أو المسح لحركات المخزون.
  - `item_id`, `unit_id`, `warehouse_id`, `location_type`, `quantity` (موجبة للإيداع وسالبة للصرف), `reference_doc_type`, `reference_doc_id`, `entry_type`, `created_at`, `created_by`.

---

## 3. المنتجات والموديلات والمتغيرات (Products & Variants)

- `products`:
  - `code`, `name_ar`, `style_type`:
    - `half_collar_cuff`: جلابية نصف لياقة مع كفتة.
    - `half_collar_balto`: جلابية نصف لياقة بالطو.
    - `full_collar_cuff`: جلابية لياقة كاملة مع كفتة.
    - `full_collar_balto`: جلابية لياقة كاملة بالطو.
    - `short_sleeve_galabeya`: جلابية نص كم.
    - `sharwal`: شروال.
  - `description`.
- `product_variants`:
  - المتغيرات التابعة للموديل:
    - `product_id`.
    - `numeric_size`: المقاس الرقمي (56, 58, 60, 62, 64).
    - `letter_size`: المقاس الحرفي كبُعد مستقل (S, M, L, XL, 2XL) دون فرض تطابق حسابي ثابت بانتظار قرار المصنع.
    - `season`: الموسم المعتمد (`summer`, `autumn`, `winter`).
    - `sku`: رمز مميز للمتغير.

---

## 4. قوالب الإنتاج وإصداراتها (Production Templates)

- `production_templates`:
  - كود القالب، الاسم، المنتج المرتبط `product_id`.
  - `is_active`.
- `production_template_versions`:
  - `template_id`, `version_number`, `status` (`draft`, `approved`, `archived`).
  - `reference_quantity`: الكمية المرجعية التي حُسبت على أساسها الخامات (مثال: 100 قطعة).
  - `notes`.
- `production_template_lines`:
  - `version_id`.
  - `item_id`: صنف الدليل.
  - `unit_id`: وحدة القياس.
  - `quantity_per_reference`: الكمية المطلوبة للكمية المرجعية.
  - `notes`.

---

## 5. أوامر التشغيل ولقطة المواد (Production Orders & Material Snapshots)

- `production_orders`:
  - `order_number`: رقم تسلسلي فريد لأمر التشغيل (مثل `PO-2026-001`).
  - `product_id`, `variant_id`: حقول رأس الأمر التوافقية للموديل الأساسي.
  - `template_version_id`: القالب المستخدم (اختياري، يمكن الإنشاء من الصفر أو من قالب).
  - `target_quantity`: إجمالي الكمية المستهدفة لدفعة التشغيل.
  - `season`: الموسم التشغيلي.
  - `status`: حالة الأمر (`draft`, `materials_dispatched`, `in_production`, `completed`, `cancelled`).
  - `created_by`, `assigned_to`, `created_at`, `notes`.
- `production_order_items` (بنود أمر التشغيل المتعددة):
  - يدعم الأمر احتواء عدة موديلات أو مقاسات ومواصفات أقمشة مختلفة ضمن نفس الدفعة:
  - `order_id`: معرّف أمر التشغيل التابع له.
  - `product_id`, `variant_id`: الموديل والمتغير (المقاس والموسم).
  - `product_type`: تصنيف المنتج (`factory_brand` لمنتجات القمة، `private_label` للتصنيع للغير).
  - `customer_id`: عميل التصنيع للغير (إلزامي إذا كان `private_label`).
  - `template_version_id`: قالب التشغيل للبند المحدد.
  - `target_quantity`: الكمية المستهدفة للبند.
  - `season`: موسم البند.
  - مواصفات القماش: `fabric_area` (مساحة القماش)، `fabric_name` (اسم القماش)، `fabric_color` (لون القماش)، `fabric_weight` (وزن القماش).
  - `notes`: ملاحظات البند.
- `production_order_materials` (لقطة الخامات المجمدة - Snapshot):
  - تحفظ الخطة المستقلة للدفعة بحيث لا تتأثر بتعديل القوالب أو الأصناف لاحقاً.
  - `order_id`, `item_id`, `unit_id`.
  - `planned_quantity`: الكمية المحتسبة نسبياً `(target_quantity / reference_quantity) * quantity_per_reference`.
  - `dispatched_quantity`: الكمية المصروفة فعلياً من مخزن الخامات.
  - `received_quantity`: الكمية المستلمة فعلياً في مخزن تحت التشغيل.
  - `discrepancy_quantity`: الفرق المسجل بين الصرف والاستلام.
  - `status`: (`pending`, `dispatched`, `received_with_discrepancy`, `received_complete`).
  - `item_name_snapshot` (Migration 0013): لقطة نصية مجمدة لاسم الصنف بالعربية وقت إنشاء الأمر، لحماية الوثائق التاريخية من التغير عند تعديل الصنف بالدليل مستقبلاً.

---

## 6. التحويلات المخزنية وتأكيد الاستلام (Warehouse Transfers & Receipts)

- `warehouse_transfers`:
  - `transfer_number`: رقم مستند التحويل.
  - `order_id`: أمر التشغيل المرتبط.
  - `source_warehouse_id`: مخزن الخامات الرئيسي.
  - `destination_warehouse_id`: مخزن تحت التشغيل.
  - `status`: (`in_transit`, `partially_received`, `received_confirmed`, `cancelled`).
  - `dispatched_at`, `dispatched_by`.
  - `received_at`, `received_by`: تأكيد أمين مخزن تحت التشغيل.
  - `notes`.
- `warehouse_transfer_lines`:
  - `transfer_id`, `item_id`, `unit_id`.
  - `dispatched_quantity`: الكمية الخارجة من المخزن الرئيسي (تُسجل كـ in-transit وتخفض رصيد المصدر).
  - `received_quantity`: الكمية المقبولة في مخزن تحت التشغيل.
  - `discrepancy_quantity`: أي نقص أو زيادة مسجلة دون مسح أثر التحويل.
  - `notes`.

---

## 7. تتبع مراحل الإنتاج (Production Stages & Events)

- المراحل الخمس المعتمدة تتابعياً:
  1. `cutting`: القص على الباترون.
  2. `finishing`: التشطيب.
  3. `snap_installation`: تركيب الكبسولة.
  4. `ironing`: الكي.
  5. `packing`: التعبئة والتغليف.
- `production_stage_events`:
  - `order_id`.
  - `stage_name`: اسم المرحلة.
  - `status`: (`not_started`, `in_progress`, `completed`).
  - `actor_id`: المستخدم المنفذ.
  - `actor_name`: اسم المسؤول.
  - `timestamp`: وقت تغيير الحالة.
  - `notes`: ملاحظات الوردية أو العمال.

---

## 8. الجداول التأسيسية للوحدات المتبقية (Foundational Schemas)

تمثيل هيكلي فقط دون فرض معادلات مالية أو قواعد اعتماد مغلقة:

- `customers`: `id`, `name`, `code`, `phone`, `city`, `address`, `status`, `created_at`.
- `customer_orders`: `customer_id`, `order_type` (`ready_goods`, `custom_manufacturing`), الحالة، التاريخ والموعد المتوقع، خصم إجمالي مؤقت، نص شروط التعامل، والمنشئ.
- `customer_order_lines`: موديل ومقاس/موسم وكمية وسعر وحدة مسجل. بند التصنيع يمكن ربطه بعدة أوامر تشغيل جزئية عبر `production_orders.customer_order_line_id`.
- `customer_deliveries` و`customer_delivery_lines`: دفعات تسليم مستقلة مرتبطة بالطلب وبنوده، مع المستلم والتاريخ والمنشئ.
- `customer_payments`: إيصالات تحصيل مستقلة مرتبطة بالطلب، تشمل المبلغ والطريقة والمرجع والمسجل. لا تُحذف أو تعدل عبر واجهة العميل الحالية.
- تعرض صفحة العميل الطلبات المرتبطة بها والتسليمات والتحصيلات والرصيد المحسوب مبدئيًا من إجمالي الطلب ناقص التحصيلات المسجلة.
- `employees`: `id`, `name`, `code`, `department`, `job_title`, `status`, `hire_date`.
- `pay_periods`: `id`, `period_name`, `start_date`, `end_date`, `status` (`draft`, `approved`, `closed`).
- `payroll_runs`: `id`, `period_id`, `employee_id`, `net_amount`, `notes`.
- `daily_expenses`: `id`, `expense_date`, `category`, `amount`, `description`, `created_by`, `status`.

### افتراضات مؤقتة لسجل العميل

- نوع المعاملة يُحدد على مستوى الطلب، لذلك يمكن للعميل نفسه شراء منتج جاهز وطلب تصنيع خاص في معاملات مختلفة.
- يمكن إنشاء عدة دفعات تسليم على الطلب، ولا تتجاوز الكمية المسجلة كمية بند الطلب. هذا التوثيق لا يحجز ولا يخصم مخزون المنتج التام.
- يمكن ربط عدة أوامر تشغيل ببند تصنيع واحد على دفعات؛ لا يتجاوز مجموع كمياتها كمية الطلب. الصرف المخزني يظل ضمن دورة الإنتاج الحالية.
- المدفوعات تُحفظ كإيصالات تشغيلية ويحسب منها رصيد مبدئي للطلب؛ لا تنشئ قيودًا أو حركات نقدية محاسبية.
- هذه الافتراضات مؤقتة للمراجعة مع المصنع، ولا تمثل اعتمادًا نهائيًا لسياسة البيع أو الخصم أو الائتمان.
