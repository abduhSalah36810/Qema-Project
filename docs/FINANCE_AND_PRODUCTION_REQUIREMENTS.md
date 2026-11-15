# Qema ERP — Consolidated Finance & Production Requirements

> **Document Purpose:** Consolidated baseline of all business requirements for the additive restructuring of Qema ERP (Finance restructuring, Internal vs. External Manufacturing separation, and Production Time Tracking), preserving all existing operational capabilities, data, permissions, and audit trails.  
> **Scope Rule:** Additive restructuring and organization — **NOT** a system replacement or rebuild.  
> **References:** [`PRODUCT_REQUIREMENTS_AR.md`](file:///d:/Qema%20Project/docs/PRODUCT_REQUIREMENTS_AR.md), [`COMPANY_WORKFLOWS_AR.md`](file:///d:/Qema%20Project/docs/COMPANY_WORKFLOWS_AR.md), [`OPEN_DECISIONS_AR.md`](file:///d:/Qema%20Project/docs/OPEN_DECISIONS_AR.md), [`KNOWN_LIMITATIONS_AR.md`](file:///d:/Qema%20Project/docs/KNOWN_LIMITATIONS_AR.md).

---

## 1. Core Restructuring Principles & Constraints

1. **Additive Restructuring Only:** Existing working modules, screens, database records, permissions, audit logs, and operational workflows are preserved by default.
2. **Three Primary Finance Additions:**
   - **Purchases** (subsections: *Create Purchase Invoice*, *Purchased Items*).
   - **Sales** (subsections: *Sold Items*, plus logical placement of existing sales/delivery/return/customer screens).
   - **Reports** (subsections: *Account Statements*, *Balance Sheet*, *Income Statement*, alongside existing financial/operational analytics).
3. **Preservation of Other Finance Capabilities:** Treasury and cash accounts, revenues, expenses, custody (petty cash), customers, suppliers, payments, collections, and payroll financial operations remain intact. Functions are placed in their most logical UI location without forcing every function into the three new sections or introducing unnecessary menu depth.
4. **Mandatory Classification Model:** Every existing capability is classified as one of:
   - `NEW`
   - `ADAPT`
   - `KEEP`
   - `CONSOLIDATE`
   - `DEPRECATE — APPROVAL REQUIRED` (no deletion or retirement without explicit approval and verified replacement coverage).
5. **Single Source of Truth:** No parallel financial ledgers, duplicate inventory sources, or competing operational workflows. Reuse and adapt authoritative backend services and tables (`balances.py`, `ledger_service.py`, `stock.py`, `StockLedgerEntry`, `CashDocument`, `SupplierInvoice`, `CustomerOrder`).
6. **Language & UX:** Arabic RTL primary interface, responsive across desktop, tablet, and mobile; clean, shallow navigation.

---

## 2. Finance Department Restructuring Requirements

### 2.1 Purchases (`المشتريات`)

Target subsections: **Create Purchase Invoice** and **Purchased Items** (plus logical linkage to Supplier directory and Supplier Invoices/Receipts/Payments).

#### A. Create Purchase Invoice (`إنشاء فاتورة شراء`)
Must review, preserve, and support the full purchase-invoice lifecycle:
- Supplier selection (active suppliers only).
- Supplier invoice number (unique per supplier) and invoice date (plus internal reference number).
- Purchased items (active, approved catalog items only; matching item `unit_id`).
- Quantities, units of measurement, unit prices, line discounts, and calculated totals.
- Taxes (only if supported and approved by business policy).
- Supplier relationship and supplier account statement relationship.
- Invoice status and approval/receipt lifecycle (`awaiting_receipt` → `partially_received` → `received`, plus `cancelled` if approved).
- Payment status (paid, pending treasury approval, payable balance, advance payments).
- Inventory receipt relationship (`GRN` / `SupplierReceipt`) and raw-material warehouse effects.
- Source-document traceability across invoice → receipt → stock ledger → cash document → GL journal entry.

**Critical Invariants:**
- Creating a purchase invoice **must NOT** automatically receive goods into inventory.
- Inventory quantities **must NOT** be increased twice (guarded per-line against `invoiced_quantity - received_quantity`).
- Financial liabilities (`2100`) and inventory movements (`1210`) must remain traceable to actual source documents (`SupplierInvoice` / `SupplierReceipt`).

#### B. Purchased Items (`الأصناف المشتراة`)
Dedicated view to inspect purchased items and purchase history:
- Item (code, Arabic name, classification/category/type).
- Purchased quantity and received quantity, with unit of measurement.
- Unit purchase price, line discount, net line total.
- Supplier, purchase date, and link/reference to source purchase invoice (`internal_number` / `invoice_number`).
- Filters: item, item classification (`category_id` / `item_type`), supplier, invoice status, and date ranges.
- Item-level purchase price & quantity history derived directly from `supplier_invoices` and `supplier_invoice_lines` (no duplicate purchase table).

---

### 2.2 Sales (`المبيعات`)

Target subsections: **Sold Items** (and logical organization of existing Customer Orders, Deliveries, Returns, Customers, and Collections).

#### A. Sold Items (`الأصناف المباعة`)
Dedicated view of sold items derived from authoritative sales order, delivery, and return records:
- Item / Product model and variant (size, season).
- Quantity (ordered, delivered, returned, net sold).
- Unit price, order discount share, and total net sales value.
- Customer.
- Source sales order (`CustomerOrder`) and delivery document (`CustomerDelivery`) references.
- Delivery status and collection/payment relationship on the source order.
- Date/period filters and item/model-level sales history.

**Critical Invariants:**
- Preserve operational distinctions between:
  1. **Sales Order** (`CustomerOrder` — commitment & pricing, no stock deduction),
  2. **Actual Delivery** (`CustomerDelivery` — finished-goods stock deduction, revenue & COGS recognition),
  3. **Sales Invoice** (if distinct document is later approved, or delivery-based recognition as currently implemented),
  4. **Customer Collection** (`CustomerPayment` → Treasury-approved `CashDocument`),
  5. **Customer Returns & Inspection** (`CustomerDeliveryReturn` → quarantine → restock/scrap).

---

### 2.3 Financial Reports (`التقارير المالية`)

Target subsections: **Account Statements**, **Balance Sheet**, and **Income Statement** (while preserving existing operational/financial analytics: Cash Flow, Expense Analysis, Custody Reconciliation, Payroll Cost, AR/AP Aging, Sales Analysis, Model Profitability, COGS, Inventory Valuation, WIP Valuation, Stock Health, Losses).

#### A. Account Statements (`كشوف الحسابات`)
Unified statement experience supporting all reliable account types:
- **Customer** (`1100` sub-ledger via deliveries, returns, collections).
- **Supplier** (`2100` sub-ledger via receipts and payments).
- **Employee** (payroll runs, allowances, deductions, advances/settlements — requires sub-ledger support).
- **Treasury / Cash Account** (`CashAccount` of type `treasury` via `cash_ledger_entries` + `cash_documents`).
- **Custody Account** (`CashAccount` of type `petty_cash` via `cash_ledger_entries` + `custody_settlements`).
- **GL Accounts** (`Account` via `journal_entry_lines`).

Required columns/semantics per statement:
- Opening balance (prior to selected period start).
- Chronological transactions: date, description, source document type/number, counterparty, debit, credit, running balance.
- Closing balance.
- Period filtering (`date_from`, `date_to`).
- Debit/credit semantics must match each account's accounting nature (asset/expense = debit normal; liability/equity/revenue = credit normal; sub-ledger party statements must match authoritative party balance rules).

#### B. Detailed Income Statement (`قائمة الدخل التفصيلية`)
Period-filtered financial performance statement covering:
- Revenue (sales of finished goods, external manufacturing/service revenue, other operational income, net of sales returns/discounts).
- Cost of Sales / Manufacturing (COGS, raw material consumption, direct labor, direct manufacturing costs/scrap).
- Gross Profit & Gross Margin %.
- Operating & Administrative Expenses (categorized properly, not guessed by text keywords).
- Salaries & Wages (clearly classified between direct manufacturing labor vs. administrative/general salaries to prevent double-counting).
- Depreciation (if/when fixed assets are supported).
- Net Profit or Loss & Net Margin %.
- **Mandatory Drill-Down:** Every displayed total or account line must be clickable/expandable to show its underlying journal entries, transactions, dates, amounts, categories, and source documents.
- **Anti-Double-Counting Rule:** Payroll expenses must never be counted both as cash payroll expense (`5200`) and again inside capitalized WIP/COGS (`1220` → `1230` → `5100`).

#### C. Balance Sheet (`الميزانية العمومية`)
Point-in-time (`as_of` date) financial position respecting:
$$\text{Assets} = \text{Liabilities} + \text{Equity}$$
Must inspect and rely on sound accounting foundations:
- Complete Chart of Accounts with proper classifications (`asset`, `liability`, `equity`, `revenue`, `expense`, plus sub-classifications current vs. non-current).
- Balanced double-entry journal postings for **all** balance-affecting events.
- Validated Opening Balances (`3000` Capital / Opening Equity) — never treating opening cash or inventory as revenue or expense reductions.
- Accurate Inventory Valuation (`1210` Raw Materials, `1220` WIP, `1230` Finished Goods), Cash & Treasury (`1010`, `1020`, `1030`), Receivables (`1100`), Payables (`2100`), Payroll/Accrued Liabilities, Fixed Assets & Accumulated Depreciation (if supported), Retained Earnings & Current Period Net Income.
- Must **NOT** be fabricated by naively summing unlinked sub-ledger balances; missing foundations must be resolved before exposing the official Balance Sheet.

---

## 3. Separation of Internal Manufacturing & External Manufacturing

### 3.1 Internal Manufacturing (`التصنيع الداخلي — لحساب المصنع`)
- Factory purchases and owns raw materials (`1210`), bears material, labor, and manufacturing costs, owns finished goods (`1230`, bucket `factory_brand` or factory-owned custom orders), sells to customers (`4100`), and recognizes COGS (`5100`).
- Full chain preserved: Purchase Invoices → Raw Material Inventory → Material Issue → WIP → Production → Finished Goods → Sales Deliveries → Financial Results.

### 3.2 External Manufacturing (`التصنيع للغير — لحساب العملاء`)
Customer provides the main raw materials; factory provides manufacturing services (and optionally factory-supplied accessories).

1. **Customer-Owned Materials (`خامات العميل`):**
   - Must identify ownership and source on receipt, storage, issue, consumption, waste, remaining balance, and return.
   - Associated with the specific `Customer` and `ProductionOrder`.
   - Segregated from factory-owned inventory (must **NOT** inflate factory purchases `SupplierInvoice`, factory inventory assets `1210`/`1220`/`1230`, or factory COGS `5100`).
   - Full quantity reconciliation required: $\text{Received} = \text{Consumed} + \text{Waste} + \text{Remaining/Returned}$ (e.g., 500m received = 450m consumed + 30m waste + 20m remaining).

2. **Accessories Ownership (`ملكية الإكسسوارات والمستلزمات`):**
   - Accessories (buttons, snaps, hooks, threads, packaging, etc.) may be supplied by either the **customer** or the **factory**.
   - Ownership/source must be recorded per material line:
     - Customer-owned accessories → tracked in custody/reconciliation, zero factory asset/cost impact.
     - Factory-owned accessories → deducted from factory inventory and included in factory manufacturing cost for the external order.

3. **Labor Costing (`تكلفة العمالة المباشرة`):**
   - Supported methods per production order:
     1. **Time-based:** hours or days worked × relevant labor rate.
     2. **Piece-based:** completed pieces × agreed piece rate.
   - Labor cost must be attributable to the specific production order without double-counting wages in financial reports (requiring proper GL clearing/absorption between payroll liability/expense and WIP/production cost).

4. **External Manufacturing Pricing (`تسعير التصنيع للغير`):**
   - Agreed **fixed total service price** per customer agreement/order (not cost-plus).
   - Profitability = Agreed Service Revenue − Factory-supplied Accessories − Direct Labor − Allocated Operating Costs.

5. **Waste Allowance (`نسبة الهالك المسموح به`):**
   - Predefined allowed waste percentage (per material/order/stage).
   - Record actual waste, compare against allowed waste, flag overruns, and link waste to material, production order, and production stage where possible.

6. **Separate & Consolidated Financial Analysis:**
   - Every production order identifiable by: `manufacturing_type` (`internal` vs. `external`), order number, customer (for external), cost center/activity tag, material source, expense source, labor cost, accessories cost, and associated revenue.
   - Analytical views within one coherent accounting model (not two disconnected systems):
     - Internal Manufacturing Income Statement.
     - External Manufacturing Income Statement.
     - Consolidated Income Statement.
     - Side-by-side profitability comparison.

---

## 4. Production Time Tracking (`تتبع زمن الإنتاج والتأخيرات`)

New operational capability added without altering existing material issue, WIP, finished goods receipt, quality, or order-closing rules.

### 4.1 Production-Order-Level Timing
- Actual start timestamp (`started_at`) and actual completion timestamp (`completed_at`).
- Automatically calculated total elapsed duration (in hours and days) — not manually entered when timestamps exist.
- Current status and reliable full-cycle timing history.

### 4.2 Stage-Level Timing
- Independent timing record per production stage per order, using the system's existing/configurable stage sequence (currently `cutting`, `finishing`, `snap_installation`, `ironing`, `packing` — never hardcode if configurable stages are introduced).
- On stage start: actual `started_at` timestamp, `order_id`, `stage_name`, responsible user/operator.
- On stage completion (and handling reopen/rollback cleanly): actual `completed_at` timestamp, auto-calculated elapsed duration, preserved timing history for reporting.

### 4.3 Expected vs. Actual Duration
- Support configurable expected duration at complete-order level and individual-stage level.
- Compare expected vs. actual duration: show expected, actual, delay/overrun amount, and delay percentage.
- **Calendar Elapsed Time vs. Labor Hours:** Explicitly distinguish wall-clock elapsed time (including non-working hours/nights/weekends) from active working/shift hours or direct labor hours.

### 4.4 Delay Monitoring & Causes
- Automatically surface delayed stages and orders when actual/current elapsed time exceeds expected duration.
- Allow authorized users to record:
  - Structured delay reason (e.g., `material_shortage`, `labor_shortage`, `machine_failure`, `low_productivity`, `waiting_previous_stage`, `quality_issue`, `other`).
  - Operational notes and corrective action taken.

### 4.5 Production Time Reports
- Average duration per stage and per complete order (computed from actual timestamps, replacing current static placeholder constants).
- Most delayed stages and currently delayed active production orders.
- Delay causes breakdown and frequencies.
- Cross-order duration comparisons and productivity trends over time.

