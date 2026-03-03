"""
SEESOUND — Backend API  (Phase 2)
===================================
FastAPI server providing:
  • POST /api/upload              — accept an audio file, analyse it, store results
  • GET  /api/analysis/{job_id}   — retrieve all frames for a job
  • WS   /ws                      — real-time WebSocket: stream analysis frames &
                                    receive parameter updates
"""

from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from models import AnalysisParams
from audio_analyzer import analyze_file, UNSUPPORTED_AUDIO_EXTS, ffmpeg_to_wav

# ---------------------------------------------------------------------------
# Presets directory  (SEESOUND root / presets/)
# ---------------------------------------------------------------------------

PRESETS_DIR = Path(__file__).parent.parent / "presets"
COLOR_PRESETS_DIR = PRESETS_DIR / "colors"


class PresetBody(BaseModel):
    name: str
    params: dict
    disabledKeys: list = []
    mappingGroups: list = []
    canvasW: int | None = None
    canvasH: int | None = None

# ---------------------------------------------------------------------------
# App bootstrap
# ---------------------------------------------------------------------------

app = FastAPI(
    title="SEESOUND API",
    version="0.2.0",
    description="Audio-to-visual generation backend — FFT analysis engine",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:5175", "http://127.0.0.1:5175",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Thread pool for blocking analysis work
_executor = ThreadPoolExecutor(max_workers=4)

# In-memory job store  { job_id: {"params": dict, "frames": [dict], "status": str} }
_jobs: dict[str, dict] = {}

# Per-connection session params  { ws_id: AnalysisParams }
_session_params: dict[int, AnalysisParams] = {}

# Live subscribers per job: { job_id: set[WebSocket] }
# Registered when client subscribes to an in-progress job
_job_subscribers: dict[str, set] = {}

# Current playback position per job reported by the frontend (seconds).
# -1 means the user has not started playback yet — analysis runs freely.
_job_playback_time: dict[str, float] = {}

# Max seconds of analysis ahead of the current playback position.
LOOKAHEAD_S: float = 60.0

# ---------------------------------------------------------------------------
# Connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"[WS]  connected  — total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        _session_params.pop(id(websocket), None)
        # Remove from any live job subscriptions
        for subs in _job_subscribers.values():
            subs.discard(websocket)
        print(f"[WS]  disconnected — total: {len(self.active_connections)}")

    async def send(self, websocket: WebSocket, payload: dict):
        await websocket.send_text(json.dumps(payload))

    async def broadcast(self, payload: dict):
        for conn in list(self.active_connections):
            try:
                await conn.send_text(json.dumps(payload))
            except Exception:
                pass


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Background analysis helpers
# ---------------------------------------------------------------------------

_SENTINEL = object()  # unique marker for end-of-generator


async def _iter_in_executor(loop: asyncio.AbstractEventLoop, gen_factory):
    """Wrap a synchronous generator so it can be awaited without blocking the event loop.
    Exceptions raised inside the generator are propagated to the caller."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=128)

    def _produce():
        exc_caught = None
        try:
            for item in gen_factory():
                asyncio.run_coroutine_threadsafe(queue.put((_SENTINEL, item)), loop).result()
        except Exception as e:
            exc_caught = e
        finally:
            asyncio.run_coroutine_threadsafe(queue.put((None, exc_caught)), loop).result()

    loop.run_in_executor(_executor, _produce)

    while True:
        sentinel, value = await queue.get()
        if sentinel is None:
            # End of generator — value holds any exception
            if value is not None:
                raise value
            break
        yield value


async def _run_analysis_job(
    job_id: str,
    audio_path: Path,
    params: AnalysisParams,
    websocket: WebSocket | None = None,
) -> None:
    """Run analysis in a thread pool, stream frames over WebSocket, store in _jobs."""

    # ------------------------------------------------------------------
    # Pre-convert formats that libsndfile cannot read (M4A, AAC, WMA …)
    # so that analyze_file always receives a file it can stream.
    # ------------------------------------------------------------------
    _converted_path: Path | None = None
    if audio_path.suffix.lower() in UNSUPPORTED_AUDIO_EXTS:
        print(f"[job {job_id[:8]}] Converting '{audio_path.suffix}' to WAV …")
        try:
            _converted_path = await asyncio.get_event_loop().run_in_executor(
                _executor, ffmpeg_to_wav, audio_path
            )
            analysis_path = _converted_path
        except Exception as conv_err:
            _jobs[job_id]["status"] = f"error: {conv_err}"
            print(f"[job {job_id[:8]}] Conversion failed: {conv_err}")
            if websocket is not None:
                try:
                    await manager.send(websocket,
                        {"type": "error", "job_id": job_id, "message": str(conv_err)})
                except Exception:
                    pass
            audio_path.unlink(missing_ok=True)
            return
    else:
        analysis_path = audio_path

    _job_playback_time[job_id] = -1.0   # sentinel: playback not started yet

    def _blocking_gen():
        for frame in analyze_file(analysis_path, params):
            yield frame.model_dump()

    _jobs[job_id]["status"] = "running"
    loop = asyncio.get_event_loop()
    print(f"[job {job_id[:8]}] Starting analysis of {audio_path.name}")

    async def _send_to_all(payload: dict) -> None:
        """Send to the triggering websocket and all subscribers."""
        if websocket is not None:
            try:
                await manager.send(websocket, payload)
            except Exception:
                pass
        for sub_ws in list(_job_subscribers.get(job_id, [])):
            try:
                await manager.send(sub_ws, payload)
            except Exception:
                _job_subscribers[job_id].discard(sub_ws)

    try:
        async for frame_dict in _iter_in_executor(loop, _blocking_gen):
            _jobs[job_id]["frames"].append(frame_dict)
            msg = {"type": "frame", "job_id": job_id, "payload": frame_dict}
            await _send_to_all(msg)

            # ── Strict 30-second lookahead throttle ────────────────────────────
            # Always active: treat "not started yet" (pb_time == -1) as position 0
            # so analysis never runs more than 30 s ahead even before playback begins.
            pb_time = _job_playback_time.get(job_id, -1.0)
            effective_pb = max(0.0, pb_time)   # -1 sentinel → 0
            frame_time = frame_dict.get("time_seconds", 0.0)
            while frame_time > effective_pb + LOOKAHEAD_S:
                await asyncio.sleep(0.05)
                pb_time = _job_playback_time.get(job_id, -1.0)
                effective_pb = max(0.0, pb_time)

            frame_idx = frame_dict.get("frame_index", 0)

            # Progress heartbeat every 500 frames so the UI can show live counts
            if frame_idx > 0 and frame_idx % 500 == 0:
                await _send_to_all({
                    "type": "progress",
                    "job_id": job_id,
                    "frame_count": len(_jobs[job_id]["frames"]),
                })

            # Yield to the event loop every 50 frames so the WS write buffer
            # can drain and the asyncio transport doesn't stall.
            if frame_idx % 50 == 0:
                await asyncio.sleep(0)

        _jobs[job_id]["status"] = "done"
        frame_count = len(_jobs[job_id]["frames"])
        print(f"[job {job_id[:8]}] Done — {frame_count} frames")
        await _send_to_all({
            "type": "analysis_done",
            "job_id": job_id,
            "frame_count": frame_count,
        })
        _job_subscribers.pop(job_id, None)

    except Exception as exc:
        _jobs[job_id]["status"] = f"error: {exc}"
        print(f"[job {job_id[:8]}] ERROR: {exc}")
        await _send_to_all({"type": "error", "job_id": job_id, "message": str(exc)})
        raise
    finally:
        _job_playback_time.pop(job_id, None)
        audio_path.unlink(missing_ok=True)
        if _converted_path is not None:
            _converted_path.unlink(missing_ok=True)

# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    return {"status": "ok", "message": "SEESOUND API is running", "version": "0.2.0"}


@app.get("/api/health")
async def health():
    return {
        "status": "healthy",
        "connections": len(manager.active_connections),
        "jobs": len(_jobs),
    }


@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    """
    Accept an audio file (WAV, MP3, FLAC, OGG, AIFF …).
    Returns a job_id immediately; analysis runs asynchronously.

    To receive streamed frames in real-time, connect to WS /ws first,
    then either:
      • upload via the WebSocket using {"type":"upload_audio", "payload":{"filename":..., "data":<b64>}}
      • or subscribe after HTTP upload: {"type":"subscribe", "payload":{"job_id":"..."}}
    """
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    # Stream-write in 1 MB chunks so large WAV/FLAC files don't spike RAM
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        tmp.write(chunk)
    tmp.close()

    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"filename": file.filename, "status": "queued", "frames": [], "params": AnalysisParams().model_dump()}
    asyncio.create_task(_run_analysis_job(job_id, Path(tmp.name), AnalysisParams()))
    return {"job_id": job_id, "filename": file.filename, "status": "queued"}


@app.get("/api/analysis/{job_id}/status")
async def job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "status": job["status"], "frame_count": len(job["frames"])}


@app.get("/api/analysis/{job_id}")
async def get_analysis(job_id: str, start: int = 0, limit: int = 500):
    """Return a paginated slice of stored AnalysisFrame dicts."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "total_frames": len(job["frames"]),
        "frames": job["frames"][start: start + limit],
    }


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    ws_id = id(websocket)
    _session_params[ws_id] = AnalysisParams()

    await manager.send(websocket, {
        "type": "handshake",
        "message": "Connected to SEESOUND backend",
        "version": "0.2.0",
        "default_params": _session_params[ws_id].model_dump(),
    })

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send(websocket, {"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = data.get("type", "unknown")
            payload  = data.get("payload", {})

            # ── Ping ─────────────────────────────────────────────────────
            if msg_type == "ping":
                await manager.send(websocket, {"type": "pong"})

            # ── Update session analysis parameters ────────────────────────
            elif msg_type == "params":
                try:
                    merged = {**_session_params[ws_id].model_dump(), **payload}
                    # Map camelCase color keys from the frontend into the nested
                    # color sub-model (the frontend sends flat camelCase params).
                    current_color = merged.get("color", {})
                    color_map = {
                        "noteColors":      "note_colors",
                        "colorInputMode":  "color_input_mode",
                        "freqColorTable":  "freq_color_table",
                        "lightnessMin":    "lightness_min",
                        "lightnessMax":    "lightness_max",
                    }
                    for camel, snake in color_map.items():
                        if camel in payload:
                            current_color = {**current_color, snake: payload[camel]}
                    if current_color:
                        merged["color"] = current_color
                    _session_params[ws_id] = AnalysisParams(**merged)
                    await manager.send(websocket, {
                        "type": "params_ack",
                        "params": _session_params[ws_id].model_dump(),
                    })
                except Exception as exc:
                    await manager.send(websocket, {"type": "error", "message": f"Invalid params: {exc}"})

            # ── Upload audio as base64 over WebSocket ─────────────────────
            elif msg_type == "upload_audio":
                b64 = payload.get("data", "")
                filename = payload.get("filename", "audio.wav")
                if not b64:
                    await manager.send(websocket, {"type": "error", "message": "No audio data supplied"})
                    continue

                suffix = Path(filename).suffix or ".wav"
                tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
                tmp.write(base64.b64decode(b64))
                tmp.close()

                job_id = str(uuid.uuid4())
                params = _session_params[ws_id]
                _jobs[job_id] = {"filename": filename, "status": "queued", "frames": [], "params": params.model_dump()}
                asyncio.create_task(_run_analysis_job(job_id, Path(tmp.name), params, websocket))
                await manager.send(websocket, {
                    "type": "job_started",
                    "job_id": job_id,
                    "filename": filename,
                    "params": params.model_dump(),
                })

            # ── Subscribe to an already-running / completed job ───────────
            elif msg_type == "subscribe":
                job_id = payload.get("job_id", "")
                job = _jobs.get(job_id)
                if not job:
                    await manager.send(websocket, {"type": "error", "message": f"Job '{job_id}' not found"})
                    continue
                # Tell the client a job is active so it clears & starts rendering
                await manager.send(websocket, {
                    "type": "job_started",
                    "payload": {"job_id": job_id},
                    "filename": job.get("filename", ""),
                })
                # Replay already-stored frames in batches, yielding to the
                # event loop every 100 frames so the WS write buffer drains
                # and we don't overflow the browser's receive buffer.
                for i, frame_dict in enumerate(list(job["frames"])):
                    await manager.send(websocket, {"type": "frame", "job_id": job_id, "payload": frame_dict})
                    if (i + 1) % 100 == 0:
                        await asyncio.sleep(0)
                if job["status"] == "running":
                    # Register this WS to receive frames as they arrive
                    if job_id not in _job_subscribers:
                        _job_subscribers[job_id] = set()
                    _job_subscribers[job_id].add(websocket)
                elif job["status"] == "queued":
                    # Job hasn't started yet — register so it receives all frames
                    if job_id not in _job_subscribers:
                        _job_subscribers[job_id] = set()
                    _job_subscribers[job_id].add(websocket)
                else:
                    # Job already finished — send done signal
                    await manager.send(websocket, {
                        "type": "analysis_done",
                        "job_id": job_id,
                        "frame_count": len(job["frames"]),
                    })

            # ── Playback position heartbeat ───────────────────────────────
            elif msg_type == "playback_time":
                j_id = payload.get("job_id", "")
                t = float(payload.get("time", 0.0))
                if j_id and j_id in _jobs:
                    _job_playback_time[j_id] = max(t, _job_playback_time.get(j_id, 0.0))

            # ── Unknown ───────────────────────────────────────────────────
            else:
                await manager.send(websocket, {"type": "error", "message": f"Unknown type: '{msg_type}'"})


    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as exc:
        print(f"[WS] Error: {exc}")
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Preset endpoints
# ---------------------------------------------------------------------------

@app.get("/api/presets")
async def list_presets():
    PRESETS_DIR.mkdir(exist_ok=True)
    names = [p.stem for p in sorted(PRESETS_DIR.glob("*.json"))]
    return {"names": names}


@app.post("/api/presets")
async def save_preset(body: PresetBody):
    PRESETS_DIR.mkdir(exist_ok=True)
    safe = "".join(c for c in body.name if c.isalnum() or c in " _-").strip()
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid preset name")
    data: dict = {
        "name": safe,
        "params": body.params,
        "disabledKeys": body.disabledKeys,
        "mappingGroups": body.mappingGroups,
    }
    if body.canvasW is not None:
        data["canvasW"] = body.canvasW
    if body.canvasH is not None:
        data["canvasH"] = body.canvasH
    (PRESETS_DIR / f"{safe}.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False)
    )
    return {"name": safe, "saved": True}


@app.get("/api/presets/{name}")
async def get_preset(name: str):
    path = PRESETS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Preset not found")
    return json.loads(path.read_text())


@app.delete("/api/presets/{name}")
async def delete_preset(name: str):
    path = PRESETS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Preset not found")
    path.unlink()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Color-preset endpoints  (presets/colors/*.json — note colors + dynamics only)
# ---------------------------------------------------------------------------

class ColorPresetBody(BaseModel):
    name: str
    colors: dict


@app.get("/api/color-presets")
async def list_color_presets():
    COLOR_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    names = [p.stem for p in sorted(COLOR_PRESETS_DIR.glob("*.json"))]
    return {"names": names}


@app.post("/api/color-presets")
async def save_color_preset(body: ColorPresetBody):
    COLOR_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in body.name if c.isalnum() or c in " _-").strip()
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid preset name")
    data = {"name": safe, "colors": body.colors}
    (COLOR_PRESETS_DIR / f"{safe}.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False)
    )
    return {"name": safe, "saved": True}


@app.get("/api/color-presets/{name}")
async def get_color_preset(name: str):
    path = COLOR_PRESETS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Color preset not found")
    return json.loads(path.read_text())


@app.delete("/api/color-presets/{name}")
async def delete_color_preset(name: str):
    path = COLOR_PRESETS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Color preset not found")
    path.unlink()
    return {"deleted": True}




if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
