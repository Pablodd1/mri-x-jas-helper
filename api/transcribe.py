"""
Vercel Serverless API — Voice Transcription
Transcribes clinical dictation using Deepgram Nova 2 Medical.
"""

import json
import os
from http.server import BaseHTTPRequestHandler
import httpx


def parse_multipart(body: bytes, content_type: str) -> dict:
    result = {}
    boundary = (
        content_type.split("boundary=")[1] if "boundary=" in content_type else None
    )
    if not boundary:
        return result
    boundary_bytes = f"--{boundary}".encode()
    parts = body.split(boundary_bytes)
    for part in parts[1:]:
        if part.startswith(b"--"):
            break
        if b"\r\n\r\n" in part:
            headers, data = part.split(b"\r\n\r\n", 1)
            data = data.rstrip(b"\r\n")
            headers_str = headers.decode("utf-8", errors="ignore")
            name_match = None
            for line in headers_str.split("\r\n"):
                if 'name="' in line:
                    name_match = line.split('name="')[1].split('"')[0]
                    break
            if name_match:
                if 'filename="' in headers_str:
                    filename = headers_str.split('filename="')[1].split('"')[0]
                    result[name_match] = {"filename": filename, "data": data}
                else:
                    result[name_match] = data.decode("utf-8", errors="ignore")
    return result


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            content_type = self.headers.get("Content-Type", "")
            body = self.rfile.read(content_length)

            fields = parse_multipart(body, content_type)

            audio_field = fields.get("audio")
            if not audio_field or not isinstance(audio_field, dict):
                self.send_error_response(400, {"error": "No audio uploaded"})
                return

            audio_bytes = audio_field["data"]
            filename = audio_field.get("filename", "audio.webm")
            mimetype = "audio/webm"
            if filename.endswith(".mp3"):
                mimetype = "audio/mp3"
            elif filename.endswith(".wav"):
                mimetype = "audio/wav"

            deepgram_key = os.environ.get("DEEPGRAM_API_KEY", "")
            if not deepgram_key:
                self.send_error_response(
                    500, {"error": "DEEPGRAM_API_KEY not configured"}
                )
                return

            url = "https://api.deepgram.com/v1/listen"
            headers = {"Authorization": f"Token {deepgram_key}"}
            params = {
                "model": "nova-2-medical",
                "smart_format": "true",
                "punctuate": "true",
                "language": "en-US",
            }

            with httpx.Client(timeout=60.0) as client:
                files = {"file": (filename, audio_bytes, mimetype)}
                response = client.post(url, files=files, headers=headers, params=params)
                response.raise_for_status()
                data = response.json()
                transcript = data["results"]["channels"][0]["alternatives"][0][
                    "transcript"
                ]

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "transcript": transcript,
                        "provider": "deepgram",
                        "model": "nova-2-medical",
                        "success": True,
                    }
                ).encode("utf-8")
            )

        except Exception as e:
            self.send_error_response(500, {"error": str(e)})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_error_response(self, status: int, body: dict):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))
