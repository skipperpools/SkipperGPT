"""Build master schedule PDF exports (Skipper Pools Schedules.pdf layout)."""
from __future__ import annotations

import io
import re
from datetime import date, datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, legal
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle

from .constants import (
    JOB_TYPE_MISC,
    JOB_TYPE_NEW_CONSTRUCTION,
    JOB_TYPE_RENOVATION,
    JOB_TYPE_SALES,
    STATUS_COMPLETED,
    STATUS_IN_PROGRESS,
    STATUS_ISSUE,
    TASK_DEFINITIONS,
)
from .models import Job, JobTask
from .services.jobs_service import _compute_progress

_FIXED_COLS = 6
_PROGRESS_YELLOW = colors.HexColor("#FFEB9C")

_SECTION_ORDER: Tuple[Tuple[str, str], ...] = (
    (JOB_TYPE_NEW_CONSTRUCTION, ""),
    (JOB_TYPE_RENOVATION, "RENOVATION PROJECTS"),
    (JOB_TYPE_MISC, "MISC. PROJECTS"),
)

_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


class _RowKind(str, Enum):
    HEADER = "header"
    SECTION = "section"
    DATA = "data"
    EMPTY = "empty"


def _header_from_task_label(label: str) -> Tuple[str, str]:
    """Split an app task label into two header lines for the PDF."""
    label = (label or "").strip()
    if not label:
        return ("", "")

    if label.startswith("QI "):
        return ("QI", label[3:].strip())

    if len(label) <= 11:
        return ("", label)

    if " & " in label:
        left, right = label.split(" & ", 1)
        return (f"{left.strip()} &", right.strip())
    if " / " in label:
        left, right = label.split(" / ", 1)
        return (left.strip(), right.strip())
    if "/" in label:
        left, right = label.split("/", 1)
        return (left.strip(), right.strip())
    if " - " in label:
        left, right = label.split(" - ", 1)
        return (left.strip(), right.strip())

    words = label.split()
    if len(words) == 2:
        return (words[0], words[1])
    if len(words) >= 3:
        mid = (len(words) + 1) // 2
        return (" ".join(words[:mid]), " ".join(words[mid:]))
    return ("", label)


def _task_header_rows() -> Tuple[List[str], List[str]]:
    line1 = [h[0] for h in (_header_from_task_label(label) for _, label in TASK_DEFINITIONS)]
    line2 = [h[1] for h in (_header_from_task_label(label) for _, label in TASK_DEFINITIONS)]
    return line1, line2


def format_task_cell(task: Optional[JobTask]) -> str:
    """Format one schedule cell from a job task (dates as M/D, notes as text)."""
    if task is None:
        return ""
    status = task.status or ""
    value = (task.value or "").strip()
    note = (task.note or "").strip()

    if status == STATUS_COMPLETED:
        if value:
            m = _ISO_DATE_RE.match(value)
            if m:
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if y != date.today().year:
                    return f"{mo}/{d}/{y % 100}"
                return f"{mo}/{d}"
            if task.completed_at:
                dt = task.completed_at
                if isinstance(dt, datetime):
                    if dt.year != date.today().year:
                        return f"{dt.month}/{dt.day}/{dt.year % 100}"
                    return f"{dt.month}/{dt.day}"
        return value or ""

    if status in (STATUS_IN_PROGRESS, STATUS_ISSUE):
        text = value or note or ""
        return text[:120] if len(text) > 120 else text

    return ""


def _completion_percent(job: Job) -> int:
    tasks = sorted(job.tasks, key=lambda t: t.sort_order)
    return _compute_progress(tasks).percent


def _task_by_key(job: Job) -> Dict[str, JobTask]:
    return {t.task_key: t for t in job.tasks}


def _progress_fill_end_index(job: Job, task_keys: Sequence[str]) -> int:
    """Last task column (0-based) to include in the yellow progress band."""
    tasks = _task_by_key(job)
    end = -1
    for i, key in enumerate(task_keys):
        task = tasks.get(key)
        if task is None:
            continue
        if task.status in (STATUS_COMPLETED, STATUS_IN_PROGRESS, STATUS_ISSUE):
            end = i
    return end


def _job_row(job: Job, row_num: int, task_keys: Sequence[str]) -> List[str]:
    tasks = _task_by_key(job)
    return [
        str(row_num),
        (job.customer_name or "").strip(),
        (job.address or "").strip(),
        (job.pool_type or "").strip(),
        (job.permit_number or "").strip(),
        (job.field_manager or "").strip(),
        *[format_task_cell(tasks.get(key)) for key in task_keys],
    ]


def _header_rows(as_of: date) -> Tuple[List[str], List[str]]:
    as_of_label = f"AS OF: {as_of.month}/{as_of.day}"
    task_line1, task_line2 = _task_header_rows()
    line1 = ["", "", "", "P or", "Permit", "Field", *task_line1]
    line2 = [as_of_label, "Job Name", "Address", "PS", "Number", "Manager", *task_line2]
    return line1, line2


def _column_count() -> int:
    return _FIXED_COLS + len(TASK_DEFINITIONS)


def _sort_jobs_by_completion(jobs: List[Job]) -> None:
    """Highest completion first (matches Overview / card grid)."""
    jobs.sort(
        key=lambda j: (
            -_completion_percent(j),
            (j.customer_name or "").lower(),
        )
    )


def _group_jobs(jobs: Sequence[Job]) -> List[Tuple[str, str, List[Job]]]:
    by_type: Dict[str, List[Job]] = {}
    for job in jobs:
        jt = job.job_type or JOB_TYPE_NEW_CONSTRUCTION
        if jt == JOB_TYPE_SALES:
            continue
        by_type.setdefault(jt, []).append(job)

    sections: List[Tuple[str, str, List[Job]]] = []
    for jt, title in _SECTION_ORDER:
        group = by_type.pop(jt, [])
        if not group:
            continue
        _sort_jobs_by_completion(group)
        sections.append((jt, title, group))

    for jt in sorted(by_type.keys()):
        group = by_type[jt]
        _sort_jobs_by_completion(group)
        sections.append((jt, jt.replace("_", " ").upper(), group))

    return sections


def build_schedule_pdf(jobs: Sequence[Job], *, as_of: Optional[date] = None) -> bytes:
    """Render jobs as a landscape master-schedule PDF."""
    as_of = as_of or date.today()
    task_keys = [key for key, _ in TASK_DEFINITIONS]
    col_count = _column_count()
    line1, line2 = _header_rows(as_of)

    table_data: List[List[str]] = []
    row_kinds: List[_RowKind] = []
    section_span_rows: List[int] = []
    header_row_indices: List[int] = []
    data_row_jobs: List[Tuple[int, Job]] = []

    def _append_header() -> None:
        header_row_indices.extend([len(table_data), len(table_data) + 1])
        table_data.append(line1)
        row_kinds.append(_RowKind.HEADER)
        table_data.append(line2)
        row_kinds.append(_RowKind.HEADER)

    _append_header()

    sections = _group_jobs(jobs)
    if not sections:
        table_data.append(["No jobs to export"] + [""] * (col_count - 1))
        row_kinds.append(_RowKind.EMPTY)
    else:
        for _jt, section_title, group in sections:
            if section_title:
                section_span_rows.append(len(table_data))
                table_data.append([section_title] + [""] * (col_count - 1))
                row_kinds.append(_RowKind.SECTION)
                _append_header()

            for i, job in enumerate(group, start=1):
                data_row_jobs.append((len(table_data), job))
                table_data.append(_job_row(job, i, task_keys))
                row_kinds.append(_RowKind.DATA)

    buf = io.BytesIO()
    page_w, page_h = landscape(legal)
    doc = SimpleDocTemplate(
        buf,
        pagesize=(page_w, page_h),
        leftMargin=0.25 * inch,
        rightMargin=0.25 * inch,
        topMargin=0.35 * inch,
        bottomMargin=0.35 * inch,
    )

    usable_w = page_w - doc.leftMargin - doc.rightMargin
    n_task = len(TASK_DEFINITIONS)
    fixed_w = usable_w * 0.28
    task_w = (usable_w - fixed_w) / max(n_task, 1)
    col_widths = [
        usable_w * 0.025,
        usable_w * 0.09,
        usable_w * 0.09,
        usable_w * 0.025,
        usable_w * 0.055,
        usable_w * 0.04,
    ] + [task_w] * n_task

    cell_style = ParagraphStyle(
        "ScheduleCell",
        fontName="Helvetica",
        fontSize=6.5,
        leading=7.5,
    )
    header_style = ParagraphStyle(
        "ScheduleHeader",
        fontName="Helvetica-Bold",
        fontSize=6.5,
        leading=7.5,
        alignment=1,
    )

    def _para(text: str, kind: _RowKind) -> Paragraph:
        safe = (text or "").replace("&", "&amp;").replace("<", "&lt;")
        if kind in (_RowKind.HEADER, _RowKind.SECTION):
            return Paragraph(safe or " ", header_style)
        return Paragraph(safe or " ", cell_style)

    wrapped = [
        [_para(str(c), row_kinds[r]) for c in row]
        for r, row in enumerate(table_data)
    ]

    table = Table(wrapped, colWidths=col_widths, repeatRows=2)
    style_commands: List[Tuple[Any, ...]] = [
        ("FONTSIZE", (0, 0), (-1, -1), 6.5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (3, 0), (5, -1), "CENTER"),
    ]

    for h_idx in header_row_indices:
        style_commands.append(
            ("BACKGROUND", (0, h_idx), (-1, h_idx), colors.HexColor("#e8eef3"))
        )

    for span_row in section_span_rows:
        style_commands.extend(
            [
                ("SPAN", (0, span_row), (-1, span_row)),
                ("BACKGROUND", (0, span_row), (-1, span_row), colors.HexColor("#d0dce8")),
                ("FONTNAME", (0, span_row), (-1, span_row), "Helvetica-Bold"),
                ("FONTSIZE", (0, span_row), (-1, span_row), 8),
                ("ALIGN", (0, span_row), (-1, span_row), "CENTER"),
            ]
        )

    last_task_col = _FIXED_COLS + len(task_keys) - 1
    for row_idx, job in data_row_jobs:
        end = _progress_fill_end_index(job, task_keys)
        if end >= 0:
            style_commands.append(
                (
                    "BACKGROUND",
                    (_FIXED_COLS, row_idx),
                    (min(_FIXED_COLS + end, last_task_col), row_idx),
                    _PROGRESS_YELLOW,
                )
            )

    table.setStyle(TableStyle(style_commands))
    doc.build([table])
    return buf.getvalue()
