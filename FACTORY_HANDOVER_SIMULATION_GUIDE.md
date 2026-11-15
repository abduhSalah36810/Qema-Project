# Qema ERP — Factory Handover Readiness & End-to-End Simulation Guide

**Prepared For:** Factory Stakeholder Handover Meeting (Qema Garment Manufacturing ERP)  
**Repository State Assessed:** Branch `feat/customer-returns` @ commit `47ed402` + uncommitted working tree changes (`2026-11-11`)  
**Alembic Code Head:** `20261111_0023` *(after post-assessment pre-meeting hotfixes for multi-bucket stocktake & P&L UI)*  
**Assessment Verdict:** **CONDITIONAL GO** *(Simulation-Ready on Isolated Local Pilot Environment — `qemma_pilot_demo` has been reset & upgraded to `20261111_0023`; **NOT** Production-Ready)*  

> **Scope & Codebase Integrity Note:** Initial assessment was strictly read-only. Afterward, on explicit user instruction before the meeting, `.env` (`DEV_ALLOWED_DBS=qemma_pilot_demo` + multi-port CORS), migration `20261111_0023` (multi-bucket stocktake unique index), and the `قائمة الدخل` UI report tab (`profit_and_loss`) were applied and verified against `qemma_test_db` and `qemma_pilot_demo`.

---

## Executive Summary

**Can the factory stakeholder demonstration run today?**  
**Yes — conditionally (`CONDITIONAL GO`)**, using the **isolated local pilot stack** (`qemma_pilot_demo` on API port `8010` + frontend on port `5180` with `DEV_AUTH_ENABLED=True`). `qemma_pilot_demo` has already been reset and migrated cleanly to **`20261111_0023`**, so only starting the two local servers (`run_pilot_api.py` and Vite on `5180`) is needed before the demo.

**Why it is NOT a `NO-GO`:**
- The core garment manufacturing and cash-to-inventory operational cycle works end-to-end across **4 distinct server-enforced roles** (`general_manager`, `warehouse_manager`, `production_manager`, `finance_manager`):
  - Catalog draft/submit/approve governance (`catalog:item:*`),
  - Purchase invoicing cleanly separated from partial/full warehouse receiving (`GRN-*`, `Dr 1210 / Cr 2100`),
  - Custom-manufacturing sales orders linked directly to multi-stage production orders,
  - Warehouse material dispatch (`TR-*` `in_transit`) separated by anti-self-receipt from Production workshop receipt (`work_in_progress`),
  - Strict 5-stage sequential production (`cutting → finishing → snap_installation → ironing → packing`),
  - Post-receipt extra raw issues (`TRX-*`), workshop raw material reconciliation (consumed / returned / scrapped), and strict zero-WIP closure gating,
  - Finished goods receipt (`FG-VAR-*`) isolated by ownership bucket (`factory_brand` vs `private_label:{customer_id}`),
  - Customer delivery (`Dr 1100 / Cr 4100` + `Dr 5100 / Cr 1230`), split return inspection (`0022`), collections, supplier payments, treasury custody, daily expenses, and manual payroll calculation/disbursement.

**Why it is NOT an unconditional `GO` (Mandatory Conditions & Limits):**
1. **Default `.env` DB (`qemma_erp_dev`) is broken for current code:** stuck at `20261106_0016` (6 migrations behind head, only 1 warehouse, 3 roles, plus `DEMO-` record pollution). Must **not** be used.
2. **Pilot DB (`qemma_pilot_demo`) Status — FIXED Pre-Meeting:** upgraded via `reset_pilot_demo_db.py --yes` + `alembic upgrade head` to **`20261111_0023`** (`roles=4, warehouses=3, units=11, item_categories=49, cash_accounts=1, accounts=15, catalog_items=8, products=6, suppliers=0, customers=0, production_orders=0`).
3. **Do NOT run `scripts/seed_pilot_demo.py` blindly for automated seeding:** `seed_pilot_demo.py` assumes `finance_manager` cash documents start as `pending` for `general_manager` approval, whereas commit `2026-11-10` added `POST_ON_CREATION_ROLES = {"finance_manager"}`, causing `finance_manager` cash documents to auto-approve immediately (`decision` by `gm` then fails with HTTP 409). Follow the clean reset + live walkthrough instead.
4. **Operational Readiness vs Accounting / Production Deployment Readiness:**
   - **Operational / Meeting Demo Readiness:** **Strong (`CONDITIONAL GO`)** under 4 dev quick-login roles (`qemma_pilot_demo`). Both multi-bucket stocktakes (`20261111_0023`) and `قائمة الدخل` UI (`FinancialReportsView.tsx`) are now active and tested.
   - **Full Financial / Production Deployment Readiness:** **NOT READY (`BLOCKED`)** — production Supabase user accounts and clean factory DB (`bootstrap_factory_db.py`) are not provisioned; direct labor & overhead are not allocated to production orders (`costing_status = "incomplete_materials_only"`); UI lacks Balance Sheet, Trial Balance, and Journal Entry viewer (backend APIs exist, UI tabs do not); UI has no `Paid-in Capital (3000)` entry path for opening cash (deposits post to `4200` Other Income); no unit conversion, no purchase tax, no invoice/payment cancellation UI.

---

## 1. Strict Readiness Assessment (Phases A–I & Platform Controls)

| Area / Workflow | Status | Assessment Summary (Code-Verified) |
|---|---|---|
| **Runtime & Database State** | **PASS** *(Pilot Ready)* | `qemma_pilot_demo` has been reset cleanly to `20261111_0023` and `.env` allows `DEV_ALLOWED_DBS=qemma_pilot_demo` + CORS `5173`/`5180`. `qemma_erp_dev` remains at `0016` (untouched/excluded). |
| **Auth & 4-Role RBAC** | **CONDITIONAL** | Server-side RBAC in `apps/api/app/core/permissions.py` (46 permissions, 4 roles) works cleanly in dev quick-login mode (`AUTH` `0001..0004`). Production Supabase login & `user_roles` provisioning (`user_roles = 0` in `qemma_pilot_demo`) not ready. |
| **Phase A: Purchasing & Receiving** | **CONDITIONAL** | Invoice creation (`awaiting_receipt`) cleanly split from partial/full receiving (`GRN-*`, `StockLedgerEntry`, `Dr 1210 / Cr 2100`). Line discount works; **tax NOT supported**; warehouse role is redacted from seeing prices (`0.00`); `finance_manager` cannot create invoices/receipts. |
| **Phase B: Item Catalog, Units & Costing** | **CONDITIONAL** | Hierarchical categories, units CRUD (`catalog:units:manage` on `warehouse_manager` & `general_manager`), and draft→submit→approve governance (`finance_manager` or `general_manager` approves) work. **NO unit conversion**, **NO purchase/selling price fields on `CatalogItem`** (only ledger receipt `unit_cost` & WAC), and `ItemCreateModal` defaults `classification_status` to `needs_review` (must change to `confirmed`/`suggested` before approval). |
| **Phase C: Customer & Sales Order** | **CONDITIONAL** | Customer create/edit, sales orders (`ready_goods` & `custom_manufacturing`), per-line price, order discount, documentary `payment_terms`, immediate `open` status, deliveries (`Dr 1100 / Cr 4100` + COGS), and collections work. **No draft→confirm transition**; **overpayments above order net total rejected (409)**; requires `customers:orders:create` + `pricing:manage` (`fm`/`gm` only). |
| **Phase D: Production Order & BOM** | **PASS** *(with semantic note)* | Versioned variant-level BOM (`1 pc` reference), automatic proportional requirements, stock availability preview, and linked `ProductionOrder` creation from custom sales orders work. **No separate "Material Request" screen/doc**: a `draft` `ProductionOrder` serves directly as the dispatch queue, and **no stock reservation** occurs until dispatch. |
| **Phase E: Warehouse Issue & WIP Receipt** | **PASS** | Strict separation between `planned_quantity`, `dispatched_quantity` (`in_transit`), `received_quantity` (`work_in_progress`, `bucket = order:{id}`), and `discrepancy_quantity`. Enforces `dispatched_by != receiver_id`. Supports post-receipt extra issues (`TRX-*`). Partial initial dispatch not supported (all-or-nothing check per order). |
| **Phase F: Production Execution** | **CONDITIONAL** | Strictly sequential 5 stages (`cutting` → `finishing` → `snap_installation` → `ironing` → `packing`), rollback with mandatory reason, defect logs (`ProductionDefect`), extra issues, and workshop material reconciliation (`consumed`/`returned`/`scrapped`). **NO per-stage produced/rejected quantities** and **no operator-level accounts** (`production_manager`/`general_manager` records all stages). |
| **Phase G: Finished Goods Receiving & Closure** | **PASS** | `finished_goods` receipt records `accepted` + `rejected` per variant (`FG-VAR-*`), credits `Dr 1230 / Cr 1220`, enforces `private_label:{customer_id}` vs `factory_brand` buckets. Strict closure gate blocks closing until 5 stages done, pending returns resolved, and `work_in_progress` order raw balance = `0.00`. |
| **Phase H: Physical Stocktake (الجرد)** | **CONDITIONAL** | Snapshot creation, count `0` vs `None`, recount loop, Maker-Checker (`created_by`/`submitted_by`/`counter_id != reviewer/poster`), FM approval/posting (uncommitted 2026-11-11 rule), GL adjustments (`5200` vs `1210/1220/1230`), AND multi-bucket WIP/FG stocktake lines (`uq_stocktake_lines_session_item_bucket` via `0023`) all work. Only **assigned-employee selector** on session creation is absent. |
| **Phase I: Finance & Treasury Acceptance** | **CONDITIONAL** | Single Treasury approval gate works for non-FM submissions (`warehouse_manager` payment request, `general_manager` cash docs), while `finance_manager` auto-approves on creation. Custody (`5,000` fund → expense → settle & auto-close), payroll (`employees`, attendance ref, daily `work_days`, manual items, single Treasury `CashDocument`), 18 analytics/valuation tabs + **`قائمة الدخل` (Profit & Loss with calendar period filter)** work. **Balance Sheet / Trial Balance / Journal Entries lack UI views**; **opening cash posts to `4200` Revenue (no `3000` Capital UI option)**; **direct labor/overhead not linked to batch cost**. |
| **Financial Statements & Audit Trail** | **CONDITIONAL** | Double-entry GL (`JournalEntry`/`JournalEntryLine`), immutable `StockLedgerEntry`, `StocktakeAuditLog`, `CatalogApprovalHistory`, and `CashLedgerEntry` all function at backend/DB level. UI exposes operational/valuation reports + **`قائمة الدخل` (`profit_and_loss`)**, while Balance Sheet / Trial Balance / Journal Entries remain backend-only APIs. |

### Detailed Classification Breakdown (Non-PASS Findings)

1. **`RESOLVED PRE-MEETING` — `qemma_pilot_demo` Reset & Upgraded to `20261111_0023`**
   - **Previous state:** `qemma_pilot_demo` was at `20261109_0021` with pre-existing rows (`14` items, `5` suppliers, `4` orders).
   - **Current state:** `reset_pilot_demo_db.py --yes` + `alembic upgrade head` ran and upgraded `qemma_pilot_demo` to **`20261111_0023`**. (`qemma_erp_dev` stays untouched at `20261106_0016` and is never used for runtime).

2. **`RESOLVED PRE-MEETING` — Multi-Bucket Stocktake on WIP / Finished Goods (`20261111_0023`)**
   - **Fix applied:** Replaced `uq_stocktake_lines_session_item` with unique expression index `uq_stocktake_lines_session_item_bucket` on `(stocktake_id, item_id, COALESCE(bucket_reference, ''))` via migration `20261111_0023` and verified via PostgreSQL E2E stocktake tests across both `finished_goods` (`factory_brand` vs `private_label`) and `work_in_progress` (`order` vs `order`).

3. **`CONDITIONAL` — Purchasing Tax, Item-Level Price Lists & Unit Conversions (`NOT SUPPORTED`)**
   - **What is missing:** No tax rate/amount on `SupplierInvoiceCreate`; no `purchase_price`, `selling_price`, or `standard_cost` columns on `CatalogItem`; no UOM conversion engine (`units` are isolated, verified in `catalog.py:1764`).
   - **Impact:** If the factory buys fabric in rolls/kg (`roll` / `kg`) and consumes in `meter` (`meter`), the system cannot convert automatically.
   - **Workaround:** Define each catalog item in the exact operational unit used in both purchasing and BOM (`meter` for fabric, `piece` for buttons/boxes, `roll` for thread), and enter tax-inclusive net unit prices directly on supplier invoices.

4. **`CONDITIONAL` — Financial Manager Auto-Approval (`POST_ON_CREATION_ROLES`) & Stale UI Banners**
   - **What happens:** In `apps/api/app/modules/finance/service.py`, `POST_ON_CREATION_ROLES = frozenset({"finance_manager"})` makes **every `CashDocument` created by `finance_manager`** (Treasury manual receipts/expenses/transfers, customer payments, supplier payments, custody settlement cash returns, payroll disbursements) **approve and post immediately on creation**. Meanwhile, UI notices in `PaymentModal` (`CustomerAccountPage.tsx:294`), `PayrollSheet.tsx:246`, and `ReceiptsDisbursementsView.tsx:168` still state documents wait pending in Treasury.
   - **Impact:** If `finance_manager` creates a receipt expecting to show the `pending` approval queue in `الخزينة والاعتمادات`, the queue will be empty!
   - **Workaround:** Demonstrate the `pending` Treasury approval hub by having **`warehouse_manager`** click `طلب سداد كامل المستحق` on an unpaid received supplier invoice (or `general_manager` submit a manual cash/custody request), then log in as **`finance_manager`** to approve it in `الخزينة والاعتمادات`.

5. **`CONDITIONAL` — Opening Treasury Capital Classifies as Revenue `4200` in P&L**
   - **What happens:** `ReceiptsDisbursementsView.tsx:391-392` only exposes `direct_sales` (`4100`) and `other_income` (`4200`) for cash receipts. There is no UI screen or cash document mapping to Equity account `3000` (Paid-in Capital).
   - **Impact:** Depositing `200,000 ج.م` opening cash keeps Cash (`1010`) and Balance Sheet (`Assets = Liabilities + Equity`) accurate, but inflates `4200` Other Operating Income in `/reports/profit-and-loss` and `overview` KPI (`revenues_period`).
   - **Workaround:** Present the opening deposit transparently to stakeholders as demo working-capital funding, and separate `4100` Sales Revenue (`63,000 ج.م`) from `4200` (`200,000 ج.م`) when reading reports. Code enhancement recommended post-handover for Paid-in Capital (`3000`) opening entries.

6. **`CONDITIONAL` — Batch Costing Excludes Direct Labor & Overhead (`incomplete_materials_only`)**
   - **What happens:** `ProductionOrder` has `actual_labor_cost` and `actual_overhead_cost` columns, and `analytics`/`reports.py` flags orders as `costing_status = "incomplete_materials_only"` when both are zero. No UI allocates payroll or electricity/rent expenses onto production orders.
   - **Impact:** `unit_manufacturing_cost` and `COGS (5100)` represent **direct raw material cost only**; payroll and overhead appear as period expenses (`5xxx`) in P&L rather than capitalized into inventory (`1220`/`1230`).

7. **`NOT SUPPORTED` in UI — Remaining Statutory Statements UI & Operational Features**
   - **Exposed in UI Pre-Meeting (`قائمة الدخل`):** Profit & Loss (`/reports/profit-and-loss`) is now live in `التقارير → نظرة عامة → قائمة الدخل` with calendar period filters.
   - **Still Missing in UI (API exists):** Trial Balance (`/finance/gl/trial-balance`), Journal Entries (`/finance/gl/journal-entries`), Balance Sheet (`/reports/balance-sheet`), Account Ledger (`/reports/general-ledger/{code}`), Order Cost Breakdown (`/reports/production-cost-analysis/{order_id}`).
   - **Not Supported Anywhere (`docs/KNOWN_LIMITATIONS_AR.md` + Code Verified):** UI user/role administration, opening inventory balance import screen (must use purchase receipt or surplus stocktake), UI cancel/reverse buttons on approved invoices/payments/receipts, free raw-to-raw warehouse transfers, stock reservation on draft orders, production operator user accounts, per-stage good/scrap piece counts, automatic attendance-to-payroll deduction formulas, purchase taxes.

8. **`CONDITIONAL` (Cosmetic Drift) — Uncommitted UI Role Descriptions & Catalog Modal Defaults**
   - **Drift observed:** `SignInModal.tsx:50-69` still displays legacy descriptions for `general_manager` (`اعتماد أصناف، ترحيل جرد...`) and `finance_manager` (omits newly granted catalog & stocktake approvals from uncommitted `2026-11-11` diff). Additionally, `ItemCreateModal.tsx:52,109` renders a checked box `تفعيل الصنف فوراً في العمليات` (`is_active: true`) even though `POST /catalog/items` (`catalog.py:624`) ignores it and enforces `is_active=False, approval_status="draft"`, and defaults `classification_status` to `needs_review` (which blocks approval unless switched to `confirmed`/`suggested`).

---

## 2. Complete Lifecycle Feasibility Analysis (Phases A–I)

### Phase A — Purchasing & Raw Material Receiving
- **Can we create an invoice and receive materials against it?** **Yes** (`SupplierPurchasingView.tsx` → `POST /finance/supplier-invoices` + `POST /finance/supplier-invoices/{id}/receive`).
- **Are invoice creation and warehouse receiving correctly separated?** **Yes.** Invoice creation validates active `approved` catalog items with matching `unit_id`, computes `total = Σ(qty × unit_price − discount_amount)`, saves status `awaiting_receipt`, and creates **zero** inventory or GL rows. Only `confirm_supplier_receipt` creates `SupplierReceipt` (`GRN-*`), inserts `StockLedgerEntry(entry_type="supplier_receipt", warehouse_id=main_raw_materials)`, updates status to `partially_received` / `received`, and posts GL `Dr 1210 / Cr 2100` for `total_received_cost`.
- **Is partial receiving supported?** **Yes**, per line across multiple `GRN-*` events up to `invoiced_quantity` (`وصل كل المتبقي` button fills remaining quantities automatically).
- **Discounts & Taxes:** Line-level `discount_amount` is supported and reduces `net_unit_cost = line_total / invoiced_quantity` proportionally; **taxes are NOT supported**.
- **Balances & Costing:** Supplier balance (`balances.py:supplier_invoice_financials`) cleanly separates `invoice_total` (ordered), `received_value` (actual liability in `2100`), `paid_approved`, and `paid_pending`. Warehouse role sees `0.00` for all monetary fields (`_can_view_prices`) and uses `طلب سداد كامل المستحق` (`suppliers:payments:request_full_balance`) to trigger a Treasury approval request without exposing supplier prices.

### Phase B — Item Catalog, Units & Inventory Readiness
- **Catalog Lifecycle & Governance:** New items (`THB-*`) always start as `draft` (`is_active=False`), must be classified (`classification_status` ≠ `needs_review`), submitted (`POST /catalog/items/{id}/submit`), and approved (`POST /catalog/items/{id}/approve`) by a **different** user (`submitted_by != current_user.id`). Once approved (`is_active=True`), they appear in purchasing, BOMs, and stocktake.
- **Units & Conversions:** Units (`meter`, `piece`, `roll`, `kg`, `dozen`) can be created/edited in `دليل الخامات والأصناف → تبويب وحدات القياس` (`warehouse_manager` + `general_manager`). **Unit conversions are NOT supported** (`catalog.py:1764`). Every item uses one immutable base unit across catalog, invoices, BOM, and stock ledger.
- **Price vs Cost Distinction (Exact Code Behavior):**
  - **Catalog Item Purchase Price:** **Does NOT exist** on `CatalogItem`.
  - **Weighted Average Cost (WAC):** Dynamically computed by `get_weighted_average_cost` from positive `StockLedgerEntry` rows (`SUM(total_cost) / SUM(quantity)`, excluding `return_pending_inspection:*`), stored per ledger entry (`unit_cost`) on supplier receipts (`net_unit_cost`) and production dispatches.
  - **Production Cost:** Frozen on `ProductionOrder` from actual material WAC at dispatch/extra-issue receipt minus accepted workshop returns (`actual_material_cost / target_quantity = unit_manufacturing_cost`). Labor & overhead remain `0.00` unless populated externally (`costing_status = "incomplete_materials_only"`).
  - **Selling Price:** Entered per `CustomerOrderLine` (`unit_price`), gated by `pricing:manage` (`finance_manager` / `general_manager`).

### Phase C — Customer & Sales Order
- **Confirmation & Status:** Orders created via `العملاء وطلبات البيع` (`POST /customers/{id}/orders`, requires `customers:orders:create` + `pricing:manage`) start **immediately as `open`** — there is no separate draft→confirm step.
- **Payment Terms & Discounts:** Order-level `discount_amount` reduces net total (`total_amount = gross - discount`) and proportionally scales delivered/returned revenue (`net_ratio`). `payment_terms` is stored and displayed as informational text (no credit limit block or installment schedule).
- **Balances & Overpayments:** Customer `receivable (1100)` changes **only on delivery (`Dr 1100 / Cr 4100`)** and **approved collections (`Dr 1010 / Cr 1100`)** or **returns**. Advance collections before delivery are supported (`available = remaining_on_order - paid_pending`), creating a negative receivable (credit advance); **overpayments exceeding `total_amount` are strictly rejected (HTTP 409)**.
- **Availability for Production:** Only orders with `order_type = "custom_manufacturing"` expose `＋ أمر تشغيل` inside `CustomerAccountPage`, creating a `ProductionOrder` locked to that `CustomerOrderLine` (`private_label:{customer_id}` bucket) capped at remaining unplanned quantity. (`ready_goods` orders fulfill from `factory_brand` stock instead.)

### Phase D — Production Order & BOM
- **BOM Setup:** Defined per `ProductVariant` (`الموديلات والمقاسات → مستلزمات التصنيع`) using approved active catalog items (`reference_quantity = 1.0`, versioned immutably).
- **Material Requests vs Production Orders:** Creating a `ProductionOrder` previews stock availability (`preview_order_requirements`), freezes `ProductionOrderItemMaterial`, and populates `ProductionOrderMaterial` (`planned_quantity`, `status = "draft"` / UI `"بانتظار صرف الخامات"`). **There is no separate Material Request screen or document** — the `draft` production order appears automatically in `أمين المخزن → صرف الخامات واستلام التام`.
- **Shortages & Reservations:** Draft orders do **not** reserve raw stock. When `warehouse_manager` triggers dispatch, `dispatch_order_materials` locks raw balances and checks `available >= planned_quantity` for **all** lines; any single shortage blocks the whole dispatch with HTTP 409 (`لا يمكن صرف الخامات لعدم كفاية الرصيد`).

### Phase E — Warehouse Material Issue & Production Receipt
- **Quantity Distinction Verified:**
  - `planned_quantity`: Frozen BOM requirement.
  - `dispatched_quantity`: Set by `warehouse_manager` clicking `صرف الخامات (بالطريق) ←` (`TR-*` transfer; deducts `main_raw_materials`, adds `location_type="in_transit"`, sets `unit_cost = WAC`, moves order to `materials_dispatched`). All-or-nothing across all planned lines.
  - `received_quantity`: Set by `production_manager` clicking `✓ تأكيد استلام الخامات وتسجيل الفروقات` (`0` to `dispatched_quantity`). Strictly enforces **`dispatched_by != receiver_id`** (HTTP 409). Credits `work_in_progress` (`bucket = order:{order.id}`), sets order `in_production`, and posts `Dr 1220 (received) + Dr 5200 (transit loss) / Cr 1210 (dispatched)`.
  - `discrepancy_quantity`: `received - dispatched` (`location_type="discrepancy"`).
- **Extra Consumption & Returns:** Handled via `صرف خامات إضافي` (`TRX-*` transfer while `in_production`/`manufacturing_completed`, before final FG closure, also enforcing `dispatched_by != receiver_id` and updating WIP & `unit_manufacturing_cost`) and `تسوية خامات الورشة` (`MRC-*` reconciliation + `TRR-*` return transfers).

### Phase F — Production Execution
- **Sequential Stage Engine:** Once `in_production`, `production_manager` executes 5 hardcoded sequential stages (`cutting` القص على الباترون → `finishing` التشطيب → `snap_installation` تركيب الكبسولة → `ironing` الكي → `packing` التعبئة والتغليف). Each stage strictly transitions `not_started → in_progress → completed`; starting stage `N` before stage `N-1` completes is rejected (`HTTP 400`).
- **Operators, Stage Counts & Defects:** No floor-operator accounts exist (`production_manager` or `general_manager` updates stages). Stages store actor, timestamp, status, and notes (**no per-stage good/rejected piece quantities**). Quality defects can be logged via `العيوب والهالك` (`ProductionDefect`) for documentation without modifying inventory.
- **Stage 5 Completion Rule:** Completing `packing` updates order status to `manufacturing_completed`, which **does NOT** move inventory or close WIP.

### Phase G — Finished Goods Receiving & Closure
- **FG Receipt (`warehouse_manager`):** From `مخزن المنتج التام` (pending tab) or `OrderDetailModal → استلام المنتج التام`, enters `accepted` (`سليم الآن`) and `rejected` (`مرفوض الآن`) per variant line and clicks `✓ تأكيد استلام التام`. Auto-creates/uses `FG-VAR-*` catalog item, increases `finished_goods` (`private_label:{customer_id}` or `factory_brand`) at `unit_manufacturing_cost`, reduces `order.wip_balance`, posts GL `Dr 1230 / Cr 1220`, and moves order to `receipt_completed` once `accepted == target` (if `accepted < target`, closing later requires `under_production_reason`).
- **Mandatory WIP Material Reconciliation & Closure (`production_manager`):** Before `close_production_order` succeeds (`ProductionOrdersView → التسوية والمرتجعات والإغلاق`), PM must allocate **100%** of raw quantities sitting in `work_in_progress` (`order:{id}`) into `consumed_quantity`, `returned_quantity`, and `scrapped_quantity` until `remaining_wip_balance == 0.0`. Returned raw items must first be received by WH (`Dr 1210 / Cr 1220`) and any return shortages/rejections resolved by PM/GM before `إغلاق أمر التشغيل نهائياً` closes the order and zeros residual `order.wip_balance` against `5200 / 1220`.

### Phase H — Physical Stocktake (الجرد)
- **Supported Scope:** `warehouse_manager` (or `gm`) opens sessions in `المخازن → الجرد`, selecting warehouse (`main_raw_materials`, `work_in_progress`, or `finished_goods`) and scope (`جرد شامل` or `أصناف محددة`). With migration `20261111_0023`, items spanning multiple ownership or order buckets (`factory_brand` vs `private_label`, or multiple `order:{id}` WIP buckets) generate independent `StocktakeLine` rows seamlessly.
- **Counting & Zero Differentiation:** Modal has no assigned-employee dropdown (`counter_id` records the logged-in user who clicks `بدء العد الميداني` and saves counts). System cleanly treats `0` as verified zero stock vs `None` (`غير معدود`), tracks full `StocktakeCountHistory`, and supports `طلب إعادة عد` (`under_review`).
- **Approval & Posting (2026-11-11 Rule):** Both `finance_manager` (new uncommitted permission) and `general_manager` have `inventory:stocktake:view|review|approve|post`. Maker-Checker strictly blocks approval/posting if reviewer/poster created, submitted, or counted any line. Posting verifies `Snapshot Integrity` (live ledger still equals snapshot) and posts `stocktake_shortage` (`Dr 5200 / Cr 12xx`) or `stocktake_surplus` (`Dr 12xx / Cr 5200`).

### Phase I — Finance Manager Acceptance
- **Single Treasury Approval Gate:** All financial approvals flow through `CashDocument` (`الخزينة والاعتمادات`, `CANONICAL_TREASURY_ID = 00000000-0000-0000-0000-000000000001`). Non-FM cash documents wait `pending` until approved (`created_by != approver`, payroll preparers blocked); `finance_manager` auto-approves atomically on creation and rolls back on insufficient balance. Rejected documents create zero `CashLedgerEntry` or `JournalEntry` rows.
- **Supported Modules:** Treasury cash-ins/outs/transfers, supplier AP (`2100`) & payments, customer AR (`1100`) & collections (including split return inspection), custody accounts (`petty_cash`), daily custody expenses, custody settlement with auto-close, payroll (`employees`, attendance ref, daily work-days, manual allowances/deductions, single Treasury disbursement), and 19 interactive tabs in `التقارير` including `قائمة الدخل` (GL Profit & Loss with calendar period filter).

---

## 3. Exact User Roles, Permissions & Account-Switching Map

There are **exactly 4 roles** in the implementation (`apps/api/app/core/permissions.py`). **No separate Purchasing Officer, Sales Manager, or Shop-Floor Operator roles exist.**

| Role Key | Arabic Title | Dev Account (`DEV_AUTH_ENABLED=True`) | Primary End-to-End Responsibilities in Simulation | Strict Restrictions / Maker-Checker Boundaries |
|---|---|---|---|---|
| `warehouse_manager` | **أمين المخزن** | `wh@qemma.local` (`...0002`) | Catalog item draft creation/submit, Units CRUD, Suppliers, Purchase Invoices & Receiving (`GRN`), Full-balance supplier payment requests, Production raw material dispatch (`TR-*`), Extra issues (`TRX-*`), Workshop return receipt/inspection, FG receipt (`FG-VAR-*`), Customer deliveries & returns inspection, Stocktake create/count/submit. | **Redacted from all prices (`0.00`)** on supplier invoices; **cannot** approve catalog items, **cannot** receive materials in WIP that they dispatched, **cannot** approve/post stocktakes, **cannot** view Treasury/Reports/Payroll or create customer orders. |
| `production_manager` | **مسؤول الإنتاج / مدير الإنتاج** | `prod@qemma.local` (`...0004`) | Models/Variants & BOM definitions, Production Orders create/manage, Workshop material & extra-issue receipt confirmation, 5 Sequential Production Stages + Rollback, Defects, Workshop raw material reconciliation (`consumed`/`returned`/`scrapped`), Return resolution, Production Order Closure. | **Cannot** dispatch raw materials or receive FG in `finished_goods`, **cannot** approve catalog/stocktake, **cannot** access Finance/Treasury/Payroll/Customers. |
| `finance_manager` | **المدير المالي** | `fin@qemma.local` (`...0003`) | Catalog item approve/reject *(2026-11-11 uncommitted)*, Stocktake review/approve/post *(2026-11-11 uncommitted)*, Customer creation & Sales Orders (with pricing & discount), Customer collections, Supplier payments & Treasury `pending` approvals (`الخزينة والاعتمادات`), Manual receipts/expenses/transfers, Custody create/fund/expenses/settlement, Employees & Payroll calculate/disburse, All 18 Financial Reports. | **Cannot** create supplier invoices or confirm supplier/FG warehouse receipts (`suppliers:invoices:create` / `suppliers:receive` / `warehouse:finished_goods:receive` absent); **auto-approves own `CashDocument`s on creation**; cannot approve documents created by self (Maker-Checker). |
| `general_manager` | **المدير العام** | Local Dev GM (`...0001`) | Full oversight across all 46 permissions (`لوحة التشغيل`, all workflows, fallback resolver/approver). | Still bound by **Anti-Self-Approval** (cannot approve own submitted catalog item, own submitted stocktake, own created `CashDocument`, or receive own dispatched transfer). |

### How to Switch Accounts During the Meeting (Local Pilot Mode)
1. Look at the **top-left / header user badge** showing the currently active role/user.
2. Click **`تغيير الحساب` / `تسجيل الخروج`** *(opens `SignInModal`: «التبديل السريع للتطوير (Local Dev)»)*.
3. Click the exact button for the next role:
   - **`دخول كأمين مخزن`** (`warehouse_manager`)
   - **`دخول كمدير إنتاج`** (`production_manager`)
   - **`دخول كمدير مالي`** (`finance_manager`)
   - **`دخول كمدير عام`** (`general_manager`)
4. **Role-switch sanity check:** Verify the sidebar changes immediately (e.g., `أمين المخزن` sees `المشتريات` & `المخازن`, `مدير الإنتاج` sees `أوامر التشغيل` & `الموديلات والمقاسات`, `المدير المالي` sees `الخزينة والاعتمادات`, `اعتماد الأصناف والجرد`, `العملاء والطلبات والتحصيل`, `الرواتب`, `التقارير`).

> **Minor UI Note:** `SignInModal.tsx` still shows old subtitles on `دخول كمدير عام` / `دخول كمدير مالي`; rely on the actual sidebar and this guide, not those static modal blurbs.

---

## 4. Technical Prerequisites, Blockers & Pre-Meeting Launch Runbook

### Current Local Database Inspection Summary
| Database | Alembic Revision | Tables | Record State | Safe for Handover Demo? |
|---|---|---|---|---|
| `qemma_erp_dev` *(default `.env`)* | `20261106_0016` *(7 behind head)* | 56 | 1 warehouse, 3 roles, `173` items, `DEMO-` pollution | **NO — Blocked / Unusable** |
| `qemma_pilot_demo` *(pilot DB)* | `20261111_0023` *(at head — reset clean)* | 62 | Clean base seed (`8` items, `6` products, `0` orders) | **READY FOR HANDOVER DEMO** |
| `qemma_test_db` *(pytest isolated)* | `20261111_0023` *(at head)* | 62 | `754` items, `214` orders (automated test artifacts) | **NO — Pytest Only** |

### Pre-Meeting Launch Sequence (Ready Now — Database Already Reset & Migrated)
All commands assume `D:\Qema Project\apps\api` (API) and `D:\Qema Project\apps\web` (Web), with local PostgreSQL running on `127.0.0.1:5432`:

```powershell
# Terminal 1 — Start isolated pilot API on http://localhost:8010 (qemma_pilot_demo already at 20261111_0023)
cd "D:\Qema Project\apps\api"
python scripts/run_pilot_api.py
```

```powershell
# Terminal 2 — Start frontend pointing strictly to Pilot API (port 5180)
cd "D:\Qema Project\apps\web"
$env:VITE_API_BASE_URL = "http://localhost:8010"
npm run dev -- --port 5180
```

```powershell
# Terminal 3 (After meeting / verification) — Read-only cross-screen consistency check
cd "D:\Qema Project\apps\api"
python scripts/check_pilot_consistency.py --api http://localhost:8010
```

> **CRITICAL WARNINGS BEFORE DEMO:**
> 1. **Do NOT run `scripts/seed_pilot_demo.py`** against current code (it breaks when `gm` tries to approve `fm`'s auto-approved opening cash document). Perform the live reset (`reset_pilot_demo_db.py --yes`) and walk through **Steps 0–27** live — `reset_pilot_demo_db.py` already seeds the 3 warehouses (`main_raw_materials`, `work_in_progress`, `finished_goods`), 5 base units (`meter`, `piece`, `roll`, `kg`, `dozen`), hierarchical item categories, `TREASURY-MAIN` (`00000000-...-0001`), Chart of Accounts (`1010..5400`), and 4 roles (`seed_provisional_data_if_empty` also adds 8 `draft` items and 6 starter products, which we intentionally leave untouched while using clean `THB-*` / `SIM-*` codes below so every number reconciles cleanly).
> 2. **Run from the current working tree** on `feat/customer-returns` (do not stash/discard the uncommitted `2026-11-11` changes, otherwise `finance_manager` loses catalog/stocktake approval permissions and `warehouse_manager` loses unit management).

---

## 5. Realistic Demonstration Dataset (100-Piece Egyptian Thobe / Galabiya Scenario)

All quantities and prices below use **synthetic codes/names (`SIM-*`, `THB-*`)**, exact base units (`meter`, `piece`, `roll`), and exact integer/2-decimal math so every balance checks cleanly:

### 5.1 Master Entities
- **Supplier:** `SIM-SUP-01` — `شركة الدلتا للغزل والنسيج والمستلزمات` (المحلة الكبرى).
- **Customer:** `SIM-CUS-01` — `معرض الأناقة العربية للملابس` (القاهرة).
- **Raw Material Items (All Approved Active via Catalog Governance):**
  1. `THB-FAB-01` — `قماش تترون أبيض فاخر` | Type: `أقمشة وخامات أساسية ومساعدة (fabric)` | Unit: `متر (meter)` | Category: `الأقمشة الرئيسية` | Classification: `confirmed` | Reorder: `100`
  2. `THB-BTN-01` — `زرار صدف أبيض` | Type: `إكسسوارات ومستلزمات خياطة (accessory)` | Unit: `قطعة (piece)` | Category: `أزرار` | Classification: `confirmed` | Reorder: `200`
  3. `THB-THR-01` — `بكرة خيط أبيض ممتاز` | Type: `إكسسوارات ومستلزمات خياطة (accessory)` | Unit: `بكرة (roll)` | Category: `خيوط الحياكة` | Classification: `confirmed` | Reorder: `10`
  4. `THB-BOX-01` — `علبة تغليف ثوب قمة` | Type: `مواد تعبئة وتغليف وشحن (packaging)` | Unit: `قطعة (piece)` | Category: `كراتين وعلب` | Classification: `confirmed` | Reorder: `50`
- **Finished Product & Variant:**
  - Model: `THB-LUX-01` — `ثوب قمة الكلاسيكي` | Size: `58` | Letter: `M` | Season: `صيفي (summer)` (auto-SKU: `THB-LUX-01-58-M-SUM`, FG Catalog SKU created on receipt: `FG-VAR-...`).
- **BOM (Per 1 Piece of `THB-LUX-01 · 58 M`):**
  - `THB-FAB-01`: `3.0` متر/قطعة (`× 100 = 300` متر | Cost: `3.0 × 120.00 = 360.00 ج.م`)
  - `THB-BTN-01`: `6.0` قطعة/قطعة (`× 100 = 600` قطعة | Cost: `6.0 × 2.00 = 12.00 ج.م`)
  - `THB-THR-01`: `0.1` بكرة/قطعة (`× 100 = 10` بكرة | Cost: `0.1 × 40.00 = 4.00 ج.م`)
  - `THB-BOX-01`: `1.0` قطعة/قطعة (`× 100 = 100` قطعة | Cost: `1.0 × 15.00 = 15.00 ج.م`)
  - **Planned Unit Material Cost:** **`391.00 ج.م / قطعة`** (**`39,100.00 ج.م`** for `100` pieces).

### 5.2 Commercial, Production & Financial Parameters
- **Opening Treasury Deposit:** `200,000.00 ج.م` (`TREASURY-MAIN`).
- **Supplier Invoice (`SIM-INV-001`):** `46,000.00 ج.م` total (`350m` fabric @ `120.00` = `42,000` + `700` btn @ `2.00` = `1,400` + `20` thread @ `45.00` minus `100.00` discount = `800` [WAC `40.00`] + `120` box @ `15.00` = `1,800`).
  - Partial Receipt #1 = `200m` fabric + `700` btn + `20` thread + `120` box (`28,000.00 ج.م`).
  - Receipt #2 = remaining `150m` fabric (`18,000.00 ج.م`).
  - Supplier Payments: `26,000.00 ج.م` direct by FM (leaving `20,000.00 ج.م` payable), then `20,000.00 ج.م` requested by WH (`طلب سداد كامل المستحق`) and approved by FM in Treasury.
- **Customer Order (`custom_manufacturing`):** `100` pcs × `650.00 ج.م` = `65,000.00` gross − `2,000.00` order discount = **`63,000.00 ج.م`** net (`net_ratio = 63,000 / 65,000`).
  - Advance deposit: `20,000.00 ج.م` cash.
  - Collection #2 after delivery: `40,000.00 ج.م` cash (leaves `3,000.00` receivable verified in reports, then cleared by final `3,000.00` collection).
- **Production Execution Extras:**
  - Extra Issue: `+1` roll thread (`THB-THR-01`, `40.00 ج.م`) → lifts `total_actual_cost` to `39,140.00 ج.م` (`391.4000/pc`) before FG receipt.
  - FG Receipt: `100` accepted, `0` rejected (`Dr 1230 39,140.00 / Cr 1220 39,140.00`).
  - Workshop Reconciliation: `295m` fabric consumed + `5m` scrapped; `600` btn consumed; `10` rolls consumed + `1` roll returned (`good`); `100` boxes consumed.
  - Return Receipt (`+1` roll = `40.00 ج.م` back to Raw) + Order Closure (`Dr 1220 40.00 / Cr 5200 40.00`).
- **Stocktake (`main_raw_materials`):** Book (`50m`, `100 btn`, `10 roll`, `20 box` = `6,900.00 ج.م`) vs Counted (`48m`, `105 btn`, `10 roll`, `20 box` = `6,670.00 ج.م`) → net `-2m` (`-240.00`) + `+5` btn (`+10.00`) = `-230.00 ج.م`.
- **Direct Expense, Custody & Payroll:**
  - Direct Expense: `1,500.00 ج.م` (ورشة / كهرباء).
  - Custody: `5,000.00 ج.م` funded → `1,200.00 ج.م` daily expense (نقل خامات) → `3,800.00 ج.م` cash returned & custody closed.
  - Payroll (2 synthetic employees): `SIM-EMP-01` (Monthly `6,000` + `500` incentive = `6,500`) + `SIM-EMP-02` (Daily `300 × 10` days = `3,000`) = **`9,500.00 ج.م`**.

---

## 6. Stakeholder Handover Meeting Execution Guide (Step-by-Step)

Open **`http://localhost:5180`** after starting the pilot API & web servers. Use the local quick-login switcher for all account switches.

### Step 0 — Seed Opening Working Capital in Treasury
1. **Step:** `0` *(Pre-Operations Cash Setup)*
2. **Role:** `المدير المالي` (`finance_manager`)
3. **Screen:** `المصروفات والإيرادات ← سندات القبض والصرف` → tab **`＋ قبض نقدي`**
4. **Enter:**
   - **الحساب المستلم:** `الخزنة الرئيسية` (`TREASURY-MAIN`)
   - **التصنيف:** `إيرادات تشغيلية أخرى / بيع مخلفات (حساب 4200)`
   - **المبلغ:** `200000`
   - **البيان:** `رصيد افتتاحي وتشغيلي لمحاكاة مصنع القمة`
5. **Button:** **`تأكيد وتسجيل سند القبض`**
6. **What Happens Next:** Because `finance_manager` is in `POST_ON_CREATION_ROLES`, the document posts **immediately** as `معتمد` (zero pending row in Treasury) and increases `1010` Treasury balance to `200,000.00 ج.م` (`Dr 1010 / Cr 4200`).
7. **Verify Before Proceeding:** Open `الخزينة والاعتمادات` → card **`الخزنة الرئيسية`** reads **`200,000.00 ج.م`**.
8. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** Cash `200,000.00` available for supplier settlement, custody, and payroll.

---

### Step 1 — Create Raw Material Catalog Items (Drafts)
1. **Step:** `1` *(Phase B — Catalog Creation)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `المخازن ← دليل الخامات والأصناف` → tab **`الأصناف`**
4. **Enter & Submit 4 Items** *(click **`＋ إضافة صنف جديد`** for each; note: leave or ignore `"تفعيل الصنف فوراً"` checkbox as backend creates drafts, and **MUST** set **`حالة المراجعة والتوثيق`** to **`معتمد وموثق (Confirmed)`**, NOT `قيد المراجعة`)*:
   - Item 1: Code `THB-FAB-01`, Name `قماش تترون أبيض فاخر`, Type `أقمشة وخامات أساسية ومساعدة`, Unit `متر (meter)`, Category `الأقمشة الرئيسية`, Status `معتمد وموثق (Confirmed)`, Reorder `100`.
   - Item 2: Code `THB-BTN-01`, Name `زرار صدف أبيض`, Type `إكسسوارات ومستلزمات خياطة`, Unit `قطعة (piece)`, Category `أزرار`, Status `معتمد وموثق (Confirmed)`, Reorder `200`.
   - Item 3: Code `THB-THR-01`, Name `بكرة خيط أبيض ممتاز`, Type `إكسسوارات ومستلزمات خياطة`, Unit `بكرة (roll)`, Category `خيوط الحياكة`, Status `معتمد وموثق (Confirmed)`, Reorder `10`.
   - Item 4: Code `THB-BOX-01`, Name `علبة تغليف ثوب قمة`, Type `مواد تعبئة وتغليف وشحن`, Unit `قطعة (piece)`, Category `كراتين وعلب`, Status `معتمد وموثق (Confirmed)`, Reorder `50`.
   *(Optional Unit Demo: also briefly open tab **`وحدات القياس`** to show `warehouse_manager` can add/edit unused units, explaining no cross-unit conversion exists.)*
5. **Buttons:** Save each modal, then click **`عرض وتعديل`** on each `THB-*` row → click **`🚀 تقديم الصنف للاعتماد`**.
6. **What Happens Next:** All 4 items transition `draft → pending_review` (`is_active = false`), recording audit events in `CatalogApprovalHistory`. They cannot yet be purchased or added to BOMs.
7. **Verify Before Proceeding:** All 4 `THB-*` items show status **`قيد الاعتماد`**.
8. **Switch Account:** **Switch to `المدير المالي` (`finance_manager`)**.
9. **Consequence:** Items enter `pending_review` governance queue.

---

### Step 2 — Approve Raw Material Catalog Items (Anti-Self-Approval Gate)
1. **Step:** `2` *(Phase B — Catalog Approval)*
2. **Role:** `المدير المالي` (`finance_manager`) *(using uncommitted `2026-11-11` approval permission)*
3. **Screen:** `اعتماد الأصناف والجرد ← دليل الخامات والأصناف` *(or click items from `الرئيسية · مهامي واعتماداتي`)*
4. **Enter:** Filter `حالة دورة الاعتماد = قيد الاعتماد` (via `فلاتر متقدمة`) or locate the 4 `THB-*` items.
5. **Button:** Open each of the 4 items (`عرض وتعديل`) → click **`✅ اعتماد الصنف`**.
6. **What Happens Next:** Status becomes `approved` and `is_active = true` with `CatalogApprovalHistory` trail (`submitted_by != approved_by`).
7. **Verify Before Proceeding:** All 4 `THB-*` items show active approved badges.
8. **Switch Account:** **Switch back to `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** All 4 items are now selectable in supplier invoices and BOMs.

---

### Step 3 — Create Supplier Master Record
1. **Step:** `3` *(Phase A — Supplier Setup)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `البيانات الأساسية ← تبويب الموردون`
4. **Enter:** Click **`＋ مورد جديد`** → Code `SIM-SUP-01`, Name `شركة الدلتا للغزل والنسيج والمستلزمات`, Phone `01012345678`, Address `المحلة الكبرى - المنطقة الصناعية`.
5. **Button:** **`حفظ`**
6. **What Happens Next:** Creates active supplier `SIM-SUP-01`.
7. **Verify Before Proceeding:** Supplier row `شركة الدلتا للغزل والنسيج والمستلزمات (SIM-SUP-01)` appears in table.
8. **Switch Account:** **Stay on `أمين المخزن` (`warehouse_manager`)** *(to match the real RBAC split: `finance_manager` cannot create supplier invoices, while `warehouse_manager` can enter invoice quantities and prices from the paper bill — after saving, monetary totals display as `0.00` to `warehouse_manager`; if you prefer the creator to see totals post-save, `general_manager` may perform Step 4 instead)*.
9. **Consequence:** Supplier record ready for purchasing.

---

### Step 4 — Create & Save Supplier Invoice (Before Warehouse Receipt)
1. **Step:** `4` *(Phase A — Purchasing Split)*
2. **Role:** `أمين المخزن` (`warehouse_manager`) *(or `المدير العام` if demonstrating visible money preview during entry)*
3. **Screen:** `المشتريات ← فواتير الشراء والاستلام`
4. **Enter:** Click **`＋ تسجيل فاتورة شراء جديدة`**:
   - Supplier: `شركة الدلتا للغزل والنسيج والمستلزمات`
   - Paper Invoice Number: `SIM-INV-001`
   - Add 4 lines (`＋ إضافة البند`):
     1. `THB-FAB-01` | Qty `350` | Unit Price `120` | Discount `0`
     2. `THB-BTN-01` | Qty `700` | Unit Price `2` | Discount `0`
     3. `THB-THR-01` | Qty `20` | Unit Price `45` | Discount `100`
     4. `THB-BOX-01` | Qty `120` | Unit Price `15` | Discount `0`
   *(Note: Point out to stakeholders that no tax field exists; net price/discounts are entered directly per line.)*
5. **Button:** **`حفظ فاتورة الشراء (بانتظار استلام المخزن)`**
6. **What Happens Next:** Generates `PI-*` invoice with status `بانتظار استلام المخزن (awaiting_receipt)`, total `46,000.00 ج.م` (visible as `0.00` to `أمين المخزن`), **0** stock added, and **0** GL payable entries (`2100 = 0.00`).
7. **Verify Before Proceeding:** Open `مخزن الخامات` briefly to prove `THB-FAB-01` balance is still `٠.٠٠ (غير مثبت)`.
8. **Switch Account:** **Stay on `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** Commitment recorded; physical stock and AP (`2100`) remain `0.00` until receipt.

---

### Step 5 — Partial Warehouse Receipt #1 Against Supplier Invoice (`GRN-1`)
1. **Step:** `5` *(Phase A — Partial Receiving)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `المشتريات ← فواتير الشراء والاستلام` → click `استلام بالمخزن` on `SIM-INV-001`
4. **Enter:** Receive **partial fabric + full trims/packaging**:
   - `THB-FAB-01`: `200` *(out of 350)*
   - `THB-BTN-01`: `700`
   - `THB-THR-01`: `20`
   - `THB-BOX-01`: `120`
   - Delivery Note: `دفعة أولى - وصل 200 متر قماش من أصل 350`
5. **Button:** **`تأكيد الاستلام بالمخزن`**
6. **What Happens Next:** Creates `GRN-*` #1, posts `StockLedgerEntry(entry_type="supplier_receipt")` into `main_raw_materials` (`200m` @ `120.00`, `700` btn @ `2.00`, `20` thr @ `40.00`, `120` box @ `15.00`), sets invoice status to `مستلم جزئياً (partially_received)`, and posts GL **`Dr 1210 / Cr 2100 = 28,000.00 ج.م`**.
7. **Verify Before Proceeding:** Open `المخازن ← مخزن الخامات`: confirm `THB-FAB-01 = 200 متر`, `THB-BTN-01 = 700 قطعة`, `THB-THR-01 = 20 بكرة`, `THB-BOX-01 = 120 قطعة`.
8. **Switch Account:** **Stay on `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** Raw Stock Value = `28,000.00`, Supplier AP (`2100`) = `28,000.00`, Remaining unreceived fabric = `150m`.

---

### Step 6 — Final Warehouse Receipt #2 (`GRN-2`) & Full-Balance Payment Request
1. **Step:** `6` *(Phase A — Complete Receiving + WH Payment Request)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `المشتريات ← فواتير الشراء والاستلام` → open `SIM-INV-001`
4. **Enter:** Click **`وصل كل المتبقي`** *(auto-fills `150` for `THB-FAB-01` and `0` for completed lines)*.
5. **Button:** **`تأكيد الاستلام بالمخزن`**
6. **What Happens Next:** Creates `GRN-*` #2 for `150m` (`18,000.00 ج.م`), moves invoice to `مستلم بالكامل (received)`, posts GL **`Dr 1210 / Cr 2100 = 18,000.00 ج.م`** (Total Received Value & AP = **`46,000.00 ج.م`**).
   - *(Notice on the `received` invoice: `أمين المخزن` now sees button `طلب سداد كامل المستحق`—do NOT click it yet if you want FM to pay a partial `26,000.00` first in Step 7! Wait until Step 25 for WH to test `طلب سداد كامل المستحق` on the remaining `20,000.00`!)*
7. **Verify Before Proceeding:** `مخزن الخامات` shows `THB-FAB-01 = 350 متر` (`عرض الحركات` displays both `GRN-1 = +200` and `GRN-2 = +150`).
8. **Switch Account:** **Switch to `المدير المالي` (`finance_manager`)**.
9. **Consequence:** Raw Materials (`1210`) = **`46,000.00 ج.م`**, Supplier AP (`2100`) = **`46,000.00 ج.م`**.

---

### Step 7 — Verify Supplier Liability, Item Costing (WAC), & Partial Supplier Payment
1. **Step:** `7` *(Phase A/B — AP Verification & Partial Settlement)*
2. **Role:** `المدير المالي` (`finance_manager`)
3. **Screen:** `مستحقات الموردين` (`فواتير الشراء والاستلام`) + `التقارير ← تقييم المخزون`
4. **Enter:** Click `طلب سداد` on `SIM-INV-001` → Amount **`26000`**, Method `نقدي`, Notes `دفعة أولى من مستحق المورد`.
5. **Button:** **`طلب سداد (يُعتمد في الخزينة)`**
6. **What Happens Next:** Inspect `SIM-INV-001` financial card first (`46,000.00` total, `0.00` paid, `46,000.00` due) and `التقارير → تقييم المخزون` showing WAC (`120.00`, `2.00`, `40.00` net of `100` discount, `15.00`). On payment submit by FM, FM auto-approves immediately: Treasury drops `200,000 → 174,000.00 ج.م`, GL **`Dr 2100 / Cr 1010 = 26,000.00 ج.م`**, remaining Supplier AP (`2100`) = **`20,000.00 ج.م`**.
7. **Verify Before Proceeding:** Check `الخزينة والاعتمادات` = `174,000.00 ج.م`, and `مستحقات الموردين` balance due = `20,000.00 ج.م`.
8. **Switch Account:** **Switch to `مدير الإنتاج` (`production_manager`)**.
9. **Consequence:** Cash `174,000.00`, Raw Inventory `46,000.00`, AP `20,000.00`.

---

### Step 8 — Create Thobe Model, Size Variant & Variant BOM
1. **Step:** `8` *(Phase D — Model & BOM Configuration)*
2. **Role:** `مدير الإنتاج` (`production_manager`)
3. **Screen:** `الموديلات والمقاسات` *(via sidebar)* → **`＋ موديل جديد`**
4. **Enter:**
   - Code: `THB-LUX-01`, Name: `ثوب قمة الكلاسيكي`, Numeric Size: `58`, Letter Size: `M`, Season: `صيفي`.
   - Click **`حفظ ثم تعريف المستلزمات`** → BOM Editor opens automatically for `مقاس 58 M · صيفي`:
     - Add 4 lines (`＋ إضافة صنف`, quantities **per 1 piece**):
       1. `THB-FAB-01` → `3`
       2. `THB-BTN-01` → `6`
       3. `THB-THR-01` → `0.1`
       4. `THB-BOX-01` → `1`
5. **Button:** **`حفظ مستلزمات هذا المقاس`**
6. **What Happens Next:** Saves version `v1 (active)` of BOM on `THB-LUX-01` (`58 M · صيفي`). Product card changes from `ينقصه مستلزمات` to **`جاهز للتشغيل`**.
7. **Verify Before Proceeding:** Chip `58 M ✓` displays `جاهز للتشغيل` (`مستلزماته معرّفة إصدار 1`).
8. **Switch Account:** **Switch to `المدير المالي` (`finance_manager`)**.
9. **Consequence:** Model & active BOM ready for custom sales & production orders.

---

### Step 9 — Create Customer, Confirm Custom-Manufacturing Sales Order (100 Units) & Collect Advance Deposit
1. **Step:** `9` *(Phase C — Customer, Sales Order & Advance Deposit)*
2. **Role:** `المدير المالي` (`finance_manager`) *(has `customers:orders:create` + `pricing:manage`)*
3. **Screen:** `العملاء والطلبات والتحصيل`
4. **Enter:**
   - Click **`＋ تسجيل عميل`**: Code `SIM-CUS-01`, Name `معرض الأناقة العربية للملابس`, Phone `01198765432`, City `القاهرة` → **`حفظ بيانات العميل`**.
   - On opened `CustomerAccountPage`, click **`＋ طلب جديد`**:
     - **نوع الطلب:** `تصنيع خاص للعميل (custom_manufacturing)`
     - **الموديل:** `ثوب قمة الكلاسيكي · THB-LUX-01`, **المقاس:** `مقاس 58 (M) — صيفي`
     - **الكمية:** `100` | **سعر الوحدة (ج.م):** `650`
     - **خصم على الطلب (ج.م):** `2000` *(verify Net Order preview = `63,000.00 ج.م`)*
     - **طريقة/شروط التعامل:** `دفعة مقدمة 20,000 ج.م والباقي عند التسليم (نص توثيقي)`
     - Click **`حفظ الطلب`**.
   - On the saved order card (`status: مفتوح`), click **`＋ تسجيل تحصيل مالي`**:
     - Amount: `20000`, Method: `نقدي`, Reference: `SIM-RC-01` → Click **`تسجيل التحصيل`**.
5. **Buttons:** `حفظ بيانات العميل` → `حفظ الطلب` → `تسجيل التحصيل`.
6. **What Happens Next:** Order starts immediately as `open` (`total_amount = 63,000.00`). No inventory deducted, no AR (`1100`) revenue yet. Collection auto-approves immediately under FM: Treasury rises `174,000 → 194,000.00 ج.م`, Customer `paid_amount = 20,000.00`, `receivable_amount = -20,000.00` *(رصيد دائن للعميل / دفعة مقدمة)*, `balance_amount = 43,000.00 ج.م`. *(Note: point out the stale yellow UI banner inside `PaymentModal` still says "pending", while `194,000` reflects immediately.)*
7. **Verify Before Proceeding:** Customer Account shows `قيمة ما تم تسليمه: 0.00`, `مديونية العميل: -20,000.00 ج.م`, Treasury = `194,000.00 ج.م`.
8. **Switch Account:** **Switch to `مدير الإنتاج` (`production_manager`)** *(or check `أمر تشغيل` link)*.
9. **Consequence:** Cash `194,000.00`, Advance Liability/Negative AR `-20,000.00`, `custom_manufacturing` line ready for production.

---

### Step 10 — Create Production Order Linked to Sales Order (BOM & Stock Check)
1. **Step:** `10` *(Phase D — Linked Production Order)*
2. **Role:** `المدير العام` (`general_manager`) or `مدير الإنتاج` (`production_manager`)
   - *(Note on Screen Access: `production_manager` does NOT have `customers:view`, so `production_manager` cannot open `العملاء`! Instead, EITHER switch briefly to `المدير العام` to click `＋ أمر تشغيل` directly from `CustomerAccountPage`, OR `production_manager` creates a `private_label` order in `أوامر التشغيل ← أمر تشغيل جديد` — wait: creating from **`NewOrderModal`** does NOT set `customer_order_line_id` link on `CustomerOrderLine`, whereas **`CustomerAccountPage → ＋ أمر تشغيل`** as `المدير العام` links `customer_order_line_id` directly while still producing in `private_label:SIM-CUS-01`! Recommended for cleanest demo: switch briefly to `المدير العام` for Step 10 so stakeholders see direct Sales-to-Production Order linkage!)*
3. **Screen (as `المدير العام`):** `المبيعات ← العملاء وطلبات البيع` → click **`معرض الأناقة العربية للملابس`** → on the `open` order line, click **`＋ أمر تشغيل`**
4. **Enter:** Verify Quantity = `100`, select active template `THB-LUX-01 مقاس 58`, click **`إنشاء أمر التشغيل`**.
   - Then switch to `التشغيل ← أوامر التشغيل`, open the new `PO-*` order (`بانتظار صرف الخامات`) → tab **`الخامات: الصرف والاستلام`** to demonstrate BOM breakdown (`300m`, `600`, `10`, `100`) and stock availability (`350m`, `700`, `20`, `120` available).
5. **Button:** **`إنشاء أمر التشغيل`**
6. **What Happens Next:** Creates `PO-*` in `draft` (`بانتظار صرف الخامات`) with frozen `ProductionOrderItemMaterial` + `ProductionOrderMaterial` (`planned_quantity`) and 5 `not_started` stages. **Stock is NOT yet reduced or reserved.**
7. **Verify Before Proceeding:** `SIM-CUS-01` order line shows linked `PO-*`, and `PO-*` appears in `أوامر التشغيل` as `بانتظار صرف الخامات`.
8. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** Warehouse dispatch queue now holds `PO-*`.

---

### Step 11 — Warehouse Raw Material Dispatch (`TR-*` to WIP `in_transit`)
1. **Step:** `11` *(Phase E — Warehouse Issue)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `صرف الخامات واستلام التام` (`أوامر التشغيل`) → click **`نفّذ الخطوة ‹`** on `PO-*` → tab **`الخامات: الصرف والاستلام`**
4. **Enter:** Review `المخطط في الأمر` (`300m`, `600`, `10`, `100`) vs `المتاح بالمخزن`.
5. **Button:** **`صرف الخامات (بالطريق) ←`**
6. **What Happens Next:** Locks all 4 raw items, verifies stock sufficiency, creates `WarehouseTransfer` (`TR-*`, status `in_transit`), deducts `main_raw_materials` (`350→50m`, `700→100`, `20→10`, `120→20`), adds `300m/600/10/100` to `location_type="in_transit"`, freezes WAC (`120.00`, `2.00`, `40.00`, `15.00` = `39,100.00 ج.م`), and updates `PO-*` to `materials_dispatched` (`خامات في الطريق للورشة`). **No GL entry yet** (not in WIP yet) and `أمين المخزن` is blocked from seeing the Step 2 workshop receipt button (`dispatched_by` separation).
7. **Verify Before Proceeding:** `مخزن الخامات` shows remaining `50 متر` fabric, `100` buttons, `10` thread rolls, `20` boxes.
8. **Switch Account:** **Switch to `مدير الإنتاج` (`production_manager`)**.
9. **Consequence:** Raw stock reduced by `39,100.00`; materials sit `in_transit` awaiting workshop confirmation.

---

### Step 12 — Workshop Material Receipt Confirmation (WIP Entry & Anti-Self-Receipt)
1. **Step:** `12` *(Phase E — Workshop Receipt)*
2. **Role:** `مدير الإنتاج` (`production_manager`)
3. **Screen:** `أوامر التشغيل` → click **`نفّذ الخطوة ‹`** on `PO-*` → tab **`الخامات: الصرف والاستلام`**
4. **Enter:** Verify default pre-filled quantities equal dispatched (`300`, `600`, `10`, `100`) *(point out UI allows entering `0 .. dispatched` to document transit shortages)*. Leave at `300`, `600`, `10`, `100`.
5. **Button:** **`✓ تأكيد استلام الخامات وتسجيل الفروقات`**
6. **What Happens Next:** Releases `in_transit`, credits `work_in_progress` (`bucket = order:{PO_id}`) with `300m`, `600` btn, `10` rolls, `100` boxes, updates `order.actual_material_cost = 39,100.00`, `order.wip_balance = 39,100.00`, `unit_manufacturing_cost = 391.0000`, posts GL **`Dr 1220 / Cr 1210 = 39,100.00 ج.م`**, and changes `PO-*` status to **`in_production` (`قيد التصنيع`)**.
7. **Verify Before Proceeding:** Tab `مراحل التصنيع` unlocks! Look at `مخطط` = `300/600/10/100`, `منصرف` = `300/600/10/100`, `مستلم` = `300/600/10/100`.
8. **Switch Account:** **Stay on `مدير الإنتاج` (`production_manager`)**.
9. **Consequence:** WIP inventory `1220 = 39,100.00 ج.م`; Raw `1210 = 6,900.00 ج.م`.

---

### Step 13 — Execute Production Stage 1 (`القص`) & Sequential Guard Demo, Plus Stage 2 (`التشطيب`) + Defect Note
1. **Step:** `13` *(Phase F — Stages 1 & 2 + Sequential Check)*
2. **Role:** `مدير الإنتاج` (`production_manager`)
3. **Screen:** `أوامر التشغيل` → `PO-*` → tab **`مراحل التصنيع`**
4. **Enter / Test:**
   - **Demo Sequential Lock:** Show Stage 2 (`التشطيب`) button is disabled (`يجب إكمال المرحلة السابقة أولاً`).
   - Stage 1 (`القص على الباترون`): Click **`بدء المرحلة ▶`** → enter note `بدأ قص 100 ثوب مقاس 58` → Click **`✓ إكمال المرحلة`**.
   - Stage 2 (`التشطيب`): Click **`بدء المرحلة ▶`** → open tab **`العيوب والهالك`** → log 1 defect (`affect_qty = 2`, stage `التشطيب`, `خياطة غير متوازنة تم إصلاحها فوراً`, action `إعادة خياطة خط جانبي`) to show quality tracking → return to `مراحل التصنيع` and click **`✓ إكمال المرحلة`** on Stage 2 (`التشطيب`).
5. **Button:** `بدء المرحلة ▶` → `✓ إكمال المرحلة` sequentially.
6. **What Happens Next:** Stage events and `ProductionStageHistory` rows record actor/timestamps. Defects are logged without affecting inventory.
7. **Verify Before Proceeding:** Stages 1 & 2 show `مكتملة`, progress bar = `40%`, Stages 3 (`تركيب الكبسولة`) now unlocked.
8. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)** for Step 14 *(Extra Issue demonstration)*.
9. **Consequence:** Stage 1 & 2 complete; real-world extra thread roll needed before finishing assembly.

---

### Step 14 — Extra Raw Material Issue (`TRX-*`) & Workshop Receipt
1. **Step:** `14` *(Phase E/F — Extra Material Issue)*
2. **Role:** `أمين المخزن` (`warehouse_manager`) → then `مدير الإنتاج` (`production_manager`)
3. **Screen:** `أوامر التشغيل` → `PO-*` → tab **`الخامات: الصرف والاستلام`** → section **`صرف خامات إضافي`** (`ExtraIssuePanel`)
4. **Enter (as `أمين المخزن`):**
   - Click **`＋ صرف إضافي`** → Reason: `تلف بكرة خيط أثناء مرحلة التشطيب`, Item: `THB-THR-01` (`بكرة خيط أبيض ممتاز`), Qty: `1` → click **`ترحيل الصرف`** and confirm **`ترحيل الصرف`** (`TRX-*` created `in_transit`).
   - **Switch to `مدير الإنتاج` (`production_manager`):** Open same tab → verify `1` received → click **`تأكيد استلام الورشة`** and confirm **`تأكيد الاستلام`**.
5. **Button:** `＋ صرف إضافي` → `ترحيل الصرف` (`WH`), then `تأكيد استلام الورشة` (`PM`).
6. **What Happens Next:** `main_raw_materials` drops `10 → 9` rolls; `work_in_progress` (`order:{id}`) gets `+1` roll (`11` total); `order.actual_material_cost` & `wip_balance` rise `39,100.00 → 39,140.00`; **`unit_manufacturing_cost` recalculates to `391.4000 ج.م`**; GL posts **`Dr 1220 / Cr 1210 = 40.00 ج.م`**.
7. **Verify Before Proceeding:** `مخزن الخامات` shows `THB-THR-01 = 9 بكرة`; order shows `TRX-*` received.
8. **Switch Account:** **Stay on `مدير الإنتاج` (`production_manager`)**.
9. **Consequence:** Raw `1210 = 6,860.00`, WIP `1220 = 39,140.00`, Unit Cost = `391.4000`.

---

### Step 15 — Complete Production Stages 3, 4 & 5
1. **Step:** `15` *(Phase F — Complete Remaining Stages)*
2. **Role:** `مدير الإنتاج` (`production_manager`)
3. **Screen:** `أوامر التشغيل` → `PO-*` → tab **`مراحل التصنيع`**
4. **Execute in Strict Sequence:**
   - Stage 3 (`تركيب الكبسولة`): **`بدء المرحلة ▶`** → **`✓ إكمال المرحلة`**
   - Stage 4 (`الكي`): **`بدء المرحلة ▶`** → **`✓ إكمال المرحلة`**
   - Stage 5 (`التعبئة والتغليف`): **`بدء المرحلة ▶`** → **`✓ إكمال المرحلة`**
5. **What Happens Next:** Completing Stage 5 (`packing`) reaches `100%` (5 of 5) and transitions `PO-*` to **`manufacturing_completed` (`اكتمل التصنيع`)**. **WIP is still `39,140.00` and FG is still `0`** until WH confirms Finished Goods receipt.
6. **Verify Before Proceeding:** `PO-*` badge shows **`اكتمل التصنيع`**.
7. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)**.
8. **Consequence:** Order enters Warehouse FG Receipt queue (`مخزن المنتج التام`).

---

### Step 16 — Finished Goods Receiving (`100` Accepted Units)
1. **Step:** `16` *(Phase G — FG Receiving)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `المخازن ← مخزن المنتج التام` → tab **`بانتظار الاستلام`** *(or `OrderDetailModal → استلام المنتج التام`)*
4. **Enter:** Verify line `ثوب قمة الكلاسيكي · مقاس 58 M` (`تصنيع خاص: معرض الأناقة العربية للملابس`), **`سليم الآن`** = `100`, **`مرفوض الآن`** = `0`, Notes `فحص جودة كامل - 100 قطعة مطابقة`.
5. **Button:** **`✓ تأكيد استلام التام`**
6. **What Happens Next:** Auto-creates `CatalogItem` `FG-VAR-*`, inserts `StockLedgerEntry(+100)` in `finished_goods` (`bucket = private_label:{SIM-CUS-01}` @ `unit_cost = 391.4000`), reduces `order.wip_balance` from `39,140.00 → 0.00`, posts GL **`Dr 1230 / Cr 1220 = 39,140.00 ج.م`**, and sets `PO-*` to **`receipt_completed` (`استُلم المنتج التام`)**.
7. **Verify Before Proceeding:** Switch to tab `استعراض الأرصدة` in `مخزن المنتج التام`: confirm `100 قطعة` under **`تصنيع خاص: معرض الأناقة العربية للملابس`** (and `0` under `متاح للبيع براند المصنع` so it cannot accidentally ship to another customer).
8. **Switch Account:** **Switch to `مدير الإنتاج` (`production_manager`)**.
9. **Consequence:** FG `1230 = 39,140.00`, WIP `1220 = 0.00` *(dollar balance `0`, raw quantities in WIP warehouse still need reconciliation before closing!)*.

---

### Step 17 — Workshop Material Reconciliation (`تسوية خامات الورشة` with Scrap & Return)
1. **Step:** `17` *(Phase F/G — Mandatory Zero-WIP Material Settlement)*
2. **Role:** `مدير الإنتاج` (`production_manager`)
3. **Screen:** `أوامر التشغيل` → `PO-*` → tab **`التسوية والمرتجعات والإغلاق`**
4. **Enter:** *(Before submitting, click **`إغلاق أمر التشغيل نهائياً`** or read the blocker banner showing that remaining WIP quantities block closing!)* Then fill **`تسوية خامات الورشة`**:
   - `THB-FAB-01` (WIP `300`): Consumed **`295`** | Returned **`0`** | Scrapped **`5`** (`هالك قصاصات قص`) → Remaining `0`
   - `THB-BTN-01` (WIP `600`): Consumed **`600`** | Returned **`0`** | Scrapped **`0`** → Remaining `0`
   - `THB-THR-01` (WIP `11`): Consumed **`10`** | Returned **`1`** | Condition **`سليمة (good)`** | Scrapped **`0`** → Remaining `0`
   - `THB-BOX-01` (WIP `100`): Consumed **`100`** | Returned **`0`** | Scrapped **`0`** → Remaining `0`
   - Notes: `تسوية نهاية الدفعة وإرجاع 1 بكرة خيط سليمة`
5. **Button:** **`تسجيل تسوية الخامات`**
6. **What Happens Next:** Generates `MRC-*` reconciliation (`production_consumption` + `production_scrap`), zeros WIP raw ledger balances for `order:{PO_id}`, AND generates `TRR-*` workshop return transfer (`1` roll `THB-THR-01`, `in_transit`). Because `TRR-*` is `in_transit`, **`PO-*` STILL cannot close yet**!
7. **Verify Before Proceeding:** Table shows `المتبقي بعد التسوية = 0` for all 4 items, and panel **`مرتجعات الورشة إلى مخزن الخامات`** displays `TRR-*` awaiting warehouse receipt.
8. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** `1` roll `THB-THR-01` is `in_transit` back to `main_raw_materials`.

---

### Step 18 — Warehouse Receipt of Returned Raw Material (`TRR-*`)
1. **Step:** `18` *(Phase E/G — Workshop Return Inspection)*
2. **Role:** `أمين المخزن` (`warehouse_manager`) *(enforces `declared_by != receiver_id`)*
3. **Screen:** `أوامر التشغيل` → `PO-*` → tab **`التسوية والمرتجعات والإغلاق`** → **`مرتجعات الورشة إلى مخزن الخامات`**
4. **Enter:** For `TRR-*` (`1` roll `THB-THR-01`), enter Accepted = **`1`**, Rejected = **`0`**.
5. **Button:** **`تأكيد فحص واستلام المرتجع`**
6. **What Happens Next:** Adds `+1` roll to `main_raw_materials` (`9 → 10` rolls, `THB-THR-01` value `+40.00`), reduces `order.wip_balance` to `-40.00` (refund against earlier WIP charge), and posts GL **`Dr 1210 / Cr 1220 = 40.00 ج.م`**.
7. **Verify Before Proceeding:** `مخزن الخامات` shows `THB-THR-01 = 10 بكرة`.
8. **Switch Account:** **Switch to `مدير الإنتاج` (`production_manager`)**.
9. **Consequence:** Raw `1210 = 6,900.00`, `TRR-*` status complete.

---

### Step 19 — Final Production Order Closure (`إغلاق أمر التشغيل نهائياً`)
1. **Step:** `19` *(Phase G — Production Order Closure)*
2. **Role:** `مدير الإنتاج` (`production_manager`)
3. **Screen:** `أوامر التشغيل` → `PO-*` → tab **`التسوية والمرتجعات والإغلاق`**
4. **Enter:** Notice green confirmation `الأمر جاهز للإغلاق`. Enter Closing Notes: `تمت تسوية الخامات واستلام 100 قطعة كاملة`.
5. **Button:** **`إغلاق أمر التشغيل نهائياً`**
6. **What Happens Next:** Validates all 5 stages completed, 0 pending transfers/returns, `remaining_wip = 0.0`, settles residual `-40.00` on `order.wip_balance` via GL **`Dr 1220 / Cr 5200 = 40.00 ج.م`**, sets `order.wip_balance = 0.00`, and locks `PO-*` as **`closed` (`مغلق`)**.
7. **Verify Before Proceeding:** Status badge reads **`مغلق`**; all edit/stage/receipt buttons are locked.
8. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)**.
9. **Consequence:** Net `1220 WIP = 0.00 ج.م`; Raw `1210 = 6,900.00 ج.م`; FG `1230 = 39,140.00 ج.م`.

---

### Step 20 — Customer Delivery (`100` Pieces Shipped from FG) & Customer Partial Payment (`40,000`)
1. **Step:** `20` *(Phase C/G — Customer Delivery & Second Collection)*
2. **Role:** `أمين المخزن` (`warehouse_manager`) → then `المدير المالي` (`finance_manager`)
3. **Screen (Delivery as `أمين المخزن`):** `تسليم طلبات العملاء` → click **`🚚 صرف وتسليم`** on `معرض الأناقة العربية للملابس` (`100` pcs, `private_label` bucket `available_stock = 100`)
   - Enter Quantity: `100` *(click `أقصى كمية متاحة`)*, Recipient: `أحمد حسن (مندوب العميل)`, Notes `إذن تسليم رقم 101` → click **`✓ تأكيد الصرف وخصم رصيد التام`**.
4. **What Happens on Delivery:** Deducts `-100` from `finished_goods` (`private_label:{cus}` → `0`), updates sales order status to **`تم التسليم (delivered)`**, posts Revenue GL **`Dr 1100 / Cr 4100 = 63,000.00 ج.م`**, and COGS GL **`Dr 5100 / Cr 1230 = 39,140.00 ج.م`**. Customer `receivable (1100)` flips from `-20,000.00` to **`+43,000.00 ج.م`**.
5. **Switch to `المدير المالي` (`finance_manager`):**
   - Screen: `العملاء والطلبات والتحصيل` → `معرض الأناقة العربية للملابس` → **`＋ تسجيل تحصيل مالي`**
   - Enter Amount: `40000`, Method: `تحويل بنكي`, Reference: `SIM-TRF-02` → **`تسجيل التحصيل`**.
   - *(Treasury rises `194,000 → 234,000.00`; Customer `receivable (1100)` becomes **`+3,000.00 ج.م`** open balance for Phase I verification.)*
6. **Optional Customer Return Mini-Demo (`0022` Check — Skip or Run Separately):** If stakeholders want to see split return inspection (`pending_inspection → partially_restocked`), run it in a separate sandbox run (`WH` opens `مرتجعات العملاء → ＋ تسجيل مرتجع`, returns `2` pcs, then clicks `فحص المرتجع`, enters `1` صالح للبيع + `1` تالف, and clicks `اعتماد الفحص` → `Dr 5200 / Cr 1230` for scrap, AR drops `-1,260.00`). *(Keep `0` returns in the primary run so the Phase I checkpoint numbers below stay exact!)*
7. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)**.
8. **Consequence:** FG `1230 = 0.00`, Cash `234,000.00`, Customer AR `1100 = 3,000.00`, Sales `4100 = 63,000.00`, COGS `5100 = 39,140.00`.

---

### Step 21 — Physical Stocktake Create, Count & Submit (With Variance)
1. **Step:** `21` *(Phase H — Stocktake Field Count)*
2. **Role:** `أمين المخزن` (`warehouse_manager`)
3. **Screen:** `المخازن ← الجرد` → **`+ فتح جلسة جرد جديدة`**
4. **Enter:**
   - **المخزن المراد جرده:** `مخزن الخامات الرئيسي (main_raw_materials)`
   - **نطاق الجرد:** **`جرد دوري / أصناف محددة فقط`** *(select our 4 items: `THB-FAB-01`, `THB-BTN-01`, `THB-THR-01`, `THB-BOX-01`)*
   - **بيان / سبب الجرد:** `جرد دوري بعد إتمام دفعة الثوب الكلاسيكي`
   - Click **`فتح الجلسة وتثبيت اللقطة`** (`Book Snapshot`: `50`, `100`, `10`, `20`).
   - Click **`بدء العد الميداني`**, enter counted quantities:
     - `THB-FAB-01` (`book: 50`): **`48`** *(عجز `-2` م)*
     - `THB-BTN-01` (`book: 100`): **`105`** *(زيادة `+5` قطعة)*
     - `THB-THR-01` (`book: 10`): **`10`** *(مطابق `0`)*
     - `THB-BOX-01` (`book: 20`): **`20`** *(مطابق `0`)*
   - Click **`حفظ مسودة العد`**, verify `Count History` (`سجل محاولات العد`), then click **`رفع للاعتماد والمراجعة`**.
5. **Button:** `فتح الجلسة وتثبيت اللقطة` → `بدء العد الميداني` → `رفع للاعتماد والمراجعة`.
6. **What Happens Next:** Session enters `submitted` (`بانتظار مراجعة واعتماد الإدارة`). No inventory ledger entries yet!
7. **Verify Before Proceeding:** Variances display `-2` (`THB-FAB-01`), `+5` (`THB-BTN-01`), `0`, `0`.
8. **Switch Account:** **Switch to `المدير المالي` (`finance_manager`)**.
9. **Consequence:** Stocktake ready for independent Financial review/approval/posting.

---

### Step 22 — Stocktake Approval & Ledger Adjustment Posting
1. **Step:** `22` *(Phase H — Stocktake Approval & GL Posting under 2026-11-11 Rules)*
2. **Role:** `المدير المالي` (`finance_manager`) *(using `اعتماد الأصناف والجرد ← الجرد`)*
3. **Screen:** `اعتماد الأصناف والجرد ← الجرد` → open the `submitted` `STK-*` session
4. **Actions:**
   - *(Optional check: verify `أمين المخزن` could not see `اعتماد` / `ترحيل`, and `مدير الإنتاج` gets blocked.)*
   - *(Optional recount demo: click `طلب إعادة عد` on `THB-FAB-01`, switch to WH to re-enter `48`, resubmit, then come back to FM — or proceed directly to approval.)*
   - Click **`اعتماد نتائج الجرد`** (`status → approved`).
   - Click **`ترحيل التسويات للأستاذ`** → enter notes `ترحيل فروقات جرد المحاكاة` → click **`تأكيد الترحيل النهائي`**.
5. **What Happens Next:** Verifies `Snapshot Integrity` (no overlapping movements changed balances), posts `StockLedgerEntry` (`stocktake_shortage = -2` @ `120.00 = -240.00`, `stocktake_surplus = +5` @ `2.00 = +10.00`), posts GL **`Dr 5200 / Cr 1210 = 240.00 ج.م`** and **`Dr 1210 / Cr 5200 = 10.00 ج.م`**, and closes session as `posted`.
6. **Verify Before Proceeding:** Open tabs **`سجل التدقيق`** and **`قيود الأستاذ الناتجة`** inside the session to inspect immutable ledger rows. Raw stock `1210` = `6,900 - 240 + 10` = **`6,670.00 ج.م`**.
7. **Switch Account:** **Stay on `المدير المالي` (`finance_manager`)**.
8. **Consequence:** Physical & book inventory reconciled (`48m`, `105 btn`, `10 roll`, `20 box` = `6,670.00 ج.م`).

---

### Step 23 — Direct Operating Expense, Custody Lifecycle (Fund → Expense → Settle & Auto-Close)
1. **Step:** `23` *(Phase I — Treasury Cash Movements & Custody)*
2. **Role:** `المدير المالي` (`finance_manager`)
3. **Screens & Inputs:**
   - **A. Direct Expense (`المصروفات والإيرادات ← سندات القبض والصرف` → tab `－ صرف نقدي`):**
     - Source: `الخزنة الرئيسية`, Category: `مصروفات تشغيلية وإنتاجية (حساب 5300)`, Amount: `1500`, Description: `فاتورة كهرباء وتشغيل الورشة` → **`تأكيد وتسجيل سند الصرف`** *(auto-posts immediately: Treasury `234,000 → 232,500.00`)*.
   - **B. Custody (`المصروفات والإيرادات ← العهد والمصروفات`):**
     1. Click **`+ إنشاء صندوق عهدة جديد`** → Name `عهدة مصروفات التشغيل السريعة` → Save *(balance `0.00`)*.
     2. Click **`⇄ طلب تغذية عهدة من الخزينة`** → Target: `عهدة مصروفات التشغيل السريعة`, Amount: `5000`, Notes: `سلفة مصروفات نقل وصيانة` → **`إرسال طلب التغذية للاعتماد`** *(auto-posts: Treasury `232,500 → 227,500.00`, Petty Cash = `5,000.00`)*.
     3. Click **`＋ مصروف يومي من عهدة`** → Account: `عهدة مصروفات التشغيل السريعة`, Amount: `1200`, Category: `5300`, Description: `أجرة نقل ومشال خامات` → **`تسجيل المصروف`** *(auto-posts: Petty Cash `5,000 → 3,800.00`)*.
     4. On the custody card, click **`تسوية ورد النقدية`** → Returned cash defaults to `3,800.00`, Notes `تسوية وإغلاق العهدة` → **`رفع التسوية للاعتماد`** *(auto-posts transfer back to Treasury: Treasury `227,500 → 231,300.00`, Petty Cash `= 0.00`, Custody status auto-closes `is_active = False`!)*.
4. **Verify Before Proceeding:** `الخزينة والاعتمادات` shows Treasury = **`231,300.00 ج.م`**, Active Petty Cash = **`0` (`0.00 ج.م`)**.
5. **Switch Account:** **Stay on `المدير المالي` (`finance_manager`)**.
6. **Consequence:** Net expenses `+2,700.00` (`1,500` direct + `1,200` custody); custody cleanly settled & closed.

---

### Step 24 — Payroll Setup, Calculation & Treasury Disbursement
1. **Step:** `24` *(Phase I — Employees & Payroll)*
2. **Role:** `المدير المالي` (`finance_manager`)
3. **Screen:** `الرواتب` *(sidebar item)*
4. **Enter:**
   - **Section 1 (`ملفات العاملين`):** Add 2 synthetic employees (`إضافة موظف`):
     1. Code `SIM-EMP-01`, Name `عامل تجميع تجريبي 1`, Dept `التشطيب`, Pay Type `شهري (monthly)`, Rate `6000`.
     2. Code `SIM-EMP-02`, Name `عامل قص يومي تجريبي 2`, Dept `القص`, Pay Type `يومية (daily)`, Rate `300`.
   - **Section 2 (`سجل الحضور`, optional):** Record 1 `حاضر` entry for `SIM-EMP-02` *(demonstrates informational reference note only)*.
   - **Section 3 (`فترات الرواتب`):** Create period Name `دورة رواتب المحاكاة`, From `2026-11-01`, To `2026-11-30` → **`إنشاء الفترة`**.
   - **Section 4 (`PayrollSheet`):**
     1. Click **`إعداد الكشف واختيار الموظفين`** → select `SIM-EMP-01` & `SIM-EMP-02` → **`إعداد الكشف`**.
     2. For `SIM-EMP-02` (daily): click `الحوافز والخصومات` → enter `أيام العمل = 10` → **`حفظ الأيام`** (`base = 3,000.00`).
     3. For `SIM-EMP-01` (monthly): click `الحوافز والخصومات` → under `إضافة حافز أو خصم`, Category `حافز / مكافأة`, Method `مبلغ ثابت`, Value `500`, Label `حافز إنتاج الدفعة` → **`إضافة البند`** (`net = 6,500.00`).
     4. Verify Grand Net Total = **`9,500.00 ج.م`**.
     5. Click **`مراجعة وتقديم للصرف`** → confirm **`تقديم للصرف`**.
5. **What Happens Next:** Creates single Treasury `CashDocument` (`source_system="payroll"`, `9,500.00`), auto-approves immediately under FM, marks period **`مصروف (paid)`**, deducts Treasury `231,300 → 221,800.00 ج.م`, posts GL expense/cash (`Dr 5xxx / Cr 1010 = 9,500.00`).
6. **Verify Before Proceeding:** Period status reads **`مصروف`**, Treasury = **`221,800.00 ج.م`**.
7. **Switch Account:** **Switch to `أمين المخزن` (`warehouse_manager`)** for Step 25 *(to demonstrate the real pending Treasury approval workflow!)*.
8. **Consequence:** Payroll settled cleanly (`9,500.00`).

---

### Step 25 — Clear Remaining Supplier Payable (`20,000.00`) via Pending Treasury Hub (Maker-Checker Demo)
1. **Step:** `25` *(Phase I — Treasury Single-Approval Hub & Full AP Settlement)*
2. **Roles:** `أمين المخزن` (`warehouse_manager` submits request) → `المدير المالي` (`finance_manager` approves in Treasury)
3. **Actions:**
   - **As `أمين المخزن`:** Open `المشتريات ← فواتير الشراء والاستلام` → open `SIM-INV-001` → notice all money values show `0.00` → click **`طلب سداد كامل المستحق`**.
     *(Creates `pending` `CashDocument` for `20,000.00 ج.م` with zero cash/GL effect yet!)*
   - **Switch to `المدير المالي` (`finance_manager`):** Open **`الخزينة والاعتمادات`** → under `معاملات بانتظار الاعتماد`, see the `20,000.00 ج.م` supplier payment submitted by `أمين المخزن` → click **`✓ اعتماد`** → **`تأكيد الاعتماد`**.
4. **What Happens Next:** Atomic transaction writes `CashLedgerEntry(-20,000)`, marks `SupplierPayment` `approved`, posts GL **`Dr 2100 / Cr 1010 = 20,000.00 ج.م`**. Treasury drops `221,800 → 201,800.00 ج.م`, Supplier Payable (`2100`) becomes **`0.00 ج.م`**.
5. **Verify Before Proceeding:** `مستحقات الموردين` shows `0.00 ج.م` due on `SIM-INV-001`; pending approvals queue = `0`.
6. **Switch Account:** **Stay on `المدير المالي` (`finance_manager`)**.
7. **Consequence:** Demonstrates live Maker-Checker Treasury governance and settles supplier liability completely.

---

### Step 26 — Verify Open Customer Receivable (`3,000.00`) in Reports & Collect Final Balance
1. **Step:** `26` *(Phase I — AR Verification & Final Collection)*
2. **Role:** `المدير المالي` (`finance_manager`)
3. **Actions:**
   - Open `التقارير → العملاء والموردون → مديونيات العملاء` (and `كشف حساب عميل` for `SIM-CUS-01`): verify remaining customer receivable = **`3,000.00 ج.م`**.
   - Open `العملاء والطلبات والتحصيل → معرض الأناقة العربية للملابس` → **`＋ تسجيل تحصيل مالي`** → Amount: **`3000`**, Method: `نقدي`, Reference: `SIM-RC-03` → **`تسجيل التحصيل`**.
4. **What Happens Next:** Treasury rises `201,800 → 204,800.00 ج.م`; Customer AR (`1100`) drops **`3,000 → 0.00 ج.م`**.
5. **Verify Before Proceeding:** Customer summary shows Total Order `63,000.00`, Delivered `63,000.00`, Paid `63,000.00`, Receivable **`0.00 ج.م`**.
6. **Switch Account:** **Stay on `المدير المالي`** (then **`المدير العام`** in Step 27).
7. **Consequence:** All party subledgers (`AR = 0`, `AP = 0`) cleanly reconciled.

---

### Step 27 — Finance Manager Reports Sign-Off & General Manager Operations Board Review
1. **Step:** `27` *(Phase I — Financial Acceptance & GM Oversight)*
2. **Roles:** `المدير المالي` (`finance_manager`), then `المدير العام` (`general_manager`)
3. **Actions (as `المدير المالي` → `التقارير`):**
   - `نظرة عامة` (`overview`): confirm Treasury **`204,800.00`**, Sales **`63,000.00`**, COGS **`39,140.00`** *(note exact caveat: operating result includes `4200` opening cash if counted in cash inflows)*.
   - `قائمة الدخل` (`profit_and_loss`): confirm GL revenues (`4100 = 63,000.00`, `4200 = 200,000.00`, total **`263,000.00`**), total expenses + COGS (`5100..5400 = 51,530.00`), and Net Income **`211,470.00 ج.م`**.
   - `حركة الخزينة` (`cash_flow`): verify inflows (`200k + 20k + 40k + 3k = 263,000` external; internal custody return `3,800` excluded from P&L cash flow) and outflows (`46k + 1.5k + 1.2k + 9.5k = 58,200`, net `+204,800.00`).
   - `تحليل المصروفات` (`expense_analysis`) & `مطابقة العهد` (`custody_recon`): verify `1,500` + `1,200` expenses & closed custody (`returned = 3,800`, `remaining = 0`).
   - `تكلفة الرواتب` (`payroll_cost`): verify `9,500.00` paid period.
   - `تقييم المخزون` (`inventory_valuation`) & `الهالك والعجز` (`losses`): verify Raw Inventory = **`6,670.00 ج.م`** (`48m` fabric, `105` btn, `10` rolls, `20` boxes), WIP = **`0.00 ج.م`**, FG = **`0.00 ج.م`**, net stocktake shortage `230.00`, fabric cutting scrap `5m`.
   - `ربحية الموديلات` (`model_profitability`): verify `ثوب قمة الكلاسيكي` sales `63,000.00`, COGS `39,140.00` *(materials only)*, gross margin `23,860.00 ج.م`.
   - *(Optional API check via Swagger/curl or `check_pilot_consistency.py`: verify `GET /api/v1/finance/gl/trial-balance` balanced and `GET /api/v1/reports/balance-sheet` `Assets = Liabilities + Equity = 211,470.00`, `is_balanced = true`.)*
4. **Actions (Switch to `المدير العام` → `لوحة التشغيل`):** Verify live sync cards (`Treasury 204,800.00`, `Payables 0.00`, `Receivables 0.00`, `Production Pipeline` and `BatchGrid` live from server).

---

## 7. Master Financial, Inventory & GL Checkpoint Table

| Step | Event | Raw Stock (`1210`) | WIP (`1220`) | FG (`1230`) | Treasury (`1010`) | Petty (`1020`) | Supplier AP (`2100`) | Customer AR (`1100`) |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| **0** | Opening Cash (`200k` via UI) | `0.00` | `0.00` | `0.00` | **`200,000.00`** | `0.00` | `0.00` | `0.00` |
| **4** | Save Supplier Invoice (`46k`) | `0.00` | `0.00` | `0.00` | `200,000.00` | `0.00` | `0.00` | `0.00` |
| **5** | GRN-1 Partial Receipt | **`28,000.00`** | `0.00` | `0.00` | `200,000.00` | `0.00` | **`28,000.00`** | `0.00` |
| **6** | GRN-2 Remaining Fabric Receipt | **`46,000.00`** | `0.00` | `0.00` | `200,000.00` | `0.00` | **`46,000.00`** | `0.00` |
| **7** | Partial Supplier Payment (`26k`) | `46,000.00` | `0.00` | `0.00` | **`174,000.00`** | `0.00` | **`20,000.00`** | `0.00` |
| **9** | Customer Order (`63k`) + Adv (`20k`) | `46,000.00` | `0.00` | `0.00` | **`194,000.00`** | `0.00` | `20,000.00` | **`-20,000.00`** |
| **11** | Dispatch Materials (`39.1k` in-transit) | **`6,900.00`** | `0.00` | `0.00` | `194,000.00` | `0.00` | `20,000.00` | `-20,000.00` |
| **12** | Workshop Receipt (`order:{id}`) | `6,900.00` | **`39,100.00`** | `0.00` | `194,000.00` | `0.00` | `20,000.00` | `-20,000.00` |
| **14** | Extra Thread Issue (`+1` roll = `40`) | **`6,860.00`** | **`39,140.00`** | `0.00` | `194,000.00` | `0.00` | `20,000.00` | `-20,000.00` |
| **16** | FG Receipt (`100` pcs @ `391.40`) | `6,860.00` | **`0.00`** | **`39,140.00`** | `194,000.00` | `0.00` | `20,000.00` | `-20,000.00` |
| **18–19** | Return `1` Roll (`+40`) + Close Order | **`6,900.00`** | **`0.00`** | `39,140.00` | `194,000.00` | `0.00` | `20,000.00` | `-20,000.00` |
| **20** | Deliver `100` pcs + Collect `40k` | `6,900.00` | `0.00` | **`0.00`** | **`234,000.00`** | `0.00` | `20,000.00` | **`+3,000.00`** |
| **22** | Stocktake Post (`-2m` fab, `+5` btn) | **`6,670.00`** | `0.00` | `0.00` | `234,000.00` | `0.00` | `20,000.00` | `3,000.00` |
| **23** | Expense (`1.5k`) + Custody Cycle (`1.2k` spent, `3.8k` returned) | `6,670.00` | `0.00` | `0.00` | **`231,300.00`** | **`0.00`** | `20,000.00` | `3,000.00` |
| **24** | Payroll Paid (`9,500.00`) | `6,670.00` | `0.00` | `0.00` | **`221,800.00`** | `0.00` | `20,000.00` | `3,000.00` |
| **25** | Final Supplier Payment (`20k` via Treasury Hub) | `6,670.00` | `0.00` | `0.00` | **`201,800.00`** | `0.00` | **`0.00`** | `3,000.00` |
| **26** | Final Customer Collection (`3k`) | **`6,670.00`** | **`0.00`** | **`0.00`** | **`204,800.00`** | **`0.00`** | **`0.00`** | **`0.00`** |

**End-of-Simulation Accounting Proof:**
- **Total Assets:** Cash (`204,800.00`) + Raw Inventory (`6,670.00`) + Petty Cash (`0`) + AR (`0`) + WIP (`0`) + FG (`0`) = **`211,470.00 ج.م`**.
- **Total Liabilities (`2100`):** **`0.00 ج.م`**.
- **Revenues (`4100` + `4200`):** `63,000.00` Sales + `200,000.00` Opening Cash Receipt = **`263,000.00 ج.م`**.
- **Expenses (`5xxx`):** `39,140.00` COGS (`5100`) + `190.00` Variance/Shortage Net (`5200`: `-40.00` close adjustment `+ 240.00` shortage `- 10.00` surplus) + `12,200.00` Direct Expense/Custody/Payroll = **`51,530.00 ج.م`**.
- **Net Income / Equity (`3000 + RE`):** `263,000.00 − 51,530.00` = **`211,470.00 ج.م`** (`Assets − (Liabilities + Equity) = 0.00 ج.م`).

---

## 8. Stakeholder Acceptance Checklist (Sign-Off Sheet)

| # | Acceptance Criterion | Passed? | Notes / Owner Sign-Off |
|---|---|---|---|
| 1 | `qemma_pilot_demo` reset to `20261111_0023` and running cleanly on `:8010` / `:5180` | [x] | Done pre-meeting |
| 2 | Catalog item draft → submit → approve (`warehouse_manager` → `finance_manager`), anti-self-approval verified | [ ] | |
| 3 | Purchase invoice created with `0` stock/GL impact; partial (`GRN-1`) & full (`GRN-2`) receipts update stock + AP (`46,000`) | [ ] | |
| 4 | Warehouse Manager price redaction (`0.00`) verified; `طلب سداد كامل المستحق` submits pending Treasury doc | [ ] | |
| 5 | Sales order (`custom_manufacturing`, `100` pcs @ `650 − 2,000 = 63,000`) + `20,000` advance payment verified | [ ] | |
| 6 | Linked `ProductionOrder` locks BOM snapshot; warehouse dispatch (`TR-*`) & separate PM workshop receipt (`order:{id}`) verified | [ ] | |
| 7 | Sequential 5 production stages enforce order; extra issue (`TRX-*`) updates `unit_manufacturing_cost` (`391.40`) | [ ] | |
| 8 | FG receipt (`100` pcs) isolates `private_label` bucket (`1230 = 39,140`); order cannot close until WIP raw balance = `0` & return received | [ ] | |
| 9 | Delivery (`100` pcs) posts `Dr 1100 / Cr 4100 (63k)` + `Dr 5100 / Cr 1230 (39.14k)`; AR & AP reach `0.00` after final settlements | [ ] | |
| 10 | Stocktake (`-2` fabric, `+5` buttons) approved & posted by `finance_manager`; inventory valuation reaches `6,670.00 ج.م` | [ ] | |
| 11 | Custody lifecycle (`5,000 → 1,200 → 3,800`), direct expense (`1,500`), payroll (`9,500`), & Treasury ending balance (`204,800.00`) verified | [ ] | |
| 12 | `python scripts/check_pilot_consistency.py --api http://localhost:8010` returns zero cross-screen discrepancies | [ ] | |

---

## 9. Final Recommendation

- **Verdict:** **`CONDITIONAL GO`** for the Factory Stakeholder Handover Demonstration; **`NO-GO`** for direct production cutover without follow-up hardening.
- **Estimated Live Meeting Duration:** **75–90 minutes** (Steps 0–27 with Q&A and role-switching pauses).
- **Exact First Action Before Starting the Meeting:**
  1. *(Already completed pre-meeting: `qemma_pilot_demo` is at `20261111_0023` with clean base data; re-run `reset_pilot_demo_db.py --yes` only if you want to wipe again between dry runs.)*
  2. Start `python scripts/run_pilot_api.py` (port `8010`) and `apps/web` with `$env:VITE_API_BASE_URL="http://localhost:8010"; npm run dev -- --port 5180`.
- **Mandatory Post-Handover Actions Before Production Cutover (`bootstrap_factory_db.py`):**
  1. Commit & merge `feat/customer-returns` (including `20261111_0023`, `قائمة الدخل` UI, and the 2026-11-11 approval & unit permissions updates).
  2. Add Paid-in Capital (`3000`) opening-cash classification option in `ReceiptsDisbursementsView` and expose Trial Balance / Balance Sheet / Journal Entry UI tabs in `FinancialReportsView`.
  3. Resolve open factory business decisions in `docs/OPEN_DECISIONS_AR.md` (unit conversion vs fixed units, labor/overhead batch allocation, operator roles, real employee/user Supabase provisioning).
