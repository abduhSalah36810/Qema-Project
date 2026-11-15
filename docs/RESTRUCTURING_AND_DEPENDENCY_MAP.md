# Qema ERP — Restructuring & Cross-Module Dependency Map

> **Purpose:** Map the current Finance and adjacent navigation against the proposed Finance navigation, document every screen's disposition (`KEEP`, `ADAPT`, `NEW`, `CONSOLIDATE`, `DEPRECATE — APPROVAL REQUIRED`), and analyze all 20 cross-module dependencies.

---

## 1. Current Finance & Adjacent Navigation Tree (As Implemented in `apps/web/src/App.tsx`)

### 1.1 Current Navigation by Role

| Role | Current Top-Level Groups / Items in `App.tsx` | Rendered Component |
|---|---|---|
| **`general_manager`** (`GENERAL_NAV`) | • `inbox` — الرئيسية · مهامي<br>• `dashboard` — لوحة التشغيل<br>• **المشتريات (`procurement`)**: `finance-suppliers` (فواتير الشراء والاستلام)<br>• **المخازن (`warehouses`)**: `warehouse-raw`, `warehouse-finished`, `warehouse-stocktake`<br>• `batches` — أوامر التشغيل<br>• **المبيعات والتسليم (`deliveries`)**: `finance-customers` (العملاء وطلبات البيع), `orders` (تسليم طلبات العملاء), `customer-returns` (مرتجعات العملاء)<br>• **المالية (`finance`)**: `finance-treasury` (الخزينة والاعتمادات), `finance-operations` (سندات القبض والصرف), `finance-custody` (العهد والمصروفات), `finance-payroll` (الرواتب), `finance-reports` (التقارير)<br>• **البيانات الأساسية (`master-data-group`)**: `master-data` (الموردون والعملاء والموديلات), `warehouse-catalog` (دليل الخامات والأصناف) | `SupplierPurchasingView`<br>`CustomersView`<br>`CustomerDeliveriesView`<br>`CustomerReturnsView`<br>`TreasuryView`<br>`ReceiptsDisbursementsView`<br>`CustodyView`<br>`PayrollFinanceView`<br>`FinancialReportsView` |
| **`finance_manager`** (`FINANCE_NAV`) | • `inbox` — الرئيسية · مهامي واعتماداتي<br>• `finance-treasury` — الخزينة والاعتمادات<br>• `finance-customers` — العملاء والطلبات والتحصيل<br>• `customer-returns` — مرتجعات العملاء<br>• `finance-suppliers` — مستحقات الموردين *(renders same `SuppliersView`)*<br>• **المصروفات والإيرادات (`finance`)**: `finance-operations` (سندات القبض والصرف), `finance-custody` (العهد والمصروفات)<br>• `finance-payroll` — الرواتب<br>• `finance-reports` — التقارير<br>• **اعتماد الأصناف والجرد (`approvals`)**: `warehouse-catalog`, `warehouse-stocktake`<br>• `master-data` — البيانات الأساسية | Same components as above |
| **`warehouse_manager`** (`WAREHOUSE_NAV`) | • `inbox`, `finance-suppliers` (فواتير الشراء والاستلام — prices masked), `batches`, `orders`, `customer-returns`, `warehouses` group, `master-data-group`, `warehouse-guide` | `SupplierPurchasingView` (no prices) |
| **`production_manager`** (`PRODUCTION_NAV`) | • `inbox`, `batches`, `warehouse-raw`, `master-data`, `warehouse-catalog`, `dashboard` | No Finance screens |

### 1.2 Orphaned / Hidden Routes in `App.tsx`
- `finance-payments` (`PaymentsCollectionsView.tsx`) — defined in `App.tsx:41,258,911`, **absent from all 4 nav arrays**.
- `finance-revenues` & `finance-expenses` — route aliases to `ReceiptsDisbursementsView.tsx`, **absent from all 4 nav arrays**.
- `warehouse-reports` / `inventory-reports` — route aliases to `FinancialReportsView` (`initialTab="inventory"`), **absent from all 4 nav arrays**.
- `warehouse-machinery` (`MachineryView.tsx`) — **intentionally hidden** (`navigation.test.tsx:212`).

---

## 2. Proposed Finance Navigation Structure

### 2.1 Design Rationale
1. **Explicitly fulfills the 3 requested Finance pillars** (`Purchases`, `Sales`, `Reports`) while **preserving all independent Finance pillars** (`Treasury & Approvals`, `Cash Operations`, `Custody & Expenses`, `Payroll`) without forcing them awkwardly under Purchases/Sales/Reports.
2. **Shallow hierarchy (max 2 levels):** Avoids nested sub-sub-menus in the sidebar. Inside each section, clean horizontal sub-tabs (matching existing `FinancialReportsView` / `PayrollConceptView` patterns) organize subsections like *Create Purchase Invoice* & *Purchased Items*, or *Account Statements*, *Income Statement*, & *Balance Sheet*.
3. **Preserves Warehouse & Production workflows:** `warehouse_manager` keeps direct operational access to receiving (`finance-suppliers` / warehouse receiving), customer deliveries (`orders`), and returns (`customer-returns`) without seeing financial prices or Treasury/Reports.
4. **No duplicate business logic:** `Purchases` and `Sales` reuse `SupplierPurchasingView`, `CustomersView`, `CustomerAccountPage`, and `balances.py`.

### 2.2 Proposed Navigation Tree

#### A. For `general_manager` (`GENERAL_NAV`)
1. **الرئيسية · مهامي** (`inbox`) — *Independent*
2. **لوحة التشغيل** (`dashboard`) — *Independent*
3. **المخازن** (`warehouses` group) — *Independent Operational*:
   - مخزن الخامات (`warehouse-raw`)
   - مخزن المنتج التام (`warehouse-finished`)
   - الجرد (`warehouse-stocktake`)
4. **أوامر التشغيل** (`batches`) — *Independent Operational* *(includes Time Tracking & Internal/External classification)*
5. **المالية (`finance` / organized Finance sections — flat & clear):**
   - **المشتريات (`finance-purchases` group):**
     - فواتير الشراء والاستلام (`finance-suppliers` — includes *إنشاء فاتورة شراء*, receipt & payment requests)
     - الأصناف المشتراة (`finance-purchased-items` — **NEW**)
   - **المبيعات (`finance-sales` group):**
     - العملاء والطلبات والتحصيل (`finance-customers`)
     - الأصناف المباعة (`finance-sold-items` — **NEW**)
     - تسليم طلبات العملاء (`orders`)
     - مرتجعات العملاء (`customer-returns`)
   - **الخزينة والنقدية (`finance-cash` group):**
     - الخزينة والاعتمادات (`finance-treasury`)
     - سندات القبض والصرف (`finance-operations`)
     - العهد والمصروفات اليومية (`finance-custody`)
   - **الرواتب** (`finance-payroll`) — *Independent Finance Item*
   - **التقارير المالية** (`finance-reports`) — *Unified Reports Hub containing:*
     - Tab/Group 1: **كشوف الحسابات** (Customer, Supplier, Employee, Treasury, Custody, GL Account) — **ADAPT / NEW**
     - Tab/Group 2: **قائمة الدخل** (Detailed Income Statement + Drill-Down + Internal/External Mfg split in Phase 6) — **ADAPT**
     - Tab/Group 3: **الميزانية العمومية** (Balance Sheet — enabled once Phase 5 accounting foundations are verified) — **ADAPT / GATED**
     - Tab/Group 4: **ميزان المراجعة والقيود** (Trial Balance & Journal Entries) — **ADAPT / NEW UI**
     - Tab/Group 5: **التحليلات التشغيلية والمالية** (Overview, Cash Flow, Expense Analysis, Custody Recon, Payroll Cost, AR/AP Aging, Sales Analysis, Model Profitability, COGS, Inventory Valuation, WIP Valuation, Stock Health, Losses, Production Time Report) — **KEEP / ADAPT**
6. **البيانات الأساسية** (`master-data-group`):
   - الموردون والعملاء والموديلات (`master-data`)
   - دليل الخامات والأصناف (`warehouse-catalog`)

#### B. For `finance_manager` (`FINANCE_NAV`)
Mirrors the exact same clean Finance grouping (so old vs. new structures never diverge), plus `finance_manager`'s governance approvals:
1. **الرئيسية · مهامي واعتماداتي** (`inbox`)
2. **المشتريات** (`finance-purchases` group):
   - فواتير ومستحقات الموردين (`finance-suppliers`)
   - الأصناف المشتراة (`finance-purchased-items` — **NEW**)
3. **المبيعات** (`finance-sales` group):
   - العملاء والطلبات والتحصيل (`finance-customers`)
   - الأصناف المباعة (`finance-sold-items` — **NEW**)
   - مرتجعات العملاء (`customer-returns`) *(view/credit tracking)*
4. **الخزينة والنقدية** (`finance-cash` group):
   - الخزينة والاعتمادات (`finance-treasury`)
   - سندات القبض والصرف (`finance-operations`)
   - العهد والمصروفات اليومية (`finance-custody`)
5. **الرواتب** (`finance-payroll`)
6. **التقارير المالية** (`finance-reports`) — *(Account Statements, Income Statement, Balance Sheet [gated], Trial Balance, Analytics)*
7. **اعتماد الأصناف والجرد** (`approvals` group): `warehouse-catalog`, `warehouse-stocktake`
8. **البيانات الأساسية** (`master-data`)

*(Note: `WAREHOUSE_NAV` and `PRODUCTION_NAV` remain unchanged in structure, preserving daily shop-floor simplicity; `WAREHOUSE_NAV` continues to open `SupplierPurchasingView` without prices for receiving goods.)*

---

## 3. Old-to-New Screen Mapping & Classification

| Old Screen / Route ID | Component File | Classification | Proposed Location | Change Type | Reuse Backend / DB? | Notes |
|---|---|---|---|---|---|---|
| `finance-suppliers` (فواتير الشراء والاستلام / مستحقات الموردين) | `SuppliersView.tsx` → `SupplierPurchasingView.tsx` | `ADAPT` | **Finance → Purchases** (Create Invoice, Receive, Request Payment) | Organizational + minor UI tabs/sub-headers | **Yes 100%** (`/finance/supplier-invoices*`) | Add clear "Create Purchase Invoice" action/tab; check `suppliers:invoices:create` for `finance_manager`. |
| *(Does not exist)* | *(New)* `PurchasedItemsView.tsx` | `NEW` | **Finance → Purchases → الأصناف المشتراة** | Frontend + New read-only API | **Yes** (`supplier_invoice_lines` + `supplier_invoices`) | No duplicate purchase table. |
| `finance-customers` (العملاء وطلبات البيع) | `CustomersView.tsx` → `CustomerAccountPage.tsx` | `KEEP` (Relocate under Finance → Sales) | **Finance → Sales → العملاء والطلبات والتحصيل** | Organizational (plus optional all-orders list) | **Yes 100%** (`/customers*`) | Preserves Order vs Delivery vs Return vs Collection separation. |
| *(Does not exist)* | *(New)* `SoldItemsView.tsx` | `NEW` | **Finance → Sales → الأصناف المباعة** | Frontend + New read-only API | **Yes** (`customer_order_lines` + `customer_delivery_lines` + `balances.py`) | No duplicate sales table. |
| `orders` (تسليم طلبات العملاء) | `CustomerDeliveriesView.tsx` | `KEEP` | **Finance → Sales** (for GM) & top-level for Warehouse | Organizational | **Yes 100%** | Operational delivery dispatch stays intact. |
| `customer-returns` (مرتجعات العملاء) | `CustomerReturnsView.tsx` | `KEEP` | **Finance → Sales** (for GM/FM) & top-level for Warehouse | Organizational | **Yes 100%** | Preserves quarantine & split inspection. |
| `finance-treasury` (الخزينة والاعتمادات) | `TreasuryView.tsx` | `KEEP` | **Finance → الخزينة والنقدية** | Organizational | **Yes 100%** | Remains single central approval screen. |
| `finance-operations` (`finance-revenues`, `finance-expenses`) | `ReceiptsDisbursementsView.tsx` | `ADAPT` (Keep in Phase 1, add category in Phase 5) | **Finance → الخزينة والنقدية → سندات القبض والصرف** | Organizational now; functional category mapping in Phase 5 | **Yes 100%** | Consolidate/keep hidden aliases `finance-revenues` / `finance-expenses` clean. |
| `finance-custody` (العهد والمصروفات) | `CustodyView.tsx` | `KEEP` | **Finance → الخزينة والنقدية → العهد والمصروفات** | Organizational | **Yes 100%** | Independent operational custody lifecycle preserved. |
| `finance-payroll` (الرواتب) | `PayrollFinanceView.tsx` → `PayrollConceptView.tsx` | `KEEP` (Adapt later for Labor Costing) | **Finance → الرواتب** (Independent) | Unchanged in Phase 1; Phase 6 integration | **Yes 100%** | Preserves HR/payroll access controls. |
| `finance-reports` (التقارير) | `FinancialReportsView.tsx` | `ADAPT` | **Finance → التقارير المالية** | Reorganize report groups to feature **Account Statements**, **Income Statement**, **Balance Sheet** first + Analytics | **Yes** + new/fixed endpoints | Fixes GL ledger bug, adds drill-down, adds statements & gated Balance Sheet. |
| `finance-payments` (المدفوعات والتحصيلات) | `PaymentsCollectionsView.tsx` | `DEPRECATE — APPROVAL REQUIRED` | Candidate for retirement in Phase 8 | Retirement after verification | — | See Section 4 below for mandatory 9-point retirement analysis. |
| `master-data` (الموردون والعملاء والموديلات) | `MasterDataView.tsx` | `KEEP` | **البيانات الأساسية** | Unchanged | **Yes 100%** | Shared across Procurement, Sales, Production, Payroll. |
| `warehouse-machinery` (الماكينات) | `MachineryView.tsx` | `KEEP` (Hidden / Deferred) | Hidden until Fixed Assets scope approved | Deferred | — | Out of initial scope unless Depreciation/Fixed Assets approved. |

---

## 4. Consolidation & Proposed Deprecation Analysis (`DEPRECATE — APPROVAL REQUIRED`)

> **Policy:** No screen or endpoint is deleted during this audit. Any retirement requires explicit owner approval after Phase 1–3 verification.

### Candidate: `PaymentsCollectionsView.tsx` (`routeId = 'finance-payments'`)
1. **Current Users:** Effectively **zero** via sidebar navigation (`finance-payments` is absent from `GENERAL_NAV`, `FINANCE_NAV`, `WAREHOUSE_NAV`, and `PRODUCTION_NAV` in `App.tsx`). Reachable only if navigated to programmatically.
2. **Backend Dependencies:** Calls only `GET /api/v1/finance/supplier-invoices` and `GET /api/v1/finance/cash-documents` (`financeApi.ts`). Has **no** dedicated backend endpoint.
3. **Database Records:** Read-only UI; owns zero tables or records.
4. **Replacement:**
   - Supplier invoice payment tracking & balances → `SupplierPurchasingView.tsx` + `FinancialReportsView` (`PayablesSection`, `SupplierStatementSection`).
   - Customer collections & cash inflows → `CustomerAccountPage.tsx` + `ReceiptsDisbursementsView.tsx` + `TreasuryView.tsx` + `CashFlowSection`.
5. **Proof of Coverage (with bug discovered):** `PaymentsCollectionsView.tsx:146-151` actually checks `inv.status === 'paid'` / `'partially_paid'`, which **never match** real `SupplierInvoice` statuses (`awaiting_receipt`, `partially_received`, `received`), displaying all invoices wrongly as "مستحقة بالكامل"! And its summary sums `inv.balance_due` (invoice total − paid) instead of authoritative `inv.payable_balance` (received value − paid). Thus the existing replacements are **more accurate and complete**.
6. **Historical Data Implications:** Zero — read-only view.
7. **Safe Migration Sequence:** Verify `SupplierPurchasingView` + `TreasuryView` + `CashFlowSection` cover all user checks during Phases 1–3 → remove `finance-payments` route & `PaymentsCollectionsView.tsx` in Phase 8 after owner sign-off.
8. **Risks of Removing:** Low (already unreachable from menus); only risk is if a test or shortcut references `'finance-payments'`.
9. **Is Removal Necessary?** Recommended in Phase 8 to eliminate dead/buggy code that reports inaccurate supplier balances.

### Candidate Endpoints / Aliases to Review for Consolidation:
- `GET /api/v1/reports/financial` (`reports.py:266`) vs `GET /api/v1/reports/cash-flow` + `/profit-and-loss`: Keep `/reports/financial` for backward API compatibility (`reportsApi.ts` exposes it; unit tests may call it), do not delete without checking tests.
- `POST /api/v1/finance/petty-cash/{account_id}/settle` (`reports`/`finance.py:774`) vs `POST /petty-cash/{account_id}/settlement` (`finance.py:740`): Both call `_create_custody_settlement`; keep both until API callers are audited.

---

## 5. Cross-Module Dependency Matrix (Part C)

| # | Module / Area | Current Source of Truth | Existing Relationship with Finance | Required Relationship | Scope of Change | Duplicate / Balance Inconsistency Risk | Migration Needed? | Integration Status |
|---|---|---|---|---|---|---|---|---|
| 1 | **Suppliers** | `suppliers` (`finance/models.py`) | Linked to `supplier_invoices`; managed in `MasterDataView` | Remains supplier master; linked to Purchases & Supplier Statement | **Finance-only** (UI link) | Low | No | **Works** |
| 2 | **Purchase Invoices** | `supplier_invoices`, `supplier_invoice_lines`, `supplier_payments` (`balances.py`) | Creates payable tracking; payment requests create `CashDocument` | Add `Purchased Items` read view; preserve invoice vs receipt separation; clarify FM create perm | **Finance-only** (plus RBAC check) | Medium if FM perm or taxes added inconsistently | Only if taxes/discounts extended | **Works** (Adapt UI) |
| 3 | **Raw-Material Warehouses** | `StockLedgerEntry` (`main_raw_materials`) | `SupplierReceipt` increases stock & WAC (`1210`); `WarehouseTransfer` issues to WIP (`1220`) | Must remain separate from Customer-Owned Materials (`cust_mat` bucket, zero `1210` value) | **Cross-module** (Inventory + Finance) | **High** if customer materials enter factory `1210` stock | Yes (Phase 6 `ownership_type`) | **Needs Adjustment** (for External Mfg) |
| 4 | **Inventory Receipts (`GRN`)** | `supplier_receipts` + `StockLedgerEntry` (`supplier_receipt`) | Posts `Dr 1210 / Cr 2100` for received qty × net unit cost | Add separate **Customer Material Receipt** (zero GL value) for External Mfg | **Cross-module** (Inventory + Production) | **High** if customer receipt posts AP `2100` | Yes (Phase 6) | **Works** (Internal); **Missing** (External) |
| 5 | **Inventory Issues** | `warehouse_transfers` (`dispatch_source`/`receipt_warehouse`) | Moves WAC cost `1210` → `1220` (`ProductionOrder.actual_material_cost`) | External Mfg: issue customer-owned materials with `cost=0`, factory-owned accessories with WAC | **Cross-module** (Production + Inventory) | **High** if mixed in same `ProductionOrderMaterial` without ownership flag | Yes (Phase 6) | **Needs Adjustment** (Phase 6) |
| 6 | **Customer-Owned Materials** | *(None — currently missing)* | Not tracked separately | Full custody lifecycle (`received = consumed + waste + remaining/returned`), zero factory asset/expense | **Cross-module** (Inventory + Production + Customers) | **Critical** — must never inflate `1210` or `5100` | Yes (Phase 6) | **Missing** |
| 7 | **WIP (`تحت التشغيل`)** | `StockLedgerEntry` (`work_in_progress`, `order:{id}`) + `ProductionOrder.wip_balance` | Accumulates material cost; closes residual to `5200` | Include factory-owned accessories & labor cost (if absorbed) for Internal/External; zero cost for customer materials | **Cross-module** (Production + Finance) | **High** (wage double-counting & `5200` overloading) | Yes (Phase 6) | **Needs Adjustment** |
| 8 | **Production Orders** | `production_orders`, `production_order_items` | Linked to `customer_order_line_id` (custom) and `1220`/`1230` | Add `manufacturing_type` (`internal`/`external`), `activity_type`, `labor_cost`, `started_at`/`completed_at` | **Cross-module** (Production + Finance + Sales) | Medium (backfilling existing `private_label` orders) | Yes (Phases 6 & 7) | **Needs Adjustment** |
| 9 | **Production Stages** | `production_stage_events`, `production_stage_history` | Operational only | Add stage `started_at`, `completed_at`, expected duration, delay reason/notes; optional labor logging per stage | **Production-only** (plus Time Reports) | Low (must not alter stage sequence/FG receipt locks) | Yes (Phase 7) | **Needs Adjustment** |
| 10 | **Finished Goods** | `StockLedgerEntry` (`finished_goods`, buckets `factory_brand` / `private_label:{cid}`) | `finished_goods_receipt` posts `Dr 1230 / Cr 1220` | Preserve buckets; for External Mfg evaluate whether FG carries only factory-borne cost (accessories + labor) or service-only costing | **Cross-module** (Production + Inventory + Sales) | **High** if customer fabric value enters `1230` | No new table; costing rule update | **Works** (Internal); **Needs Rule** (External) |
| 11 | **Sales Orders** | `customer_orders`, `customer_order_lines` | Commitment & pricing only; no GL/stock effect | Keep separate from Deliveries; add `Sold Items` read view & external service order link | **Finance & Sales** | Low | Optional (`activity_type`) | **Works** |
| 12 | **Deliveries** | `customer_deliveries`, `customer_delivery_lines` | Deducts `finished_goods`; posts `Dr 1100 / Cr 4100` & `Dr 5100 / Cr 1230` | Route External Mfg delivery revenue to dedicated service revenue (`4120`/`4200`); expose line details in `Sold Items` | **Cross-module** (Sales + Inventory + GL) | Medium (revenue misclassification in P&L) | No (only GL code routing) | **Works** (Adapt revenue GL code) |
| 13 | **Customer Collections** | `customer_payments` → `CashDocument` (`income`) | Posts `Dr 1010 / Cr 1100` upon Treasury approval | Keep unchanged; reflect in chronological Customer Statement & Sold Items payment status | **Finance-only** | Low | No | **Works** |
| 14 | **Treasury** | `cash_accounts`, `cash_documents`, `cash_ledger_entries` | Central approval & GL posting for all cash movements | Add Treasury Account Statement (`REP-STMT-04`); add structured expense category (`5300`/`5400`/etc.); bank account `1030` if approved | **Finance-only** | Medium (opening cash currently posts to `4200` revenue!) | Phase 5 (`expense_account_code`, `'bank'` type if approved) | **Works** (Adapt GL mapping) |
| 15 | **Expenses** | `CashDocument` (`document_type='expense'`), `daily_expenses` (legacy unused?) | Keyword match (`صيانة`/`تشغيل`/`إنتاج`) selects `5300` vs `5400` | Replace keyword heuristic with explicit Expense Category → GL account mapping; support drill-down in Income Statement | **Finance-only** | High (misclassified expenses in P&L) | Yes (Phase 5) | **Needs Adjustment** |
| 16 | **Revenues** | `CustomerDelivery` (`4100`), `CashDocument` (`income` → `4200`/`4100`) | Mixed `4100`/`4200`; opening cash uses `4200` | Separate `4100` (Internal Sales), `4120`/`4200` (External Manufacturing Service), `3000` (Opening Capital — NOT revenue!) | **Finance & Sales** | **High** (opening balance inflated revenue!) | Yes (Phase 5 & 6) | **Needs Adjustment** |
| 17 | **Custody** | `CashAccount` (`petty_cash`), `custody_settlements` | Funded by Treasury transfer; daily expenses reduce balance; settlement returns cash | Add chronological Custody Account Statement (`REP-STMT-05`) | **Finance-only** | Low | No | **Works** |
| 18 | **Employee Payroll** | `employees`, `pay_periods`, `payroll_runs`, `payroll_run_items` | Cash disbursement posts lump sum `Dr 5200 / Cr 1010` | Add Employee Statement (`REP-STMT-03`); separate Direct vs Admin wages; coordinate with Production Labor Costing to prevent double-counting | **Cross-module** (HR/Payroll + Production + GL) | **Critical** (double-counting wages + cash-only accrual gap) | Yes (Phase 5 & 6) | **Needs Adjustment** |
| 19 | **Permissions & Approvals** | `app/core/permissions.py` (`ROLE_PERMISSIONS_MAP`, Maker-Checker in services) | API enforces every permission; `finance_manager` lacks `suppliers:invoices:create` | Verify `finance_manager` access to new Purchases/Sales/Reports endpoints; keep `warehouse_manager` price masking intact | **Cross-module** (RBAC) | High if new endpoints forget `require_permission` or price masking | No | **Works** (Verify new endpoints) |
| 20 | **Financial & Operational Reports** | `endpoints/reports.py`, `modules/reports/analytics.py`, `FinancialReportsView.tsx` | 19 UI reports + hidden `balance-sheet` & buggy `general-ledger`; mocked `performance/summary` | Fix `general-ledger` bug; add Account Statements, P&L Drill-Down, Production Time Report; gate Balance Sheet on Phase 5 foundations | **Finance & Production** | High if unverified Balance Sheet is shown | No new tables for Phase 4; yes for Phase 5–7 | **Needs Adjustment** |

