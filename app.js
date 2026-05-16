// ── STORAGE ───────────────────────────────────
const STORAGE_KEY = "takuma_jobs";

function saveJobs() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
}

function loadJobs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

// ── SITE FILES (現場単位のファイル参照 — localStorage) ───
const SITE_FILES_KEY = "takuma_sitefiles";
let siteFiles = (() => {
  try { return JSON.parse(localStorage.getItem(SITE_FILES_KEY)) || {}; } catch (_) { return {}; }
})();
function saveSiteFiles() { localStorage.setItem(SITE_FILES_KEY, JSON.stringify(siteFiles)); }
function getSiteKey(client, site) { return `${(client || "").trim()}||${(site || "").trim()}`; }
function getSiteFileRefs(job) {
  const key = getSiteKey(job.client, job.site);
  if (siteFiles[key]) return siteFiles[key];
  // 旧データ互換: job に直接 photoIds が保存されていた場合
  return { photoIds: job.photoIds || [], drawingId: job.drawingId || null, instructionId: job.instructionId || null };
}

// ── FILE STORE (IndexedDB — バイナリ添付専用) ───
const FileStore = (() => {
  const DB_NAME = "takuma_files", DB_VER = 1, ST = "files";
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = (e) => e.target.result.createObjectStore(ST, { keyPath: "id" });
      r.onsuccess  = (e) => res(e.target.result);
      r.onerror    = (e) => rej(e.target.error);
    });
  }
  async function save(file) {
    const id = `f${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    let data;
    try {
      data = await file.arrayBuffer();
    } catch (_) {
      throw new Error("ファイルを読み込めませんでした。\niPhone/iPadでiCloud・LINE経由のファイルは、端末に一度保存してから再選択してください。");
    }
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(ST, "readwrite");
      tx.objectStore(ST).put({ id, name: file.name, type: file.type, data });
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
    const blobUrl = file.type.startsWith("image/")
      ? URL.createObjectURL(new Blob([data], { type: file.type }))
      : null;
    return { id, blobUrl };
  }
  async function get(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const r = db.transaction(ST).objectStore(ST).get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => rej(r.error);
    });
  }
  async function remove(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(ST, "readwrite");
      tx.objectStore(ST).delete(id);
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }
  function toBlobUrl(entry) {
    return URL.createObjectURL(new Blob([entry.data], { type: entry.type }));
  }
  return { save, get, remove, toBlobUrl };
})();

// ── DEMO DATA (used when localStorage is empty) ──
const DEMO_JOBS = [
  { id: "job-1", date: "2026-05-15", client: "積和建設", process: "架",  site: "○○マンション", place: "名古屋市中区○○町1-1", memo: "", photoIds: [], drawingId: null, instructionId: null },
  { id: "job-2", date: "2026-05-15", client: "大林組",  process: "払",  site: "△△ビル",       place: "一宮市",            memo: "駐車場なし・要確認", photoIds: [], drawingId: null, instructionId: null },
  { id: "job-3", date: "2026-05-16", client: "清水建設", process: "CAP", site: "□□工場",       place: "小牧市",            memo: "", photoIds: [], drawingId: null, instructionId: null },
  { id: "job-4", date: "2026-05-17", client: "西島工業", process: "常用",site: "応援作業",     place: "岐阜市",            memo: "", photoIds: [], drawingId: null, instructionId: null },
];

// ── STATE ─────────────────────────────────────
const currentMonthDate = new Date(2026, 4, 1);
let jobs = loadJobs() || DEMO_JOBS;
let draggedCard  = null;
let dragCopy     = false;
let movedByDrag  = false;
let activeJobId  = null;
let ctxTargetJobId = null;
let scheduleDateKey = "";
let lpTimer    = null;
let lpStartPos = { x: 0, y: 0 };
let dragRowJobId = null;  // 予定表内の行並び替えドラッグ

// ── FORM FILE STATE ────────────────────────────
// 各エントリ: { kind:'saved',    id, name, blobUrl }  ← 選択直後にIDB保存済み
//          | { kind:'existing', id, name, blobUrl }  ← 既存物件から読み込み
let ffPhotos    = [];   // 複数可
let ffDrawing   = null; // 1件のみ
let ffInstr     = null; // 1件のみ
let ffToDelete  = [];   // 削除予定のIDB ID（✕で外した既存ファイル）
let ffNewIds    = [];   // このフォームセッションでIDB保存したID（キャンセル時に削除）

// order フィールドが未設定の既存データへのバックフィル
(function backfillOrder() {
  const byDate = {};
  jobs.forEach((j) => { (byDate[j.date] = byDate[j.date] || []).push(j); });
  Object.values(byDate).forEach((group) => {
    if (group.some((j) => j.order === undefined)) {
      group.forEach((j, i) => { if (j.order === undefined) j.order = i + 1; });
    }
  });
})();

// ── UTILS ─────────────────────────────────────
// 場所から市区町村までを抽出（例：名古屋市中区○○町1-1 → 名古屋市）
function cityOnly(place) {
  if (!place) return "";
  const m = String(place).match(/^.+?[市区郡町村]/);
  return m ? m[0] : place;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad(v) { return String(v).padStart(2, "0"); }
function getDateKey(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function getMonthLength(y, m) { return new Date(y, m + 1, 0).getDate(); }

function getJobColorClass(process) {
  if (/架/.test(process)) return "silver";
  if (/払/.test(process)) return "red";
  if (/CAP/i.test(process)) return "blue";
  if (/常用/.test(process)) return "purple";
  return "silver";
}

// ── ORDER HELPERS ─────────────────────────────
function getDayJobs(dateKey) {
  return jobs
    .filter((j) => j.date === dateKey)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

function getNextOrder(dateKey) {
  const day = getDayJobs(dateKey);
  return day.length === 0 ? 1 : (day[day.length - 1].order ?? day.length) + 1;
}

function moveJobInDay(jobId, direction) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;
  const day = getDayJobs(job.date);
  const idx = day.findIndex((j) => j.id === jobId);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= day.length) return;
  [day[idx], day[swapIdx]] = [day[swapIdx], day[idx]];
  day.forEach((j, i) => { j.order = i + 1; });
  saveJobs();
}

function dropReorderRow(dateKey, srcId, tgtId, insertAfter) {
  const day = getDayJobs(dateKey);
  const srcIdx = day.findIndex((j) => j.id === srcId);
  const [moved] = day.splice(srcIdx, 1);
  const newTgt = day.findIndex((j) => j.id === tgtId);
  day.splice(insertAfter ? newTgt + 1 : newTgt, 0, moved);
  day.forEach((j, i) => { j.order = i + 1; });
  saveJobs();
}

// ── FORM FILE HELPERS ─────────────────────────
function ffReset(job) {
  // キャンセルで積まれた未確定IDBファイルを削除
  ffNewIds.forEach((id) => FileStore.remove(id).catch(() => {}));
  ffNewIds   = [];
  ffPhotos   = [];
  ffDrawing  = null;
  ffInstr    = null;
  ffToDelete = [];
  if (job) {
    const refs = getSiteFileRefs(job);
    (refs.photoIds || []).forEach((id) => ffPhotos.push({ kind: "existing", id, name: "…", blobUrl: null }));
    if (refs.drawingId)    ffDrawing = { kind: "existing", id: refs.drawingId,    name: "…", blobUrl: null };
    if (refs.instructionId) ffInstr  = { kind: "existing", id: refs.instructionId, name: "…", blobUrl: null };
    _loadExistingNames();
  }
  ffRenderAll();
}

async function _loadExistingNames() {
  for (let i = 0; i < ffPhotos.length; i++) {
    if (ffPhotos[i].kind !== "existing") continue;
    const e = await FileStore.get(ffPhotos[i].id);
    if (!e) continue;
    ffPhotos[i].name    = e.name;
    ffPhotos[i].blobUrl = e.type.startsWith("image/") ? FileStore.toBlobUrl(e) : null;
    ffRenderChips("photo");
  }
  if (ffDrawing?.kind === "existing") {
    const e = await FileStore.get(ffDrawing.id);
    if (e) { ffDrawing.name = e.name; ffDrawing.blobUrl = e.type.startsWith("image/") ? FileStore.toBlobUrl(e) : null; ffRenderChips("drawing"); }
  }
  if (ffInstr?.kind === "existing") {
    const e = await FileStore.get(ffInstr.id);
    if (e) { ffInstr.name = e.name; ffInstr.blobUrl = e.type.startsWith("image/") ? FileStore.toBlobUrl(e) : null; ffRenderChips("instr"); }
  }
}

function ffRenderAll() {
  ffRenderChips("photo");
  ffRenderChips("drawing");
  ffRenderChips("instr");
}

function ffRenderChips(type) {
  const el = document.getElementById(
    type === "photo" ? "attachPhotoChips" : type === "drawing" ? "attachDrawingChips" : "attachInstrChips"
  );
  if (!el) return;
  el.innerHTML = "";
  const items = type === "photo" ? ffPhotos : (type === "drawing" ? (ffDrawing ? [ffDrawing] : []) : (ffInstr ? [ffInstr] : []));
  items.forEach((item, idx) => {
    const chip = document.createElement("div");
    chip.className = "file-chip";
    if (item.blobUrl) {
      const img = document.createElement("img");
      img.className = "file-chip-img";
      img.src = item.blobUrl;
      chip.appendChild(img);
    }
    const nameEl = document.createElement("span");
    nameEl.className = "file-chip-name";
    nameEl.textContent = item.name;
    chip.appendChild(nameEl);
    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.className = "file-chip-x";
    xBtn.textContent = "✕";
    xBtn.addEventListener("click", () => {
      const _purge = (removed) => {
        if (removed?.kind === "existing") ffToDelete.push(removed.id);
        if (removed?.kind === "saved") {
          FileStore.remove(removed.id).catch(() => {});
          ffNewIds = ffNewIds.filter((i) => i !== removed.id);
        }
      };
      if (type === "photo") {
        const [removed] = ffPhotos.splice(idx, 1);
        _purge(removed);
        ffRenderChips("photo");
      } else {
        const removed = type === "drawing" ? ffDrawing : ffInstr;
        _purge(removed);
        if (type === "drawing") ffDrawing = null; else ffInstr = null;
        ffRenderChips(type);
      }
    });
    chip.appendChild(xBtn);
    el.appendChild(chip);
  });
  // ドロップヒントの表示/非表示
  const drop = el.closest(".attach-drop");
  if (drop) drop.querySelector(".attach-drop-hint")?.style.setProperty("display", items.length ? "none" : "");
}

function _showAttachError(name, err) {
  const base = err.message.includes("端末に一度保存")
    ? err.message
    : `「${name}」の読み込みに失敗しました。\n\niPhone/iPad でiCloud・LINE経由のファイルは、\n端末に一度保存してから再選択してください。\n\nエラー: ${err.message}`;
  alert(base);
}

async function ffAddPhotos(files) {
  for (const file of Array.from(files)) {
    try {
      const { id, blobUrl } = await FileStore.save(file);
      ffNewIds.push(id);
      ffPhotos.push({ kind: "saved", id, name: file.name, blobUrl });
      ffRenderChips("photo");
    } catch (err) {
      _showAttachError(file.name, err);
    }
  }
}

async function ffSetDoc(type, file) {
  try {
    // 既存エントリの処理
    const old = type === "drawing" ? ffDrawing : ffInstr;
    if (old?.kind === "existing") ffToDelete.push(old.id);
    if (old?.kind === "saved") {
      FileStore.remove(old.id).catch(() => {});
      ffNewIds = ffNewIds.filter((i) => i !== old.id);
    }
    const { id, blobUrl } = await FileStore.save(file);
    ffNewIds.push(id);
    const entry = { kind: "saved", id, name: file.name, blobUrl };
    if (type === "drawing") ffDrawing = entry; else ffInstr = entry;
    ffRenderChips(type);
  } catch (err) {
    _showAttachError(file.name, err);
  }
}

async function ffCommit() {
  // 全エントリはすでにIDB保存済みなのでIDを集めるだけ
  const photoIds      = ffPhotos.map((p) => p.id);
  const drawingId     = ffDrawing ? ffDrawing.id : null;
  const instructionId = ffInstr   ? ffInstr.id   : null;
  ffToDelete.forEach((id) => FileStore.remove(id).catch(() => {}));
  ffNewIds = []; // コミット確定 — キャンセル削除対象から外す
  return { photoIds, drawingId, instructionId };
}

// ── ATTACHMENT DROP ZONES ─────────────────────
function setupDropZone(el, onFiles) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("drag-over"); });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
  });
}

function setupAttachments() {
  const photoBtn   = document.getElementById("attachPhotoBtn");
  const photoInput = document.getElementById("attachPhotoInput");
  const photoDrop  = document.getElementById("attachPhotoDrop");
  photoBtn.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async (e) => {
    if (e.target.files.length) await ffAddPhotos(e.target.files);
    e.target.value = "";  // 読み込み完了後にクリア（iOS参照保護）
  });
  setupDropZone(photoDrop, (files) => ffAddPhotos(files.filter((f) => f.type.startsWith("image/"))));

  const drawingBtn   = document.getElementById("attachDrawingBtn");
  const drawingInput = document.getElementById("attachDrawingInput");
  const drawingDrop  = document.getElementById("attachDrawingDrop");
  drawingBtn.addEventListener("click", () => drawingInput.click());
  drawingInput.addEventListener("change", async (e) => {
    if (e.target.files[0]) await ffSetDoc("drawing", e.target.files[0]);
    e.target.value = "";
  });
  setupDropZone(drawingDrop, (files) => { if (files[0]) ffSetDoc("drawing", files[0]); });

  const instrBtn   = document.getElementById("attachInstrBtn");
  const instrInput = document.getElementById("attachInstrInput");
  const instrDrop  = document.getElementById("attachInstrDrop");
  instrBtn.addEventListener("click", () => instrInput.click());
  instrInput.addEventListener("change", async (e) => {
    if (e.target.files[0]) await ffSetDoc("instr", e.target.files[0]);
    e.target.value = "";
  });
  setupDropZone(instrDrop, (files) => { if (files[0]) ffSetDoc("instr", files[0]); });
}

// ── MODAL FILE SECTION ────────────────────────
async function buildModalFiles(container, job) {
  container.innerHTML = "";

  // MAP: 場所から自動生成（旧 mapUrl にもフォールバック）
  const place = (job.place || "").trim();
  const mapUrl = place
    ? `https://maps.google.com/maps?q=${encodeURIComponent(place)}`
    : (job.mapUrl || "");
  if (mapUrl) {
    const a = document.createElement("a");
    a.className = "mfile-map";
    a.href = mapUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = `<span class="mfile-icon">📍</span><span class="mfile-name">${escHtml(place || "Google Map")}</span><span class="mfile-arrow">Map →</span>`;
    container.appendChild(a);
  }

  // 写真
  const refs     = getSiteFileRefs(job);
  const photoIds = refs.photoIds || [];
  if (photoIds.length > 0) {
    const sec = _mfileSection("📷", "写真");
    const grid = document.createElement("div");
    grid.className = "mfile-thumb-grid";
    for (const id of photoIds) {
      const entry = await FileStore.get(id);
      if (!entry) continue;
      const url = FileStore.toBlobUrl(entry);
      const img = document.createElement("img");
      img.className = "mfile-thumb";
      img.src = url;
      img.alt = entry.name;
      img.title = entry.name;
      img.addEventListener("click", () => openLightbox(url, entry.name));
      grid.appendChild(img);
    }
    sec.appendChild(grid);
    container.appendChild(sec);
  } else if (job.photoUrl) {
    const sec = _mfileSection("📷", "写真");
    const a = document.createElement("a");
    a.href = job.photoUrl; a.target = "_blank"; a.rel = "noopener";
    a.className = "mfile-link"; a.textContent = "写真リンク →";
    sec.appendChild(a);
    container.appendChild(sec);
  }

  // 図面
  await _appendDocSection(container, "📐", "図面", refs.drawingId, job.drawingUrl);

  // 指示書
  await _appendDocSection(container, "📄", "指示書", refs.instructionId, job.instructionUrl);
}

function _mfileSection(icon, label) {
  const sec = document.createElement("div");
  sec.className = "mfile-section";
  const lbl = document.createElement("div");
  lbl.className = "mfile-section-label";
  lbl.innerHTML = `<span class="mfile-icon">${icon}</span>${escHtml(label)}`;
  sec.appendChild(lbl);
  return sec;
}

async function _appendDocSection(container, icon, label, fileId, fallbackUrl) {
  if (!fileId && !fallbackUrl) return;
  const sec = _mfileSection(icon, label);
  if (fileId) {
    const entry = await FileStore.get(fileId);
    if (!entry) return;
    const row = document.createElement("div");
    row.className = "mfile-doc-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "mfile-doc-name";
    nameSpan.textContent = entry.name;
    const openBtn = document.createElement("button");
    openBtn.className = "mfile-open-btn";
    openBtn.textContent = "開く";
    openBtn.addEventListener("click", () => _openEntry(entry));
    row.append(nameSpan, openBtn);
    sec.appendChild(row);
    if (entry.type.startsWith("image/")) {
      const url = FileStore.toBlobUrl(entry);
      const img = document.createElement("img");
      img.className = "mfile-thumb mfile-doc-thumb";
      img.src = url;
      img.alt = entry.name;
      img.addEventListener("click", () => openLightbox(url, entry.name));
      sec.appendChild(img);
    }
  } else if (fallbackUrl) {
    const a = document.createElement("a");
    a.href = fallbackUrl; a.target = "_blank"; a.rel = "noopener";
    a.className = "mfile-link"; a.textContent = `${label}リンク →`;
    sec.appendChild(a);
  }
  container.appendChild(sec);
}

function _openEntry(entry) {
  const url = FileStore.toBlobUrl(entry);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── LIGHTBOX ──────────────────────────────────
function openLightbox(url, name) {
  const lb = document.getElementById("lightbox");
  document.getElementById("lightboxImg").src = url;
  document.getElementById("lightboxCaption").textContent = name || "";
  lb.classList.remove("hidden");
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.classList.add("hidden");
  document.getElementById("lightboxImg").src = "";
}

// ── CALENDAR CELLS ────────────────────────────
function getCalendarCells(date) {
  const y = date.getFullYear(), m = date.getMonth();
  const startWeek = new Date(y, m, 1).getDay();
  const daysInMonth = getMonthLength(y, m);
  const cells = [];
  for (let i = 0; i < startWeek; i++) cells.push({ date: null });
  for (let i = 1; i <= daysInMonth; i++) cells.push({ date: new Date(y, m, i) });
  while (cells.length % 7 !== 0) cells.push({ date: null });
  return cells;
}

// ── CALENDAR RENDER ───────────────────────────
function updateMonthLabel() {
  const el = document.getElementById("currentMonthLabel");
  if (el) el.textContent = `${currentMonthDate.getFullYear()}年${currentMonthDate.getMonth() + 1}月`;
}

function updateDateOptions() {
  const native = document.getElementById("jobDate");
  if (!native) return;
  const y = currentMonthDate.getFullYear(), m = currentMonthDate.getMonth();
  const days = getMonthLength(y, m);
  const cur = Math.min(Number(native.value) || 1, days);
  native.innerHTML = "";
  for (let day = 1; day <= days; day++) {
    const opt = document.createElement("option");
    opt.value = String(day);
    opt.textContent = `${day}日`;
    native.appendChild(opt);
  }
  native.value = String(cur);
  const el = document.getElementById("jobDatePickerValue");
  if (el) el.textContent = `${cur}日`;
}

function renderProcessPanel() {
  const panel = document.getElementById("processPanel");
  if (!panel) return;
  const stats = {};
  jobs.forEach((j) => { stats[j.process] = (stats[j.process] || 0) + 1; });
  const sorted = Object.keys(stats).sort((a, b) => stats[b] - stats[a]);
  panel.innerHTML = sorted.map((p) =>
    `<div class="process-stat"><span>${escHtml(p)}</span><span>${stats[p]}件</span></div>`
  ).join("");
}

function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  if (!grid) return;
  grid.innerHTML = "";
  updateMonthLabel();
  updateDateOptions();
  renderProcessPanel();

  const cells = getCalendarCells(currentMonthDate);
  const today = new Date();
  const todayKey = getDateKey(today.getFullYear(), today.getMonth(), today.getDate());

  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    const weekMaxJobs = Math.max(0, ...week.map((c) => {
      if (!c.date) return 0;
      const k = getDateKey(c.date.getFullYear(), c.date.getMonth(), c.date.getDate());
      return jobs.filter((j) => j.date === k).length;
    }));
    const weekMaxHols = Math.max(0, ...week.map((c) => {
      if (!c.date) return 0;
      const k = getDateKey(c.date.getFullYear(), c.date.getMonth(), c.date.getDate());
      return getHolidaysByDate(k).length;
    }));
    const rowHeight = (weekMaxJobs === 0 && weekMaxHols === 0) ? "86px"
      : `${96 + weekMaxJobs * 68 + weekMaxHols * 26}px`;

    week.forEach((cell, dow) => {
      if (!cell.date) {
        const el = document.createElement("div");
        el.className = ["calendar-cell", "empty-placeholder", `dow-${dow}`,
          dow === 0 ? "sunday" : dow === 6 ? "saturday" : ""].filter(Boolean).join(" ");
        el.style.minHeight = rowHeight;
        grid.appendChild(el);
        return;
      }

      const key = getDateKey(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate());
      const dayJobs = jobs.filter((j) => j.date === key);
      const isToday = key === todayKey;

      const cellEl = document.createElement("div");
      const cls = ["calendar-cell", "day", "dropzone", `dow-${dow}`];
      if (dow === 0) cls.push("sunday");
      if (dow === 6) cls.push("saturday");
      if (isToday) cls.push("today");
      const dayHolsCount = getHolidaysByDate(key).length;
      if (dayJobs.length === 0 && dayHolsCount === 0) cls.push("empty-day");
      cellEl.className = cls.join(" ");
      cellEl.dataset.date = key;
      cellEl.style.minHeight = (dayJobs.length === 0 && dayHolsCount === 0) ? "86px" : rowHeight;

      cellEl.innerHTML = `
        <div class="day-head">
          <strong>${cell.date.getDate()}</strong>
          <span class="day-count">${dayJobs.length > 0 ? dayJobs.length + "件" : ""}</span>
        </div>
        <div class="day-body"></div>
      `;

      const head = cellEl.querySelector(".day-head");
      head.addEventListener("click", (e) => {
        e.stopPropagation();
        openScheduleModal(key);
      });

      const body = cellEl.querySelector(".day-body");
      getDayJobs(key).forEach((j) => body.appendChild(buildJobCard(j)));
      // 休みカード
      getHolidaysByDate(key).forEach((h) => body.appendChild(buildHolidayCard(h)));
      grid.appendChild(cellEl);
    });
  }

  setupDropzones();
  updateDashboardStats();
}

// ── CARD BUILDING ─────────────────────────────
function buildJobCard(data) {
  const card = document.createElement("article");
  card.className = `job ${getJobColorClass(data.process)}`;
  card.draggable = true;
  card.dataset.jobId = data.id;

  const memoLine = data.memo && data.memo.trim()
    ? `<div class="card-memo">⚠ ${escHtml(data.memo)}</div>` : "";

  card.innerHTML = `
    <div class="client">${escHtml(data.client)}</div>
    <div class="site-name">${escHtml(data.site)}</div>
    <div class="proc-place">
      <span class="proc-tag">${escHtml(data.process)}</span>
      <span class="proc-divider">|</span>
      <span class="place">${escHtml(cityOnly(data.place))}</span>
    </div>
    ${memoLine}
  `;

  attachJobEvents(card);
  return card;
}

function buildHolidayCard(h) {
  const card = document.createElement("div");
  card.className = "holiday-card";
  card.dataset.holId = h.id;
  const memo = h.memo ? ` · ${h.memo}` : "";
  card.innerHTML =
    `<span class="hol-card-badge">休</span>` +
    `<span class="hol-card-name">${escHtml(h.memberName)}</span>` +
    `<span class="hol-card-type">${escHtml(h.type)}${escHtml(memo)}</span>`;
  return card;
}

// ── JOB EVENTS ────────────────────────────────
function attachJobEvents(card) {
  // Long press via pointer events
  card.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    lpStartPos = { x: e.clientX, y: e.clientY };
    lpTimer = setTimeout(() => {
      lpTimer = null;
      movedByDrag = true;
      showCtxMenu(card, e.clientX, e.clientY);
    }, 380);
  });

  card.addEventListener("pointermove", (e) => {
    if (!lpTimer) return;
    if (Math.abs(e.clientX - lpStartPos.x) > 8 || Math.abs(e.clientY - lpStartPos.y) > 8) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  });

  card.addEventListener("pointerup", () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  });

  card.addEventListener("pointercancel", () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  });

  // Right-click = context menu (desktop)
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showCtxMenu(card, e.clientX, e.clientY);
  });

  // Drag
  card.addEventListener("dragstart", (e) => {
    draggedCard = card;
    dragCopy = e.shiftKey;
    setTimeout(() => card.classList.add("dragging"), 0);
  });

  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    setTimeout(() => { draggedCard = null; dragCopy = false; movedByDrag = false; }, 120);
    updateDays();
  });

  // タッチドラッグ（iPhone / iPad）
  setupTouchDrag(card);

  // Tap = detail
  card.addEventListener("click", () => {
    if (movedByDrag) return;
    openJobModal(card.dataset.jobId);
  });
}

// ── CONTEXT MENU ──────────────────────────────
function showCtxMenu(card, x, y) {
  ctxTargetJobId = card.dataset.jobId;
  const menu = document.getElementById("ctxMenu");
  menu.classList.remove("hidden");
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 164, mh = 120;
  menu.style.left = `${Math.min(x + 6, vw - mw - 8)}px`;
  menu.style.top  = `${Math.min(y + 6, vh - mh - 8)}px`;
}

function hideCtxMenu() {
  document.getElementById("ctxMenu").classList.add("hidden");
  ctxTargetJobId = null;
}

function ctxCopyJob() {
  if (!ctxTargetJobId) return;
  const src = jobs.find((j) => j.id === ctxTargetJobId);
  hideCtxMenu();
  if (!src) return;
  jobs.push({ ...src, id: `job-${Date.now()}` });
  saveJobs();
  renderCalendar();
}

function ctxEditJob() {
  if (!ctxTargetJobId) return;
  const id = ctxTargetJobId;
  hideCtxMenu();
  openEditForm(id);
}

function ctxDeleteJob() {
  if (!ctxTargetJobId) return;
  const src = jobs.find((j) => j.id === ctxTargetJobId);
  if (!src || !confirm(`「${src.site}」を削除しますか？`)) return;
  hideCtxMenu();
  const siteKey = getSiteKey(src.client, src.site);
  jobs.splice(jobs.findIndex((j) => j.id === src.id), 1);
  // 同じ現場の他カードがなければファイルも削除
  const stillUsed = jobs.some((j) => getSiteKey(j.client, j.site) === siteKey);
  if (!stillUsed && siteFiles[siteKey]) {
    const refs = siteFiles[siteKey];
    [...(refs.photoIds || []), ...(refs.drawingId ? [refs.drawingId] : []), ...(refs.instructionId ? [refs.instructionId] : [])]
      .forEach((id) => FileStore.remove(id).catch(() => {}));
    delete siteFiles[siteKey];
    saveSiteFiles();
  }
  saveJobs();
  renderCalendar();
}

// ── TOUCH DRAG（iPhone / iPad）────────────────
function setupTouchDrag(card) {
  let active = false, ghost = null, timer = null, ox = 0, oy = 0;
  let dragStartX = 0, dragStartY = 0, directionLocked = false;

  card.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const sx = t.clientX, sy = t.clientY;
    let moved = false;

    // 指が動いたらタイマー即解除（縦・横どちらでも）
    const onEarlyMove = (ev) => {
      if (moved) return;
      const mt = ev.touches[0];
      const dx = Math.abs(mt.clientX - sx);
      const dy = Math.abs(mt.clientY - sy);
      if (dx > 6 || dy > 6) {
        moved = true;
        clearTimeout(timer); timer = null;
        card.removeEventListener("touchmove", onEarlyMove);
      }
    };
    card.addEventListener("touchmove", onEarlyMove, { passive: true });

    timer = setTimeout(() => {
      timer = null;
      if (moved) return;  // 動いていたらドラッグ発動しない
      card.removeEventListener("touchmove", onEarlyMove);
      active = true;
      draggedCard = card;
      movedByDrag = true;
      navigator.vibrate?.(25);

      const rect = card.getBoundingClientRect();
      ox = t.clientX - rect.left;
      oy = t.clientY - rect.top;

      ghost = card.cloneNode(true);
      ghost.style.cssText = [
        "position:fixed",
        `width:${rect.width}px`,
        `left:${rect.left}px`,
        `top:${rect.top}px`,
        "opacity:0.88",
        "pointer-events:none",
        "z-index:9999",
        "transform:scale(1.07)",
        "box-shadow:0 16px 36px rgba(0,0,0,.6)",
        "transition:none",
        "border-radius:10px",
      ].join(";");
      // コンテキストメニューが開いていたらドラッグしない
      if (!document.getElementById("ctxMenu")?.classList.contains("hidden") === false) return;
      document.body.appendChild(ghost);
      card.style.opacity = "0.25";
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      directionLocked = false;
    }, 800);  // 0.8秒長押しで発動（コンテキストメニュー380msより後）

  }, { passive: true });

  card.addEventListener("touchmove", (e) => {
    if (!active) return;
    const t = e.touches[0];

    // 方向ロック：最初の動きが縦ならドラッグキャンセル
    if (!directionLocked) {
      const dx = Math.abs(t.clientX - dragStartX);
      const dy = Math.abs(t.clientY - dragStartY);
      if (dx < 4 && dy < 4) return;
      if (dy > dx * 0.5) {
        // 斜め・縦方向 → ドラッグ中止（水平移動が明確な場合のみ継続）
        active = false;
        ghost?.remove(); ghost = null;
        card.style.opacity = "";
        draggedCard = null;
        setTimeout(() => { movedByDrag = false; }, 120);
        return;
      }
      directionLocked = true;
    }

    e.preventDefault();
    ghost.style.left = `${t.clientX - ox}px`;
    ghost.style.top  = `${t.clientY - oy}px`;

    // ドロップ候補セルを探す
    ghost.style.display = "none";
    const el = document.elementFromPoint(t.clientX, t.clientY);
    ghost.style.display = "";
    const zone = el?.closest(".dropzone");
    document.querySelectorAll(".dropzone.drag-over").forEach(z => z.classList.remove("drag-over"));
    if (zone) zone.classList.add("drag-over");
  }, { passive: false });

  const endDrag = (e) => {
    clearTimeout(timer); timer = null;
    if (!active) return;
    active = false;

    ghost?.remove(); ghost = null;
    card.style.opacity = "";
    document.querySelectorAll(".dropzone.drag-over").forEach(z => z.classList.remove("drag-over"));

    const t = (e.changedTouches || e.touches)[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const zone = el?.closest(".dropzone");

    if (zone?.dataset.date) {
      const job = jobs.find(j => j.id === card.dataset.jobId);
      if (job) {
        job.date = zone.dataset.date;
        saveJobs();
        renderCalendar();
        setupDropzones();
      }
    }
    draggedCard = null;
    setTimeout(() => { movedByDrag = false; }, 120);
  };

  card.addEventListener("touchend",    endDrag, { passive: true });
  card.addEventListener("touchcancel", endDrag, { passive: true });
}

// ── DRAG & DROP ───────────────────────────────
function setupDropzones() {
  document.querySelectorAll(".dropzone").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      if (!draggedCard) return;
      const newDate = zone.dataset.date;
      const jobId = draggedCard.dataset.jobId;

      if (dragCopy) {
        const src = jobs.find((j) => j.id === jobId);
        if (src) { jobs.push({ ...src, id: `job-${Date.now()}`, date: newDate }); saveJobs(); renderCalendar(); }
      } else {
        const body = zone.querySelector(".day-body");
        if (!body) return;
        const before = Array.from(body.querySelectorAll(".job")).find((c) => {
          const r = c.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        });
        before ? body.insertBefore(draggedCard, before) : body.appendChild(draggedCard);
        const job = jobs.find((j) => j.id === jobId);
        if (job) { job.date = newDate; draggedCard.dataset.date = newDate; }
        saveJobs();
        updateDays();
      }
    });
  });
}

function updateDays() {
  document.querySelectorAll(".day").forEach((day) => {
    const count = day.querySelectorAll(".day-body > .job").length;
    const el = day.querySelector(".day-count");
    if (el) el.textContent = count > 0 ? `${count}件` : "";
    day.classList.toggle("empty-day", count === 0);
  });
}

// ── JOB DETAIL MODAL ──────────────────────────
async function openJobModal(jobId) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;
  activeJobId = jobId;

  document.getElementById("modalTitle").textContent = job.site;
  document.getElementById("modalSubtitle").textContent = `${job.process} ・ ${job.date}`;
  document.getElementById("modalClient").textContent = job.client || "-";
  document.getElementById("modalProcess").textContent = job.process || "-";
  document.getElementById("modalSite").textContent = job.site || "-";
  document.getElementById("modalPlace").textContent = job.place || "-";

  const memoEl = document.getElementById("modalMemo");
  const memoRow = document.getElementById("modalMemoRow");
  if (job.memo && job.memo.trim()) {
    memoEl.textContent = job.memo;
    if (memoRow) memoRow.style.display = "";
  } else {
    memoEl.textContent = "";
    if (memoRow) memoRow.style.display = "none";
  }

  document.getElementById("jobModal").classList.add("show");

  const filesEl = document.getElementById("modalFiles");
  if (filesEl) await buildModalFiles(filesEl, job);
}

function closeJobModal() {
  document.getElementById("jobModal").classList.remove("show");
  activeJobId = null;
}

// ── EDIT FORM ─────────────────────────────────
function openEditForm(jobId) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;

  document.getElementById("formTitle").textContent = "物件を編集";
  document.getElementById("editJobId").value = jobId;
  document.getElementById("formSubmitBtn").textContent = "更新する";

  // Sync month if needed
  const [y, m, d] = job.date.split("-").map(Number);
  if (currentMonthDate.getFullYear() !== y || currentMonthDate.getMonth() + 1 !== m) {
    currentMonthDate.setFullYear(y);
    currentMonthDate.setMonth(m - 1);
    renderCalendar();
  }
  updateDateOptions();

  const jobDateNative = document.getElementById("jobDate");
  const pickerValue = document.getElementById("jobDatePickerValue");
  if (jobDateNative) jobDateNative.value = String(d);
  if (pickerValue) pickerValue.textContent = `${d}日`;

  document.getElementById("jobClient").value  = job.client  || "";
  document.getElementById("jobProcess").value = job.process || "";
  document.getElementById("jobSite").value    = job.site    || "";
  document.getElementById("jobPlace").value   = job.place   || "";
  document.getElementById("jobMemo").value    = job.memo    || "";

  ffReset(job);

  const panel = document.getElementById("newJobPanel");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetEditState() {
  document.getElementById("formTitle").textContent = "新規物件追加フォーム";
  document.getElementById("editJobId").value = "";
  document.getElementById("formSubmitBtn").textContent = "登録して追加";
}

// ── FORM SUBMIT ───────────────────────────────
async function addJobFromForm(e) {
  e.preventDefault();
  const submitBtn = document.getElementById("formSubmitBtn");
  const editId = document.getElementById("editJobId").value;
  submitBtn.disabled = true;
  submitBtn.textContent = "保存中…";
  try {
    const fd = new FormData(document.getElementById("jobForm"));
    const day = Number(fd.get("date"));
    const dateKey = getDateKey(currentMonthDate.getFullYear(), currentMonthDate.getMonth(), day);
    const fileRefs = await ffCommit();
    const client  = (fd.get("client")  || "").trim();
    const site    = (fd.get("site")    || "").trim();
    const data = {
      date: dateKey,
      client,
      process: (fd.get("process") || "").trim(),
      site,
      place:   (fd.get("place")   || "").trim(),
      memo:    (fd.get("memo")    || "").trim(),
    };
    // ファイル参照は現場単位で保存（同じ現場の全カードで共有）
    siteFiles[getSiteKey(client, site)] = fileRefs;
    saveSiteFiles();
    if (editId) {
      const idx = jobs.findIndex((j) => j.id === editId);
      if (idx >= 0) jobs[idx] = { ...jobs[idx], ...data };
    } else {
      jobs.push({ id: `job-${Date.now()}`, order: getNextOrder(dateKey), ...data });
    }
    saveJobs();
    renderCalendar();
    resetForm();
    resetEditState();
    document.getElementById("newJobPanel").classList.add("hidden");
  } catch (err) {
    console.error("[addJobFromForm]", err);
    alert("保存に失敗しました: " + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = editId ? "更新する" : "登録して追加";
  }
}

function resetForm() {
  document.getElementById("jobForm").reset();
  const jobDateNative = document.getElementById("jobDate");
  const pickerValue = document.getElementById("jobDatePickerValue");
  if (jobDateNative) jobDateNative.value = "1";
  if (pickerValue) pickerValue.textContent = "1日";
  closeDatePicker();
  ffReset(null);
}

// ── DATE PICKER (mini calendar) ───────────────
function closeDatePicker() {
  document.getElementById("jobDatePickerPopup")?.classList.add("hidden");
  document.getElementById("jobDatePickerBtn")?.setAttribute("aria-expanded", "false");
}

function setupDatePicker() {
  const btn     = document.getElementById("jobDatePickerBtn");
  const popup   = document.getElementById("jobDatePickerPopup");
  const valueEl = document.getElementById("jobDatePickerValue");
  const native  = document.getElementById("jobDate");
  if (!btn || !popup) return;

  function renderPickerGrid() {
    const y = currentMonthDate.getFullYear(), m = currentMonthDate.getMonth();
    const today = new Date();
    const todayDay = (today.getFullYear() === y && today.getMonth() === m) ? today.getDate() : -1;
    const label = document.getElementById("dpMonthLabel");
    if (label) label.textContent = `${y}年${m + 1}月`;
    const grid = document.getElementById("dpGrid");
    if (!grid) return;
    grid.innerHTML = "";
    const startDow = new Date(y, m, 1).getDay();
    const daysInMonth = getMonthLength(y, m);
    const selectedDay = Number(native?.value) || 1;
    for (let i = 0; i < startDow; i++) {
      const e = document.createElement("div");
      e.className = "dp-cell dp-empty";
      grid.appendChild(e);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = (startDow + d - 1) % 7;
      const cls = ["dp-cell"];
      if (dow === 0) cls.push("dp-sun");
      if (dow === 6) cls.push("dp-sat");
      if (d === todayDay) cls.push("dp-today");
      if (d === selectedDay) cls.push("dp-selected");
      const cell = document.createElement("div");
      cell.className = cls.join(" ");
      cell.textContent = d;
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        if (native) native.value = String(d);
        if (valueEl) valueEl.textContent = `${d}日`;
        closeDatePicker();
        renderPickerGrid();
      });
      grid.appendChild(cell);
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popup.classList.contains("hidden")) {
      renderPickerGrid();
      popup.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    } else {
      closeDatePicker();
    }
  });

  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".date-picker-wrap");
    if (!popup.classList.contains("hidden") && wrap && !wrap.contains(e.target)) {
      closeDatePicker();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDatePicker(); hideCtxMenu(); closeLightbox(); }
  });
}

// ── 休み登録日付ピッカー ──────────────────────
function setupHolidayDatePicker() {
  const btn     = document.getElementById("holDatePickerBtn");
  const popup   = document.getElementById("holDatePickerPopup");
  const valueEl = document.getElementById("holDatePickerValue");
  const native  = document.getElementById("holRegDate");
  if (!btn || !popup) return;

  const pickerDate = new Date();
  pickerDate.setDate(1);

  function renderHolGrid() {
    const y = pickerDate.getFullYear(), m = pickerDate.getMonth();
    const lbl = document.getElementById("holDpMonthLabel");
    if (lbl) lbl.textContent = `${y}年${m + 1}月`;
    const grid = document.getElementById("holDpGrid");
    if (!grid) return;
    grid.innerHTML = "";
    const today = new Date();
    const todayKey    = getDateKey(today.getFullYear(), today.getMonth(), today.getDate());
    const selectedKey = native.value || "";
    const startDow    = new Date(y, m, 1).getDay();
    const daysInMonth = getMonthLength(y, m);
    for (let i = 0; i < startDow; i++) {
      const e = document.createElement("div");
      e.className = "dp-cell dp-empty";
      grid.appendChild(e);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dow    = (startDow + d - 1) % 7;
      const dayKey = getDateKey(y, m, d);
      const cls    = ["dp-cell"];
      if (dow === 0) cls.push("dp-sun");
      if (dow === 6) cls.push("dp-sat");
      if (dayKey === todayKey)    cls.push("dp-today");
      if (dayKey === selectedKey) cls.push("dp-selected");
      const cell = document.createElement("div");
      cell.className = cls.join(" ");
      cell.textContent = d;
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        native.value    = dayKey;
        valueEl.textContent = `${y}年${m + 1}月${d}日`;
        popup.classList.add("hidden");
        btn.setAttribute("aria-expanded", "false");
        renderHolGrid();
      });
      grid.appendChild(cell);
    }
  }

  document.getElementById("holDpPrev").addEventListener("click", (e) => {
    e.stopPropagation();
    pickerDate.setMonth(pickerDate.getMonth() - 1);
    renderHolGrid();
  });
  document.getElementById("holDpNext").addEventListener("click", (e) => {
    e.stopPropagation();
    pickerDate.setMonth(pickerDate.getMonth() + 1);
    renderHolGrid();
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popup.classList.contains("hidden")) {
      if (native.value) {
        const [y, m] = native.value.split("-").map(Number);
        pickerDate.setFullYear(y);
        pickerDate.setMonth(m - 1);
      } else {
        const t = new Date();
        pickerDate.setFullYear(t.getFullYear());
        pickerDate.setMonth(t.getMonth());
      }
      renderHolGrid();
      popup.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    } else {
      popup.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("click", (e) => {
    const wrap = btn.closest(".date-picker-wrap");
    if (!popup.classList.contains("hidden") && wrap && !wrap.contains(e.target)) {
      popup.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });
}

// ── MONTH NAV ─────────────────────────────────
function goToPreviousMonth() {
  currentMonthDate.setMonth(currentMonthDate.getMonth() - 1);
  renderCalendar();
}

function goToNextMonth() {
  currentMonthDate.setMonth(currentMonthDate.getMonth() + 1);
  renderCalendar();
}

function goToToday() {
  const today = new Date();
  if (currentMonthDate.getFullYear() !== today.getFullYear() ||
      currentMonthDate.getMonth() !== today.getMonth()) {
    currentMonthDate.setFullYear(today.getFullYear());
    currentMonthDate.setMonth(today.getMonth());
    currentMonthDate.setDate(1);
    renderCalendar();
  }
  const key = getDateKey(today.getFullYear(), today.getMonth(), today.getDate());
  const cell = document.querySelector(`.calendar-cell[data-date="${key}"]`);
  if (!cell) return;
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
  cell.classList.remove("today-focus");
  void cell.offsetWidth;
  cell.classList.add("today-focus");
  cell.addEventListener("animationend", () => cell.classList.remove("today-focus"), { once: true });
}

// ── DASHBOARD ─────────────────────────────────
function updateDashboardStats() {
  const today = new Date();
  const todayKey = getDateKey(today.getFullYear(), today.getMonth(), today.getDate());

  const thisMonthPrefix = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;

  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const todayCount = jobs.filter((j) => j.date === todayKey).length;
  const monthCount = jobs.filter((j) => j.date.startsWith(thisMonthPrefix)).length;
  const weekCount  = jobs.filter((j) => { const d = new Date(j.date); return d >= weekStart && d <= weekEnd; }).length;
  const memoCount  = jobs.filter((j) => j.memo && j.memo.trim()).length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("statToday", todayCount + "件");
  set("statUnassigned", monthCount + "件");
  set("statVehicle", weekCount + "件");
  set("statAlert", memoCount + "件");
}

// ── SEARCH ────────────────────────────────────
function filterJobs() {
  const q = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();
  document.querySelectorAll(".job").forEach((card) => {
    const jobId = card.dataset.jobId;
    const job = jobs.find((j) => j.id === jobId);
    if (!job) { card.style.display = "none"; return; }
    const hay = [job.client, job.process, job.site, job.place, job.memo].join(" ").toLowerCase();
    card.style.display = !q || hay.includes(q) ? "" : "none";
  });
  updateDays();
}

// ── 予定表モーダル ────────────────────────────
function getTomorrowKey() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return getDateKey(d.getFullYear(), d.getMonth(), d.getDate());
}

function getDateLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const isWeekend = dow === 0 || dow === 6;
  const label = `${y}年${m}月${d}日（${DOW[dow]}）`;
  return isWeekend ? label + " 🔴" : label;
}

// ── メモポップオーバー ─────────────────────────────
let _memoPop = null;
function _getMemoPopEl() {
  if (!_memoPop) {
    _memoPop = document.createElement("div");
    _memoPop.className = "memo-popover hidden";
    document.body.appendChild(_memoPop);
    const dismissPop = (e) => {
      if (!e.target.closest(".memo-cell")) _memoPop.classList.add("hidden");
    };
    document.addEventListener("click", dismissPop, true);
    // iOSではclickが来ないのでtouchstartでも閉じる
    document.addEventListener("touchstart", dismissPop, { capture: true, passive: true });
  }
  return _memoPop;
}
function showMemoPopover(anchor, text) {
  const pop = _getMemoPopEl();
  pop.textContent = `⚠ ${text}`;
  pop.classList.remove("hidden");
  const r   = anchor.getBoundingClientRect();
  const pw  = Math.min(280, window.innerWidth - 24);
  let left  = r.left;
  if (left + pw > window.innerWidth - 12)  left = window.innerWidth - pw - 12;
  if (left < 12) left = 12;
  let top = r.bottom + 8;
  if (top + 80 > window.innerHeight) top = r.top - 8 - 80;
  if (top < 8) top = 8;
  pop.style.left     = `${left}px`;
  pop.style.top      = `${top}px`;
  pop.style.maxWidth = `${pw}px`;
}

// ── 工程表 テーブル行（列：No/元請/現場名/場所/工程/車両/時間/メンバー/メモ） ──
const _isTouch = () => window.matchMedia("(pointer: coarse)").matches;
function buildScheduleRow(job, num, total) {
  const tr = document.createElement("tr");
  const cc = getJobColorClass(job.process);
  tr.className = `srow ${cc}`;
  tr.dataset.jobId = job.id;
  // iOSでは draggable 属性を付けない（付けると行が斜めにドラッグされてしまう）
  if (!_isTouch()) tr.setAttribute("draggable", "true");

  const time = job.time || "—";

  const memberChips = (job.members || []).map((m) =>
    `<span class="assigned-chip">${escHtml(m)}<button class="chip-x" data-type="member" data-job="${job.id}" data-val="${escHtml(m)}">✕</button></span>`
  ).join("") || `<span class="cell-empty">—</span>`;

  const vehicleChips = (job.vehicles || []).map((v) =>
    `<span class="assigned-chip vehicle-chip">${escHtml(v)}<button class="chip-x" data-type="vehicle" data-job="${job.id}" data-val="${escHtml(v)}">✕</button></span>`
  ).join("") || `<span class="cell-empty">—</span>`;

  const upBtn   = num > 1     ? `<button class="move-btn" data-dir="-1" data-job="${job.id}" title="上へ">▲</button>` : `<span class="move-ph"></span>`;
  const downBtn = num < total ? `<button class="move-btn" data-dir="1"  data-job="${job.id}" title="下へ">▼</button>` : `<span class="move-ph"></span>`;

  tr.innerHTML = `
    <td class="col-no">
      <span class="order-badge">${num}</span>
      <div class="row-move-btns">${upBtn}${downBtn}</div>
    </td>
    <td class="col-client">${escHtml(job.client)}</td>
    <td class="col-site">${escHtml(job.site)}</td>
    <td class="col-place">${escHtml(cityOnly(job.place))}</td>
    <td class="col-proc"><span class="pbadge ${cc}">${escHtml(job.process)}</span></td>
    <td class="col-truck assignable-cell" data-assign-type="vehicle">${vehicleChips}</td>
    <td class="col-time">${escHtml(time)}</td>
    <td class="col-members assignable-cell" data-assign-type="member">${memberChips}</td>
    <td class="col-memo">${job.memo ? `<span class="memo-cell">⚠ ${escHtml(job.memo)}</span>` : ""}</td>
  `;

  // メモセル：タップで全文ポップオーバー（iOS touch対応）
  if (job.memo) {
    const memoCell = tr.querySelector(".memo-cell");
    const openMemo = (e) => { e.stopPropagation(); showMemoPopover(memoCell, job.memo); };
    memoCell.addEventListener("click", openMemo);
    // touchstart で伝播を止め、touchend でポップオーバー表示
    memoCell.addEventListener("touchstart", (e) => { e.stopPropagation(); }, { passive: true });
    memoCell.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMemo(e);
    }, { passive: false });
  }

  // ── 行ドラッグ（PC のみ） ──────────────
  if (!_isTouch()) {
    tr.addEventListener("dragstart", (e) => {
      dragRowJobId = job.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", job.id);
      setTimeout(() => tr.classList.add("dragging-row"), 0);
    });
    tr.addEventListener("dragend", () => {
      tr.classList.remove("dragging-row");
      dragRowJobId = null;
      document.querySelectorAll(".drag-above,.drag-below").forEach((el) =>
        el.classList.remove("drag-above", "drag-below")
      );
    });
    tr.addEventListener("dragover", (e) => {
      if (!dragRowJobId || dragRowJobId === job.id) return;
      const src = jobs.find((j) => j.id === dragRowJobId);
      if (!src || src.date !== job.date) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const above = e.clientY < tr.getBoundingClientRect().top + tr.getBoundingClientRect().height / 2;
      tr.classList.toggle("drag-above", above);
      tr.classList.toggle("drag-below", !above);
    });
    tr.addEventListener("dragleave", (e) => {
      if (!tr.contains(e.relatedTarget)) tr.classList.remove("drag-above", "drag-below");
    });
    tr.addEventListener("drop", (e) => {
      e.preventDefault();
      tr.classList.remove("drag-above", "drag-below");
      if (!dragRowJobId || dragRowJobId === job.id) return;
      const src = jobs.find((j) => j.id === dragRowJobId);
      if (!src || src.date !== job.date) return;
      const rect = tr.getBoundingClientRect();
      dropReorderRow(job.date, dragRowJobId, job.id, e.clientY >= rect.top + rect.height / 2);
      renderScheduleModal();
      renderCalendar();
    });
  }

  return tr;
}

function renderScheduleModal() {
  const dayJobs = getDayJobs(scheduleDateKey);
  document.getElementById("tomorrowDateLabel").textContent = getDateLabel(scheduleDateKey);
  const list = document.getElementById("tomorrowJobList");
  list.innerHTML = "";

  // 工程表テーブル
  const wrap = document.createElement("div");
  wrap.className = "schedule-table-wrap";
  const table = document.createElement("table");
  table.className = "schedule-table";
  table.innerHTML = `
    <thead><tr>
      <th class="col-no">No</th>
      <th class="col-client">元請</th>
      <th class="col-site">現場名</th>
      <th class="col-place">場所</th>
      <th class="col-proc">工程</th>
      <th class="col-truck">車両</th>
      <th class="col-time">時間</th>
      <th class="col-members">メンバー</th>
      <th class="col-memo">メモ</th>
    </tr></thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  if (dayJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="cell-empty-row">この日の予定はありません</td></tr>`;
  } else {
    dayJobs.forEach((j, i) => tbody.appendChild(buildScheduleRow(j, i + 1, dayJobs.length)));
  }

  // テーブルのクリック／タッチハンドラ（並び替え ▲▼ / 割当 × 解除）
  const handleTableAction = (e) => {
    // ▲▼ 並び替えボタン
    const moveBtn = e.target.closest(".move-btn");
    if (moveBtn) {
      moveJobInDay(moveBtn.dataset.job, Number(moveBtn.dataset.dir));
      renderScheduleModal();
      renderCalendar();
      return;
    }
    // ×ボタン → 解除
    const chipX = e.target.closest(".chip-x");
    if (chipX) {
      const type  = chipX.dataset.type;
      const jobId = chipX.dataset.job;
      const val   = chipX.dataset.val;
      if (type === "member") unassignMember(jobId, val);
      else                   unassignVehicle(jobId, val);
      renderScheduleModal();
      renderCmdSidebar();
      return;
    }
    // セルクリック → 割当
    if (!selectedChip) return;
    const cell = e.target.closest(".assignable-cell");
    if (!cell) return;
    const row = cell.closest(".srow");
    if (!row) return;
    const jobId     = row.dataset.jobId;
    const assignType = cell.dataset.assignType;
    if (selectedChip.type === assignType) {
      let changed = false;
      if (assignType === "member") changed = assignMember(jobId, selectedChip.value);
      else                       { assignVehicle(jobId, selectedChip.value); changed = true; }
      selectedChip = null;
      renderScheduleModal();
      renderCmdSidebar();
      // 休みを削除した可能性があるのでカレンダーも更新
      if (changed) renderCalendar();
    }
  };
  tbody.addEventListener("click", handleTableAction);
  // iOS: touchend でも同じ処理（memo-cell 以外）
  tbody.addEventListener("touchend", (e) => {
    if (e.target.closest(".memo-cell")) return; // メモはmemoCell側で処理
    handleTableAction(e);
  }, { passive: true });

  wrap.appendChild(table);
  list.appendChild(wrap);

  // 割当モード中はセルをハイライト
  if (selectedChip) {
    const type = selectedChip.type === "member" ? "member" : "vehicle";
    table.querySelectorAll(`.assignable-cell[data-assign-type="${type}"]`).forEach((c) => {
      c.classList.add("cell-assignable");
    });
  }

  // 休みセクション
  const dayHolidays = getHolidaysByDate(scheduleDateKey);
  const sec = document.createElement("div");
  sec.className = "schedule-holiday-section";
  if (dayHolidays.length === 0) {
    sec.innerHTML = `<div class="schedule-holiday-title">休み</div><div class="schedule-holiday-none">なし</div>`;
  } else {
    sec.innerHTML = `<div class="schedule-holiday-title">休み</div>` +
      dayHolidays.map((h) => `<div class="schedule-holiday-item">${escHtml(h.memberName)}（${escHtml(h.type)}）</div>`).join("");
  }
  list.appendChild(sec);

  // サイドバーも更新
  renderCmdSidebar();
}

function openScheduleModal(dateKey) {
  scheduleDateKey = dateKey || getTomorrowKey();
  const input = document.getElementById("scheduleDateInput");
  if (input) input.value = scheduleDateKey;
  renderScheduleModal();
  document.getElementById("tomorrowModal").classList.add("show");
}

function closeTomorrowModal() {
  document.getElementById("tomorrowModal").classList.remove("show");
}

// ── LINE TEXT（UIなし・現場向け簡易工程表） ───
function getLINEText() {
  const key     = scheduleDateKey || getTomorrowKey();
  const dayJobs = getDayJobs(key);
  const label   = getDateLabel(key);
  const lines   = [`◆ 工程表｜${label}`, ""];

  if (dayJobs.length === 0) {
    lines.push("（予定なし）");
  } else {
    dayJobs.forEach((job, i) => {
      const members  = (job.members  || []).join("・") || "—";
      const vehicles = (job.vehicles || []).join(" ")  || "—";
      const time     = job.time || "";
      // 1行目: No. 元請　現場名　場所
      lines.push(`${i + 1}. ${job.client}　${job.site}　${job.place}`);
      // 2行目: 工程・車両・時間
      const row2 = [job.process, vehicles !== "—" ? vehicles : null, time || null].filter(Boolean).join("　");
      if (row2) lines.push(`   ${row2}`);
      // 3行目: メンバー
      if (members !== "—") lines.push(`   👷 ${members}`);
      // 4行目: メモ
      if (job.memo && job.memo.trim()) lines.push(`   ⚠ ${job.memo}`);
      lines.push("");
    });
  }

  // 休み
  const dayHols = getHolidaysByDate(key);
  lines.push("【休み】");
  if (dayHols.length === 0) {
    lines.push("なし");
  } else {
    dayHols.forEach((h) => lines.push(`${h.memberName}（${h.type}）`));
  }

  return lines.join("\n");
}

function copyLineText() {
  const text = getLINEText();
  const btn = document.getElementById("copyLineBtn");
  const done = () => {
    const orig = btn.textContent;
    btn.textContent = "✓ コピー完了";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2200);
  };
  navigator.clipboard.writeText(text).then(done).catch(() => window.prompt("以下をコピーしてください:", text));
}

// ── PRINT（A4横・工程表） ──────────────────────
function printSchedule() {
  const key     = scheduleDateKey || getTomorrowKey();
  const dayJobs = getDayJobs(key);
  const label   = getDateLabel(key);
  const dayHols = getHolidaysByDate(key);

  const procColor = { silver: "#9e9e9e", red: "#e53935", blue: "#1e72ff", purple: "#8e24aa" };
  const getColor  = (proc) => procColor[getJobColorClass(proc)] || "#9e9e9e";

  // テーブル行（UIなし：プレーンテキスト）
  const tableRows = dayJobs.map((job, i) => {
    const members  = (job.members  || []).join("・") || "—";
    const vehicles = (job.vehicles || []).join(" ")  || "—";
    const time     = job.time || "—";
    const color    = getColor(job.process);
    return `<tr>
      <td class="c-no" style="border-left:4px solid ${color}">${i + 1}</td>
      <td class="c-client">${escHtml(job.client)}</td>
      <td class="c-site">${escHtml(job.site)}</td>
      <td class="c-place">${escHtml(job.place)}</td>
      <td class="c-proc" style="color:${color};font-weight:800">${escHtml(job.process)}</td>
      <td class="c-truck">${escHtml(vehicles)}</td>
      <td class="c-time">${escHtml(time)}</td>
      <td class="c-members">${escHtml(members)}</td>
      <td class="c-memo">${job.memo ? `<span class="memo">⚠ ${escHtml(job.memo)}</span>` : ""}</td>
    </tr>`;
  }).join("");

  const holidayBlock = dayHols.length === 0
    ? "<p class='hol-none'>なし</p>"
    : dayHols.map((h) => `<p class="hol-item">${escHtml(h.memberName)}（${escHtml(h.type)}）</p>`).join("");

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>工程表</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "Yu Gothic Medium","Yu Gothic","Meiryo",Arial,sans-serif;
  font-size: 11px; color: #111;
  padding: 10mm 12mm;
}
h1 {
  font-size: 16px; font-weight: 800;
  border-bottom: 2.5px solid #111;
  padding-bottom: 5px; margin-bottom: 10px;
  display: flex; align-items: baseline; gap: 12px;
}
h1 span { font-size: 12px; font-weight: 500; color: #555; }
table {
  width: 100%; border-collapse: collapse;
  table-layout: fixed;
}
col.c-no      { width: 4%; }
col.c-client  { width: 10%; }
col.c-site    { width: 16%; }
col.c-place   { width: 8%; }
col.c-proc    { width: 7%; }
col.c-truck   { width: 7%; }
col.c-time    { width: 5%; }
col.c-members { width: 26%; }
col.c-memo    { width: 17%; }
th {
  background: #111; color: #fff;
  font-size: 9px; font-weight: 700;
  letter-spacing: .08em;
  padding: 5px 6px; text-align: left;
}
th.c-no { text-align: center; }
td {
  border: 1px solid #ddd;
  padding: 8px 6px; vertical-align: top;
  font-size: 11px; line-height: 1.5;
  word-break: break-word;
  min-height: 80px;
}
td.c-no { text-align: center; font-weight: 700; color: #555; vertical-align: middle; }
td.c-site { font-weight: 700; }
td.c-client { color: #555; font-size: 10px; }
td.c-members { word-break: break-all; }
.memo { color: #cc0000; }
tr:nth-child(even) td { background: #fafafa; }
.holiday-section {
  margin-top: 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 8px 12px;
  background: #fff8f0;
}
.holiday-title {
  font-size: 11px; font-weight: 700;
  color: #cc6600; margin-bottom: 4px;
  letter-spacing: .05em;
}
.hol-item { font-size: 11px; line-height: 1.8; }
.hol-none { font-size: 11px; color: #aaa; }
.footer {
  margin-top: 10px; font-size: 9px; color: #aaa;
  text-align: right; border-top: 1px solid #eee;
  padding-top: 6px;
}
@page { size: A4 landscape; margin: 0; }
</style></head><body>
<h1>工程表<span>${label}</span></h1>
<table>
  <colgroup>
    <col class="c-no"><col class="c-client"><col class="c-site">
    <col class="c-place"><col class="c-proc"><col class="c-truck">
    <col class="c-time"><col class="c-members"><col class="c-memo">
  </colgroup>
  <thead><tr>
    <th class="c-no">No</th>
    <th class="c-client">元請</th>
    <th class="c-site">現場名</th>
    <th class="c-place">場所</th>
    <th class="c-proc">工程</th>
    <th class="c-truck">車両</th>
    <th class="c-time">時間</th>
    <th class="c-members">メンバー</th>
    <th class="c-memo">メモ</th>
  </tr></thead>
  <tbody>${tableRows || `<tr><td colspan="9" style="text-align:center;color:#999;padding:20px">予定なし</td></tr>`}</tbody>
</table>
<div class="holiday-section">
  <div class="holiday-title">【休み】</div>
  ${holidayBlock}
</div>
<div class="footer">N-WORK SYSTEM v3 ・ 出力：${new Date().toLocaleDateString("ja-JP")}</div>
</body></html>`;

  const blob = new Blob([html], { type: "text/html; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (win) {
    win.addEventListener("load", () => {
      setTimeout(() => { win.print(); URL.revokeObjectURL(url); }, 300);
    });
  }
}

function savePdf() {
  printSchedule();
}

// ── LINE共有トースト通知 ──────────────────────
function showLineToast(clipped) {
  const msg = clipped
    ? "⬇ ダウンロード完了\n✓ クリップボードにコピー済み\nLINEで Ctrl+V 貼付できます"
    : "⬇ 工程表をダウンロードしました\nLINEに画像を添付してください";
  const el = document.createElement("div");
  el.className = "share-toast" + (clipped ? " share-toast--ok" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 5000);
}

// ── LINE共有（PNG画像） ───────────────────────
async function shareAsImage() {
  const btn = document.getElementById("lineShareImgBtn");
  if (btn) { btn.textContent = "⏳ 生成中…"; btn.disabled = true; }

  // ── html2canvas チェック ──────────────────
  if (typeof html2canvas === "undefined") {
    console.error("[shareAsImage] html2canvas 未読み込み。CDN接続を確認してください。");
    alert("PNG生成ライブラリが未読み込みです。\nインターネット接続を確認して再読み込みしてください。\n\n「🖨 印刷」→「PDF保存」をお使いください。");
    if (btn) { btn.textContent = "📱 LINE共有"; btn.disabled = false; }
    return;
  }

  const key     = scheduleDateKey || getTomorrowKey();
  const dayJobs = getDayJobs(key);
  const label   = getDateLabel(key);
  const dayHols = getHolidaysByDate(key);

  const procColor = { silver: "#9e9e9e", red: "#e53935", blue: "#1e72ff", purple: "#8e24aa" };
  const getColor  = (proc) => procColor[getJobColorClass(proc)] || "#9e9e9e";

  const tdBase = "padding:8px 6px;border:1px solid #ddd;vertical-align:top;font-size:11px;line-height:1.5;word-break:break-word;min-height:80px";
  const tableRows = dayJobs.map((job, i) => {
    const members  = (job.members  || []).join("・") || "—";
    const vehicles = (job.vehicles || []).join(" ")  || "—";
    const time     = job.time || "—";
    const color    = getColor(job.process);
    return `<tr>
      <td style="${tdBase};border-left:4px solid ${color};text-align:center;font-weight:700;color:#555;vertical-align:middle;width:4%">${i + 1}</td>
      <td style="${tdBase};color:#555;font-size:10px;width:10%">${escHtml(job.client)}</td>
      <td style="${tdBase};font-weight:700;width:16%">${escHtml(job.site)}</td>
      <td style="${tdBase};color:#777;font-size:10px;width:8%">${escHtml(job.place)}</td>
      <td style="${tdBase};color:${color};font-weight:800;width:7%">${escHtml(job.process)}</td>
      <td style="${tdBase};width:7%">${escHtml(vehicles)}</td>
      <td style="${tdBase};width:5%">${escHtml(time)}</td>
      <td style="${tdBase};width:26%;word-break:break-all">${escHtml(members)}</td>
      <td style="${tdBase};width:17%">${job.memo ? `<span style="color:#cc0000">⚠ ${escHtml(job.memo)}</span>` : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" style="text-align:center;color:#999;padding:20px">予定なし</td></tr>`;

  const thBase = "background:#111;color:#fff;font-size:9px;font-weight:700;letter-spacing:.08em;padding:5px 6px;text-align:left";
  const holidayHtml = dayHols.length === 0
    ? `<span style="color:#aaa">なし</span>`
    : dayHols.map((h) => `${escHtml(h.memberName)}（${escHtml(h.type)}）`).join("　");

  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1122px;background:#fff;color:#111;font-family:Yu Gothic Medium,Yu Gothic,Meiryo,Arial,sans-serif;font-size:11px;padding:28px 36px;line-height:1.4";
  wrap.innerHTML = `
    <div style="font-size:16px;font-weight:800;border-bottom:2.5px solid #111;padding-bottom:5px;margin-bottom:10px;display:flex;align-items:baseline;gap:12px">
      工程表 <span style="font-size:12px;font-weight:500;color:#555">${label}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <colgroup>
        <col style="width:4%"><col style="width:10%"><col style="width:16%">
        <col style="width:8%"><col style="width:7%"><col style="width:7%">
        <col style="width:5%"><col style="width:26%"><col style="width:17%">
      </colgroup>
      <thead><tr>
        <th style="${thBase};text-align:center">No</th>
        <th style="${thBase}">元請</th><th style="${thBase}">現場名</th>
        <th style="${thBase}">場所</th><th style="${thBase}">工程</th>
        <th style="${thBase}">車両</th><th style="${thBase}">時間</th>
        <th style="${thBase}">メンバー</th><th style="${thBase}">メモ</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div style="margin-top:12px;border:1px solid #ddd;border-radius:4px;padding:8px 12px;background:#fff8f0">
      <div style="font-size:11px;font-weight:700;color:#cc6600;margin-bottom:4px">【休み】</div>
      <div style="font-size:11px">${holidayHtml}</div>
    </div>
    <div style="margin-top:10px;font-size:9px;color:#aaa;text-align:right;border-top:1px solid #eee;padding-top:6px">
      N-WORK SYSTEM v3 ・ ${new Date().toLocaleDateString("ja-JP")}
    </div>`;

  document.body.appendChild(wrap);

  try {
    console.log("[shareAsImage] html2canvas 開始");
    const canvas = await html2canvas(wrap, { backgroundColor: "#fff", scale: 2, useCORS: true, logging: false });
    console.log("[shareAsImage] html2canvas 完了。PNG変換中…");

    // toBlob を Promise 化（await を確保する）
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) {
          console.log("[shareAsImage] PNG生成完了:", b.size, "bytes");
          resolve(b);
        } else {
          reject(new Error("canvas.toBlob が null を返しました"));
        }
      }, "image/png");
    });

    const filename = `工程表_${key}.png`;
    const file = new File([blob], filename, { type: "image/png" });

    // ── モバイル（iOS / Android）のみ Web Share API を使用 ──
    // Windows Chrome も canShare=true を返すが、Windowsの共有シートは
    // ファイルを受け取れないため、UA判定でモバイルに限定する。
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    console.log("[shareAsImage] isMobile:", isMobile, "canShare:", !!(navigator.canShare));

    if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
      console.log("[shareAsImage] モバイル: Web Share API で共有");
      try {
        await navigator.share({ files: [file], title: `工程表 ${label}` });
        console.log("[shareAsImage] 共有成功");
        return;
      } catch (e) {
        if (e.name === "AbortError") { console.log("[shareAsImage] ユーザーがキャンセル"); return; }
        console.warn("[shareAsImage] Web Share API 失敗。ダウンロードへ:", e);
      }
    }

    // ── PC: 自動ダウンロード（必ず実行） ──
    console.log("[shareAsImage] ダウンロード開始:", filename);
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl; a.download = filename; a.click();
    URL.revokeObjectURL(dlUrl);
    console.log("[shareAsImage] ダウンロード完了");

    // ── PC: クリップボードへ画像コピー（Chrome / Edge）──
    let clipped = false;
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        clipped = true;
        console.log("[shareAsImage] クリップボードコピー成功");
      } catch (e) {
        console.warn("[shareAsImage] クリップボードコピー失敗:", e.name, "-", e.message);
      }
    } else {
      console.log("[shareAsImage] ClipboardItem 未対応:",
        "clipboard:", !!navigator.clipboard,
        "ClipboardItem:", !!window.ClipboardItem);
    }

    showLineToast(clipped);

  } catch (e) {
    console.error("[shareAsImage] 致命的エラー:", e);
    alert(`PNG生成に失敗しました。\nエラー: ${e.message}\n\n「🖨 印刷」ボタンをお使いください。`);
  } finally {
    if (document.body.contains(wrap)) document.body.removeChild(wrap);
    if (btn) { btn.textContent = "📱 LINE共有"; btn.disabled = false; }
  }
}

// ══════════════════════════════════════════════
// ── メンバー / 車両 / 休み データ ─────────────
// ══════════════════════════════════════════════
const MEMBERS_KEY  = "takuma_members";
const VEHICLES_KEY = "takuma_vehicles";
const HOLIDAYS_KEY = "takuma_holidays";

let members  = (() => { try { return JSON.parse(localStorage.getItem(MEMBERS_KEY))  || []; } catch { return []; } })();
let vehicles = (() => { try { return JSON.parse(localStorage.getItem(VEHICLES_KEY)) || []; } catch { return []; } })();
let holidays = (() => { try { return JSON.parse(localStorage.getItem(HOLIDAYS_KEY)) || []; } catch { return []; } })();

function saveMembers()  { localStorage.setItem(MEMBERS_KEY,  JSON.stringify(members));  }
function saveVehicles() { localStorage.setItem(VEHICLES_KEY, JSON.stringify(vehicles)); }
function saveHolidays() { localStorage.setItem(HOLIDAYS_KEY, JSON.stringify(holidays)); }

// 日付ごとの休み取得（renderScheduleModal・LINE・printから参照）
function getHolidaysByDate(dateKey) {
  return holidays.filter((h) => h.date === dateKey);
}

// ── 割当済チェック ─────────────────────────────
function getMembersUsedOnDate(dateKey) {
  // 後方互換維持（工程に割当 + 休み の両方）
  const s = new Set();
  jobs.filter((j) => j.date === dateKey).forEach((j) => (j.members || []).forEach((m) => s.add(m)));
  holidays.filter((h) => h.date === dateKey).forEach((h) => s.add(h.memberName));
  return s;
}
function getMembersAssignedOnDate(dateKey) {
  // 工程に割当されているメンバーのみ
  const s = new Set();
  jobs.filter((j) => j.date === dateKey).forEach((j) => (j.members || []).forEach((m) => s.add(m)));
  return s;
}
function getMembersOnHolidayOnDate(dateKey) {
  const s = new Set();
  holidays.filter((h) => h.date === dateKey).forEach((h) => s.add(h.memberName));
  return s;
}
function getVehiclesUsedOnDate(dateKey) {
  const s = new Set();
  jobs.filter((j) => j.date === dateKey).forEach((j) => (j.vehicles || []).forEach((v) => s.add(v)));
  return s;
}

// ── メンバー状態の一元判定 ─────────────────────
// 戻り値: "assigned" | "off" | "available"
function getMemberStatusOnDate(memberName, date) {
  if (holidays.some((h) => h.date === date && h.memberName === memberName)) return "off";
  if (jobs.some((j) => j.date === date && (j.members || []).includes(memberName))) return "assigned";
  return "available";
}

// ── 選択中チップ ───────────────────────────────
let selectedChip  = null; // { type:"member"|"vehicle", value:"名前" }
let activeTabName = "members";

// ── 割当 ───────────────────────────────────────
function assignMember(jobId, name) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return false;
  if (!job.members) job.members = [];
  if (job.members.includes(name)) return false;

  // 同日・別現場への割当チェック
  const usedElsewhere = jobs
    .filter((j) => j.date === job.date && j.id !== jobId)
    .flatMap((j) => j.members || []);
  if (usedElsewhere.includes(name)) {
    alert(`${name} はこの日すでに別の現場に割り当てられています。`);
    return false;
  }

  // 同日・休み登録チェック
  const holEntry = holidays.find((h) => h.date === job.date && h.memberName === name);
  if (holEntry) {
    if (!confirm(`${name} はこの日に休み登録されています（${holEntry.type}）。\n現場へ割り当てる場合、休みから外しますか？`)) {
      return false;
    }
    // 休みから削除
    holidays = holidays.filter((h) => !(h.date === job.date && h.memberName === name));
    saveHolidays();
  }

  job.members.push(name);
  saveJobs();
  return true;
}
function unassignMember(jobId, name) {
  const job = jobs.find((j) => j.id === jobId);
  if (job) { job.members = (job.members || []).filter((m) => m !== name); saveJobs(); }
}
function assignVehicle(jobId, name) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;
  if (!job.vehicles) job.vehicles = [];
  if (job.vehicles.includes(name)) return;
  const usedElsewhere = jobs
    .filter((j) => j.date === job.date && j.id !== jobId)
    .flatMap((j) => j.vehicles || []);
  if (usedElsewhere.includes(name)) {
    alert(`${name} はこの日すでに別の現場に割り当てられています。`);
    return;
  }
  job.vehicles.push(name);
  saveJobs();
}
function unassignVehicle(jobId, name) {
  const job = jobs.find((j) => j.id === jobId);
  if (job) { job.vehicles = (job.vehicles || []).filter((v) => v !== name); saveJobs(); }
}

// ── メンバー管理 ───────────────────────────────
function addMember(name) {
  name = name.trim();
  if (!name || members.find((m) => m.name === name)) return false;
  members.push({ id: `m-${Date.now()}`, name });
  saveMembers();
  return true;
}
function deleteMember(id) {
  members = members.filter((m) => m.id !== id);
  saveMembers();
}

// ── 車両管理 ───────────────────────────────────
function addVehicle(name, type, inspDate, isRental) {
  name = name.trim();
  if (!name) { alert("車両名を入力してください。"); return false; }
  if (!isRental && !inspDate) {
    alert("車検満期日を入力してください。\nレンタカーの場合はチェックを入れてください。");
    return false;
  }
  vehicles.push({ id: `v-${Date.now()}`, name, type: type || "その他", inspectionDate: inspDate || "", isRental: !!isRental });
  saveVehicles();
  return true;
}
function deleteVehicle(id) {
  vehicles = vehicles.filter((v) => v.id !== id);
  saveVehicles();
}

// ── 休み管理 ───────────────────────────────────
function addHoliday(date, memberName, type, memo) {
  if (!memberName || !type) return false;

  // 同日・休み二重登録チェック
  if (holidays.find((h) => h.date === date && h.memberName === memberName)) {
    alert(`${memberName} のこの日の休みはすでに登録されています。`);
    return false;
  }

  // 同日・現場割当チェック
  const assignedJob = jobs.find((j) => j.date === date && (j.members || []).includes(memberName));
  if (assignedJob) {
    if (!confirm(`${memberName} はこの日に「${assignedJob.site}」へ割り当て済みです。\n休みに登録する場合、現場割当から外しますか？`)) {
      return false;
    }
    // 現場割当から削除
    assignedJob.members = (assignedJob.members || []).filter((m) => m !== memberName);
    saveJobs();
  }

  holidays.push({ id: `h-${Date.now()}`, date, memberName, type, memo: (memo || "").trim() });
  saveHolidays();
  return true;
}
function deleteHoliday(id) {
  holidays = holidays.filter((h) => h.id !== id);
  saveHolidays();
}

// ══════════════════════════════════════════════
// ── 司令室サイドバー ───────────────────────────
// ══════════════════════════════════════════════
function renderCmdSidebar() {
  const body = document.getElementById("cmdTabBody");
  if (!body) return;
  body.innerHTML = "";
  if (activeTabName === "members")  renderMembersTab(body);
  if (activeTabName === "vehicles") renderVehiclesTab(body);
  if (activeTabName === "holidays") renderHolidaysTab(body);
}

function renderMembersTab(container) {
  const assigned  = getMembersAssignedOnDate(scheduleDateKey);
  const onHoliday = getMembersOnHolidayOnDate(scheduleDateKey);

  // チップ一覧
  const list = document.createElement("div");
  list.className = "cmd-chip-list";
  if (members.length === 0) {
    list.innerHTML = `<p class="cmd-empty">メンバー未登録</p>`;
  } else {
    members.forEach((m) => {
      const isAssigned = assigned.has(m.name);
      const isHoliday  = onHoliday.has(m.name);
      const isSel      = selectedChip?.type === "member" && selectedChip.value === m.name;
      const chip       = document.createElement("div");
      chip.className = `cmd-chip${isAssigned ? " inuse" : ""}${isHoliday ? " on-holiday" : ""}${isSel ? " selected" : ""}`;

      const holEntry = isHoliday ? holidays.find((h) => h.date === scheduleDateKey && h.memberName === m.name) : null;
      chip.innerHTML = `<span>${escHtml(m.name)}</span>` + (
        isAssigned ? `<small class="inuse-label">使用中</small>`
          : isHoliday ? `<small class="inuse-label">${escHtml(holEntry?.type || "休み")}</small>`
          : `<button class="cmd-chip-del" data-id="${m.id}">✕</button>`
      );

      if (!isAssigned) {
        const chipTap = (e) => {
          if (e.target.closest(".cmd-chip-del")) return;
          if (isHoliday) {
            const typeStr = holEntry?.type || "休み";
            if (!confirm(`⚠ ${m.name} は休み予定です（${typeStr}）\n割り当てますか？`)) return;
          }
          selectedChip = isSel ? null : { type: "member", value: m.name };
          renderCmdSidebar();
          renderScheduleModal();
        };
        chip.addEventListener("click", chipTap);
        chip.addEventListener("touchend", (e) => {
          if (e.target.closest(".cmd-chip-del")) return;
          e.preventDefault();
          chipTap(e);
        }, { passive: false });
        if (!isHoliday) {
          chip.querySelector(".cmd-chip-del").addEventListener("click", (e) => {
            e.stopPropagation();
            if (!confirm(`「${m.name}」を削除しますか？`)) return;
            deleteMember(m.id);
            renderCmdSidebar();
          });
        }
      }
      list.appendChild(chip);
    });
  }
  container.appendChild(list);

  if (selectedChip?.type === "member") {
    const hint = document.createElement("div");
    hint.className = "cmd-hint";
    hint.textContent = `▶ 表のメンバー欄をタップして割り当て`;
    container.appendChild(hint);
  }

  // 追加フォーム
  const form = document.createElement("div");
  form.className = "cmd-add-form";
  form.innerHTML = `<input type="text" class="cmd-input" id="newMemberInput" placeholder="名前を追加…" maxlength="20">
    <button class="cmd-add-btn" id="addMemberBtn">追加</button>`;
  form.querySelector("#addMemberBtn").addEventListener("click", () => {
    const inp = form.querySelector("#newMemberInput");
    if (addMember(inp.value)) { inp.value = ""; renderCmdSidebar(); }
  });
  form.querySelector("#newMemberInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") form.querySelector("#addMemberBtn").click();
  });
  container.appendChild(form);
}

function renderVehiclesTab(container) {
  const used  = getVehiclesUsedOnDate(scheduleDateKey);
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(today.getDate() + 30);

  // チップ一覧
  const list = document.createElement("div");
  list.className = "cmd-chip-list";
  if (vehicles.length === 0) {
    list.innerHTML = `<p class="cmd-empty">車両未登録</p>`;
  } else {
    vehicles.forEach((v) => {
      const inuse  = used.has(v.name);
      const isSel  = selectedChip?.type === "vehicle" && selectedChip.value === v.name;
      let warn = "";
      if (!v.isRental && v.inspectionDate) {
        const d = new Date(v.inspectionDate);
        if (d < today) warn = "⚠期限切";
        else if (d <= soon) warn = "⚠期限近";
      }
      const chip = document.createElement("div");
      chip.className = `cmd-chip${inuse ? " inuse" : ""}${isSel ? " selected" : ""}${warn ? " insp-warn" : ""}`;
      chip.innerHTML = `<span>${escHtml(v.name)}${warn ? `<small class="warn-label"> ${warn}</small>` : ""}</span>` +
        (inuse ? `<small class="inuse-label">使用中</small>` : `<button class="cmd-chip-del" data-id="${v.id}">✕</button>`);
      if (!inuse) {
        const vChipTap = (e) => {
          if (e.target.closest(".cmd-chip-del")) return;
          selectedChip = isSel ? null : { type: "vehicle", value: v.name };
          renderCmdSidebar();
          renderScheduleModal();
        };
        chip.addEventListener("click", vChipTap);
        chip.addEventListener("touchend", (e) => {
          if (e.target.closest(".cmd-chip-del")) return;
          e.preventDefault();
          vChipTap(e);
        }, { passive: false });
        chip.querySelector(".cmd-chip-del").addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`「${v.name}」を削除しますか？`)) return;
          deleteVehicle(v.id);
          renderCmdSidebar();
        });
      }
      list.appendChild(chip);
    });
  }
  container.appendChild(list);

  if (selectedChip?.type === "vehicle") {
    const hint = document.createElement("div");
    hint.className = "cmd-hint";
    hint.textContent = `▶ 表の車両欄をタップして割り当て`;
    container.appendChild(hint);
  }

  // 車両追加フォーム
  const form = document.createElement("div");
  form.className = "cmd-vehicle-form";
  form.innerHTML = `
    <div class="cmd-form-title">車両追加</div>
    <input type="text" class="cmd-input" id="newVehicleName" placeholder="車両名 (例: 3t-01)" maxlength="20">
    <select class="cmd-select" id="newVehicleType">
      <option value="2t">2t</option><option value="3t">3t</option>
      <option value="4t">4t</option><option value="ハイエース">ハイエース</option>
      <option value="軽トラ">軽トラ</option><option value="その他">その他</option>
    </select>
    <input type="date" class="cmd-input" id="newVehicleInsp" placeholder="車検満期日">
    <label class="cmd-rental-label">
      <input type="checkbox" id="newVehicleRental"> レンタカー（車検不要）
    </label>
    <button class="cmd-add-btn" id="addVehicleBtn">追加</button>`;
  const rentalCb = form.querySelector("#newVehicleRental");
  const inspInp  = form.querySelector("#newVehicleInsp");
  rentalCb.addEventListener("change", () => {
    inspInp.disabled = rentalCb.checked;
    inspInp.style.opacity = rentalCb.checked ? "0.3" : "1";
  });
  form.querySelector("#addVehicleBtn").addEventListener("click", () => {
    const name = form.querySelector("#newVehicleName").value;
    const type = form.querySelector("#newVehicleType").value;
    if (addVehicle(name, type, inspInp.value, rentalCb.checked)) {
      form.querySelector("#newVehicleName").value = "";
      inspInp.value = ""; rentalCb.checked = false;
      inspInp.disabled = false; inspInp.style.opacity = "1";
      renderCmdSidebar();
    }
  });
  container.appendChild(form);
}

function renderHolidaysTab(container) {
  const dayHols = getHolidaysByDate(scheduleDateKey);

  // 休み一覧
  const list = document.createElement("div");
  list.className = "cmd-holiday-list";
  if (dayHols.length === 0) {
    list.innerHTML = `<p class="cmd-empty">この日の休みなし</p>`;
  } else {
    dayHols.forEach((h) => {
      const item = document.createElement("div");
      item.className = "cmd-hol-item";
      item.innerHTML = `<span class="hol-name">${escHtml(h.memberName)}</span>
        <span class="hol-type">${escHtml(h.type)}</span>
        <button class="cmd-chip-del hol-del" data-id="${h.id}">✕</button>`;
      item.querySelector(".hol-del").addEventListener("click", () => {
        deleteHoliday(h.id);
        renderCmdSidebar();
        renderScheduleModal();
      });
      list.appendChild(item);
    });
  }
  container.appendChild(list);

  // 休み追加フォーム
  const form = document.createElement("div");
  form.className = "cmd-add-form cmd-hol-form";
  const memberOpts = members.length === 0
    ? `<option value="">（メンバー未登録）</option>`
    : members.map((m) => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join("");
  form.innerHTML = `
    <div class="cmd-form-title">休み追加</div>
    <select class="cmd-select" id="holMember">${memberOpts}</select>
    <select class="cmd-select" id="holType">
      <option value="休み">休み</option><option value="有給">有給</option>
      <option value="午前休">午前休</option><option value="午後休">午後休</option>
      <option value="私用">私用</option>
    </select>
    <button class="cmd-add-btn" id="addHolBtn" ${members.length === 0 ? "disabled" : ""}>追加</button>`;
  form.querySelector("#addHolBtn").addEventListener("click", () => {
    const name = form.querySelector("#holMember").value;
    const type = form.querySelector("#holType").value;
    if (addHoliday(scheduleDateKey, name, type)) {
      renderCalendar();
    }
    renderCmdSidebar();
    renderScheduleModal();
  });
  container.appendChild(form);
}

// ── 休み登録パネル ────────────────────────────
function openHolidayRegPanel() {
  const sel = document.getElementById("holRegMember");
  if (sel) {
    sel.innerHTML = members.length === 0
      ? `<option value="">（メンバー未登録）</option>`
      : members.map((m) => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join("");
  }
  const native  = document.getElementById("holRegDate");
  const valueEl = document.getElementById("holDatePickerValue");
  if (native && !native.value) {
    const t = new Date();
    native.value = getDateKey(t.getFullYear(), t.getMonth(), t.getDate());
    if (valueEl) valueEl.textContent = `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`;
  }
  document.getElementById("holidayFormPanel").classList.remove("hidden");
}

function closeHolidayRegPanel() {
  document.getElementById("holidayFormPanel").classList.add("hidden");
}

// ══════════════════════════════════════════════
// ── ヘルプ機能 ─────────────────────────────────
// ══════════════════════════════════════════════
const HELP_DATA = [
  {
    id: "schedule", icon: "📅", title: "工程登録",
    steps: [
      "「＋ 新規物件」ボタンを押す",
      "日付・元請・工程・現場名・場所を入力",
      "「登録して追加」でカレンダーに追加",
    ],
    tips: [
      "工程の文字で自動色分け：架→グレー / 払→赤 / CAP→青 / 常用→紫",
      "カード長押し（右クリック）→ 編集 / コピー / 削除",
      "カードをドラッグして別日に移動",
    ],
  },
  {
    id: "member", icon: "👷", title: "メンバー割当",
    steps: [
      "日付セルをタップ、または「予定表」ボタンを押す",
      "右パネル「👷 メンバー」タブを開く",
      "メンバーチップをタップして選択（青枠）",
      "表のメンバー欄をタップして割当",
      "✕ボタンで割当解除",
    ],
    tips: [
      "同日・同メンバーは1現場のみ割当可能",
      "休み登録済みのメンバーはオレンジ表示で警告あり",
    ],
  },
  {
    id: "vehicle", icon: "🚚", title: "車両割当",
    steps: [
      "予定表モーダルを開く",
      "右パネル「🚛 車両」タブを開く",
      "車両チップをタップして選択",
      "表の車両欄をタップして割当",
    ],
    tips: [
      "車検期限切れ・期限近は ⚠ マークで警告",
      "レンタカーは「レンタカー」チェックで車検不要",
    ],
  },
  {
    id: "holiday", icon: "🏖", title: "休み登録",
    steps: [
      "「🟠 休み登録」ボタンを押す",
      "日付・メンバー・種別（休み / 有給 / 午前休 / 午後休 / 私用）を選択",
      "「登録する」でカレンダーにオレンジカード表示",
    ],
    tips: [
      "予定表モーダル「🟠 休み」タブからも登録可能",
      "現場に割当済みのメンバーは警告後に振り替え",
      "休み中メンバーを現場に割り当てると警告が出ます",
    ],
  },
  {
    id: "line", icon: "📱", title: "LINE共有",
    steps: [
      "予定表モーダルを開く",
      "「📱 LINE共有」ボタンを押す",
      "iPad / iPhone：共有シートからLINEを選択",
      "PC：画像が自動ダウンロード＋クリップボードにコピー",
    ],
    tips: [
      "工程・メンバー・車両・休みがすべて含まれた画像を生成",
      "テキスト形式は「LINE転送」ボタン→予定表を開いてテキストコピー",
    ],
  },
  {
    id: "pdf", icon: "📄", title: "PDF・印刷",
    steps: [
      "予定表モーダルを開く",
      "「📄 PDF保存」または「🖨 印刷」を押す",
      "A4横サイズの工程表が出力される",
    ],
    tips: [
      "休み欄も自動的に印刷に含まれます",
      "ヘッダーの「印刷」ボタンでも同じ印刷が可能",
    ],
  },
  {
    id: "files", icon: "📷", title: "図面・写真・指示書",
    steps: [
      "「＋ 新規物件」または編集フォームを開く",
      "📷 写真追加 / 📐 図面追加 / 📄 指示書追加 ボタンを押す",
      "ファイルを選択（写真は複数選択可）",
      "カードをタップ → 詳細モーダルで閲覧・拡大",
    ],
    tips: [
      "同じ元請・現場名のカードは写真・図面を共有",
      "iPhone / iPad：iCloud・LINE経由は端末に保存してから選択",
      "PC：ドラッグ＆ドロップにも対応",
    ],
  },
  {
    id: "copy", icon: "📋", title: "継続現場コピー",
    steps: [
      "コピー元カードを長押し（右クリック）",
      "「📋 コピー」を選択 → 同じ日に複製",
    ],
    note: "別日にコピーする場合\nPC：Shift を押しながらドラッグ\niPad：カードをドラッグ → 別日にドロップ（移動）\n　　　同日複製はメニューから「コピー」",
    tips: [
      "元請・工程・現場名・場所・メモがコピーされます",
      "メンバー・車両は引き継がれません",
    ],
  },
  {
    id: "faq", icon: "❓", title: "よくある質問",
    faqs: [
      { q: "カードの順番を変えたい", a: "予定表モーダル内で ▲▼ ボタン、またはドラッグで並び替え可能" },
      { q: "写真・図面が保存されない", a: "iPhone / iPad で iCloud・LINE 経由のファイルは端末に保存してから再選択してください" },
      { q: "休みがカレンダーに表示されない", a: "登録した日付が現在表示中の月と一致しているか確認してください" },
      { q: "メンバーが割り当てられない", a: "同日に休み登録またはほかの現場への割当がないか確認してください" },
      { q: "月の表示を切り替えたい", a: "◀ ▶ で月移動。「本日」ボタンで今日の月に戻ります" },
      { q: "日付セルをタップすると何が開く？", a: "その日の予定表モーダルが開きます。メンバー・車両割当もここから行えます" },
    ],
  },
];

let helpActiveId = "schedule";

function openHelpModal() {
  document.getElementById("helpModal").classList.add("show");
  _renderHelpNav();
  _renderHelpContent(helpActiveId);
}

function closeHelpModal() {
  document.getElementById("helpModal").classList.remove("show");
}

function _renderHelpNav() {
  const nav = document.getElementById("helpNav");
  if (!nav) return;
  nav.innerHTML = "";
  HELP_DATA.forEach((cat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `help-nav-btn${cat.id === helpActiveId ? " active" : ""}`;
    btn.innerHTML = `<span class="help-nav-icon">${cat.icon}</span><span class="help-nav-label">${escHtml(cat.title)}</span>`;
    btn.addEventListener("click", () => {
      helpActiveId = cat.id;
      _renderHelpNav();
      _renderHelpContent(cat.id);
    });
    nav.appendChild(btn);
  });
}

function _renderHelpContent(catId) {
  const el = document.getElementById("helpContent");
  if (!el) return;
  const cat = HELP_DATA.find((c) => c.id === catId);
  if (!cat) return;

  let html = `<div class="help-cat-head"><span>${cat.icon}</span><h3>${escHtml(cat.title)}</h3></div>`;

  if (cat.steps) {
    html += `<ol class="help-steps">`;
    cat.steps.forEach((s) => { html += `<li class="help-step-item"><span class="help-step-num"></span><span>${escHtml(s)}</span></li>`; });
    html += `</ol>`;
  }

  if (cat.note) {
    html += `<div class="help-note"><pre class="help-note-pre">${escHtml(cat.note)}</pre></div>`;
  }

  if (cat.tips?.length) {
    html += `<div class="help-section-title">💡 ポイント</div><ul class="help-tips">`;
    cat.tips.forEach((t) => { html += `<li>${escHtml(t)}</li>`; });
    html += `</ul>`;
  }

  if (cat.faqs) {
    html += `<div class="help-faq-list">`;
    cat.faqs.forEach((f) => {
      html += `<div class="help-faq-item">
        <div class="help-faq-q"><span class="help-faq-label">Q</span>${escHtml(f.q)}</div>
        <div class="help-faq-a"><span class="help-faq-label help-faq-label--a">A</span>${escHtml(f.a)}</div>
      </div>`;
    });
    html += `</div>`;
  }

  el.innerHTML = html;
}

// ── INIT ──────────────────────────────────────
function initialize() {
  setupDatePicker();
  setupHolidayDatePicker();
  renderCalendar();

  setupAttachments();

  // 休み登録パネル
  document.getElementById("toggleHolidayForm")?.addEventListener("click", openHolidayRegPanel);
  document.getElementById("holRegSubmit")?.addEventListener("click", () => {
    const date   = document.getElementById("holRegDate").value;
    const member = document.getElementById("holRegMember").value;
    const type   = document.getElementById("holRegType").value;
    const memo   = document.getElementById("holRegMemo").value;
    if (!date)   { alert("日付を選択してください。"); return; }
    if (!member) { alert("メンバーを選択してください。"); return; }
    if (addHoliday(date, member, type, memo)) {
      closeHolidayRegPanel();
      renderCalendar();
      if (document.getElementById("tomorrowModal").classList.contains("show")) {
        renderScheduleModal();
      }
    }
  });
  document.getElementById("holRegCancel")?.addEventListener("click", closeHolidayRegPanel);

  // Form panel
  document.getElementById("toggleForm").addEventListener("click", () => {
    resetEditState();
    ffReset(null);
    document.getElementById("newJobPanel").classList.toggle("hidden");
  });
  document.getElementById("cancelForm").addEventListener("click", () => {
    document.getElementById("newJobPanel").classList.add("hidden");
    resetEditState();
    resetForm();  // ffNewIds（未コミットファイル）のクリーンアップも含む
  });
  document.getElementById("jobForm").addEventListener("submit", addJobFromForm);

  // Month nav
  document.getElementById("prevMonth")?.addEventListener("click", goToPreviousMonth);
  document.getElementById("nextMonth")?.addEventListener("click", goToNextMonth);
  document.getElementById("todayBtn")?.addEventListener("click", goToToday);

  // Job modal
  document.getElementById("closeModal").addEventListener("click", closeJobModal);
  document.getElementById("jobModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("jobModal")) closeJobModal();
  });

  // Lightbox
  document.getElementById("lightboxClose")?.addEventListener("click", closeLightbox);
  document.getElementById("lightbox")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("lightbox")) closeLightbox();
  });

  // Context menu
  document.getElementById("ctxCopy").addEventListener("click", ctxCopyJob);
  document.getElementById("ctxEdit").addEventListener("click", ctxEditJob);
  document.getElementById("ctxDelete").addEventListener("click", ctxDeleteJob);
  document.addEventListener("click", (e) => {
    if (!document.getElementById("ctxMenu").contains(e.target)) hideCtxMenu();
  });
  document.addEventListener("scroll", hideCtxMenu, { passive: true });

  // Search
  document.getElementById("searchInput")?.addEventListener("input", filterJobs);

  // 予定表モーダル
  document.getElementById("tomorrowScheduleBtn")?.addEventListener("click", () => openScheduleModal());
  document.getElementById("lineShareBtn")?.addEventListener("click", () => openScheduleModal());
  document.getElementById("printBtn")?.addEventListener("click", () => openScheduleModal());
  document.getElementById("closeTomorrowModal")?.addEventListener("click", closeTomorrowModal);
  document.getElementById("tomorrowModal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("tomorrowModal")) closeTomorrowModal();
  });
  document.getElementById("scheduleDateInput")?.addEventListener("change", (e) => {
    if (!e.target.value) return;
    scheduleDateKey = e.target.value;
    selectedChip = null;
    renderScheduleModal();
  });
  document.getElementById("lineShareImgBtn")?.addEventListener("click", shareAsImage);
  document.getElementById("savePdfBtn")?.addEventListener("click", savePdf);
  document.getElementById("printTomorrowBtn")?.addEventListener("click", printSchedule);

  // 司令室タブ切り替え
  document.getElementById("cmdTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".cmd-tab");
    if (!btn) return;
    activeTabName = btn.dataset.tab;
    selectedChip  = null;
    document.querySelectorAll(".cmd-tab").forEach((t) => t.classList.toggle("active", t === btn));
    renderCmdSidebar();
    renderScheduleModal();
  });

  // ヘルプモーダル
  document.getElementById("helpBtn")?.addEventListener("click", openHelpModal);
  document.getElementById("closeHelpModal")?.addEventListener("click", closeHelpModal);
  document.getElementById("helpModal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("helpModal")) closeHelpModal();
  });
}

AUTH.showLoginIfNeeded(initialize);
