"""Validate and normalize sketch JSON documents."""
from __future__ import annotations

from typing import Any

_VALID_GRID_SPACING = {1, 3, 6, 12}
_VALID_TOOLS = {"pen", "line", "eraser"}
_VALID_BG_SOURCES = {"none", "job_photo", "device"}


def validate_sketch_document(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("version") != 1:
        raise ValueError("Unsupported sketch document version")

    ppi = data.get("pixelsPerInch")
    if not isinstance(ppi, (int, float)) or ppi <= 0:
        raise ValueError("Invalid pixelsPerInch")

    canvas = data.get("canvas")
    if not isinstance(canvas, dict):
        raise ValueError("Invalid canvas")
    for key in ("width", "height"):
        val = canvas.get(key)
        if not isinstance(val, (int, float)) or val <= 0:
            raise ValueError(f"Invalid canvas.{key}")

    spacing = data.get("gridSpacingInches")
    if spacing not in _VALID_GRID_SPACING:
        raise ValueError("gridSpacingInches must be 1, 3, 6, or 12")

    snap_sub = data.get("snapSubdivisionInches", 0.25)
    if not isinstance(snap_sub, (int, float)) or snap_sub <= 0:
        raise ValueError("Invalid snapSubdivisionInches")

    if not isinstance(data.get("snapEnabled"), bool):
        raise ValueError("snapEnabled must be boolean")

    bg = data.get("background")
    if not isinstance(bg, dict):
        raise ValueError("Invalid background")
    source = bg.get("source", "none")
    if source not in _VALID_BG_SOURCES:
        raise ValueError("Invalid background.source")
    transform = bg.get("transform")
    if not isinstance(transform, dict):
        raise ValueError("Invalid background.transform")
    for key in ("x", "y", "scale", "opacity"):
        if key not in transform:
            raise ValueError(f"Missing background.transform.{key}")

    strokes = data.get("strokes")
    if not isinstance(strokes, list):
        raise ValueError("strokes must be a list")
    for stroke in strokes:
        if not isinstance(stroke, dict):
            raise ValueError("Invalid stroke")
        tool = stroke.get("tool")
        if tool not in _VALID_TOOLS:
            raise ValueError("Invalid stroke tool")
        points = stroke.get("points")
        if not isinstance(points, list):
            raise ValueError("Invalid stroke points")
        for pt in points:
            if not isinstance(pt, (list, tuple)) or len(pt) != 2:
                raise ValueError("Invalid point")
            if not all(isinstance(c, (int, float)) for c in pt):
                raise ValueError("Invalid point coordinates")

    return data


def grid_spacing_from_document(data: dict[str, Any]) -> int:
    spacing = data.get("gridSpacingInches", 3)
    return int(spacing) if spacing in _VALID_GRID_SPACING else 3
