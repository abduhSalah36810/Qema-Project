import sys
from pathlib import Path

# Add apps/api to sys.path so app.* modules import seamlessly
current_dir = Path(__file__).resolve().parent
repo_root = current_dir.parent
api_dir = repo_root / "apps" / "api"

for p in (str(api_dir), str(repo_root)):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.main import app

@app.middleware("http")
async def log_path(request, call_next):
    response = await call_next(request)
    response.headers["X-Debug-Path"] = request.url.path
    return response

