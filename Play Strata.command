#!/usr/bin/env python3
"""Serve Strata on this Mac and open it in the default browser."""
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

root = Path(__file__).resolve().parent / "dist"
port = int(os.environ.get("STRATA_PORT", 8741))
url = f"http://127.0.0.1:{port}/"
handler = partial(SimpleHTTPRequestHandler, directory=str(root))

try:
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
except OSError:
    try:
        with urlopen(url, timeout=2) as response:
            existing_game = b"<title>Strata " in response.read(2000)
    except (OSError, URLError):
        existing_game = False
    if existing_game:
        print(f"Strata is already running at {url}")
        webbrowser.open(url)
    else:
        print(f"Port {port} is unavailable. Set STRATA_PORT to choose another port.")
        raise SystemExit(1)
else:
    print(f"Strata is running at {url}\nKeep this window open while playing. Press Control-C to quit.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
