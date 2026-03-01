"""
SEESOUND — Phase 1 Backend Skeleton: server.py
═══════════════════════════════════════════════════════════════════════════════

This stripped-down FastAPI server is the Phase 1 backend for the hybrid
architecture. Its responsibilities are intentionally minimal:

  • WebSocket /ws        — Accept frontend connections; send structural rule
                           sets and receive parameter updates. No real-time
                           FFT processing occurs here.

  • POST /api/upload     — Stub endpoint. Accepts an audio file and returns a
                           job ID. In Phase 2 this will trigger AI stem
                           separation and harmonic pre-processing.

  • GET  /api/presets    — Serve the JSON preset files from the presets/ dir.

  • GET  /api/presets/{name} — Serve a single preset.

  • Static file serving  — Serves the built frontend (frontend/dist/) when
                           running in production. In development, Vite's own
                           dev server is used instead.

What was REMOVED compared to main.py:
  ✗  Real-time, frame-by-frame FFT streaming (audio_analyzer.analyze_file)
  ✗  ThreadPoolExecutor analysis pipeline
  ✗  Per-frame WebSocket broadcasting
  ✗  In-memory frame store (_jobs, _session_params, _job_subscribers)

Run with:
  uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


class PresetBody(BaseModel):
    name: str
    params: dict[str, Any] = Field(default_factory=dict)
    mappingGroups: list[Any] = Field(default_factory=list)

# ─────────────────────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────────────────────

ROOT_DIR    = Path(__file__).parent.parent          # …/SEESOUND/
PRESETS_DIR = ROOT_DIR / "presets"
DIST_DIR    = ROOT_DIR / "frontend" / "dist"        # built frontend (Vite output)
UPLOADS_DIR = ROOT_DIR / "uploads"                  # temp storage for uploaded audio
UPLOADS_DIR.mkdir(exist_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="SEESOUND Backend — Phase 1",
    version="1.0.0",
    description="WebSocket routing, preset serving, and upload stub. "
                "Real-time FFT is handled entirely by the browser (Web Audio API).",
)

# ── CORS — allow the Vite dev server origins ──────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:5175", "http://127.0.0.1:5175",
        "http://localhost:8000", "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# § 1  Connection Manager
# ─────────────────────────────────────────────────────────────────────────────

class ConnectionManager:
    """Tracks active WebSocket connections and provides broadcast helpers."""

    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)
        print(f"[WS]  connected   — total: {len(self.active)}")

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)
        print(f"[WS]  disconnected — total: {len(self.active)}")

    async def send(self, ws: WebSocket, payload: dict) -> None:
        """Send a JSON payload to a single client."""
        try:
            await ws.send_text(json.dumps(payload))
        except Exception as exc:
            print(f"[WS]  send error: {exc}")

    async def broadcast(self, payload: dict) -> None:
        """Broadcast a JSON payload to all connected clients."""
        text = json.dumps(payload)
        for conn in list(self.active):
            try:
                await conn.send_text(text)
            except Exception:
                pass


manager = ConnectionManager()


# ─────────────────────────────────────────────────────────────────────────────
# § 2  DEFAULT RULE SET
# ─────────────────────────────────────────────────────────────────────────────

# This is the baseline ruleset sent to every client on connect.
# In Phase 2 these values are computed from uploaded audio (harmonic analysis,
# stem separation results, etc.) and updated over the WebSocket in real-time.
DEFAULT_RULES: dict = {
    "visualMode":     0,             # 0 = particle sphere (Phase 1 placeholder)
    "colorPalette":   [             # RGB triples, 0-255
        [255, 255, 255],
        [100, 180, 255],
        [255, 120,  50],
    ],
    "bassMultiplier":  1.0,
    "midMultiplier":   1.0,
    "highMultiplier":  1.0,
    "harmonicRatios":  [],          # populated after audio pre-processing
    "stemGains":       {},          # populated after AI stem separation
}


# ─────────────────────────────────────────────────────────────────────────────
# § 3  WEBSOCKET ENDPOINT  /ws
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """
    Main WebSocket handler.

    On connect  → send the current default rule set so the frontend can
                  start rendering immediately, even before any audio upload.

    On message  → handle client→server commands:
                    { "type": "load_preset", "name": "..." }
                    { "type": "params_update", "payload": { ... } }
                    { "type": "pong" }
    """
    await manager.connect(ws)

    # Send initial rules immediately
    await manager.send(ws, {"type": "rules", "payload": DEFAULT_RULES})

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send(ws, {"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = msg.get("type", "")

            # ── Load a preset ─────────────────────────────────────────────
            if msg_type == "load_preset":
                name    = msg.get("name", "")
                preset  = _load_preset(name)
                if preset is None:
                    await manager.send(ws, {
                        "type":    "error",
                        "message": f"Preset '{name}' not found",
                    })
                else:
                    await manager.send(ws, {
                        "type":    "preset_loaded",
                        "payload": {"name": name, "rules": preset},
                    })

            # ── Parameter update from the UI ──────────────────────────────
            elif msg_type == "params_update":
                # TODO Phase 2: persist per-connection params and feed into
                # the pre-processing pipeline. For now, echo back as rules.
                payload = msg.get("payload", {})
                await manager.send(ws, {"type": "rules", "payload": payload})

            # ── Keepalive pong ────────────────────────────────────────────
            elif msg_type == "pong":
                pass  # nothing to do

            else:
                print(f"[WS]  unknown message type: '{msg_type}'")

    except WebSocketDisconnect:
        manager.disconnect(ws)


# ─────────────────────────────────────────────────────────────────────────────
# § 4  REST ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    """
    STUB — Phase 1.

    Accepts an audio file, saves it to disk, and returns a job ID.

    Phase 2 will extend this to:
      • Run AI stem separation (e.g. Demucs) in a background task
      • Compute harmonic relationships (key, chord progression)
      • Push updated rule sets to connected WebSocket clients via manager.broadcast()
    """
    if not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="File must be an audio type.")

    job_id  = uuid.uuid4().hex
    suffix  = Path(file.filename).suffix or ".audio"
    dest    = UPLOADS_DIR / f"{job_id}{suffix}"

    contents = await file.read()
    dest.write_bytes(contents)

    print(f"[UPLOAD] job={job_id}  file={file.filename}  size={len(contents):,} bytes")

    return JSONResponse({
        "job_id":   job_id,
        "filename": file.filename,
        "size":     len(contents),
        "status":   "queued",   # will become "processing" / "done" in Phase 2
        "message":  "Upload received. Deep analysis will be added in Phase 2.",
    })


@app.get("/api/presets")
async def list_presets():
    """Return a list of available preset names."""
    names = [p.stem for p in sorted(PRESETS_DIR.glob("*.json"))]
    return {"presets": names}


@app.get("/api/presets/{name}")
async def get_preset(name: str):
    """Return a single preset by name (without the .json extension)."""
    preset = _load_preset(name)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"Preset '{name}' not found.")
    return preset


@app.post("/api/presets")
async def save_preset(body: PresetBody):
    """Save (create or overwrite) a preset JSON file."""
    safe = re.sub(r'[^\w\s\-]', '', body.name).strip()
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid preset name.")
    path = PRESETS_DIR / f"{safe}.json"
    data = {
        "name": safe,
        "params": body.params,
        "mappingGroups": body.mappingGroups,
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"[PRESETS] Saved preset: {safe}")
    return {"saved": safe}


@app.delete("/api/presets/{name}")
async def delete_preset(name: str):
    """Delete a preset by name."""
    path = PRESETS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Preset '{name}' not found.")
    path.unlink()
    print(f"[PRESETS] Deleted preset: {name}")
    return {"deleted": name}


@app.get("/api/health")
async def health():
    """Simple liveness check."""
    return {"status": "ok", "phase": 1}


# ─────────────────────────────────────────────────────────────────────────────
# § 5  PRESET HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_preset(name: str) -> dict | None:
    """
    Load a preset JSON file from the presets/ directory.
    Returns None if the file does not exist.
    """
    path = PRESETS_DIR / f"{name}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[PRESETS] Failed to read '{path}': {exc}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# § 6  STATIC FILE SERVING (production mode)
# ─────────────────────────────────────────────────────────────────────────────
# Mount only if the Vite build output exists.
# In development, Vite's own HMR server (port 5173) takes over this role.

if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
    print(f"[STATIC] Serving built frontend from {DIST_DIR}")
else:
    print("[STATIC] No dist/ found — run `pnpm build` or use the Vite dev server on :5173")


# ─────────────────────────────────────────────────────────────────────────────
# § 7  ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
