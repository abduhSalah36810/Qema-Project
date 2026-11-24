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

class VercelPathPreserver:
    def __init__(self, asgi_app):
        self.asgi_app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            # Extract headers for diagnostics & path resolution
            headers = dict(scope.get("headers", []))
            # Convert header keys to lower-case string
            str_headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in headers.items()}
            
            # Check if Vercel passed the original path in a header
            original_path = (
                str_headers.get("x-matched-path")
                or str_headers.get("x-vercel-matched-path")
                or str_headers.get("x-forwarded-url")
                or str_headers.get("x-original-url")
                or str_headers.get("x-real-path")
            )
            
            if original_path and scope.get("path") == "/api/index.py":
                # If original_path has query parameters, strip them for scope['path']
                if "?" in original_path:
                    path_part, query_part = original_path.split("?", 1)
                    scope["path"] = path_part
                    scope["raw_path"] = path_part.encode("latin1")
                    if not scope.get("query_string"):
                        scope["query_string"] = query_part.encode("latin1")
                else:
                    scope["path"] = original_path
                    scope["raw_path"] = original_path.encode("latin1")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                # Add diagnostics headers
                hdrs = list(message.get("headers", []))
                hdrs.append((b"x-scope-path", str(scope.get("path", "")).encode("latin1")))
                # Expose safe headers for inspection
                safe_hdrs = [f"{k}={v}" for k, v in str_headers.items() if not any(s in k for s in ("auth", "key", "cookie", "token", "secret"))]
                hdrs.append((b"x-seen-headers", "; ".join(safe_hdrs[:8]).encode("latin1")))
                message["headers"] = hdrs
            await send(message)

        return await self.asgi_app(scope, receive, send_wrapper)

# Wrap app with the path preserver
app = VercelPathPreserver(app)
