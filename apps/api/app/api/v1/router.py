"""
Router الرئيسي للإصدار v1.
كل وحدة عمل (مخازن، إنتاج، مبيعات...) تُضاف هنا عند التنفيذ.
"""
from fastapi import APIRouter

from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.catalog import router as catalog_router
from app.api.v1.endpoints.customers import router as customers_router
from app.api.v1.endpoints.finance import router as finance_router
from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.inventory import router as inventory_router
from app.api.v1.endpoints.payroll import router as payroll_router
from app.api.v1.endpoints.production import router as production_router
from app.api.v1.endpoints.ready import router as ready_router
from app.api.v1.endpoints.reports import router as reports_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["system"])
api_router.include_router(ready_router, tags=["system"])
api_router.include_router(auth_router, prefix="/auth", tags=["auth"])
api_router.include_router(catalog_router)
api_router.include_router(customers_router)
api_router.include_router(finance_router)
api_router.include_router(inventory_router)
api_router.include_router(production_router)
api_router.include_router(payroll_router)
api_router.include_router(reports_router)
