"""
Router الرئيسي للإصدار v1.
كل وحدة عمل (مخازن، إنتاج، مبيعات...) تُضاف هنا عند التنفيذ.
"""
from fastapi import APIRouter

from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.ready import router as ready_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["system"])
api_router.include_router(ready_router, tags=["system"])
api_router.include_router(auth_router, prefix="/auth", tags=["auth"])

# ─── الوحدات المستقبلية (تُفعّل بعد اعتماد قرارات OPEN_DECISIONS_AR.md) ──
# from app.api.v1.endpoints.catalog   import router as catalog_router
# from app.api.v1.endpoints.inventory import router as inventory_router
# from app.api.v1.endpoints.production import router as production_router
# from app.api.v1.endpoints.sales     import router as sales_router
# from app.api.v1.endpoints.payroll   import router as payroll_router
