"""
Vercel Serverless API — Health Check
Returns API health status and configured AI providers.
"""

import json
import os
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        response = {
            "status": "ok",
            "version": "1.0.0",
            "providers": {
                "ollama": bool(os.environ.get("OLLAMA_BASE_URL")),
                "kimi": bool(os.environ.get("KIMI_API_KEY")),
                "minimax": bool(os.environ.get("MINIMAX_API_KEY")),
                "deepgram": bool(os.environ.get("DEEPGRAM_API_KEY")),
            },
            "modal": {
                "configured": bool(os.environ.get("MODAL_OLLAMA_URL")),
                "url": self._mask_url(os.environ.get("MODAL_OLLAMA_URL", "")),
                "model": os.environ.get("MODAL_OLLAMA_MODEL", "llava-llama3"),
            },
        }

        self.wfile.write(json.dumps(response).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _mask_url(self, url: str) -> str:
        if not url:
            return ""
        return url[:50] + "..." if len(url) > 50 else url
