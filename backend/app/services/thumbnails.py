"""Generate and manage WebP thumbnails co-located under .thumbs/ next to originals."""
from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError

from .job_docs_fs import absolute_file_path as doc_absolute_path
from .job_photos_fs import absolute_file_path as photo_absolute_path

logger = logging.getLogger("skipper.thumbnails")

_THUMB_MAX = 480
_WEBP_QUALITY = 80
_WEBP_METHOD = 4
_THUMBS_DIR = ".thumbs"

Kind = Literal["photo", "document"]


def photo_thumb_relpath(stored_path: str) -> str:
    sp = stored_path.replace("\\", "/")
    p = Path(sp)
    return str(p.parent / _THUMBS_DIR / f"{p.stem}.webp").replace("\\", "/")


def doc_thumb_relpath(stored_path: str) -> str:
    return photo_thumb_relpath(stored_path)  # same layout under Docs/... vs Photos/...


def _atomic_write_webp(dest: Path, im: Image.Image) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".webp.part")
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=_WEBP_QUALITY, method=_WEBP_METHOD)
    tmp.write_bytes(buf.getvalue())
    tmp.replace(dest)


def ensure_photo_thumbnail(docs_root: Path, stored_path: str) -> Path | None:
    """Create thumbnail next to original if missing. Returns path or None on failure."""
    try:
        original = photo_absolute_path(docs_root, stored_path)
    except ValueError:
        logger.warning("Invalid photo stored_path for thumbnail: %s", stored_path)
        return None

    if not original.is_file():
        return None

    thumb_rel = photo_thumb_relpath(stored_path)
    try:
        thumb_abs = photo_absolute_path(docs_root, thumb_rel)
    except ValueError:
        logger.warning("Invalid thumb path for photo: %s", thumb_rel)
        return None

    if thumb_abs.is_file():
        return thumb_abs

    try:
        with Image.open(original) as im:
            im.seek(0)
            im = ImageOps.exif_transpose(im)
            im.thumbnail((_THUMB_MAX, _THUMB_MAX), Image.Resampling.LANCZOS)
            if im.mode == "RGBA":
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[3])
                im = bg
            else:
                im = im.convert("RGB")
            _atomic_write_webp(thumb_abs, im)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("Photo thumbnail failed for %s: %s", stored_path, exc)
        return None

    return thumb_abs if thumb_abs.is_file() else None


def ensure_pdf_thumbnail(docs_root: Path, stored_path: str) -> Path | None:
    """Render first PDF page to WebP thumbnail. Returns path or None on failure."""
    try:
        original = doc_absolute_path(docs_root, stored_path)
    except ValueError:
        logger.warning("Invalid document stored_path for thumbnail: %s", stored_path)
        return None

    if not original.is_file():
        return None

    thumb_rel = doc_thumb_relpath(stored_path)
    try:
        thumb_abs = doc_absolute_path(docs_root, thumb_rel)
    except ValueError:
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
        else:
            p = doc_absolute_path(docs_root, rel)
    except ValueError:
        return
    if p.is_file():
        try:
            p.unlink()
        except OSError:
            pass
