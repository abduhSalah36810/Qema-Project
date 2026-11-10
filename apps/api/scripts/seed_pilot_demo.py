"""
بيانات العرض التجريبي لمصنع القمة (Pilot Demo Dataset) — DEMO-PILOT
─────────────────────────────────────────────────────────────────────────────
يبني قصة تشغيل صغيرة ومترابطة عبر واجهة الـ API الفعلية (وليس بالكتابة المباشرة في قاعدة
البيانات)، فتمر كل عملية على نفس القواعد والصلاحيات وقيود الخزينة ودفتر المخزون التي يمر عليها
المستخدم في الواجهة:

  موردون ← فواتير شراء ← استلام خامات ← أمر تشغيل بثلاثة مقاسات ← صرف ← استلام بالورشة ←
  مراحل ← استلام منتج تام لكل مقاس ← تسوية خامات ← إغلاق ← طلب عميل ← تسليم ← تحصيل ← اعتماد الخزينة

كل السجلات تبدأ بكود DEMO- وأسماؤها تنتهي بـ (تجريبي) حتى لا تختلط ببيانات المصنع الفعلية.

ضوابط الأمان:
1. يعمل فقط مع خادم على localhost وفيه الدخول المحلي للتطوير مفعل (development/testing فقط).
2. شغّله على قاعدة عرض مستقلة (مثل qemma_pilot_demo) — لا على قاعدة التطوير ولا الإنتاج.
3. يرفض التشغيل مرتين على نفس القاعدة (يتوقف إذا وجد المورد DEMO-SUP-01).

الاستخدام:
    python scripts/seed_pilot_demo.py --api http://localhost:8010
يطبع سجلاً بكل عملية ومرجعها والأرصدة الناتجة، ويحفظه في ملف JSON إن مُرر --report.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import urlparse

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TREASURY_ID = "00000000-0000-0000-0000-000000000001"
STAGES = ["cutting", "finishing", "snap_installation", "ironing", "packing"]
ROLE_AR = {
    "gm": "المدير العام",
    "wh": "أمين المخزن",
    "pm": "مدير الإنتاج",
    "fm": "المدير المالي",
}
ROLE_KEYS = {
    "gm": "general_manager",
    "wh": "warehouse_manager",
    "pm": "production_manager",
    "fm": "finance_manager",
}


class DemoError(RuntimeError):
    pass


class Demo:
    def __init__(self, api: str):
        host = urlparse(api).hostname
        if host not in {"localhost", "127.0.0.1", "::1"}:
            raise DemoError(f"حظر: بيانات العرض تُبنى على خادم محلي فقط (المستهدف {host}).")
        self.http = httpx.Client(base_url=api.rstrip("/") + "/api/v1", timeout=60)
        self.tokens: dict[str, str] = {}
        self.log: list[dict] = []
        self.refs: dict[str, str] = {}

    # ─── أدوات ────────────────────────────────────────────────────────────
    def login_all(self) -> None:
        for key, role in ROLE_KEYS.items():
            res = self.http.post("/auth/local-login", json={"role": role})
            if res.status_code != 200:
                raise DemoError(f"تعذر الدخول المحلي بدور {role}: {res.status_code} {res.text[:200]}")
            self.tokens[key] = res.json()["access_token"]

    def call(self, actor: str, method: str, path: str, expect: int | tuple[int, ...] = (200, 201), **kw):
        res = self.http.request(method, path, headers={"Authorization": f"Bearer {self.tokens[actor]}"}, **kw)
        expected = (expect,) if isinstance(expect, int) else expect
        if res.status_code not in expected:
            raise DemoError(f"{ROLE_AR[actor]} {method} {path} → {res.status_code}: {res.text[:400]}")
        return res.json() if res.content else None

    def step(self, title: str, actor: str, reference: str = "", result: str = "") -> None:
        entry = {"step": len(self.log) + 1, "action": title, "by": ROLE_AR[actor], "reference": reference, "result": result}
        self.log.append(entry)
        print(f"  {entry['step']:>2}. [{entry['by']}] {title}" + (f" — {reference}" if reference else "") + (f" → {result}" if result else ""))

    def approve(self, doc: dict, what: str) -> None:
        self.call("gm", "POST", f"/finance/cash-documents/{doc['id']}/decision", json={"decision": "approve"})
        self.step(f"اعتماد {what} في الخزينة", "gm", doc.get("document_number") or doc["id"][:8], "معتمد")

    def verify_target_is_demo_database(self) -> None:
        """يتأكد قبل أي كتابة أن الخادم متصل فعلاً بقاعدة العرض: يقارن أكواد أصناف الدليل
        كما يراها الخادم بما في قاعدة qemma_pilot_demo مباشرة."""
        import asyncio
        import os

        sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
        sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
        from reset_pilot_demo_db import DEMO_DB, demo_database_url
        import asyncpg
        from sqlalchemy.engine import make_url

        url = make_url(demo_database_url())

        async def codes() -> set[str]:
            conn = await asyncpg.connect(host=url.host, port=url.port, user=url.username, password=url.password, database=DEMO_DB)
            try:
                return {r[0] for r in await conn.fetch("SELECT code FROM catalog_items")}
            finally:
                await conn.close()

        direct = asyncio.run(codes())
        served = {i["code"] for i in self.call("gm", "GET", "/catalog/items", params={"limit": 250})}
        if direct != served:
            raise DemoError(
                f"حظر: الخادم على {self.http.base_url} ليس متصلاً بقاعدة {DEMO_DB} "
                f"({len(served)} صنف عند الخادم مقابل {len(direct)} في قاعدة العرض). لم يُكتب أي شيء."
            )

    # ─── 1. البيانات الأساسية ───────────────────────────────────────────────
    def master_data(self) -> None:
        print("\n① البيانات الأساسية")
        suppliers = self.call("gm", "GET", "/finance/suppliers")
        if any(s["code"] == "DEMO-SUP-01" for s in suppliers):
            raise DemoError("بيانات العرض موجودة بالفعل على هذه القاعدة (DEMO-SUP-01). استخدم قاعدة عرض جديدة.")

        self.suppliers = {}
        for code, name, phone, address in [
            ("DEMO-SUP-01", "النيل للمنسوجات (تجريبي)", "01000000001", "المحلة الكبرى"),
            ("DEMO-SUP-02", "الأمل لمستلزمات الخياطة (تجريبي)", "01000000002", "القاهرة - الموسكي"),
            ("DEMO-SUP-03", "الشروق للتعبئة والتغليف (تجريبي)", "01000000003", "العاشر من رمضان"),
        ]:
            s = self.call("wh", "POST", "/finance/suppliers", json={"code": code, "name": name, "phone": phone, "address": address})
            self.suppliers[code] = s["id"]
            self.step(f"إضافة مورد {name}", "wh", code)

        self.customers = {}
        for code, name, phone, city in [
            ("DEMO-CUS-01", "محلات الأمانة للملابس (تجريبي)", "01100000001", "القاهرة"),
            ("DEMO-CUS-02", "مؤسسة النور التجارية (تجريبي)", "01100000002", "الإسكندرية"),
            ("DEMO-CUS-03", "معرض الفجر (تجريبي)", "01100000003", "أسيوط"),
        ]:
            c = self.call("gm", "POST", "/customers", json={"code": code, "name": name, "phone": phone, "city": city})
            self.customers[code] = c["id"]
            self.step(f"إضافة عميل {name}", "gm", code)

        # الخامات: الأصناف المبدئية تبدأ مسودات؛ أمين المخزن يصنفها ويقدمها والمدير العام يعتمدها
        categories = {c["code"]: c["id"] for c in self._flatten(self.call("gm", "GET", "/catalog/categories"))}
        category_for = {
            "FAB-COTTON-01": "FAB_MAIN", "FAB-LINEN-02": "FAB_MAIN", "ACC-BUTTON-01": "TRM_BUTTONS",
            "ACC-SNAP-01": "TRM_SNAPS", "ACC-THREAD-01": "SEW_THREAD_SEWING", "TOOL-PATTERN-58": "TOL_MEASURING",
            "MAINT-OIL-01": "MNT_LUBRICANTS", "PKG-BOX-01": "PKG_BOXES",
        }
        reorder = {"FAB-COTTON-01": 200, "FAB-LINEN-02": 100, "ACC-BUTTON-01": 1000, "ACC-SNAP-01": 500, "ACC-THREAD-01": 10, "PKG-BOX-01": 100}
        items = {i["code"]: i for i in self.call("gm", "GET", "/catalog/items", params={"limit": 250})}
        self.items = {}
        for code, cat in category_for.items():
            item = items.get(code)
            if not item:
                continue
            self.items[code] = item
            if item.get("approval_status") == "approved":
                continue
            self.call("wh", "PATCH", f"/catalog/items/{item['id']}", json={
                "category_id": categories[cat], "classification_status": "confirmed", "reorder_level": reorder.get(code, 0),
            })
            self.call("wh", "POST", f"/catalog/items/{item['id']}/submit", json={})
            self.call("gm", "POST", f"/catalog/items/{item['id']}/approve", json={})
        self.step(f"تصنيف واعتماد {len(self.items)} صنف خامات ومستلزمات", "gm", "أمين المخزن يقدم ← المدير العام يعتمد")

        products = {p["code"]: p for p in self.call("gm", "GET", "/production/products")}
        self.products = products
        # موديل إضافي يوضح إضافة موديل ومقاسات من الواجهة
        p = self.call("pm", "POST", "/production/products", json={
            "code": "DEMO-PRD-01", "name_ar": "جلابية أطفال قطن (تجريبي)", "style_type": "custom",
            "description": "موديل تجريبي لعرض إضافة الموديلات والمقاسات",
            "variants": [{"numeric_size": s, "season": "summer"} for s in (40, 44, 48)],
        })
        self.products[p["code"]] = p
        self.step("إضافة موديل جديد بثلاثة مقاسات", "pm", "DEMO-PRD-01", "مقاسات 40 / 44 / 48")

        self.units = {u["code"]: u["id"] for u in self.call("gm", "GET", "/catalog/units")}

    @staticmethod
    def _flatten(nodes):
        out = []
        for n in nodes or []:
            out.append(n)
            out.extend(Demo._flatten(n.get("children") or n.get("subcategories") or []))
        return out

    # ─── 2. الخزينة الافتتاحية ──────────────────────────────────────────────
    def opening_cash(self) -> None:
        print("\n② رصيد الخزنة الافتتاحي")
        doc = self.call("fm", "POST", "/finance/cash-documents", json={
            "document_type": "income", "to_account_id": TREASURY_ID, "amount": "150000.00",
            "description": "رصيد افتتاحي للخزنة الرئيسية (تجريبي)", "occurred_at": _now(),
        })
        self.step("تسجيل رصيد افتتاحي 150,000 ج.م (معلق)", "fm", doc.get("document_number", ""))
        self.approve(doc, "الرصيد الافتتاحي")

    # ─── 3. المشتريات والاستلام ─────────────────────────────────────────────
    def purchasing(self) -> None:
        print("\n③ المشتريات واستلام الخامات")
        it, u = self.items, self.units

        def line(code, qty, price, discount="0"):
            return {"item_id": it[code]["id"], "unit_id": it[code]["unit_id"], "invoiced_quantity": qty,
                    "unit_price": price, "discount_amount": discount}

        inv1 = self.call("wh", "POST", "/finance/supplier-invoices", json={
            "supplier_id": self.suppliers["DEMO-SUP-01"], "invoice_number": "DEMO-INV-1001", "invoice_date": _now(-6),
            "notes": "أقمشة الموسم (تجريبي)",
            "lines": [line("FAB-COTTON-01", 1000, "45"), line("FAB-LINEN-02", 400, "60", "500")],
        })
        self.step("فاتورة شراء أقمشة: قطن 1000م × 45 + كتان 400م × 60 − خصم 500", "wh", inv1["internal_number"], "الإجمالي 68,500")
        self.call("wh", "POST", f"/finance/supplier-invoices/{inv1['id']}/receive", json={
            "lines": [{"line_id": l["id"], "received_quantity": l["invoiced_quantity"]} for l in inv1["lines"]],
            "notes": "استلام كامل",
        })
        self.step("استلام كامل للأقمشة بمخزن الخامات", "wh", inv1["internal_number"], "قطن +1000م، كتان +400م")

        inv2 = self.call("wh", "POST", "/finance/supplier-invoices", json={
            "supplier_id": self.suppliers["DEMO-SUP-02"], "invoice_number": "DEMO-INV-2001", "invoice_date": _now(-5),
            "lines": [line("ACC-BUTTON-01", 6000, "0.75"), line("ACC-SNAP-01", 2000, "0.5"), line("ACC-THREAD-01", 50, "35")],
        })
        self.call("wh", "POST", f"/finance/supplier-invoices/{inv2['id']}/receive", json={
            "lines": [{"line_id": l["id"], "received_quantity": l["invoiced_quantity"]} for l in inv2["lines"]],
        })
        self.step("فاتورة مستلزمات (أزرار، كباسين، خيط) واستلامها كاملة", "wh", inv2["internal_number"], "الإجمالي 7,250 — غير مسددة")

        inv3 = self.call("wh", "POST", "/finance/supplier-invoices", json={
            "supplier_id": self.suppliers["DEMO-SUP-03"], "invoice_number": "DEMO-INV-3001", "invoice_date": _now(-2),
            "lines": [line("PKG-BOX-01", 500, "4")],
        })
        self.call("wh", "POST", f"/finance/supplier-invoices/{inv3['id']}/receive", json={
            "lines": [{"line_id": inv3["lines"][0]["id"], "received_quantity": 300}], "notes": "استلام جزئي — الباقي الأسبوع القادم",
        })
        self.step("فاتورة كراتين 500 × 4 واستلام جزئي 300 فقط", "wh", inv3["internal_number"], "مستلمة جزئياً")

        pay = self.call("fm", "POST", f"/finance/supplier-invoices/{inv1['id']}/payments", json={
            "amount": "20000.00", "description": "دفعة أولى لمورد الأقمشة (تجريبي)",
        })
        self.step("طلب سداد 20,000 لمورد الأقمشة (معلق حتى الاعتماد)", "fm", pay.get("document_number", ""))
        self.approve(pay, "سداد المورد")
        self.refs.update(inv_fabric=inv1["id"], inv_trims=inv2["id"], inv_boxes=inv3["id"])

    # ─── 4. الإنتاج ────────────────────────────────────────────────────────
    def _variant(self, product_code: str, size: int, season: str = "summer") -> dict:
        p = self.products[product_code]
        return next(v for v in p["variants"] if v["numeric_size"] == size and v["season"] == season)

    def _material(self, code: str, qty: float) -> dict:
        i = self.items[code]
        return {"item_id": i["id"], "unit_id": i["unit_id"], "planned_quantity": qty}

    def production(self) -> None:
        print("\n④ أوامر التشغيل")
        prd = self.products["PRD-GLB-01"]
        sizes = (56, 58, 60)
        order = self.call("pm", "POST", "/production/orders", json={
            "items": [{"product_id": prd["id"], "variant_id": self._variant("PRD-GLB-01", s)["id"], "target_quantity": 40, "season": "summer"} for s in sizes],
            "custom_materials": [
                self._material("FAB-COTTON-01", 336), self._material("ACC-BUTTON-01", 720),
                self._material("ACC-SNAP-01", 240), self._material("ACC-THREAD-01", 6), self._material("PKG-BOX-01", 120),
            ],
            "notes": "دفعة جلابية كفتة صيفي — 3 مقاسات × 40 (تجريبي)",
        })
        on = order["order_number"]
        self.step("إنشاء أمر تشغيل: جلابية كفتة 56/58/60 × 40 قطعة", "pm", on, "مسودة")
        self.call("wh", "POST", f"/production/orders/{order['id']}/dispatch", json={"notes": "صرف كامل الخامات"})
        self.step("صرف الخامات من مخزن الخامات إلى الورشة", "wh", on, "قطن −336م، أزرار −720 ...")
        self.call("pm", "POST", f"/production/orders/{order['id']}/receive", json={
            "received_lines": [
                {"item_id": self.items["FAB-COTTON-01"]["id"], "received_quantity": 334},
                {"item_id": self.items["ACC-BUTTON-01"]["id"], "received_quantity": 720},
                {"item_id": self.items["ACC-SNAP-01"]["id"], "received_quantity": 240},
                {"item_id": self.items["ACC-THREAD-01"]["id"], "received_quantity": 6},
                {"item_id": self.items["PKG-BOX-01"]["id"], "received_quantity": 120},
            ],
            "notes": "عجز نقل 2 متر قماش",
        })
        self.step("استلام الخامات بالورشة (تحت التشغيل) مع عجز نقل 2م", "pm", on, "WIP قطن 334م")
        for stage in STAGES:
            for st in ("in_progress", "completed"):
                self.call("pm", "POST", f"/production/orders/{order['id']}/stages/{stage}", json={"status": st})
        self.step("تسجيل المراحل: قص ← تقفيل ← كباسين ← كي ← تعبئة", "pm", on, "مكتملة")
        detail = self.call("pm", "GET", f"/production/orders/{order['id']}")
        by_size = {}
        for item in detail["items"]:
            v = next(v for v in prd["variants"] if v["id"] == item["variant_id"])
            by_size[v["numeric_size"]] = item["id"]
        self.call("wh", "POST", f"/production/orders/{order['id']}/finished-receipt", json={
            "lines": [
                {"order_item_id": by_size[56], "accepted_quantity": 40},
                {"order_item_id": by_size[58], "accepted_quantity": 39, "rejected_quantity": 1},
                {"order_item_id": by_size[60], "accepted_quantity": 40},
            ],
            "notes": "استلام بالفحص — قطعة مرفوضة مقاس 58",
        })
        self.step("استلام المنتج التام لكل مقاس بمخزن التام", "wh", on, "56: 40 | 58: 39 (+1 مرفوضة) | 60: 40")
        recon = self.call("pm", "POST", f"/production/orders/{order['id']}/material-reconciliations", json={
            "lines": [
                {"item_id": self.items["FAB-COTTON-01"]["id"], "consumed_quantity": 325, "returned_quantity": 6, "scrapped_quantity": 3},
                {"item_id": self.items["ACC-BUTTON-01"]["id"], "consumed_quantity": 714, "returned_quantity": 6},
                {"item_id": self.items["ACC-SNAP-01"]["id"], "consumed_quantity": 238, "returned_quantity": 2},
                {"item_id": self.items["ACC-THREAD-01"]["id"], "consumed_quantity": 6},
                {"item_id": self.items["PKG-BOX-01"]["id"], "consumed_quantity": 119, "returned_quantity": 1},
            ],
            "notes": "تسوية نهاية الأمر: استهلاك + مرتجع للمخزن + هالك",
        })
        self.step("تسوية خامات الورشة (استهلاك / مرتجع / هالك)", "pm", on, "رصيد الورشة = صفر، المرتجع بالطريق بانتظار فحص المخزن")
        # المرتجع لا يدخل رصيد الخامات إلا بعد فحص واستلام أمين المخزن
        return_id = recon["return_transfer_id"]
        returned = {"FAB-COTTON-01": 6, "ACC-BUTTON-01": 6, "ACC-SNAP-01": 2, "PKG-BOX-01": 1}
        self.call("wh", "POST", f"/production/orders/{order['id']}/returns/{return_id}/receive", json={
            "lines": [{"item_id": self.items[code]["id"], "accepted_quantity": qty} for code, qty in returned.items()],
        })
        self.step("فحص واستلام مرتجع الورشة بمخزن الخامات", "wh", recon.get("return_transfer_number") or on, "قطن +6م، أزرار +6، كباسين +2، كراتين +1")
        self.call("gm", "POST", f"/production/orders/{order['id']}/close", json={
            "discrepancy_signoff": True, "discrepancy_notes": "عجز نقل 2م قماش", "under_production_reason": "قطعة مرفوضة بالفحص مقاس 58",
        })
        self.step("إغلاق أمر التشغيل", "gm", on, "مغلق")
        self.refs["order_closed"] = order["id"]

        # أمر ثانٍ جارٍ في الورشة
        prd5 = self.products["PRD-GLB-05"]
        order2 = self.call("pm", "POST", "/production/orders", json={
            "items": [{"product_id": prd5["id"], "variant_id": self._variant("PRD-GLB-05", s)["id"], "target_quantity": 50, "season": "summer"} for s in (58, 60)],
            "custom_materials": [self._material("FAB-LINEN-02", 250), self._material("ACC-BUTTON-01", 400), self._material("ACC-THREAD-01", 5)],
            "notes": "جلابية نص كم كتان — جارية (تجريبي)",
        })
        self.call("wh", "POST", f"/production/orders/{order2['id']}/dispatch", json={"notes": "صرف"})
        self.call("pm", "POST", f"/production/orders/{order2['id']}/receive", json={
            "received_lines": [
                {"item_id": self.items["FAB-LINEN-02"]["id"], "received_quantity": 250},
                {"item_id": self.items["ACC-BUTTON-01"]["id"], "received_quantity": 400},
                {"item_id": self.items["ACC-THREAD-01"]["id"], "received_quantity": 5},
            ], "notes": "",
        })
        self.call("pm", "POST", f"/production/orders/{order2['id']}/stages/cutting", json={"status": "in_progress"})
        self.call("pm", "POST", f"/production/orders/{order2['id']}/stages/cutting", json={"status": "completed"})
        self.call("pm", "POST", f"/production/orders/{order2['id']}/stages/finishing", json={"status": "in_progress"})
        self.step("أمر تشغيل ثانٍ: نص كم كتان 58/60 × 50 — مصروف وجارٍ في التقفيل", "pm", order2["order_number"], "قيد التشغيل")

        # أمر ثالث مسودة لعرض الصرف أمام المصنع
        prd3 = self.products["PRD-GLB-03"]
        order3 = self.call("pm", "POST", "/production/orders", json={
            "items": [{"product_id": prd3["id"], "variant_id": self._variant("PRD-GLB-03", s)["id"], "target_quantity": 25, "season": "summer"} for s in (58, 62)],
            "custom_materials": [self._material("FAB-COTTON-01", 140), self._material("ACC-BUTTON-01", 300), self._material("ACC-SNAP-01", 100)],
            "notes": "جلابية لياقة كاملة — جاهز للصرف (تجريبي)",
        })
        self.step("أمر تشغيل ثالث مسودة جاهز للصرف أثناء العرض", "pm", order3["order_number"], "مسودة")

    # ─── 5. المبيعات والتسليم والتحصيل ───────────────────────────────────────
    def sales(self) -> None:
        print("\n⑤ طلبات العملاء والتسليم والتحصيل")
        prd = self.products["PRD-GLB-01"]
        cid = self.customers["DEMO-CUS-01"]
        order = self.call("gm", "POST", f"/customers/{cid}/orders", json={
            "order_type": "ready_goods", "discount_amount": "400.00", "payment_terms": "50% عند التسليم والباقي خلال 30 يوماً",
            "expected_delivery_at": _now(3),
            "lines": [
                {"product_id": prd["id"], "variant_id": self._variant("PRD-GLB-01", 56)["id"], "quantity": "20", "unit_price": "350.00"},
                {"product_id": prd["id"], "variant_id": self._variant("PRD-GLB-01", 58)["id"], "quantity": "20", "unit_price": "350.00"},
            ],
        })
        self.step("طلب عميل: 20 مقاس 56 + 20 مقاس 58 × 350 − خصم 400", "gm", order["order_number"], f"الإجمالي {order['total_amount']:,.0f}")
        lines = {l["variant_id"]: l["id"] for l in order["lines"]}
        delivery = self.call("wh", "POST", f"/customers/{cid}/orders/{order['id']}/deliveries", json={
            "received_by": "مندوب محلات الأمانة", "notes": "تسليم أول",
            "lines": [
                {"order_line_id": lines[self._variant("PRD-GLB-01", 56)["id"]], "quantity": "20"},
                {"order_line_id": lines[self._variant("PRD-GLB-01", 58)["id"]], "quantity": "10"},
            ],
        })
        self.step("تسليم جزئي للعميل: 20 مقاس 56 + 10 مقاس 58", "wh", delivery.get("delivery_number", ""), "ينقص مخزن التام")
        pay = self.call("fm", "POST", f"/customers/{cid}/orders/{order['id']}/payments", json={
            "amount": "5000.00", "method": "cash", "reference": "إيصال 001", "notes": "دفعة عند التسليم",
        })
        self.step("تحصيل 5,000 نقداً من العميل (معلق)", "fm", pay.get("cash_document_number") or "")
        self.approve({"id": pay["cash_document_id"]}, "تحصيل العميل")

        cid2 = self.customers["DEMO-CUS-02"]
        order2 = self.call("gm", "POST", f"/customers/{cid2}/orders", json={
            "order_type": "ready_goods", "expected_delivery_at": _now(7),
            "lines": [{"product_id": prd["id"], "variant_id": self._variant("PRD-GLB-01", 60)["id"], "quantity": "30", "unit_price": "360.00"}],
        })
        self.step("طلب عميل ثانٍ: 30 مقاس 60 × 360 — لم يُسلم بعد", "gm", order2["order_number"], "بانتظار التسليم")
        pay2 = self.call("fm", "POST", f"/customers/{cid2}/orders/{order2['id']}/payments", json={
            "amount": "3000.00", "method": "cash", "reference": "عربون", "notes": "عربون حجز",
        })
        self.step("عربون 3,000 من العميل الثاني — متروك معلقاً لعرض الاعتماد في الخزينة", "fm", "", "معلق")

    # ─── 6. ملخص الأرصدة ────────────────────────────────────────────────────
    def summary(self) -> dict:
        print("\n⑥ الأرصدة الناتجة (من شاشات النظام نفسها)")
        accounts = self.call("gm", "GET", "/finance/accounts")
        treasury = next(a for a in accounts if a["id"] == TREASURY_ID)
        invoices = self.call("fm", "GET", "/finance/supplier-invoices")
        payables = {i["invoice_number"]: float(i["payable_balance"]) for i in invoices if i["invoice_number"].startswith("DEMO-")}
        customers = {}
        for code, cid in self.customers.items():
            orders = self.call("gm", "GET", f"/customers/{cid}/account").get("orders", [])
            customers[code] = {
                "orders_total": sum(o["total_amount"] for o in orders),
                "delivered_value": sum(o["delivered_value"] for o in orders),
                "approved_payments": sum(o["paid_amount"] for o in orders),
                "pending_payments": sum(o["pending_payments_amount"] for o in orders),
                "receivable_now": sum(o["receivable_amount"] for o in orders),
                "remaining_on_orders": sum(o["balance_amount"] for o in orders),
            }
        stock = self.call("gm", "GET", "/inventory/stock")
        result = {"treasury_balance": treasury.get("balance") or treasury.get("current_balance"),
                  "supplier_payables": payables, "customers": customers, "stock_rows": len(stock) if isinstance(stock, list) else None}
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return result


def _now(days: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def main() -> int:
    parser = argparse.ArgumentParser(description="بناء بيانات العرض التجريبي لمصنع القمة عبر الـ API")
    parser.add_argument("--api", default="http://localhost:8010", help="عنوان خادم الـ API المحلي")
    parser.add_argument("--report", default="", help="مسار ملف JSON لحفظ سجل العمليات والأرصدة")
    args = parser.parse_args()
    demo = Demo(args.api)
    try:
        ready = demo.http.get("/ready").json()
        if ready.get("status") != "ready":
            raise DemoError(f"الخادم غير جاهز: {ready}")
        demo.login_all()
        demo.verify_target_is_demo_database()
        demo.master_data()
        demo.opening_cash()
        demo.purchasing()
        demo.production()
        demo.sales()
        balances = demo.summary()
    except DemoError as exc:
        print(f"\n✖ توقف: {exc}")
        return 1
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump({"steps": demo.log, "balances": balances}, fh, ensure_ascii=False, indent=2, default=str)
    print(f"\n✔ اكتملت بيانات العرض: {len(demo.log)} عملية.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
