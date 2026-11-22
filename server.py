"""Serve Equity Desk and its read-only OpenBB endpoints on loopback."""

import argparse
import json
import re
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import parse_qs, urlsplit

from backend.openbb_data import get_section, installed_providers, search


PUBLIC = Path(__file__).resolve().parent / "public"
SYMBOL = re.compile(r"(?:[A-Z0-9][A-Z0-9.\-]{0,19}:)?[A-Z0-9][A-Z0-9.\-]{0,19}")  # matches public/app.js
SECTIONS = frozenset((
    "quote profile history income balance cash ratios news earnings dividends splits "
    "estimates peers filings holders segments transcripts earnings_calendar targets "
    "metrics insiders benchmark revenue_estimates recommendations"
).split())
RANGES = frozenset("1D 5D 1M 3M 6M YTD 1Y 3Y 5Y 10Y MAX".split())


class ResearchHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        if not self.path.startswith("/api/"):
            # Revalidate the page's files (cheap 304s) so an updated app.js or style.css is never stale.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    STATIC_FILES = frozenset({"/", "/index.html", "/style.css", "/app.js", "/detail.js",
                              "/vendor/lightweight-charts-5.2.1.js", "/vendor/lightweight-charts-LICENSE.txt"})

    def host_allowed(self):
        """Reject other Host names so a DNS-rebinding page cannot read this loopback server."""
        port = self.server.server_port
        if self.headers.get("Host", "").lower() in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return True
        self.send_error(HTTPStatus.MISDIRECTED_REQUEST)
        return False

    def do_HEAD(self):
        # Same Host check and file list as GET; the API answers GET only.
        if not self.host_allowed():
            return
        path = urlsplit(self.path).path
        if path not in self.STATIC_FILES:
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED if path.startswith("/api/") else HTTPStatus.NOT_FOUND)
            return
        return super().do_HEAD()

    def do_GET(self):
        if not self.host_allowed():
            return
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            if url.path not in self.STATIC_FILES:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            return super().do_GET()
        args = parse_qs(url.query)

        def argument(name, default=""):
            return args.get(name, [default])[0].strip()

        try:
            if url.path == "/api/search":
                query = argument("q")
                if not 1 <= len(query) <= 80:
                    return self.send_json({"error": "Enter a ticker or company name."}, HTTPStatus.BAD_REQUEST)
                payload = search(query)
            elif url.path == "/api/section":
                symbol = argument("symbol").upper()
                section = argument("section")
                period = argument("period", "annual")
                chart_range = argument("range", "1Y").upper()
                if not SYMBOL.fullmatch(symbol) or section not in SECTIONS:
                    return self.send_json({"error": "Invalid ticker or data section."}, HTTPStatus.BAD_REQUEST)
                if period not in {"annual", "quarter"} or chart_range not in RANGES:
                    return self.send_json({"error": "Invalid period or chart range."}, HTTPStatus.BAD_REQUEST)
                provider_section = "history" if section == "benchmark" else section
                provider_symbol = "SPY" if section == "benchmark" else symbol
                options = {"period": period, "range": chart_range, "refresh": argument("refresh") == "1"}
                if provider_section in {"income", "balance", "cash", "ratios"}:
                    options["limit"] = 100
                payload = get_section(provider_symbol, provider_section, **options)
            elif url.path == "/api/health":
                payload = {"status": "ok", "data_interface": "OpenBB", "providers": installed_providers()}
            else:
                return self.send_json({"error": "Endpoint not found."}, HTTPStatus.NOT_FOUND)
            return self.send_json(payload)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            self.log_error("Data request failed (%s)", type(exc).__name__)
            return self.send_json(
                {"data": [], "error": "OpenBB could not complete this request."},
                HTTPStatus.BAD_GATEWAY,
            )

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open the dashboard in your browser.")
    args = parser.parse_args()
    handler = partial(ResearchHandler, directory=str(PUBLIC))
    host = "127.0.0.1"
    try:
        server = ThreadingHTTPServer((host, args.port), handler)
    except OSError:
        if not args.open:
            raise
        existing = f"http://{host}:{args.port}"
        with urlopen(existing + "/api/health", timeout=3) as response:
            health = json.load(response)
            if not isinstance(health, dict) or health.get("status") != "ok" or health.get("data_interface") != "OpenBB":
                raise RuntimeError("The selected port is being used by another application.")
        webbrowser.open(existing)
        return
    with server:
        url = f"http://127.0.0.1:{server.server_port}"
        print(f"Equity Desk: {url}", flush=True)
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
