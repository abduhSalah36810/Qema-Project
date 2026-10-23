"""
نقطة تجميع النماذج المركزية لـ SQLAlchemy وAlembic.
─────────────────────────────────────────────────────────────────────────────
تستورد القاعدة الأساسية Base، وتوفر نقطة الاستيراد الموحدة لنماذج وحدات
العمل (Modular Monolith) لاكتشافها تلقائياً بواسطة Alembic (target_metadata).

حالة النطاق الحالية:
لم تُضف أي جداول أعمال حتى الآن بانتظار اعتماد القرارات المفتوحة في docs/OPEN_DECISIONS_AR.md.
جميع الكيانات المرشحة (الأصناف، وحدات القياس، المخازن، أوامر التشغيل، العملاء، الرواتب)
تتضمن قواعد تشغيلية وحقولاً مرتبطة بقرارات لم تُعتمد من إدارة المصنع بعد.
─────────────────────────────────────────────────────────────────────────────
"""
from app.db.session import Base

# مستقبلاً، عند تنفيذ كل وحدة عمل معتمدة، تُستورد نماذجها هنا ليراها Alembic تلقائياً:
# from app.modules.catalog.models import *    # noqa: F401, F403
# from app.modules.inventory.models import *  # noqa: F401, F403
# from app.modules.production.models import * # noqa: F401, F403
# from app.modules.sales.models import *      # noqa: F401, F403
# from app.modules.payroll.models import *    # noqa: F401, F403

__all__ = ["Base"]
