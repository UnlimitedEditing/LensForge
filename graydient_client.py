"""
graydient_client.py — Direct HTTP client for the Graydient v3 API.

Speaks the same wire format as the official SDK but lives entirely within
this project so we control iteration on request shape, error handling,
and workflow selection without touching a third-party package.

Key facts from the SDK source (render_v3.py):
  - POST /render with Content-Type: application/vnd.api+json
  - Workflow slug goes into the 'options' string as /run:<slug>
  - Other option flags (seed etc) join the same space-separated string
  - Streaming uses SSE; 'rendering_done' event carries the render_hash
  - GET /render/<hash> returns JSON-API envelope; image URL is in
    attributes.images[0].media[0].url (or .url fallback)
"""

import json
import logging
import os
from typing import Callable, Optional

import requests
import sseclient

log = logging.getLogger("forge.graydient")

BASE_URL = os.environ.get("GRAYDIENT_API_URL", "https://app.graydient.ai/api/v3/")


def _url(path: str) -> str:
    return BASE_URL.rstrip("/") + "/" + path.lstrip("/")


def _headers(api_key: str, stream: bool = False) -> dict:
    h = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/vnd.api+json",
        "Accept-Type": "application/vnd.api+json",
    }
    if stream:
        h["Accept"] = "text/event-stream"
    return h


def validate_key(api_key: str) -> bool:
    """Probe GET /workflows — cheap call, 200 means key is valid."""
    try:
        resp = requests.get(_url("workflows"), headers=_headers(api_key), timeout=10)
        return resp.status_code == 200
    except Exception:
        return False


def render_create(
    prompt: str,
    workflow: str,
    api_key: str,
    on_event: Callable[[dict], None],
    init_image: Optional[str] = None,
    seed: Optional[int] = None,
    strength: Optional[float] = None,
    control_slug: Optional[str] = None,
    extra_options: Optional[str] = None,
) -> None:
    """
    Submit a workflow render and stream progress events back.
    Blocks until the SSE stream closes. on_event fires for each parsed event.

    init_image: publicly-accessible URL used as the source image for img2img
    workflows (e.g. edit-qwen-rapid for variant state generation).

    strength: denoise strength for img2img workflows (0.0–1.0). Only valid for
    edit/remix/img2img workflows — do not pass for txt2img renders.

    control_slug: optional ControlNet reference slug — appends /image1:{slug}
    to the options string when provided.

    extra_options: raw option string appended verbatim (e.g. '/size:640x640 /fps:30').
    """
    options_parts = [f"/run:{workflow}"]
    if seed is not None:
        options_parts.append(f"/seed:{seed}")
    if strength is not None:
        options_parts.append(f"/strength:{strength:.2f}")
    if control_slug is not None:
        options_parts.append(f"/image1:{control_slug}")
    if extra_options:
        options_parts.append(extra_options.strip())

    body = {
        "options": " ".join(options_parts),
        "placeholders": {},
        "metadata_fields": {},
        "prompt": prompt,
        "task": "workflow",
        "progressive_return": True,
        "stream": True,
    }
    if init_image:
        body["init_image"] = init_image

    log.info("render_create workflow=%s prompt=%.80s", workflow, prompt)
    resp = requests.post(
        _url("render"),
        headers=_headers(api_key, stream=True),
        json=body,
        stream=True,
        timeout=(15, 180),  # 15s connect, 180s between SSE events
    )
    resp.raise_for_status()

    client = sseclient.SSEClient(resp)
    for event in client.events():
        try:
            payload = json.loads(event.data)
        except (json.JSONDecodeError, ValueError):
            log.warning("unparseable SSE event: %.200s", event.data)
            continue
        log.debug("sse event keys=%s", list(payload.keys()))
        on_event(payload)


def upload_control_image(image_data: str, slug: str, api_key: str) -> None:
    """
    Upload a pose/control image to Graydient as a named ControlNet reference.

    image_data: base64 data URI (e.g. data:image/jpeg;base64,...)
    slug: the name to register the control image under (e.g. "df_walk_f0")

    Uses the zimage workflow with /control /new:{slug} options.
    SSE events are consumed and discarded — only the upload matters.
    """
    options_parts = ["/run:zimage", "/control", f"/new:{slug}"]
    body = {
        "options": " ".join(options_parts),
        "placeholders": {},
        "metadata_fields": {},
        "prompt": "",
        "task": "workflow",
        "progressive_return": True,
        "stream": True,
        "init_image": image_data,
    }

    log.info("upload_control_image slug=%s", slug)
    resp = requests.post(
        _url("render"),
        headers=_headers(api_key, stream=True),
        json=body,
        stream=True,
        timeout=120,
    )
    resp.raise_for_status()

    # Drain the SSE stream so the server finalises the upload
    client = sseclient.SSEClient(resp)
    for event in client.events():
        log.debug("upload_control_image sse: %.120s", event.data)


def render_info(render_hash: str, api_key: str) -> dict:
    """
    Fetch completed render metadata. Returns the attributes dict merged with id,
    matching the structure the SDK's to_render() produces.
    """
    resp = requests.get(
        _url(f"render/{render_hash}"),
        headers=_headers(api_key),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return {"id": data["id"], **data["attributes"]}


def extract_image_url(render_data: dict) -> Optional[str]:
    """Pull the first image URL from a render_info result dict."""
    images = render_data.get("images") or []
    if not images:
        return None
    img = images[0]
    media = img.get("media") or []
    if media:
        return media[0].get("url")
    return img.get("url")


def llm_query(
    prompt: str,
    system_prompt: str,
    api_key: str,
    persona: str = "Polly",
    *,
    reply_to: Optional[str] = None,
    session_id: Optional[str] = None,
    image_url: Optional[str] = None,
) -> dict:
    """
    Synchronous LLM chat call against Graydient /chat/ endpoint.

    Returns a dict with:
      "text"        — the LLM response string
      "response_id" — Graydient response ID; pass as reply_to to continue the thread

    Optional chaining params:
      reply_to   — response_id from a previous call; includes full conversation history
      session_id — arbitrary string for Graydient-side correlation (we use Chronicle session id)
      image_url  — URL of an image for vision-enabled models to analyse alongside the prompt

    When reply_to is supplied, system_prompt is NOT prepended (the conversation thread already
    has the original context; prepending again would pollute it).
    """
    full_prompt = prompt if reply_to else (
        f"{system_prompt}\n\n{prompt}" if system_prompt else prompt
    )
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
    }
    payload: dict = {
        "persona": persona,
        "prompt":  full_prompt,
        "sync":    True,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    if session_id:
        payload["session_id"] = session_id
    if image_url:
        payload["image_url"] = image_url

    log.info("llm_query persona=%s reply_to=%s image=%s prompt=%.80s",
             persona, reply_to, bool(image_url), full_prompt)
    resp = requests.post(_url("chat/"), headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()

    # Graydient returns JSON:API envelope: {"data": [{"attributes": {...}}]}
    # Fall back to flat top-level keys for forward-compatibility.
    attrs = data
    if isinstance(data.get("data"), list) and data["data"]:
        attrs = data["data"][0].get("attributes", data)

    response_text = attrs.get("response_text") or ""
    response_id   = attrs.get("response_id")

    log.info("llm_query response_id=%s text=%.80s", response_id, response_text[:80])
    return {
        "text":        response_text or str(data),
        "response_id": response_id,
    }


# ─────────────────────────────────────────────────────────────────────────────
# SKILLS API  (POST /skills, GET /skills/:slug, POST /skills/:slug/invoke)
# ─────────────────────────────────────────────────────────────────────────────

def skill_create(
    name: str,
    content: str,
    description: str,
    api_key: str,
    slug: Optional[str] = None,
    allows_input_media: bool = False,
    is_public: bool = False,
    is_open_source: bool = True,
) -> dict:
    """Register a new skill on Graydient.

    Returns the attributes dict of the created skill (id, slug, version, …).
    Raises requests.HTTPError on failure (e.g. duplicate slug → 422).
    """
    payload: dict = {
        "name":               name,
        "content":            content,
        "description":        description,
        "allows_input_media": allows_input_media,
        "is_public":          is_public,
        "is_open_source":     is_open_source,
    }
    if slug:
        payload["slug"] = slug
    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Content-Type":   "application/vnd.api+json",
        "Accept":         "application/vnd.api+json",
    }
    log.info("skill_create name=%s slug=%s", name, slug)
    resp = requests.post(_url("skills"), headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    # Graydient returns {"data": {"id": ..., "attributes": {...}}}
    record = data.get("data", data)
    return {"id": record.get("id"), **(record.get("attributes") or record)}


def skill_invoke(
    slug: str,
    prompt: str,
    api_key: str,
    *,
    input_media: Optional[dict] = None,
) -> dict:
    """Invoke a Graydient skill by slug and return the generated command.

    prompt      — the natural-language request (entity description, frame suffix, etc.)
    input_media — optional vision context: {"type": "image", "reference": "<url>"}
                  The reference image is shown to the skill's LLM so it can tailor
                  the command without re-describing identity.  Do NOT pass this for
                  txt2img skills (idle/turnaround).

    Returns:
      command     — the full workflow command string, e.g.
                    "/wf /run:qwen /size:1152x640 /images:1 character turnaround..."
      explanation — human-readable description of what the command does
      safe        — bool; False means the command failed the safety filter
    """
    payload: dict = {"prompt": prompt}
    if input_media:
        payload["input_media"] = input_media
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type":  "application/vnd.api+json",
        "Accept":        "application/vnd.api+json",
    }
    log.info("skill_invoke slug=%s prompt=%.80s media=%s", slug, prompt, bool(input_media))
    resp = requests.post(
        _url(f"skills/{slug}/invoke"),
        headers=headers,
        json=payload,
        timeout=60,
    )
    resp.raise_for_status()
    raw  = resp.json()
    data = raw.get("data", raw)
    return {
        "command":     data.get("command", ""),
        "explanation": data.get("explanation", ""),
        "safe":        data.get("safe", True),
    }


def parse_skill_command(command: str) -> dict:
    """Parse a Graydient skill command string into render_create() parameters.

    Skill commands use the format:
        /wf /run:<workflow> [/size:NxN] [/strength:0.N] [/images:N] [...] <prompt text>

    The /wf prefix and any recognised option flags are extracted; everything
    after the last flag is the prompt text.  Unknown flags are collected into
    extra_options.

    Returns:
        workflow      — workflow slug string, or None (caller uses its default)
        prompt        — the prompt text portion (everything after flags)
        strength      — float denoise strength, or None
        extra_options — remaining flags joined as a string, or None
    """
    result: dict = {
        "workflow":      None,
        "prompt":        command.strip(),
        "strength":      None,
        "extra_options": None,
    }
    if not command.strip():
        return result

    parts    = command.strip().split()
    opt_list: list[str] = []
    i = 0

    # Strip leading /wf or /workflow marker
    if parts and parts[0].lower() in ("/wf", "/workflow"):
        i += 1

    while i < len(parts):
        p = parts[i]
        if p.startswith("/run:"):
            result["workflow"] = p[5:]
        elif p.startswith("/strength:"):
            try:
                result["strength"] = float(p[10:])
            except ValueError:
                opt_list.append(p)
        elif p.startswith("/"):
            opt_list.append(p)
        else:
            # First non-flag token — the remainder is the prompt
            result["prompt"] = " ".join(parts[i:])
            break
        i += 1

    if opt_list:
        result["extra_options"] = " ".join(opt_list)
    return result
