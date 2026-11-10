# API contract changes — operational integrity release (2026-11-08)

Migration: `apps/api/alembic/versions/20261108_0017_operational_integrity.py` (revises `20261106_0016`).
All amounts are returned as JSON numbers (floats) unless noted; send money as strings or numbers.
Error responses keep the same shape `{ code, message, detail, request_id, details? }`; for business
errors (400/404/409/422/503) `message`/`detail` now carry the **specific Arabic reason** (e.g. insufficient
balance) instead of a generic sentence. 401/403/500 remain generic.

## 1. Auth & permissions

- `GET /api/v1/auth/me` → `{ id, email, roles: string[], permissions: string[] }`.
  `permissions` is the **single source of truth** for the UI. Roles are resolved server-side from the
  `user_roles` table, server-issued claims (`role`/`roles`) and `app_metadata` only. `user_metadata` is ignored.
- `finance_manager` now has `finance:cash:approve` (the finance manager is the final financial approver).
  `general_manager` keeps `finance:cash:approve`.
- Unknown `APP_ENV` values stop the server. Dev login (`DEV_AUTH_ENABLED`) is allowed only for
  `development` / `testing` / `test`. SQL statement logging requires `SQL_ECHO=true`.

## 2. Treasury — the only approval point

- Every cash movement is created **pending** and changes no balance until approved.
- `POST /api/v1/finance/cash-documents/{id}/decision` — permission `finance:cash:approve`.
  Body `{ decision: "approve" | "reject", rejection_reason? }` (reason required for reject).
  - The creator of a document can never approve/reject it (409, any role). Another finance manager or the GM approves.
  - Approving twice → 409. Approving into a closed/inactive account → 409. Insufficient balance → 409 with amounts.
  - Approval writes the cash ledger **and** the journal entry in one transaction; any failure rolls back everything.
- Documents created by other modules (`source_system`): `supplier_payment`, `customer_payment`, `payroll`,
  `custody_settlement`, `daily_expense`. The generic `POST /finance/cash-documents` rejects the system ones
  (422) — they are created only from their own screens.
- `GET /finance/cash-documents?status=pending&approvable_by_me=true` lists what the current user may approve.

## 3. Custody (petty cash)

1. Open: `POST /finance/petty-cash?name=..&business_date=..` (balance 0).
2. Fund: `POST /finance/cash-documents` `{document_type:"transfer", from_account_id: <treasury>, to_account_id: <petty>}` → approve in Treasury.
3. Spend: `POST /finance/daily-expenses` (same body as a cash document, `from_account_id` = petty account) → **pending**, approve in Treasury. Only petty accounts allowed (422 otherwise).
4. Preview: `GET /finance/petty-cash/{id}/settlement-preview` →
   `{ original_custody_amount (net funded), total_funded, total_expenses_recorded, previously_returned, current_balance, suggested_returned_cash, has_pending_settlement }`.
5. Settle: `POST /finance/petty-cash/{id}/settlement` body `{ returned_cash_amount, notes }`.
   **Only `returned_cash_amount` is used**; expenses and remaining are computed by the server.
   Returns `CustodySettlementRead` with `status:"pending"` and `cash_document_id` (the return transfer to approve in Treasury).
   When the return is approved and the custody balance reaches 0, the custody account closes automatically.
   If `returned_cash_amount` is 0 the settlement is recorded as approved immediately (no cash moves).
   A second settlement while one is pending → 409.
6. Final settle shortcut: `POST /finance/petty-cash/{id}/settle` = settlement returning the full balance (returns `CustodySettlementRead`, previously returned a cash document).

## 4. Suppliers & purchasing

- `POST /finance/supplier-invoices` lines accept `discount_amount` (per line, ≥0, ≤ line value).
  `invoice_total` is **computed from lines** (qty × price − discount). If the client sends `invoice_total` and it differs → 422.
- `POST /finance/supplier-invoices/{id}/receive` — **partial receipts supported**. Body `{ lines: [{ line_id, received_quantity, notes }], notes }`
  where `received_quantity` is the quantity received **in this receipt** (not cumulative). Lines may be omitted; quantities of 0 are skipped.
  Receiving more than the remaining quantity → 409. Status becomes `partially_received` or `received`. Each call creates a
  `supplier_receipts` document (GRN-…) and stock entries with `reference_doc_type = "supplier_receipt"`.
- `SupplierInvoiceRead` new fields: `received_value`, `pending_payments_total`, `payable_balance` (= received value − approved payments);
  line fields `discount_amount`, `line_total`, `remaining_quantity`. Prices are zeroed for roles without finance visibility (unchanged).
- Supplier payment `POST /finance/supplier-invoices/{id}/payments` creates a **pending** cash document (approve in Treasury).
  Cap: invoice total while receiving is incomplete; received value after the invoice is fully `received`.

## 5. Customers & sales

- Discount is allocated proportionally: net ratio = total ÷ gross. Delivered/returned values use that ratio, rounded per document.
- `CustomerOrderRead` new fields: `delivered_value`, `returned_value`, `receivable_amount` (= delivered − returned − approved payments;
  negative = customer credit), `pending_payments_amount`, `returns[]`; `balance_amount` = remaining on order (total − returned − approved payments).
  Lines add `returned_quantity`, `remaining_quantity`. Delivery lines now include `id` (needed for returns).
  Payments add `status` (`pending|approved|rejected`) and `cash_document_id`.
- Payments `POST /customers/{cid}/orders/{oid}/payments` → **pending**; approve in Treasury. Amount > remaining (minus pending) → 409.
- Deliveries post revenue (net of discount) **and** cost of goods sold. Remaining-to-deliver nets returns (re-delivery after a return is allowed).
- Returns `POST /customers/{cid}/orders/{oid}/deliveries/{did}/return` body `{ reason, received_by, idempotency_key?, lines:[{delivery_line_id, quantity, notes}] }`
  → goods go to bucket `return_pending_inspection:{cid}` (not sellable).
- **New** inspection `POST /customers/{cid}/returns/{return_id}/inspection` body `{ disposition: "restocked" | "scrapped", notes }`
  (permission `customers:deliveries:manage`). Restocked goods become sellable; scrapped goods leave stock.
- Pending deliveries `available_stock` now equals the stock the delivery endpoint will actually allow (same ownership bucket).
- Linked production orders for custom orders are created as `private_label` for that customer.

## 6. Production

- Stage updates require order status `in_production` (409 otherwise). Draft orders cannot progress to finished goods.
  Stage rollback is blocked once the order is `receipt_completed` or `closed`.
- Materials receipt into WIP (`POST /production/orders/{id}/receive`): only for `materials_dispatched` orders; received quantity must be
  between 0 and dispatched (over-receipt → 409); unknown items → 422. Entries are costed.
- Finished goods receipt `POST /production/orders/{id}/finished-receipt` — **per order item**:
  `{ lines: [{ order_item_id, accepted_quantity, rejected_quantity }], notes }`. The short form
  `{ accepted_quantity, rejected_quantity }` is accepted only for single-item orders (422 for multi-item orders).
  Each item goes to its own SKU (`FG-VAR-{variant_id}`) and ownership bucket. Per-item target cap → 409.
  Response adds `lines[]` with `total_received`, `remaining_quantity`. Order items expose `received_quantity`, `rejected_quantity`.
  Allowed while the order is `in_production` or `manufacturing_completed`.
- **New** material reconciliation `POST /production/orders/{id}/material-reconciliations`
  (permission `warehouse:confirm_receipt`, optional `Idempotency-Key` header):
  `{ lines: [{ item_id, consumed_quantity, returned_quantity, scrapped_quantity, notes }], notes }`.
  Sum per item ≤ current WIP balance of that order (409 otherwise). Returned quantities go back to the raw-materials warehouse.
- `POST /production/orders/{id}/close` (unchanged body) succeeds once WIP balance is zero (after reconciliation), transfers are received,
  and either all pieces were received or `under_production_reason` is given; transport discrepancies need `discrepancy_signoff: true`.
- `GET /production/orders/{id}/wip-summary` (unchanged) shows `materials[].current_wip_balance` per item — use it to prefill the reconciliation form.

## 7. Inventory & stocktake

- **New** `GET /inventory/finished-goods-balances` → rows `{ item_id, item_code, product_id, product_name_ar, variant_id, numeric_size,
  letter_size, season, available_factory_brand, private_label:[{customer_id, customer_name, quantity}], pending_inspection, unassigned, total }`.
- Stocktake statuses: `draft → counting → submitted → (under_review via recount request) → approved → posted` (+ `cancelled`).
  **`submitted` is a real status** — review/approve actions must be available for `submitted` and `under_review`.
  Line statuses: `uncounted, counted, recount_required, …`; `needs_recount` flag is now correct.
- Stocktake lines carry `bucket_reference` (ownership bucket; e.g. `factory_brand`, `private_label:<id>`, `order:<id>`; null for raw materials).
  Full-warehouse sessions contain only items that have stock in that warehouse (per bucket).
- Approval is blocked while any line is `recount_required`, and for anyone who counted lines. Posting creates costed adjustments and journal entries.

## 8. Payroll (no invented formulas)

- Permissions: view `finance:payroll:view`; employees/attendance/periods `finance:payroll:manage`; prepare/adjust/submit `finance:payroll:calculate`.
- Period create validates `end_date > start_date` and rejects overlapping periods (409). Attendance duplicates per employee/day → 409.
- `POST /payroll/periods/{id}/calculate` prepares one run per active employee with `base_amount` = employee base salary;
  overtime/allowances/deductions/advances start at **0** (no formula). Status → `calculated`. Re-running keeps manual values.
- **New** `PATCH /payroll/periods/{pid}/runs/{rid}` `{ overtime_amount, bonus_amount, deductions_amount, advances_amount, reason }`
  — explicit approved values; net = base + overtime + bonus − deductions − advances (negative → 422).
- `POST /payroll/periods/{id}/disburse` now **submits for payment**: creates one pending cash document (`source_system:"payroll"`) and sets status `submitted`.
  Approval in Treasury marks the period `paid`; rejection returns it to `calculated`. Submitting twice → 409.
- Period statuses: `draft, calculated, submitted, paid, closed`. Money columns are exact decimals.

## 9. Reports

- `/reports/summary`: `treasury` and `payables` are `null` for users without `finance:reports:view`.
  `treasury.cash_in_period` / `cash_out_period` are cash-basis (approved treasury receipts/payments). `payables.customer_receivables` added.
- `/reports/accounts-receivable`, `/reports/customer-statement/{id}`, `/reports/accounts-payable`, `/reports/supplier-statement/{id}`
  use the same balance functions as the operational screens (`apps/api/app/modules/finance/balances.py`).
- General-ledger statements (trial balance, P&L, balance sheet) are **not reconciled with pre-0016 history and lack opening balances**;
  they must not be shown to users as official statements (see known limitations).
