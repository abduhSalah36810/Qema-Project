# صورة خادم Qema ERP API للإنتاج (سيرفر Google e2-micro)
# البناء من جذر المستودع: docker build -f deploy/api.Dockerfile -t qema-api .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY apps/api/ ./
# الاعتماديات من pyproject.toml نفسه (بدون أدوات الاختبار)
RUN pip install --upgrade pip && pip install . && useradd --create-home --uid 10001 qema
USER qema

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

# عامل واحد يكفي 3 مستخدمين ويناسب ذاكرة e2-micro (1 جيجا)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "1"]
