"""
إعدادات التطبيق — تُقرأ من متغيرات البيئة أو ملف .env في جذر المستودع.
تتطلب إعدادًا صريحًا لرابط قاعدة البيانات دون الاعتماد على كلمة مرور مدمجة في الكود.
"""
from pathlib import Path
from pydantic import Field, field_validator, model_validator
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
    cors_allowed_origins: list[str] | str = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"],
        description="النطاقات المصرح لها بالاتصال (CORS)",
    )

    # ─── Supabase Auth / JWT (التحقق غير المتماثل عبر JWKS) ───────────
    supabase_url: str | None = Field(
        default=None,
        description="عنوان مشروع Supabase الأساسي",
    )
    supabase_jwks_url: str | None = Field(
        default=None,
        description="رابط مفاتيح JWKS للتحقق من التوقيع غير المتماثل لـ Supabase Auth",
    )
    supabase_jwt_issuer: str | None = Field(
        default=None,
        description="الـ Issuer المتوقع للـ JWT (افتراضياً: <SUPABASE_URL>/auth/v1)",
    )
    supabase_jwt_audience: str = Field(
        default="authenticated",
        description="الـ Audience المتوقع للتوكنات المصادق عليها",
    )

    @property
    def resolved_jwks_url(self) -> str | None:
        """رابط JWKS المحسوب إما مباشرة أو عبر عنوان المشروع."""
        if self.supabase_jwks_url and self.supabase_jwks_url.strip():
            return self.supabase_jwks_url.strip()
        if self.supabase_url and self.supabase_url.strip():
            clean_url = self.supabase_url.strip().rstrip('/')
            return f"{clean_url}/auth/v1/.well-known/jwks.json"
        return None

    @property
    def resolved_jwt_issuer(self) -> str | None:
        """جهة إصدار التوكن (Issuer) المحسوبة إما مباشرة أو عبر عنوان المشروع."""
        if self.supabase_jwt_issuer and self.supabase_jwt_issuer.strip():
            return self.supabase_jwt_issuer.strip()
        if self.supabase_url and self.supabase_url.strip():
            clean_url = self.supabase_url.strip().rstrip('/')
            return f"{clean_url}/auth/v1"
        return None

    model_config = SettingsConfigDict(
        env_file=(str(DEFAULT_ENV_FILE), ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("cors_allowed_origins", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: object) -> list[str]:
        if v is None:
            return ["http://localhost:5173", "http://127.0.0.1:5173"]

        raw_origins: list[str] = []
        if isinstance(v, str):
            v_clean = v.strip()
            if not v_clean:
                return []
            if v_clean.startswith("[") and v_clean.endswith("]"):
                import json
                try:
                    parsed = json.loads(v_clean)
                    if isinstance(parsed, list):
                        raw_origins = [str(item).strip() for item in parsed if str(item).strip()]
                    else:
                        raw_origins = [v_clean]
                except Exception:
                    raw_origins = [origin.strip() for origin in v_clean.split(",") if origin.strip()]
            else:
                raw_origins = [origin.strip() for origin in v_clean.split(",") if origin.strip()]
        elif isinstance(v, (list, tuple, set)):
            raw_origins = [str(origin).strip() for origin in v if str(origin).strip()]
        else:
            raw_origins = [str(v).strip()]

        cleaned_origins: list[str] = []
        for raw in raw_origins:
            origin = raw.rstrip("/")
            if not origin:
                continue
            if origin == "*" or origin.lower() == "null":
                raise ValueError(
                    "استخدام النطاق العام '*' أو 'null' غير مسموح به مع تفعيل المصادقة والاعتمادات (credentials)."
                )
            if not (origin.startswith("http://") or origin.startswith("https://")):
                raise ValueError(
                    f"النطاق '{origin}' غير صالح: يجب أن يبدأ ببروتوكول صريح (http:// أو https://)."
                )
            cleaned_origins.append(origin)

        return cleaned_origins

    @model_validator(mode="after")
    def validate_production_cors_origins(self) -> "Settings":
        if self.app_env.lower() == "production":
            if not self.cors_allowed_origins:
                raise ValueError(
                    "يجب تحديد CORS_ALLOWED_ORIGINS صراحة وبشكل آمن في بيئة الإنتاج."
                )
            for origin in self.cors_allowed_origins:
                lower = origin.lower()
                if "localhost" in lower or "127.0.0.1" in lower:
                    raise ValueError(
                        f"النطاق '{origin}' غير مسموح به في بيئة الإنتاج (app_env=production)."
                    )
        return self

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

        # خطأ في إعدادات CORS
        cors_errors = [e for e in errors if "cors_allowed_origins" in [str(loc) for loc in e.get("loc", ())]]
        if cors_errors:
            msg = cors_errors[0].get("msg", "")
            raise RuntimeError(
                f"خطأ في إعدادات تشغيل الخادم (CORS_ALLOWED_ORIGINS):\n{msg}\n"
                "الرجاء مراجعة ملف .env وضبط النطاقات المسموحة بشكل صريح وآمن."
            ) from None

        # خطأ في التحقق من صحة أحد الحقول دون طباعة مدخلات المستخدم الحساسة
        field_names = ", ".join(str(e["loc"][0]) for e in errors)
        raise RuntimeError(
            f"خطأ في إعدادات تشغيل الخادم: إعدادات غير صالحة للحقول ({field_names}).\n"
            "الرجاء مراجعة ملف .env والتأكد من مطابقة وصحة القيم المطلوبة."
        ) from None


settings = load_settings()

