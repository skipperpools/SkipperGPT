"""Master schedule task definitions used to seed every new job."""
from __future__ import annotations

from typing import List, Tuple

# (task_key, task_label) in display / sort order.
# Matches the Skipper Pools master schedule columns.
TASK_DEFINITIONS: List[Tuple[str, str]] = [
    ("permit_application", "Permit Application"),
    ("permit_received", "Permit Received"),
    ("excavation", "Excavation"),
    ("form_steel", "Form & Steel"),
    ("qi_1", "QI 1"),
    ("shell_bonding_inspection", "Shell Bonding Inspection"),
    ("shell_steel_inspection", "Shell Steel Inspection"),
    ("rough_plumbing_inspection", "Rough Plumbing Inspection"),
    ("gunite", "Gunite"),
    ("qi_2", "QI 2"),
    ("survey", "Survey"),
    ("backfill", "Backfill"),
    ("plumbing", "Plumbing"),
    ("qi_3", "QI 3"),
    ("electrical_inspection", "PSI Inspection"),
    ("coping", "Coping"),
    ("tile", "Tile"),
    ("qi_4", "QI 4"),
    ("rail_anchor_grid_inspection", "Rail Anchor/Grid Inspection"),
    ("inspection", "Footer/Deck Inspection"),
    ("water_subdeck_installation", "Footer/Sub-Deck Installation"),
    ("paver_installation", "Paver Installation"),
    ("qi_5", "QI 5"),
    ("equipment_installation", "Equipment Installation"),
    ("equipment_wiring", "Equipment Wiring"),
    ("qi_6", "QI 6"),
    ("screen_fence", "Screen/Fence"),
    ("electric_inspection", "Electric Inspection"),
    ("safety_inspection", "Safety Inspection"),
    ("plaster", "Plaster"),
    ("startup", "Startup"),
    ("final_qi", "Final QI"),
    ("final_inspection", "Final Inspections"),
]

TASK_KEYS = {key for key, _ in TASK_DEFINITIONS}

STATUS_NOT_STARTED = "not_started"
STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETED = "completed"
STATUS_ISSUE = "issue"

VALID_ROLES = frozenset({"admin", "office", "field"})

MAX_JOB_CONTACTS = 25
DOC_CATEGORY_FIELD = "field"
DOC_CATEGORY_PERMIT = "permit"
VALID_DOC_CATEGORIES = frozenset({DOC_CATEGORY_FIELD, DOC_CATEGORY_PERMIT})

VALID_STATUSES = {
    STATUS_NOT_STARTED,
    STATUS_IN_PROGRESS,
    STATUS_COMPLETED,
    STATUS_ISSUE,
}

FEEDBACK_KIND_REQUEST = "request"
FEEDBACK_KIND_BUG = "bug"
VALID_FEEDBACK_KINDS = frozenset({FEEDBACK_KIND_REQUEST, FEEDBACK_KIND_BUG})

FEEDBACK_STATUS_OPEN = "open"
FEEDBACK_STATUS_CLOSED = "closed"
VALID_FEEDBACK_STATUS = frozenset({FEEDBACK_STATUS_OPEN, FEEDBACK_STATUS_CLOSED})

NOTIFICATION_TYPE_BILLING = "billing"
VALID_NOTIFICATION_TYPES = frozenset({NOTIFICATION_TYPE_BILLING})

# Task numbers are 1-based in user language. This set maps the requested
# billing notification steps (4, 9, 17, 24, 31) to task keys.
BILLING_NOTIFICATION_TASK_KEYS = frozenset(
    {
        TASK_DEFINITIONS[3][0],   # 4 Form & Steel
        TASK_DEFINITIONS[8][0],   # 9 Gunite
        TASK_DEFINITIONS[16][0],  # 17 Tile
        TASK_DEFINITIONS[23][0],  # 24 Equipment Installation
        TASK_DEFINITIONS[30][0],  # 31 Startup
    }
)
