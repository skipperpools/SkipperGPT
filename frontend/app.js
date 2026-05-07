/* ============================================================
   Skipper Pools - Job Card Dashboard (vanilla JS)
   Talks only to /api/* routes; never accesses the DB directly.
   ============================================================ */

const API = "/api";
const TOKEN_KEY = "access_token";

const state = {
  token: null,
  user: null,
  includeArchived: false,
  jobs: [],
  jobsById: new Map(),
  filter: "",
  /** @type {"cards" | "overview"} */
  view: "cards",
  notifications: [],
  unbilledNotificationCount: 0,
  /** @type {Array<{id:number,label?:string,name?:string,phone?:string,email?:string}>} */
  contactsCatalog: [],
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
  pageIndex: 0,
};
const PHOTOS_MODAL_PAGE_SIZE = 12;

const photoViewerState = {
  objectUrl: null,
  loadSeq: 0,
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
};

// Card-back thumbnail grid: 4 columns x 2 rows.
const VISIBLE_PHOTO_COUNT = 8;
/** Max chars of job notes shown on the unflipped card front. */
const JOB_NOTES_PREVIEW_MAX = 250;
/** Must match backend MAX_JOB_CONTACTS. */
const MAX_EDIT_JOB_CONTACTS = 25;

/** Ordered contact ids for Edit Job modal (shared directory). */
let editJobContactIdsOrder = [];

/** When set, directory form PATCHes this contact instead of POST create. */
let contactsDirectoryEditingId = null;

/**
 * @param {string|null|undefined} text
 * @param {number} [maxLen]
 * @returns {{ text: string, truncated: boolean, full: string } | null}
 */
function truncateJobNotesPreview(text, maxLen = JOB_NOTES_PREVIEW_MAX) {
  const full = (text ?? "").trim();
  if (!full) return null;
  if (full.length <= maxLen) return { text: full, truncated: false, full };
  return { text: full.slice(0, maxLen) + "…", truncated: true, full };
}

function jobHasContacts(job) {
  return Array.isArray(job.contacts) && job.contacts.length > 0;
}

async function refreshContactsCatalog() {
  try {
    state.contactsCatalog = await apiClient.listContacts();
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
  closeNotificationsModal();
  closeDocsModal();
  closePhotosModal();
  closeContactsModal();
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

async function getPhotoThumbUrl(jobId, photo) {
  const cached = photoThumbUrlCache.get(photo.id);
  if (cached) return cached;
  const blob = await apiClient.fetchJobPhotoThumbBlob(jobId, photo.id);
  const url = URL.createObjectURL(blob);
  photoThumbUrlCache.set(photo.id, url);
  return url;
}

async function getDocThumbUrl(jobId, doc) {
  const cached = docThumbUrlCache.get(doc.id);
  if (cached) return cached;
  const blob = await apiClient.fetchJobDocumentThumbBlob(jobId, doc.id);
  const url = URL.createObjectURL(blob);
  docThumbUrlCache.set(doc.id, url);
  return url;
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
  return [
    job.customer_name,
    job.address,
    job.field_manager,
    job.permit_number,
    job.permit_status,
    job.pool_type,
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

function canArchive() {
  return state.user?.role === "admin";
}

function canEditJobAdmin() {
  return state.user?.role === "admin";
}

function canManageUsers() {
  return state.user?.role === "admin";
}

function canViewBillingNotifications() {
  const role = state.user?.role;
  return role === "admin" || role === "office";
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

function setArchivedMenuLabel() {
  const label = state.includeArchived ? "View active projects" : "View archived projects";
  for (const archivedBtn of $$('[data-menu-action="view-archived"]')) {
    archivedBtn.textContent = label;
  }
}

function syncUserMenu() {
  const userLabel = $("#user-menu-label");
  if (userLabel) userLabel.textContent = state.user?.username || "Account";
  renderUserMenuBadge();
  setArchivedMenuLabel();
}

function setNotificationsState(items) {
  state.notifications = Array.isArray(items) ? items : [];
  state.unbilledNotificationCount = state.notifications.filter((item) => !item.billed).length;
  renderUserMenuBadge();
}

function renderUserMenuBadge() {
  const badge = $("#user-menu-badge");
  if (!badge) return;
  if (!canViewBillingNotifications()) {
    badge.hidden = true;
    badge.textContent = "0";
    return;
  }
  const count = Number(state.unbilledNotificationCount || 0);
  if (count <= 0) {
    badge.hidden = true;
    badge.textContent = "0";
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 99 ? "99+" : String(count);
}

async function refreshNotificationBadgeCount() {
  if (!canViewBillingNotifications()) {
    setNotificationsState([]);
    return;
  }
  try {
    const items = await apiClient.listNotifications();
    setNotificationsState(items);
  } catch {
    // Keep the last known count if this refresh fails.
  }
}

function authHeaders() {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  location.reload();
}

// ---- API client ----------------------------------------------------------

async function api(path, opts = {}) {
  const init = {
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    ...opts,
  };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const res = await fetch(`${API}${path}`, init);
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    toast("Session expired — please sign in again.", "error");
    setTimeout(() => location.reload(), 800);
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
  const headers = { ...authHeaders(), ...(init.headers || {}) };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    toast("Session expired — please sign in again.", "error");
    setTimeout(() => location.reload(), 800);
    throw new Error("Unauthorized");
  }
  return res;
}

async function loginRequest(username, password) {
  const body = new URLSearchParams();
  body.set("username", username);
  body.set("password", password);
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
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
    if (state.user?.role === "admin" && state.includeArchived) {
      params.set("include_archived", "true");
    }
    const qs = params.toString();
    return api(qs ? `/jobs?${qs}` : "/jobs");
  },
  createJob: (payload) => api("/jobs", { method: "POST", body: payload }),
  updateJob: (id, payload) => api(`/jobs/${id}`, { method: "PATCH", body: payload }),
  listContacts: () => api("/contacts"),
  createContact: (payload) => api("/contacts", { method: "POST", body: payload }),
  updateContact: (id, payload) => api(`/contacts/${id}`, { method: "PATCH", body: payload }),
  deleteContact: (id) => api(`/contacts/${id}`, { method: "DELETE" }),
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
  listNotifications: () => api("/notifications"),
  updateNotification: (id, payload) => api(`/notifications/${id}`, { method: "PATCH", body: payload }),
  uploadJobDocument: async (jobId, files, title, category = "field") => {
    const list = Array.from(files ?? []);
    if (!list.length) throw new Error("No files selected");
    const fd = new FormData();
    for (const file of list) fd.append("files", file);
    const t = String(title || "").trim();
    if (t) fd.append("title", t);
    const c = String(category || "field").trim().toLowerCase();
    fd.append("category", c === "permit" ? "permit" : "field");
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
    const res = await authFetch(`/jobs/${jobId}/documents/${documentId}/file`);
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
    const res = await authFetch(`/jobs/${jobId}/photos/${photoId}/file`);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchJobPhotoThumbBlob: async (jobId, photoId) => {
    const res = await authFetch(`/jobs/${jobId}/photos/${photoId}/thumbnail`);
    if (!res.ok) throw new Error(await parseFetchError(res));
    return res.blob();
  },
  fetchJobDocumentThumbBlob: async (jobId, documentId) => {
    const res = await authFetch(`/jobs/${jobId}/documents/${documentId}/thumbnail`);
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

  const meta = el("dl", { class: "card__meta" });
  function addMeta(label, value) {
    if (!value) return;
    meta.appendChild(el("dt", {}, label));
    meta.appendChild(el("dd", { title: value }, value));
  }
  addMeta("Permit #", job.permit_number || "");
  addMeta("Field Mgr", job.field_manager || "");
  addMeta("P or PS", job.pool_type || "");
  addMeta("Permit", job.permit_status || "");

  const latestText = progress.latest_label
    ? `Last: ${progress.latest_label}${progress.latest_completed_at ? " - " + fmtDate(progress.latest_completed_at) : ""}`
    : "No tasks completed yet";

  const badges = [
    el("span", { class: "card__status-badge" }, statusLabel(overall_status)),
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

  const notesPreview = truncateJobNotesPreview(job.notes);
  const notesPreviewEl =
    notesPreview &&
    el(
      "p",
      {
        class: "card__notes-preview",
        ...(notesPreview.truncated ? { title: notesPreview.full } : {}),
      },
      notesPreview.text
    );

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
      notesPreviewEl,
      el("div", { class: "card__progress" }, [
        el("div", { class: "card__progress-row" }, [
          el("span", {}, latestText),
          el("strong", {}, `${progress.completed}/${progress.total}`),
        ]),
        el("div", { class: "progressbar" }, [
          el("div", { class: "progressbar__fill", style: `width:${pct}%` }),
        ]),
      ]),
      meta,
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

// ---- Job documents (PDFs) -----------------------------------------------

function renderJobDocs(job) {
  const docs = Array.isArray(job.documents) ? job.documents : [];
  const canAttach = canAttachJobDocs();
  const fieldDocs = docs.filter((doc) => (doc.category || "field") !== "permit");
  const permitDocs = docs.filter((doc) => (doc.category || "field") === "permit");

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
      });
      getDocThumbUrl(job.id, doc)
        .then((url) => {
          thumbImg.src = url;
        })
        .catch(() => {});

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
      ]
    );
    fileInput.addEventListener("change", async () => {
      const files = fileInput.files;
      if (!files?.length) return;
      try {
        const updated = await apiClient.uploadJobDocument(
          job.id,
          files,
          titleInput.value,
          categoryInput.value
        );
        replaceJob(updated);
        const count = files.length;
        fileInput.value = "";
        titleInput.value = "";
        categoryInput.value = "field";
        toast(count === 1 ? "PDF added" : `${count} PDFs added`, "success");
      } catch (err) {
        toast(`Upload failed: ${err.message}`, "error");
        fileInput.value = "";
      }
    });
    children.push(
      el("div", { class: "job-docs__upload", onclick: (e) => e.stopPropagation() }, [
        categoryInput,
        titleInput,
        fileInput,
        el("span", { class: "job-docs__upload-hint" }, "PDF only — choose a file to upload."),
      ])
    );
  }

  return el("section", { class: "job-docs", "aria-label": "Job documents" }, children);
}

function renderJobPhotos(job) {
  const photos = Array.isArray(job.photos) ? job.photos : [];
  const total = photos.length;
  const visible = photos.slice(0, VISIBLE_PHOTO_COUNT);
  const hiddenCount = Math.max(0, total - visible.length);

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
    const grid = el("div", { class: "job-photos__grid" });
    visible.forEach((photo, idx) => {
      const img = el("img", {
        alt: photo.original_filename || `Photo ${idx + 1}`,
        loading: "lazy",
        decoding: "async",
      });
      getPhotoThumbUrl(job.id, photo)
        .then((url) => {
          img.src = url;
        })
        .catch(() => {
          // Leave the thumb empty if loading fails; the modal surfaces the error.
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
    });
    bodyChildren.push(grid);
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

function renderBack(job) {
  const list = el("ul", { class: "tasklist" });

  for (const task of job.tasks) {
    list.appendChild(renderTaskRow(job, task));
  }

  const notesEditable = canEditJobNotes();
  const notes = el("div", { class: "notes" }, [
    el("label", { for: `notes-${job.id}` }, "Job Notes"),
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
          toast("Notes saved", "success");
        } catch (err) {
          toast(`Failed to save notes: ${err.message}`, "error");
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

  return el("div", { class: "face face--back" }, [
    el("header", { class: "back__header" }, [
      el("div", { class: "back__header-main" }, [
        el("h3", { class: "back__title", title: job.customer_name }, job.customer_name),
        el("div", { class: "back__jobinfo" }, [
          el("p", { class: "back__jobinfo-row" }, [
            el("span", { class: "back__jobinfo-label" }, "Job Address"),
            el(
              "span",
              { class: "back__jobinfo-value", title: job.address || "" },
              job.address || "No address"
            ),
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
      renderJobPhotos(job),
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

function renderTaskRow(job, task) {
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
      await refreshNotificationBadgeCount();
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
      await refreshNotificationBadgeCount();
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
        await refreshNotificationBadgeCount();
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
          await refreshNotificationBadgeCount();
        } catch (err) {
          toast(`Failed to update task: ${err.message}`, "error");
        }
      },
    },
    isIssue ? "! Issue" : "Flag"
  );

  return el(
    "li",
    { class: "task", dataset: { status: task.status, taskKey: task.task_key } },
    [
      checkbox,
      el("div", { class: "task__main" }, [
        el("div", { class: "task__label" }, [el("span", {}, task.task_label), issueBtn]),
        el("div", { class: "task__inputs" }, [dateWrap, noteInput]),
      ]),
    ]
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
      dataset: { status: job.overall_status, id: String(job.id) },
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

function getFlippedCards() {
  return $$(".card.is-flipped");
}

function hasOpenMobileCardOverlay() {
  return isMobileCardOverlayViewport() && getFlippedCards().length > 0;
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
  setCardOverlayPageState();
}

function closeMobileCardOverlay() {
  for (const card of getFlippedCards()) {
    card.classList.remove("is-flipped", "card--mobile-overlay", "card--desktop-overlay");
  }
  setCardOverlayPageState();
  syncMobileCardHistoryAfterOverlayClosed();
}

function closeDesktopCardOverlay() {
  for (const card of getFlippedCards()) {
    card.classList.remove("is-flipped", "card--desktop-overlay", "card--mobile-overlay");
  }
  setCardOverlayPageState();
}

function closeActiveCardOverlay() {
  if (isMobileCardOverlayViewport()) {
    closeMobileCardOverlay();
    return;
  }
  closeDesktopCardOverlay();
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

  if (nextFlipped) {
    closeOtherFlippedCards(jobId);
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
  const header = el("div", { class: "overview__header" }, [
    el("h2", { class: "overview__title" }, "Overview"),
    backBtn,
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
      const photoCount = Array.isArray(updatedJob.photos) ? updatedJob.photos.length : 0;
      if (photoCount <= 0) {
        photosModalState.selectedIndex = 0;
        photosModalState.pageIndex = 0;
      } else {
        if (photosModalState.selectedIndex > photoCount - 1) {
          photosModalState.selectedIndex = photoCount - 1;
        }
        const totalPages = Math.max(1, Math.ceil(photoCount / PHOTOS_MODAL_PAGE_SIZE));
        if (photosModalState.pageIndex > totalPages - 1) {
          photosModalState.pageIndex = totalPages - 1;
        }
      }
      renderPhotosModalContent(updatedJob);
    }
    applyFilter();
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
  }

  const newCard = renderCard(updatedJob);
  if (wasFlipped) newCard.classList.add("is-flipped");
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
        nextBack.scrollTop = backScrollTop;
        if (focusSnap) restoreEditableFocusAfterCardSwap(newCard, updatedJob.id, focusSnap);
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
    const photoCount = Array.isArray(updatedJob.photos) ? updatedJob.photos.length : 0;
    if (photoCount <= 0) {
      photosModalState.selectedIndex = 0;
      photosModalState.pageIndex = 0;
    } else {
      if (photosModalState.selectedIndex > photoCount - 1) {
        photosModalState.selectedIndex = photoCount - 1;
      }
      const totalPages = Math.max(1, Math.ceil(photoCount / PHOTOS_MODAL_PAGE_SIZE));
      if (photosModalState.pageIndex > totalPages - 1) {
        photosModalState.pageIndex = totalPages - 1;
      }
    }
    renderPhotosModalContent(updatedJob);
  }

  applyFilter();
  reorderCardsByCompletion();
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

function renderAll() {
  const grid = $("#grid");
  if (grid) grid.classList.toggle("card-grid--overview", state.view === "overview");
  $$(".overview", grid).forEach((n) => n.remove());
  $$(".card", grid).forEach((c) => c.remove());

  updateEmptyStateMessage();

  if (!state.jobs.length) {
    $("#empty-state").hidden = false;
    applyFilter();
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
  applyFilter();
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  if (state.view === "overview") {
    for (const row of $$(".overview-row")) {
      if (!q) {
        row.style.display = "";
        continue;
      }
      const id = Number(row.dataset.id);
      const job = state.jobsById.get(id);
      if (!job) continue;
      row.style.display = jobSearchHay(job).includes(q) ? "" : "none";
    }
    return;
  }
  for (const card of $$(".card")) {
    if (!q) {
      card.style.display = "";
      continue;
    }
    const id = Number(card.dataset.id);
    const job = state.jobsById.get(id);
    if (!job) continue;
    card.style.display = jobSearchHay(job).includes(q) ? "" : "none";
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

  const fieldDocs = docs.filter((doc) => (doc.category || "field") !== "permit");
  const permitDocs = docs.filter((doc) => (doc.category || "field") === "permit");

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
  closeContactsModal();
  docsModalState.jobId = job.id;
  renderDocsModalContent(job);
  const modal = $("#docs-modal");
  if (modal) modal.hidden = false;
}

function updatePhotoGallerySelectionLabel(selectedIndex, total, pageIndex, totalPages) {
  const label = $("#photos-modal-selection");
  if (!label) return;
  if (!total) {
    label.textContent = "";
    return;
  }
  label.textContent = `Selected ${selectedIndex + 1}/${total} - Page ${pageIndex + 1}/${totalPages}`;
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
}

function isPhotoViewerOpen() {
  const o = $("#photo-viewer-overlay");
  return o && !o.hidden;
}

function initPhotoViewerGesturesOnce() {
  const stage = $("#photo-viewer-stage");
  if (!stage || stage.dataset.gesturesWired === "1") return;
  stage.dataset.gesturesWired = "1";

  const MIN_SCALE = 1;
  const MAX_SCALE = 5;

  stage.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        photoViewerGesture.panning = false;
        photoViewerGesture.pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
        photoViewerGesture.pinchStartScale = photoViewerGesture.scale;
      } else if (e.touches.length === 1) {
        photoViewerGesture.panning = true;
        photoViewerGesture.lastClientX = e.touches[0].clientX;
        photoViewerGesture.lastClientY = e.touches[0].clientY;
      }
    },
    { passive: true }
  );

  stage.addEventListener(
    "touchmove",
    (e) => {
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

  stage.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) {
      photoViewerGesture.pinchStartDist = 0;
    }
    if (e.touches.length === 0) {
      photoViewerGesture.panning = false;
    }
  });

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
    const loading = $("#photo-viewer-loading");
    if (loading && !loading.hidden) return;
    if (e.target.closest(".photo-viewer__transform")) return;
    closePhotoViewer();
  });
}

async function openPhotoViewer(job, index) {
  const photos = Array.isArray(job?.photos) ? job.photos : [];
  const photo = photos[index];
  if (!photo) return;

  closePhotoViewer();

  const overlay = $("#photo-viewer-overlay");
  const img = $("#photo-viewer-img");
  const loading = $("#photo-viewer-loading");
  if (!overlay || !img) return;

  const reqId = photoViewerState.loadSeq;

  overlay.hidden = false;
  document.body.classList.add("photo-viewer-open");
  if (loading) loading.hidden = false;

  resetPhotoViewerTransform();

  try {
    const blob = await apiClient.fetchJobPhotoBlob(job.id, photo.id);
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
    if (!job || !Array.isArray(job.photos) || !job.photos.length) return;
    const idx = Math.max(0, Math.min(job.photos.length - 1, photosModalState.selectedIndex));
    const p = job.photos[idx];
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
  const photos = Array.isArray(job?.photos) ? job.photos : [];
  const main = $("#photos-modal-main");
  const downloadBtn = $("#photos-modal-download-btn");
  const prevBtn = $("#photos-modal-prev-btn");
  const nextBtn = $("#photos-modal-next-btn");
  const removeBtn = $("#photos-modal-remove-btn");
  if (!main || !downloadBtn || !prevBtn || !nextBtn) return;

  const canAttach = canAttachJobPhotos();
  if (removeBtn) removeBtn.hidden = !canAttach;

  if (!photos.length) {
    photosModalState.selectedIndex = 0;
    photosModalState.pageIndex = 0;
    updatePhotoGallerySelectionLabel(0, 0, 0, 1);
    main.innerHTML = "";
    main.appendChild(el("p", { class: "photos-modal__empty" }, "No photos found for this job."));
    downloadBtn.disabled = true;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    if (removeBtn) removeBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(photos.length / PHOTOS_MODAL_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(photosModalState.pageIndex, 0), totalPages - 1);
  photosModalState.pageIndex = pageIndex;
  const selectedIndex = Math.min(Math.max(photosModalState.selectedIndex, 0), photos.length - 1);
  photosModalState.selectedIndex = selectedIndex;
  updatePhotoGallerySelectionLabel(selectedIndex, photos.length, pageIndex, totalPages);

  downloadBtn.disabled = false;
  prevBtn.disabled = pageIndex <= 0;
  nextBtn.disabled = pageIndex >= totalPages - 1;
  if (removeBtn) removeBtn.disabled = false;

  const start = pageIndex * PHOTOS_MODAL_PAGE_SIZE;
  const end = Math.min(start + PHOTOS_MODAL_PAGE_SIZE, photos.length);

  main.innerHTML = "";
  for (let i = start; i < end; i++) {
    const photo = photos[i];
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
          openPhotoViewer(job, i);
        },
      },
      img
    );
    main.appendChild(tile);
  }

  wirePhotosModalDownloadButton();
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
    const result = await uploadJobPhotosSequential(photosModalState.jobId, files);
    toastJobPhotosUploadResult(result);
    if (result.lastUpdated) {
      photosModalState.selectedIndex = Math.max(0, (result.lastUpdated.photos?.length || 1) - 1);
      photosModalState.pageIndex = Math.floor(photosModalState.selectedIndex / PHOTOS_MODAL_PAGE_SIZE);
      renderPhotosModalContent(result.lastUpdated);
    }
    fileInput.value = "";
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

function shiftPhotosModalPage(delta) {
  const job = getJobById(photosModalState.jobId);
  if (!job || !Array.isArray(job.photos) || !job.photos.length) return;
  const totalPages = Math.max(1, Math.ceil(job.photos.length / PHOTOS_MODAL_PAGE_SIZE));
  const next = Math.max(0, Math.min(totalPages - 1, photosModalState.pageIndex + delta));
  if (next === photosModalState.pageIndex) return;
  photosModalState.pageIndex = next;
  renderPhotosModalContent(job);
}

async function removeSelectedModalPhoto() {
  if (!canAttachJobPhotos()) return;
  const job = getJobById(photosModalState.jobId);
  if (!job || !Array.isArray(job.photos) || !job.photos.length) return;
  const selectedIndex = Math.max(0, Math.min(job.photos.length - 1, photosModalState.selectedIndex));
  const photo = job.photos[selectedIndex];
  if (!photo) return;
  if (!confirm(`Remove "${photo.original_filename || "photo"}"?`)) return;
  try {
    const updated = await apiClient.deleteJobPhoto(job.id, photo.id);
    photoThumbUrlCache.delete(photo.id);
    const nextCount = Array.isArray(updated.photos) ? updated.photos.length : 0;
    photosModalState.selectedIndex = nextCount > 0
      ? Math.max(0, Math.min(selectedIndex, nextCount - 1))
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
  photosModalState.pageIndex = 0;
  closePhotoViewer();
  const main = $("#photos-modal-main");
  if (main) main.innerHTML = "";
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
  photosModalState.jobId = job.id;
  const photoCount = Array.isArray(job.photos) ? job.photos.length : 0;
  const requested = Number.isFinite(initialIndex) ? Math.floor(initialIndex) : 0;
  photosModalState.selectedIndex = photoCount > 0
    ? Math.max(0, Math.min(requested, photoCount - 1))
    : 0;
  photosModalState.pageIndex = photoCount > 0
    ? Math.floor(photosModalState.selectedIndex / PHOTOS_MODAL_PAGE_SIZE)
    : 0;
  renderPhotosModalContent(job);
  const modal = $("#photos-modal");
  if (modal) modal.hidden = false;
}

function openModal() {
  const modal = $("#modal");
  if (!modal) return;
  modal.hidden = false;
  const first = $("#new-job-form input[name='customer_name']");
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  const modal = $("#modal");
  if (!modal) return;
  modal.hidden = true;
  $("#new-job-form")?.reset();
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
  closeContactsModal();
  idInput.value = String(job.id);
  form.elements.namedItem("customer_name").value = job.customer_name || "";
  form.elements.namedItem("address").value = job.address || "";
  form.elements.namedItem("pool_type").value = job.pool_type || "";
  form.elements.namedItem("permit_status").value = job.permit_status || "";
  form.elements.namedItem("permit_number").value = job.permit_number || "";
  form.elements.namedItem("field_manager").value = job.field_manager || "";
  form.elements.namedItem("notes").value = job.notes || "";
  await refreshContactsCatalog();
  editJobContactIdsOrder = getJobContactIdsFromJob(job);
  renderEditJobContactsPicker();
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
  const feedbackModal = $("#feedback-modal");
  const feedbackReviewModal = $("#feedback-review-modal");
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
  if (contactsDirectoryModal) {
    contactsDirectoryModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closeContactsDirectoryModal();
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
  if (photosModal) {
    photosModal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") closePhotosModal();
    });
    $("#photos-modal-prev-btn")?.addEventListener("click", () => shiftPhotosModalPage(-1));
    $("#photos-modal-next-btn")?.addEventListener("click", () => shiftPhotosModalPage(1));
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
    initPhotoViewerGesturesOnce();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPhotoViewerOpen()) {
      closePhotoViewer();
      e.preventDefault();
      return;
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
        shiftPhotosModalPage(-1);
        return;
      }
      if (!isInputContext && e.key === "ArrowRight") {
        e.preventDefault();
        shiftPhotosModalPage(1);
        return;
      }
    }
    if (e.key !== "Escape") return;
    if (photosModal && !photosModal.hidden) {
      closePhotosModal();
      return;
    }
    if (contactsModal && !contactsModal.hidden) {
      closeContactsModal();
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
        closeModal();
        toast(`Created job: ${job.customer_name}`, "success");
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

function openNotificationsModal() {
  const modal = $("#notifications-modal");
  if (!modal) return;
  closeModal();
  closeEditJobModal();
  closeUsersModal();
  closeContactsDirectoryModal();
  closeFeedbackModal();
  closeFeedbackReviewModal();
  closeDocsModal();
  closePhotosModal();
  closeContactsModal();
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
  modal.hidden = false;
  refreshUsersModal();
}

function closeUsersModal() {
  const modal = $("#users-modal");
  if (modal) modal.hidden = true;
}

async function refreshUsersModal() {
  const body = $("#users-modal-body");
  if (!body) return;
  body.textContent = "Loading…";
  try {
    const users = await apiClient.listUsers();
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
  for (const btn of $$('[data-menu-action="view-archived"]')) btn.hidden = !canArchive();
  renderUserMenuBadge();
  setArchivedMenuLabel();
}

// ---- Boot ----------------------------------------------------------------

async function loadJobs() {
  try {
    const jobs = await apiClient.listJobs();
    state.jobs = jobs;
    state.jobsById = new Map(jobs.map((j) => [j.id, j]));
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
    "new-job": async () => {
      openModal();
    },
    "view-archived": async () => {
      if (!canArchive()) return;
      state.includeArchived = !state.includeArchived;
      setArchivedMenuLabel();
      await loadJobs();
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
    setCardOverlayPageState();
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
    state.user = await apiClient.me();
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
        localStorage.setItem(TOKEN_KEY, data.access_token);
        state.token = data.access_token;
        state.user = await apiClient.me();
        showAppShell();
        syncUserMenu();
        applyRoleVisibility();
        wireModal();
        wireSearch();
        wireShell();
        await loadJobs();
        await refreshContactsCatalog();
        await refreshNotificationBadgeCount();
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
    wireShell();
    await loadJobs();
    await refreshContactsCatalog();
    await refreshNotificationBadgeCount();
  }
});
