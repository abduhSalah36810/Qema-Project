"""
إعدادات بيئة الاختبارات الآلية (Pytest Fixtures).
─────────────────────────────────────────────────────────────────────────────
تضمن ضبط المتغيرات الأساسية المطلوبة للاختبارات الآلية دون الاعتماد على وجود
ملف .env محلي، مما يتيح تشغيل suite الاختبارات في أي بيئة معزولة بنجاح.
─────────────────────────────────────────────────────────────────────────────
"""
import os

# ضبط قيم اختبارية آمنة في بيئة الاختبار إذا لم تكن محددة مسبقاً
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://qemma_test:test_only_password@localhost:5432/qemma_test_db",
)
os.environ.setdefault("APP_ENV", "testing")
os.environ.setdefault("LOG_LEVEL", "warning")
