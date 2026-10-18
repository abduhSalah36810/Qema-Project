"""
إعدادات التطبيق — تُقرأ من متغيرات البيئة أو ملف .env
لا تُضاف قيم حقيقية هنا — استخدم .env المحلي فقط.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # ─── تعريف عام ───────────────────────────────────────
    app_env: str = "development"
    log_level: str = "info"

    # ─── قاعدة البيانات ──────────────────────────────────
    database_url: str = (
        "postgresql+asyncpg://qemma_dev:changeme_local_only@localhost:5432/qemma_erp_dev"
    )

    # ─── CORS ────────────────────────────────────────────
    cors_allowed_origins: list[str] = ["http://localhost:5173"]

    model_config = SettingsConfigDict(
        env_file="../../.env",       # جذر المستودع
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
