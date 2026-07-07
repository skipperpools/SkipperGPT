/* ============================================================
   Skipper Pools - Job Card Dashboard (vanilla JS)
   Talks only to /api/* routes; never accesses the DB directly.
   ============================================================ */

const API = "/api";
const TOKEN_KEY = "access_token";
let _sessionExpired = false;
let _sessionReloadTimer = null;

const state = {
  token: null,
  user: null,
  includeArchived: false,
  jobs: [],
  jobsById: new Map(),
  filter: "",
  jobTypeFilter: "all",
  /** @type {"cards" | "overview"} */
  view: "cards",
  notifications: [],
  billingUnbilledCount: 0,
  assignedOpenCount: 0,
  creatorUnreadCount: 0,
  assignableUsers: [],
  pushEnabled: false,
  /** @type {Array<{id:number,label?:string,name?:string,phone?:string,email?:string}>} */
  contactsCatalog: [],
  /** @type {number|null} job whose card should show details after a full grid rerender */
  activeDetailJobId: null,
  /** when true with activeDetailJobId, restore flipped card without modal overlay (see keepCardOpenWithoutOverlay) */
  activeDetailNoOverlay: false,
  /** Admin nested tasks modal: user whose list is being edited */
  adminTasksUserId: null,
  adminTasksUsername: null,
  /** @type {"all" | "assigned" | "own"} filter applied to the "My tasks" list */
  userTasksMineFilter: "all",
};

const POLL_BASE_INTERVAL_MS = 5000;
const POLL_MAX_BACKOFF_MS = 60000;

const poller = {
  timerId: null,
  active: false,
  channels: {
    jobs: { inFlight: false, failCount: 0, lastSig: "" },
    notifications: { inFlight: false, failCount: 0, lastSig: "" },
    notificationCounts: { inFlight: false, failCount: 0, lastSig: "" },
    feedbackMine: { inFlight: false, failCount: 0, lastSig: "" },
    feedbackAll: { inFlight: false, failCount: 0, lastSig: "" },
    userTasksMine: { inFlight: false, failCount: 0, lastSig: "" },
    userTasksAll: { inFlight: false, failCount: 0, lastSig: "" },
    users: { inFlight: false, failCount: 0, lastSig: "" },
    contacts: { inFlight: false, failCount: 0, lastSig: "" },
  },
};

const JOB_TYPE_LABELS = {
  all: "All",
  sales: "Sales",
  new_construction: "New Construction",
  renovation: "Renovation",
  misc: "Misc.",
};

const docsModalState = {
  jobId: null,
};

const contactsModalState = {
  jobId: null,
};

const photosModalState = {
  jobId: null,
  selectedIndex: 0,
};

const sketchesModalState = {
  jobId: null,
  selectedSketchId: null,
};

const notesModalState = {
  jobId: null,
};

const photoViewerState = {
  objectUrl: null,
  loadSeq: 0,
  /** @type {number|null} */
  jobId: null,
  /** @type {number|null} */
  photoIndex: null,
};

const photoViewerGesture = {
  scale: 1,
  tx: 0,
  ty: 0,
  pinchStartDist: 0,
  pinchStartScale: 1,
  panning: false,
  lastClientX: 0,
  lastClientY: 0,
  mousePanning: false,
  /** Largest number of simultaneous touches in the current gesture (for swipe vs pinch). */
  maxTouchesInGesture: 0,
  swipeStartX: 0,
  swipeStartY: 0,
  swipeTouchId: 0,
  /** Ignore synthetic clicks shortly after a swipe navigation (mobile). */
  ignoreNextClickUntil: 0,
};

// Card-back thumbnail grid: 4 columns x 2 rows.
const VISIBLE_PHOTO_COUNT = 8;
const VISIBLE_SKETCH_COUNT = 4;
/** Latest note with text shown on the unflipped card front. */
const RECENT_JOB_NOTES_COUNT = 1;
/** Max chars per feed note body on the card front. */
const RECENT_JOB_NOTE_BODY_MAX = 140;
/** Must match backend MAX_JOB_CONTACTS. */
const MAX_EDIT_JOB_CONTACTS = 25;

/** Ordered contact ids for Edit Job modal (shared directory). */
let editJobContactIdsOrder = [];

/** Ordered contact ids for New Job modal (shared directory). */
let newJobContactIdsOrder = [];

/** When set, New Job submission also copies custom tasks from this source job. */
let cloneFromJobId = null;

/** When set, directory form PATCHes this contact instead of POST create. */
let contactsDirectoryEditingId = null;

/** Strip zero-width chars so invisible-only bodies are not treated as displayable. */
const NOTE_BODY_INVISIBLE_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * @param {string|null|undefined} body
 * @returns {string}
 */
function normalizeNoteBody(body) {
  return String(body ?? "")
    .replace(NOTE_BODY_INVISIBLE_RE, "")
    .trim();
}

/**
 * @param {string|null|undefined} body
 * @param {number} [maxLen]
 * @returns {{ text: string, truncated: boolean, full: string }}
 */
function truncateNoteBody(body, maxLen = RECENT_JOB_NOTE_BODY_MAX) {
  const full = normalizeNoteBody(body);
  if (!full) return { text: "", truncated: false, full: "" };
  if (full.length <= maxLen) return { text: full, truncated: false, full };
  return { text: full.slice(0, maxLen) + "…", truncated: true, full };
}

/**
 * @param {{ body?: string|null }|null|undefined} note
 */
function noteHasDisplayBody(note) {
  return Boolean(normalizeNoteBody(note?.body));
}

function openNotesModalFromCard(e, job) {
  e.stopPropagation();
  openNotesModal(job);
}

function onRecentNotesPreviewKeydown(e, job) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.stopPropagation();
  openNotesModal(job);
}

/** @returns {HTMLElement} */
function renderRecentJobNotesPreview(job) {
  const allNotes = Array.isArray(job.job_notes) ? job.job_notes : [];
  const displayableNotes = allNotes.filter(noteHasDisplayBody);
  const recent = displayableNotes.slice(0, RECENT_JOB_NOTES_COUNT);
  const total = allNotes.length;
  const moreCount = displayableNotes.length - recent.length;
  const labelText =
    total > RECENT_JOB_NOTES_COUNT ? `Recent Notes (${total})` : "Recent Notes";

  const children = [el("span", { class: "card__section-label" }, labelText)];

  if (!recent.length) {
    const emptyHint =
      total > 0 ? "Notes have no text — tap to open" : "No notes yet — tap to add";
    children.push(el("p", { class: "card__recent-notes__empty-hint" }, emptyHint));
  } else {
    const list = el("ul", { class: "card__recent-notes-list" });
    for (const note of recent) {
      const authoredBy = note.author_username || `User #${note.author_user_id}`;
      const when = fmtDate(note.created_at);
      const metaBits = [authoredBy];
      if (when) metaBits.push(when);
      const bodyPreview = truncateNoteBody(note.body);
      const itemAttrs = { class: "card__recent-note" };
      if (bodyPreview.truncated && bodyPreview.full) itemAttrs.title = bodyPreview.full;
      list.appendChild(
        el("li", itemAttrs, [
          el("span", { class: "card__recent-note-meta" }, metaBits.join(" · ")),
          el("span", { class: "card__recent-note-body" }, bodyPreview.text),
        ])
      );
    }
    children.push(list);
    if (moreCount > 0) {
      children.push(
        el("span", { class: "card__recent-notes-more" }, `+${moreCount} more`)
      );
    }
  }

  const customer = job.customer_name || "job";
  return el(
    "section",
    {
      class: "card__recent-notes card__recent-notes--interactive",
      role: "button",
      tabindex: "0",
      "aria-label": `Open job notes for ${customer}`,
      onclick: (e) => openNotesModalFromCard(e, job),
      onkeydown: (e) => onRecentNotesPreviewKeydown(e, job),
    },
    children
  );
}

/** @returns {HTMLElement|null} */
function renderCardMetaCompact(job) {
  const items = [
    { label: "Permit", value: job.permit_number },
    { label: "Mgr", value: job.field_manager },
    { label: "Pool", value: job.pool_type },
    { label: "Status", value: job.permit_status },
  ].filter((item) => (item.value ?? "").trim());

  if (!items.length) return null;

  const row = el("div", { class: "card__meta-compact" });
  items.forEach((item, index) => {
    if (index > 0) row.appendChild(el("span", { class: "card__meta-sep", "aria-hidden": "true" }, "·"));
    const value = String(item.value).trim();
    row.appendChild(
      el(
        "span",
        { class: "card__meta-item", title: `${item.label}: ${value}` },
        [el("span", { class: "card__meta-k" }, `${item.label} `), value]
      )
    );
  });
  return row;
}

/**
 * @param {string|null|undefined} address
 * @returns {string} Google Maps search URL, or "" if empty after trim.
 */
function googleMapsSearchUrl(address) {
  const q = String(address ?? "").trim();
  if (!q) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function jobHasContacts(job) {
  return Array.isArray(job.contacts) && job.contacts.length > 0;
}

async function refreshContactsCatalog() {
  try {
    state.contactsCatalog = await apiClient.listContacts();
    poller.channels.contacts.lastSig = simpleSignature(state.contactsCatalog);
  } catch {
    state.contactsCatalog = [];
  }
}

function getJobContactIdsFromJob(job) {
  if (!job?.contacts?.length) return [];
  return job.contacts.map((c) => c.id).filter((id) => Number.isFinite(id));
}

function formatContactOneLine(c) {
  if (!c) return "";
  const role = c.label ? `${c.label}: ` : "";
  const main = c.name || "—";
  const tail = c.phone ? ` · ${c.phone}` : "";
  return `${role}${main}${tail}`;
}

function clearEditJobContactsPanel() {
  editJobContactIdsOrder = [];
  $("#edit-job-contact-search") && ($("#edit-job-contact-search").value = "");
  const sel = $("#edit-job-contact-selected");
  const cat = $("#edit-job-contact-catalog");
  if (sel) sel.innerHTML = "";
  if (cat) cat.innerHTML = "";
  const nw = $("#edit-job-contact-new-wrap");
  if (nw) nw.hidden = true;
}

function renderEditJobContactsPicker() {
  const selectedEl = $("#edit-job-contact-selected");
  const catalogEl = $("#edit-job-contact-catalog");
  const searchEl = $("#edit-job-contact-search");
  if (!selectedEl || !catalogEl) return;
  const q = (searchEl?.value || "").trim().toLowerCase();
  selectedEl.innerHTML = "";
  const selectedSet = new Set(editJobContactIdsOrder);

  editJobContactIdsOrder.forEach((id, idx) => {
    const c = state.contactsCatalog.find((x) => x.id === id);
    const labelText = formatContactOneLine(c) || `Contact #${id}`;
    selectedEl.appendChild(
      el("div", { class: "edit-job-contact-picked-row" }, [
        el("span", { class: "edit-job-contact-picked-label", title: labelText }, labelText),
        el("div", { class: "edit-job-contact-picked-actions" }, [
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              "aria-label": "Move up",
              disabled: idx === 0 ? true : null,
              onclick: (e) => {
                e.preventDefault();
                if (idx <= 0) return;
                const t = editJobContactIdsOrder[idx - 1];
                editJobContactIdsOrder[idx - 1] = editJobContactIdsOrder[idx];
                editJobContactIdsOrder[idx] = t;
                renderEditJobContactsPicker();
              },
            },
            "↑"
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              "aria-label": "Move down",
              disabled: idx >= editJobContactIdsOrder.length - 1 ? true : null,
              onclick: (e) => {
                e.preventDefault();
                if (idx >= editJobContactIdsOrder.length - 1) return;
                const t = editJobContactIdsOrder[idx + 1];
                editJobContactIdsOrder[idx + 1] = editJobContactIdsOrder[idx];
                editJobContactIdsOrder[idx] = t;
                renderEditJobContactsPicker();
              },
            },
            "↓"
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              "aria-label": "Remove from job",
              onclick: (e) => {
                e.preventDefault();
                editJobContactIdsOrder.splice(idx, 1);
                renderEditJobContactsPicker();
              },
            },
            "Remove"
          ),
        ]),
      ])
    );
  });

  catalogEl.innerHTML = "";
  const avail = state.contactsCatalog.filter((c) => {
    if (selectedSet.has(c.id)) return false;
    if (!q) return true;
    const hay = [c.label, c.name, c.phone, c.email].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
  if (!avail.length) {
    catalogEl.appendChild(
      el("p", { class: "edit-job-contact-catalog-empty" }, q ? "No matches." : "No more contacts to add.")
    );
    return;
  }
  for (const c of avail) {
    catalogEl.appendChild(
      el("div", { class: "edit-job-contact-catalog-row" }, [
        el("span", { class: "edit-job-contact-catalog-label" }, formatContactOneLine(c)),
        el(
          "button",
          {
            type: "button",
            class: "btn btn--primary btn--sm",
            onclick: (e) => {
              e.preventDefault();
              if (editJobContactIdsOrder.length >= MAX_EDIT_JOB_CONTACTS) {
                toast(`Maximum ${MAX_EDIT_JOB_CONTACTS} contacts per job`, "error");
                return;
              }
              if (editJobContactIdsOrder.includes(c.id)) return;
              editJobContactIdsOrder.push(c.id);
              renderEditJobContactsPicker();
            },
          },
          "Add"
        ),
      ])
    );
  }
}

function collectEditJobContactIdsPayload() {
  return editJobContactIdsOrder.slice();
}

function clearNewJobContactsPanel() {
  newJobContactIdsOrder = [];
  $("#new-job-contact-search") && ($("#new-job-contact-search").value = "");
  const sel = $("#new-job-contact-selected");
  const cat = $("#new-job-contact-catalog");
  if (sel) sel.innerHTML = "";
  if (cat) cat.innerHTML = "";
  const nw = $("#new-job-contact-new-wrap");
  if (nw) nw.hidden = true;
  for (const id of ["new-job-new-label", "new-job-new-name", "new-job-new-phone", "new-job-new-email"]) {
    const n = document.getElementById(id);
    if (n) n.value = "";
  }
}

function renderNewJobContactsPicker() {
  const selectedEl = $("#new-job-contact-selected");
  const catalogEl = $("#new-job-contact-catalog");
  const searchEl = $("#new-job-contact-search");
  if (!selectedEl || !catalogEl) return;
  const q = (searchEl?.value || "").trim().toLowerCase();
  selectedEl.innerHTML = "";
  const selectedSet = new Set(newJobContactIdsOrder);

  newJobContactIdsOrder.forEach((id, idx) => {
    const c = state.contactsCatalog.find((x) => x.id === id);
    const labelText = formatContactOneLine(c) || `Contact #${id}`;
    selectedEl.appendChild(
      el("div", { class: "edit-job-contact-picked-row" }, [
        el("span", { class: "edit-job-contact-picked-label", title: labelText }, labelText),
        el("div", { class: "edit-job-contact-picked-actions" }, [
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              "aria-label": "Move up",
              disabled: idx === 0 ? true : null,
              onclick: (e) => {
                e.preventDefault();
                if (idx <= 0) return;
                const t = newJobContactIdsOrder[idx - 1];
                newJobContactIdsOrder[idx - 1] = newJobContactIdsOrder[idx];
                newJobContactIdsOrder[idx] = t;
                renderNewJobContactsPicker();
              },
            },
            "↑"
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              "aria-label": "Move down",
              disabled: idx >= newJobContactIdsOrder.length - 1 ? true : null,
              onclick: (e) => {
                e.preventDefault();
                if (idx >= newJobContactIdsOrder.length - 1) return;
                const t = newJobContactIdsOrder[idx + 1];
                newJobContactIdsOrder[idx + 1] = newJobContactIdsOrder[idx];
                newJobContactIdsOrder[idx] = t;
                renderNewJobContactsPicker();
              },
            },
            "↓"
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              "aria-label": "Remove from job",
              onclick: (e) => {
                e.preventDefault();
                newJobContactIdsOrder.splice(idx, 1);
                renderNewJobContactsPicker();
              },
            },
            "Remove"
          ),
        ]),
      ])
    );
  });

  catalogEl.innerHTML = "";
  const avail = state.contactsCatalog.filter((c) => {
    if (selectedSet.has(c.id)) return false;
    if (!q) return true;
    const hay = [c.label, c.name, c.phone, c.email].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
  if (!avail.length) {
    catalogEl.appendChild(
      el("p", { class: "edit-job-contact-catalog-empty" }, q ? "No matches." : "No more contacts to add.")
    );
    return;
  }
  for (const c of avail) {
    catalogEl.appendChild(
      el("div", { class: "edit-job-contact-catalog-row" }, [
        el("span", { class: "edit-job-contact-catalog-label" }, formatContactOneLine(c)),
        el(
          "button",
          {
            type: "button",
            class: "btn btn--primary btn--sm",
            onclick: (e) => {
              e.preventDefault();
              if (newJobContactIdsOrder.length >= MAX_EDIT_JOB_CONTACTS) {
                toast(`Maximum ${MAX_EDIT_JOB_CONTACTS} contacts per job`, "error");
                return;
              }
              if (newJobContactIdsOrder.includes(c.id)) return;
              newJobContactIdsOrder.push(c.id);
              renderNewJobContactsPicker();
            },
          },
          "Add"
        ),
      ])
    );
  }
}

function collectNewJobContactIdsPayload() {
  return newJobContactIdsOrder.slice();
}

function closeContactsDirectoryModal() {
  const m = $("#contacts-directory-modal");
  if (m) m.hidden = true;
  contactsDirectoryEditingId = null;
}

async function openContactsDirectoryModal() {
  const modal = $("#contacts-directory-modal");
  if (!modal) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeFeedbackModal();
  closeFeedbackReviewModal();
  closeUserTasksModal();
  closeUserTasksAdminModal();
  closeNotificationsModal();
  closeDocsModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  closeNotesModal();
  modal.hidden = false;
  await refreshContactsDirectoryModal();
}

function resetContactsDirectoryForm() {
  contactsDirectoryEditingId = null;
  const ids = ["contacts-dir-label", "contacts-dir-name", "contacts-dir-phone", "contacts-dir-email"];
  for (const id of ids) {
    const eln = document.getElementById(id);
    if (eln) eln.value = "";
  }
  const title = $("#contacts-dir-form-title");
  if (title) title.textContent = "Add contact";
  const saveBtn = $("#contacts-dir-save-btn");
  if (saveBtn) saveBtn.textContent = "Save contact";
}

async function refreshContactsDirectoryModal() {
  const body = $("#contacts-directory-modal-body");
  if (!body) return;
  body.textContent = "Loading…";
  try {
    await refreshContactsCatalog();
    body.innerHTML = "";
    const formCard = el("div", { class: "contacts-dir-form-card" }, [
      el("h3", { id: "contacts-dir-form-title", class: "users-section-title" }, "Add contact"),
      el("div", { class: "contacts-dir-form-grid" }, [
        el("label", { class: "field" }, [
          el("span", {}, "Role / label"),
          el("input", {
            id: "contacts-dir-label",
            type: "text",
            maxlength: 64,
            autocomplete: "off",
          }),
        ]),
        el("label", { class: "field" }, [
          el("span", {}, "Name"),
          el("input", {
            id: "contacts-dir-name",
            type: "text",
            maxlength: 255,
            autocomplete: "off",
          }),
        ]),
        el("label", { class: "field" }, [
          el("span", {}, "Phone"),
          el("input", {
            id: "contacts-dir-phone",
            type: "text",
            maxlength: 64,
            autocomplete: "off",
          }),
        ]),
        el("label", { class: "field" }, [
          el("span", {}, "Email"),
          el("input", {
            id: "contacts-dir-email",
            type: "email",
            maxlength: 255,
            autocomplete: "off",
          }),
        ]),
      ]),
      el("div", { class: "contacts-dir-form-actions" }, [
        el(
          "button",
          {
            type: "button",
            id: "contacts-dir-save-btn",
            class: "btn btn--primary btn--sm",
            onclick: async () => {
              const payload = {};
              const lab = String($("#contacts-dir-label")?.value ?? "").trim();
              const nam = String($("#contacts-dir-name")?.value ?? "").trim();
              const ph = String($("#contacts-dir-phone")?.value ?? "").trim();
              const em = String($("#contacts-dir-email")?.value ?? "").trim();
              if (lab) payload.label = lab;
              if (nam) payload.name = nam;
              if (ph) payload.phone = ph;
              if (em) payload.email = em;
              if (!Object.keys(payload).length) {
                toast("Enter at least one field", "error");
                return;
              }
              try {
                if (contactsDirectoryEditingId != null) {
                  await apiClient.updateContact(contactsDirectoryEditingId, payload);
                  toast("Contact updated", "success");
                } else {
                  await apiClient.createContact(payload);
                  toast("Contact added", "success");
                }
                resetContactsDirectoryForm();
                await refreshContactsDirectoryModal();
                await refreshContactsCatalog();
              } catch (err) {
                toast(err.message, "error");
              }
            },
          },
          "Save contact"
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn btn--ghost btn--sm",
            onclick: () => resetContactsDirectoryForm(),
          },
          "Clear"
        ),
      ]),
    ]);
    body.appendChild(formCard);

    const table = el("table", { class: "contacts-dir-table" });
    table.appendChild(
      el("thead", {}, [
        el("tr", {}, ["Role", "Name", "Phone", "Email", ""].map((h) => el("th", {}, h))),
      ])
    );
    const tb = el("tbody");
    for (const c of state.contactsCatalog) {
      tb.appendChild(
        el("tr", {}, [
          el("td", {}, c.label || "—"),
          el("td", {}, c.name || "—"),
          el("td", {}, c.phone || "—"),
          el("td", {}, c.email || "—"),
          el(
            "td",
            { class: "contacts-dir-actions" },
            [
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn--ghost btn--sm",
                  onclick: () => {
                    contactsDirectoryEditingId = c.id;
                    const title = $("#contacts-dir-form-title");
                    if (title) title.textContent = "Edit contact";
                    const saveBtn = $("#contacts-dir-save-btn");
                    if (saveBtn) saveBtn.textContent = "Update contact";
                    const setv = (id, v) => {
                      const n = document.getElementById(id);
                      if (n) n.value = v ?? "";
                    };
                    setv("contacts-dir-label", c.label);
                    setv("contacts-dir-name", c.name);
                    setv("contacts-dir-phone", c.phone);
                    setv("contacts-dir-email", c.email);
                    document.getElementById("contacts-dir-label")?.focus();
                  },
                },
                "Edit"
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn--ghost btn--sm",
                  onclick: async () => {
                    if (!confirm(`Remove ${c.name || c.label || "this contact"} from directory?`)) return;
                    try {
                      await apiClient.deleteContact(c.id);
                      toast("Contact deleted", "success");
                      if (contactsDirectoryEditingId === c.id) resetContactsDirectoryForm();
                      await refreshContactsDirectoryModal();
                      await refreshContactsCatalog();
                    } catch (err) {
                      toast(err.message, "error");
                    }
                  },
                },
                "Delete"
              ),
            ]
          ),
        ])
      );
    }
    table.appendChild(tb);
    body.appendChild(el("h3", { class: "users-section-title" }, "All contacts"));
    body.appendChild(table);
  } catch (err) {
    body.textContent = "";
    body.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

// Photos are immutable per id (delete-then-reupload yields a new id), so we
// can safely cache object URLs by photo id and reuse them across re-renders.
// We don't actively revoke; the office-app session is short-lived and the
// leak is bounded by the number of distinct photos viewed.
const photoThumbUrlCache = new Map();
const docThumbUrlCache = new Map();
const sketchThumbUrlCache = new Map();
const THUMB_FETCH_CONCURRENCY = 6;
let thumbFetchActive = 0;
const thumbFetchQueue = [];

function runThumbFetchQueue() {
  while (thumbFetchActive < THUMB_FETCH_CONCURRENCY && thumbFetchQueue.length) {
    thumbFetchActive += 1;
    const job = thumbFetchQueue.shift();
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        thumbFetchActive -= 1;
        runThumbFetchQueue();
      });
  }
}

function enqueueThumbFetch(run) {
  return new Promise((resolve, reject) => {
    thumbFetchQueue.push({ run, resolve, reject });
    runThumbFetchQueue();
  });
}

async function getPhotoThumbUrl(jobId, photo) {
  const cached = photoThumbUrlCache.get(photo.id);
  if (cached) return cached;
  return enqueueThumbFetch(async () => {
    const hit = photoThumbUrlCache.get(photo.id);
    if (hit) return hit;
    const blob = await apiClient.fetchJobPhotoThumbBlob(jobId, photo.id);
    const url = URL.createObjectURL(blob);
    photoThumbUrlCache.set(photo.id, url);
    return url;
  });
}

async function getDocThumbUrl(jobId, doc) {
  const cached = docThumbUrlCache.get(doc.id);
  if (cached) return cached;
  return enqueueThumbFetch(async () => {
    const hit = docThumbUrlCache.get(doc.id);
    if (hit) return hit;
    const blob = await apiClient.fetchJobDocumentThumbBlob(jobId, doc.id);
    const url = URL.createObjectURL(blob);
    docThumbUrlCache.set(doc.id, url);
    return url;
  });
}

function invalidateSketchThumbCache(sketchId) {
  const url = sketchThumbUrlCache.get(sketchId);
  if (url) URL.revokeObjectURL(url);
  sketchThumbUrlCache.delete(sketchId);
}

async function getSketchThumbUrl(jobId, sketch) {
  const cached = sketchThumbUrlCache.get(sketch.id);
  if (cached) return cached;
  return enqueueThumbFetch(async () => {
    const hit = sketchThumbUrlCache.get(sketch.id);
    if (hit) return hit;
    const blob = await apiClient.fetchJobSketchThumbBlob(jobId, sketch.id);
    const url = URL.createObjectURL(blob);
    sketchThumbUrlCache.set(sketch.id, url);
    return url;
  });
}

function loadLazyThumbIntoImg(img, { retry = false } = {}) {
  if (!img || img.src) return;
  if (img.dataset.thumbLoading === "1") return;
  const kind = img.dataset.lazyThumb;
  const jobId = Number(img.dataset.jobId);
  const itemId = Number(img.dataset.itemId);
  if (!kind || !jobId || !itemId) return;
  img.dataset.thumbLoading = "1";
  const load =
    kind === "photo"
      ? getPhotoThumbUrl(jobId, { id: itemId })
      : kind === "sketch"
        ? getSketchThumbUrl(jobId, { id: itemId })
        : getDocThumbUrl(jobId, { id: itemId });
  load
    .then((url) => {
      delete img.dataset.thumbLoading;
      if (!img.isConnected) return;
      img.src = url;
      img.dataset.thumbLoaded = "1";
    })
    .catch(() => {
      delete img.dataset.thumbLoaded;
      delete img.dataset.thumbLoading;
      if (!retry && img.isConnected) loadLazyThumbIntoImg(img, { retry: true });
    });
}

function loadCardBackThumbnails(jobId) {
  const card = getCardById(jobId);
  if (!card) return;
  const back = card.querySelector(".face--back");
  if (!back) return;
  for (const img of back.querySelectorAll("img[data-lazy-thumb]")) {
    loadLazyThumbIntoImg(img);
  }
}

const MOBILE_CARD_QUERY = "(max-width: 639px)";
const MOBILE_USER_MENU_QUERY = "(max-width: 900px)";

let ignoreNextMobileCardPopstate = false;
let mobileCardPopstateWired = false;
let photosModalDocDropWired = false;
let modalHandlersWired = false;

// ---- Tiny helpers --------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    if (key === "class") node.className = val;
    else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(val)) node.dataset[dk] = dv;
    } else if (key.startsWith("on") && typeof val === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === "html") {
      node.innerHTML = val;
    } else if (val === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, val);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function toast(message, kind = "info") {
  const wrap = $("#toasts");
  if (!wrap) return;
  const t = el("div", { class: `toast toast--${kind}` }, message);
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.transition = "opacity .25s ease";
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 250);
  }, 3500);
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function photoLocalDateKey(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return "";
  }
}

function photoUploadedAtMs(photo) {
  if (!photo?.uploaded_at) return 0;
  const t = new Date(photo.uploaded_at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Newest uploads first; matches card/modal grouping order. */
function getJobPhotosOrdered(job) {
  const photos = Array.isArray(job?.photos) ? job.photos.slice() : [];
  return photos.sort((a, b) => {
    const ta = photoUploadedAtMs(a);
    const tb = photoUploadedAtMs(b);
    if (tb !== ta) return tb - ta;
    return (b.id || 0) - (a.id || 0);
  });
}

function groupPhotosByUploadDate(photos) {
  const groups = [];
  const byKey = new Map();
  for (const photo of photos) {
    const key = photoLocalDateKey(photo.uploaded_at) || "__unknown__";
    const label =
      key === "__unknown__" ? "Unknown date" : fmtDate(photo.uploaded_at) || "Unknown date";
    if (!byKey.has(key)) {
      const group = { key, label, photos: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).photos.push(photo);
  }
  return groups;
}

function fmtDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function feedbackKindLabel(kind) {
  return kind === "bug" ? "Bug" : "Request";
}

function isoToDateInput(iso) {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/** Display ISO date (YYYY-MM-DD) as MM/DD/YYYY for task inputs. */
function isoToUsMdy(iso) {
  const ymd = isoToDateInput(iso);
  if (!ymd) return "";
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function taskDateCanonical(task) {
  const iso = isoToDateInput(task.value || task.completed_at);
  return iso || null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse manual task date: empty clears; accepts MM/DD/YYYY (US) or YYYY-MM-DD. */
function parseManualTaskDate(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return { ok: true, value: null };

  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidYmd(y, mo, d)) return { ok: true, value: `${y}-${pad2(mo)}-${pad2(d)}` };
    return { ok: false, message: "Invalid date" };
  }

  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (isValidYmd(y, mo, d)) return { ok: true, value: `${y}-${pad2(mo)}-${pad2(d)}` };
    return { ok: false, message: "Invalid date" };
  }

  return { ok: false, message: "Use MM/DD/YYYY (or YYYY-MM-DD)" };
}

function formatDocSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function getJobById(jobId) {
  return state.jobsById.get(Number(jobId)) || null;
}

function jobSearchHay(job) {
  const feedNoteBits = Array.isArray(job.job_notes)
    ? job.job_notes.flatMap((n) => [n.author_username, n.body])
    : [];
  return [
    job.customer_name,
    job.address,
    job.field_manager,
    job.permit_number,
    job.permit_status,
    job.pool_type,
    job.notes,
    ...feedNoteBits,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function triggerBlobDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

function canCreateJob() {
  const r = state.user?.role;
  return r === "admin" || r === "office";
}

function canAttachJobDocs() {
  return canCreateJob();
}

function canAttachJobPhotos() {
  return Boolean(state.user?.role);
}

function canEditJobNotes() {
  // Notes are editable by any authenticated role.
  return Boolean(state.user?.role);
}

function canDeleteJobNote(note) {
  if (!note) return false;
  if (state.user?.role === "admin") return true;
  return Number(note.author_user_id) === Number(state.user?.id);
}

function canArchive() {
  return state.user?.role === "admin";
}

function canViewArchivedJobs() {
  const role = state.user?.role;
  return role === "admin" || role === "office";
}

function canEditJobAdmin() {
  const role = state.user?.role;
  return role === "admin" || role === "office";
}

function canManageUsers() {
  return state.user?.role === "admin";
}

function canViewBillingNotifications() {
  const role = state.user?.role;
  return role === "admin" || role === "office";
}

function canViewSalesJobs() {
  return state.user?.role !== "field";
}

function closeUserMenu() {
  const menu = $("#user-menu");
  const btn = $("#user-menu-btn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function isMobileUserMenuViewport() {
  return window.matchMedia(MOBILE_USER_MENU_QUERY).matches;
}

function closeMobileUserMenu() {
  const modal = $("#mobile-user-menu-modal");
  const btn = $("#user-menu-btn");
  if (modal) modal.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function openMobileUserMenu() {
  const modal = $("#mobile-user-menu-modal");
  const btn = $("#user-menu-btn");
  if (!modal) return;
  closeUserMenu();
  modal.hidden = false;
  if (btn) btn.setAttribute("aria-expanded", "true");
}

function closeAllUserMenus() {
  closeUserMenu();
  closeMobileUserMenu();
}

function shouldUseMobileUserMenu(menuEl) {
  if (isMobileUserMenuViewport()) return true;
  if (!menuEl) return true;
  return window.getComputedStyle(menuEl).display === "none";
}

function syncUserMenu() {
  const userLabel = $("#user-menu-label");
  if (userLabel) userLabel.textContent = state.user?.username || "Account";
  state.pushEnabled = Boolean(state.user?.push_enabled);
  syncPushMenuLabel();
  renderUserMenuBadge();
}

function syncPushMenuLabel() {
  const label = state.pushEnabled ? "On" : "Off";
  for (const btn of $$('[data-menu-action="push-toggle"]')) {
    btn.textContent = `Push notifications: ${label}`;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function registerPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("Push notifications are not supported in this browser", "error");
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("Push notifications were not enabled", "error");
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const vapid = await apiClient.getVapidPublicKey();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid.public_key),
    });
    const json = sub.toJSON();
    await apiClient.subscribePush({
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
    const res = await apiClient.setPushEnabled(true);
    state.pushEnabled = Boolean(res.push_enabled);
    if (state.user) state.user.push_enabled = state.pushEnabled;
    syncPushMenuLabel();
    return true;
  } catch (err) {
    toast(err.message || "Failed to enable push notifications", "error");
    return false;
  }
}

async function disablePushNotifications() {
  try {
    const res = await apiClient.setPushEnabled(false);
    state.pushEnabled = Boolean(res.push_enabled);
    if (state.user) state.user.push_enabled = state.pushEnabled;
    syncPushMenuLabel();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function togglePushNotifications() {
  if (state.pushEnabled) {
    await disablePushNotifications();
    toast("Push notifications disabled", "success");
    return;
  }
  const ok = await registerPushSubscription();
  if (ok) toast("Push notifications enabled", "success");
}

function maybePromptPushOnAssignment() {
  const key = "skipper_push_assignment_prompt";
  if (localStorage.getItem(key) === "1" || state.pushEnabled) return;
  if (!window.confirm("Enable push notifications for task updates?")) {
    localStorage.setItem(key, "1");
    return;
  }
  localStorage.setItem(key, "1");
  registerPushSubscription();
}

function setNotificationsState(items) {
  state.notifications = Array.isArray(items) ? items : [];
}

function setNotificationCounts(counts) {
  state.billingUnbilledCount = Number(counts?.billing_unbilled_count || 0);
  state.assignedOpenCount = Number(counts?.assigned_open_count || 0);
  state.creatorUnreadCount = Number(counts?.creator_unread_count || 0);
  renderUserMenuBadge();
}

function taskBadgeCount() {
  return state.assignedOpenCount + state.creatorUnreadCount;
}

function channelBackoffMs(ch) {
  const exp = Math.max(0, Number(ch.failCount || 0));
  return Math.min(POLL_MAX_BACKOFF_MS, POLL_BASE_INTERVAL_MS * (2 ** exp));
}

function isChannelDue(ch) {
  const now = Date.now();
  if (!ch.nextRunAt || now >= ch.nextRunAt) return true;
  return false;
}

function markChannelSuccess(ch) {
  ch.failCount = 0;
  ch.nextRunAt = Date.now() + POLL_BASE_INTERVAL_MS;
}

function markChannelFailure(ch) {
  ch.failCount = Math.min(6, Number(ch.failCount || 0) + 1);
  ch.nextRunAt = Date.now() + channelBackoffMs(ch);
}

function jobSignatureFields(job) {
  return {
    id: job.id,
    archived: job.archived,
    updated_at: job.updated_at,
    permit_status: job.permit_status,
    notes: job.notes,
    tasks: Array.isArray(job.tasks)
      ? job.tasks.map((t) => [t.id, t.status, t.value, t.note, t.completed_at, t.completed_by, t.sort_order])
      : [],
    documents: Array.isArray(job.documents)
      ? job.documents.map((d) => [d.id, d.title, d.uploaded_at, d.category, d.size_bytes])
      : [],
    photos: Array.isArray(job.photos) ? job.photos.map((p) => [p.id, p.uploaded_at, p.size_bytes]) : [],
    contacts: Array.isArray(job.contacts)
      ? job.contacts.map((c) => [c.id, c.label, c.name, c.phone, c.email])
      : [],
    job_notes: Array.isArray(job.job_notes)
      ? job.job_notes.map((n) => [n.id, n.author_user_id, n.created_at, n.body])
      : [],
  };
}

function jobSignature(job) {
  return JSON.stringify(jobSignatureFields(job));
}

function jobsSignature(list) {
  if (!Array.isArray(list)) return "";
  return JSON.stringify(list.map(jobSignatureFields));
}

function syncJobsPollSignature() {
  poller.channels.jobs.lastSig = jobsSignature(state.jobs);
}

function syncJobsFromPoll(jobs) {
  const newIds = jobs.map((j) => j.id).sort((a, b) => a - b);
  const oldIds = state.jobs.map((j) => j.id).sort((a, b) => a - b);
  const structuralChange =
    newIds.length !== oldIds.length || newIds.some((id, i) => id !== oldIds[i]);

  if (structuralChange) {
    state.jobs = jobs;
    state.jobsById = new Map(jobs.map((j) => [j.id, j]));
    renderAll();
    return;
  }

  const oldSigById = new Map(state.jobs.map((j) => [j.id, jobSignature(j)]));
  state.jobs = jobs;
  state.jobsById = new Map(jobs.map((j) => [j.id, j]));

  for (const job of jobs) {
    if (oldSigById.get(job.id) !== jobSignature(job)) {
      replaceJob(job);
    }
  }
}

function simpleSignature(list) {
  if (!Array.isArray(list)) return "";
  return JSON.stringify(list);
}

function refreshOpenJobBoundModalsAfterSync() {
  const docsModal = $("#docs-modal");
  if (docsModal && !docsModal.hidden && docsModalState.jobId != null) {
    const j = getJobById(docsModalState.jobId);
    if (j) renderDocsModalContent(j);
  }
  const contactsModal = $("#contacts-modal");
  if (contactsModal && !contactsModal.hidden && contactsModalState.jobId != null) {
    const j = getJobById(contactsModalState.jobId);
    if (j) renderContactsModalContent(j);
  }
  const photosModal = $("#photos-modal");
  if (photosModal && !photosModal.hidden && photosModalState.jobId != null) {
    const j = getJobById(photosModalState.jobId);
    if (j) renderPhotosModalContent(j);
  }
  const notesModal = $("#notes-modal");
  if (notesModal && !notesModal.hidden && notesModalState.jobId != null) {
    const j = getJobById(notesModalState.jobId);
    if (j) renderNotesModalContent(j);
  }
}

async function pollJobsChannel() {
  const ch = poller.channels.jobs;
  if (ch.inFlight || !isChannelDue(ch)) return;
  ch.inFlight = true;
  try {
    const jobs = await apiClient.listJobs();
    const sig = jobsSignature(jobs);
    if (sig !== ch.lastSig) {
      ch.lastSig = sig;
      syncJobsFromPoll(jobs);
      refreshOpenJobBoundModalsAfterSync();
    }
    markChannelSuccess(ch);
  } catch {
    markChannelFailure(ch);
  } finally {
    ch.inFlight = false;
  }
}

async function pollNotificationCountsChannel() {
  const ch = poller.channels.notificationCounts;
  if (ch.inFlight || !isChannelDue(ch)) return;
  ch.inFlight = true;
  try {
    const counts = await apiClient.notificationCounts();
    const sig = simpleSignature([
      counts.billing_unbilled_count,
      counts.assigned_open_count,
      counts.creator_unread_count,
    ]);
    if (sig !== ch.lastSig) {
      ch.lastSig = sig;
      setNotificationCounts(counts);
    }
    markChannelSuccess(ch);
  } catch {
    markChannelFailure(ch);
  } finally {
    ch.inFlight = false;
  }
}

async function pollNotificationsChannel() {
  if (!canViewBillingNotifications()) return;
  const modal = $("#notifications-modal");
  if (!modal || modal.hidden) return;
  const ch = poller.channels.notifications;
  if (ch.inFlight || !isChannelDue(ch)) return;
  ch.inFlight = true;
  try {
    const items = await apiClient.listNotifications();
    const sig = simpleSignature(items);
    if (sig !== ch.lastSig) {
      ch.lastSig = sig;
      setNotificationsState(items);
      await refreshNotificationsModal();
    }
    markChannelSuccess(ch);
  } catch {
    markChannelFailure(ch);
  } finally {
    ch.inFlight = false;
  }
}

function userTasksSignature(items) {
  return simpleSignature(
    (items ?? []).map((t) => [
      t.id,
      t.title,
      t.completed,
      t.note,
      t.sort_order,
      t.is_pinned,
      t.category,
      t.assignee_id,
      t.user_id,
      (t.attachments ?? []).length,
    ])
  );
}

async function pollUserTasksChannel() {
  const mine = poller.channels.userTasksMine;
  if (!mine.inFlight && isChannelDue(mine)) {
    mine.inFlight = true;
    try {
      const items = await apiClient.listMyUserTasks();
      const sig = userTasksSignature(items);
      if (sig !== mine.lastSig) {
        mine.lastSig = sig;
        const modal = $("#user-tasks-modal");
        if (modal && !modal.hidden) {
          await refreshUserTasksMineList();
          await refreshUserTasksCreatedList();
        }
      }
      markChannelSuccess(mine);
    } catch {
      markChannelFailure(mine);
    } finally {
      mine.inFlight = false;
    }
  }

  if (!canManageUsers()) return;
  const all = poller.channels.userTasksAll;
  if (all.inFlight || !isChannelDue(all)) return;
  const modal = $("#user-tasks-admin-modal");
  const userId = state.adminTasksUserId;
  if (!modal || modal.hidden || !userId) return;
  all.inFlight = true;
  try {
    const items = await apiClient.listAllUserTasks(userId);
    const sig = userTasksSignature(items);
    if (sig !== all.lastSig) {
      all.lastSig = sig;
      await refreshUserTasksAdminList();
    }
    markChannelSuccess(all);
  } catch {
    markChannelFailure(all);
  } finally {
    all.inFlight = false;
  }
}

async function pollFeedbackChannel() {
  const mine = poller.channels.feedbackMine;
  if (!mine.inFlight && isChannelDue(mine)) {
    mine.inFlight = true;
    try {
      const items = await apiClient.listMyFeedback();
      const sig = simpleSignature(items);
      if (sig !== mine.lastSig) {
        mine.lastSig = sig;
        const modal = $("#feedback-modal");
        if (modal && !modal.hidden) await refreshFeedbackMineList();
      }
      markChannelSuccess(mine);
    } catch {
      markChannelFailure(mine);
    } finally {
      mine.inFlight = false;
    }
  }

  if (!canManageUsers()) return;
  const all = poller.channels.feedbackAll;
  if (all.inFlight || !isChannelDue(all)) return;
  all.inFlight = true;
  try {
    const items = await apiClient.listAllFeedback();
    const sig = simpleSignature(items);
    if (sig !== all.lastSig) {
      all.lastSig = sig;
      const modal = $("#feedback-review-modal");
      if (modal && !modal.hidden) await refreshFeedbackReviewModal();
    }
    markChannelSuccess(all);
  } catch {
    markChannelFailure(all);
  } finally {
    all.inFlight = false;
  }
}

async function pollUsersChannel() {
  if (!canManageUsers()) return;
  const ch = poller.channels.users;
  if (ch.inFlight || !isChannelDue(ch)) return;
  ch.inFlight = true;
  try {
    const users = await apiClient.listUsers();
    const sig = simpleSignature(users);
    if (sig !== ch.lastSig) {
      ch.lastSig = sig;
      const modal = $("#users-modal");
      if (modal && !modal.hidden) await refreshUsersModal();
    }
    markChannelSuccess(ch);
  } catch {
    markChannelFailure(ch);
  } finally {
    ch.inFlight = false;
  }
}

async function pollContactsChannel() {
  const ch = poller.channels.contacts;
  if (ch.inFlight || !isChannelDue(ch)) return;
  ch.inFlight = true;
  try {
    const contacts = await apiClient.listContacts();
    const sig = simpleSignature(contacts);
    if (sig !== ch.lastSig) {
      ch.lastSig = sig;
      state.contactsCatalog = contacts;
      const directoryModal = $("#contacts-directory-modal");
      if (directoryModal && !directoryModal.hidden) {
        await refreshContactsDirectoryModal();
      }
    }
    markChannelSuccess(ch);
  } catch {
    markChannelFailure(ch);
  } finally {
    ch.inFlight = false;
  }
}

async function runPollCycle() {
  if (!poller.active || document.hidden || !state.token) return;
  await pollJobsChannel();
  await pollNotificationCountsChannel();
  await pollNotificationsChannel();
  await pollFeedbackChannel();
  await pollUserTasksChannel();
  await pollUsersChannel();
  await pollContactsChannel();
}

function scheduleNextPoll(ms = POLL_BASE_INTERVAL_MS) {
  if (poller.timerId) window.clearTimeout(poller.timerId);
  poller.timerId = window.setTimeout(async () => {
    await runPollCycle();
    if (poller.active) scheduleNextPoll(POLL_BASE_INTERVAL_MS);
  }, ms);
}

function startAppPolling() {
  if (poller.active) return;
  poller.active = true;
  scheduleNextPoll(1500);
}

function stopAppPolling() {
  poller.active = false;
  if (poller.timerId) {
    window.clearTimeout(poller.timerId);
    poller.timerId = null;
  }
}

function renderUserMenuBadge() {
  const billingBadge = $("#user-menu-badge-billing");
  const taskBadge = $("#user-menu-badge-tasks");
  const wrap = $("#user-menu-badges");
  const formatCount = (n) => (n > 99 ? "99+" : String(n));

  const billingCount = canViewBillingNotifications() ? Number(state.billingUnbilledCount || 0) : 0;
  const tasksCount = taskBadgeCount();

  if (billingBadge) {
    if (billingCount <= 0) {
      billingBadge.hidden = true;
      billingBadge.textContent = "0";
    } else {
      billingBadge.hidden = false;
      billingBadge.textContent = formatCount(billingCount);
    }
  }

  if (taskBadge) {
    if (tasksCount <= 0) {
      taskBadge.hidden = true;
      taskBadge.textContent = "0";
    } else {
      taskBadge.hidden = false;
      taskBadge.textContent = formatCount(tasksCount);
    }
  }

  if (wrap) {
    wrap.hidden = billingCount <= 0 && tasksCount <= 0;
  }
}

async function refreshNotificationCounts() {
  try {
    const counts = await apiClient.notificationCounts();
    setNotificationCounts(counts);
    poller.channels.notificationCounts.lastSig = simpleSignature([
      counts.billing_unbilled_count,
      counts.assigned_open_count,
      counts.creator_unread_count,
    ]);
  } catch {
    // Keep last known counts.
  }
}

function authHeaders() {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function cancelSessionReload() {
  if (_sessionReloadTimer != null) {
    clearTimeout(_sessionReloadTimer);
    _sessionReloadTimer = null;
  }
}

function resetSessionAuthState() {
  cancelSessionReload();
  _sessionExpired = false;
}

async function verifySessionStillValid() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return false;
  try {
    const res = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function handleUnauthorized({ sessionExpiredUI }) {
  if (!sessionExpiredUI) return;
  // Ignore stale cached 401s (common on thumbnail GETs after re-login).
  if (await verifySessionStillValid()) return;
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  if (!_sessionExpired) {
    _sessionExpired = true;
    toast("Session expired — please sign in again.", "error");
    cancelSessionReload();
    // reload() tears down the page; stopAppPolling() is only needed on deliberate logout()
    _sessionReloadTimer = setTimeout(() => {
      _sessionReloadTimer = null;
      location.reload();
    }, 800);
  }
}

function logout() {
  resetSessionAuthState();
  stopAppPolling();
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  location.reload();
}

// ---- API client ----------------------------------------------------------

async function api(path, opts = {}) {
  const { sessionExpiredUI = true, ...fetchOpts } = opts;
  const init = {
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      ...(fetchOpts.headers || {}),
    },
    ...fetchOpts,
  };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const res = await fetch(`${API}${path}`, { ...init, cache: "no-store" });
  if (res.status === 401) {
    await handleUnauthorized({ sessionExpiredUI });
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function parseFetchError(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const data = await res.json();
    if (data?.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
  } catch {
    /* ignore */
  }
  return detail;
}

async function authFetch(path, init = {}) {
  const { sessionExpiredUI = true, ...fetchInit } = init;
  const headers = { ...authHeaders(), ...(fetchInit.headers || {}) };
  const res = await fetch(`${API}${path}`, { ...fetchInit, headers, cache: "no-store" });
  if (res.status === 401) {
    await handleUnauthorized({ sessionExpiredUI });
    throw new Error("Unauthorized");
  }
  return res;
}

/** Thumbnail/file GETs must not end the session (flip loads many in parallel). */
const AUTH_FETCH_MEDIA = { sessionExpiredUI: false };

async function loginRequest(username, password) {
  const body = new URLSearchParams();
  body.set("username", username);
  body.set("password", password);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "Login failed";
    try {
      const data = await res.json();
      if (data?.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

const apiClient = {
  me: () => api("/auth/me"),
  listJobs: () => {
    const params = new URLSearchParams();
    if (canViewArchivedJobs() && state.includeArchived) {
      params.set("include_archived", "true");
    }
    const qs = params.toString();
    return api(qs ? `/jobs?${qs}` : "/jobs");
  },
  createJob: (payload) => api("/jobs", { method: "POST", body: payload }),
  updateJob: (id, payload) => api(`/jobs/${id}`, { method: "PATCH", body: payload }),
  deleteJob: (id) => api(`/jobs/${id}`, { method: "DELETE" }),
  listJobNotes: (jobId) => api(`/jobs/${jobId}/notes`),
  createJobNote: (jobId, payload) => api(`/jobs/${jobId}/notes`, { method: "POST", body: payload }),
  deleteJobNote: async (jobId, noteId) => {
    const res = await authFetch(`/jobs/${jobId}/notes/${noteId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return true;
  },
  listContacts: () => api("/contacts"),
  createContact: (payload) => api("/contacts", { method: "POST", body: payload }),
  updateContact: (id, payload) => api(`/contacts/${id}`, { method: "PATCH", body: payload }),
  deleteContact: (id) => api(`/contacts/${id}`, { method: "DELETE" }),
  addCustomTask: (id, payload) => api(`/jobs/${id}/tasks`, { method: "POST", body: payload }),
  convertSalesJob: (id, targetJobType) =>
    api(`/jobs/${id}/convert-sales`, {
      method: "POST",
      body: { target_job_type: targetJobType },
    }),
  moveJobTask: (id, taskKey, payload) =>
    api(`/jobs/${id}/tasks/${encodeURIComponent(taskKey)}/move`, {
      method: "PATCH",
      body: payload,
    }),
  deleteJobTask: (id, taskKey) =>
    api(`/jobs/${id}/tasks/${encodeURIComponent(taskKey)}`, { method: "DELETE" }),
  listTaskTemplates: (jobType) =>
    api(`/jobs/job-type-task-templates?job_type=${encodeURIComponent(jobType)}`),
  createTaskTemplate: (payload) =>
    api("/jobs/job-type-task-templates", { method: "POST", body: payload }),
  updateTask: (id, taskKey, payload) =>
    api(`/jobs/${id}/tasks/${encodeURIComponent(taskKey)}`, { method: "PATCH", body: payload }),
  listUsers: () => api("/users"),
  createUser: (payload) => api("/users", { method: "POST", body: payload }),
  updateUser: (id, payload) => api(`/users/${id}`, { method: "PATCH", body: payload }),
  deleteUser: (id) => api(`/users/${id}`, { method: "DELETE" }),
  createFeedback: (payload) => api("/feedback", { method: "POST", body: payload }),
  listMyFeedback: () => api("/feedback/mine"),
  listAllFeedback: () => api("/feedback"),
  updateFeedback: (id, payload) => api(`/feedback/${id}`, { method: "PATCH", body: payload }),
  listMyUserTasks: () => api("/user-tasks/mine"),
  listCreatedUserTasks: () => api("/user-tasks/created"),
  listAllUserTasks: (assigneeId) => {
    const q = assigneeId != null ? `?assignee_id=${encodeURIComponent(assigneeId)}` : "";
    return api(`/user-tasks${q}`);
  },
  listAssignableUsers: () => api("/users/assignable"),
  createUserTask: (payload) => api("/user-tasks", { method: "POST", body: payload }),
  updateUserTask: (id, payload) => api(`/user-tasks/${id}`, { method: "PATCH", body: payload }),
  deleteUserTask: (id) => api(`/user-tasks/${id}`, { method: "DELETE" }),
  moveUserTask: (id, direction) =>
    api(`/user-tasks/${id}/move`, { method: "PATCH", body: { direction } }),
  listUserTaskAttachments: (taskId) => api(`/user-tasks/${taskId}/attachments`),
  uploadUserTaskAttachment: async (taskId, file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await authFetch(`/user-tasks/${taskId}/attachments`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  deleteUserTaskAttachment: async (taskId, attachmentId) => {
    const res = await authFetch(`/user-tasks/${taskId}/attachments/${attachmentId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await parseFetchError(res));
  },
  fetchUserTaskAttachmentThumbUrl: async (taskId, attachmentId) => {
    const res = await authFetch(
      `/user-tasks/${taskId}/attachments/${attachmentId}/thumbnail`,
      AUTH_FETCH_MEDIA
    );
    if (!res.ok) throw new Error(await parseFetchError(res));
    return URL.createObjectURL(await res.blob());
  },
  notificationCounts: () => api("/notifications/counts"),
  listNotifications: () => api("/notifications"),
  updateNotification: (id, payload) => api(`/notifications/${id}`, { method: "PATCH", body: payload }),
  listMyTaskNotifications: () => api("/user-task-notifications/mine"),
  markTaskNotificationRead: (id) =>
    api(`/user-task-notifications/${id}`, { method: "PATCH", body: { read: true } }),
  getVapidPublicKey: () => api("/push/vapid-public-key"),
  subscribePush: (payload) => api("/push/subscribe", { method: "POST", body: payload }),
  unsubscribePush: (payload) => api("/push/subscribe", { method: "DELETE", body: payload }),
  setPushEnabled: (pushEnabled) =>
    api("/push/me/push-enabled", { method: "PATCH", body: { push_enabled: pushEnabled } }),
  uploadJobDocument: async (jobId, files, title, category = "field") => {
    const list = Array.from(files ?? []);
    if (!list.length) throw new Error("No files selected");
    const fd = new FormData();
    for (const file of list) fd.append("files", file);
    const t = String(title || "").trim();
    if (t) fd.append("title", t);
    const c = String(category || "field").trim().toLowerCase();
    const allowed = new Set(["field", "permit", "sales", "invoices"]);
    fd.append("category", allowed.has(c) ? c : "field");
    const res = await authFetch(`/jobs/${jobId}/documents`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  deleteJobDocument: async (jobId, documentId) => {
    const res = await authFetch(`/jobs/${jobId}/documents/${documentId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  updateJobDocumentTitle: (jobId, documentId, title) =>
    api(`/jobs/${jobId}/documents/${documentId}`, { method: "PATCH", body: { title } }),
  fetchJobDocumentBlob: async (jobId, documentId) => {
    const res = await authFetch(`/jobs/${jobId}/documents/${documentId}/file`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  uploadJobPhoto: async (jobId, file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await authFetch(`/jobs/${jobId}/photos`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  deleteJobPhoto: async (jobId, photoId) => {
    const res = await authFetch(`/jobs/${jobId}/photos/${photoId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  fetchJobPhotoBlob: async (jobId, photoId) => {
    const res = await authFetch(`/jobs/${jobId}/photos/${photoId}/file`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchJobPhotoDisplayBlob: async (jobId, photoId) => {
    const res = await authFetch(`/jobs/${jobId}/photos/${photoId}/display`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchJobPhotoThumbBlob: async (jobId, photoId) => {
    const res = await authFetch(`/jobs/${jobId}/photos/${photoId}/thumbnail`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchJobDocumentThumbBlob: async (jobId, documentId) => {
    const res = await authFetch(`/jobs/${jobId}/documents/${documentId}/thumbnail`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  createJobSketch: (jobId, payload) =>
    api(`/jobs/${jobId}/sketches`, { method: "POST", body: payload }),
  fetchJobSketchDocument: (jobId, sketchId) => api(`/jobs/${jobId}/sketches/${sketchId}`),
  saveJobSketch: async (jobId, sketchId, { document, preview, background, contentVersion }) => {
    const fd = new FormData();
    fd.append("document", JSON.stringify(document));
    if (contentVersion != null) fd.append("content_version", String(contentVersion));
    fd.append("preview", preview, "preview.png");
    if (background) fd.append("background", background, "background.jpg");
    const res = await authFetch(`/jobs/${jobId}/sketches/${sketchId}`, { method: "PUT", body: fd });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  renameJobSketch: (jobId, sketchId, title) =>
    api(`/jobs/${jobId}/sketches/${sketchId}`, { method: "PATCH", body: { title } }),
  deleteJobSketch: async (jobId, sketchId) => {
    const res = await authFetch(`/jobs/${jobId}/sketches/${sketchId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.json();
  },
  fetchJobSketchThumbBlob: async (jobId, sketchId) => {
    const res = await authFetch(`/jobs/${jobId}/sketches/${sketchId}/thumbnail`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchJobSketchBackgroundBlob: async (jobId, sketchId) => {
    const res = await authFetch(`/jobs/${jobId}/sketches/${sketchId}/background`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchSchedulePdfBlob: async (includeArchived = false) => {
    const params = new URLSearchParams();
    if (includeArchived) params.set("include_archived", "true");
    const qs = params.toString();
    const res = await authFetch(`/jobs/schedule.pdf${qs ? `?${qs}` : ""}`, AUTH_FETCH_MEDIA);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
};

async function uploadJobPhotosSequential(jobId, files) {
  const list = Array.from(files ?? []);
  let lastUpdated = null;
  const failed = [];
  for (const file of list) {
    try {
      lastUpdated = await apiClient.uploadJobPhoto(jobId, file);
      replaceJob(lastUpdated);
    } catch (err) {
      failed.push({ name: file.name || "file", message: err.message });
    }
  }
  return { lastUpdated, failed, total: list.length };
}

function toastJobPhotosUploadResult(result) {
  const { failed, total } = result;
  const ok = total - failed.length;
  if (total === 0) return;
  if (failed.length === 0) {
    toast(ok === 1 ? "Photo added" : `${ok} photos added`, "success");
    return;
  }
  if (ok === 0) {
    const detail =
      failed.length === 1 ? failed[0].message : `${failed.length} files failed. ${failed[0].message}`;
    toast(`Upload failed: ${detail}`, "error");
    return;
  }
  const nameSample = failed
    .slice(0, 2)
    .map((f) => f.name)
    .join(", ");
  const more = failed.length > 2 ? ` (+${failed.length - 2} more)` : "";
  toast(`Added ${ok} photo(s); ${failed.length} failed: ${nameSample}${more}`, "error");
}

// ---- Render: card front --------------------------------------------------

function renderFront(job) {
  const { progress, overall_status } = job;
  const pct = progress.percent || 0;

  const metaCompact = renderCardMetaCompact(job);
  const recentNotesBlock = renderRecentJobNotesPreview(job);

  let lastTaskValue;
  let lastTaskValueClass = "card__last-task-value";
  if (progress.latest_label) {
    const datePart = progress.latest_completed_at ? fmtDate(progress.latest_completed_at) : "";
    lastTaskValue = datePart ? `${progress.latest_label} · ${datePart}` : progress.latest_label;
  } else {
    lastTaskValue = "None yet";
    lastTaskValueClass += " card__last-task-value--empty";
  }

  const lastTaskBlock = el("div", { class: "card__last-task" }, [
    el("span", { class: "card__last-task-label" }, "Last completed"),
    el("span", { class: lastTaskValueClass }, lastTaskValue),
  ]);

  const progressBlock = el("div", { class: "card__progress" }, [
    el("div", { class: "card__progress-row" }, [
      el("strong", { class: "card__progress-count" }, `${progress.completed}/${progress.total}`),
    ]),
    el("div", { class: "progressbar" }, [
      el("div", { class: "progressbar__fill", style: `width:${pct}%` }),
    ]),
  ]);

  const badges = [
    el("span", { class: "card__status-badge" }, statusLabel(overall_status)),
    el("span", { class: "card__jobtype-badge" }, jobTypeLabel(job.job_type)),
  ];
  if (job.archived) {
    badges.push(el("span", { class: "card__archived-badge", title: "Archived" }, "Archived"));
  }

  const frontActions = [];
  if (Array.isArray(job.documents) && job.documents.length > 0) {
    frontActions.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm card__front-action-btn",
          onclick: (e) => {
            e.stopPropagation();
            openDocsModal(job.id);
          },
        },
        "Docs"
      )
    );
  }
  if (jobHasContacts(job)) {
    frontActions.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm card__front-action-btn",
          onclick: (e) => {
            e.stopPropagation();
            openContactsModal(job.id);
          },
        },
        "Contacts"
      )
    );
  }
  if (Array.isArray(job.photos) && job.photos.length > 0) {
    frontActions.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm card__front-action-btn",
          onclick: (e) => {
            e.stopPropagation();
            openPhotosModal(job.id);
          },
        },
        "Photos"
      )
    );
  }

  return el(
    "div",
    {
      class: "face face--front",
      tabindex: "0",
      role: "button",
      "aria-label": `Open job details for ${job.customer_name}`,
    },
    [
      el("div", { class: "card__badges-row" }, [
        el("div", { class: "card__badges" }, badges),
        frontActions.length ? el("div", { class: "card__front-actions" }, frontActions) : null,
      ]),
      el("h3", { class: "card__customer" }, job.customer_name),
      el("p", { class: "card__address" }, job.address || "No address"),
      recentNotesBlock,
      lastTaskBlock,
      progressBlock,
      metaCompact,
      el("div", { class: "card__hint" }, "Tap to open"),
    ]
  );
}

function statusLabel(status) {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
    case "issue":
      return "Needs attention";
    default:
      return "Not started";
  }
}

function normalizeJobType(v) {
  const raw = String(v || "").trim().toLowerCase();
  if (
    raw === "sales" ||
    raw === "new_construction" ||
    raw === "renovation" ||
    raw === "misc"
  ) return raw;
  return "new_construction";
}

function jobTypeLabel(jobType) {
  return JOB_TYPE_LABELS[normalizeJobType(jobType)] || "New Construction";
}

// ---- Job documents (PDFs) -----------------------------------------------

function docCategory(doc) {
  const c = String(doc?.category || "field").trim().toLowerCase();
  if (c === "permit" || c === "sales" || c === "invoices") return c;
  return "field";
}

function renderJobDocs(job) {
  const docs = Array.isArray(job.documents) ? job.documents : [];
  const canAttach = canAttachJobDocs();
  const fieldDocs = docs.filter((doc) => docCategory(doc) === "field");
  const permitDocs = docs.filter((doc) => docCategory(doc) === "permit");
  const salesDocs = docs.filter((doc) => docCategory(doc) === "sales");
  const invoicesDocs = docs.filter((doc) => docCategory(doc) === "invoices");

  function buildDocList(listDocs, emptyLabel) {
    const list = el("ul", { class: "job-docs__list" });
    if (!listDocs.length) {
      list.appendChild(el("li", { class: "job-docs__empty" }, emptyLabel));
      return list;
    }
    for (const doc of listDocs) {
      const metaBits = [];
      if (doc.size_bytes != null) metaBits.push(formatDocSize(doc.size_bytes));
      if (doc.uploaded_at) metaBits.push(fmtDate(doc.uploaded_at));

      const actions = [
        el(
          "button",
          {
            type: "button",
            class: "btn btn--ghost btn--sm",
            onclick: async (e) => {
              e.stopPropagation();
              try {
                const blob = await apiClient.fetchJobDocumentBlob(job.id, doc.id);
                const name = doc.original_filename || `${doc.title}.pdf`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                a.rel = "noopener";
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2500);
              } catch (err) {
                toast(`Download failed: ${err.message}`, "error");
              }
            },
          },
          "Download"
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn btn--ghost btn--sm",
            onclick: async (e) => {
              e.stopPropagation();
              try {
                const blob = await apiClient.fetchJobDocumentBlob(job.id, doc.id);
                const name = doc.original_filename || `${doc.title}.pdf`;
                const file = new File([blob], name, { type: "application/pdf" });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                  await navigator.share({
                    files: [file],
                    title: doc.title,
                    text: `${job.customer_name} — ${doc.title}`,
                  });
                } else {
                  toast("Sharing is not available on this device — use Download.", "info");
                }
              } catch (err) {
                if (err?.name === "AbortError") return;
                toast(`Share failed: ${err.message}`, "error");
              }
            },
          },
          "Share"
        ),
      ];
      if (canAttach) {
        actions.push(
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              onclick: async (e) => {
                e.stopPropagation();
                const next = prompt("Rename document:", doc.title);
                if (next == null) return;
                const trimmed = next.trim();
                if (!trimmed || trimmed === doc.title) return;
                try {
                  const updated = await apiClient.updateJobDocumentTitle(job.id, doc.id, trimmed);
                  replaceJob(updated);
                  toast("PDF renamed", "success");
                } catch (err) {
                  toast(`Rename failed: ${err.message}`, "error");
                }
              },
            },
            "Rename"
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              onclick: async (e) => {
                e.stopPropagation();
                if (!confirm(`Remove "${doc.title}"?`)) return;
                try {
                  const updated = await apiClient.deleteJobDocument(job.id, doc.id);
                  replaceJob(updated);
                  toast("PDF removed", "success");
                } catch (err) {
                  toast(`Failed: ${err.message}`, "error");
                }
              },
            },
            "Remove"
          )
        );
      }

      const thumbImg = el("img", {
        class: "job-docs__thumb",
        alt: "",
        loading: "lazy",
        decoding: "async",
        width: 40,
        height: 52,
        dataset: {
          lazyThumb: "doc",
          jobId: String(job.id),
          itemId: String(doc.id),
        },
      });

      list.appendChild(
        el("li", { class: "job-docs__item" }, [
          el("div", { class: "job-docs__item-row" }, [
            thumbImg,
            el("div", { class: "job-docs__main" }, [
              el(
                "button",
                {
                  type: "button",
                  class: "job-docs__title",
                  title: doc.original_filename || "",
                  onclick: async (e) => {
                    e.stopPropagation();
                    try {
                      const blob = await apiClient.fetchJobDocumentBlob(job.id, doc.id);
                      const url = URL.createObjectURL(blob);
                      window.open(url, "_blank", "noopener");
                      setTimeout(() => URL.revokeObjectURL(url), 45000);
                    } catch (err) {
                      toast(`Open failed: ${err.message}`, "error");
                    }
                  },
                },
                doc.title
              ),
              el("span", { class: "job-docs__meta" }, metaBits.join(" · ")),
            ]),
          ]),
          el("div", { class: "job-docs__actions" }, actions),
        ])
      );
    }
    return list;
  }

  const children = [
    el("h4", { class: "job-docs__heading" }, "Docs"),
    el("h5", { class: "job-docs__heading" }, "Field Docs"),
    buildDocList(fieldDocs, "No field PDFs yet."),
    el(
      "details",
      { class: "job-docs__accordion" },
      [
        el("summary", { class: "job-docs__accordion-summary" }, `Permit Docs (${permitDocs.length})`),
        buildDocList(permitDocs, "No permit PDFs yet."),
      ]
    ),
    el(
      "details",
      { class: "job-docs__accordion" },
      [
        el("summary", { class: "job-docs__accordion-summary" }, `Sales Docs (${salesDocs.length})`),
        buildDocList(salesDocs, "No sales PDFs yet."),
      ]
    ),
    el(
      "details",
      { class: "job-docs__accordion" },
      [
        el("summary", { class: "job-docs__accordion-summary" }, `Invoices (${invoicesDocs.length})`),
        buildDocList(invoicesDocs, "No invoice PDFs yet."),
      ]
    ),
  ];

  if (canAttach) {
    const titleInput = el("input", {
      type: "text",
      class: "job-docs__title-input",
      placeholder: "Title for upload (single PDF only, optional)",
      "aria-label": "Document title",
      onclick: (e) => e.stopPropagation(),
    });
    const fileInput = el("input", {
      type: "file",
      accept: ".pdf,application/pdf",
      multiple: true,
      class: "job-docs__file",
      "aria-label": "Choose PDF files to upload",
    });
    const categoryInput = el(
      "select",
      {
        class: "job-docs__title-input",
        "aria-label": "Document category",
        onclick: (e) => e.stopPropagation(),
      },
      [
        el("option", { value: "field" }, "Field Docs"),
        el("option", { value: "permit" }, "Permit Docs"),
        el("option", { value: "sales" }, "Sales Docs"),
        el("option", { value: "invoices" }, "Invoices"),
      ]
    );
    const uploadStatus = el(
      "div",
      { class: "job-docs__upload-status", hidden: true, "aria-live": "polite" },
      [
        el("span", { class: "upload-spinner", "aria-hidden": "true" }),
        el("span", {}, "Uploading…"),
      ]
    );
    fileInput.addEventListener("change", async () => {
      const files = fileInput.files;
      if (!files?.length) return;
      try {
        uploadStatus.hidden = false;
        fileInput.disabled = true;
        titleInput.disabled = true;
        categoryInput.disabled = true;
        const updated = await apiClient.uploadJobDocument(
          job.id,
          files,
          titleInput.value,
          categoryInput.value
        );
        replaceJob(updated);
        const count = files.length;
        titleInput.value = "";
        categoryInput.value = "field";
        toast(count === 1 ? "PDF added" : `${count} PDFs added`, "success");
      } catch (err) {
        toast(`Upload failed: ${err.message}`, "error");
      } finally {
        uploadStatus.hidden = true;
        fileInput.disabled = false;
        titleInput.disabled = false;
        categoryInput.disabled = false;
        fileInput.value = "";
      }
    });
    children.push(
      el("div", { class: "job-docs__upload", onclick: (e) => e.stopPropagation() }, [
        categoryInput,
        titleInput,
        fileInput,
        uploadStatus,
        el("span", { class: "job-docs__upload-hint" }, "PDF only — choose a file to upload."),
      ])
    );
  }

  return el("section", { class: "job-docs", "aria-label": "Job documents" }, children);
}

async function syncJobNotesAfterChange(job, afterChange) {
  const refreshed = await apiClient.listJobNotes(job.id);
  const updated = { ...job, job_notes: refreshed };
  replaceJob(updated);
  afterChange?.(updated);
  return updated;
}

/** @param {object} job @param {{ afterChange?: (job: object) => void }} [opts] */
function buildJobNotesFeedBody(job, opts = {}) {
  const { afterChange } = opts;
  const notes = Array.isArray(job.job_notes) ? job.job_notes : [];
  const body = el("div", { class: "job-notes-feed__body" });
  const list = el("ul", { class: "job-notes-feed__list" });
  if (!notes.length) {
    list.appendChild(el("li", { class: "job-notes-feed__empty" }, "No notes yet."));
  } else {
    for (const note of notes) {
      const authoredBy = note.author_username || `User #${note.author_user_id}`;
      const when = fmtDateTime(note.created_at);
      const headerBits = [authoredBy];
      if (when) headerBits.push(when);
      const row = el("li", { class: "job-notes-feed__item" }, [
        el("div", { class: "job-notes-feed__meta" }, headerBits.join(" · ")),
        el("p", { class: "job-notes-feed__text" }, note.body || ""),
      ]);
      if (canDeleteJobNote(note)) {
        row.appendChild(
          el(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--sm",
              onclick: async (e) => {
                e.stopPropagation();
                if (!confirm("Delete this note?")) return;
                try {
                  await apiClient.deleteJobNote(job.id, note.id);
                  await syncJobNotesAfterChange(job, afterChange);
                  toast("Note deleted", "success");
                } catch (err) {
                  toast(`Failed to delete note: ${err.message}`, "error");
                }
              },
            },
            "Delete"
          )
        );
      }
      list.appendChild(row);
    }
  }
  body.appendChild(list);

  if (canEditJobNotes()) {
    const textarea = el("textarea", {
      class: "job-notes-feed__composer",
      rows: "3",
      placeholder: "Add a timestamped note...",
      onclick: (e) => e.stopPropagation(),
      onkeydown: async (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.nextElementSibling?.click();
        }
      },
    });
    const submit = el(
      "button",
      {
        type: "button",
        class: "btn btn--primary btn--sm",
        onclick: async (e) => {
          e.stopPropagation();
          const bodyText = String(textarea.value || "").trim();
          if (!bodyText) {
            toast("Note cannot be empty", "error");
            return;
          }
          try {
            await apiClient.createJobNote(job.id, { body: bodyText });
            textarea.value = "";
            await syncJobNotesAfterChange(job, afterChange);
            toast("Note added", "success");
          } catch (err) {
            toast(`Failed to add note: ${err.message}`, "error");
          }
        },
      },
      "Add Note"
    );
    body.appendChild(el("div", { class: "job-notes-feed__composer-wrap" }, [textarea, submit]));
  }

  return body;
}

function renderJobNotesFeed(job) {
  const notes = Array.isArray(job.job_notes) ? job.job_notes : [];
  const feedBody = buildJobNotesFeedBody(job);
  return el("section", { class: "job-notes-feed", "aria-label": "Job notes feed" }, [
    el("details", { class: "job-notes-feed__accordion" }, [
      el("summary", { class: "job-notes-feed__accordion-summary" }, `Job Notes (${notes.length})`),
      feedBody,
    ]),
  ]);
}

function renderJobPhotos(job) {
  const ordered = getJobPhotosOrdered(job);
  const total = ordered.length;
  const hiddenCount = Math.max(0, total - VISIBLE_PHOTO_COUNT);

  const headerChildren = [
    el("h4", { class: "job-photos__heading" }, "Photos"),
    el("span", { class: "job-photos__count" }, `(${total})`),
  ];
  if (hiddenCount > 0) {
    headerChildren.push(
      el("span", { class: "job-photos__more-badge" }, `+${hiddenCount} more`)
    );
  }

  const bodyChildren = [];
  if (!total) {
    bodyChildren.push(
      el("p", { class: "job-photos__empty" }, "No photos yet — click to add.")
    );
  } else {
    const groupsWrap = el("div", { class: "job-photos__groups" });
    const dateGroups = groupPhotosByUploadDate(ordered);
    let shown = 0;
    let globalIndex = 0;
    for (const group of dateGroups) {
      if (shown >= VISIBLE_PHOTO_COUNT) break;
      const items = [];
      for (const photo of group.photos) {
        if (shown >= VISIBLE_PHOTO_COUNT) break;
        items.push({ photo, globalIndex });
        globalIndex += 1;
        shown += 1;
      }
      if (!items.length) continue;
      const groupEl = el("div", { class: "job-photos__date-group" });
      groupEl.appendChild(el("div", { class: "job-photos__date-label" }, group.label));
      const grid = el("div", { class: "job-photos__grid" });
      for (const { photo, globalIndex: idx } of items) {
        const img = el("img", {
          alt: photo.original_filename || `Photo ${idx + 1}`,
          loading: "lazy",
          decoding: "async",
          dataset: {
            lazyThumb: "photo",
            jobId: String(job.id),
            itemId: String(photo.id),
          },
        });
        const thumb = el(
          "button",
          {
            type: "button",
            class: "job-photos__thumb",
            dataset: { index: String(idx) },
            title: photo.original_filename || "",
            "aria-label": `Open ${photo.original_filename || `photo ${idx + 1}`}`,
            onclick: (e) => {
              e.stopPropagation();
              openPhotosModal(job, idx);
            },
          },
          [img]
        );
        grid.appendChild(thumb);
      }
      groupEl.appendChild(grid);
      groupsWrap.appendChild(groupEl);
    }
    bodyChildren.push(groupsWrap);
  }

  return el(
    "section",
    {
      class: "job-photos",
      role: "button",
      tabindex: "0",
      "aria-label": total
        ? `Open ${total} job photo${total === 1 ? "" : "s"}`
        : "Open job photos to add",
      onclick: () => openPhotosModal(job, 0),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPhotosModal(job, 0);
        }
      },
    },
    [
      el("div", { class: "job-photos__header" }, headerChildren),
      ...bodyChildren,
    ]
  );
}

function getJobSketchesOrdered(job) {
  return [...(job.sketches || [])].sort(
    (a, b) => new Date(b.updated_at) - new Date(a.updated_at) || b.id - a.id
  );
}

function renderJobSketches(job) {
  const ordered = getJobSketchesOrdered(job);
  const total = ordered.length;
  const hiddenCount = Math.max(0, total - VISIBLE_SKETCH_COUNT);

  const headerChildren = [
    el("h4", { class: "job-sketches__heading" }, "Sketches"),
    el("span", { class: "job-sketches__count" }, `(${total})`),
  ];
  if (hiddenCount > 0) {
    headerChildren.push(
      el("span", { class: "job-sketches__more-badge" }, `+${hiddenCount} more`)
    );
  }

  const bodyChildren = [];
  if (!total) {
    bodyChildren.push(
      el("p", { class: "job-sketches__empty" }, "No sketches yet — click to add.")
    );
  } else {
    const grid = el("div", { class: "job-sketches__grid" });
    for (let i = 0; i < Math.min(total, VISIBLE_SKETCH_COUNT); i += 1) {
      const sketch = ordered[i];
      const img = el("img", {
        alt: sketch.title || `Sketch ${i + 1}`,
        loading: "lazy",
        decoding: "async",
        dataset: {
          lazyThumb: "sketch",
          jobId: String(job.id),
          itemId: String(sketch.id),
        },
      });
      const thumb = el(
        "button",
        {
          type: "button",
          class: "job-sketches__thumb",
          title: sketch.title || "",
          "aria-label": `Open ${sketch.title || `sketch ${i + 1}`}`,
          onclick: (e) => {
            e.stopPropagation();
            openSketchesModal(job, sketch.id);
          },
        },
        [img]
      );
      grid.appendChild(thumb);
    }
    bodyChildren.push(grid);
  }

  return el(
    "section",
    {
      class: "job-sketches",
      role: "button",
      tabindex: "0",
      "aria-label": total
        ? `Open ${total} sketch${total === 1 ? "" : "es"}`
        : "Open sketches to add",
      onclick: () => openSketchesModal(job, null),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openSketchesModal(job, null);
        }
      },
    },
    [
      el("div", { class: "job-sketches__header" }, headerChildren),
      ...bodyChildren,
    ]
  );
}

function renderJobContacts(job) {
  if (!jobHasContacts(job)) return null;
  const previews = [];
  for (const c of job.contacts) {
    if (!c || typeof c !== "object") continue;
    const bits = [];
    if (c.label) bits.push(el("div", { class: "job-contacts__preview-label" }, c.label));
    const line = [c.name, c.phone, c.email].filter(Boolean).join(" · ");
    if (line) bits.push(el("div", { class: "job-contacts__preview-line" }, line));
    if (bits.length) previews.push(el("div", { class: "job-contacts__preview-item" }, bits));
  }
  return el(
    "section",
    {
      class: "job-contacts",
      role: "button",
      tabindex: "0",
      "aria-label": "Open contacts list",
      onclick: () => openContactsModal(job),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openContactsModal(job);
        }
      },
    },
    [
      el("div", { class: "job-contacts__header" }, [
        el("h4", { class: "job-contacts__heading" }, "Contacts"),
        el("span", { class: "job-contacts__count" }, `(${job.contacts.length})`),
      ]),
      el("div", { class: "job-contacts__preview" }, previews),
    ]
  );
}

// ---- Render: card back (checklist) --------------------------------------

function createTaskDragHandleIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const cy of [3, 7, 11]) {
    for (const cx of [4, 10]) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "1.35");
      svg.appendChild(circle);
    }
  }
  return svg;
}

function getTaskDragAfterElement(tasklistEl, clientY) {
  const rows = [...tasklistEl.querySelectorAll(":scope > .task:not(.task--dragging)")];
  return rows.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = clientY - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function attachTasklistDragDrop(tasklistEl, jobId) {
  if (!tasklistEl || tasklistEl.dataset.dndAttached === "1") return;
  tasklistEl.dataset.dndAttached = "1";

  let dragState = null;

  const getRows = () => [...tasklistEl.querySelectorAll(":scope > .task")];

  const clearDropTargets = () => {
    getRows().forEach((row) => row.classList.remove("task--drop-target"));
  };

  const cleanupDragUi = () => {
    if (dragState?.autoScrollId) cancelAnimationFrame(dragState.autoScrollId);
    tasklistEl.classList.remove("tasklist--dragging");
    if (dragState?.row) dragState.row.classList.remove("task--dragging");
    clearDropTargets();
  };

  const maybeAutoScroll = (clientY) => {
    const scroller = tasklistEl.closest(".back__body");
    if (!scroller) return;
    const { top, bottom } = scroller.getBoundingClientRect();
    const margin = 36;
    if (clientY < top + margin) scroller.scrollTop -= 10;
    else if (clientY > bottom - margin) scroller.scrollTop += 10;
  };

  const finishDrag = async (commit) => {
    if (!dragState) return;
    const { row, startIndex, pointerId } = dragState;
    const finalIndex = getRows().indexOf(row);
    cleanupDragUi();
    dragState = null;

    try {
      if (row?.querySelector(".task__drag-handle")?.hasPointerCapture?.(pointerId)) {
        row.querySelector(".task__drag-handle").releasePointerCapture(pointerId);
      }
    } catch (_) {
      /* ignore */
    }

    if (!commit || finalIndex < 0 || finalIndex === startIndex) {
      if (!commit) {
        const job = state.jobsById.get(jobId);
        if (job) replaceJob(job);
      }
      return;
    }

    const taskKey = row.dataset.taskKey;
    if (!taskKey) return;

    try {
      const updated = await apiClient.moveJobTask(jobId, taskKey, { target_index: finalIndex });
      replaceJob(updated);
    } catch (err) {
      toast(`Failed to move task: ${err.message}`, "error");
      const job = state.jobsById.get(jobId);
      if (job) replaceJob(job);
    }
  };

  tasklistEl.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".task__drag-handle");
    if (!handle || !tasklistEl.contains(handle)) return;
    e.preventDefault();
    e.stopPropagation();

    const row = handle.closest(".task");
    if (!row) return;

    dragState = {
      row,
      startIndex: getRows().indexOf(row),
      pointerId: e.pointerId,
      autoScrollId: null,
    };

    row.classList.add("task--dragging");
    tasklistEl.classList.add("tasklist--dragging");
    handle.setPointerCapture(e.pointerId);
  });

  tasklistEl.addEventListener("pointermove", (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const { row } = dragState;
    const afterElement = getTaskDragAfterElement(tasklistEl, e.clientY);
    clearDropTargets();
    if (afterElement) {
      afterElement.classList.add("task--drop-target");
      tasklistEl.insertBefore(row, afterElement);
    } else {
      tasklistEl.appendChild(row);
    }

    if (dragState.autoScrollId) cancelAnimationFrame(dragState.autoScrollId);
    dragState.autoScrollId = requestAnimationFrame(() => maybeAutoScroll(e.clientY));
  });

  tasklistEl.addEventListener("pointerup", (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    void finishDrag(true);
  });

  tasklistEl.addEventListener("pointercancel", (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    void finishDrag(false);
  });
}

function showCustomTaskDialog(job) {
  // Remove any existing dialog first
  $("#custom-task-dialog")?.remove();

  const labelInput = el("input", {
    type: "text",
    id: "custom-task-label",
    class: "form-input",
    placeholder: "Task label",
    maxlength: "128",
    autocomplete: "off",
  });

  const billableCheckbox = el("input", {
    type: "checkbox",
    id: "custom-task-billable",
    class: "custom-task-dialog__billable-check",
  });

  const dialog = el("div", { id: "custom-task-dialog", class: "custom-task-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Add Custom Task" }, [
    el("div", { class: "custom-task-dialog__inner" }, [
      el("h3", { class: "custom-task-dialog__title" }, "Add Custom Task"),
      el("div", { class: "custom-task-dialog__field" }, [
        el("label", { for: "custom-task-label", class: "custom-task-dialog__label" }, "Task Label"),
        labelInput,
      ]),
      el("div", { class: "custom-task-dialog__field custom-task-dialog__field--inline" }, [
        billableCheckbox,
        el("label", { for: "custom-task-billable", class: "custom-task-dialog__label" }, "Billable"),
      ]),
      el("div", { class: "custom-task-dialog__actions" }, [
        el("button", {
          type: "button",
          class: "btn btn--ghost btn--sm",
          onclick: () => dialog.remove(),
        }, "Cancel"),
        el("button", {
          type: "button",
          class: "btn btn--primary btn--sm",
          onclick: async () => {
            const taskLabel = labelInput.value.trim();
            if (!taskLabel) {
              labelInput.focus();
              return;
            }
            const isBillable = billableCheckbox.checked;
            dialog.remove();
            try {
              const updated = await apiClient.addCustomTask(job.id, {
                task_label: taskLabel,
                is_billable: isBillable,
              });
              replaceJob(updated);
              toast("Custom task added", "success");
            } catch (err) {
              toast(`Failed to add custom task: ${err.message}`, "error");
            }
          },
        }, "Add Task"),
      ]),
    ]),
  ]);

  // Close on backdrop click
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.remove();
  });

  // Submit on Enter key in label field
  labelInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dialog.querySelector(".btn--primary").click();
    }
    if (e.key === "Escape") dialog.remove();
  });

  document.body.appendChild(dialog);
  labelInput.focus();
}

function renderBack(job) {
  const list = el("ul", { class: "tasklist" });

  for (let i = 0; i < job.tasks.length; i += 1) {
    const task = job.tasks[i];
    list.appendChild(renderTaskRow(job, task, i, job.tasks.length));
  }
  if (canCreateJob()) {
    attachTasklistDragDrop(list, job.id);
  }

  const customTaskTools = canCreateJob()
    ? el("div", { class: "tasklist__tools" }, [
        el(
          "button",
          {
            type: "button",
            class: "btn btn--ghost btn--sm",
            onclick: (e) => {
              e.stopPropagation();
              showCustomTaskDialog(job);
            },
          },
          "+ Custom Task"
        ),
      ])
    : null;

  const notesEditable = canEditJobNotes();
  const notes = el("div", { class: "notes" }, [
    el("label", { for: `notes-${job.id}` }, "Job Description"),
    el("textarea", {
      id: `notes-${job.id}`,
      placeholder: "Issues, gate codes, customer preferences...",
      readonly: notesEditable ? null : true,
      disabled: notesEditable ? null : true,
      onclick: (e) => {
        e.currentTarget.closest(".notes")?.classList.add("notes--expanded");
      },
      onfocus: (e) => {
        e.currentTarget.closest(".notes")?.classList.add("notes--expanded");
      },
      onblur: async (e) => {
        if (!notesEditable) return;
        const newVal = e.target.value;
        if ((newVal || "") === (job.notes || "")) return;
        try {
          const updated = await apiClient.updateJob(job.id, { notes: newVal });
          replaceJob(updated);
          toast("Job description saved", "success");
        } catch (err) {
          toast(`Failed to save job description: ${err.message}`, "error");
        }
      },
    }, job.notes || ""),
  ]);

  const headerRight = [
    el("button", {
      type: "button",
      class: "btn btn--ghost",
      "aria-label": "Close details",
      onclick: (e) => {
        e.stopPropagation();
        flipCard(job.id, false);
      },
    }, "< Back"),
  ];
  if (canEditJobAdmin()) {
    headerRight.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost",
          title: "Edit job details",
          onclick: async (e) => {
            e.stopPropagation();
            await openEditJobModal(job);
          },
        },
        "Edit"
      )
    );
  }
  if (canCreateJob()) {
    headerRight.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost",
          title: "Clone this job with new details",
          onclick: async (e) => {
            e.stopPropagation();
            await openCloneJobModal(job);
          },
        },
        "Clone"
      )
    );
  }
  if (canCreateJob() && normalizeJobType(job.job_type) === "sales") {
    headerRight.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost",
          title: "Convert Sales job to build type",
          onclick: async (e) => {
            e.stopPropagation();
            const raw = prompt(
              "Convert Sales job to which type? Enter: new_construction, renovation, or misc",
              "new_construction"
            );
            const target = String(raw || "").trim().toLowerCase();
            if (!target) return;
            if (!["new_construction", "renovation", "misc"].includes(target)) {
              toast("Use new_construction, renovation, or misc", "error");
              return;
            }
            if (!confirm(`Convert this Sales job to ${jobTypeLabel(target)}?`)) return;
            try {
              await apiClient.convertSalesJob(job.id, target);
              await loadJobs();
              toast(`Created ${jobTypeLabel(target)} job copy`, "success");
            } catch (err) {
              toast(`Failed to convert job: ${err.message}`, "error");
            }
          },
        },
        "Convert"
      )
    );
  }
  if (canArchive()) {
    headerRight.push(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost",
          title: job.archived ? "Restore this job to the active list" : "Archive this job",
          onclick: async (e) => {
            e.stopPropagation();
            if (!job.archived && !confirm(`Archive "${job.customer_name || "this job"}"?`)) return;
            try {
              const updated = await apiClient.updateJob(job.id, { archived: !job.archived });
              toast(updated.archived ? "Job archived" : "Job restored", "success");
              flipCard(job.id, false);
              await loadJobs();
            } catch (err) {
              toast(`Failed: ${err.message}`, "error");
            }
          },
        },
        job.archived ? "Restore" : "Archive"
      )
    );
  }

  const addressTrimmed = String(job.address ?? "").trim();
  const addressValueEl = addressTrimmed
    ? el(
        "a",
        {
          class: "back__jobinfo-value back__jobinfo-value--link",
          href: googleMapsSearchUrl(job.address),
          target: "_blank",
          rel: "noopener noreferrer",
          title: job.address || "",
        },
        job.address
      )
    : el("span", { class: "back__jobinfo-value", title: "" }, "No address");

  return el("div", { class: "face face--back" }, [
    el("header", { class: "back__header" }, [
      el("div", { class: "back__header-main" }, [
        el("h3", { class: "back__title", title: job.customer_name }, job.customer_name),
        el("div", { class: "back__jobinfo" }, [
          el("p", { class: "back__jobinfo-row" }, [
            el("span", { class: "back__jobinfo-label" }, "Job Address"),
            addressValueEl,
          ]),
          el("p", { class: "back__jobinfo-row" }, [
            el("span", { class: "back__jobinfo-label" }, "Permit Number"),
            el(
              "span",
              { class: "back__jobinfo-value", title: job.permit_number || "" },
              job.permit_number || "—"
            ),
          ]),
        ]),
      ]),
      el("div", { class: "back__header-actions" }, headerRight),
    ]),
    el("div", { class: "back__body", onclick: (e) => e.stopPropagation() }, [
      notes,
      jobHasContacts(job) ? renderJobContacts(job) : null,
      renderJobDocs(job),
      renderJobNotesFeed(job),
      renderJobPhotos(job),
      renderJobSketches(job),
      customTaskTools,
      list,
    ]),
    el("footer", { class: "back__footer" }, [
      el(
        "span",
        { style: "font-size:.78rem;color:var(--text-muted)" },
        `${job.progress.completed}/${job.progress.total} tasks complete (${job.progress.percent}%)`
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn btn--primary",
          onclick: (e) => {
            e.stopPropagation();
            flipCard(job.id, false);
          },
        },
        "Done"
      ),
    ]),
  ]);
}

function renderTaskRow(job, task, taskIndex, totalTasks) {
  const isCompleted = task.status === "completed";
  const isIssue = task.status === "issue";

  const checkbox = el("input", {
    type: "checkbox",
    class: "task__check",
    "aria-label": `Mark ${task.task_label} complete`,
  });
  checkbox.checked = isCompleted;

  checkbox.addEventListener("click", (e) => e.stopPropagation());
  checkbox.addEventListener("change", async (e) => {
    e.stopPropagation();
    const next = e.target.checked ? "completed" : "not_started";
    try {
      const updated = await apiClient.updateTask(job.id, task.task_key, { status: next });
      replaceJob(updated);
      await refreshNotificationCounts();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`Failed to update task: ${err.message}`, "error");
    }
  });

  const canonical = taskDateCanonical(task) || "";

  const revertDateControls = () => {
    const c = taskDateCanonical(task) || "";
    dateText.value = isoToUsMdy(c);
    nativeDate.value = isoToDateInput(c);
  };

  const persistTaskDate = async (nextIsoOrNull) => {
    const prev = taskDateCanonical(task);
    if (prev === nextIsoOrNull) return true;
    try {
      const updated = await apiClient.updateTask(job.id, task.task_key, { value: nextIsoOrNull });
      replaceJob(updated);
      await refreshNotificationCounts();
      return true;
    } catch (err) {
      toast(`Failed to save date: ${err.message}`, "error");
      revertDateControls();
      return false;
    }
  };

  const dateText = el("input", {
    type: "text",
    class: "task__date task__date--text",
    placeholder: "MM/DD/YYYY",
    value: isoToUsMdy(canonical),
    inputmode: "text",
    spellcheck: false,
    dataset: { taskField: "dateText" },
    "aria-label": `${task.task_label} date`,
    title: "Enter MM/DD/YYYY or choose a date with the calendar button",
    onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      }
    },
    onblur: async (e) => {
      e.stopPropagation();
      const parsed = parseManualTaskDate(dateText.value);
      if (!parsed.ok) {
        toast(parsed.message, "error");
        revertDateControls();
        return;
      }
      const ok = await persistTaskDate(parsed.value);
      if (ok) dateText.value = isoToUsMdy(parsed.value);
    },
  });

  const nativeDate = el("input", {
    type: "date",
    class: "task__date-native",
    value: isoToDateInput(canonical),
    tabIndex: -1,
    "aria-hidden": "true",
    onclick: (e) => e.stopPropagation(),
    onchange: async (e) => {
      e.stopPropagation();
      const v = e.target.value ? e.target.value : null;
      const ok = await persistTaskDate(v);
      if (ok) dateText.value = isoToUsMdy(v || "");
    },
  });

  const calBtn = el(
    "button",
    {
      type: "button",
      class: "task__date-cal",
      "aria-label": `Open calendar for ${task.task_label}`,
      title: "Open calendar",
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (typeof nativeDate.showPicker === "function") {
            nativeDate.showPicker();
          } else {
            nativeDate.click();
          }
        } catch (_) {
          nativeDate.click();
        }
      },
    },
    [
      (() => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "18");
        svg.setAttribute("height", "18");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("aria-hidden", "true");
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        r.setAttribute("x", "3");
        r.setAttribute("y", "4");
        r.setAttribute("width", "18");
        r.setAttribute("height", "18");
        r.setAttribute("rx", "2");
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M16 2v4M8 2v4M3 10h18");
        svg.append(r, p);
        return svg;
      })(),
    ]
  );

  const dateWrap = el("div", { class: "task__date-wrap" }, [dateText, calBtn, nativeDate]);

  const noteInput = el("input", {
    type: "text",
    class: "task__note",
    placeholder: "Note (optional)",
    value: task.note || "",
    dataset: { taskField: "note" },
    "aria-label": `${task.task_label} note`,
    onclick: (e) => e.stopPropagation(),
    onblur: async (e) => {
      const v = e.target.value;
      if ((v || "") === (task.note || "")) return;
      try {
        const updated = await apiClient.updateTask(job.id, task.task_key, { note: v });
        replaceJob(updated);
        await refreshNotificationCounts();
      } catch (err) {
        toast(`Failed to save note: ${err.message}`, "error");
      }
    },
  });

  const issueBtn = el(
    "button",
    {
      type: "button",
      class: "task__issue-btn",
      title: "Toggle issue / needs attention",
      "aria-pressed": isIssue ? "true" : "false",
      onclick: async (e) => {
        e.stopPropagation();
        const next = isIssue ? "not_started" : "issue";
        try {
          const updated = await apiClient.updateTask(job.id, task.task_key, { status: next });
          replaceJob(updated);
          await refreshNotificationCounts();
        } catch (err) {
          toast(`Failed to update task: ${err.message}`, "error");
        }
      },
    },
    isIssue ? "! Issue" : "Flag"
  );
  const canManageTaskList = canCreateJob();
  const dragHandle = canManageTaskList
    ? el(
        "button",
        {
          type: "button",
          class: "task__drag-handle",
          "aria-label": "Drag to reorder",
          title: "Drag to reorder",
          tabIndex: -1,
        },
        [createTaskDragHandleIcon()]
      )
    : null;
  const moveUpBtn = canManageTaskList
    ? el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm task__manage-btn",
          disabled: taskIndex <= 0 ? true : null,
          title: "Move task up",
          onclick: async (e) => {
            e.stopPropagation();
            try {
              const updated = await apiClient.moveJobTask(job.id, task.task_key, { direction: "up" });
              replaceJob(updated);
            } catch (err) {
              toast(`Failed to move task: ${err.message}`, "error");
            }
          },
        },
        "↑"
      )
    : null;
  const moveDownBtn = canManageTaskList
    ? el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm task__manage-btn",
          disabled: taskIndex >= totalTasks - 1 ? true : null,
          title: "Move task down",
          onclick: async (e) => {
            e.stopPropagation();
            try {
              const updated = await apiClient.moveJobTask(job.id, task.task_key, { direction: "down" });
              replaceJob(updated);
            } catch (err) {
              toast(`Failed to move task: ${err.message}`, "error");
            }
          },
        },
        "↓"
      )
    : null;
  const deleteBtn = canManageTaskList
    ? el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm task__manage-btn task__manage-btn--danger",
          title: "Delete task",
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete task "${task.task_label}"?`)) return;
            try {
              const updated = await apiClient.deleteJobTask(job.id, task.task_key);
              replaceJob(updated);
              await refreshNotificationCounts();
              toast("Task deleted", "success");
            } catch (err) {
              toast(`Failed to delete task: ${err.message}`, "error");
            }
          },
        },
        "Delete"
      )
    : null;
  const taskActions = el("div", { class: "task__actions" }, [
    issueBtn,
    moveUpBtn,
    moveDownBtn,
    deleteBtn,
  ]);

  const rowChildren = [
    checkbox,
    el("div", { class: "task__main" }, [
      el("div", { class: "task__label" }, [
        el("span", {}, task.task_label),
        task.is_billable ? el("span", { class: "task__billable-badge", title: "Billable" }, "Billable") : null,
        taskActions,
      ]),
      el("div", { class: "task__inputs" }, [dateWrap, noteInput]),
    ]),
  ];
  if (dragHandle) rowChildren.unshift(dragHandle);

  return el(
    "li",
    {
      class: canManageTaskList ? "task task--draggable" : "task",
      dataset: { status: task.status, taskKey: task.task_key },
    },
    rowChildren
  );
}

// ---- Card container ------------------------------------------------------

function renderCard(job) {
  const front = renderFront(job);
  const back = renderBack(job);

  const inner = el("div", { class: "card-inner" }, [front, back]);
  const card = el(
    "article",
    {
      class: "card",
      dataset: {
        status: job.overall_status,
        id: String(job.id),
        jobType: normalizeJobType(job.job_type),
      },
    },
    [inner]
  );

  front.addEventListener("click", (e) => {
    if (e.target.closest("button, input, textarea, a")) return;
    flipCard(job.id, true);
  });
  front.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      flipCard(job.id, true);
    }
  });

  return card;
}

function isMobileCardOverlayViewport() {
  return window.matchMedia(MOBILE_CARD_QUERY).matches;
}

function isDesktopCardOverlayViewport() {
  return !isMobileCardOverlayViewport();
}

function getCardById(jobId) {
  return document.querySelector(`.card[data-id="${jobId}"]`);
}

function clearActiveDetailIntent() {
  state.activeDetailJobId = null;
  state.activeDetailNoOverlay = false;
}

function getFlippedCards() {
  return $$(".card.is-flipped");
}

function hasOpenMobileCardOverlay() {
  return isMobileCardOverlayViewport() && Boolean(document.querySelector(".card.is-flipped.card--mobile-overlay"));
}

function setCardOverlayPageState() {
  const hasMobileOverlay = hasOpenMobileCardOverlay();
  const hasDesktopOverlay = isDesktopCardOverlayViewport() && Boolean(document.querySelector(".card.is-flipped.card--desktop-overlay"));
  document.body.classList.toggle("mobile-card-overlay-open", hasMobileOverlay);
  document.body.classList.toggle("desktop-card-overlay-open", hasDesktopOverlay);
  $("#grid")?.classList.toggle("card-grid--mobile-overlay", hasMobileOverlay);
  $("#grid")?.classList.toggle("card-grid--desktop-overlay", hasDesktopOverlay);
}

function syncFlippedCardOverlayClasses() {
  for (const card of getFlippedCards()) {
    const cardJobId = Number(card.dataset.id);
    if (state.activeDetailNoOverlay && cardJobId === state.activeDetailJobId) {
      card.classList.remove("card--mobile-overlay", "card--desktop-overlay");
      continue;
    }
    if (isMobileCardOverlayViewport()) {
      card.classList.add("card--mobile-overlay");
      card.classList.remove("card--desktop-overlay");
    } else {
      card.classList.add("card--desktop-overlay");
      card.classList.remove("card--mobile-overlay");
    }
  }
  setCardOverlayPageState();
}

function ensureMobileCardHistoryEntryForOverlay() {
  if (!isMobileCardOverlayViewport()) return;
  if (history.state?.skipperMobileCard) return;
  history.pushState({ skipperMobileCard: true }, "", location.href);
}

function syncMobileCardHistoryAfterOverlayClosed() {
  if (!history.state?.skipperMobileCard) return;
  if (hasOpenMobileCardOverlay()) return;
  ignoreNextMobileCardPopstate = true;
  history.back();
}

function onMobileCardPopstate() {
  if (ignoreNextMobileCardPopstate) {
    ignoreNextMobileCardPopstate = false;
    return;
  }
  if (!hasOpenMobileCardOverlay()) return;
  for (const card of getFlippedCards()) {
    card.classList.remove("is-flipped", "card--mobile-overlay", "card--desktop-overlay");
  }
  clearActiveDetailIntent();
  setCardOverlayPageState();
}

function closeMobileCardOverlay() {
  for (const card of getFlippedCards()) {
    card.classList.remove("is-flipped", "card--mobile-overlay", "card--desktop-overlay");
  }
  clearActiveDetailIntent();
  setCardOverlayPageState();
  syncMobileCardHistoryAfterOverlayClosed();
}

function closeDesktopCardOverlay() {
  for (const card of getFlippedCards()) {
    card.classList.remove("is-flipped", "card--desktop-overlay", "card--mobile-overlay");
  }
  clearActiveDetailIntent();
  setCardOverlayPageState();
}

function closeActiveCardOverlay() {
  if (isMobileCardOverlayViewport()) {
    closeMobileCardOverlay();
    return;
  }
  closeDesktopCardOverlay();
}

function keepCardOpenWithoutOverlay(jobId) {
  const card = getCardById(jobId);
  if (!card || !card.classList.contains("is-flipped")) return;
  state.activeDetailJobId = Number(jobId);
  state.activeDetailNoOverlay = true;
  card.classList.remove("card--mobile-overlay", "card--desktop-overlay");
  setCardOverlayPageState();
  syncMobileCardHistoryAfterOverlayClosed();
}

function closeOtherFlippedCards(activeJobId) {
  for (const card of getFlippedCards()) {
    const cardJobId = Number(card.dataset.id);
    if (cardJobId === Number(activeJobId)) continue;
    card.classList.remove("is-flipped", "card--mobile-overlay", "card--desktop-overlay");
  }
}

function flipCard(jobId, flipped) {
  const card = getCardById(jobId);
  if (!card) return;
  const nextFlipped = !!flipped;
  const mobileOverlayMode = nextFlipped && isMobileCardOverlayViewport();
  const desktopOverlayMode = nextFlipped && isDesktopCardOverlayViewport();
  const idNum = Number(jobId);

  if (nextFlipped) {
    closeOtherFlippedCards(jobId);
    state.activeDetailJobId = idNum;
    state.activeDetailNoOverlay = false;
  } else if (state.activeDetailJobId === idNum) {
    clearActiveDetailIntent();
  }

  card.classList.toggle("is-flipped", nextFlipped);
  card.classList.toggle("card--mobile-overlay", mobileOverlayMode);
  card.classList.toggle("card--desktop-overlay", desktopOverlayMode);

  if (!nextFlipped) {
    card.classList.remove("card--mobile-overlay", "card--desktop-overlay");
  }
  setCardOverlayPageState();
  if (nextFlipped && card.classList.contains("card--mobile-overlay")) {
    ensureMobileCardHistoryEntryForOverlay();
  }
  syncMobileCardHistoryAfterOverlayClosed();
  if (nextFlipped) {
    requestAnimationFrame(() => loadCardBackThumbnails(jobId));
  }
}

// ---- State sync & rendering --------------------------------------------

function overviewCompletionPct(job) {
  const prog = job.progress || { percent: 0 };
  let pct = Number(prog.percent);
  if (!Number.isFinite(pct)) pct = 0;
  return Math.min(100, Math.max(0, pct));
}

/** Highest completion first; same ordering as Overview rows and the card grid. */
function sortedJobsByCompletionDesc() {
  return [...state.jobs].sort((a, b) => overviewCompletionPct(b) - overviewCompletionPct(a));
}

/** Keep card DOM order in sync with completion sort without a full rerender. */
function reorderCardsByCompletion() {
  const grid = $("#grid");
  if (!grid || state.view !== "cards") return;
  for (const job of sortedJobsByCompletionDesc()) {
    const card = getCardById(job.id);
    if (card) grid.appendChild(card);
  }
}

function openJobCardFromOverview(jobId) {
  const id = Number(jobId);
  state.filter = "";
  const searchInput = $("#search");
  if (searchInput) searchInput.value = "";
  state.view = "cards";
  renderAll();
  requestAnimationFrame(() => {
    closeOtherFlippedCards(id);
    flipCard(id, true);
    getCardById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function buildOverviewRow(job) {
  const prog = job.progress || { completed: 0, total: 0, percent: 0 };
  let pct = Number(prog.percent);
  if (!Number.isFinite(pct)) pct = 0;
  pct = Math.min(100, Math.max(0, pct));
  const completed = prog.completed ?? 0;
  const total = prog.total ?? 0;
  const metaText = `${completed} / ${total} tasks · ${pct}%`;
  const fill = el("div", { class: "overview-bar__fill", style: `width: ${pct}%` });
  const bar = el(
    "div",
    {
      class: "overview-bar",
      role: "progressbar",
      "aria-valuenow": String(Math.round(pct)),
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-label": `${job.customer_name || "Job"} completion`,
    },
    [fill]
  );
  const sub = job.address || job.field_manager || "";
  const name = job.customer_name || "—";
  const labelBlock = el("div", { class: "overview-row__label" }, [
    el("div", { class: "overview-row__name" }, name),
    sub ? el("div", { class: "overview-row__sub" }, sub) : null,
  ]);
  const stats = el("div", { class: "overview-row__stats" }, metaText);
  const barRow = el("div", { class: "overview-row__bar-wrap" }, [bar, stats]);
  return el(
    "button",
    {
      type: "button",
      class: "overview-row",
      dataset: { id: String(job.id) },
      "aria-label": `Open job card for ${name}, ${pct}% complete`,
      onclick: () => openJobCardFromOverview(job.id),
    },
    [labelBlock, barRow]
  );
}

function exitOverviewToCards() {
  state.view = "cards";
  renderAll();
}

async function exportSchedulePdf() {
  const btn = $("#overview-export-pdf-btn");
  if (btn) btn.disabled = true;
  try {
    const includeArchived = canViewArchivedJobs() && state.includeArchived;
    const blob = await apiClient.fetchSchedulePdfBlob(includeArchived);
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    triggerBlobDownload(blob, `Schedules-${stamp}.pdf`);
    toast("Schedule PDF downloaded.", "success");
  } catch (err) {
    toast(err?.message || "Could not export schedule PDF.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function buildOverviewPanel() {
  const backBtn = el(
    "button",
    {
      type: "button",
      class: "btn btn--ghost overview__back",
      onclick: () => exitOverviewToCards(),
    },
    "Back to job cards"
  );
  const exportBtn = el(
    "button",
    {
      type: "button",
      id: "overview-export-pdf-btn",
      class: "btn btn--primary overview__export",
      title: "Download master schedule for all jobs (ignores search filter)",
      onclick: () => exportSchedulePdf(),
    },
    "Export schedule PDF"
  );
  const headerActions = el("div", { class: "overview__actions" }, [exportBtn, backBtn]);
  const header = el("div", { class: "overview__header" }, [
    el("h2", { class: "overview__title" }, "Overview"),
    headerActions,
  ]);
  const body = el("div", { class: "overview__body" }, sortedJobsByCompletionDesc().map((job) => buildOverviewRow(job)));
  return el("section", { class: "overview", "aria-label": "Job completion overview" }, [header, body]);
}

/** If the flipped card had focus in checklist inputs, preserve it across `replaceJob` DOM swap. */
function captureEditableFocusInCard(oldCard, jobId) {
  if (!oldCard) return null;
  const a = document.activeElement;
  if (!a || !oldCard.contains(a) || !a.matches("input, textarea")) return null;
  const backBody = oldCard.querySelector(".back__body");
  if (!backBody || !backBody.contains(a)) return null;

  const taskRow = a.closest(".task");
  if (taskRow?.dataset.taskKey && a.dataset.taskField) {
    return {
      kind: "task",
      taskKey: taskRow.dataset.taskKey,
      field: a.dataset.taskField,
      selStart: typeof a.selectionStart === "number" ? a.selectionStart : null,
      selEnd: typeof a.selectionEnd === "number" ? a.selectionEnd : null,
    };
  }
  if (a.tagName === "TEXTAREA" && a.id === `notes-${jobId}`) {
    return {
      kind: "notes",
      selStart: typeof a.selectionStart === "number" ? a.selectionStart : null,
      selEnd: typeof a.selectionEnd === "number" ? a.selectionEnd : null,
    };
  }
  return null;
}

function findTaskInputByField(backBody, taskKey, field) {
  for (const row of backBody.querySelectorAll(".task")) {
    if (row.dataset.taskKey !== taskKey) continue;
    for (const inp of row.querySelectorAll("[data-task-field]")) {
      if (inp.dataset.taskField === field) return inp;
    }
  }
  return null;
}

function restoreEditableFocusAfterCardSwap(newCard, jobId, snap) {
  if (!snap || !newCard) return;
  const backBody = newCard.querySelector(".back__body");
  if (!backBody) return;
  let node = null;
  if (snap.kind === "task") {
    node = findTaskInputByField(backBody, snap.taskKey, snap.field);
  } else if (snap.kind === "notes") {
    const ta = document.getElementById(`notes-${jobId}`);
    node = ta && newCard.contains(ta) ? ta : null;
  }
  if (!node || typeof node.focus !== "function") return;
  node.focus({ preventScroll: true });
  if (typeof node.setSelectionRange === "function" && snap.selStart != null) {
    try {
      node.setSelectionRange(snap.selStart, snap.selEnd ?? snap.selStart);
    } catch (_) {
      /* date inputs may throw if selection unsupported */
    }
  }
}

/** Rebuild the overview panel only; caller should run `applyFilter()` after any modal updates. */
function renderOverviewBars() {
  const grid = $("#grid");
  if (!grid) return;
  $$(".overview", grid).forEach((n) => n.remove());
  updateEmptyStateMessage();
  if (!state.jobs.length) {
    $("#empty-state").hidden = false;
    return;
  }
  $("#empty-state").hidden = true;
  grid.appendChild(buildOverviewPanel());
}

function replaceJob(updatedJob) {
  state.jobsById.set(updatedJob.id, updatedJob);
  const idx = state.jobs.findIndex((j) => j.id === updatedJob.id);
  if (idx >= 0) state.jobs[idx] = updatedJob;

  if (state.view === "overview") {
    renderOverviewBars();
    setCardOverlayPageState();
    if (docsModalState.jobId === updatedJob.id && !$("#docs-modal")?.hidden) {
      renderDocsModalContent(updatedJob);
    }
    if (photosModalState.jobId === updatedJob.id && !$("#photos-modal")?.hidden) {
      const photos = getJobPhotosOrdered(updatedJob);
      if (!photos.length) {
        photosModalState.selectedIndex = 0;
      } else if (photosModalState.selectedIndex > photos.length - 1) {
        photosModalState.selectedIndex = photos.length - 1;
      }
      renderPhotosModalContent(updatedJob);
    }
    if (sketchesModalState.jobId === updatedJob.id && !$("#sketches-modal")?.hidden) {
      const sketches = getJobSketchesOrdered(updatedJob);
      if (!sketches.some((s) => s.id === sketchesModalState.selectedSketchId)) {
        sketchesModalState.selectedSketchId = sketches[0]?.id ?? null;
      }
      renderSketchesModalContent(updatedJob);
    }
    applyFilter();
    syncJobsPollSignature();
    return;
  }

  const oldCard = document.querySelector(`.card[data-id="${updatedJob.id}"]`);
  const focusSnap = oldCard ? captureEditableFocusInCard(oldCard, updatedJob.id) : null;
  const wasFlipped = oldCard?.classList.contains("is-flipped");
  const wasMobileOverlay = oldCard?.classList.contains("card--mobile-overlay");
  const wasDesktopOverlay = oldCard?.classList.contains("card--desktop-overlay");
  let backScrollTop = 0;
  if (wasFlipped && oldCard) {
    const prevBack = oldCard.querySelector(".back__body");
    if (prevBack) backScrollTop = prevBack.scrollTop;
    state.activeDetailJobId = updatedJob.id;
    state.activeDetailNoOverlay = !wasMobileOverlay && !wasDesktopOverlay;
  }

  const newCard = renderCard(updatedJob);
  const newInner = newCard.querySelector(".card-inner");
  if (wasFlipped) {
    newInner.classList.add("no-flip-transition");
    newCard.classList.add("is-flipped");
  }
  if (wasFlipped && wasMobileOverlay) newCard.classList.add("card--mobile-overlay");
  if (wasFlipped && wasDesktopOverlay) newCard.classList.add("card--desktop-overlay");

  if (oldCard) {
    oldCard.replaceWith(newCard);
  } else {
    $("#grid").prepend(newCard);
  }

  if (wasFlipped) {
    const nextBack = newCard.querySelector(".back__body");
    if (nextBack) {
      requestAnimationFrame(() => {
        newInner.classList.remove("no-flip-transition");
        nextBack.scrollTop = backScrollTop;
        if (focusSnap) restoreEditableFocusAfterCardSwap(newCard, updatedJob.id, focusSnap);
        loadCardBackThumbnails(updatedJob.id);
      });
    } else {
      requestAnimationFrame(() => {
        newInner.classList.remove("no-flip-transition");
        loadCardBackThumbnails(updatedJob.id);
      });
    }
  } else if (focusSnap) {
    requestAnimationFrame(() => restoreEditableFocusAfterCardSwap(newCard, updatedJob.id, focusSnap));
  }
  syncFlippedCardOverlayClasses();

  if (docsModalState.jobId === updatedJob.id && !$("#docs-modal")?.hidden) {
    renderDocsModalContent(updatedJob);
  }
  if (photosModalState.jobId === updatedJob.id && !$("#photos-modal")?.hidden) {
    const photos = getJobPhotosOrdered(updatedJob);
    if (!photos.length) {
      photosModalState.selectedIndex = 0;
    } else if (photosModalState.selectedIndex > photos.length - 1) {
      photosModalState.selectedIndex = photos.length - 1;
    }
    renderPhotosModalContent(updatedJob);
  }
  if (sketchesModalState.jobId === updatedJob.id && !$("#sketches-modal")?.hidden) {
    const sketches = getJobSketchesOrdered(updatedJob);
    if (!sketches.some((s) => s.id === sketchesModalState.selectedSketchId)) {
      sketchesModalState.selectedSketchId = sketches[0]?.id ?? null;
    }
    renderSketchesModalContent(updatedJob);
  }

  applyFilter();
  reorderCardsByCompletion();
  syncJobsPollSignature();
}

function removeJob(jobId) {
  const id = Number(jobId);
  if (!id) return;
  if (state.activeDetailJobId === id) clearActiveDetailIntent();
  state.jobs = state.jobs.filter((j) => j.id !== id);
  state.jobsById.delete(id);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.remove();
  if (docsModalState.jobId === id) closeDocsModal();
  if (photosModalState.jobId === id) closePhotosModal();
  if (sketchesModalState.jobId === id) closeSketchesModal();
  if (contactsModalState.jobId === id) closeContactsModal();
  if (notesModalState.jobId === id) closeNotesModal();
  if (state.view === "overview") {
    renderOverviewBars();
  }
  applyFilter();
  syncJobsPollSignature();
}

function updateEmptyStateMessage() {
  const empty = $("#empty-state");
  if (!empty) return;
  const p = empty.querySelector("p");
  if (!p) return;
  if (state.user?.role === "field") {
    p.innerHTML = "No jobs on file.";
  } else {
    p.innerHTML = 'No jobs yet. Click <strong>+ New Job</strong> to create one.';
  }
}

function captureActiveDetailScroll() {
  const detailId = state.activeDetailJobId;
  if (detailId == null || state.view !== "cards") {
    return { detailId: null, backScrollTop: 0, noOverlay: false };
  }
  const card = getCardById(detailId);
  let backScrollTop = 0;
  if (card) {
    const prevBack = card.querySelector(".back__body");
    if (prevBack) backScrollTop = prevBack.scrollTop;
  }
  return {
    detailId,
    backScrollTop,
    noOverlay: state.activeDetailNoOverlay,
  };
}

function restoreActiveFlippedCardAfterRebuild(detailId, backScrollTop, noOverlay) {
  if (detailId == null || !state.jobsById.has(detailId)) return;
  const card = getCardById(detailId);
  if (!card) return;
  const inner = card.querySelector(".card-inner");
  if (inner) inner.classList.add("no-flip-transition");
  closeOtherFlippedCards(detailId);
  flipCard(detailId, true);
  if (noOverlay) keepCardOpenWithoutOverlay(detailId);
  const nextBack = card.querySelector(".back__body");
  if (nextBack) nextBack.scrollTop = backScrollTop;
  requestAnimationFrame(() => {
    if (inner) inner.classList.remove("no-flip-transition");
    loadCardBackThumbnails(detailId);
  });
}

function renderAll() {
  const grid = $("#grid");
  if (grid) grid.classList.toggle("card-grid--overview", state.view === "overview");
  if (state.view === "overview") clearActiveDetailIntent();
  const activeDetail = captureActiveDetailScroll();
  $$(".overview", grid).forEach((n) => n.remove());
  $$(".card", grid).forEach((c) => c.remove());

  updateEmptyStateMessage();

  if (!state.jobs.length) {
    clearActiveDetailIntent();
    $("#empty-state").hidden = false;
    refreshJobTypeTabs();
    applyFilter();
    setCardOverlayPageState();
    syncMobileCardHistoryAfterOverlayClosed();
    return;
  }
  $("#empty-state").hidden = true;
  if (state.view === "overview") {
    renderOverviewBars();
  } else {
    const frag = document.createDocumentFragment();
    for (const job of sortedJobsByCompletionDesc()) frag.appendChild(renderCard(job));
    grid.appendChild(frag);
  }
  refreshJobTypeTabs();
  applyFilter();
  if (state.view === "cards" && activeDetail.detailId != null && state.jobsById.has(activeDetail.detailId)) {
    restoreActiveFlippedCardAfterRebuild(
      activeDetail.detailId,
      activeDetail.backScrollTop,
      activeDetail.noOverlay
    );
  }
  setCardOverlayPageState();
  syncMobileCardHistoryAfterOverlayClosed();
}

function jobMatchesActiveFilters(job, q) {
  const matchesSearch = !q || jobSearchHay(job).includes(q);
  const activeType = state.jobTypeFilter || "all";
  if (activeType === "all") return matchesSearch;
  return matchesSearch && normalizeJobType(job.job_type) === activeType;
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  if (state.view === "overview") {
    for (const row of $$(".overview-row")) {
      const id = Number(row.dataset.id);
      const job = state.jobsById.get(id);
      if (!job) continue;
      row.style.display = jobMatchesActiveFilters(job, q) ? "" : "none";
    }
    return;
  }
  for (const card of $$(".card")) {
    const id = Number(card.dataset.id);
    const job = state.jobsById.get(id);
    if (!job) continue;
    card.style.display = jobMatchesActiveFilters(job, q) ? "" : "none";
  }
}

// ---- Modals --------------------------------------------------------------

function renderDocsModalContent(job) {
  const body = $("#docs-modal-body");
  const title = $("#docs-modal-title-text");
  if (!body || !title) return;
  title.textContent = job?.customer_name || "Job";
  body.innerHTML = "";

  const docs = Array.isArray(job?.documents) ? job.documents : [];
  if (!docs.length) {
    body.appendChild(el("p", { class: "docs-modal__empty" }, "No PDFs found for this job."));
    return;
  }

  const fieldDocs = docs.filter((doc) => docCategory(doc) === "field");
  const permitDocs = docs.filter((doc) => docCategory(doc) === "permit");
  const salesDocs = docs.filter((doc) => docCategory(doc) === "sales");
  const invoicesDocs = docs.filter((doc) => docCategory(doc) === "invoices");

  function buildModalList(listDocs, emptyLabel) {
    const list = el("ul", { class: "docs-modal__list" });
    if (!listDocs.length) {
      list.appendChild(el("li", { class: "docs-modal__item" }, [el("div", { class: "docs-modal__meta" }, emptyLabel)]));
      return list;
    }
    for (const doc of listDocs) {
      const metaBits = [];
      if (doc.size_bytes != null) metaBits.push(formatDocSize(doc.size_bytes));
      if (doc.uploaded_at) metaBits.push(fmtDate(doc.uploaded_at));
      const docName = doc.original_filename || `${doc.title}.pdf`;

      const openBtn = el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm",
          onclick: async () => {
            try {
              const blob = await apiClient.fetchJobDocumentBlob(job.id, doc.id);
              const url = URL.createObjectURL(blob);
              window.open(url, "_blank", "noopener");
              setTimeout(() => URL.revokeObjectURL(url), 45000);
            } catch (err) {
              toast(`Open failed: ${err.message}`, "error");
            }
          },
        },
        "View"
      );
      const downloadBtn = el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm",
          onclick: async () => {
            try {
              const blob = await apiClient.fetchJobDocumentBlob(job.id, doc.id);
              triggerBlobDownload(blob, docName);
            } catch (err) {
              toast(`Download failed: ${err.message}`, "error");
            }
          },
        },
        "Download"
      );
      const shareBtn = el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm",
          onclick: async () => {
            try {
              const blob = await apiClient.fetchJobDocumentBlob(job.id, doc.id);
              const file = new File([blob], docName, { type: "application/pdf" });
              if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                  files: [file],
                  title: doc.title,
                  text: `${job.customer_name} - ${doc.title}`,
                });
                return;
              }
              toast("Sharing is not available on this device - use Download.", "info");
            } catch (err) {
              if (err?.name === "AbortError") return;
              toast(`Share failed: ${err.message}`, "error");
            }
          },
        },
        "Share"
      );

      list.appendChild(
        el("li", { class: "docs-modal__item" }, [
          el("div", { class: "docs-modal__main" }, [
            el("div", { class: "docs-modal__title", title: docName }, doc.title),
            el("div", { class: "docs-modal__meta" }, metaBits.join(" · ")),
          ]),
          el("div", { class: "docs-modal__actions" }, [openBtn, downloadBtn, shareBtn]),
        ])
      );
    }
    return list;
  }
  body.appendChild(el("h4", { class: "job-docs__heading" }, `Field Docs (${fieldDocs.length})`));
  body.appendChild(buildModalList(fieldDocs, "No field PDFs found."));
  body.appendChild(
    el(
      "details",
      { class: "docs-modal__accordion" },
      [
        el("summary", { class: "docs-modal__accordion-summary" }, `Permit Docs (${permitDocs.length})`),
        buildModalList(permitDocs, "No permit PDFs found."),
      ]
    )
  );
  body.appendChild(
    el(
      "details",
      { class: "docs-modal__accordion" },
      [
        el("summary", { class: "docs-modal__accordion-summary" }, `Sales Docs (${salesDocs.length})`),
        buildModalList(salesDocs, "No sales PDFs found."),
      ]
    )
  );
  body.appendChild(
    el(
      "details",
      { class: "docs-modal__accordion" },
      [
        el("summary", { class: "docs-modal__accordion-summary" }, `Invoices (${invoicesDocs.length})`),
        buildModalList(invoicesDocs, "No invoice PDFs found."),
      ]
    )
  );
}

function closeDocsModal() {
  const modal = $("#docs-modal");
  if (!modal) return;
  modal.hidden = true;
  docsModalState.jobId = null;
  const body = $("#docs-modal-body");
  if (body) body.innerHTML = "";
}

function closeContactsModal() {
  const modal = $("#contacts-modal");
  if (!modal) return;
  modal.hidden = true;
  contactsModalState.jobId = null;
  const body = $("#contacts-modal-body");
  if (body) body.innerHTML = "";
}

function notesModalAfterChange(updated) {
  if (notesModalState.jobId === updated.id) renderNotesModalContent(updated);
}

function renderNotesModalContent(job) {
  const titleEl = $("#notes-modal-title-text");
  if (titleEl) titleEl.textContent = job.customer_name || "Job";
  const body = $("#notes-modal-body");
  if (!body) return;
  body.innerHTML = "";
  const inner = el("div", { class: "notes-modal__body-inner job-notes-feed" });
  inner.appendChild(buildJobNotesFeedBody(job, { afterChange: notesModalAfterChange }));
  body.appendChild(inner);
}

function closeNotesModal() {
  const modal = $("#notes-modal");
  if (!modal) return;
  modal.hidden = true;
  notesModalState.jobId = null;
  const body = $("#notes-modal-body");
  if (body) body.innerHTML = "";
}

function openNotesModal(jobOrId) {
  const job = typeof jobOrId === "object" ? jobOrId : getJobById(jobOrId);
  if (!job) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeDocsModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  notesModalState.jobId = job.id;
  renderNotesModalContent(job);
  const modal = $("#notes-modal");
  if (modal) modal.hidden = false;
}

function telHref(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "#";
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "#";
  return hasPlus ? `tel:+${digits}` : `tel:${digits}`;
}

function mailtoHref(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "#";
  return `mailto:${encodeURIComponent(s)}`;
}

function renderContactsModalCard(c) {
  const parts = [];
  if (c.label) parts.push(el("h4", { class: "job-contacts-modal__title" }, c.label));
  const meta = el("dl", { class: "job-contacts-modal__meta" });
  if (c.name) {
    meta.appendChild(el("dt", {}, "Name"));
    meta.appendChild(el("dd", {}, c.name));
  }
  if (c.phone) {
    meta.appendChild(el("dt", {}, "Phone"));
    meta.appendChild(
      el(
        "dd",
        {},
        el(
          "a",
          {
            href: telHref(c.phone),
            class: "job-contacts-modal__link",
            onclick: (e) => e.stopPropagation(),
          },
          c.phone
        )
      )
    );
  }
  if (c.email) {
    meta.appendChild(el("dt", {}, "Email"));
    meta.appendChild(
      el(
        "dd",
        {},
        el(
          "a",
          {
            href: mailtoHref(c.email),
            class: "job-contacts-modal__link",
            onclick: (e) => e.stopPropagation(),
          },
          c.email
        )
      )
    );
  }
  if (meta.children.length) parts.push(meta);
  if (!parts.length) parts.push(el("p", { class: "job-contacts-modal__muted" }, "—"));
  return el("article", { class: "job-contacts-modal__card" }, parts);
}

function renderContactsModalContent(job) {
  const titleEl = $("#contacts-modal-title-text");
  if (titleEl) titleEl.textContent = job.customer_name || "Job";
  const body = $("#contacts-modal-body");
  if (!body) return;
  body.innerHTML = "";
  const list = Array.isArray(job.contacts) ? job.contacts : [];
  if (!list.length) {
    body.appendChild(el("p", { class: "job-contacts-modal__empty" }, "No contacts on file."));
    return;
  }
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    body.appendChild(renderContactsModalCard(c));
  }
}

function openContactsModal(jobOrId) {
  const job = typeof jobOrId === "object" ? jobOrId : getJobById(jobOrId);
  if (!job) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeDocsModal();
  closePhotosModal();
  closeNotesModal();
  contactsModalState.jobId = job.id;
  renderContactsModalContent(job);
  const modal = $("#contacts-modal");
  if (modal) modal.hidden = false;
}

function openDocsModal(jobOrId) {
  const job = typeof jobOrId === "object" ? jobOrId : getJobById(jobOrId);
  if (!job) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  closeNotesModal();
  docsModalState.jobId = job.id;
  renderDocsModalContent(job);
  const modal = $("#docs-modal");
  if (modal) modal.hidden = false;
}

function updatePhotoGallerySelectionLabel(selectedIndex, total) {
  const label = $("#photos-modal-selection");
  if (!label) return;
  if (!total) {
    label.textContent = "";
    return;
  }
  label.textContent = `Selected ${selectedIndex + 1} of ${total}`;
}

function scrollActivePhotoTileIntoView() {
  requestAnimationFrame(() => {
    const tile = $("#photos-modal-main")?.querySelector(".photos-modal__tile.is-active");
    tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function navigatePhotosModalSelection(delta) {
  const job = getJobById(photosModalState.jobId);
  const photos = getJobPhotosOrdered(job);
  if (!photos.length) return;
  const next = photosModalState.selectedIndex + delta;
  if (next < 0 || next >= photos.length) return;
  photosModalState.selectedIndex = next;
  renderPhotosModalContent(job);
  scrollActivePhotoTileIntoView();
}

function touchDistance(t0, t1) {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}

function resetPhotoViewerTransform() {
  photoViewerGesture.scale = 1;
  photoViewerGesture.tx = 0;
  photoViewerGesture.ty = 0;
  photoViewerGesture.pinchStartDist = 0;
  photoViewerGesture.pinchStartScale = 1;
  photoViewerGesture.panning = false;
  photoViewerGesture.mousePanning = false;
  const t = $("#photo-viewer-transform");
  const stage = $("#photo-viewer-stage");
  if (t) t.style.transform = "translate(0px, 0px) scale(1)";
  if (stage) stage.classList.remove("is-panning");
}

function applyPhotoViewerTransform() {
  const t = $("#photo-viewer-transform");
  if (!t) return;
  t.style.transform = `translate(${photoViewerGesture.tx}px, ${photoViewerGesture.ty}px) scale(${photoViewerGesture.scale})`;
}

function closePhotoViewer() {
  photoViewerState.loadSeq += 1;
  if (photoViewerState.objectUrl) {
    URL.revokeObjectURL(photoViewerState.objectUrl);
    photoViewerState.objectUrl = null;
  }
  const overlay = $("#photo-viewer-overlay");
  if (overlay) overlay.hidden = true;
  document.body.classList.remove("photo-viewer-open");
  const img = $("#photo-viewer-img");
  if (img) {
    img.removeAttribute("src");
    img.alt = "";
  }
  const loading = $("#photo-viewer-loading");
  if (loading) loading.hidden = true;
  resetPhotoViewerTransform();
  photoViewerState.jobId = null;
  photoViewerState.photoIndex = null;
  photoViewerGesture.maxTouchesInGesture = 0;
  updatePhotoViewerNavControls();
}

function isPhotoViewerOpen() {
  const o = $("#photo-viewer-overlay");
  return o && !o.hidden;
}

function updatePhotoViewerNavControls() {
  const prevBtn = $("#photo-viewer-prev-btn");
  const nextBtn = $("#photo-viewer-next-btn");
  if (!prevBtn || !nextBtn) return;

  const job = getJobById(photoViewerState.jobId);
  const photos = getJobPhotosOrdered(job);
  const index = photoViewerState.photoIndex;
  const hasMultiple = isPhotoViewerOpen() && photos.length > 1 && index != null;

  prevBtn.hidden = !hasMultiple;
  nextBtn.hidden = !hasMultiple;
  prevBtn.disabled = !hasMultiple || index <= 0;
  nextBtn.disabled = !hasMultiple || index >= photos.length - 1;
}

/** @param {-1|1} delta -1 = previous photo, +1 = next (after swipe left). */
function navigatePhotoViewer(delta) {
  if (!isPhotoViewerOpen() || photoViewerState.jobId == null || photoViewerState.photoIndex == null) return;
  const job = getJobById(photoViewerState.jobId);
  const photos = getJobPhotosOrdered(job);
  if (!job || photos.length < 2) return;
  const cur = photoViewerState.photoIndex;
  const next = cur + delta;
  if (next < 0 || next >= photos.length) return;
  photoViewerGesture.ignoreNextClickUntil = performance.now() + 450;
  photosModalState.selectedIndex = next;
  renderPhotosModalContent(job);
  scrollActivePhotoTileIntoView();
  void openPhotoViewer(job, next);
}

function initPhotoViewerGesturesOnce() {
  const stage = $("#photo-viewer-stage");
  if (!stage || stage.dataset.gesturesWired === "1") return;
  stage.dataset.gesturesWired = "1";

  const MIN_SCALE = 1;
  const MAX_SCALE = 5;
  const SWIPE_MIN_PX = 52;
  const SWIPE_DOMINANCE = 1.25;

  stage.addEventListener(
    "touchstart",
    (e) => {
      photoViewerGesture.maxTouchesInGesture = Math.max(
        photoViewerGesture.maxTouchesInGesture,
        e.touches.length
      );
      if (e.touches.length === 2) {
        photoViewerGesture.panning = false;
        photoViewerGesture.pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
        photoViewerGesture.pinchStartScale = photoViewerGesture.scale;
      } else if (e.touches.length === 1) {
        photoViewerGesture.panning = true;
        const t = e.touches[0];
        photoViewerGesture.lastClientX = t.clientX;
        photoViewerGesture.lastClientY = t.clientY;
        if (photoViewerGesture.scale <= MIN_SCALE) {
          photoViewerGesture.swipeStartX = t.clientX;
          photoViewerGesture.swipeStartY = t.clientY;
          photoViewerGesture.swipeTouchId = t.identifier;
        }
      }
    },
    { passive: true }
  );

  stage.addEventListener(
    "touchmove",
    (e) => {
      photoViewerGesture.maxTouchesInGesture = Math.max(
        photoViewerGesture.maxTouchesInGesture,
        e.touches.length
      );
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = touchDistance(e.touches[0], e.touches[1]);
        if (photoViewerGesture.pinchStartDist > 0) {
          const next =
            (photoViewerGesture.pinchStartScale * d) / photoViewerGesture.pinchStartDist;
          photoViewerGesture.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
          if (photoViewerGesture.scale === 1) {
            photoViewerGesture.tx = 0;
            photoViewerGesture.ty = 0;
          }
          applyPhotoViewerTransform();
        }
      } else if (e.touches.length === 1 && photoViewerGesture.panning && photoViewerGesture.scale > 1) {
        e.preventDefault();
        const t0 = e.touches[0];
        photoViewerGesture.tx += t0.clientX - photoViewerGesture.lastClientX;
        photoViewerGesture.ty += t0.clientY - photoViewerGesture.lastClientY;
        photoViewerGesture.lastClientX = t0.clientX;
        photoViewerGesture.lastClientY = t0.clientY;
        applyPhotoViewerTransform();
      }
    },
    { passive: false }
  );

  stage.addEventListener(
    "touchend",
    (e) => {
      if (e.touches.length < 2) {
        photoViewerGesture.pinchStartDist = 0;
      }
      if (e.touches.length === 0) {
        photoViewerGesture.panning = false;

        if (
          photoViewerGesture.maxTouchesInGesture < 2 &&
          photoViewerGesture.scale <= MIN_SCALE &&
          isPhotoViewerOpen() &&
          photoViewerState.photoIndex != null
        ) {
          let t0 = null;
          for (let i = 0; i < e.changedTouches.length; i++) {
            const c = e.changedTouches[i];
            if (c.identifier === photoViewerGesture.swipeTouchId) {
              t0 = c;
              break;
            }
          }
          if (!t0 && e.changedTouches.length) t0 = e.changedTouches[0];
          if (t0) {
            const dx = t0.clientX - photoViewerGesture.swipeStartX;
            const dy = t0.clientY - photoViewerGesture.swipeStartY;
            if (
              Math.abs(dx) >= SWIPE_MIN_PX &&
              Math.abs(dx) >= Math.abs(dy) * SWIPE_DOMINANCE
            ) {
              navigatePhotoViewer(dx < 0 ? 1 : -1);
            }
          }
        }
        photoViewerGesture.maxTouchesInGesture = 0;
      }
    },
    { passive: true }
  );

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY;
    const factor = delta > 0 ? 0.92 : 1.08;
    photoViewerGesture.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, photoViewerGesture.scale * factor));
    if (photoViewerGesture.scale === 1) {
      photoViewerGesture.tx = 0;
      photoViewerGesture.ty = 0;
    }
    applyPhotoViewerTransform();
  }, { passive: false });

  stage.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    photoViewerGesture.mousePanning = true;
    photoViewerGesture.lastClientX = e.clientX;
    photoViewerGesture.lastClientY = e.clientY;
    stage.classList.add("is-panning");
  });

  document.addEventListener("mouseup", () => {
    photoViewerGesture.mousePanning = false;
    stage.classList.remove("is-panning");
  });

  stage.addEventListener("mousemove", (e) => {
    if (!photoViewerGesture.mousePanning || photoViewerGesture.scale <= 1) return;
    photoViewerGesture.tx += e.clientX - photoViewerGesture.lastClientX;
    photoViewerGesture.ty += e.clientY - photoViewerGesture.lastClientY;
    photoViewerGesture.lastClientX = e.clientX;
    photoViewerGesture.lastClientY = e.clientY;
    applyPhotoViewerTransform();
  });

  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest(".photo-viewer__transform")) {
      resetPhotoViewerTransform();
    }
  });

  stage.addEventListener("click", (e) => {
    if (performance.now() < photoViewerGesture.ignoreNextClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const loading = $("#photo-viewer-loading");
    if (loading && !loading.hidden) return;
    if (e.target.closest(".photo-viewer__transform")) return;
    closePhotoViewer();
  });
}

async function openPhotoViewer(job, index) {
  const photos = getJobPhotosOrdered(job);
  const photo = photos[index];
  if (!photo) return;

  closePhotoViewer();

  const overlay = $("#photo-viewer-overlay");
  const img = $("#photo-viewer-img");
  const loading = $("#photo-viewer-loading");
  if (!overlay || !img) return;

  photoViewerState.jobId = job.id;
  photoViewerState.photoIndex = index;

  const reqId = photoViewerState.loadSeq;

  overlay.hidden = false;
  document.body.classList.add("photo-viewer-open");
  if (loading) loading.hidden = false;
  updatePhotoViewerNavControls();

  resetPhotoViewerTransform();

  try {
    const blob = await apiClient.fetchJobPhotoDisplayBlob(job.id, photo.id);
    if (reqId !== photoViewerState.loadSeq) return;
    const url = URL.createObjectURL(blob);
    photoViewerState.objectUrl = url;
    img.alt = photo.original_filename || "Photo";
    img.src = url;
    if (loading) loading.hidden = true;
    img.onload = () => {
      resetPhotoViewerTransform();
    };
  } catch (err) {
    if (reqId !== photoViewerState.loadSeq) return;
    toast(`Could not load photo: ${err.message}`, "error");
    closePhotoViewer();
  }
}

function wirePhotosModalDownloadButton() {
  const downloadBtn = $("#photos-modal-download-btn");
  if (!downloadBtn) return;
  downloadBtn.onclick = async () => {
    const job = getJobById(photosModalState.jobId);
    const photos = getJobPhotosOrdered(job);
    if (!job || !photos.length) return;
    const idx = Math.max(0, Math.min(photos.length - 1, photosModalState.selectedIndex));
    const p = photos[idx];
    if (!p) return;
    try {
      const blob = await apiClient.fetchJobPhotoBlob(job.id, p.id);
      triggerBlobDownload(blob, p.original_filename || "photo");
    } catch (err) {
      toast(`Download failed: ${err.message}`, "error");
    }
  };
}

function renderPhotosModalGrid(job) {
  const photos = getJobPhotosOrdered(job);
  const main = $("#photos-modal-main");
  const downloadBtn = $("#photos-modal-download-btn");
  const removeBtn = $("#photos-modal-remove-btn");
  if (!main || !downloadBtn) return;

  const canAttach = canAttachJobPhotos();
  if (removeBtn) removeBtn.hidden = !canAttach;

  if (!photos.length) {
    photosModalState.selectedIndex = 0;
    updatePhotoGallerySelectionLabel(0, 0);
    main.innerHTML = "";
    main.appendChild(el("p", { class: "photos-modal__empty" }, "No photos found for this job."));
    downloadBtn.disabled = true;
    if (removeBtn) removeBtn.disabled = true;
    return;
  }

  const selectedIndex = Math.min(Math.max(photosModalState.selectedIndex, 0), photos.length - 1);
  photosModalState.selectedIndex = selectedIndex;
  updatePhotoGallerySelectionLabel(selectedIndex, photos.length);

  downloadBtn.disabled = false;
  if (removeBtn) removeBtn.disabled = false;

  main.innerHTML = "";
  const groups = groupPhotosByUploadDate(photos);
  let globalIndex = 0;
  for (const group of groups) {
    const groupEl = el("div", { class: "photos-modal__date-group" });
    groupEl.appendChild(el("div", { class: "photos-modal__date-label" }, group.label));
    const grid = el("div", { class: "photos-modal__grid" });
    for (const photo of group.photos) {
      const i = globalIndex;
      globalIndex += 1;
      const name = photo.original_filename || `Photo ${i + 1}`;
      const img = el("img", { alt: name });
      getPhotoThumbUrl(job.id, photo)
        .then((url) => {
          img.src = url;
        })
        .catch(() => {});
      const tile = el(
        "button",
        {
          type: "button",
          class: `photos-modal__tile${i === selectedIndex ? " is-active" : ""}`,
          title: name,
          "aria-label": `Open ${name}`,
          "aria-pressed": i === selectedIndex ? "true" : "false",
          onclick: () => {
            photosModalState.selectedIndex = i;
            renderPhotosModalGrid(job);
            scrollActivePhotoTileIntoView();
            openPhotoViewer(job, i);
          },
        },
        img
      );
      grid.appendChild(tile);
    }
    groupEl.appendChild(grid);
    main.appendChild(groupEl);
  }

  wirePhotosModalDownloadButton();
  scrollActivePhotoTileIntoView();
}

function renderPhotosModalUpload(job) {
  const uploadWrap = $("#photos-modal-upload-wrap");
  if (!uploadWrap) return;
  uploadWrap.hidden = !canAttachJobPhotos();
  if (uploadWrap.hidden) return;

  const fileInput = $("#photos-modal-upload-input");
  const dropZone = $("#photos-modal-dropzone");
  if (!fileInput || fileInput.dataset.wired === "1") return;
  fileInput.dataset.wired = "1";

  function markDragOver(on) {
    if (!dropZone) return;
    dropZone.classList.toggle("is-dragover", !!on);
  }

  function preventDropNavigation(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  async function handleFiles(files) {
    if (!files?.length || !photosModalState.jobId) return;
    const overlay = $("#photos-modal-upload-overlay");
    const statusText = $("#photos-modal-upload-status-text");
    try {
      uploadWrap.setAttribute("aria-busy", "true");
      if (dropZone) dropZone.classList.add("is-uploading");
      if (overlay) overlay.hidden = false;
      if (statusText) statusText.textContent = "Uploading…";
      fileInput.disabled = true;
      const result = await uploadJobPhotosSequential(photosModalState.jobId, files);
      toastJobPhotosUploadResult(result);
      if (result.lastUpdated) {
        photosModalState.selectedIndex = 0;
        renderPhotosModalContent(result.lastUpdated);
      }
    } finally {
      uploadWrap.removeAttribute("aria-busy");
      if (dropZone) dropZone.classList.remove("is-uploading");
      if (overlay) overlay.hidden = true;
      fileInput.disabled = false;
      fileInput.value = "";
    }
  }

  fileInput.addEventListener("change", async () => {
    await handleFiles(fileInput.files);
  });

  uploadWrap.addEventListener("dragenter", (e) => {
    preventDropNavigation(e);
    markDragOver(true);
  });
  uploadWrap.addEventListener("dragover", (e) => {
    preventDropNavigation(e);
    markDragOver(true);
  });
  uploadWrap.addEventListener("dragleave", (e) => {
    preventDropNavigation(e);
    const rel = e.relatedTarget;
    if (rel && uploadWrap.contains(rel)) return;
    markDragOver(false);
  });
  uploadWrap.addEventListener("drop", async (e) => {
    preventDropNavigation(e);
    markDragOver(false);
    await handleFiles(e.dataTransfer?.files);
  });

  if (dropZone) {
    dropZone.addEventListener("dragenter", (e) => {
      preventDropNavigation(e);
      markDragOver(true);
    });
    dropZone.addEventListener("dragover", (e) => {
      preventDropNavigation(e);
      markDragOver(true);
    });
    dropZone.addEventListener("dragleave", (e) => {
      preventDropNavigation(e);
      const rel = e.relatedTarget;
      if (rel && dropZone.contains(rel)) return;
      markDragOver(false);
    });
    dropZone.addEventListener("drop", async (e) => {
      preventDropNavigation(e);
      markDragOver(false);
      await handleFiles(e.dataTransfer?.files);
    });
  }
}

function renderPhotosModalContent(job) {
  const title = $("#photos-modal-title-text");
  if (title) title.textContent = job?.customer_name || "Job";
  renderPhotosModalUpload(job);
  renderPhotosModalGrid(job);
}

async function removeSelectedModalPhoto() {
  if (!canAttachJobPhotos()) return;
  const job = getJobById(photosModalState.jobId);
  const photos = getJobPhotosOrdered(job);
  if (!job || !photos.length) return;
  const selectedIndex = Math.max(0, Math.min(photos.length - 1, photosModalState.selectedIndex));
  const photo = photos[selectedIndex];
  if (!photo) return;
  if (!confirm(`Remove "${photo.original_filename || "photo"}"?`)) return;
  try {
    const updated = await apiClient.deleteJobPhoto(job.id, photo.id);
    photoThumbUrlCache.delete(photo.id);
    const updatedPhotos = getJobPhotosOrdered(updated);
    photosModalState.selectedIndex = updatedPhotos.length > 0
      ? Math.max(0, Math.min(selectedIndex, updatedPhotos.length - 1))
      : 0;
    replaceJob(updated);
    toast("Photo removed", "success");
  } catch (err) {
    toast(`Failed: ${err.message}`, "error");
  }
}

function closePhotosModal() {
  const modal = $("#photos-modal");
  if (!modal) return;
  modal.hidden = true;
  photosModalState.jobId = null;
  photosModalState.selectedIndex = 0;
  closePhotoViewer();
  const main = $("#photos-modal-main");
  if (main) main.innerHTML = "";
}

function closeSketchesModal() {
  const modal = $("#sketches-modal");
  if (!modal) return;
  modal.hidden = true;
  sketchesModalState.jobId = null;
  sketchesModalState.selectedSketchId = null;
  const main = $("#sketches-modal-main");
  if (main) main.innerHTML = "";
}

function updateSketchesModalToolbar() {
  const hasSelection = sketchesModalState.selectedSketchId != null;
  const openBtn = $("#sketches-modal-open-btn");
  const renameBtn = $("#sketches-modal-rename-btn");
  const deleteBtn = $("#sketches-modal-delete-btn");
  if (openBtn) openBtn.disabled = !hasSelection;
  if (renameBtn) renameBtn.disabled = !hasSelection;
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
}

function renderSketchesModalGrid(job) {
  const main = $("#sketches-modal-main");
  if (!main) return;
  main.innerHTML = "";
  const ordered = getJobSketchesOrdered(job);
  if (!ordered.length) {
    main.appendChild(el("p", { class: "sketches-modal__empty" }, "No sketches yet. Create one to get started."));
    updateSketchesModalToolbar();
    return;
  }
  const grid = el("div", { class: "sketches-modal__grid" });
  for (const sketch of ordered) {
    const img = el("img", { alt: sketch.title || "", loading: "lazy", decoding: "async" });
    getSketchThumbUrl(job.id, sketch)
      .then((url) => {
        img.src = url;
      })
      .catch(() => {});
    const tile = el(
      "button",
      {
        type: "button",
        class: "sketches-modal__tile",
        dataset: { sketchId: String(sketch.id) },
        onclick: () => {
          sketchesModalState.selectedSketchId = sketch.id;
          $$(".sketches-modal__tile", main).forEach((t) => {
            t.classList.toggle("is-active", Number(t.dataset.sketchId) === sketch.id);
          });
          updateSketchesModalToolbar();
        },
        ondblclick: () => openSketchEditorForJob(job.id, sketch.id),
      },
      [
        img,
        el("span", { class: "sketches-modal__tile-label" }, sketch.title || "Untitled"),
      ]
    );
    if (sketchesModalState.selectedSketchId === sketch.id) tile.classList.add("is-active");
    grid.appendChild(tile);
  }
  main.appendChild(grid);
  updateSketchesModalToolbar();
}

function renderSketchesModalContent(job) {
  const titleText = $("#sketches-modal-title-text");
  if (titleText) titleText.textContent = job.customer_name || "";
  renderSketchesModalGrid(job);
}

function openSketchesModal(jobOrId, sketchId = null) {
  const job = typeof jobOrId === "object" ? jobOrId : getJobById(jobOrId);
  if (!job) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeDocsModal();
  closeContactsModal();
  closeNotesModal();
  closePhotosModal();
  sketchesModalState.jobId = job.id;
  sketchesModalState.selectedSketchId = sketchId;
  renderSketchesModalContent(job);
  const modal = $("#sketches-modal");
  if (modal) modal.hidden = false;
}

async function createSketchFromModal() {
  const job = getJobById(sketchesModalState.jobId);
  if (!job) return;
  const title = prompt("Sketch name", "Pool layout");
  if (!title || !String(title).trim()) return;
  try {
    const updated = await apiClient.createJobSketch(job.id, {
      title: String(title).trim(),
      grid_spacing_inches: 3,
    });
    replaceJob(updated);
    const fresh = getJobById(job.id);
    const newest = getJobSketchesOrdered(fresh)[0];
    sketchesModalState.selectedSketchId = newest?.id ?? null;
    renderSketchesModalContent(fresh);
    if (newest) await openSketchEditorForJob(job.id, newest.id);
  } catch (err) {
    toast(`Failed: ${err.message}`, "error");
  }
}

async function openSketchEditorForJob(jobId, sketchId) {
  const job = getJobById(jobId);
  const sketch = (job?.sketches || []).find((s) => s.id === sketchId);
  if (!job || !sketch || !window.SketchEditor) return;
  let document;
  try {
    document = await apiClient.fetchJobSketchDocument(jobId, sketchId);
  } catch (err) {
    toast(`Failed to load sketch: ${err.message}`, "error");
    return;
  }
  closeSketchesModal();
  await window.SketchEditor.open({
    jobId,
    sketch,
    document,
    jobPhotos: job.photos || [],
    fetchPhotoBlob: (photoId) => apiClient.fetchJobPhotoDisplayBlob(jobId, photoId),
    fetchBackgroundBlob: () => apiClient.fetchJobSketchBackgroundBlob(jobId, sketchId),
    loadPhotoThumb: (photoId) => getPhotoThumbUrl(jobId, { id: photoId }),
    onSave: async ({ document: doc, preview, background, contentVersion }) =>
      apiClient.saveJobSketch(jobId, sketchId, {
        document: doc,
        preview,
        background,
        contentVersion,
      }),
    onSaved: (updatedJob) => {
      invalidateSketchThumbCache(sketchId);
      replaceJob(updatedJob);
      toast("Sketch saved", "success");
    },
    onError: (err) => toast(err.message || String(err), "error"),
  });
}

async function renameSelectedSketch() {
  const job = getJobById(sketchesModalState.jobId);
  const sketchId = sketchesModalState.selectedSketchId;
  if (!job || sketchId == null) return;
  const sketch = (job.sketches || []).find((s) => s.id === sketchId);
  if (!sketch) return;
  const title = prompt("Rename sketch", sketch.title || "");
  if (!title || !String(title).trim()) return;
  try {
    const updated = await apiClient.renameJobSketch(job.id, sketchId, String(title).trim());
    replaceJob(updated);
    renderSketchesModalContent(getJobById(job.id));
    toast("Sketch renamed", "success");
  } catch (err) {
    toast(`Failed: ${err.message}`, "error");
  }
}

async function deleteSelectedSketch() {
  const job = getJobById(sketchesModalState.jobId);
  const sketchId = sketchesModalState.selectedSketchId;
  if (!job || sketchId == null) return;
  const sketch = (job.sketches || []).find((s) => s.id === sketchId);
  if (!sketch) return;
  if (!confirm(`Delete sketch "${sketch.title}"?`)) return;
  try {
    const updated = await apiClient.deleteJobSketch(job.id, sketchId);
    invalidateSketchThumbCache(sketchId);
    replaceJob(updated);
    sketchesModalState.selectedSketchId = null;
    renderSketchesModalContent(getJobById(job.id));
    toast("Sketch deleted", "success");
  } catch (err) {
    toast(`Failed: ${err.message}`, "error");
  }
}

function openPhotosModal(jobOrId, initialIndex = 0) {
  const job = typeof jobOrId === "object" ? jobOrId : getJobById(jobOrId);
  if (!job) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeDocsModal();
  closeContactsModal();
  closeNotesModal();
  closeSketchesModal();
  photosModalState.jobId = job.id;
  const photos = getJobPhotosOrdered(job);
  const requested = Number.isFinite(initialIndex) ? Math.floor(initialIndex) : 0;
  photosModalState.selectedIndex = photos.length > 0
    ? Math.max(0, Math.min(requested, photos.length - 1))
    : 0;
  renderPhotosModalContent(job);
  const modal = $("#photos-modal");
  if (modal) modal.hidden = false;
}

async function openModal() {
  const modal = $("#modal");
  if (!modal) return;
  modal.hidden = false;
  if (cloneFromJobId == null) {
    newJobContactIdsOrder = [];
    await refreshContactsCatalog();
    renderNewJobContactsPicker();
  }
  const first = $("#new-job-form input[name='customer_name']");
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  const modal = $("#modal");
  if (!modal) return;
  modal.hidden = true;
  $("#new-job-form")?.reset();
  clearNewJobContactsPanel();
  cloneFromJobId = null;
  const titleEl = $("#modal-title");
  if (titleEl) titleEl.textContent = "New Job";
  const submitBtn = $("#new-job-form button[type='submit']");
  if (submitBtn) submitBtn.textContent = "Create Job";
}

async function openCloneJobModal(job) {
  const modal = $("#modal");
  const form = $("#new-job-form");
  if (!modal || !form) return;
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeDocsModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  closeNotesModal();
  form.reset();
  clearNewJobContactsPanel();
  cloneFromJobId = job.id;
  form.elements.namedItem("customer_name").value = `${job.customer_name || ""} (Copy)`.trim();
  const jobTypeEl = form.elements.namedItem("job_type");
  if (jobTypeEl) jobTypeEl.value = normalizeJobType(job.job_type) || job.job_type || "new_construction";
  form.elements.namedItem("address").value = job.address || "";
  form.elements.namedItem("pool_type").value = job.pool_type || "";
  form.elements.namedItem("permit_status").value = job.permit_status || "";
  form.elements.namedItem("permit_number").value = job.permit_number || "";
  form.elements.namedItem("field_manager").value = job.field_manager || "";
  form.elements.namedItem("notes").value = job.notes || "";
  await refreshContactsCatalog();
  newJobContactIdsOrder = getJobContactIdsFromJob(job);
  renderNewJobContactsPicker();
  const titleEl = $("#modal-title");
  if (titleEl) titleEl.textContent = "Clone Job";
  const submitBtn = $("#new-job-form button[type='submit']");
  if (submitBtn) submitBtn.textContent = "Create Clone";
  modal.hidden = false;
  const first = form.querySelector("input[name='customer_name']");
  if (first) setTimeout(() => {
    first.focus();
    first.select();
  }, 30);
}

async function openEditJobModal(job) {
  const modal = $("#edit-job-modal");
  const idInput = $("#edit-job-id");
  const form = $("#edit-job-form");
  if (!modal || !form || !idInput) return;
  closeModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeDocsModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  closeNotesModal();
  idInput.value = String(job.id);
  form.elements.namedItem("customer_name").value = job.customer_name || "";
  form.elements.namedItem("job_type").value = job.job_type || "new_construction";
  form.elements.namedItem("address").value = job.address || "";
  form.elements.namedItem("pool_type").value = job.pool_type || "";
  form.elements.namedItem("permit_status").value = job.permit_status || "";
  form.elements.namedItem("permit_number").value = job.permit_number || "";
  form.elements.namedItem("field_manager").value = job.field_manager || "";
  form.elements.namedItem("notes").value = job.notes || "";
  await refreshContactsCatalog();
  editJobContactIdsOrder = getJobContactIdsFromJob(job);
  renderEditJobContactsPicker();
  const deleteBtn = $("#edit-job-delete-btn");
  if (deleteBtn) deleteBtn.hidden = !canArchive();
  modal.hidden = false;
  const first = form.querySelector("input[name='customer_name']");
  if (first) setTimeout(() => first.focus(), 30);
}

function closeEditJobModal() {
  const modal = $("#edit-job-modal");
  if (!modal) return;
  modal.hidden = true;
  $("#edit-job-form")?.reset();
  clearEditJobContactsPanel();
  const deleteBtn = $("#edit-job-delete-btn");
  if (deleteBtn) deleteBtn.hidden = true;
  const idInput = $("#edit-job-id");
  if (idInput) idInput.value = "";
}

function wireModal() {
  if (modalHandlersWired) return;
  modalHandlersWired = true;
  if (!mobileCardPopstateWired) {
    mobileCardPopstateWired = true;
    window.addEventListener("popstate", onMobileCardPopstate);
  }
  const modal = $("#modal");
  const editJobModal = $("#edit-job-modal");
  const docsModal = $("#docs-modal");
  const contactsModal = $("#contacts-modal");
  const photosModal = $("#photos-modal");
  const sketchesModal = $("#sketches-modal");
  const notesModal = $("#notes-modal");
  const taskTemplatesModal = $("#task-templates-modal");
  const feedbackModal = $("#feedback-modal");
  const feedbackReviewModal = $("#feedback-review-modal");
  const userTasksModal = $("#user-tasks-modal");
  const userTasksAdminModal = $("#user-tasks-admin-modal");
  const notificationsModal = $("#notifications-modal");
  const contactsDirectoryModal = $("#contacts-directory-modal");
  if (feedbackModal) {
    feedbackModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeFeedbackModal();
    });
  }
  if (feedbackReviewModal) {
    feedbackReviewModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeFeedbackReviewModal();
    });
  }
  if (userTasksModal) {
    userTasksModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeUserTasksModal();
    });
  }
  if (userTasksAdminModal) {
    userTasksAdminModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeUserTasksAdminModal();
    });
  }
  if (notificationsModal) {
    notificationsModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeNotificationsModal();
    });
  }
  $("#feedback-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = $("#feedback-kind")?.value ?? "request";
    const bodyText = String($("#feedback-body")?.value ?? "").trim();
    if (!bodyText) {
      toast("Description is required", "error");
      return;
    }
    try {
      await apiClient.createFeedback({ kind, body: bodyText });
      toast("Submitted", "success");
      const ta = $("#feedback-body");
      if (ta) ta.value = "";
      await refreshFeedbackMineList();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#user-tasks-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = String($("#user-task-title")?.value ?? "").trim();
    const noteRaw = String($("#user-task-note")?.value ?? "").trim();
    const assigneeRaw = $("#user-task-assignee")?.value;
    const assigneeId = assigneeRaw ? Number(assigneeRaw) : null;
    const category = String($("#user-task-category")?.value ?? "general").trim() || "general";
    if (!title) {
      toast("Title is required", "error");
      return;
    }
    try {
      const payload = { title, note: noteRaw || null, category };
      if (assigneeId) payload.assignee_id = assigneeId;
      const created = await apiClient.createUserTask(payload);
      toast("Task added", "success");
      const titleEl = $("#user-task-title");
      const noteEl = $("#user-task-note");
      const categoryEl = $("#user-task-category");
      if (titleEl) titleEl.value = "";
      if (noteEl) noteEl.value = "";
      if (categoryEl) categoryEl.value = "general";
      if (
        state.user &&
        created.assignee_id === state.user.id &&
        created.user_id !== state.user.id
      ) {
        maybePromptPushOnAssignment();
      }
      await refreshUserTasksMineList();
      await refreshUserTasksCreatedList();
      await refreshNotificationCounts();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#user-tasks-mine-filter")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".user-tasks-filter__btn");
    if (!btn) return;
    const value = btn.dataset.filter || "all";
    if (value === state.userTasksMineFilter) return;
    state.userTasksMineFilter = value;
    for (const b of e.currentTarget.querySelectorAll(".user-tasks-filter__btn")) {
      b.classList.toggle("is-active", b === btn);
    }
    await refreshUserTasksMineList();
  });
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeModal();
    });
  }
  if (editJobModal) {
    editJobModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeEditJobModal();
    });
  }
  if (docsModal) {
    docsModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeDocsModal();
    });
  }
  if (contactsModal) {
    contactsModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeContactsModal();
    });
  }
  if (notesModal) {
    notesModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeNotesModal();
    });
  }
  if (contactsDirectoryModal) {
    contactsDirectoryModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeContactsDirectoryModal();
    });
  }
  if (taskTemplatesModal) {
    taskTemplatesModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeTaskTemplatesModal();
    });
  }
  $("#edit-job-contact-search")?.addEventListener("input", () => renderEditJobContactsPicker());
  $("#edit-job-contact-new-toggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    const w = $("#edit-job-contact-new-wrap");
    if (w) w.hidden = !w.hidden;
  });
  $("#edit-job-contact-new-save")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const payload = {};
    const lab = String($("#edit-job-new-label")?.value ?? "").trim();
    const nam = String($("#edit-job-new-name")?.value ?? "").trim();
    const ph = String($("#edit-job-new-phone")?.value ?? "").trim();
    const em = String($("#edit-job-new-email")?.value ?? "").trim();
    if (lab) payload.label = lab;
    if (nam) payload.name = nam;
    if (ph) payload.phone = ph;
    if (em) payload.email = em;
    if (!Object.keys(payload).length) {
      toast("Enter at least one field", "error");
      return;
    }
    try {
      const created = await apiClient.createContact(payload);
      await refreshContactsCatalog();
      if (
        editJobContactIdsOrder.length < MAX_EDIT_JOB_CONTACTS &&
        !editJobContactIdsOrder.includes(created.id)
      ) {
        editJobContactIdsOrder.push(created.id);
      }
      renderEditJobContactsPicker();
      toast("Contact added to directory and this job", "success");
      const w = $("#edit-job-contact-new-wrap");
      if (w) w.hidden = true;
      for (const id of ["edit-job-new-label", "edit-job-new-name", "edit-job-new-phone", "edit-job-new-email"]) {
        const n = document.getElementById(id);
        if (n) n.value = "";
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#new-job-contact-search")?.addEventListener("input", () => renderNewJobContactsPicker());
  $("#new-job-contact-new-toggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    const w = $("#new-job-contact-new-wrap");
    if (w) w.hidden = !w.hidden;
  });
  $("#new-job-contact-new-save")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const payload = {};
    const lab = String($("#new-job-new-label")?.value ?? "").trim();
    const nam = String($("#new-job-new-name")?.value ?? "").trim();
    const ph = String($("#new-job-new-phone")?.value ?? "").trim();
    const em = String($("#new-job-new-email")?.value ?? "").trim();
    if (lab) payload.label = lab;
    if (nam) payload.name = nam;
    if (ph) payload.phone = ph;
    if (em) payload.email = em;
    if (!Object.keys(payload).length) {
      toast("Enter at least one field", "error");
      return;
    }
    try {
      const created = await apiClient.createContact(payload);
      await refreshContactsCatalog();
      if (
        newJobContactIdsOrder.length < MAX_EDIT_JOB_CONTACTS &&
        !newJobContactIdsOrder.includes(created.id)
      ) {
        newJobContactIdsOrder.push(created.id);
      }
      renderNewJobContactsPicker();
      toast("Contact added to directory and this job", "success");
      const w = $("#new-job-contact-new-wrap");
      if (w) w.hidden = true;
      for (const id of ["new-job-new-label", "new-job-new-name", "new-job-new-phone", "new-job-new-email"]) {
        const n = document.getElementById(id);
        if (n) n.value = "";
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });
  if (sketchesModal) {
    sketchesModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeSketchesModal();
    });
    $("#sketches-modal-new-btn")?.addEventListener("click", () => createSketchFromModal());
    $("#sketches-modal-open-btn")?.addEventListener("click", () => {
      const jobId = sketchesModalState.jobId;
      const sketchId = sketchesModalState.selectedSketchId;
      if (jobId != null && sketchId != null) openSketchEditorForJob(jobId, sketchId);
    });
    $("#sketches-modal-rename-btn")?.addEventListener("click", () => renameSelectedSketch());
    $("#sketches-modal-delete-btn")?.addEventListener("click", () => deleteSelectedSketch());
  }
  if (photosModal) {
    photosModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closePhotosModal();
    });
    $("#photos-modal-remove-btn")?.addEventListener("click", () => removeSelectedModalPhoto());
    if (!photosModalDocDropWired) {
      photosModalDocDropWired = true;
      function preventPhotosModalGlobalDrop(e) {
        const m = $("#photos-modal");
        if (!m || m.hidden) return;
        e.preventDefault();
      }
      document.addEventListener("dragover", preventPhotosModalGlobalDrop, true);
      document.addEventListener("drop", preventPhotosModalGlobalDrop, true);
    }
  }
  const photoViewerOverlay = $("#photo-viewer-overlay");
  if (photoViewerOverlay) {
    photoViewerOverlay.addEventListener("click", (e) => {
      if (e.target.closest("[data-photo-viewer-close]")) closePhotoViewer();
    });
    $("#photo-viewer-prev-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigatePhotoViewer(-1);
    });
    $("#photo-viewer-next-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigatePhotoViewer(1);
    });
    initPhotoViewerGesturesOnce();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && window.SketchEditor?.isOpen?.()) {
      window.SketchEditor.close();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && isPhotoViewerOpen()) {
      closePhotoViewer();
      e.preventDefault();
      return;
    }
    if (isPhotoViewerOpen()) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigatePhotoViewer(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigatePhotoViewer(1);
        return;
      }
    }
    if (e.key === "Escape" && document.querySelector(".card.is-flipped.card--mobile-overlay, .card.is-flipped.card--desktop-overlay")) {
      closeActiveCardOverlay();
      return;
    }
    if (photosModal && !photosModal.hidden) {
      const tag = e.target?.tagName || "";
      const isInputContext = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (!isInputContext && e.key === "ArrowLeft") {
        e.preventDefault();
        navigatePhotosModalSelection(-1);
        return;
      }
      if (!isInputContext && e.key === "ArrowRight") {
        e.preventDefault();
        navigatePhotosModalSelection(1);
        return;
      }
    }
    if (e.key !== "Escape") return;
    if (sketchesModal && !sketchesModal.hidden) {
      closeSketchesModal();
      return;
    }
    if (photosModal && !photosModal.hidden) {
      closePhotosModal();
      return;
    }
    if (contactsModal && !contactsModal.hidden) {
      closeContactsModal();
      return;
    }
    if (notesModal && !notesModal.hidden) {
      closeNotesModal();
      return;
    }
    if (docsModal && !docsModal.hidden) {
      closeDocsModal();
      return;
    }
    if (feedbackReviewModal && !feedbackReviewModal.hidden) {
      closeFeedbackReviewModal();
      return;
    }
    if (userTasksAdminModal && !userTasksAdminModal.hidden) {
      closeUserTasksAdminModal();
      return;
    }
    if (userTasksModal && !userTasksModal.hidden) {
      closeUserTasksModal();
      return;
    }
    if (notificationsModal && !notificationsModal.hidden) {
      closeNotificationsModal();
      return;
    }
    if (feedbackModal && !feedbackModal.hidden) {
      closeFeedbackModal();
      return;
    }
    const cdm = $("#contacts-directory-modal");
    if (cdm && !cdm.hidden) {
      closeContactsDirectoryModal();
      return;
    }
    const um = $("#users-modal");
    if (um && !um.hidden) {
      closeUsersModal();
      return;
    }
    if (taskTemplatesModal && !taskTemplatesModal.hidden) {
      closeTaskTemplatesModal();
      return;
    }
    if (editJobModal && !editJobModal.hidden) {
      closeEditJobModal();
      return;
    }
    if (modal && !modal.hidden) closeModal();
  });
  document.addEventListener(
    "click",
    (e) => {
      const activeCard = document.querySelector(".card.is-flipped.card--mobile-overlay, .card.is-flipped.card--desktop-overlay");
      if (!activeCard) return;
      if (activeCard.contains(e.target)) return;
      closeActiveCardOverlay();
    },
    true
  );
  window.matchMedia(MOBILE_CARD_QUERY).addEventListener("change", () => {
    syncFlippedCardOverlayClasses();
    if (!isMobileCardOverlayViewport()) {
      syncMobileCardHistoryAfterOverlayClosed();
    }
  });
  const form = $("#new-job-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {};
      for (const [key, value] of fd.entries()) {
        const v = String(value).trim();
        if (v) payload[key] = v;
      }
      if (!payload.customer_name) {
        toast("Customer / Job name is required", "error");
        return;
      }
      if (!payload.job_type) {
        toast("Job type is required", "error");
        return;
      }
      const contactIds = collectNewJobContactIdsPayload();
      if (contactIds.length > 0) {
        payload.contact_ids = contactIds;
      }
      const wasClone = cloneFromJobId != null;
      if (wasClone) {
        payload.clone_from_job_id = cloneFromJobId;
      }
      try {
        const job = await apiClient.createJob(payload);
        state.jobs.unshift(job);
        state.jobsById.set(job.id, job);
        $("#empty-state").hidden = true;
        if (state.view === "overview") {
          renderOverviewBars();
          applyFilter();
        } else {
          $("#grid").prepend(renderCard(job));
          reorderCardsByCompletion();
          applyFilter();
        }
        syncJobsPollSignature();
        closeModal();
        toast(
          wasClone
            ? `Cloned job: ${job.customer_name}`
            : `Created job: ${job.customer_name}`,
          "success"
        );
      } catch (err) {
        toast(`Failed to create job: ${err.message}`, "error");
      }
    });
  }
  const editForm = $("#edit-job-form");
  if (editForm) {
    editForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = Number($("#edit-job-id")?.value);
      if (!id) {
        toast("Missing job", "error");
        return;
      }
      const customer_name = String(fd.get("customer_name") || "").trim();
      if (!customer_name) {
        toast("Customer / Job name is required", "error");
        return;
      }
      const opt = (key) => {
        const v = String(fd.get(key) ?? "").trim();
        return v.length ? v : null;
      };
      const payload = {
        customer_name,
        job_type: fd.get("job_type"),
        address: opt("address"),
        pool_type: opt("pool_type"),
        permit_status: opt("permit_status"),
        permit_number: opt("permit_number"),
        field_manager: opt("field_manager"),
        notes: opt("notes"),
        contact_ids: collectEditJobContactIdsPayload(),
      };
      try {
        const updated = await apiClient.updateJob(id, payload);
        replaceJob(updated);
        closeEditJobModal();
        toast("Job updated", "success");
      } catch (err) {
        toast(`Failed to update job: ${err.message}`, "error");
      }
    });
  }
  const editDeleteBtn = $("#edit-job-delete-btn");
  if (editDeleteBtn) {
    editDeleteBtn.addEventListener("click", async () => {
      if (!canArchive()) return;
      const id = Number($("#edit-job-id")?.value);
      if (!id) {
        toast("Missing job", "error");
        return;
      }
      const job = getJobById(id);
      const name = job?.customer_name || "this job";
      const ok = window.confirm(`Delete "${name}"? This cannot be undone.`);
      if (!ok) return;
      try {
        await apiClient.deleteJob(id);
        closeEditJobModal();
        removeJob(id);
        toast("Job deleted", "success");
      } catch (err) {
        toast(`Failed to delete job: ${err.message}`, "error");
      }
    });
  }
}

function openFeedbackModal() {
  const modal = $("#feedback-modal");
  if (!modal) return;
  modal.hidden = false;
  refreshFeedbackMineList();
}

function closeFeedbackModal() {
  const modal = $("#feedback-modal");
  if (modal) modal.hidden = true;
}

async function refreshFeedbackMineList() {
  const wrap = $("#feedback-mine-list");
  if (!wrap) return;
  wrap.textContent = "Loading…";
  try {
    const items = await apiClient.listMyFeedback();
    poller.channels.feedbackMine.lastSig = simpleSignature(items);
    wrap.innerHTML = "";
    if (!items.length) {
      wrap.appendChild(el("p", { class: "feedback-empty" }, "No submissions yet."));
      return;
    }
    for (const it of items) {
      const note = it.admin_note
        ? el("p", { class: "feedback-mine__note" }, ["Response: ", it.admin_note])
        : null;
      wrap.appendChild(
        el("div", { class: "feedback-mine__item" }, [
          el(
            "div",
            { class: "feedback-mine__meta" },
            `${fmtDateTime(it.created_at)} · ${feedbackKindLabel(it.kind)} · ${it.status}`
          ),
          el("div", { class: "feedback-mine__body" }, it.body),
          note,
        ])
      );
    }
  } catch (err) {
    wrap.textContent = "";
    wrap.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

function openFeedbackReviewModal() {
  const modal = $("#feedback-review-modal");
  if (!modal) return;
  modal.hidden = false;
  refreshFeedbackReviewModal();
}

function closeFeedbackReviewModal() {
  const modal = $("#feedback-review-modal");
  if (modal) modal.hidden = true;
}

function openUserTasksModal() {
  const modal = $("#user-tasks-modal");
  if (!modal) return;
  modal.hidden = false;
  loadAssignableUsersForForm();
  refreshUserTasksMineList();
  refreshUserTasksCreatedList();
  refreshCreatorTaskNotificationsList();
}

async function loadAssignableUsersForForm() {
  const sel = $("#user-task-assignee");
  if (!sel) return;
  try {
    const users = await apiClient.listAssignableUsers();
    state.assignableUsers = users;
    sel.innerHTML = "";
    for (const u of users) {
      const opt = el("option", { value: String(u.id) }, u.username);
      if (state.user && u.id === state.user.id) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

function canModifyTaskAttachments(task) {
  if (!state.user) return false;
  return state.user.id === task.user_id || state.user.id === task.assignee_id;
}

function canChangeAssignee(task) {
  if (!state.user) return false;
  if (state.user.role === "admin") return true;
  return state.user.id === task.user_id || state.user.id === task.assignee_id;
}

async function renderUserTaskAttachments(task, container, onRefresh) {
  container.innerHTML = "";
  if (!canModifyTaskAttachments(task)) return;

  const grid = el("div", { class: "user-task__attachment-grid" });
  for (const att of task.attachments || []) {
    const item = el("div", { class: "user-task__attachment-item" });
    if (att.attachment_kind === "image") {
      const img = el("img", {
        class: "user-task__attachment-thumb lazy-thumb",
        alt: att.original_filename,
        loading: "lazy",
      });
      img.dataset.taskId = String(task.id);
      img.dataset.attachmentId = String(att.id);
      item.appendChild(img);
      loadUserTaskAttachmentThumb(img, task.id, att.id);
    } else {
      item.appendChild(
        el("div", { class: "user-task__attachment-pdf" }, att.original_filename || "PDF")
      );
    }
    item.appendChild(
      el(
        "button",
        {
          type: "button",
          class: "btn btn--ghost btn--sm user-task__attachment-remove",
          title: "Remove attachment",
          onclick: async () => {
            const name = att.original_filename || "file";
            if (!window.confirm(`Remove "${name}"?`)) return;
            try {
              await apiClient.deleteUserTaskAttachment(task.id, att.id);
              await onRefresh();
            } catch (err) {
              toast(err.message, "error");
            }
          },
        },
        "×"
      )
    );
    grid.appendChild(item);
  }
  container.appendChild(grid);

  const upload = el("input", {
    type: "file",
    accept: "image/*,.pdf,application/pdf",
    multiple: true,
    class: "user-task__attachment-upload",
    "aria-label": "Add attachments",
  });
  upload.addEventListener("change", async () => {
    const files = Array.from(upload.files || []);
    upload.value = "";
    if (!files.length) return;
    for (const file of files) {
      try {
        await apiClient.uploadUserTaskAttachment(task.id, file);
      } catch (err) {
        toast(err.message, "error");
      }
    }
    await onRefresh();
  });
  container.appendChild(upload);
}

const userTaskThumbCache = new Map();

async function loadUserTaskAttachmentThumb(img, taskId, attachmentId) {
  const key = `${taskId}:${attachmentId}`;
  if (userTaskThumbCache.has(key)) {
    img.src = userTaskThumbCache.get(key);
    return;
  }
  try {
    const url = await apiClient.fetchUserTaskAttachmentThumbUrl(taskId, attachmentId);
    userTaskThumbCache.set(key, url);
    img.src = url;
  } catch {
    img.alt = "Thumbnail unavailable";
  }
}

function renderUserTaskRow(task, onRefresh, options = {}) {
  const { showReorder = false, showAssignee = false, showCreator = false } = options;
  const titleInput = el("input", {
    type: "text",
    class: "user-task__title-input",
    value: task.title,
    maxlength: "255",
    "aria-label": "Task title",
  });
  const noteTa = el("textarea", {
    class: "user-task__note",
    rows: 2,
    maxlength: "8000",
    placeholder: "Optional note…",
    "aria-label": "Task note",
  });
  noteTa.value = task.note || "";

  const saveRow = async () => {
    const title = String(titleInput.value ?? "").trim();
    if (!title) {
      toast("Title is required", "error");
      return;
    }
    const note = String(noteTa.value ?? "").trim() || null;
    try {
      await apiClient.updateUserTask(task.id, { title, note });
      await onRefresh();
      await refreshNotificationCounts();
    } catch (err) {
      toast(err.message, "error");
    }
  };

  titleInput.addEventListener("change", saveRow);
  noteTa.addEventListener("change", saveRow);

  const check = el("input", {
    type: "checkbox",
    class: "user-task__check",
    checked: task.completed ? true : null,
    "aria-label": "Mark complete",
  });
  check.addEventListener("change", async () => {
    try {
      await apiClient.updateUserTask(task.id, { completed: check.checked });
      await onRefresh();
      await refreshNotificationCounts();
    } catch (err) {
      toast(err.message, "error");
      check.checked = task.completed;
    }
  });

  const categorySel = el("select", {
    class: "user-task__category-select",
    "aria-label": "Category",
  });
  for (const [value, label] of [
    ["general", "General"],
    ["sales", "Sales"],
    ["construction", "Construction"],
    ["warranty", "Warranty"],
  ]) {
    const opt = el("option", { value }, label);
    if ((task.category || "general") === value) opt.selected = true;
    categorySel.appendChild(opt);
  }
  categorySel.addEventListener("change", async () => {
    const category = categorySel.value;
    if (category === (task.category || "general")) return;
    try {
      await apiClient.updateUserTask(task.id, { category });
      await onRefresh();
    } catch (err) {
      toast(err.message, "error");
      categorySel.value = task.category || "general";
    }
  });

  const titleRow = el("div", { class: "user-task__title-row" }, [titleInput]);
  if (showCreator && task.creator_username && task.user_id !== state.user?.id) {
    titleRow.appendChild(
      el("span", {
        class: "user-task__from-badge",
        title: `Assigned by ${task.creator_username}`,
      }, `From ${task.creator_username}`)
    );
  }

  const bodyChildren = [titleRow, categorySel, noteTa];

  if (showAssignee && task.assignee_username) {
    bodyChildren.push(
      el("div", { class: "user-task__meta" }, `Assigned to ${task.assignee_username}`)
    );
  }

  if (showAssignee && canChangeAssignee(task)) {
    const assigneeSel = el("select", {
      class: "user-task__assignee-select",
      "aria-label": "Assignee",
    });
    for (const u of state.assignableUsers || []) {
      const opt = el("option", { value: String(u.id) }, u.username);
      if (u.id === task.assignee_id) opt.selected = true;
      assigneeSel.appendChild(opt);
    }
    assigneeSel.addEventListener("change", async () => {
      const assigneeId = Number(assigneeSel.value);
      if (!assigneeId || assigneeId === task.assignee_id) return;
      try {
        const updated = await apiClient.updateUserTask(task.id, { assignee_id: assigneeId });
        if (
          state.user &&
          assigneeId === state.user.id &&
          updated.user_id !== state.user.id
        ) {
          maybePromptPushOnAssignment();
        }
        await onRefresh();
        await refreshNotificationCounts();
      } catch (err) {
        toast(err.message, "error");
        assigneeSel.value = String(task.assignee_id);
      }
    });
    bodyChildren.push(assigneeSel);
  }

  const attachmentsWrap = el("div", { class: "user-task__attachments" });
  renderUserTaskAttachments(task, attachmentsWrap, onRefresh);

  bodyChildren.push(attachmentsWrap);

  const actions = [];
  actions.push(
    el("button", {
      type: "button",
      class: task.is_pinned ? "btn btn--ghost btn--sm user-task__pin user-task__pin--active" : "btn btn--ghost btn--sm user-task__pin",
      title: task.is_pinned ? "Unpin task" : "Pin task to top",
      "aria-label": task.is_pinned ? "Unpin task" : "Pin task to top",
      onclick: async () => {
        try {
          await apiClient.updateUserTask(task.id, { is_pinned: !task.is_pinned });
          await onRefresh();
        } catch (err) {
          toast(err.message, "error");
        }
      },
    }, task.is_pinned ? "📌 Pinned" : "📌 Pin")
  );
  if (showReorder) {
    actions.push(
      el("button", {
        type: "button",
        class: "btn btn--ghost btn--sm",
        title: "Move up",
        onclick: async () => {
          try {
            await apiClient.moveUserTask(task.id, "up");
            await onRefresh();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      }, "↑"),
      el("button", {
        type: "button",
        class: "btn btn--ghost btn--sm",
        title: "Move down",
        onclick: async () => {
          try {
            await apiClient.moveUserTask(task.id, "down");
            await onRefresh();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      }, "↓")
    );
  }
  actions.push(
    el("button", {
      type: "button",
      class: "btn btn--ghost btn--sm user-task__delete",
      onclick: async () => {
        if (!window.confirm("Delete this task?")) return;
        try {
          await apiClient.deleteUserTask(task.id);
          await onRefresh();
          await refreshUserTasksCreatedList();
          await refreshNotificationCounts();
        } catch (err) {
          toast(err.message, "error");
        }
      },
    }, "Delete")
  );

  bodyChildren.push(el("div", { class: "user-task__actions" }, actions));

  return el("div", {
    class: task.is_pinned ? "user-task user-task--pinned" : "user-task",
    dataset: {
      completed: task.completed ? "1" : "0",
      pinned: task.is_pinned ? "1" : "0",
      category: task.category || "general",
    },
  }, [
    check,
    el("div", { class: "user-task__body" }, bodyChildren),
  ]);
}

function filterUserTasksMine(items) {
  if (state.userTasksMineFilter === "assigned") {
    return (items ?? []).filter((t) => t.user_id !== state.user?.id);
  }
  if (state.userTasksMineFilter === "own") {
    return (items ?? []).filter((t) => t.user_id === state.user?.id);
  }
  return items ?? [];
}

async function refreshUserTasksMineList() {
  const wrap = $("#user-tasks-mine-list");
  if (!wrap) return;
  wrap.textContent = "Loading…";
  try {
    const items = await apiClient.listMyUserTasks();
    poller.channels.userTasksMine.lastSig = userTasksSignature(items);
    wrap.innerHTML = "";
    const visible = filterUserTasksMine(items);
    if (!visible.length) {
      wrap.appendChild(
        el(
          "p",
          { class: "user-tasks-empty" },
          items.length ? "No tasks match this filter." : "No tasks assigned to you."
        )
      );
      return;
    }
    for (const task of visible) {
      wrap.appendChild(
        renderUserTaskRow(task, async () => {
          await refreshUserTasksMineList();
          await refreshUserTasksCreatedList();
        }, { showReorder: true, showCreator: true })
      );
    }
  } catch (err) {
    wrap.textContent = "";
    wrap.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

async function refreshCreatorTaskNotificationsList() {
  const wrap = $("#user-task-notifications-list");
  if (!wrap) return;
  try {
    const items = (await apiClient.listMyTaskNotifications()).filter((n) => !n.read);
    wrap.innerHTML = "";
    if (!items.length) return;
    for (const item of items) {
      wrap.appendChild(
        el("div", { class: "user-task-notification" }, [
          el("div", {}, [
            el("strong", {}, item.title),
            el("div", {}, item.message),
          ]),
          el("button", {
            type: "button",
            class: "btn btn--ghost btn--sm",
            onclick: async () => {
              try {
                await apiClient.markTaskNotificationRead(item.id);
                await refreshCreatorTaskNotificationsList();
                await refreshNotificationCounts();
              } catch (err) {
                toast(err.message, "error");
              }
            },
          }, "Dismiss"),
        ])
      );
    }
  } catch {
    wrap.innerHTML = "";
  }
}

async function refreshUserTasksCreatedList() {
  const wrap = $("#user-tasks-created-list");
  if (!wrap) return;
  wrap.textContent = "Loading…";
  try {
    const items = await apiClient.listCreatedUserTasks();
    wrap.innerHTML = "";
    if (!items.length) {
      wrap.appendChild(el("p", { class: "user-tasks-empty" }, "No tasks assigned to others."));
      return;
    }
    for (const task of items) {
      wrap.appendChild(
        renderUserTaskRow(task, async () => {
          await refreshUserTasksMineList();
          await refreshUserTasksCreatedList();
        }, { showAssignee: true })
      );
    }
  } catch (err) {
    wrap.textContent = "";
    wrap.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

async function refreshUserTasksAdminList() {
  const wrap = $("#user-tasks-admin-list");
  const userId = state.adminTasksUserId;
  if (!wrap || !userId) return;
  wrap.textContent = "Loading…";
  try {
    const items = await apiClient.listAllUserTasks(userId);
    poller.channels.userTasksAll.lastSig = userTasksSignature(items);
    wrap.innerHTML = "";
    if (!items.length) {
      wrap.appendChild(el("p", { class: "user-tasks-empty" }, "No tasks for this user."));
      return;
    }
    for (const task of items) {
      wrap.appendChild(
        renderUserTaskRow(task, refreshUserTasksAdminList, {
          showReorder: true,
          showCreator: true,
        })
      );
    }
  } catch (err) {
    wrap.textContent = "";
    wrap.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

function closeUserTasksModal() {
  const modal = $("#user-tasks-modal");
  if (modal) modal.hidden = true;
}

function openUserTasksAdminModal(userId, username) {
  const modal = $("#user-tasks-admin-modal");
  if (!modal) return;
  state.adminTasksUserId = userId;
  state.adminTasksUsername = username;
  const nameEl = $("#user-tasks-admin-username");
  if (nameEl) nameEl.textContent = username;
  modal.hidden = false;
  loadAssignableUsersForForm();
  refreshUserTasksAdminList();
}

function closeUserTasksAdminModal() {
  const modal = $("#user-tasks-admin-modal");
  if (modal) modal.hidden = true;
  state.adminTasksUserId = null;
  state.adminTasksUsername = null;
}

function openNotificationsModal() {
  const modal = $("#notifications-modal");
  if (!modal) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeFeedbackModal();
  closeFeedbackReviewModal();
  closeUserTasksModal();
  closeUserTasksAdminModal();
  closeDocsModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  closeNotesModal();
  closeTaskTemplatesModal();
  modal.hidden = false;
  refreshNotificationsModal();
}

function closeNotificationsModal() {
  const modal = $("#notifications-modal");
  if (modal) modal.hidden = true;
}

async function refreshNotificationsModal() {
  const body = $("#notifications-modal-body");
  if (!body) return;
  body.textContent = "Loading…";
  try {
    const items = await apiClient.listNotifications();
    poller.channels.notifications.lastSig = simpleSignature(items);
    setNotificationsState(items);
    body.innerHTML = "";
    if (!state.notifications.length) {
      body.appendChild(el("p", { class: "notifications-empty" }, "No billing notifications yet."));
      return;
    }

    const activeItems = state.notifications.filter((item) => !item.billed);
    const billedItems = state.notifications.filter((item) => item.billed);

    const activeSection = el("section", { class: "notifications-section" }, [
      el("h3", { class: "notifications-section__title" }, "Active"),
    ]);
    if (!activeItems.length) {
      activeSection.appendChild(
        el("p", { class: "notifications-empty" }, "No active billing notifications.")
      );
    } else {
      const activeList = el("ul", { class: "notifications-list" });
      for (const item of activeItems) activeList.appendChild(renderNotificationItem(item));
      activeSection.appendChild(activeList);
    }
    body.appendChild(activeSection);

    const accordion = el("details", { class: "notifications-accordion" }, [
      el("summary", { class: "notifications-accordion__summary" }, `Billed (${billedItems.length})`),
    ]);
    if (!billedItems.length) {
      accordion.appendChild(el("p", { class: "notifications-empty" }, "No billed items yet."));
    } else {
      const billedList = el("ul", { class: "notifications-list notifications-list--billed" });
      for (const item of billedItems) billedList.appendChild(renderNotificationItem(item));
      accordion.appendChild(billedList);
    }
    body.appendChild(accordion);
  } catch (err) {
    body.textContent = "";
    body.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

function renderNotificationItem(item) {
  const createdBits = [fmtDateTime(item.created_at)];
  if (item.task_key) createdBits.push(item.task_key);
  const billedBits = [];
  if (item.billed_at) billedBits.push(`Billed ${fmtDateTime(item.billed_at)}`);
  if (item.billed_by_user_id != null) billedBits.push(`by user #${item.billed_by_user_id}`);

  return el("li", { class: `notifications-list__item${item.billed ? " is-billed" : ""}` }, [
    el("div", { class: "notifications-list__title" }, item.title || "Billing notification"),
    el("div", { class: "notifications-list__body" }, item.message || ""),
    el("div", { class: "notifications-list__meta" }, createdBits.join(" · ")),
    billedBits.length
      ? el("div", { class: "notifications-list__meta notifications-list__meta--billed" }, billedBits.join(" · "))
      : null,
    canViewBillingNotifications()
      ? el(
          "button",
          {
            type: "button",
            class: "btn btn--ghost btn--sm notifications-list__toggle",
            onclick: async () => {
              try {
                await apiClient.updateNotification(item.id, { billed: !item.billed });
                await refreshNotificationsModal();
                await refreshNotificationCounts();
                toast(item.billed ? "Marked unbilled" : "Marked billed", "success");
              } catch (err) {
                toast(`Failed to update notification: ${err.message}`, "error");
              }
            },
          },
          item.billed ? "Mark unbilled" : "Mark billed"
        )
      : null,
  ]);
}

async function refreshFeedbackReviewModal() {
  const body = $("#feedback-review-modal-body");
  if (!body) return;
  body.textContent = "Loading…";
  try {
    const items = await apiClient.listAllFeedback();
    poller.channels.feedbackAll.lastSig = simpleSignature(items);
    body.innerHTML = "";
    if (!items.length) {
      body.appendChild(el("p", { class: "feedback-empty" }, "No submissions yet."));
      return;
    }
    const table = el("table", { class: "users-table feedback-review-table" });
    table.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          "When",
          "User",
          "Type",
          "Description",
          "Status",
          "Admin note",
          "",
        ].map((h) => el("th", {}, h))),
      ])
    );
    const tb = el("tbody", {});
    for (const it of items) {
      const statusSelect = el(
        "select",
        { name: `fb-status-${it.id}`, class: "feedback-review-status-select" },
        [
          el("option", { value: "open", selected: it.status === "open" ? true : null }, "open"),
          el("option", { value: "closed", selected: it.status === "closed" ? true : null }, "closed"),
        ]
      );
      const noteTa = el("textarea", {
        name: `fb-note-${it.id}`,
        rows: 2,
        class: "feedback-review-note",
        placeholder: "Optional note to user…",
      });
      noteTa.value = it.admin_note || "";
      tb.appendChild(
        el("tr", { dataset: { feedbackId: String(it.id) } }, [
          el("td", {}, fmtDateTime(it.created_at)),
          el("td", {}, it.author_username || "—"),
          el("td", {}, feedbackKindLabel(it.kind)),
          el(
            "td",
            { class: "feedback-review-table__body-cell" },
            el("div", { class: "feedback-review-body-scroll" }, it.body)
          ),
          el("td", { class: "feedback-review-table__status-cell" }, [statusSelect]),
          el("td", { class: "feedback-review-table__note-cell" }, [noteTa]),
          el(
            "td",
            { class: "users-table__actions" },
            el(
              "button",
              {
                type: "button",
                class: "btn btn--ghost btn--sm",
                onclick: async () => {
                  try {
                    await apiClient.updateFeedback(it.id, {
                      status: statusSelect.value,
                      admin_note: noteTa.value.trim() || null,
                    });
                    toast("Saved", "success");
                    refreshFeedbackReviewModal();
                  } catch (err) {
                    toast(err.message, "error");
                  }
                },
              },
              "Save"
            )
          ),
        ])
      );
    }
    table.appendChild(tb);
    body.appendChild(table);
  } catch (err) {
    body.textContent = "";
    body.appendChild(el("p", { class: "users-error" }, `Failed to load: ${err.message}`));
  }
}

function openUsersModal() {
  const modal = $("#users-modal");
  if (!modal) return;
  closeContactsDirectoryModal();
  closeTaskTemplatesModal();
  modal.hidden = false;
  refreshUsersModal();
}

function closeUsersModal() {
  const modal = $("#users-modal");
  if (modal) modal.hidden = true;
}

function openTaskTemplatesModal() {
  const modal = $("#task-templates-modal");
  if (!modal) return;
  closeModal();
  closeEditJobModal();
  closeDocsModal();
  closePhotosModal();
  closeSketchesModal();
  closeContactsModal();
  closeNotesModal();
  closeFeedbackModal();
  closeFeedbackReviewModal();
  closeUserTasksModal();
  closeUserTasksAdminModal();
  closeNotificationsModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  modal.hidden = false;
  refreshTaskTemplatesModal();
}

function closeTaskTemplatesModal() {
  const modal = $("#task-templates-modal");
  if (modal) modal.hidden = true;
}

async function refreshTaskTemplatesModal() {
  const body = $("#task-templates-modal-body");
  if (!body) return;
  body.textContent = "Loading…";
  try {
    const jobTypes = ["sales", "new_construction", "renovation", "misc"];
    const lists = await Promise.all(jobTypes.map((jt) => apiClient.listTaskTemplates(jt)));
    body.innerHTML = "";
    for (let i = 0; i < jobTypes.length; i += 1) {
      const jobType = jobTypes[i];
      const rows = lists[i] || [];
      const section = el("section", { class: "task-templates__section" }, [
        el("h3", { class: "users-section-title" }, jobTypeLabel(jobType)),
      ]);
      const list = el("ul", { class: "task-templates__list" });
      if (!rows.length) {
        list.appendChild(el("li", { class: "task-templates__empty" }, "No custom template tasks yet."));
      } else {
        for (const row of rows) {
          list.appendChild(el("li", { class: "task-templates__item" }, row.task_label));
        }
      }
      const addRow = el("div", { class: "task-templates__add" }, [
        el("input", {
          type: "text",
          class: "task-templates__input",
          placeholder: "New template task label",
          maxlength: "128",
        }),
        el(
          "button",
          {
            type: "button",
            class: "btn btn--ghost btn--sm",
            onclick: async (e) => {
              const wrap = e.currentTarget.closest(".task-templates__add");
              const input = wrap?.querySelector("input");
              const label = String(input?.value || "").trim();
              if (!label) return;
              try {
                await apiClient.createTaskTemplate({ job_type: jobType, task_label: label });
                if (input) input.value = "";
                toast("Template task added", "success");
                await refreshTaskTemplatesModal();
              } catch (err) {
                toast(`Failed to add template task: ${err.message}`, "error");
              }
            },
          },
          "Add"
        ),
      ]);
      section.appendChild(list);
      section.appendChild(addRow);
      body.appendChild(section);
    }
  } catch (err) {
    body.textContent = "";
    body.appendChild(el("p", { class: "users-error" }, `Failed to load templates: ${err.message}`));
  }
}

async function refreshUsersModal() {
  const body = $("#users-modal-body");
  if (!body) return;
  body.textContent = "Loading…";
  try {
    const users = await apiClient.listUsers();
    poller.channels.users.lastSig = simpleSignature(users);
    body.innerHTML = "";
    const addForm = el("div", { class: "users-add" }, [
      el("h3", { class: "users-section-title" }, "Add user"),
      el("div", { class: "users-add__row" }, [
        el("input", { name: "nu_username", placeholder: "Username", autocomplete: "off" }),
        el("input", { name: "nu_password", type: "password", placeholder: "Password", autocomplete: "new-password" }),
        el(
          "select",
          { name: "nu_role" },
          [
            el("option", { value: "field" }, "field"),
            el("option", { value: "office" }, "office"),
            el("option", { value: "admin" }, "admin"),
          ]
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn btn--primary",
            onclick: async () => {
              const u = body.querySelector("input[name='nu_username']")?.value?.trim();
              const p = body.querySelector("input[name='nu_password']")?.value ?? "";
              const role = body.querySelector("select[name='nu_role']")?.value ?? "field";
              if (!u || !p) {
                toast("Username and password required", "error");
                return;
              }
              try {
                await apiClient.createUser({ username: u, password: p, role });
                toast("User created", "success");
                refreshUsersModal();
              } catch (err) {
                toast(err.message, "error");
              }
            },
          },
          "Create"
        ),
      ]),
    ]);
    body.appendChild(addForm);

    const table = el("table", { class: "users-table" });
    table.appendChild(
      el("thead", {}, [
        el("tr", {}, ["Username", "Role", "Active", "New password", "Actions"].map((h) => el("th", {}, h))),
      ])
    );
    const tb = el("tbody", {});
    for (const u of users) {
      const roleSelect = el(
        "select",
        { name: `role-${u.id}` },
        ["admin", "office", "field"].map((r) =>
          el("option", { value: r, selected: r === u.role ? true : null }, r)
        )
      );
      const activeCb = el("input", { type: "checkbox", checked: u.is_active ? true : null });
      const passInput = el("input", { type: "password", placeholder: "optional", autocomplete: "new-password" });
      tb.appendChild(
        el("tr", { dataset: { userId: String(u.id) } }, [
          el("td", {}, u.username),
          el("td", {}, [roleSelect]),
          el("td", {}, [activeCb]),
          el("td", {}, [passInput]),
          el(
            "td",
            { class: "users-table__actions" },
            [
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn--ghost btn--sm",
                  onclick: () => openUserTasksAdminModal(u.id, u.username),
                },
                "Tasks"
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn--ghost btn--sm",
                  onclick: async () => {
                    const payload = {
                      role: roleSelect.value,
                      is_active: activeCb.checked,
                    };
                    const np = passInput.value?.trim();
                    if (np) payload.password = np;
                    try {
                      await apiClient.updateUser(u.id, payload);
                      toast("User updated", "success");
                      refreshUsersModal();
                    } catch (err) {
                      toast(err.message, "error");
                    }
                  },
                },
                "Save"
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "btn btn--ghost btn--sm",
                  onclick: async () => {
                    if (!confirm(`Delete user ${u.username}?`)) return;
                    try {
                      await apiClient.deleteUser(u.id);
                      toast("User removed", "success");
                      refreshUsersModal();
                    } catch (err) {
                      toast(err.message, "error");
                    }
                  },
                },
                "Delete"
              ),
            ]
          ),
        ])
      );
    }
    table.appendChild(tb);
    body.appendChild(el("h3", { class: "users-section-title" }, "Users"));
    body.appendChild(table);
  } catch (err) {
    body.textContent = "";
    body.appendChild(el("p", { class: "users-error" }, `Failed to load users: ${err.message}`));
  }
}

// ---- Role visibility -----------------------------------------------------

function applyRoleVisibility() {
  for (const btn of $$('[data-menu-action="new-job"]')) btn.hidden = !canCreateJob();
  for (const btn of $$('[data-menu-action="notifications"]')) btn.hidden = !canViewBillingNotifications();
  for (const btn of $$('[data-menu-action="users"]')) btn.hidden = !canManageUsers();
  for (const btn of $$('[data-menu-action="contacts"]')) btn.hidden = !canCreateJob();
  for (const btn of $$('[data-menu-action="review-feedback"]')) btn.hidden = !canManageUsers();
  for (const btn of $$('[data-menu-action="task-templates"]')) btn.hidden = !canCreateJob();
  for (const btn of $$('[data-job-type-filter="sales"]')) btn.hidden = !canViewSalesJobs();
  for (const btn of $$('[data-job-type-filter="archived"]')) btn.hidden = !canViewArchivedJobs();
  if (!canViewArchivedJobs() && state.includeArchived) state.includeArchived = false;
  renderUserMenuBadge();
}

// ---- Boot ----------------------------------------------------------------

async function loadJobs() {
  try {
    const jobs = await apiClient.listJobs();
    state.jobs = jobs;
    state.jobsById = new Map(jobs.map((j) => [j.id, j]));
    poller.channels.jobs.lastSig = jobsSignature(jobs);
    renderAll();
  } catch (err) {
    toast(`Failed to load jobs: ${err.message}`, "error");
  }
}

function wireSearch() {
  $("#search")?.addEventListener("input", (e) => {
    state.filter = e.target.value || "";
    applyFilter();
  });
}

function refreshJobTypeTabs() {
  if (!canViewSalesJobs() && state.jobTypeFilter === "sales") {
    state.jobTypeFilter = "all";
  }
  if (!canViewArchivedJobs() && state.includeArchived) {
    state.includeArchived = false;
  }
  const counts = {
    all: state.jobs.length,
    sales: 0,
    new_construction: 0,
    renovation: 0,
    misc: 0,
  };
  for (const job of state.jobs) {
    const jt = normalizeJobType(job.job_type);
    counts[jt] = (counts[jt] || 0) + 1;
  }
  for (const btn of $$("[data-job-type-filter]")) {
    const key = btn.dataset.jobTypeFilter || "all";
    if (key === "archived") {
      btn.hidden = !canViewArchivedJobs();
      btn.textContent = "Archived";
      btn.classList.toggle("is-active", state.includeArchived);
      continue;
    }
    const isSalesBtn = key === "sales";
    if (isSalesBtn) btn.hidden = !canViewSalesJobs();
    const label = JOB_TYPE_LABELS[key] || JOB_TYPE_LABELS.all;
    const count = isSalesBtn && !canViewSalesJobs() ? 0 : (counts[key] ?? 0);
    btn.textContent = `${label} (${count})`;
    btn.classList.toggle("is-active", !state.includeArchived && key === state.jobTypeFilter);
  }
}

function wireJobTypeTabs() {
  for (const btn of $$("[data-job-type-filter]")) {
    btn.addEventListener("click", async () => {
      const selected = btn.dataset.jobTypeFilter || "all";
      if (selected === "archived") {
        if (!canViewArchivedJobs()) return;
        state.includeArchived = true;
        state.jobTypeFilter = "all";
        refreshJobTypeTabs();
        await loadJobs();
        return;
      }
      if (selected === "sales" && !canViewSalesJobs()) {
        state.jobTypeFilter = "all";
        refreshJobTypeTabs();
        applyFilter();
        return;
      }
      if (state.includeArchived) {
        state.includeArchived = false;
        state.jobTypeFilter = selected;
        refreshJobTypeTabs();
        await loadJobs();
        return;
      }
      state.jobTypeFilter = selected;
      refreshJobTypeTabs();
      applyFilter();
    });
  }
  refreshJobTypeTabs();
}

function wireShell() {
  const userBtn = $("#user-menu-btn");
  const menu = $("#user-menu");
  const mobileMenuModal = $("#mobile-user-menu-modal");
  if (userBtn && menu) {
    userBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (shouldUseMobileUserMenu(menu)) {
        if (mobileMenuModal?.hidden === false) closeMobileUserMenu();
        else openMobileUserMenu();
        return;
      }
      closeMobileUserMenu();
      menu.hidden = !menu.hidden;
      userBtn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    });
    document.addEventListener("click", (e) => {
      if (isMobileUserMenuViewport()) return;
      if (!menu.hidden && !e.target.closest(".topbar__user-menu")) closeUserMenu();
    });
  }

  if (mobileMenuModal) {
    mobileMenuModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeMobileUserMenu();
    });
  }

  const menuActionHandlers = {
    logout: async () => {
      logout();
    },
    users: async () => {
      openUsersModal();
    },
    contacts: async () => {
      if (!canCreateJob()) return;
      await openContactsDirectoryModal();
    },
    feedback: async () => {
      openFeedbackModal();
    },
    notifications: async () => {
      if (!canViewBillingNotifications()) return;
      openNotificationsModal();
    },
    "review-feedback": async () => {
      openFeedbackReviewModal();
    },
    "user-tasks": async () => {
      openUserTasksModal();
    },
    "push-toggle": async () => {
      await togglePushNotifications();
    },
    "new-job": async () => {
      openModal();
    },
    "task-templates": async () => {
      if (!canCreateJob()) return;
      openTaskTemplatesModal();
    },
  };
  for (const btn of $$("[data-menu-action]")) {
    btn.addEventListener("click", async () => {
      closeAllUserMenus();
      const action = btn.dataset.menuAction;
      const handler = menuActionHandlers[action];
      if (handler) await handler();
    });
  }

  $("#topbar-logo")?.addEventListener("click", () => {
    closeAllUserMenus();
    state.view = state.view === "overview" ? "cards" : "overview";
    renderAll();
  });

  $("#users-modal")?.addEventListener("click", (e) => {
    if (e.target.dataset.close === "1") closeUsersModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllUserMenus();
  });
  syncUserMenu();
}

function showAppShell() {
  $("#login-screen").hidden = true;
  $("#app-shell").hidden = false;
}

async function tryResumeSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return false;
  state.token = token;
  try {
    // Stale token on load: clear quietly (no toast/reload) so login is not raced by a pending reload.
    state.user = await api("/auth/me", { sessionExpiredUI: false });
    resetSessionAuthState();
    return true;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    state.user = null;
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const loginForm = $("#login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(loginForm);
      const username = String(fd.get("username") || "").trim();
      const password = String(fd.get("password") || "");
      if (!username || !password) {
        toast("Enter username and password", "error");
        return;
      }
      try {
        const data = await loginRequest(username, password);
        resetSessionAuthState();
        localStorage.setItem(TOKEN_KEY, data.access_token);
        state.token = data.access_token;
        state.user = await apiClient.me();
        showAppShell();
        syncUserMenu();
        applyRoleVisibility();
        wireModal();
        wireSearch();
        wireJobTypeTabs();
        wireShell();
        await loadJobs();
        await refreshContactsCatalog();
        await refreshNotificationCounts();
        startAppPolling();
        toast(`Signed in as ${state.user.username}`, "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    const loginPass = $("#login-password");
    const loginPassToggle = $("#login-password-toggle");
    if (loginPass && loginPassToggle) {
      loginPassToggle.addEventListener("click", () => {
        const visible = loginPass.type === "text";
        loginPass.type = visible ? "password" : "text";
        loginPassToggle.setAttribute("aria-pressed", visible ? "false" : "true");
        loginPassToggle.setAttribute("aria-label", visible ? "Show password" : "Hide password");
        loginPassToggle.textContent = visible ? "Show" : "Hide";
      });
    }
  }

  if (await tryResumeSession()) {
    showAppShell();
    syncUserMenu();
    applyRoleVisibility();
    wireModal();
    wireSearch();
    wireJobTypeTabs();
    wireShell();
    await loadJobs();
    await refreshContactsCatalog();
    await refreshNotificationCounts();
    startAppPolling();
  }

  document.addEventListener("visibilitychange", () => {
    if (!poller.active) return;
    if (!document.hidden) scheduleNextPoll(300);
  });
});
