"""
camera_math.py — Shared camera trajectory math for LensForge.

Used by:
  - lensforge_node/nodes.py  (runs inside ComfyUI on Graydient)
  - lensforge.py             (used for client-side preview / validation)

No torch dependency here — pure Python + math so it works without GPU.
The ComfyUI node converts the output to a torch tensor.
"""

import math
from typing import Any


# ── Constants ─────────────────────────────────────────────────────────────────

MAX_PAN_RAD  = math.radians(30)   # max pan travel at speed=1
MAX_TILT_RAD = math.radians(20)
MAX_DOLLY    = 0.8                 # world units
MAX_CRANE    = 0.4
MAX_ORBIT    = math.pi / 3        # 60° arc

MOTION_TYPES = [
    "static",
    "pan_left", "pan_right",
    "tilt_up",  "tilt_down",
    "zoom_in",  "zoom_out",
    "dolly_fwd","dolly_bwd",
    "crane_up", "crane_down",
    "orbit_cw", "orbit_ccw",
]


# ── 4×4 matrix helpers ────────────────────────────────────────────────────────

def _identity() -> list:
    return [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]

def _rot_y(a: float) -> list:
    c, s = math.cos(a), math.sin(a)
    return [[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]]

def _rot_x(a: float) -> list:
    c, s = math.cos(a), math.sin(a)
    return [[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]]

def _translate(tx: float, ty: float, tz: float) -> list:
    return [[1,0,0,tx],[0,1,0,ty],[0,0,1,tz],[0,0,0,1]]

def _mul(a: list, b: list) -> list:
    r = [[0.0]*4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            for k in range(4):
                r[i][j] += a[i][k] * b[k][j]
    return r

def _ease(t: float) -> float:
    """Smooth cubic ease-in-out."""
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# ── Per-motion pose builder ────────────────────────────────────────────────────

def pose_for_t(motion: str, speed: float, t: float) -> list:
    """
    Return a 4×4 camera-to-world matrix for normalised time t ∈ [0, 1].
    t=0 is segment start, t=1 is segment end.
    """
    t = _ease(t)
    s = speed

    if motion == "static":
        return _identity()
    elif motion == "pan_left":
        return _rot_y(-s * MAX_PAN_RAD * t)
    elif motion == "pan_right":
        return _rot_y( s * MAX_PAN_RAD * t)
    elif motion == "tilt_up":
        return _rot_x(-s * MAX_TILT_RAD * t)
    elif motion == "tilt_down":
        return _rot_x( s * MAX_TILT_RAD * t)
    elif motion in ("zoom_in", "dolly_fwd"):
        return _translate(0, 0, -s * MAX_DOLLY * t)
    elif motion in ("zoom_out", "dolly_bwd"):
        return _translate(0, 0,  s * MAX_DOLLY * t)
    elif motion == "crane_up":
        return _translate(0,  s * MAX_CRANE * t, 0)
    elif motion == "crane_down":
        return _translate(0, -s * MAX_CRANE * t, 0)
    elif motion in ("orbit_cw", "orbit_ccw"):
        direction = 1.0 if motion == "orbit_cw" else -1.0
        angle  = direction * s * MAX_ORBIT * t
        radius = 1.5
        tx = radius * math.sin(angle)
        tz = radius * (math.cos(angle) - 1)
        return _mul(_translate(tx, 0, tz), _rot_y(-angle))
    else:
        return _identity()


# ── Full trajectory ────────────────────────────────────────────────────────────

def generate_poses(keyframes: list[dict], total_frames: int) -> list[list[list[float]]]:
    """
    Build a list of `total_frames` 4×4 matrices from a keyframe list.

    Each keyframe: { "start": int, "end": int, "motion": str, "speed": float }
    Frames not covered by any keyframe default to static (identity).

    Returns: list of length total_frames, each element a 4×4 nested list.
    """
    kfs = sorted(keyframes, key=lambda k: k["start"])
    poses = []
    for frame in range(total_frames):
        active = next(
            (kf for kf in kfs if kf["start"] <= frame < kf["end"]),
            None,
        )
        if active is None:
            poses.append(_identity())
        else:
            span = max(1, active["end"] - active["start"])
            t    = (frame - active["start"]) / span
            poses.append(pose_for_t(active["motion"], active["speed"], t))
    return poses


# ── Serialisation helper ───────────────────────────────────────────────────────

def poses_to_flat(poses: list[list[list[float]]]) -> list[float]:
    """Flatten (T, 4, 4) poses to a 1-D list for JSON transport."""
    return [v for mat in poses for row in mat for v in row]


def flat_to_poses(flat: list[float], total_frames: int) -> list[list[list[float]]]:
    """Inverse of poses_to_flat."""
    poses = []
    for i in range(total_frames):
        base = i * 16
        mat  = [flat[base + r*4 : base + r*4 + 4] for r in range(4)]
        poses.append(mat)
    return poses
