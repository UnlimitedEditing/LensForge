"""
lensforge.py — LensForge API server.

Endpoints:
  GET  /             → index.html
  GET  /config       → current config JSON
  PUT  /config       → update config
  POST /render       → submit a scene document to Graydient as a render job
  GET  /render/{id}  → poll render status / result

Run:
  uvicorn lensforge:app --host 0.0.0.0 --port 8765 --reload

Config keys (config.json):
  api_key           — Graydient API key
  workflow_slug     — Graydient workflow slug to target (e.g. "lensforge-wan-cam-1234-5")
  field_json        — Graydient field name for the LensForge JSON bus   (default: "lensforge_json")
  field_positive    — Graydient field name for positive prompt           (default: "positive_prompt")
  field_negative    — Graydient field name for negative prompt           (default: "negative_prompt")
  field_seed        — Graydient field name for seed                      (default: "seed")
"""

import json
import logging
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import graydient_client as gc

log = logging.getLogger("lensforge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

BASE_DIR    = Path(__file__).parent
STATIC_DIR  = BASE_DIR / "static"
CONFIG_FILE = BASE_DIR / "config.json"

DEFAULT_CONFIG = {
    "api_key":        "",
    "workflow_slug":  "",
    "field_json":     "lensforge_json",
    "field_positive": "positive_prompt",
    "field_negative": "negative_prompt",
    "field_seed":     "seed",
}

app = FastAPI(title="LensForge")


# ── Config ────────────────────────────────────────────────────────────────────

def _load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return {**DEFAULT_CONFIG, **json.loads(CONFIG_FILE.read_text())}
        except Exception:
            pass
    return dict(DEFAULT_CONFIG)

def _save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


@app.get("/config")
async def get_config():
    return JSONResponse(_load_config())

@app.put("/config")
async def put_config(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    cfg = _load_config()
    cfg.update({k: v for k, v in body.items() if k in DEFAULT_CONFIG})
    _save_config(cfg)
    return JSONResponse(cfg)


# ── Render ────────────────────────────────────────────────────────────────────

@app.post("/render")
async def post_render(request: Request):
    """
    Submit a scene document to Graydient.

    The scene document's `keyframes` array (and any other bus data) is
    JSON-serialised and passed as the `lensforge_json` field value.
    Prompt + seed are passed as their respective fields.

    Returns: { "render_id": str }  immediately; client polls /render/{id}.

    Field injection mechanism: Graydient's /render endpoint accepts a
    `placeholders` dict for prompt-template substitution, and `metadata_fields`
    for workflow field overrides.  We use metadata_fields for widget overrides
    (the Fields tab mappings) and placeholders for prompt tokens if needed.
    Verify with your Graydient slot's actual field names.
    """
    try:
        doc = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    cfg = _load_config()

    if not cfg.get("api_key"):
        raise HTTPException(400, "No Graydient API key configured — set it in the Config tab.")
    if not cfg.get("workflow_slug"):
        raise HTTPException(400, "No workflow slug configured — set it in the Config tab.")

    prompt   = doc.get("prompt", "")
    neg      = doc.get("negative_prompt", "")
    seed     = doc.get("seed", -1)
    # Serialise the full scene doc as the JSON bus payload
    lf_json  = json.dumps({
        "keyframes": doc.get("keyframes", []),
        "frames":    doc.get("frames", 81),
        "fps":       doc.get("fps", 16),
        "resolution": doc.get("resolution", "848x480"),
        # Future bus passengers go here (temporal_prompts, vfx_params, …)
    })

    # Build Graydient field overrides
    metadata_fields = {
        cfg["field_json"]:     lf_json,
        cfg["field_positive"]: prompt,
        cfg["field_negative"]: neg,
    }
    if seed >= 0:
        metadata_fields[cfg["field_seed"]] = str(seed)

    # Collect SSE events in a background thread, return render_id immediately
    render_id_holder: dict = {}
    error_holder:     dict = {}
    done_event = threading.Event()

    def _on_event(evt: dict):
        if "render_hash" in evt and not render_id_holder:
            render_id_holder["id"] = evt["render_hash"]
            done_event.set()
        if evt.get("event") == "rendering_done":
            render_id_holder["id"] = evt.get("render_hash", render_id_holder.get("id", ""))
            done_event.set()
        if evt.get("error"):
            error_holder["msg"] = str(evt["error"])
            done_event.set()

    def _run():
        try:
            gc.render_create(
                prompt   = prompt,
                workflow = cfg["workflow_slug"],
                api_key  = cfg["api_key"],
                on_event = _on_event,
                extra_options = _build_extra_options(metadata_fields),
            )
        except Exception as e:
            error_holder["msg"] = str(e)
        finally:
            done_event.set()

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    # Wait up to 15 s for Graydient to acknowledge and return a render hash
    done_event.wait(timeout=15)

    if error_holder:
        raise HTTPException(502, f"Graydient error: {error_holder['msg']}")

    render_id = render_id_holder.get("id", "")
    return JSONResponse({"render_id": render_id, "status": "queued"})


def _build_extra_options(fields: dict) -> str:
    """
    Encode field overrides as Graydient option flags.

    Graydient accepts field overrides via the options string as:
      /field:name=value   (for simple string/number values)

    For the lensforge_json field the value is a URL-safe base64 blob to avoid
    special characters in the options string.  The ComfyUI node decodes it.

    ⚠ Verify this matches your Graydient account tier's field injection syntax.
      Some tiers use `metadata_fields` in the POST body instead of options flags.
      If /field: flags don't work, switch to the body-based approach below.
    """
    import base64
    parts = []
    for name, value in fields.items():
        if name.endswith("_json"):
            # Base64-encode JSON blobs to keep the options string clean
            encoded = base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")
            parts.append(f"/field:{name}={encoded}")
        else:
            # Simple values — strip newlines, truncate for safety
            safe = str(value).replace("\n", " ").replace("=", "%3D")[:512]
            parts.append(f"/field:{name}={safe}")
    return " ".join(parts)


@app.get("/render/{render_id}")
async def get_render(render_id: str):
    """Poll a render for status and result URL."""
    cfg = _load_config()
    if not cfg.get("api_key"):
        raise HTTPException(400, "No API key configured.")
    try:
        data = gc.render_info(render_id, cfg["api_key"])
        url  = gc.extract_image_url(data)
        return JSONResponse({
            "render_id": render_id,
            "status":    data.get("status", "unknown"),
            "url":       url,
            "raw":       data,
        })
    except Exception as e:
        raise HTTPException(502, str(e))


# ── Static / index ────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def root():
    return FileResponse(str(STATIC_DIR / "index.html"))


# ── Bootstrap ─────────────────────────────────────────────────────────────────

if not CONFIG_FILE.exists():
    _save_config(DEFAULT_CONFIG)
    log.info("Created default config.json")
