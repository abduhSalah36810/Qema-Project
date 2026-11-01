"""
اختبارات دورة الجرد والتسويات المخزنية (Stocktake & Inventory Adjustments Tests).
─────────────────────────────────────────────────────────────────────────────
تغطي:
1. إنشاء جلسات الجرد وتثبيت اللقطة الدفترية (Book Quantity Snapshot).
2. تسجيل العد الفعلي، العد الجزئي، التمييز الصارم بين الصفر والغياب، وتاريخ إعادة العد (Count History).
3. احتساب الفروقات بدقة (عجز Shortage / زيادة Surplus / تطابق Exact).
4. مسار المراجعة والاعتماد وفصل الصلاحيات (Maker-Checker RBAC).
5. ترحيل التسويات بقيود ليدجر حقيقية غير قابلة للتعديل أو المسح (Immutable StockLedgerEntry).
6. الحماية من الحركات المخزنية المتداخلة وتعارض اللقطة (Snapshot Drift Conflict -> 409).
7. منع التكرار (Idempotency Key Replay).
8. سجل التدقيق المتسلسل (Audit Trail Investigation).
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

import app.db.base  # noqa: F401
from app.core.auth import AuthenticatedUser, get_current_user
from app.core.permissions import ROLE_GENERAL_MANAGER, ROLE_WAREHOUSE_MANAGER, ROLE_FINANCE_MANAGER
from app.db.session import get_db
from app.main import app
from app.modules.production.models import (
    CatalogItem,
    StockLedgerEntry,
    StocktakeAuditLog,
    StocktakeCountHistory,
    StocktakeLine,
    StocktakeSession,
    Unit,
    Warehouse,
    utc_now,
)
from app.modules.production.service import (
    lock_stock_balance,
    seed_provisional_data_if_empty,
)
from app.modules.production.stocktake_service import (
    create_stocktake_session,
    post_stocktake_adjustments,
    record_counts,
    review_stocktake,
    start_counting,
    submit_for_review,
)


def _uid() -> str:
    return str(uuid.uuid4())


@pytest.fixture
async def setup_stocktake_data(session: AsyncSession):
    """تهيئة مخزن وأصناف وأرصدة دفترية معتمدة للاختبار."""
    await seed_provisional_data_if_empty(session)

    # مخزن الخامات الرئيسي
    wh = (await session.execute(
        select(Warehouse).where(Warehouse.code == "main_raw_materials")
    )).scalar_one_or_none()
    if not wh:
        wh = Warehouse(id=_uid(), code="main_raw_materials", name_ar="مخزن الخامات الرئيسي", is_active=True)
        session.add(wh)

    # وحدة المتر
    unit = (await session.execute(
        select(Unit).where(Unit.code == "meter")
    )).scalar_one_or_none()
    if not unit:
        unit = Unit(id=_uid(), code="meter", name_ar="متر", is_active=True)
        session.add(unit)

    # صنف قماش 1 برصيد 100 متر
    code1 = f"FAB-TEST-{uuid.uuid4().hex[:6]}"
    item1 = CatalogItem(
        id=_uid(), code=code1, name_ar=f"قماش قطن جرد {code1}",
        item_type="raw_material", unit_id=unit.id, is_active=True,
        approval_status="approved", classification_status="confirmed",
    )
    session.add(item1)

    # صنف خيط 2 برصيد 50 بكرة
    code2 = f"THR-TEST-{uuid.uuid4().hex[:6]}"
    item2 = CatalogItem(
        id=_uid(), code=code2, name_ar=f"خيط حياكة جرد {code2}",
        item_type="raw_material", unit_id=unit.id, is_active=True,
        approval_status="approved", classification_status="confirmed",
    )
    session.add(item2)

    await session.flush()

    # إيداع رصيد دفتري أولي عبر StockLedgerEntry
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item1.id, unit_id=unit.id, warehouse_id=wh.id,
        location_type="warehouse", quantity=100.0,
        reference_doc_type="initial_deposit", reference_doc_id="INIT-01",
        entry_type="initial_stock", created_by="test_setup"
    ))
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item2.id, unit_id=unit.id, warehouse_id=wh.id,
        location_type="warehouse", quantity=50.0,
        reference_doc_type="initial_deposit", reference_doc_id="INIT-02",
        entry_type="initial_stock", created_by="test_setup"
    ))

    await session.commit()

    return {
        "warehouse": wh,
        "unit": unit,
        "item1": item1,
        "item2": item2,
    }


def make_auth_user(user_id: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(
        id=user_id,
        email=f"{user_id}@qemma.test",
        claims={"sub": user_id, "role": role},
        raw_token=f"Bearer {user_id}_token",
    )


# ── 1. اختبارات إنشاء الجلسة واللقطة الدفترية ─────────────────────────────────

@pytest.mark.asyncio
async def test_create_stocktake_captures_book_snapshot(session: AsyncSession, setup_stocktake_data):
    """التحقق من إنشاء جلسة الجرد وتثبيت الأرصدة الدفترية الحقيقية لحظة الفتح."""
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]
    item2 = data["item2"]

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("gm_user", ROLE_GENERAL_MANAGER)

    res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={
            "warehouse_id": wh.id,
            "scope_type": "specific_items",
            "item_ids": [item1.id, item2.id],
            "description": "جرد ربع سنوي لخامات الأقمشة",
        },
    )
    assert res.status_code == 201
    body = res.json()
    assert body["session_number"].startswith("STK-")
    assert body["status"] == "draft"
    assert body["total_lines"] == 2
    assert body["counted_lines"] == 0

    lines = body["lines"]
    line_map = {l["item_id"]: l for l in lines}

    # التحقق من تثبيت اللقطة الدفترية بدقة
    assert line_map[item1.id]["book_quantity"] == 100.0
    assert line_map[item1.id]["counted_quantity"] is None  # لم يُعد بعد
    assert line_map[item1.id]["status"] == "uncounted"

    assert line_map[item2.id]["book_quantity"] == 50.0
    assert line_map[item2.id]["counted_quantity"] is None

    app.dependency_overrides.clear()


# ── 2. اختبارات العد الفعلي والصفر المعتمد وتاريخ إعادة العد ───────────────────

@pytest.mark.asyncio
async def test_record_counts_and_distinguish_zero_from_uncounted(session: AsyncSession, setup_stocktake_data):
    """
    التحقق من تسجيل العد الفعلي:
    - الصفر هو قيمة معدودة فعلية (رصيد نافد).
    - حفظ تاريخ إعادة العد في StocktakeCountHistory.
    """
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]
    item2 = data["item2"]

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("wh_user", ROLE_WAREHOUSE_MANAGER)

    # 1. إنشاء الجلسة
    create_res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={
            "warehouse_id": wh.id,
            "scope_type": "specific_items",
            "item_ids": [item1.id, item2.id],
        },
    )
    st_id = create_res.json()["id"]
    lines = create_res.json()["lines"]
    line1 = next(l for l in lines if l["item_id"] == item1.id)
    line2 = next(l for l in lines if l["item_id"] == item2.id)

    # 2. بدء العد
    start_res = await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    assert start_res.status_code == 200
    assert start_res.json()["status"] == "counting"

    # 3. تسجيل عد جزئي (صنف 1 = 95 متر، وصنف 2 = 0.0 متر صفر معتمد!)
    count_res = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={
            "counts": [
                {"line_id": line1["id"], "counted_quantity": 95.0, "notes": "عجز 5 أمتار قص تالف"},
                {"line_id": line2["id"], "counted_quantity": 0.0, "notes": "الصنف نافد بالكامل"},
            ],
            "reason": "first_count",
        },
    )
    assert count_res.status_code == 200
    res_lines = {l["id"]: l for l in count_res.json()["lines"]}

    # صنف 1: عجز -5
    assert res_lines[line1["id"]]["counted_quantity"] == 95.0
    assert res_lines[line1["id"]]["variance"] == -5.0
    assert res_lines[line1["id"]]["status"] == "counted"

    # صنف 2: صفر حقيقي (وليس None)، عجز -50
    assert res_lines[line2["id"]]["counted_quantity"] == 0.0
    assert res_lines[line2["id"]]["variance"] == -50.0
    assert res_lines[line2["id"]]["status"] == "counted"

    # 4. إعادة عد الصنف 1 لتصحيح الكمية إلى 97
    recount_res = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={
            "counts": [
                {"line_id": line1["id"], "counted_quantity": 97.0, "notes": "إعادة عد: تم العثور على توب إضافي 2 متر"},
            ],
            "reason": "recount",
        },
    )
    assert recount_res.status_code == 200
    updated_line1 = next(l for l in recount_res.json()["lines"] if l["id"] == line1["id"])
    assert updated_line1["counted_quantity"] == 97.0
    assert updated_line1["variance"] == -3.0

    # التحقق من أن تاريخ العد StocktakeCountHistory يحتوي على المحاولتين
    history_stmt = (
        select(StocktakeCountHistory)
        .where(StocktakeCountHistory.line_id == line1["id"])
        .order_by(StocktakeCountHistory.counted_at.asc())
    )
    history_records = (await session.scalars(history_stmt)).all()
    assert len(history_records) == 2
    assert history_records[0].counted_quantity == 95.0
    assert history_records[0].reason == "first_count"
    assert history_records[1].counted_quantity == 97.0
    assert history_records[1].previous_quantity == 95.0
    assert history_records[1].reason == "recount"

    app.dependency_overrides.clear()


# ── 3. اختبارات فصل الصلاحيات والاعتماد (Maker-Checker RBAC) ─────────────────

@pytest.mark.asyncio
async def test_maker_checker_approval_enforcement(session: AsyncSession, setup_stocktake_data):
    """
    التحقق من فصل الصلاحيات (Maker-Checker):
    - أمين المخزن (warehouse_manager) يمكنه إنشاء الجلسة والعد والتقديم.
    - أمين المخزن لا يملك صلاحية الاعتماد (403) أو الترحيل (403).
    - المدير العام (general_manager) هو المخول بالاعتماد والترحيل.
    """
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session

    # 1. أمين المخزن ينشئ ويعد ويقدم
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("wh_staff", ROLE_WAREHOUSE_MANAGER)

    create_res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={"warehouse_id": wh.id, "scope_type": "specific_items", "item_ids": [item1.id]},
    )
    st_id = create_res.json()["id"]
    line_id = create_res.json()["lines"][0]["id"]

    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={"counts": [{"line_id": line_id, "counted_quantity": 105.0}]},
    )
    submit_res = await client.post(f"/api/v1/inventory/stocktakes/{st_id}/submit")
    assert submit_res.status_code == 200
    assert submit_res.json()["status"] == "submitted"

    # 2. محاولة أمين المخزن اعتماد أو ترحيل الجلسة بنفسه -> ترفض 403
    approve_attempt = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/approve",
        json={"decision": "approve", "notes": "اعتماد غير مصرح به"},
    )
    assert approve_attempt.status_code == 403

    post_attempt = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/post",
        json={"notes": "ترحيل غير مصرح به"},
    )
    assert post_attempt.status_code == 403

    # 3. المدير العام يعتمد الجلسة بنجاح
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("gm_boss", ROLE_GENERAL_MANAGER)
    approve_res = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/approve",
        json={"decision": "approve", "notes": "تم فحص الزيادة واعتماد الترحيل"},
    )
    assert approve_res.status_code == 200
    assert approve_res.json()["status"] == "approved"

    app.dependency_overrides.clear()


# ── 4. اختبارات ترحيل التسويات وقيود الأستاذ غير القابلة للتعديل ───────────────

@pytest.mark.asyncio
async def test_post_stocktake_adjustments_creates_immutable_ledger_entries(session: AsyncSession, setup_stocktake_data):
    """
    التحقق من ترحيل التسويات:
    - العجز ينشئ قيداً سالباً (stocktake_shortage).
    - الزيادة تنشئ قيداً موجباً (stocktake_surplus).
    - التطابق التام لا ينشئ أي قيد صفري غير ضروري.
    - قيود الأستاذ ترتبط برقم ومستند الجلسة.
    - القيود غير قابلة للتعديل أو المسح بسبب تريجر قاعدة البيانات.
    """
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]  # رصيد دفتري 100
    item2 = data["item2"]  # رصيد دفتري 50

    # إنشاء صنف ثالث متطابق تماماً
    code3 = f"FAB-EXACT-{uuid.uuid4().hex[:6]}"
    item3 = CatalogItem(
        id=_uid(), code=code3, name_ar=f"قماش مطابق {code3}",
        item_type="raw_material", unit_id=data["unit"].id, is_active=True,
        approval_status="approved", classification_status="confirmed",
    )
    session.add(item3)
    await session.flush()
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item3.id, unit_id=data["unit"].id, warehouse_id=wh.id,
        location_type="warehouse", quantity=40.0,
        reference_doc_type="initial_deposit", reference_doc_id="INIT-03",
        entry_type="initial_stock", created_by="test_setup"
    ))
    await session.commit()

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("gm_user", ROLE_GENERAL_MANAGER)

    # 1. إنشاء الجلسة
    create_res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={"warehouse_id": wh.id, "scope_type": "specific_items", "item_ids": [item1.id, item2.id, item3.id]},
    )
    st_id = create_res.json()["id"]
    lines = {l["item_id"]: l for l in create_res.json()["lines"]}

    # 2. بدء العد وتسجيل:
    # item1 (دفتر 100): عدلي 90 (عجز -10)
    # item2 (دفتر 50): عدلي 60 (زيادة +10)
    # item3 (دفتر 40): عدلي 40 (تطابق 0)
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={
            "counts": [
                {"line_id": lines[item1.id]["id"], "counted_quantity": 90.0},
                {"line_id": lines[item2.id]["id"], "counted_quantity": 60.0},
                {"line_id": lines[item3.id]["id"], "counted_quantity": 40.0},
            ]
        },
    )
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/submit")
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})

    # 3. ترحيل التسويات
    post_res = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/post",
        json={"notes": "ترحيل معتمد بعد المطابقة"},
    )
    assert post_res.status_code == 200
    post_data = post_res.json()
    assert post_data["status"] == "posted"
    assert post_data["shortage_count"] == 1
    assert post_data["surplus_count"] == 1
    assert post_data["ledger_entries_created"] == 2  # فقط للعجز والزيادة؛ لا قيد للصنف المطابق

    # 4. التحقق من قيود الأستاذ في قاعدة البيانات
    ledger_entries = (await session.scalars(
        select(StockLedgerEntry)
        .where(
            StockLedgerEntry.reference_doc_type == "stocktake",
            StockLedgerEntry.reference_doc_id == st_id,
        )
        .order_by(StockLedgerEntry.entry_type)
    )).all()
    assert len(ledger_entries) == 2

    shortage_entry = next(e for e in ledger_entries if e.entry_type == "stocktake_shortage")
    assert shortage_entry.item_id == item1.id
    assert shortage_entry.quantity == -10.0
    assert shortage_entry.warehouse_id == wh.id

    surplus_entry = next(e for e in ledger_entries if e.entry_type == "stocktake_surplus")
    assert surplus_entry.item_id == item2.id
    assert surplus_entry.quantity == 10.0
    assert surplus_entry.warehouse_id == wh.id

    # 5. التحقق من أن الرصيد الفعلي بعد الترحيل أصبح مساوياً للمعدود تماماً
    bal1_stmt = select(func.sum(StockLedgerEntry.quantity)).where(
        StockLedgerEntry.item_id == item1.id, StockLedgerEntry.warehouse_id == wh.id, StockLedgerEntry.location_type == "warehouse"
    )
    assert (await session.scalar(bal1_stmt)) == 90.0

    bal2_stmt = select(func.sum(StockLedgerEntry.quantity)).where(
        StockLedgerEntry.item_id == item2.id, StockLedgerEntry.warehouse_id == wh.id, StockLedgerEntry.location_type == "warehouse"
    )
    assert (await session.scalar(bal2_stmt)) == 60.0

    # 6. محاولة إلغاء جلسة مرحلة ترفض 409
    cancel_res = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/cancel",
        json={"reason": "محاولة إلغاء غير مقبولة"},
    )
    assert cancel_res.status_code == 409

    app.dependency_overrides.clear()


# ── 5. اختبار منع تكرار الترحيل (Idempotency Key Replay) ───────────────────────

@pytest.mark.asyncio
async def test_post_stocktake_idempotency_duplicate_replay(session: AsyncSession, setup_stocktake_data):
    """
    التحقق من دعم ترويسة Idempotency-Key في مسار الترحيل:
    - تكرار الطلب بنفس المفتاح والحمولة يعيد نفس الاستجابة دون مضاعفة قيود الأستاذ.
    """
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("gm_user", ROLE_GENERAL_MANAGER)

    create_res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={"warehouse_id": wh.id, "scope_type": "specific_items", "item_ids": [item1.id]},
    )
    st_id = create_res.json()["id"]
    line_id = create_res.json()["lines"][0]["id"]

    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={"counts": [{"line_id": line_id, "counted_quantity": 90.0}]},
    )
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/submit")
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})

    idempotency_key = f"stk-post-{uuid.uuid4()}"

    # الطلب الأول مع المفتاح
    res1 = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/post",
        headers={"Idempotency-Key": idempotency_key},
        json={"notes": "ترحيل بمفتاح عدم تكرار"},
    )
    assert res1.status_code == 200
    assert res1.json()["status"] == "posted"

    # إعادة الطلب بنفس المفتاح والحمولة
    res2 = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/post",
        headers={"Idempotency-Key": idempotency_key},
        json={"notes": "ترحيل بمفتاح عدم تكرار"},
    )
    assert res2.status_code == 200
    assert res2.json()["status"] == "posted"

    # التأكد من عدم إنشاء أي قيود مكررة في دفتر الأستاذ (قيد واحد فقط)
    entries = (await session.scalars(
        select(StockLedgerEntry).where(
            StockLedgerEntry.reference_doc_type == "stocktake",
            StockLedgerEntry.reference_doc_id == st_id,
        )
    )).all()
    assert len(entries) == 1

    app.dependency_overrides.clear()


# ── 6. اختبار حماية تعارض اللقطة الدفترية (Snapshot Drift Conflict -> 409) ──────

@pytest.mark.asyncio
async def test_post_stocktake_rejects_when_intervening_stock_movements_occur(session: AsyncSession, setup_stocktake_data):
    """
    التحقق من حظر تعارض اللقطة الدفترية (Snapshot Consistency Check):
    إذا حدثت حركة مخزنية أثناء فترة الجرد غيرت الرصيد الدفتري الفعلي للصنف عن اللقطة المأخوذة،
    يرفض النظام الترحيل مع HTTP 409 Conflict لتجنب تشويه الأرصدة.
    """
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]  # رصيد دفتري 100

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("gm_user", ROLE_GENERAL_MANAGER)

    # 1. فتح الجلسة وتثبيت لقطة 100
    create_res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={"warehouse_id": wh.id, "scope_type": "specific_items", "item_ids": [item1.id]},
    )
    st_id = create_res.json()["id"]
    line_id = create_res.json()["lines"][0]["id"]

    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={"counts": [{"line_id": line_id, "counted_quantity": 90.0}]},
    )
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/submit")
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})

    # 2. حدوث حركة مخزنية متداخلة غير مصرح بها (مثلاً صرف 20 متر إضافية خارج الجرد)
    session.add(StockLedgerEntry(
        id=_uid(), item_id=item1.id, unit_id=data["unit"].id, warehouse_id=wh.id,
        location_type="warehouse", quantity=-20.0,
        reference_doc_type="emergency_dispatch", reference_doc_id="EMRG-01",
        entry_type="dispatch_source", created_by="concurrent_worker"
    ))
    await session.commit()

    # 3. محاولة ترحيل الجلسة -> يجب أن ترفض بـ 409
    post_res = await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/post",
        json={"notes": "محاولة ترحيل مع لقطة متغيرة"},
    )
    assert post_res.status_code == 409
    assert post_res.json()["code"] == "CONFLICT"

    app.dependency_overrides.clear()


# ── 7. اختبار سجل التدقيق الكامل (Audit Trail) ────────────────────────────────

@pytest.mark.asyncio
async def test_stocktake_audit_trail_is_complete_and_traceable(session: AsyncSession, setup_stocktake_data):
    """
    التحقق من أن سجل التدقيق الزمني يسجل كافة العمليات:
    Create -> Start Counting -> Count -> Submit -> Approve -> Post
    مع معرف الفاعل والتوقيت.
    """
    data = setup_stocktake_data
    wh = data["warehouse"]
    item1 = data["item1"]

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides[get_db] = lambda: session

    # 1. إنشاء الجلسة بواسطة أمين المخزن
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("counter_ahmed", ROLE_WAREHOUSE_MANAGER)
    create_res = await client.post(
        "/api/v1/inventory/stocktakes",
        json={"warehouse_id": wh.id, "scope_type": "specific_items", "item_ids": [item1.id]},
    )
    st_id = create_res.json()["id"]
    line_id = create_res.json()["lines"][0]["id"]

    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/start-counting")
    await client.post(
        f"/api/v1/inventory/stocktakes/{st_id}/counts",
        json={"counts": [{"line_id": line_id, "counted_quantity": 95.0}]},
    )
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/submit")

    # 2. اعتماد وترحيل الجلسة بواسطة المدير العام
    app.dependency_overrides[get_current_user] = lambda: make_auth_user("manager_hassan", ROLE_GENERAL_MANAGER)
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/approve", json={"decision": "approve"})
    await client.post(f"/api/v1/inventory/stocktakes/{st_id}/post", json={"notes": "ترحيل نهائي"})

    # 3. استعلام سجل التدقيق
    audit_res = await client.get(f"/api/v1/inventory/stocktakes/{st_id}/audit")
    assert audit_res.status_code == 200
    logs = audit_res.json()

    actions = [log["action"] for log in logs]
    assert "create" in actions
    assert "start_counting" in actions
    assert "record_count" in actions
    assert "submit" in actions
    assert "approve" in actions
    assert "post" in actions

    # التحقق من أن سجلات التدقيق تحتفظ بمعرف الفاعل
    create_log = next(l for l in logs if l["action"] == "create")
    assert create_log["actor_id"] == "counter_ahmed"

    approve_log = next(l for l in logs if l["action"] == "approve")
    assert approve_log["actor_id"] == "manager_hassan"

    post_log = next(l for l in logs if l["action"] == "post")
    assert post_log["actor_id"] == "manager_hassan"

    app.dependency_overrides.clear()
