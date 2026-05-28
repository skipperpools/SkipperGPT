/**
 * Full-screen graph-paper sketch editor for job sketches.
 * Loaded before app.js; configured via SketchEditor.open() callbacks from app.js.
 */
(function () {
  const PPI = 48;
  const SNAP_SUB_IN = 0.25;
  const VALID_GRID = [1, 3, 6, 12];
  const ERASER_RADIUS = 14;
  const MAX_UNDO = 80;
  const PRESET_COLORS = ["#111111", "#c41e3a", "#1e5aa8", "#2d7d46", "#e67e22", "#7b2cbf"];
  const PEN_WIDTHS = [1, 2, 4, 8];

  /** @type {object|null} */
  let ctx = null;
  let dirty = false;
  let undoStack = [];
  let redoStack = [];
  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  let viewportScale = 1;
  let panX = 0;
  let panY = 0;
  /** @type {Image|null} */
  let bgImage = null;
  let bgBlobForSave = null;
  let linePreviewEnd = null;
  let activePointerId = null;
  let currentStroke = null;
  let bgDrag = null;
  let pinchState = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  function defaultDocument(gridSpacing) {
    const spacing = VALID_GRID.includes(gridSpacing) ? gridSpacing : 3;
    return {
      version: 1,
      pixelsPerInch: PPI,
      canvas: { width: 2400, height: 1800 },
      gridSpacingInches: spacing,
      snapEnabled: true,
      snapSubdivisionInches: SNAP_SUB_IN,
      background: {
        source: "none",
        jobPhotoId: null,
        storedBgPath: null,
        transform: { x: 0, y: 0, scale: 1, opacity: 0.65 },
      },
      strokes: [],
    };
  }

  function snapValue(v, enabled) {
    if (!enabled) return v;
    const step = PPI * SNAP_SUB_IN;
    return Math.round(v / step) * step;
  }

  function snapPoint(x, y, enabled) {
    return [snapValue(x, enabled), snapValue(y, enabled)];
  }

  function pushUndo() {
    if (!ctx?.document) return;
    undoStack.push(JSON.stringify(ctx.document.strokes));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
  }

  function setDirty() {
    dirty = true;
    const badge = $("#sketch-editor-unsaved");
    if (badge) badge.hidden = false;
  }

  function clearDirty() {
    dirty = false;
    const badge = $("#sketch-editor-unsaved");
    if (badge) badge.hidden = true;
  }

  function clientToCanvas(clientX, clientY) {
    const vp = $("#sketch-editor-viewport");
    if (!vp) return { x: 0, y: 0 };
    const rect = vp.getBoundingClientRect();
    return {
      x: (clientX - rect.left - panX) / viewportScale,
      y: (clientY - rect.top - panY) / viewportScale,
    };
  }

  function applyStageTransform() {
    const stage = $("#sketch-editor-stage");
    if (stage) stage.style.transform = `translate(${panX}px, ${panY}px) scale(${viewportScale})`;
  }

  function hitStroke(strokes, x, y) {
    for (let i = strokes.length - 1; i >= 0; i -= 1) {
      const s = strokes[i];
      const pts = s.points || [];
      for (const pt of pts) {
        const dx = pt[0] - x;
        const dy = pt[1] - y;
        if (Math.hypot(dx, dy) <= ERASER_RADIUS + (s.width || 2)) return i;
      }
    }
    return -1;
  }

  function drawGrid(c) {
    const doc = ctx.document;
    const w = doc.canvas.width;
    const h = doc.canvas.height;
    const major = doc.gridSpacingInches * PPI;
    const minor = PPI * SNAP_SUB_IN;

    c.fillStyle = "#fafaf8";
    c.fillRect(0, 0, w, h);

    c.strokeStyle = "#e8e4dc";
    c.lineWidth = 1;
    for (let x = 0; x <= w; x += minor) {
      c.beginPath();
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, h);
      c.stroke();
    }
    for (let y = 0; y <= h; y += minor) {
      c.beginPath();
      c.moveTo(0, y + 0.5);
      c.lineTo(w, y + 0.5);
      c.stroke();
    }

    c.strokeStyle = "#c5bfb0";
    c.lineWidth = 1.5;
    for (let x = 0; x <= w; x += major) {
      c.beginPath();
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, h);
      c.stroke();
    }
    for (let y = 0; y <= h; y += major) {
      c.beginPath();
      c.moveTo(0, y + 0.5);
      c.lineTo(w, y + 0.5);
      c.stroke();
    }
  }

  function drawBackground(c) {
    const bg = ctx.document.background;
    if (!bgImage || !bg?.transform) return;
    const t = bg.transform;
    c.save();
    c.globalAlpha = typeof t.opacity === "number" ? t.opacity : 0.65;
    const iw = bgImage.naturalWidth * t.scale;
    const ih = bgImage.naturalHeight * t.scale;
    c.drawImage(bgImage, t.x, t.y, iw, ih);
    c.restore();
  }

  function drawStroke(c, stroke) {
    const pts = stroke.points || [];
    if (pts.length < 1) return;
    c.strokeStyle = stroke.color || "#111111";
    c.lineWidth = stroke.width || 2;
    c.lineCap = "round";
    c.lineJoin = "round";
    if (stroke.tool === "eraser") {
      c.globalCompositeOperation = "destination-out";
      c.strokeStyle = "rgba(0,0,0,1)";
      c.lineWidth = (stroke.width || 2) * 4;
    } else {
      c.globalCompositeOperation = "source-over";
    }
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) {
      c.lineTo(pts[i][0], pts[i][1]);
    }
    if (stroke.tool === "line" && pts.length >= 2) {
      c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }
    c.stroke();
    c.globalCompositeOperation = "source-over";
  }

  function render() {
    if (!canvas || !ctx?.document) return;
    const c = canvas.getContext("2d");
    const doc = ctx.document;
    canvas.width = doc.canvas.width;
    canvas.height = doc.canvas.height;

    drawGrid(c);
    drawBackground(c);
    for (const stroke of doc.strokes) drawStroke(c, stroke);

    if (currentStroke) drawStroke(c, currentStroke);
    else if (ctx?.tool === "line" && linePreviewEnd?.start && linePreviewEnd?.end) {
      drawStroke(c, {
        tool: "line",
        ...currentStrokeStyle(),
        points: [linePreviewEnd.start, linePreviewEnd.end],
      });
    }
  }

  function fitBackgroundToGrid() {
    if (!bgImage || !ctx?.document) return;
    const doc = ctx.document;
    const t = doc.background.transform;
    const cw = doc.canvas.width;
    const ch = doc.canvas.height;
    const major = doc.gridSpacingInches * PPI;
    const margin = major;
    const availW = cw - margin * 2;
    const availH = ch - margin * 2;
    let scale = Math.min(availW / bgImage.naturalWidth, availH / bgImage.naturalHeight);
    const cellsW = Math.max(1, Math.round((bgImage.naturalWidth * scale) / major));
    const cellsH = Math.max(1, Math.round((bgImage.naturalHeight * scale) / major));
    scale = Math.min((cellsW * major) / bgImage.naturalWidth, (cellsH * major) / bgImage.naturalHeight);
    t.scale = scale;
    t.x = margin + (availW - bgImage.naturalWidth * scale) / 2;
    t.y = margin + (availH - bgImage.naturalHeight * scale) / 2;
    setDirty();
    render();
  }

  async function loadBackgroundFromBlob(blob, source, jobPhotoId) {
    bgBlobForSave = blob;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = url;
    });
    if (bgImage?._objectUrl) URL.revokeObjectURL(bgImage._objectUrl);
    img._objectUrl = url;
    bgImage = img;
    const doc = ctx.document;
    doc.background.source = source;
    doc.background.jobPhotoId = jobPhotoId ?? null;
    fitBackgroundToGrid();
  }

  async function tryLoadServerBackground() {
    const bg = ctx.document.background;
    if (bg?.source === "none" || !ctx.fetchBackgroundBlob) return;
    if (bg.source === "job_photo" && bg.jobPhotoId && ctx.fetchPhotoBlob) {
      try {
        const blob = await ctx.fetchPhotoBlob(bg.jobPhotoId);
        await loadBackgroundFromBlob(blob, "job_photo", bg.jobPhotoId);
        bgBlobForSave = null;
        return;
      } catch {
        /* fall through */
      }
    }
    if (ctx.fetchBackgroundBlob) {
      try {
        const blob = await ctx.fetchBackgroundBlob();
        if (blob) await loadBackgroundFromBlob(blob, bg.source || "device", bg.jobPhotoId);
        bgBlobForSave = null;
      } catch {
        /* no background */
      }
    }
  }

  function syncBgAdjustUi() {
    const active = !!(ctx?.bgAdjust && bgImage);
    $("#sketch-editor-bg-adjust-btn")?.classList.toggle("is-active", active);
    const vp = $("#sketch-editor-viewport");
    if (vp) vp.classList.toggle("sketch-editor__viewport--bg-adjust", active);
  }

  function setBgAdjust(enabled) {
    if (!ctx) return;
    ctx.bgAdjust = !!(enabled && bgImage);
    syncBgAdjustUi();
  }

  function currentStrokeStyle() {
    return { color: ctx?.penColor || "#111111", width: ctx?.penWidth || 2 };
  }

  function normalizeHexColor(hex) {
    if (!hex || typeof hex !== "string") return "#111111";
    const h = hex.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(h)) return h;
    if (/^#[0-9a-f]{3}$/.test(h)) {
      return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
    }
    return "#111111";
  }

  function syncPenStyleUi() {
    if (!ctx) return;
    const color = normalizeHexColor(ctx.penColor);
    const width = ctx.penWidth || 2;
    const isPreset = PRESET_COLORS.includes(color);

    $$(".sketch-editor__color-swatch").forEach((btn) => {
      btn.classList.toggle("is-active", isPreset && btn.dataset.color === color);
    });

    const customBtn = $(".sketch-editor__color-custom");
    if (customBtn) {
      customBtn.classList.toggle("is-active", !isPreset);
      customBtn.style.setProperty("--swatch-color", color);
    }

    const picker = $("#sketch-editor-color-picker");
    if (picker) picker.value = color;

    $$(".sketch-editor__size-btn").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.width) === width);
    });

    const styleGroup = $("#sketch-editor-style-group");
    if (styleGroup) {
      const disabled = ctx.tool === "eraser" || ctx.tool === "pan";
      styleGroup.classList.toggle("sketch-editor__style-group--disabled", disabled);
    }
  }

  function setPenColor(color) {
    if (!ctx) return;
    ctx.penColor = normalizeHexColor(color);
    syncPenStyleUi();
  }

  function setPenWidth(width) {
    if (!ctx) return;
    const w = Number(width);
    if (!PEN_WIDTHS.includes(w)) return;
    ctx.penWidth = w;
    syncPenStyleUi();
  }

  function setTool(tool) {
    ctx.tool = tool;
    if (tool !== "pan") setBgAdjust(false);
    $$(".sketch-editor__tool").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tool === tool);
    });
    const vp = $("#sketch-editor-viewport");
    if (vp) vp.classList.toggle("sketch-editor__viewport--pan", tool === "pan");
    syncPenStyleUi();
  }

  function $$(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  function updateGridSpacingUi() {
    const spacing = ctx.document.gridSpacingInches;
    $$(".sketch-editor__grid-btn").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.gridInches) === spacing);
    });
    const snapBtn = $("#sketch-editor-snap-btn");
    if (snapBtn) snapBtn.classList.toggle("is-active", !!ctx.document.snapEnabled);
  }

  function onPointerDown(e) {
    if (!ctx || e.button > 0) return;
    const vp = $("#sketch-editor-viewport");
    if (!vp) return;

    if (ctx.tool === "pan" || (e.pointerType === "touch" && e.altKey)) {
      activePointerId = e.pointerId;
      bgDrag = { mode: "pan", startX: e.clientX, startY: e.clientY, panX0: panX, panY0: panY };
      vp.setPointerCapture(e.pointerId);
      return;
    }

    if (ctx.bgAdjust && bgImage) {
      activePointerId = e.pointerId;
      const t = ctx.document.background.transform;
      bgDrag = { mode: "bg", startX: e.clientX, startY: e.clientY, x0: t.x, y0: t.y };
      vp.setPointerCapture(e.pointerId);
      return;
    }

    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const snap = ctx.document.snapEnabled;
    const [sx, sy] = snapPoint(x, y, snap);

    if (ctx.tool === "eraser") {
      pushUndo();
      const idx = hitStroke(ctx.document.strokes, sx, sy);
      if (idx >= 0) {
        ctx.document.strokes.splice(idx, 1);
        setDirty();
        render();
      }
      activePointerId = e.pointerId;
      vp.setPointerCapture(e.pointerId);
      return;
    }

    if (ctx.tool === "line") {
      pushUndo();
      linePreviewEnd = { start: [sx, sy], end: [sx, sy] };
      activePointerId = e.pointerId;
      vp.setPointerCapture(e.pointerId);
      return;
    }

    if (ctx.tool === "pen") {
      pushUndo();
      currentStroke = {
        tool: "pen",
        ...currentStrokeStyle(),
        points: [[sx, sy]],
      };
      activePointerId = e.pointerId;
      vp.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e) {
    if (!ctx) return;
    if (bgDrag?.mode === "pan") {
      panX = bgDrag.panX0 + (e.clientX - bgDrag.startX);
      panY = bgDrag.panY0 + (e.clientY - bgDrag.startY);
      applyStageTransform();
      return;
    }
    if (bgDrag?.mode === "bg" && bgImage) {
      const dx = (e.clientX - bgDrag.startX) / viewportScale;
      const dy = (e.clientY - bgDrag.startY) / viewportScale;
      const t = ctx.document.background.transform;
      t.x = bgDrag.x0 + dx;
      t.y = bgDrag.y0 + dy;
      setDirty();
      render();
      return;
    }

    if (activePointerId !== e.pointerId) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const snap = ctx.document.snapEnabled;
    const [sx, sy] = snapPoint(x, y, snap);

    if (ctx.tool === "eraser") {
      const idx = hitStroke(ctx.document.strokes, sx, sy);
      if (idx >= 0) {
        ctx.document.strokes.splice(idx, 1);
        setDirty();
        render();
      }
      return;
    }

    if (ctx.tool === "line" && linePreviewEnd) {
      linePreviewEnd.end = [sx, sy];
      render();
      return;
    }

    if (currentStroke) {
      const pts = currentStroke.points;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last[0] - sx, last[1] - sy) > 1) {
        pts.push([sx, sy]);
        setDirty();
        render();
      }
    }
  }

  function onPointerUp(e) {
    if (activePointerId !== e.pointerId) return;
    const vp = $("#sketch-editor-viewport");
    if (vp?.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);

    if (ctx?.tool === "line" && linePreviewEnd) {
      const snap = ctx.document.snapEnabled;
      const end = linePreviewEnd.end || linePreviewEnd.start;
      ctx.document.strokes.push({
        tool: "line",
        ...currentStrokeStyle(),
        points: [linePreviewEnd.start, end],
      });
      linePreviewEnd = null;
      setDirty();
      render();
    }

    if (currentStroke) {
      ctx.document.strokes.push(currentStroke);
      currentStroke = null;
      setDirty();
      render();
    }

    activePointerId = null;
    bgDrag = null;
  }

  function exportPreviewBlob() {
    return new Promise((resolve, reject) => {
      if (!canvas) {
        reject(new Error("No canvas"));
        return;
      }
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not export preview"));
      }, "image/png");
    });
  }

  async function save() {
    if (!ctx?.onSave) return;
    const btn = $("#sketch-editor-save-btn");
    if (btn) btn.disabled = true;
    try {
      const preview = await exportPreviewBlob();
      const updatedJob = await ctx.onSave({
        document: ctx.document,
        preview,
        background: bgBlobForSave,
        contentVersion: ctx.sketch.content_version,
      });
      clearDirty();
      if (ctx.onSaved) ctx.onSaved(updatedJob);
    } catch (err) {
      if (ctx.onError) ctx.onError(err);
      else alert(err.message || String(err));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function requestClose() {
    if (dirty && !confirm("Discard unsaved sketch changes?")) return;
    close();
  }

  function close() {
    const overlay = $("#sketch-editor-overlay");
    if (overlay) overlay.hidden = true;
    if (bgImage?._objectUrl) URL.revokeObjectURL(bgImage._objectUrl);
    bgImage = null;
    bgBlobForSave = null;
    ctx = null;
    dirty = false;
    undoStack = [];
    redoStack = [];
    currentStroke = null;
    linePreviewEnd = null;
    document.body.classList.remove("sketch-editor-open");
    const picker = $("#sketch-editor-bg-picker");
    if (picker) picker.hidden = true;
  }

  function showBgPicker(show) {
    const picker = $("#sketch-editor-bg-picker");
    if (picker) picker.hidden = !show;
  }

  async function renderBgPickerPhotos() {
    const grid = $("#sketch-editor-bg-photos");
    if (!grid || !ctx?.jobPhotos) return;
    grid.innerHTML = "";
    const photos = ctx.jobPhotos || [];
    if (!photos.length) {
      grid.appendChild(document.createTextNode("No job photos yet."));
      return;
    }
    for (const photo of photos) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sketch-editor__bg-photo-btn";
      btn.title = photo.original_filename || "";
      const img = document.createElement("img");
      img.alt = "";
      btn.appendChild(img);
      btn.addEventListener("click", async () => {
        try {
          const blob = await ctx.fetchPhotoBlob(photo.id);
          await loadBackgroundFromBlob(blob, "job_photo", photo.id);
          setBgAdjust(false);
          showBgPicker(false);
        } catch (err) {
          alert(err.message || "Could not load photo");
        }
      });
      grid.appendChild(btn);
      if (ctx.loadPhotoThumb) {
        ctx.loadPhotoThumb(photo.id).then((url) => {
          if (url) img.src = url;
        });
      }
    }
  }

  function wireOnce() {
    if (window.__sketchEditorWired) return;
    window.__sketchEditorWired = true;

    $("#sketch-editor-close-btn")?.addEventListener("click", () => requestClose());
    $("#sketch-editor-save-btn")?.addEventListener("click", () => save());
    $("#sketch-editor-undo-btn")?.addEventListener("click", () => {
      if (!undoStack.length || !ctx) return;
      redoStack.push(JSON.stringify(ctx.document.strokes));
      ctx.document.strokes = JSON.parse(undoStack.pop());
      setDirty();
      render();
    });
    $("#sketch-editor-redo-btn")?.addEventListener("click", () => {
      if (!redoStack.length || !ctx) return;
      undoStack.push(JSON.stringify(ctx.document.strokes));
      ctx.document.strokes = JSON.parse(redoStack.pop());
      setDirty();
      render();
    });

    $$(".sketch-editor__tool").forEach((btn) => {
      btn.addEventListener("click", () => setTool(btn.dataset.tool || "pen"));
    });

    $$(".sketch-editor__color-swatch").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!ctx) return;
        setPenColor(btn.dataset.color);
      });
    });

    $("#sketch-editor-color-picker")?.addEventListener("input", (e) => {
      if (!ctx) return;
      setPenColor(e.target.value);
    });

    $$(".sketch-editor__size-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!ctx) return;
        setPenWidth(btn.dataset.width);
      });
    });

    $$(".sketch-editor__grid-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!ctx) return;
        const inches = Number(btn.dataset.gridInches);
        if (!VALID_GRID.includes(inches)) return;
        ctx.document.gridSpacingInches = inches;
        ctx.sketch.grid_spacing_inches = inches;
        updateGridSpacingUi();
        setDirty();
        render();
      });
    });

    $("#sketch-editor-snap-btn")?.addEventListener("click", () => {
      if (!ctx) return;
      ctx.document.snapEnabled = !ctx.document.snapEnabled;
      updateGridSpacingUi();
      setDirty();
    });

    $("#sketch-editor-bg-btn")?.addEventListener("click", () => {
      showBgPicker(true);
      renderBgPickerPhotos();
    });
    $("#sketch-editor-bg-picker-close")?.addEventListener("click", () => showBgPicker(false));
    $("#sketch-editor-fit-btn")?.addEventListener("click", () => fitBackgroundToGrid());
    $("#sketch-editor-bg-adjust-btn")?.addEventListener("click", () => {
      if (!ctx) return;
      if (!bgImage) {
        alert("Add a background photo first.");
        return;
      }
      setBgAdjust(!ctx.bgAdjust);
    });

    $("#sketch-editor-bg-upload")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !ctx) return;
      await loadBackgroundFromBlob(file, "device", null);
      setBgAdjust(false);
      showBgPicker(false);
    });

    const vp = $("#sketch-editor-viewport");
    vp?.addEventListener("pointerdown", onPointerDown);
    vp?.addEventListener("pointermove", onPointerMove);
    vp?.addEventListener("pointerup", onPointerUp);
    vp?.addEventListener("pointercancel", onPointerUp);

    vp?.addEventListener(
      "wheel",
      (e) => {
        if (!ctx) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        viewportScale = Math.min(3, Math.max(0.25, viewportScale * delta));
        applyStageTransform();
      },
      { passive: false }
    );
  }

  async function open(options) {
    wireOnce();
    const overlay = $("#sketch-editor-overlay");
    if (!overlay) return;

    ctx = {
      jobId: options.jobId,
      sketch: options.sketch,
      document: options.document ? JSON.parse(JSON.stringify(options.document)) : defaultDocument(options.sketch?.grid_spacing_inches),
      tool: "pen",
      penColor: "#111111",
      penWidth: 2,
      bgAdjust: false,
      jobPhotos: options.jobPhotos || [],
      onSave: options.onSave,
      onSaved: options.onSaved,
      onError: options.onError,
      fetchPhotoBlob: options.fetchPhotoBlob,
      fetchBackgroundBlob: options.fetchBackgroundBlob,
      loadPhotoThumb: options.loadPhotoThumb,
    };

    dirty = false;
    undoStack = [];
    redoStack = [];
    viewportScale = 0.5;
    panX = 24;
    panY = 24;
    bgImage = null;
    bgBlobForSave = null;
    linePreviewEnd = null;

    const titleEl = $("#sketch-editor-title");
    if (titleEl) titleEl.textContent = options.sketch?.title || "Sketch";

    canvas = $("#sketch-editor-canvas");
    applyStageTransform();
    setTool("pen");
    setBgAdjust(false);
    syncPenStyleUi();
    $$(".sketch-editor__grid-btn").forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        Number(btn.dataset.gridInches) === ctx.document.gridSpacingInches
      );
    });
    updateGridSpacingUi();
    clearDirty();

    await tryLoadServerBackground();
    render();

    overlay.hidden = false;
    document.body.classList.add("sketch-editor-open");
    showBgPicker(false);
  }

  window.SketchEditor = {
    open,
    close: requestClose,
    forceClose: close,
    isOpen: () => !$("#sketch-editor-overlay")?.hidden,
    isDirty: () => dirty,
  };

  // Ensure startup shows dashboard, not editor (display:flex in CSS overrides [hidden] without a rule).
  const overlayOnLoad = $("#sketch-editor-overlay");
  if (overlayOnLoad) overlayOnLoad.hidden = true;
  document.body.classList.remove("sketch-editor-open");
})();
