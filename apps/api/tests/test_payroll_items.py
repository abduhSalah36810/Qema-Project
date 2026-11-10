"""
الرواتب: نظام أجر شهري ويومية، وبنود حوافز وخصومات صريحة لكل فترة.
"""
from datetime import datetime, timedelta, timezone
import io
import uuid
import zipfile

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser, get_current_user
from app.db.session import get_db
from app.main import app

API = "/api/v1/payroll"


def _user(uid: str, role: str) -> AuthenticatedUser:
    return AuthenticatedUser(id=uid, email=f"{uid}@qema-test.local", claims={"app_metadata": {"role": role}})


class Actor:
    def __init__(self, client, user):
        self.client, self.user = client, user

    async def call(self, method, url, **kw):
        app.dependency_overrides[get_current_user] = lambda: self.user
        return await self.client.request(method, url, **kw)


@pytest.fixture
async def ctx(session: AsyncSession):
    app.dependency_overrides[get_db] = lambda: session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    tag = uuid.uuid4().hex[:6]
    yield {
        "fm": Actor(client, _user(f"pi-fm-{tag}", "finance_manager")),
        "wh": Actor(client, _user(f"pi-wh-{tag}", "warehouse_manager")),
    }
    await client.aclose()
    app.dependency_overrides.clear()


async def _employee(a, **body):
    tag = uuid.uuid4().hex[:6]
    res = await a.call("POST", f"{API}/employees", json={"code": f"PI-{tag}", "name": f"عامل {tag}", **body})
    assert res.status_code == 201, res.text
    return res.json()


async def _period(a, employee_ids):
    tag = uuid.uuid4().hex[:6]
    start = datetime(2400, 1, 1, tzinfo=timezone.utc) + timedelta(days=int(uuid.uuid4().int % 300000))
    res = await a.call("POST", f"{API}/periods", json={
        "period_name": f"فترة {tag}", "start_date": start.isoformat(), "end_date": (start + timedelta(hours=20)).isoformat(),
    })
    assert res.status_code == 201, res.text
    period_id = res.json()["id"]
    res = await a.call("POST", f"{API}/periods/{period_id}/calculate", json={"employee_ids": employee_ids})
    assert res.status_code == 200, res.text
    return period_id, res.json()


def _run(detail, employee_id):
    return next(r for r in detail["runs"] if r["employee_id"] == employee_id)


@pytest.mark.asyncio
async def test_employee_pay_types_are_saved_and_validated(ctx):
    fm = ctx["fm"]
    monthly = await _employee(fm, pay_type="monthly", base_salary=6000)
    assert (monthly["pay_type"], monthly["base_salary"], monthly["daily_rate"]) == ("monthly", 6000, None)
    daily = await _employee(fm, pay_type="daily", daily_rate=300)
    assert (daily["pay_type"], daily["daily_rate"]) == ("daily", 300)
    res = await fm.call("POST", f"{API}/employees", json={"code": f"PI-{uuid.uuid4().hex[:6]}", "name": "بلا أجر", "pay_type": "daily"})
    assert res.status_code == 422
    res = await ctx["wh"].call("POST", f"{API}/employees", json={"code": "X", "name": "X", "base_salary": 1})
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_monthly_sheet_items_and_net(ctx):
    fm = ctx["fm"]
    emp = await _employee(fm, pay_type="monthly", base_salary=6000)
    period_id, detail = await _period(fm, [emp["id"]])
    run = _run(detail, emp["id"])
    # لا بنود ولا خصومات تلقائية
    assert run["items"] == [] and run["net_amount"] == 6000 and len(detail["runs"]) == 1

    url = f"{API}/periods/{period_id}/runs/{run['id']}/items"
    for body in (
        {"category": "incentive_percent", "calc_method": "percent", "value": "10"},
        {"category": "absence_unpermitted", "calc_method": "quantity", "quantity": "1", "value": "300"},
        {"category": "late_hours", "calc_method": "quantity", "quantity": "2", "value": "50"},
        {"category": "penalty", "calc_method": "fixed", "value": "200", "notes": "إتلاف خامة"},
    ):
        res = await fm.call("POST", url, json=body)
        assert res.status_code == 201, res.text
    run = _run(res.json(), emp["id"])
    amounts = {i["category"]: i["amount"] for i in run["items"]}
    assert amounts == {"incentive_percent": 600, "absence_unpermitted": 300, "late_hours": 100, "penalty": 200}
    assert run["gross_amount"] == 6600 and run["total_deductions"] == 600 and run["net_amount"] == 6000
    assert res.json()["category_totals"]["late_hours"] == 100

    # طريقة غير مناسبة للبند، وبند آخر بلا اسم
    assert (await fm.call("POST", url, json={"category": "incentive_fixed", "calc_method": "percent", "value": "5"})).status_code == 422
    assert (await fm.call("POST", url, json={"category": "other_deduction", "calc_method": "fixed", "value": "5"})).status_code == 422
    # الخصم لا يتجاوز المستحقات
    res = await fm.call("POST", url, json={"category": "penalty", "calc_method": "fixed", "value": "99999"})
    assert res.status_code == 422

    # حذف بند يعيد الحساب
    penalty = next(i for i in run["items"] if i["category"] == "penalty")
    res = await fm.call("DELETE", f"{url}/{penalty['id']}")
    assert res.status_code == 200
    assert _run(res.json(), emp["id"])["net_amount"] == 6200


@pytest.mark.asyncio
async def test_daily_wage_uses_entered_work_days_and_percent_follows_base(ctx):
    fm = ctx["fm"]
    emp = await _employee(fm, pay_type="daily", daily_rate=250)
    period_id, detail = await _period(fm, [emp["id"]])
    run = _run(detail, emp["id"])
    assert run["pay_type"] == "daily" and run["base_amount"] == 0 and run["work_days"] is None

    items_url = f"{API}/periods/{period_id}/runs/{run['id']}/items"
    assert (await fm.call("POST", items_url, json={"category": "incentive_percent", "calc_method": "percent", "value": "10"})).status_code == 422

    res = await fm.call("PATCH", f"{API}/periods/{period_id}/runs/{run['id']}/work-days", json={"work_days": "20"})
    assert res.status_code == 200, res.text
    assert _run(res.json(), emp["id"])["base_amount"] == 5000
    res = await fm.call("POST", items_url, json={"category": "incentive_percent", "calc_method": "percent", "value": "10"})
    assert _run(res.json(), emp["id"])["net_amount"] == 5500

    # تعديل الأيام يعيد حساب الأساسي وبند النسبة عليه
    res = await fm.call("PATCH", f"{API}/periods/{period_id}/runs/{run['id']}/work-days", json={"work_days": "22"})
    run = _run(res.json(), emp["id"])
    assert run["base_amount"] == 5500 and run["items"][0]["amount"] == 550 and run["net_amount"] == 6050


@pytest.mark.asyncio
async def test_employee_edit_does_not_change_prepared_snapshot_name_and_rate(ctx):
    fm = ctx["fm"]
    emp = await _employee(fm, pay_type="monthly", base_salary=4000)
    period_id, detail = await _period(fm, [emp["id"]])
    res = await fm.call("PATCH", f"{API}/employees/{emp['id']}", json={"base_salary": 9000, "name": "اسم جديد"})
    assert res.status_code == 200
    run = _run((await fm.call("GET", f"{API}/periods/{period_id}/runs")).json(), emp["id"])
    assert run["rate_amount"] == 4000 and run["net_amount"] == 4000 and run["employee_name"] == emp["name"]


@pytest.mark.asyncio
async def test_selected_employees_only_and_excel_export(ctx):
    fm = ctx["fm"]
    a = await _employee(fm, pay_type="monthly", base_salary=3000)
    b = await _employee(fm, pay_type="daily", daily_rate=200)
    period_id, detail = await _period(fm, [a["id"], b["id"]])
    assert {r["employee_id"] for r in detail["runs"]} == {a["id"], b["id"]}
    res = await fm.call("POST", f"{API}/periods/{period_id}/calculate", json={"employee_ids": [a["id"]]})
    assert {r["employee_id"] for r in res.json()["runs"]} == {a["id"]}

    res = await fm.call("GET", f"{API}/periods/{period_id}/export.xlsx")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/vnd.openxmlformats")
    with zipfile.ZipFile(io.BytesIO(res.content)) as z:
        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
        assert 'rightToLeft="1"' in sheet and a["name"] in sheet
