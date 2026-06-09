"""Generate and manage WebP thumbnails co-located under .thumbs/ next to originals."""
from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError

from .job_docs_fs import absolute_file_path as doc_absolute_path
from .job_photos_fs import absolute_file_path as photo_absolute_path
from .job_sketches_fs import absolute_file_path as sketch_absolute_path
from .user_task_attachments_fs import absolute_file_path as task_attachment_absolute_path

logger = logging.getLogger("skipper.thumbnails")

_THUMB_MAX = 480
_DISPLAY_MAX = 1920
_WEBP_QUALITY = 80
_DISPLAY_WEBP_QUALITY = 85
_WEBP_METHOD = 4
_THUMBS_DIR = ".thumbs"
_DISPLAY_DIR = ".display"

Kind = Literal["photo", "document", "sketch"]


def _absolute_original_path(docs_root: Path, stored_path: str) -> Path | None:
    for resolver in (photo_absolute_path, doc_absolute_path, task_attachment_absolute_path):
        try:
            return resolver(docs_root, stored_path)
        except ValueError:
            continue
    return None


def _absolute_thumb_path(docs_root: Path, thumb_rel: str, stored_path: str) -> Path | None:
    if stored_path.replace("\\", "/").startswith("UserTaskAttachments/"):
        try:
            return task_attachment_absolute_path(docs_root, thumb_rel)
        except ValueError:
            return None
    if stored_path.replace("\\", "/").startswith("Photos/"):
        try:
            return photo_absolute_path(docs_root, thumb_rel)
        except ValueError:
            return None
    try:
        return doc_absolute_path(docs_root, thumb_rel)
    except ValueError:
        return None


def photo_thumb_relpath(stored_path: str) -> str:
    sp = stored_path.replace("\\", "/")
    p = Path(sp)
    return str(p.parent / _THUMBS_DIR / f"{p.stem}.webp").replace("\\", "/")


def photo_display_relpath(stored_path: str) -> str:
    sp = stored_path.replace("\\", "/")
    p = Path(sp)
    return str(p.parent / _DISPLAY_DIR / f"{p.stem}.webp").replace("\\", "/")


def doc_thumb_relpath(stored_path: str) -> str:
    return photo_thumb_relpath(stored_path)  # same layout under Docs/... vs Photos/...


def _atomic_write_webp(dest: Path, im: Image.Image, *, quality: int = _WEBP_QUALITY) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".webp.part")
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=quality, method=_WEBP_METHOD)
    tmp.write_bytes(buf.getvalue())
    tmp.replace(dest)


def _prepare_rgb_for_webp(im: Image.Image) -> Image.Image:
    if im.mode == "RGBA":
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[3])
        return bg
    return im.convert("RGB")


def ensure_photo_thumbnail(docs_root: Path, stored_path: str) -> Path | None:
    """Create thumbnail next to original if missing. Returns path or None on failure."""
    original = _absolute_original_path(docs_root, stored_path)
    if original is None:
        logger.warning("Invalid photo stored_path for thumbnail: %s", stored_path)
        return None

    if not original.is_file():
        return None

    thumb_rel = photo_thumb_relpath(stored_path)
    thumb_abs = _absolute_thumb_path(docs_root, thumb_rel, stored_path)
    if thumb_abs is None:
        logger.warning("Invalid thumb path for photo: %s", thumb_rel)
        return None

    if thumb_abs.is_file():
        return thumb_abs

    try:
        with Image.open(original) as im:
            im.seek(0)
            im = ImageOps.exif_transpose(im)
            im.thumbnail((_THUMB_MAX, _THUMB_MAX), Image.Resampling.LANCZOS)
            im = _prepare_rgb_for_webp(im)
            _atomic_write_webp(thumb_abs, im)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("Photo thumbnail failed for %s: %s", stored_path, exc)
        return None

    return thumb_abs if thumb_abs.is_file() else None


def ensure_photo_display(docs_root: Path, stored_path: str) -> Path | None:
    """Create display-size WebP next to original if missing or stale. Returns path or None."""
    try:
        original = photo_absolute_path(docs_root, stored_path)
    except ValueError:
        logger.warning("Invalid photo stored_path for display: %s", stored_path)
        return None

    if not original.is_file():
        return None

    display_rel = photo_display_relpath(stored_path)
    try:
        display_abs = photo_absolute_path(docs_root, display_rel)
    except ValueError:
        logger.warning("Invalid display path for photo: %s", display_rel)
        return None

    if display_abs.is_file():
        try:
            if original.stat().st_mtime <= display_abs.stat().st_mtime:
                return display_abs
        except OSError:
            pass
        try:
            display_abs.unlink()
        except OSError:
            pass

    try:
        with Image.open(original) as im:
            im.seek(0)
            im = ImageOps.exif_transpose(im)
            im.thumbnail((_DISPLAY_MAX, _DISPLAY_MAX), Image.Resampling.LANCZOS)
            im = _prepare_rgb_for_webp(im)
            _atomic_write_webp(display_abs, im, quality=_DISPLAY_WEBP_QUALITY)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("Photo display failed for %s: %s", stored_path, exc)
        return None

    return display_abs if display_abs.is_file() else None


def ensure_sketch_thumbnail(docs_root: Path, stored_path: str) -> Path | None:
    """Create WebP thumbnail from sketch preview PNG."""
    try:
        original = sketch_absolute_path(docs_root, stored_path)
    except ValueError:
        logger.warning("Invalid sketch stored_path for thumbnail: %s", stored_path)
        return None

    if not original.is_file():
        return None

    thumb_rel = photo_thumb_relpath(stored_path)
    try:
        thumb_abs = sketch_absolute_path(docs_root, thumb_rel)
    except ValueError:
        logger.warning("Invalid thumb path for sketch: %s", thumb_rel)
        return None

    if thumb_abs.is_file():
        try:
            if original.stat().st_mtime <= thumb_abs.stat().st_mtime:
                return thumb_abs
        except OSError:
            pass
        try:
            thumb_abs.unlink()
        except OSError:
            pass

    try:
        with Image.open(original) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((_THUMB_MAX, _THUMB_MAX), Image.Resampling.LANCZOS)
            im = _prepare_rgb_for_webp(im)
            _atomic_write_webp(thumb_abs, im)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("Sketch thumbnail failed for %s: %s", stored_path, exc)
        return None

    return thumb_abs if thumb_abs.is_file() else None


def ensure_pdf_thumbnail(docs_root: Path, stored_path: str) -> Path | None:
    """Render first PDF page to WebP thumbnail. Returns path or None on failure."""
    original = _absolute_original_path(docs_root, stored_path)
    if original is None:
        logger.warning("Invalid document stored_path for thumbnail: %s", stored_path)
        return None

    if not original.is_file():
        return None

    thumb_rel = doc_thumb_relpath(stored_path)
    thumb_abs = _absolute_thumb_path(docs_root, thumb_rel, stored_path)
    if thumb_abs is None:
        logger.warning("Invalid thumb path for document: %s", thumb_rel)
        return None

    if thumb_abs.is_file():
        return thumb_abs

    try:
        import pypdfium2 as pdfium  # noqa: PLC0415 — optional heavy import at use site
    except ImportError:
        logger.warning("pypdfium2 not installed; PDF thumbnails unavailable")
        return None

    pdf = None
    try:
        pdf = pdfium.PdfDocument(str(original))
        if len(pdf) == 0:
            return None
        page = pdf[0]
        scale = 2.0
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()
        pil_image = pil_image.convert("RGB")
        pil_image.thumbnail((_THUMB_MAX, _THUMB_MAX), Image.Resampling.LANCZOS)
        _atomic_write_webp(thumb_abs, pil_image)
    except (OSError, ValueError, RuntimeError) as exc:
        logger.warning("PDF thumbnail failed for %s: %s", stored_path, exc)
        return None
    finally:
        if pdf is not None:
            try:
                pdf.close()
            except Exception:
                pass

    return thumb_abs if thumb_abs.is_file() else None


def delete_thumbnail_for(docs_root: Path, stored_path: str, kind: Kind) -> None:
    """Remove thumbnail file if it exists (best-effort)."""
    rel = photo_thumb_relpath(stored_path)
    try:
        if kind == "photo":
            p = photo_absolute_path(docs_root, rel)
        elif kind == "sketch":
            p = sketch_absolute_path(docs_root, rel)
        else:
            p = doc_absolute_path(docs_root, rel)
    except ValueError:
        return
    if p.is_file():
        try:
            p.unlink()
        except OSError:
            pass


def delete_display_for(docs_root: Path, stored_path: str) -> None:
    """Remove photo display file if it exists (best-effort)."""
    rel = photo_display_relpath(stored_path)
    try:
        p = photo_absolute_path(docs_root, rel)
    except ValueError:
        return
    if p.is_file():
        try:
            p.unlink()
        except OSError:
            pass
