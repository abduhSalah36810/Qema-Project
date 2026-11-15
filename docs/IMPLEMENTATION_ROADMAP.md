# Qema ERP — Phased Implementation Roadmap & Same-Day Feasibility Assessment

> **Governing Principle:** Execute in small, independent, reviewable steps without replacing working business logic, duplicating sources of truth, or breaking permissions/audit trails.  
> **Scope Legend:** `[Essential]` | `[Optional Enhancement]` | `[Technical Blocker]` | `[Can Be Safely Deferred]` | `[Already Implemented]`

---

## Same-Day Feasibility Assessment (Honest Engineering Evaluation)

| Scope Group | Phases | Can Be Completed Safely in One Working Day? | Rationale |
|---|---|---|---|
| **Wave 1 (UI Reorganization + Read-Only Purchases, Sales & Statements)** | **Phase 0** (Git/DB sync), **Phase 1** (Finance Nav Restructuring), **Phase 2** (Purchased Items), **Phase 3** (Sold Items), **Phase 4** (Account Statements — GL bugfix + Customer/Supplier/Cash/Custody chronological statements) | **YES — Realistically Feasible (~6–8 hours)** | Zero or minimal DB schema changes; reuses existing authoritative tables (`SupplierInvoiceLine`, `CustomerOrderLine`, `CustomerDeliveryLine`, `CashLedgerEntry`, `JournalEntryLine`) and `balances.py`. |
| **Wave 2 (True Financial Statements & Foundations)** | **Phase 5** (P&L Drill-Down + CoA cleanup + Opening Balances + Bank Account + Balance Sheet) | **PARTIAL (2–3 days + Business Decisions)** | P&L drill-down & fixing `5200` sub-accounts can be built quickly **only after** business-owner decisions on Opening Balances, cutover date, expense categories, and bank account `1030`. Balance Sheet must **not** be exposed before opening balances (`3000`) exist. |
| **Wave 3 (New Operational & Accounting Domains)** | **Phase 6** (Internal vs. External Manufacturing: customer materials, accessories ownership, labor costing, waste allowance, segmented P&L) & **Phase 7** (Production Order & Stage Time Tracking + Delays + Reports) | **NO — Multi-Day Scope (4–7 days + Business Decisions)** | Requires multiple Alembic migrations, inventory bucket/zero-cost rules, payroll-to-WIP wage-absorption accounting, stage timing history & delay taxonomy, and thorough E2E testing. Rushing these in one day risks inventory corruption and wage double-counting. |
| **Wave 4 (Cleanup & Readiness)** | **Phase 8** (UI Consolidation & Legacy Retirement) & **Phase 9** (E2E Operational Readiness) | **After respective Waves** | Legacy retirement (`PaymentsCollectionsView`) takes <1 hour once approved after Phase 1–3 verification. |

---

## Phase 0 — Audit, Git Stabilization & Technical Mapping `[Technical Blocker]`
- **Objective:** Stabilize the current working branch (`feat/customer-returns`) and DB migration state before writing new feature code.
- **Exact Scope:**
  - Step 0.1: Review and commit/split the 20 modified + 3 untracked files currently uncommitted on `feat/customer-returns` (especially uncommitted `reports.py` P&L period filter, `FinancialReportsView.tsx`, `permissions.py`, and migration `0023`).
  - Step 0.2: Verify `alembic upgrade head` (`0018`–`0023`) on local/staging DB per `KNOWN_LIMITATIONS_AR.md` (with backup & approval before any non-test DB).
  - Step 0.3: Fix `report_account_ledger` bug (`reports.py:1111-1112`: `je.reference_type`/`je.reference_id` → `je.source_doc_type`/`je.source_doc_id`).
- **Existing Components to Reuse:** All existing migrations, `permissions.py`, `reports.py`.
- **Files Likely to Change:** `apps/api/app/api/v1/endpoints/reports.py` (Step 0.3 only).
- **Backend / DB / API / Permissions:** Bugfix in `reports.py`; apply existing migrations `0018`–`0023`.
- **Risks:** Running new code on DBs missing `0018`–`0023` crashes Products/Production/Payroll/Returns.
- **Acceptance Criteria:** Clean `git status` on a dedicated feature branch; `alembic current` at `head` (`20261111_0023`); `/reports/general-ledger/1010` returns HTTP 200 without `AttributeError`.
- **Rollback:** Revert Step 0.3 commit; DB snapshot restore before migration.
- **Effort:** Small (~1 hour).

---

## Phase 1 — Finance Navigation & Restructuring `[Essential]`
- **Objective:** Reorganize Finance sidebar navigation around **Purchases**, **Sales**, **Reports**, plus **Treasury & Cash Operations** and **Payroll**, without breaking any existing business workflow or Warehouse/Production menus.
- **Exact Scope:**
  - Step 1.1: Update `GENERAL_NAV` and `FINANCE_NAV` in `apps/web/src/App.tsx` to group Finance cleanly into:
    - `المشتريات` (`finance-purchases`): `finance-suppliers`, placeholder/route for `finance-purchased-items`
    - `المبيعات` (`finance-sales`): `finance-customers`, placeholder/route for `finance-sold-items`, `orders` (GM), `customer-returns`
    - `الخزينة والنقدية` (`finance-cash`): `finance-treasury`, `finance-operations`, `finance-custody`
    - `الرواتب` (`finance-payroll`)
    - `التقارير المالية` (`finance-reports`)
  - Step 1.2: Update `TaskInboxView.tsx` shortcuts (`ROLE_HOME`) if any nav IDs or labels changed, and update `navigation.test.tsx`.
  - Step 1.3: Keep `WAREHOUSE_NAV` and `PRODUCTION_NAV` operational paths untouched.
- **Existing Components to Reuse:** `App.tsx` routing & `ROUTE_PERMISSIONS`, `TaskInboxView.tsx`, all existing Finance/Customer views.
- **Files Likely to Change:** `apps/web/src/App.tsx`, `apps/web/src/features/inbox/TaskInboxView.tsx`, `apps/web/src/features/navigation.test.tsx`.
- **Backend / DB / API / Permissions:** None (UI organization only).
- **Dependencies:** Approved Navigation Tree (`RESTRUCTURING_AND_DEPENDENCY_MAP.md` Section 2).
- **Risks:** Breaking role-based route assertions in `navigation.test.tsx`; confusing `warehouse_manager` if `finance-suppliers` moves out of `WAREHOUSE_NAV` (mitigated by keeping `WAREHOUSE_NAV` intact).
- **Acceptance Criteria:** All 4 roles see clean, intuitive menus; `npm test` (`navigation.test.tsx`) and `vite build` pass; all existing Finance screens open and function identically.
- **Rollback:** Single frontend commit revert.
- **Effort:** Small (~1–1.5 hours).

---

## Phase 2 — Purchases (`Create Purchase Invoice` & `Purchased Items`) `[Essential]`
- **Objective:** Organize Purchase Invoice creation/receipt/payment under Finance → Purchases and deliver the new **Purchased Items** review & price history view reusing `supplier_invoice_lines`.
- **Exact Scope:**
  - Step 2.1 `[Already Implemented + Adapt]`: Refine `SuppliersView.tsx` / `SupplierPurchasingView.tsx` headers/tabs so "إنشاء فاتورة شراء جديدة" and "فواتير الشراء والاستلام" are crystal clear; ensure `finance_manager` permission decision (`suppliers:invoices:create`) is applied if approved by owner.
  - Step 2.2 `[New]`: Add backend endpoint `GET /api/v1/finance/purchased-items` querying `SupplierInvoiceLine` joined with `SupplierInvoice`, `Supplier`, `CatalogItem`, `ItemCategory`, `Unit` (excluding cancelled invoices), with filters (`item_id`, `category_id`, `item_type`, `supplier_id`, `date_from`, `date_to`, `status`), respecting `_can_view_prices(user_roles)`.
  - Step 2.3 `[New]`: Build `PurchasedItemsView.tsx` (`apps/web/src/features/finance/PurchasedItemsView.tsx`) with summary KPIs, filter bar, line-level table linking back to source invoice (`internal_number` / `invoice_number`), and item price-history drawer.
  - Step 2.4 `[Can Be Safely Deferred]`: Taxes on purchase invoices and invoice cancellation / supplier return workflow (pending owner decisions).
- **Existing Components to Reuse:** `SupplierInvoice`, `SupplierInvoiceLine`, `balances.py`, `SupplierPurchasingView.tsx`, `_can_view_prices()`.
- **Files Likely to Change:** `apps/api/app/api/v1/endpoints/finance.py`, `apps/api/app/modules/finance/schemas.py`, `apps/web/src/features/finance/financeApi.ts`, `apps/web/src/features/finance/PurchasedItemsView.tsx` (new), `apps/web/src/App.tsx`.
- **Database / Migrations:** None (reuses `supplier_invoices`, `supplier_invoice_lines`).
- **Permissions:** `suppliers:view`; price masking for `warehouse_manager`; verify owner decision on `finance_manager` + `suppliers:invoices:create`.
- **Dependencies:** Phase 1.
- **Risks:** Exposing purchase prices to `warehouse_manager` if endpoint skips `_can_view_prices`; discrepancy in net line total if `discount_amount` isn't calculated via `balances.supplier_line_total()`.
- **Acceptance Criteria:** Purchased items match `supplier_invoice_lines` totals 100%; creating a purchase invoice still does NOT change stock until `receive` is confirmed; backend tests pass for price masking and filters.
- **Rollback:** Remove new endpoint & route; existing `SupplierPurchasingView` unaffected.
- **Effort:** Small–Medium (~2–3 hours).

---

## Phase 3 — Sales (`Sold Items` & Sales Organization) `[Essential]`
- **Objective:** Deliver the **Sold Items** line-level view under Finance → Sales while preserving the strict separation of Sales Order, Delivery, Collection, and Returns.
- **Exact Scope:**
  - Step 3.1 `[New]`: Add backend endpoint `GET /api/v1/customers/sold-items` (or `/finance/sold-items`) built from `CustomerDeliveryLine` + `CustomerDelivery` + `CustomerOrderLine` + `CustomerOrder` + `Customer` + `Product` + `ProductVariant`, reusing `customer_order_financials` `net_ratio` so unit net value matches `balances.py` and `analytics.py`, and exposing order delivery status & collection/payment status. Include returned qty per order line for full transparency.
  - Step 3.2 `[New]`: Build `SoldItemsView.tsx` (`apps/web/src/features/customers/SoldItemsView.tsx` or `finance/`) with filters (`customer_id`, `product_id`, `variant_id`, `order_type`, `date_from`, `date_to`), KPIs (total qty, gross vs net sales value, returns), and item/model sales history modal.
  - Step 3.3 `[Optional Enhancement]`: Global Sales Orders lookup tab (`GET /api/v1/customers/orders`) so Finance/Sales don't have to click into each customer individually to find an order.
  - Step 3.4 `[Can Be Safely Deferred]`: Formal separate `SalesInvoice` numbering / tax invoice document (pending open decision in `OPEN_DECISIONS_AR.md:42`).
- **Existing Components to Reuse:** `CustomerOrder`, `CustomerOrderLine`, `CustomerDelivery`, `CustomerDeliveryLine`, `balances.py` (`customer_order_financials`), `CustomersView.tsx`.
- **Files Likely to Change:** `apps/api/app/api/v1/endpoints/customers.py`, `apps/api/app/modules/customers/schemas.py`, `apps/web/src/features/customers/customersApi.ts`, `apps/web/src/features/customers/SoldItemsView.tsx` (new), `apps/web/src/App.tsx`.
- **Database / Migrations:** None.
- **Permissions:** `customers:view` (or `customers:view` + `finance:reports:view` for monetary fields).
- **Dependencies:** Phase 1.
- **Risks:** Rounding differences between order-level `document_net_sales_value` and line-level display; mixing undelivered order lines with delivered sold lines (must clearly distinguish or filter by delivered vs ordered).
- **Acceptance Criteria:** Sold Items net total reconciles with `sales_analysis` and `revenue-analysis` for the same period; order/delivery/payment lifecycle remains cleanly separated.
- **Rollback:** Remove new view & endpoint.
- **Effort:** Small–Medium (~2–3 hours).

---

## Phase 4 — Unified Account Statements (`كشوف الحسابات`) `[Essential]`
- **Objective:** Provide a unified, chronological Account Statements interface supporting Customer, Supplier, Treasury/Cash Account, Custody Account, GL Account, and Employee (operational run summary) with opening balance, debit, credit, running balance, closing balance, and date filtering.
- **Exact Scope:**
  - Step 4.1 `[Essential]`: Fix `report_account_ledger` (`reports.py:1111`) and add `date_from` / `date_to` + `opening_balance` + `closing_balance`.
  - Step 4.2 `[Essential]`: Enhance `GET /api/v1/reports/customer-statement/{customer_id}` with optional `date_from`/`date_to`, `opening_balance`, and chronological `transactions[]` (Deliveries = Debit; Returns & Approved Collections = Credit; running balance matching `balances.py`). Keep existing `orders` field for backward compatibility.
  - Step 4.3 `[Essential]`: Enhance `GET /api/v1/reports/supplier-statement/{supplier_id}` with optional `date_from`/`date_to`, `opening_balance`, and chronological `transactions[]` (`SupplierReceipt` = Credit payable; Approved `SupplierPayment` = Debit; running balance matching `balances.py`).
  - Step 4.4 `[New]`: Add `GET /api/v1/reports/cash-account-statement/{account_id}` covering both `treasury` and `petty_cash` (Custody) accounts from `CashLedgerEntry` + `CashDocument`, with opening/running/closing balance and `date_from`/`date_to`.
  - Step 4.5 `[New / Partial]`: Add `GET /api/v1/reports/employee-statement/{employee_id}` derived from `PayrollRun` + `PayrollRunItem` + `PayPeriod` (earnings vs deductions/advances vs disbursed net), gated by `finance:payroll:view` AND `finance:reports:view`. *(Note: standalone mid-month cash advances sub-ledger deferred pending owner decision).*
  - Step 4.6 `[New]`: Build unified `AccountStatementsSection` in `FinancialReportsView.tsx` with account-type selector (`عميل`, `مورد`, `خزينة`, `عهدة`, `حساب دفتر أستاذ`, `موظف`), period picker, summary KPIs (Opening / Total Debit / Total Credit / Closing), and printable/exportable chronological statement table.
- **Existing Components to Reuse:** `balances.py`, `CashLedgerEntry`, `JournalEntryLine`, `FinancialReportsView.tsx`, `reportUi.tsx` (`DataTable`, `PeriodBar`).
- **Database / Migrations:** None for Steps 4.1–4.5.
- **Risks:** Wrong debit/credit sign on liability (Supplier) vs asset (Customer/Cash) accounts; leaking payroll data to users without `finance:payroll:view`.
- **Acceptance Criteria:** Closing balance of Customer Statement == `accounts-receivable` balance; Supplier Statement == `accounts-payable` balance; Cash/Custody Statement == `cash_account_balance()`; GL Statement == Trial Balance net.
- **Effort:** Medium (~3–4 hours).

---

## Phase 5 — Income Statement Drill-Down & Balance Sheet Accounting Foundations `[Technical Blocker / Multi-Day]`
- **Objective:** Upgrade the Income Statement with mandatory transaction drill-down and clean expense/wage classification, and establish the missing accounting foundations required before exposing a reliable Balance Sheet.
- **Exact Scope:**
  - **Sub-phase 5A (Income Statement Drill-Down & CoA Cleanup):**
    - Step 5.1 `[Essential]`: Add `GET /api/v1/reports/profit-and-loss/drilldown?account_code=...&date_from=...&date_to=...` returning underlying `JournalEntry` + `JournalEntryLine` + source document metadata; wire clickable rows in `ProfitAndLossSection` to a drill-down modal/drawer.
    - Step 5.2 `[Technical Blocker]`: Alembic migration to expand CoA (`5200` split into e.g. `5210` Direct Mfg Wages, `5220` Mfg Scrap & Inventory Variance, `5410` Admin & General Salaries, `2200` Accrued Payroll, `3100` Retained Earnings) and add explicit `expense_account_code` on `CashDocument` (replacing Arabic keyword matching in `finance/service.py:156`).
  - **Sub-phase 5B (Balance Sheet Prerequisites & Report):**
    - Step 5.3 `[Technical Blocker]`: Build controlled **Opening Balances** workflow (`Dr Asset / Cr 3000` or `Dr 3000 / Cr Liability`) so opening cash and opening inventory do NOT credit `4200` revenue or `5200` expense!
    - Step 5.4 `[Optional / Owner Decision]`: Support Bank account (`CashAccount.account_type = 'bank'` linked to `1030`) if approved.
    - Step 5.5 `[Essential]`: Refactor `GET /api/v1/reports/balance-sheet` (`reports.py:969`) to accept `as_of` date, aggregate dynamically across `Account.account_type` (`asset`, `liability`, `equity` + unclosed `revenue - expense`), and verify `is_balanced == True`.
    - Step 5.6 `[Essential]`: Expose `BalanceSheetSection` and `TrialBalanceSection` in `FinancialReportsView.tsx` **only after** Steps 5.2–5.5 and owner opening balances cutover are verified.
- **Dependencies:** Business-owner decisions (`OPEN_DECISIONS_AND_BLOCKERS.md` Section 1).
- **Risks:** Exposing Balance Sheet before opening balances produces negative/meaningless equity; changing `5200` without migrating post-0016 journal entries splits historical data.
- **Acceptance Criteria:** Every P&L line drills down to exact source documents; `Assets == Liabilities + Equity` on any `as_of` date; opening cash/stock does not appear as profit.
- **Effort:** Medium–Large (~2–3 days after business decisions).

---

## Phase 6 — Internal vs. External Manufacturing Separation `[Multi-Day / Blocked on Decisions]`
- **Objective:** Separate Internal Manufacturing (factory-owned) from External Manufacturing (customer-owned materials, mixed accessory ownership, labor costing, fixed service price, waste allowance, segmented P&L) inside the existing unified ledger and inventory architecture.
- **Exact Scope:**
  - Step 6.1: Add `manufacturing_type` (`internal` / `external`), `customer_id`, `agreed_service_price`, `cost_center_code` on `ProductionOrder` (Alembic migration). Preserve existing `ProductionOrderItem.product_type` (`factory_brand` / `private_label`).
  - Step 6.2: Customer-Owned Raw Materials Custody (`customer_material_receipts` + `StockLedgerEntry` bucket `cust_mat:{customer_id}:{order_id}` with `ownership_type='customer'`, `unit_cost=0`, zero GL `1210`/`2100` impact) + Customer Material Return & Reconciliation report (`received = consumed + waste + remaining + returned`).
  - Step 6.3: Accessories Ownership (`ownership_source`: `factory` vs `customer`) on `ProductionOrderMaterial` and dispatch/reconciliation logic (factory accessories deduct factory stock & hit `1220`; customer accessories deduct `cust_mat` at zero cost).
  - Step 6.4: Labor Costing (`production_labor_logs` supporting `time_based` and `piece_based`) + GL wage-absorption clearing (`Dr 1220 WIP / Cr 5290 Applied Labor`) so P&L counts payroll + applied labor **once**, never twice. Respect existing lock prohibiting extra cost changes after FG receipt starts.
  - Step 6.5: Waste Allowance (`allowed_waste_pct` per BOM/material line, actual vs. allowed comparison, overrun flag, stage linkage on scrap).
  - Step 6.6: External Manufacturing Revenue Routing (`4120` External Mfg Service Revenue) + `activity_type` tag on `journal_entries` + Internal vs. External vs. Consolidated Income Statement & Comparison view.
- **Dependencies:** Phase 5 CoA/wage clearing + Business decisions (`OPEN_DECISIONS_AND_BLOCKERS.md` Section 3).
- **Risks:** Mixing customer fabric into WAC or `1210`; double-counting wages; changing unit cost after partial FG receipt.
- **Effort:** Large (~3–4 days after business decisions).

---

## Phase 7 — Production Time Tracking & Delay Monitoring `[Multi-Day / Blocked on Decisions]`
- **Objective:** Measure real elapsed time for complete production orders and individual stages, compare against expected durations, capture delay reasons/corrective actions, and deliver real Production Time Reports—without altering material issue, WIP, FG receipt, or closing rules.
- **Exact Scope:**
  - Step 7.1: Alembic migration adding:
    - Order level (`production_orders`): `production_started_at`, `production_completed_at`, `expected_duration_hours`.
    - Stage level (`production_stage_events` / `production_stage_timings`): `started_at`, `completed_at`, `actual_duration_minutes`, `expected_duration_minutes`, `delay_reason`, `delay_notes`, `corrective_action`, `delay_recorded_by`, `delay_recorded_at`.
    - Optional template/BOM expected stage durations.
  - Step 7.2: Update `update_production_stage` and `reopen_last_completed_stage` (`production/service.py`) to record/preserve timestamps automatically (using configurable stage sequence `ORDER_STAGES_SEQUENCE` or DB stage config, not hardcoded UI labels).
  - Step 7.3: Add delay monitoring & `PATCH /api/v1/production/orders/{id}/stages/{stage_name}/delay` endpoint with structured delay reasons (`material_shortage`, `labor_shortage`, `machine_failure`, `low_productivity`, `waiting_previous_stage`, `quality_issue`, `other`).
  - Step 7.4: Distinguish Calendar Elapsed Time vs. Factory Shift/Working Hours cleanly in calculations.
  - Step 7.5: Replace mocked constants in `GET /api/v1/production/performance/summary` (`production.py:1465`) with real DB aggregations (avg stage duration, avg order duration, most delayed stages, currently delayed orders, delay causes, order comparisons, productivity trends) and build Production Time Reports UI.
- **Dependencies:** Business decisions (`OPEN_DECISIONS_AND_BLOCKERS.md` Section 4).
- **Risks:** Corrupting historical stage metrics if legacy orders without `started_at` are averaged as 0; rollback overwriting original start time.
- **Acceptance Criteria:** Real elapsed hours/days match actual timestamps; delayed orders surface automatically; existing WIP/FG/close tests remain 100% green.
- **Effort:** Medium–Large (~2–3 days).

---

## Phase 8 — UI Consolidation & Legacy Retirement `[Can Be Safely Deferred / Approval Required]`
- **Objective:** Clean up orphaned/duplicate screens after Phases 1–4 are verified in live use and explicit owner approval is obtained.
- **Exact Scope:**
  - Step 8.1: Retire `PaymentsCollectionsView.tsx` and remove `finance-payments` route from `App.tsx` (only after owner sign-off).
  - Step 8.2: Audit whether `finance-revenues` / `finance-expenses` aliases in `App.tsx` can be removed once all links point to `finance-operations`.
- **Dependencies:** Owner approval + Phases 1–4 verified.
- **Rollback:** Restore component/route from git.
- **Effort:** Small (~0.5 hour).

---

## Phase 9 — Final Operational Readiness & E2E Verification `[Essential]`
- **Objective:** Controlled end-to-end verification across Finance, Inventory, Production, Sales, Payroll, and Accounting before production rollout.
- **Verification Scope:**
  1. **Purchases → Raw Inventory → AP → Treasury Payment** (no double stock receipt, price masking for warehouse, purchased items matches invoice lines).
  2. **Sales Order → Delivery → Return & Inspection → Collection → Sold Items & Customer Statement** (exact match with `balances.py`).
  3. **Production Internal vs External** (customer fabric zero asset/AP impact, reconciliation = 100%, labor clearing without double-counting wages).
  4. **Time Tracking** (stage & order timestamps, rollback preservation, delay alerts, real performance summary).
  5. **Accounting Integrity** (Trial Balance `debit == credit`, P&L drill-down matches ledger lines, Balance Sheet `Assets == Liabilities + Equity`).
  6. **RBAC & Maker-Checker** (all 4 roles tested on API + UI; no self-approval; `vite build` & `pytest` clean).
- **Effort:** Medium (~0.5–1 day).

