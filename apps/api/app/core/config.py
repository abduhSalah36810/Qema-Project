"""
إعدادات التطبيق — تُقرأ من متغيرات البيئة أو ملف .env في جذر المستودع.
تتطلب إعدادًا صريحًا لرابط قاعدة البيانات دون الاعتماد على كلمة مرور مدمجة في الكود.
"""
from pathlib import Path
from pydantic import Field, field_validator
from pydantic_core import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

# تحديد مسار ملف .env في جذر المستودع بشكل مطلق ومستقل عن مسار العمل الحالي (CWD)
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_ENV_FILE = REPO_ROOT / ".env"


class Settings(BaseSettings):
    # ─── تعريف عام ───────────────────────────────────────
    app_env: str = "development"
    log_level: str = "info"

    # ─── قاعدة البيانات (مطلوبة صراحة دون قيم افتراضية تحتوي أسراراً) ────
    database_url: str = Field(
        ...,
        description="رابط الاتصال بقاعدة بيانات PostgreSQL. مطلوب صراحة من البيئة أو ملف .env",
    )

    # ─── CORS ────────────────────────────────────────────
    cors_allowed_origins: str | list[str] = Field(
        default="http://localhost:5173",
        description="النطاقات المصرح لها بالاتصال (CORS)",
    )

    model_config = SettingsConfigDict(
        env_file=(str(DEFAULT_ENV_FILE), ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("cors_allowed_origins", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: object) -> list[str]:
        if isinstance(v, str):
            v_clean = v.strip()
            if v_clean.startswith("[") and v_clean.endswith("]"):
                import json
                try:
                    parsed = json.loads(v_clean)
                    if isinstance(parsed, list):
                        return [str(item).strip() for item in parsed if str(item).strip()]
                except Exception:
                    pass
            return [origin.strip() for origin in v_clean.split(",") if origin.strip()]
        elif isinstance(v, (list, tuple)):
            return [str(origin).strip() for origin in v if str(origin).strip()]
        return ["http://localhost:5173"]

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        cleaned = v.strip() if isinstance(v, str) else ""
        if not cleaned:
            raise ValueError("رابط DATABASE_URL لا يمكن أن يكون فارغاً.")
        if not (cleaned.startswith("postgresql+asyncpg://") or cleaned.startswith("postgresql://")):
            raise ValueError(
                "رابط DATABASE_URL غير صالح: يجب أن يبدأ بـ postgresql+asyncpg:// أو postgresql://"
            )
        return cleaned


def load_settings() -> Settings:
    """
    تحميل الإعدادات مع معالجة آمنة للأخطاء:
    تمنع تسريب أي متغيرات بيئة أو قيم أسرار حساسة في مخرجات الخطأ عند فشل التحقق.
    """
    try:
        return Settings()
    except ValidationError as err:
        errors = err.errors()
        missing_fields = [str(e["loc"][0]) for e in errors if e.get("type") == "missing"]
        if "database_url" in missing_fields:
            raise RuntimeError(
                "خطأ في إعدادات الخادم:\n"
                "متغير رابط قاعدة البيانات (DATABASE_URL) مطلوب صراحة ولم يتم العثور عليه في البيئة أو ملف .env.\n"
                "الرجاء إنشاء ملف .env من .env.example وضبط DATABASE_URL محلياً.\n"
                "النظام لا يعتمد على كلمات مرور أو عناوين افتراضية مدمجة في الكود لأسباب أمنية."
            ) from None

        # خطأ في التحقق من صحة أحد الحقول دون طباعة مدخلات المستخدم الحساسة
        field_names = ", ".join(str(e["loc"][0]) for e in errors)
        raise RuntimeError(
            f"خطأ في إعدادات تشغيل الخادم: إعدادات غير صالحة للحقول ({field_names}).\n"
            "الرجاء مراجعة ملف .env والتأكد من مطابقة وصحة القيم المطلوبة."
        ) from None


settings = load_settings()

