"""
lensforge_node/nodes.py — ComfyUI custom node for LensForge JSON bus.

Install on Graydient via Custom Nodes tab:
  https://github.com/<your-repo>/lensforge_node   (or upload the folder directly)

Node: LensForgeCameraNode
  Accepts the lensforge_json field (serialised scene document or keyframe array),
  computes camera-to-world pose matrices, and outputs them in the format
  WanFunControlCameraEmbed expects as its `camera_poses` input.

Wiring in the Graydient workflow:
  [LensForgeCameraNode] --camera_poses--> [WanFunControlCameraEmbed] --WANVIDIMAGE_EMBEDS--> [WanVideoSampler]

Fields config (Graydient → Fields tab):
  lensforge_json   → node id of LensForgeCameraNode, widget "json_input"
  positive_prompt  → WanVideoTextEncode (positive), widget "text"
  negative_prompt  → WanVideoTextEncode (negative), widget "text"
  seed             → WanVideoSampler, widget "seed"

⚠  camera_poses output type: this node emits a torch.Tensor of shape (T, 4, 4)
   as type "LENSFORGE_CAMERA_POSES".  If WanFunControlCameraEmbed expects a
   different type name, update CAMERA_POSES_TYPE below to match.  You can
   inspect the wrapper's NODE_CLASS_MAPPINGS or run inspect_workflow.py on
   a working Fun-Camera workflow to find the exact socket type.
"""

import json
import math
import sys
import os

# ── Camera math (inline copy so the node has no external deps) ────────────────
# This mirrors camera_math.py — kept inline so the node is self-contained
# when uploaded to Graydient without the rest of the LensForge repo.

_MAX_PAN  = math.radians(30)
_MAX_TILT = math.radians(20)
_MAX_DOLLY = 0.8
_MAX_CRANE = 0.4
_MAX_ORBIT = math.pi / 3

def _identity():
    return [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]

def _rot_y(a):
    c,s = math.cos(a), math.sin(a)
    return [[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]]

def _rot_x(a):
    c,s = math.cos(a), math.sin(a)
    return [[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]]

def _translate(tx,ty,tz):
    return [[1,0,0,tx],[0,1,0,ty],[0,0,1,tz],[0,0,0,1]]

def _mul(a,b):
    r = [[0.0]*4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            for k in range(4):
                r[i][j] += a[i][k]*b[k][j]
    return r

def _ease(t):
    t = max(0.0, min(1.0, t))
    return t*t*(3-2*t)

def _pose(motion, speed, t):
    t = _ease(t); s = speed
    if   motion == "pan_left":   return _rot_y(-s*_MAX_PAN*t)
    elif motion == "pan_right":  return _rot_y( s*_MAX_PAN*t)
    elif motion == "tilt_up":    return _rot_x(-s*_MAX_TILT*t)
    elif motion == "tilt_down":  return _rot_x( s*_MAX_TILT*t)
    elif motion in ("zoom_in",  "dolly_fwd"): return _translate(0,0,-s*_MAX_DOLLY*t)
    elif motion in ("zoom_out", "dolly_bwd"): return _translate(0,0, s*_MAX_DOLLY*t)
    elif motion == "crane_up":   return _translate(0, s*_MAX_CRANE*t,0)
    elif motion == "crane_down": return _translate(0,-s*_MAX_CRANE*t,0)
    elif motion in ("orbit_cw","orbit_ccw"):
        d = 1.0 if motion=="orbit_cw" else -1.0
        ang = d*s*_MAX_ORBIT*t; r=1.5
        return _mul(_translate(r*math.sin(ang),0,r*(math.cos(ang)-1)),_rot_y(-ang))
    return _identity()

def _generate_poses(keyframes, total_frames):
    kfs = sorted(keyframes, key=lambda k: k["start"])
    poses = []
    for frame in range(total_frames):
        active = next((kf for kf in kfs if kf["start"] <= frame < kf["end"]), None)
        if active is None:
            poses.append(_identity())
        else:
            span = max(1, active["end"] - active["start"])
            poses.append(_pose(active["motion"], active["speed"], (frame-active["start"])/span))
    return poses

# ─────────────────────────────────────────────────────────────────────────────
# Socket type — must match what WanFunControlCameraEmbed expects on its
# `camera_poses` input.  Inspect the wrapper source if this causes a type error.
# Common candidates: "CAMERA_POSES", "WANVIDEOCAMERAPOSES", "IMAGE" (if it
# expects pre-embedded frames rather than raw matrices).
# ─────────────────────────────────────────────────────────────────────────────
CAMERA_POSES_TYPE = "CAMERA_POSES"


class LensForgeCameraNode:
    """
    Parse a LensForge JSON scene document and emit camera poses
    for consumption by WanFunControlCameraEmbed.
    """

    CATEGORY    = "LensForge"
    FUNCTION    = "execute"
    RETURN_TYPES  = (CAMERA_POSES_TYPE,)
    RETURN_NAMES  = ("camera_poses",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "json_input":   ("STRING",  {"multiline": True,  "default": "{}"}),
                "num_frames":   ("INT",     {"default": 81,  "min": 9,  "max": 257}),
                "width":        ("INT",     {"default": 848, "min": 64, "max": 2048}),
                "height":       ("INT",     {"default": 480, "min": 64, "max": 2048}),
            }
        }

    def execute(self, json_input: str, num_frames: int, width: int, height: int):
        import torch

        try:
            doc = json.loads(json_input)
        except json.JSONDecodeError as e:
            raise ValueError(f"LensForgeCameraNode: invalid JSON — {e}")

        # Accept either a full scene document or a bare keyframe array
        if isinstance(doc, list):
            keyframes = doc
        else:
            keyframes = doc.get("keyframes", [])

        if not keyframes:
            # No keyframes → static (identity for all frames)
            keyframes = [{"start": 0, "end": num_frames, "motion": "static", "speed": 0.0}]

        poses = _generate_poses(keyframes, num_frames)

        # Convert to torch tensor: shape (T, 4, 4), float32
        tensor = torch.tensor(poses, dtype=torch.float32)  # (T, 4, 4)

        return (tensor,)


# ── Registration ──────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "LensForgeCameraNode": LensForgeCameraNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LensForgeCameraNode": "LensForge Camera (JSON → Poses)",
}
