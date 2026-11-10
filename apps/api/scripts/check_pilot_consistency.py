"""
فحص اتساق الأرصدة بين الشاشات والتقارير (للاستخدام قبل العرض وبعد أي تجربة).
─────────────────────────────────────────────────────────────────────────────
نفس الحدث يجب ألا ينتج أرصدة مختلفة في شاشتين. يقارن هذا السكربت عبر واجهة الـ API فقط (قراءة):
1. رصيد الخزنة: شاشة الخزينة ↔ لوحة الإدارة.
2. كل عميل: صفحة حساب العميل ↔ تقرير المديونيات ↔ كشف حساب العميل.
3. كل فاتورة/مورد: شاشة فواتير الشراء ↔ تقرير المستحقات ↔ كشف حساب المورد.
4. المخزون: أرصدة المخازن ↔ تقرير المخزون ↔ أرصدة المنتج التام لكل مقاس.
5. لا رصيد سالب في أي مخزن.

لا يكتب أي بيانات. الاستخدام:
    python scripts/check_pilot_consistency.py --api http://localhost:8010
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from urllib.parse import urlparse

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TOL = 0.01


class Checker:
    def __init__(self, api: str):
        if urlparse(api).hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise SystemExit("حظر: الفحص يعمل على خادم محلي فقط.")
        self.http = httpx.Client(base_url=api.rstrip("/") + "/api/v1", timeout=60)
        self.tokens: dict[str, str] = {}
        self.results: list[tuple[bool, str]] = []

    def login(self, role: str) -> str:
        if role not in self.tokens:
            res = self.http.post("/auth/local-login", json={"role": role})
            res.raise_for_status()
            self.tokens[role] = res.json()["access_token"]
        return self.tokens[role]

    def get(self, path: str, role: str = "general_manager"):
        res = self.http.get(path, headers={"Authorization": f"Bearer {self.login(role)}"})
        res.raise_for_status()
        return res.json()

    def check(self, ok: bool, label: str) -> None:
        self.results.append((ok, label))
        print(("  ✔ " if ok else "  ✖ ") + label)

    @staticmethod
    def same(a, b) -> bool:
        return abs(float(a or 0) - float(b or 0)) <= TOL

    # ─── 1. الخزينة ───────────────────────────────────────────────────────
    def treasury(self) -> None:
        print("\n① الخزينة")
        accounts = self.get("/finance/accounts")
        treasury = sum(float(a.get("balance") or a.get("current_balance") or 0) for a in accounts if a.get("account_type") == "treasury")
        summary = self.get("/reports/summary")["treasury"]["balance"]
        self.check(self.same(treasury, summary), f"رصيد الخزنة في شاشة الخزينة ({treasury:,.2f}) = لوحة الإدارة ({float(summary):,.2f})")

    # ─── 2. العملاء ───────────────────────────────────────────────────────
    def customers(self) -> None:
        print("\n② العملاء")
        ar = {c["customer_id"]: c for c in self.get("/reports/accounts-receivable")["customers"]}
        total_screen = 0.0
        for cust in self.get("/customers"):
            orders = self.get(f"/customers/{cust['id']}/account").get("orders", [])
            receivable = sum(o.get("receivable_amount", 0) for o in orders)
            paid = sum(o.get("paid_amount", 0) for o in orders)
            total_screen += receivable
            row = ar.get(cust["id"])
            if not orders and not row:
                continue
            rep_due = row["balance_due"] if row else 0
            rep_paid = row["total_paid"] if row else 0
            self.check(self.same(receivable, rep_due), f"{cust['name']}: المستحق في صفحة العميل ({receivable:,.2f}) = تقرير المديونيات ({rep_due:,.2f})")
            self.check(self.same(paid, rep_paid), f"{cust['name']}: المحصّل المعتمد ({paid:,.2f}) = تقرير المديونيات ({rep_paid:,.2f})")
            stmt = self.get(f"/reports/customer-statement/{cust['id']}")
            totals = stmt.get("totals") or stmt.get("summary") or {}
            stmt_due = totals.get("balance_due", totals.get("closing_balance"))
            if stmt_due is not None:
                self.check(self.same(receivable, stmt_due), f"{cust['name']}: كشف الحساب ({float(stmt_due):,.2f}) = صفحة العميل")
        summary = self.get("/reports/summary")["payables"]["customer_receivables"]
        self.check(self.same(total_screen, summary), f"إجمالي مديونيات العملاء ({total_screen:,.2f}) = لوحة الإدارة ({float(summary):,.2f})")

    # ─── 3. الموردون ──────────────────────────────────────────────────────
    def suppliers(self) -> None:
        print("\n③ الموردون")
        invoices = self.get("/finance/supplier-invoices", role="finance_manager")
        by_supplier: dict[str, float] = defaultdict(float)
        for inv in invoices:
            by_supplier[inv["supplier_id"]] += float(inv.get("payable_balance") or 0)
        ap = {s["supplier_id"]: s for s in self.get("/reports/accounts-payable")["suppliers"]}
        names = {s["id"]: s["name"] for s in self.get("/finance/suppliers")}
        for sid, due in by_supplier.items():
            rep = ap.get(sid, {}).get("balance_due", 0)
            self.check(self.same(due, rep), f"{names.get(sid, sid)}: المستحق في شاشة الفواتير ({due:,.2f}) = تقرير المستحقات ({float(rep):,.2f})")
            stmt = self.get(f"/reports/supplier-statement/{sid}")
            stmt_due = (stmt.get("totals") or {}).get("balance_due")
            if stmt_due is not None:
                self.check(self.same(due, stmt_due), f"{names.get(sid, sid)}: كشف حساب المورد ({float(stmt_due):,.2f}) = شاشة الفواتير")
        summary = self.get("/reports/summary")["payables"]["supplier_payables"]
        total = sum(by_supplier.values())
        self.check(self.same(total, summary), f"إجمالي مستحقات الموردين ({total:,.2f}) = لوحة الإدارة ({float(summary):,.2f})")

    # ─── 4. المخزون ───────────────────────────────────────────────────────
    def inventory(self) -> None:
        print("\n④ المخزون")
        stock = self.get("/inventory/stock")
        live = {(r["item_id"], r["warehouse_id"]): float(r["balance"] or 0) for r in stock if r.get("balance")}
        report = {(r["item_id"], r["warehouse_id"]): float(r["balance"] or 0) for r in self.get("/reports/inventory")["items"] if r.get("balance")}
        mismatches = [k for k in set(live) | set(report) if not self.same(live.get(k), report.get(k))]
        self.check(not mismatches, f"أرصدة المخازن = تقرير المخزون ({len(live)} رصيد، فروق: {len(mismatches)})")
        negatives = [k for k, v in live.items() if v < -TOL]
        self.check(not negatives, f"لا يوجد رصيد سالب في أي مخزن (سالب: {len(negatives)})")
        fg_wh = {r["warehouse_id"] for r in stock if r.get("warehouse_code") == "finished_goods"}
        fg_live = {r["item_id"]: float(r["balance"] or 0) for r in stock if r["warehouse_id"] in fg_wh and r.get("balance")}
        fg_screen = {r["item_id"]: float(r["total"] or 0) for r in self.get("/inventory/finished-goods-balances")}
        diff = [k for k in set(fg_live) | set(fg_screen) if not self.same(fg_live.get(k), fg_screen.get(k))]
        self.check(not diff, f"المنتج التام لكل مقاس: شاشة التام = دفتر المخزن ({len(fg_screen)} مقاس، فروق: {len(diff)})")

    def run(self) -> int:
        self.treasury()
        self.customers()
        self.suppliers()
        self.inventory()
        failed = [label for ok, label in self.results if not ok]
        print(f"\nالنتيجة: {len(self.results) - len(failed)} ناجح، {len(failed)} فاشل.")
        return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="فحص اتساق الأرصدة بين شاشات وتقارير نظام القمة")
    parser.add_argument("--api", default="http://localhost:8010")
    return Checker(parser.parse_args().api).run()


if __name__ == "__main__":
    sys.exit(main())
