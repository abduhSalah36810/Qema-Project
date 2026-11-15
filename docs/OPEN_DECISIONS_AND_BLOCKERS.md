# Qema ERP — Open Decisions, Missing Foundations & Technical Blockers

> **Purpose:** Explicitly document every unresolved business question, missing accounting foundation, unverified assumption, and technical blocker identified during the audit. **No answers are guessed or invented.** Implementation of blocked items must wait for written business-owner decisions.

---

## 1. Accounting & Balance Sheet Blockers (Required Before Phase 5 Balance Sheet)

| ID | Topic | Current System Gap | Business Decision / Input Required |
|---|---|---|---|
| **ACC-01** | **Opening Balances & Cutover Date (`3000`)** | `accounts` `3000` ("رأس المال ورصيد افتتاحي") has `0.00` balance. Currently, `KNOWN_LIMITATIONS_AR.md:11` instructs recording opening treasury cash as an `income` cash document (which credits `4200` Revenue, creating fake profit!), and opening inventory via Stocktake surplus (which credits `5200`, creating fake negative expense!). | Confirm official accounting cutover date and provide verified opening balances for: Cash/Treasury, Custody, Bank, Customer Receivables (per customer), Supplier Payables (per supplier), Raw/WIP/FG Inventory valuation, and Paid-in Capital (`3000`). |
| **ACC-02** | **Pre-Migration `0016` Historical Records** | Operations created before Migration `0016` (2026-11-06) have operational rows (`cash_ledger_entries`, `stock_ledger_entries`, `supplier_invoices`, `customer_deliveries`) but **no `journal_entries`**. | Decide whether pre-0016 balances will be rolled into the cutover Opening Balance entry (`ACC-01`) or backfilled into GL via a one-time reconciliation script. |
| **ACC-03** | **Bank Account (`1030`) vs. Main Treasury (`1010`)** | CoA seeds `1030` ("حساب بنك المصنع"), `CustomerPayment` supports `method='bank_transfer'`, **but** `ck_cash_accounts_type` only allows `'treasury'` and `'petty_cash'`. All bank transfers currently land in `1010` (`TREASURY-MAIN`). | Decide whether to enable a separate Bank `CashAccount` type linked to `1030` (and whether suppliers/payroll can be paid by bank transfer from `1030`). |
| **ACC-04** | **Chart of Accounts Split for `5200` & Expense Categories** | Account `5200` mixes Payroll, WIP transit loss, WIP scrap, Stocktake shortage/surplus, and Customer return scrap. `CashDocument` expenses choose `5300` vs `5400` using Arabic keyword matching (`"صيانة"`, `"تشغيل"`, `"إنتاج"`) in `finance/service.py:156`. | Approve a structured Expense Category list mapped to clean GL accounts (e.g., `5210` Direct Labor, `5220` Mfg Scrap & Inventory Variance, `5300` Maintenance & Ops, `5400` Admin & General, `5410` Admin Salaries). |
| **ACC-05** | **Payroll Accounting Basis (Accrual vs. Cash)** | Payroll posts `Dr 5200 / Cr 1010` only when disbursed in cash. No `2200` Accrued Salaries liability exists when a `PayPeriod` is calculated/approved. | Decide whether salaries remain cash-basis or post accrual (`Dr Wages / Cr 2200 Accrued Payroll`) upon payroll approval and clear `2200` on payment. |
| **ACC-06** | **Fixed Assets & Depreciation** | `MachineryView.tsx` is unfinished and hidden; no fixed-asset register, asset GL accounts (`1500`), or depreciation mechanism exists. | Confirm if Machinery/Fixed Assets and monthly Depreciation are in scope for Balance Sheet & Income Statement, or explicitly excluded for now. |
| **ACC-07** | **Employee Advances Sub-Ledger (`REP-STMT-03`)** | `PayrollRun` has `advances_amount` deducted at period calculation, but there is no standalone cash-advance disbursement & installment recovery sub-ledger per employee. | Clarify how employee loans/advances are paid out of Treasury/Custody and whether an employee advance tracking table is required for Employee Account Statements. |

---

## 2. Purchases & Sales Business Rules (Phase 2 & 3 Clarifications)

| ID | Topic | Current System Gap | Business Decision Required |
|---|---|---|---|
| **PUR-DEC-01** | **Who Creates Purchase Invoices?** | In `app/core/permissions.py`, `warehouse_manager` and `general_manager` have `suppliers:invoices:create`, whereas `finance_manager` does **NOT** (can only view invoices and request payments). | Decide whether `finance_manager` should also be granted `suppliers:invoices:create` when Purchases moves into Finance, or if invoice entry remains solely with Warehouse/GM. |
| **PUR-DEC-02** | **Advance Supplier Payments Before Warehouse Receipt** | Operational supplier invoices may have payment requests before goods are received in the warehouse. | **RESOLVED (2026-11-15):** الدفع المقدم للمورد قبل الاستلام المخزني مسموح رسمياً حتى إجمالي الفاتورة (`max_allowed = fin.invoice_total`). يُسجل سداد المورد كحركة مدينة على حسابه (رصيد دائن سالب) ويُرحل إلى الأستاذ العام (Dr 2100 / Cr 1010)، ويتسوى الرصيد آلياً فور إثبات الاستلام المخزني الفعلي للبضاعة. |
| **PUR-DEC-03** | **Purchase Invoice Cancellation & Supplier Returns** | DB check constraint allows `status='cancelled'`, but no API/UI exists to cancel an unreceived invoice or return goods to a supplier. | Define rules for cancelling purchase invoices and returning defective raw materials to suppliers. |
| **PUR-DEC-04** | **Taxes (VAT / Withholding) on Purchase Invoices** | `SupplierInvoice` & `SupplierInvoiceLine` only support `unit_price` and `discount_amount` (no tax % or tax GL accounts). | Confirm whether Purchase (and Sales) invoices require tax fields & tax payable/recoverable GL accounts, or remain tax-free operational prices. |
| **SAL-DEC-01** | **Sales Invoice Document vs. Delivery Recognition** | Currently `CustomerDelivery` posts Revenue (`4100`) and AR (`1100`); there is no separate `SalesInvoice` table (`OPEN_DECISIONS_AR.md:42`). | Confirm whether Delivery remains the accounting invoice event or if a separate Sales Invoice step (pre- or post-delivery) is required. |

---

## 3. Internal vs. External Manufacturing Rules (Phase 6 Blockers)

| ID | Topic | Current System Gap | Business Decision Required |
|---|---|---|---|
| **MFG-DEC-01** | **Definition of `custom_manufacturing` vs. External Tolling** | `CustomerOrder.order_type='custom_manufacturing'` currently links to `private_label` production orders where the **factory** buys and consumes its own raw materials (`1210` → `1220` → `1230` → `5100`). | Clarify if the factory has **both**: (a) custom orders using factory-owned fabric (Internal Mfg), AND (b) CMT/Tolling orders using customer-owned fabric (External Mfg), so both cases are cleanly supported. |
| **MFG-DEC-02** | **Customer-Owned Materials Receipt & Warehouse Rules** | `main_raw_materials` holds only factory-owned stock; no customer-material receipt document exists. | Confirm who receives/inspects customer-supplied fabric (Warehouse Manager?), what document is issued, and whether leftover customer fabric is always returned or can be carried to the customer's next order. |
| **MFG-DEC-03** | **Accessories Ownership & Billing in External Orders** | `ProductionOrderMaterial` treats all BOM items as factory stock. | Confirm how factory-supplied accessories in an external order are priced: included inside the fixed total manufacturing fee, or billed separately? |
| **MFG-DEC-04** | **Labor Costing Rates & Payroll Reconciliation** | `ProductionOrder.actual_labor_cost` is always `0.00`. Workers have monthly salary or daily rate (`employees`), not piece rates. | Define: (a) how hourly/daily rates or piece rates per stage/model are configured; (b) who enters worker time/pieces per order/stage; (c) how applied labor reconciles with actual monthly payroll (`5200` / `5290`) to absorb variances without double-counting. |
| **MFG-DEC-05** | **Waste Allowance & Overrun Liability** | No `allowed_waste_pct` exists; `DEC-WIP-05` in `OPEN_DECISIONS_AR.md` is still open. | Confirm standard allowed waste % (per fabric/material or model), who approves waste overruns, and whether excess customer-fabric waste carries a financial penalty or is informational only. |
| **MFG-DEC-06** | **Overhead Allocation Between Internal & External Mfg** | `actual_overhead_cost` is always `0.00`; `5300`/`5400` expenses are unallocated at company level. | Confirm whether operating/admin expenses (`5300`/`5400`) stay unallocated below Gross Profit in segmented P&L or require an allocation basis (e.g., labor hours, pieces, or revenue %) between Internal and External manufacturing. |

---

## 4. Production Time Tracking Rules (Phase 7 Blockers)

| ID | Topic | Current System Gap | Business Decision Required |
|---|---|---|---|
| **TIME-DEC-01** | **Expected Duration Definition** | Only hardcoded `STANDARD_STAGE_DURATIONS_MINUTES` (`cutting: 120`, etc.) exist in `production.py:1456`. | Confirm whether expected durations should be configured per **Model/Template** (e.g., minutes per 100 pieces or fixed setup + per-piece time), per **Production Order** at creation, or as global stage defaults. |
| **TIME-DEC-02** | **Calendar Elapsed Time vs. Factory Working Shifts** | Orders span multiple days/nights (`ProductionStageEvent` timestamps are UTC wall-clock). | Provide official factory working schedule (shift start/end hours, working days/week, Friday/holidays) so active working-hour delays can be distinguished from overnight/weekend calendar gaps. |
| **TIME-DEC-03** | **Configurable Stages vs. Fixed 5 Stages** | Currently `ORDER_STAGES_SEQUENCE` is a fixed 5-stage list (`cutting`, `finishing`, `snap_installation`, `ironing`, `packing`), and some models skip `snap_installation`. | Confirm whether the 5 stages remain fixed (with optional per-model skip/N.A. flag) or need admin-configurable stage definitions. |
| **TIME-DEC-04** | **Mandatory vs. Optional Delay Reasons** | No delay reason fields exist. | Confirm when delay reason entry is mandatory (e.g., mandatory before completing a delayed stage, or optional operational logging) and finalize the Arabic delay reason list. |

---

## 5. Technical Blockers & Unverified Assumptions Discovered in Codebase

1. **Uncommitted Working Tree Changes (`feat/customer-returns`):**
   - 20 modified files + 3 untracked files exist uncommitted (`reports.py`, `FinancialReportsView.tsx`, `financeApi.ts`, `permissions.py`, `production/models.py`, `App.tsx`, `20261111_0023_stocktake_line_bucket_uniqueness.py`, etc.). Must be reviewed, tested, and committed/isolated before beginning Phase 1.
2. **Unapplied Alembic Migrations (`0018`–`0023`):**
   - Per `docs/KNOWN_LIMITATIONS_AR.md`, migrations `0018` through `0022` (plus untracked `0023`) are not applied on dev/demo/production databases. Deploying or running against an unmigrated DB will fail.
3. **Broken GL Account Statement Endpoint (`reports.py:1111-1112`):**
   - `report_account_ledger` accesses `je.reference_type` and `je.reference_id` instead of `JournalEntry.source_doc_type` and `JournalEntry.source_doc_id` — guaranteed `AttributeError` when ledger entries exist.
4. **Quantity Precision (`Float` vs `Numeric`):**
   - `StockLedgerEntry.quantity`, `SupplierInvoiceLine.invoiced_quantity` / `received_quantity`, and `ProductionOrderMaterial` quantities use `Float` (double precision) rather than `Numeric(12, 3)`. Financial reconciliation tolerates `1e-9` (`QTY_TOLERANCE`). Upgrading to `Numeric` is recommended (`DEC-05`) before complex customer-fabric metric reconciliations.
5. **Unverified Runtime Checks in This Audit:**
   - Per Part A audit rules (read-only inspection, no broad test suite execution), `pytest` and `vitest` were **not** executed in this session. Test suite baseline should be verified at the start of Phase 0.

