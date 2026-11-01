from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.auth import AuthenticatedUser
from app.modules.customers.schemas import CustomerCreate, CustomerOrderRead
from app.modules.production.models import Customer
from app.api.v1.endpoints.customers import create_customer
from app.api.v1.endpoints.customers import _order_payload


@pytest.mark.asyncio
async def test_create_customer_persists_trimmed_directory_record():
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    session = AsyncMock()
    session.execute.return_value = result
    session.add = MagicMock()
    manager = AuthenticatedUser(id="manager-1", email=None, claims={"sub": "manager-1"})

    customer = await create_customer(
        CustomerCreate(code=" C-001 ", name=" مصنع النور ", phone=" 0100 ", city=" القاهرة "),
        manager,
        session,
    )

    assert isinstance(customer, Customer)
    assert customer.code == "C-001"
    assert customer.name == "مصنع النور"
    assert customer.phone == "0100"
    assert customer.city == "القاهرة"
    session.add.assert_called_once_with(customer)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_customer_rejects_duplicate_code():
    result = MagicMock()
    result.scalar_one_or_none.return_value = "existing-customer"
    session = AsyncMock()
    session.execute.return_value = result
    manager = AuthenticatedUser(id="manager-1", email=None, claims={"sub": "manager-1"})

    with pytest.raises(HTTPException) as error:
        await create_customer(CustomerCreate(code="C-001", name="عميل"), manager, session)

    assert error.value.status_code == 409
    session.add.assert_not_called()
    session.commit.assert_not_awaited()


def test_customer_order_account_totals_include_delivery_and_recorded_payments():
    product = SimpleNamespace(name_ar="جلابية")
    variant = SimpleNamespace(numeric_size=58, letter_size="L", season="summer")
    line = SimpleNamespace(
        id="line-1", product_id="product-1", product=product, variant_id="variant-1",
        variant=variant, quantity=Decimal("2"), unit_price=Decimal("100.00"),
        notes="", production_orders=[],
    )
    delivery = SimpleNamespace(
        id="delivery-1", delivery_number="DL-1", delivered_at=datetime.now(timezone.utc),
        received_by="المستلم", notes="", lines=[SimpleNamespace(
            order_line_id="line-1", order_line=line, quantity=Decimal("1"),
        )],
    )
    payment = SimpleNamespace(
        id="payment-1", receipt_number="RC-1", amount=Decimal("50.00"),
        received_at=datetime.now(timezone.utc), method="cash", reference="", notes="", recorded_by="finance-1",
    )
    order = SimpleNamespace(
        id="order-1", order_number="CO-1", order_type="custom_manufacturing", status="partially_delivered",
        order_date=datetime.now(timezone.utc), expected_delivery_at=None,
        discount_amount=Decimal("10.00"), payment_terms="دفعة مقدمة", notes="",
        lines=[line], deliveries=[delivery], payments=[payment],
    )

    result = _order_payload(order)

    assert result["gross_amount"] == Decimal("200.00")
    assert result["total_amount"] == Decimal("190.00")
    assert result["paid_amount"] == Decimal("50.00")
    assert result["balance_amount"] == Decimal("140.00")
    assert result["lines"][0]["delivered_quantity"] == Decimal("1")
    assert result["deliveries"][0]["lines"][0]["product_name"] == "جلابية"
    response = CustomerOrderRead.model_validate(result)
    assert response.order_type == "custom_manufacturing"
