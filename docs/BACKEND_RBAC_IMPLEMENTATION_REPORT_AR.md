# تقرير إعادة هيكلة وتطبيق نظام الصلاحيات والتفويض الخادمي
**Qema ERP — Task 02: Backend RBAC Restructuring Report**
*توثيق سجل الصلاحيات المركزي، مصفوفة الأدوار، قواعد حجب البيانات (Data Scope)، وفصل الصانع عن المعتمد (Maker-Checker)*

---

## 1. الملخص التنفيذي (Executive Summary)

تم تنفيذ **المرحلة الثانية (TASK 02 — QEMA ERP BACKEND RBAC RESTRUCTURING)** بنجاح كامل، حيث أُعيد بناء نظام الصلاحيات والتفويض في الواجهة الخلفية (Backend) لمشروع Qema ERP وفق أفضل الممارسات الهندسية الصارمة للمؤسسات، واستناداً إلى نتائج الاكتشاف والتدقيق المعماري في **TASK 01**.

### أهم المنجزات المنفذة:
1. **إنشاء سجل الصلاحيات المركزي (Central Permission Registry):** توحيد 38 صلاحية إجرائية محددة بدقة في فئات عمل وإجراءات معيارية (`view`, `create`, `submit`, `execute`, `review`, `approve`, `post`, `cancel`).
2. **فصل الأدوار عن الصلاحيات واستحداث دور مدير الإنتاج (`production_manager`):** تم رفع العبء التنفيذي اليومي عن المدير العام بنقل مهام متابعة مراحل الإنتاج، إثبات العيوب، وإدارة الخامات لقائد التشغيل الميداني، مع الاحتفاظ بـ Maker-Checker وحوكمة الاعتمادات للمدير العام.
3. **تصحيح ثغرة الرواتب لمدير المالية:** تمكين مدير المالية من استعراض واحتساب كشوف الرواتب دون أي تعارض برمجي.
4. **تطبيق قواعد الصانع والمعتمد (Maker-Checker) خادمياً:**
   - منع منشئ المستند النقدي من اعتماده أو رفضه بنفسه (`decide_cash_document`).
   - منع منشئ أو مقدم جلسة الجرد من مراجعتها أو اعتمادها أو ترحيل قيود تسوياتها المخزنية بنفسه (`review_stocktake`, `post_stocktake_adjustments`).
   - الحفاظ على قيود Maker-Checker المطبقة في اعتماد وتعديل أصناف دليل الكتالوج (`catalog.py`).
5. **تطبيق نطاق وحجب البيانات (Data Scope):** حجب أسعار التوريد، إجمالي الفواتير، والمديونيات في مسارات فواتير الموردين عن أمين المخزن (`warehouse_manager`)، مع تمكينه من رؤية الكميات والأصناف الموردة ومطابقتها فحصاً واستلاماً.
6. **تسجيل محاولات الوصول المرفوضة في سجل التدقيق (Audit Logging):** تسجيل تحذيرات منظمة (`qemma.rbac`) تتضمن معرف المستخدم، الصلاحية المطلوبة، أدوار المستخدم، المسار، الطريقة، ومعرف الطلب، دون تسجيل أي أسرار أو توكنات.
7. **تحديث بيئة التطوير والتبديل المحلي (LOCAL DEV MODE):** إضافة دور `production_manager` بهوية اصطناعية مستقلة ومستقرة، وتحديث نافذة تسجيل الدخول `SignInModal.tsx` وسياق `AuthContext.tsx`.

---

## 2. سجل الصلاحيات المركزي (Central Permission Registry)

تم تعريف الصلاحيات ككائنات معيارية `PermissionDefinition(code, module, action, description_ar)` داخل `apps/api/app/core/permissions.py`:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PERMISSION REGISTRY                                         │
├──────────────────────────────┬────────────┬─────────┬───────────────────────────────────────┤
│ الكود البرمجي (Code)         │ الوحدة     │ الإجراء │ التوصيف والمسؤولية التشغيلية          │
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ catalog:view                 │ catalog    │ view    │ عرض دليل الأصناف والتصنيفات والشجرة   │
│ catalog:item:create          │ catalog    │ create  │ إنشاء مسودة صنف جديد                  │
│ catalog:item:update          │ catalog    │ create  │ تحديث وتعديل مسودة صنف                │
│ catalog:item:submit          │ catalog    │ submit  │ تقديم مسودة صنف للاعتماد              │
│ catalog:item:approve         │ catalog    │ approve │ اعتماد وتفعيل الصنف رسمياً             │
│ catalog:item:reject          │ catalog    │ review  │ رفض اعتماد مسودة صنف                  │
│ catalog:item:request_revision│ catalog    │ submit  │ تقديم طلب تعديل صنف معتمد             │
│ catalog:item:manage_revisions│ catalog    │ approve │ إدارة واعتماد طلبات تعديل الأصناف     │
│ catalog:item:deactivate      │ catalog    │ cancel  │ تعطيل صنف معتمد                       │
│ catalog:item:reactivate      │ catalog    │ execute │ إعادة تفعيل صنف معطل                  │
│ catalog:item:view_history    │ catalog    │ view    │ استعراض سجل تدقيق وتاريخ الصنف        │
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ inventory:view               │ inventory  │ view    │ عرض أرصدة المخازن والدفاتر والتقارير │
│ inventory:manage             │ inventory  │ execute │ إدارة وتعديل بيانات المخازن           │
│ warehouse:confirm_receipt    │ inventory  │ execute │ تأكيد استلام مواد أو منتج تام بالمخزن │
│ warehouse:dispatch           │ inventory  │ execute │ صرف خامات لأوامر التشغيل              │
│ inventory:stocktake:view     │ inventory  │ view    │ استعراض جلسات الجرد وخطوط العد        │
│ inventory:stocktake:create   │ inventory  │ create  │ إنشاء جلسة جرد جديدة وأخذ اللقطة      │
│ inventory:stocktake:count    │ inventory  │ execute │ تسجيل وتحديث العد الميداني            │
│ inventory:stocktake:submit   │ inventory  │ submit  │ تقديم جلسة الجرد للمراجعة             │
│ inventory:stocktake:review   │ inventory  │ review  │ مراجعة فروقات الجرد وفحص التسويات     │
│ inventory:stocktake:approve  │ inventory  │ approve │ الاعتماد الرسمي لفروقات الجرد         │
│ inventory:stocktake:post     │ inventory  │ post    │ ترحيل قيود التسوية المخزنية الدفترية  │
│ inventory:stocktake:cancel   │ inventory  │ cancel  │ إلغاء جلسة جرد مفتوحة                 │
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ production:orders:view       │ production │ view    │ استعراض أوامر التشغيل والمراحل        │
│ production:orders:create     │ production │ create  │ إنشاء أمر تشغيل تصنيع جديد            │
│ production:orders:manage     │ production │ execute │ إدارة أوامر التشغيل والخامات والعيوب  │
│ production:stages:manage     │ production │ execute │ تسجيل وتأكيد مراحل الإنتاج والتراجع   │
│ production:templates:manage  │ production │ create  │ إنشاء وإدارة قوالب التشغيل (BOM)      │
│ production:orders:close      │ production │ approve │ إغلاق أمر التشغيل بعد تسوية WIP       │
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ finance:cash:view            │ finance    │ view    │ استعراض حسابات الخزينة وسندات النقدية │
│ finance:cash:create          │ finance    │ create  │ إنشاء طلب أو سند صرف نقدي             │
│ finance:cash:manage          │ finance    │ execute │ إدارة الحسابات النقدية والعهد         │
│ finance:cash:approve         │ finance    │ approve │ اعتماد سندات الصرف والتحويل النقدي    │
│ finance:expenses:manage      │ finance    │ execute │ تسجيل وإدارة المصروفات التشغيلية      │
│ finance:payments:manage      │ finance    │ execute │ تسجيل إيصالات التحصيل ومقبوضات العملاء│
│ finance:payroll:view         │ payroll    │ view    │ استعراض فترات وكشوف الرواتب           │
│ finance:payroll:calculate    │ payroll    │ execute │ إعداد واحتساب كشف أجور الفترة         │
│ finance:payroll:disburse     │ payroll    │ post    │ اعتماد وصرف كشف المرتبات من الخزينة   │
│ finance:payroll:manage       │ payroll    │ execute │ إدارة الموظفين والحضور والرواتب       │
│ finance:manage               │ finance    │ review  │ الإدارة والرقابة المالية العامة       │
│ finance:reports:view         │ finance    │ view    │ استعراض التقارير المالية ومؤشرات السيولة│
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ customers:view               │ customers  │ view    │ استعراض بيانات العملاء وحساباتهم      │
│ customers:manage             │ customers  │ execute │ إنشاء وتعديل العملاء وطلبات البيع     │
│ customers:deliveries:manage  │ customers  │ execute │ صرف وتسليم البضاعة التامة والمرتجعات  │
│ pricing:manage               │ customers  │ execute │ إدارة قوائم الأسعار وشروط الخصم والبيع│
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ suppliers:view               │ suppliers  │ view    │ استعراض الموردين وفواتير الشراء       │
│ suppliers:manage             │ suppliers  │ execute │ إنشاء موردين وفواتير شراء وسداد الدفعات│
│ suppliers:receive            │ suppliers  │ execute │ إثبات استلام وتوريد الخامات بالمخزن   │
├──────────────────────────────┼────────────┼─────────┼───────────────────────────────────────┤
│ reports:view                 │ reports    │ view    │ استعراض لوحة التشغيل والتقارير التنفيذية│
│ admin:users:manage           │ identity   │ approve │ إدارة المستخدمين والأدوار             │
└──────────────────────────────┴────────────┴─────────┴───────────────────────────────────────┘
```

---

## 3. مصفوفة الأدوار والصلاحيات (Role-Permission Mapping)

تم ربط الصلاحيات بالأدوار الأربعة بدقة:

### 1. المدير العام (`ROLE_GENERAL_MANAGER`)
- **الدور والمسؤولية:** الرقابة الشاملة، الاعتمادات النهائية، الحوكمة، وإغلاق الملفات التشغيلية.
- **الصلاحيات الممنوحة:**
  - `admin:users:manage`, `reports:view`, `pricing:manage`, `customers:manage`, `customers:view`, `customers:deliveries:manage`
  - `catalog:view`, `catalog:item:create`, `catalog:item:update`, `catalog:item:submit`, `catalog:item:approve`, `catalog:item:reject`, `catalog:item:request_revision`, `catalog:item:manage_revisions`, `catalog:item:deactivate`, `catalog:item:reactivate`, `catalog:item:view_history`
  - `inventory:view`, `inventory:manage`, `inventory:stocktake:view`, `inventory:stocktake:create`, `inventory:stocktake:count`, `inventory:stocktake:submit`, `inventory:stocktake:review`, `inventory:stocktake:approve`, `inventory:stocktake:post`, `inventory:stocktake:cancel`
  - `warehouse:confirm_receipt`, `warehouse:dispatch`
  - `production:templates:manage`, `production:orders:view`, `production:orders:create`, `production:orders:manage`, `production:stages:manage`, `production:orders:close`
  - `suppliers:view`, `suppliers:manage`, `suppliers:receive`
  - `finance:manage`, `finance:cash:view`, `finance:cash:approve`, `finance:payroll:view`, `finance:payroll:disburse`, `finance:payroll:manage`, `finance:reports:view`

### 2. مدير الإنتاج / قائد التشغيل (`ROLE_PRODUCTION_MANAGER`)
- **الدور والمسؤولية:** القيادة الميدانية لخطوط الإنتاج، متابعة أوامر التشغيل، تأكيد استلام الخامات بمخزن تحت التشغيل (WIP)، تنفيذ مراحل التصنيع الخمس، تسجيل العيوب، وإثبات الاستهلاك الفعلي.
- **الصلاحيات الممنوحة:**
  - `production:orders:view`
  - `production:orders:create`
  - `production:orders:manage` (إدارة خامات الأمر وإثبات العيوب)
  - `production:stages:manage` (تنفيذ مراحل القص، التشطيب، الكبسولة، الكي، والتعبئة، والتراجع الفني)
  - `production:templates:manage` (إدارة قوالب التشغيل)
  - `inventory:view` (استعراض أرصدة الخامات و WIP)
  - `catalog:view` (استعراض مواصفات ورموز الأصناف)
  - `warehouse:confirm_receipt` (تأكيد استلام الخامات المحولة إلى صالة الإنتاج)
  - `reports:view` (متابعة مؤشرات أداء التشغيل)

### 3. أمين المخزن (`ROLE_WAREHOUSE_MANAGER`)
- **الدور والمسؤولية:** إدارة المخازن المادية الثلاثة (خامات، تحت التشغيل، منتج تام)، استلام التوريدات، صرف الخامات للإنتاج، فحص واستلام المنتج التام، تسليم طلبيات العملاء، والجرد الميداني.
- **الصلاحيات الممنوحة:**
  - `inventory:view`, `inventory:manage`
  - `inventory:stocktake:view`, `inventory:stocktake:create`, `inventory:stocktake:count`, `inventory:stocktake:submit`, `inventory:stocktake:cancel`
  - `catalog:view`, `catalog:item:create`, `catalog:item:update`, `catalog:item:submit`, `catalog:item:request_revision`, `catalog:item:view_history`
  - `warehouse:confirm_receipt`, `warehouse:dispatch`
  - `production:orders:view` (لمعرفة الخامات المطلوب تجهيزها وتوريدها)
  - `customers:deliveries:manage` (شحن وتسليم المنتجات للعملاء وإثبات المرتجعات)
  - `suppliers:view` (استعراض بيانات الشحنات وأصناف التوريد), `suppliers:receive` (إثبات استلام التوريد الفعلي)

### 4. مدير المالية (`ROLE_FINANCE_MANAGER`)
- **الدور والمسؤولية:** إدارة الخزينة والحسابات النقدية، تسجيل الإيرادات والمصروفات، متابعة مستحقات ومدفوعات الموردين، تحصيل أموال العملاء، إعداد واحتساب الرواتب، والمراجعة المالية لجلسات الجرد.
- **الصلاحيات الممنوحة:**
  - `finance:cash:view`, `finance:cash:create`, `finance:cash:manage`, `finance:expenses:manage`
  - `finance:payments:manage` (تحصيلات العملاء)
  - `finance:payroll:view`, `finance:payroll:calculate`, `finance:payroll:manage`, `finance:manage`
  - `finance:reports:view`, `reports:view`
  - `suppliers:view`, `suppliers:manage` (فواتير ودفعات الموردين)
  - `customers:view` (استعراض حسابات ومديونيات العملاء)
  - `production:orders:view` (متابعة أوامر التشغيل لحساب تكاليف الدفعات)
  - `inventory:stocktake:view`, `inventory:stocktake:review` (المراجعة المالية لفروقات الجرد وقيم العجز والزيادة)

---

## 4. قواعد الفصل الرقابي (Maker-Checker Rules)

تم تطبيق قيود Maker-Checker خادمياً على مستوى كود المعاملات الذرية:

1. **المستندات النقدية وسندات الصرف (`Cash Documents`):**
   - **المنشئ:** مدير المالية (`finance:cash:create` / `finance:cash:manage`).
   - **المعتمد:** المدير العام (`finance:cash:approve`).
   - **القيد الخادمي المطبق في `decide_cash_document`:**
     ```python
     if document.created_by and document.created_by == user_id:
         raise HTTPException(
             status_code=409,
             detail="لا يجوز لمنشئ المستند النقدي اعتماده أو رفضه بنفسه وفق قواعد الرقابة المالية (Maker-Checker).",
         )
     ```
2. **جلسات الجرد والتسويات المخزنية (`Stocktake Sessions`):**
   - **المنشئ والعداد الميداني:** أمين المخزن (`inventory:stocktake:create`, `inventory:stocktake:count`, `inventory:stocktake:submit`).
   - **المراجع والمعتمد:** مدير المالية (مراجعة) والمدير العام (اعتماد وترحيل).
   - **القيود الخادمية المطبقة في `review_stocktake` و `post_stocktake_adjustments`:**
     ```python
     # في دالة review_stocktake:
     if (stocktake.created_by and stocktake.created_by == reviewer_id) or (getattr(stocktake, "submitted_by", None) and stocktake.submitted_by == reviewer_id):
         raise HTTPException(
             status_code=409,
             detail="لا يجوز لمنشئ أو مقدم جلسة الجرد اعتمادها بنفسه وفق قواعد الفصل الرقابي (Maker-Checker).",
         )

     # في دالة post_stocktake_adjustments:
     if (stocktake.created_by and stocktake.created_by == poster_id) or (getattr(stocktake, "submitted_by", None) and stocktake.submitted_by == poster_id):
         raise HTTPException(
             status_code=409,
             detail="لا يجوز لمنشئ أو مقدم جلسة الجرد ترحيل قيود التسوية بنفسه وفق قواعد الفصل الرقابي (Maker-Checker).",
         )
     ```
3. **أصناف دليل الكتالوج وتعديلاتها (`Catalog Items & Revisions`):**
   - **المنشئ:** أمين المخزن (`catalog:item:create`, `catalog:item:submit`).
   - **المعتمد:** المدير العام (`catalog:item:approve`).
   - **القيد الخادمي المطبق في `approve_catalog_item` و `approve_item_revision`:**
     منع من قدم الصنف أو طلب التعديل (`submitted_by == current_user.id`) من اعتماده ذاتياً بـ `HTTP 409 Conflict`.

---

## 5. قواعد نطاق وحجب البيانات (Data Scope Rules)

- **حجب أسعار فواتير الشراء عن أمين المخزن (Supplier Invoice Pricing Masking):**
  - في مسار `GET /api/v1/finance/supplier-invoices` و `POST /receive`:
  - إذا كان المستخدم ينتمي حصراً لمخازن المصنع دون صفة مالية، يُنفذ حجب آلي فوري:
    ```python
    can_view_prices = bool(user_roles.intersection({"general_manager", "finance_manager"}))
    unit_price = line.unit_price if can_view_prices else Decimal("0.00")
    paid_total = Decimal(str(paid or 0)) if can_view_prices else Decimal("0.00")
    invoice_total = invoice.invoice_total if can_view_prices else Decimal("0.00")
    balance_due = max(Decimal("0"), invoice.invoice_total - paid) if can_view_prices else Decimal("0.00")
    ```
  - يرى أمين المخزن: رقم الفاتورة، اسم المورد، الأصناف، الكميات المطلوبة، والكميات المستلمة، مع حجب الأسعار ومبالغ الفاتورة الصافية.

---

## 6. تسجيل التدقيق الأمني (Security Audit Logging)

تم تحديث دوال التفويض `require_permission`, `require_any_permission`, `require_any_role` لتسجيل محاولات الوصول غير المصرح بها:
- **المستوى:** `WARNING` عبر مسجل `qemma.rbac`.
- **البيانات المسجلة:**
  - `user_id`: المعرف الثابت للمستخدم (UUID).
  - `required_permission`: كود الصلاحية المطلوبة للعملية.
  - `roles`: قائمة الأدوار الحالية للمستخدم.
  - `method`: نوع طلب HTTP (`POST`, `PATCH`, `DELETE`...).
  - `path`: المسار المطلوب.
  - `request_id`: معرّف التتبع الفريد للطلب (`X-Request-ID`).
- **ضمانات الأمان:** لا يُسجل أي توكن، كلمة مرور، أو ادعاءات حساسة.

---

## 7. أثر قاعدة البيانات وبيئة التطوير المحلي (Database & Local Dev Mode)

- **تحديث قاعدة البيانات:**
  - تم إدراج سجل دور `production_manager` في جدول `roles` بقاعدة بيانات الاختبارات `qemma_test_db` ببياناته المعتمدة باللغة العربية.
  - تم تحديث دالة التهيئة المرجعية `seed_provisional_data_if_empty` في `apps/api/app/modules/production/service.py` لتضمين الدور تلقائياً.
- **تحديث المصادقة المحلية:**
  - تم تحديث القائمة البيضاء `ALLOWED_LOCAL_ROLES` في `auth.py`.
  - تم تسجيل الهوية الاصطناعية الرابعة:
    - الدور: `production_manager`
    - المعرف: `dev-user-00000000-0000-0000-0000-000000000004`
    - البريد الإلكتروني: `prod@qemma.local`
  - تم التحقق العملي عبر طلب `POST /api/v1/auth/local-login` وصدر التوكن بنجاح.
- **تحديث واجهة المستخدم (Frontend):**
  - تم تحديث مصفوفة الصلاحيات في `apps/web/src/features/auth/AuthContext.tsx`.
  - تم إضافة زر الدخول كمدير إنتاج في `apps/web/src/features/auth/SignInModal.tsx`.
  - تم تحديث قاموس الأسماء العربية للأدوار في `apps/web/src/App.tsx`.

---

## 8. الملفات التي تم تعديلها (Files Changed)

1. `apps/api/app/core/permissions.py`:
   - تعريف `PermissionDefinition` وسجل `PERMISSION_REGISTRY`.
   - إضافة `ROLE_PRODUCTION_MANAGER` إلى `PROVISIONAL_ROLES`.
   - إعادة بناء `ROLE_PERMISSIONS_MAP` بالكامل.
   - إضافة دالة `require_any_permission`.
   - إضافة تسجيل التدقيق الأمني لمحاولات الوصول المرفوضة في `require_permission` و `require_any_role`.
2. `apps/api/app/api/v1/endpoints/auth.py`:
   - إضافة `production_manager` إلى `ALLOWED_LOCAL_ROLES`.
   - إضافة الملف التعريفي الاصطناعي في `LOCAL_ROLE_PROFILES`.
3. `apps/api/app/modules/finance/service.py`:
   - إضافة قيد Maker-Checker الصارم في `decide_cash_document`.
4. `apps/api/app/modules/production/stocktake_service.py`:
   - إضافة قيد Maker-Checker في `review_stocktake`.
   - إضافة قيد Maker-Checker في `post_stocktake_adjustments`.
5. `apps/api/app/api/v1/endpoints/finance.py`:
   - تطبيق قاعدة Data Scope في `serialize_supplier_invoice` لحجب الأسعار والمديونيات عن موظفي المخازن.
6. `apps/api/app/modules/production/service.py`:
   - إضافة دور `production_manager` إلى بيانات التهيئة الأولية `seed_provisional_data_if_empty`.
7. `apps/web/src/features/auth/AuthContext.tsx`:
   - تحديث الصلاحيات وإضافة `production_manager`.
8. `apps/web/src/features/auth/SignInModal.tsx`:
   - إضافة خيار تبديل الدور إلى مدير الإنتاج في نافذة التطوير المحلي.
9. `apps/web/src/App.tsx`:
   - إضافة التسمية العربية لمدير الإنتاج في شريط المستخدم.

---

## 9. القيود والمخاطر المتبقية (Remaining Constraints & Decisions)

1. **حماية أزرار الواجهة الأمامية (Frontend Action Hiding):**
   - تم ضبط الحماية الخادمة بنسبة 100% بنظام Deny-by-default ورمي HTTP 403 / 409.
   - الخطوة التالية الموصى بها هي تحديث الواجهة الأمامية (Task 03 أو ما يليها) لإخفاء الأزرار غير المصرح بها بصرياً، لمنع محاولة المستخدم إرسال طلب محظور خادمياً.
2. **حدود اعتماد المصروفات المالية (Expense Thresholds):**
   - سقف المبالغ النقدية المسموح لمدير المالية باعتمادها مباشرة قبل طلب توقيع المدير العام ما زال قراراً مفتوحاً بانتظار اعتماد إدارة المصنع.
3. **دور المبيعات المستقل (`sales`):**
   - تم الإبقاء على إدارة العملاء والطلبيات لدى المدير العام مؤقتاً لحين موافقة المصنع على تخصيص دور ممثل مبيعات مستقل.

