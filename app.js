import { initializeApp, deleteApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore, collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot,
  query, where, getDocs, serverTimestamp, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { firebaseConfig } from "./firebase.js";

// DOM helpers
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// --------------------
// Simple client-side password protection
// --------------------
// Set your desired plaintext password here. Keep in mind this is client-side only
// and can be bypassed by determined users. Changing this string will invalidate
// previously stored unlock tokens so visitors must re-enter the new password.
const PASSWORD = "bulbul123"; // <- change this value to set the password
const PW_STORAGE_KEY = `__site_pw_token__:${hashString(PASSWORD)}`;

function hashString(s) {
  // Small deterministic hash to tie stored token to the password string.
  // Not cryptographically secure — just used to detect password changes.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

function isUnlocked() {
  try { return localStorage.getItem(PW_STORAGE_KEY) === "1"; } catch (e) { return false; }
}

function setUnlocked(val) {
  try { if (val) localStorage.setItem(PW_STORAGE_KEY, "1"); else localStorage.removeItem(PW_STORAGE_KEY); } catch (e) {}
}

// Overlay helpers — query elements lazily (module may load before DOM nodes exist)
function getPwEl(id) {
  try { return document.getElementById(id); } catch (e) { return null; }
}

function showPwOverlay() {
  const el = getPwEl('pwOverlay');
  const inp = getPwEl('pwInput');
  if (!el) return;
  el.style.display = 'flex';
  el.setAttribute('aria-hidden', 'false');
  inp?.focus();
}

function hidePwOverlay() {
  const el = getPwEl('pwOverlay');
  if (!el) return;
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
}

function tryUnlock(entered) {
  const msg = getPwEl('pwMsg');
  if (entered === PASSWORD) {
    setUnlocked(true);
    hidePwOverlay();
    // small delay to ensure UI updates before init
    setTimeout(() => init(), 50);
    return true;
  }
  if (msg) msg.textContent = 'Incorrect password.';
  return false;
}

// State
let db = null;
let unsubscribe = null;
let coupons = [];
let filtered = [];
let viewMode = localStorage.getItem("viewMode") || (window.innerWidth < 800 ? "cards" : "table");
let connected = false;
let importingRows = [];

// Elements
const connDot = $("#connDot");
const connText = $("#connText");
const createBtn = $("#createBtn");
const emptyCreateBtn = $("#emptyCreateBtn");
const emptyImportBtn = $("#emptyImportBtn");
const toggleViewBtn = $("#toggleViewBtn");
const toggleViewText = $("#toggleViewText");
const couponCount = $("#couponCount");
const tableWrap = $("#tableWrap");
const cardsWrap = $("#cardsWrap");
const couponTbody = $("#couponTbody");
const cardsGrid = $("#cardsGrid");
const emptyState = $("#emptyState");

const couponModal = $("#couponModal");
const couponForm = $("#couponForm");
const couponModalTitle = $("#couponModalTitle");
const saveCouponBtn = $("#saveCouponBtn");
const spinner = saveCouponBtn.querySelector(".spinner");
const saveLabel = saveCouponBtn.querySelector(".label");

const codeInput = $("#code");
const typeInput = $("#type");
const valueInput = $("#value");
const scopeInput = $("#scope");
const scopeValueField = $("#scopeValueField");
const scopeValueInput = $("#scopeValue");
const minOrderAmountInput = $("#minOrderAmount");
const maxDiscountInput = $("#maxDiscount");
const isActiveInput = $("#isActive");
const expiryDateInput = $("#expiryDate");
const usageLimitInput = $("#usageLimit");
const usedCountInput = $("#usedCount");
const docIdInput = $("#docId");
const modeInput = $("#mode");
const codeError = $("#codeError");
const valueError = $("#valueError");
const minOrderAmountError = $("#minOrderAmountError");
const maxDiscountError = $("#maxDiscountError");
const isActiveError = $("#isActiveError");

const confirmModal = $("#confirmModal");
const confirmText = $("#confirmText");
const confirmDeleteBtn = $("#confirmDeleteBtn");

const importModal = $("#importModal");
const importFile = $("#importFile");
const importPreview = $("#importPreview");
const importError = $("#importError");
const confirmImportBtn = $("#confirmImportBtn");

const searchInput = $("#searchInput");
const statusFilter = $("#statusFilter");
const typeFilter = $("#typeFilter");

const toastHost = $("#toastHost");

// Initialize UI
function init() {
  bindEvents();
  setView(viewMode);
  // Auto-connect using static config
  tryConnect(firebaseConfig);
}
// Defer initialization: only call init when unlocked.
document.addEventListener("DOMContentLoaded", () => {
  const inp = getPwEl('pwInput');
  const btn = getPwEl('pwBtn');
  const msg = getPwEl('pwMsg');

  if (btn && inp) {
    btn.addEventListener('click', () => {
      msg && (msg.textContent = '');
      tryUnlock(inp.value);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { msg && (msg.textContent = ''); tryUnlock(inp.value); } });
  }

  if (isUnlocked()) {
    hidePwOverlay();
    init();
  } else {
    showPwOverlay();
  }
});

// Event bindings
function bindEvents() {
  // view toggle
  toggleViewBtn.addEventListener("click", () => {
    setView(viewMode === "table" ? "cards" : "table");
  });

  // create
  createBtn.addEventListener("click", () => openCouponModal("create"));
  $("#emptyCreateBtn")?.addEventListener("click", () => openCouponModal("create"));
  $("#emptyImportBtn")?.addEventListener("click", () => openImport());

  // filters
  searchInput.addEventListener("input", applyFilters);
  statusFilter.addEventListener("change", applyFilters);
  typeFilter.addEventListener("change", applyFilters);

  // modal controls general
  $$("[data-close-modal]").forEach(btn => btn.addEventListener("click", e => {
    const dialog = e.target.closest("dialog");
    dialog?.close();
  }));

  // form dynamics
  scopeInput.addEventListener("change", () => {
    scopeValueField.hidden = scopeInput.value === "all";
  });

  typeInput.addEventListener("change", () => validateValue());
  valueInput.addEventListener("input", () => validateValue());
  codeInput.addEventListener("input", debounce(checkCodeUnique, 350));
  [minOrderAmountInput, maxDiscountInput, usageLimitInput].forEach(el => el.addEventListener("input", validateNonNegative));
  expiryDateInput.addEventListener("change", () => validateActiveVsExpiry());

  couponForm.addEventListener("submit", onSubmitCoupon);

  // import
  $("#importBtn").addEventListener("click", openImport);
  importFile.addEventListener("change", handleImportFile);
  confirmImportBtn.addEventListener("click", confirmImport);

  // delete confirm
  confirmDeleteBtn.addEventListener("click", doDelete);

  // empty state shortcuts
  emptyCreateBtn?.addEventListener("click", () => openCouponModal("create"));
  emptyImportBtn?.addEventListener("click", openImport);
}

// View switch
function setView(mode) {
  viewMode = mode;
  localStorage.setItem("viewMode", mode);
  toggleViewText.textContent = mode === "table" ? "Cards" : "Table";
  if (mode === "table") {
    tableWrap.hidden = false;
    cardsWrap.hidden = true;
  } else {
    tableWrap.hidden = true;
    cardsWrap.hidden = false;
  }
}

// Firebase connect
async function tryConnect(cfg) {
  try {
    cleanupFirebase();
    const app = initializeApp(cfg);
    db = getFirestore(app);
    connected = true;
    setConnState(true);
    startListening();
    toast("Connected to Firebase", "success");
  } catch (err) {
    connected = false;
    setConnState(false);
    showAlert(`Failed to connect: ${err.message}`, "error");
  }
}

function cleanupFirebase() {
  const apps = getApps();
  if (apps.length) {
    // Avoid duplicate listeners
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    deleteApp(apps[0]).catch(() => {});
  }
}

function setConnState(ok) {
  if (ok) {
    connDot.classList.remove("offline");
    connDot.classList.add("online");
    connText.textContent = "Connected";
  } else {
    connDot.classList.remove("online");
    connDot.classList.add("offline");
    connText.textContent = "Connect";
  }
}

// Snapshot listener
function startListening() {
  if (!db) return;
  const col = collection(db, "coupons");
  // Order by code for stable view
  const q = query(col, orderBy("code"));
  unsubscribe = onSnapshot(q, snap => {
    coupons = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    applyFilters();
  }, err => {
    showAlert(`Realtime error: ${err.message}`, "error");
  });
}

// Filters and render
function applyFilters() {
  const queryStr = (searchInput.value || "").toLowerCase().trim();
  const status = statusFilter.value;
  const t = typeFilter.value;

  const now = new Date();
  filtered = coupons.filter(c => {
    // type
    if (t !== "all" && c.type !== t) return false;

    // status filter
    const exp = c.expiryDate ? new Date(c.expiryDate) : null;
    const isExpired = exp ? endOfDay(exp) < now : false;
    const daysLeft = exp ? daysBetween(now, exp) : Infinity;
    const isExpiringSoon = exp && !isExpired && daysLeft <= 7;

    if (status === "active" && (!c.isActive || isExpired)) return false;
    if (status === "inactive" && c.isActive) return false;
    if (status === "expired" && !isExpired) return false;
    if (status === "expiring" && !isExpiringSoon) return false;

    if (!queryStr) return true;
    const hay = [
      c.code, c.type, c.scope, c.scopeValue || "",
      String(c.value), String(c.minOrderAmount || ""), String(c.maxDiscount || "")
    ].join(" ").toLowerCase();
    return hay.includes(queryStr);
  });

  render();
}

function render() {
  couponCount.textContent = filtered.length ? `${filtered.length} shown` : "";
  if (!filtered.length) {
    couponTbody.innerHTML = "";
    cardsGrid.innerHTML = "";
    emptyState.hidden = coupons.length !== 0;
    return;
  }
  emptyState.hidden = true;
  renderTable();
  renderCards();
}

function renderTable() {
  const now = new Date();
  couponTbody.innerHTML = "";
  for (const c of filtered) {
    const exp = c.expiryDate ? new Date(c.expiryDate) : null;
    const isExpired = exp ? endOfDay(exp) < now : false;
    const daysLeft = exp ? daysBetween(now, exp) : Infinity;
    const expiringSoon = exp && !isExpired && daysLeft <= 7;

    const tr = document.createElement("tr");
    const codeCell = document.createElement("td");
    codeCell.textContent = c.code;
    if (isExpired) codeCell.classList.add("strike");

    const typeCell = tdCap(c.type);
    const valueCell = document.createElement("td");
    valueCell.textContent = c.type === "percentage" ? `${+c.value}%` : money(c.value);

    const scopeCell = document.createElement("td");
    scopeCell.textContent = c.scope === "all" ? "All" : `${cap(c.scope)}: ${c.scopeValue || "-"}`;

    const minCell = document.createElement("td");
    minCell.textContent = c.minOrderAmount ? money(c.minOrderAmount) : "-";

    const maxCell = document.createElement("td");
    maxCell.textContent = c.maxDiscount ? money(c.maxDiscount) : "-";

    const activeCell = document.createElement("td");
    const badge = document.createElement("span");
    if (isExpired) {
      badge.className = "badge red";
      badge.textContent = "Expired";
    } else if (!c.isActive) {
      badge.className = "badge red";
      badge.textContent = "Inactive";
    } else if (expiringSoon) {
      badge.className = "badge yellow";
      badge.textContent = `Expiring ${daysLeft}d`;
    } else {
      badge.className = "badge green";
      badge.textContent = "Active";
    }
    activeCell.appendChild(badge);

    const expiryCell = document.createElement("td");
    expiryCell.textContent = c.expiryDate ? fmtDate(c.expiryDate) : "—";

    const usageCell = document.createElement("td");
    usageCell.textContent = `${c.usedCount || 0}${c.usageLimit ? " / " + c.usageLimit : ""}`;

    const actCell = document.createElement("td");
    actCell.className = "row-actions";
    const editBtn = btn("Edit", () => openCouponModal("edit", c));
    const delBtn = btn("Delete", () => openDelete(c), "danger");
    actCell.append(editBtn, delBtn);

    tr.append(codeCell, typeCell, valueCell, scopeCell, minCell, maxCell, activeCell, expiryCell, usageCell, actCell);
    couponTbody.appendChild(tr);
  }
}

function renderCards() {
  const now = new Date();
  cardsGrid.innerHTML = "";
  for (const c of filtered) {
    const exp = c.expiryDate ? new Date(c.expiryDate) : null;
    const isExpired = exp ? endOfDay(exp) < now : false;
    const daysLeft = exp ? daysBetween(now, exp) : Infinity;
    const expiringSoon = exp && !isExpired && daysLeft <= 7;

    const card = document.createElement("div");
    card.className = "card";

    const top = document.createElement("div");
    const codeEl = document.createElement("div");
    codeEl.className = "code";
    codeEl.textContent = c.code;
    if (isExpired) codeEl.classList.add("strike");
    top.appendChild(codeEl);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `
      ${cap(c.type)} • ${c.type === "percentage" ? `${+c.value}%` : money(c.value)} •
      Scope: ${c.scope === "all" ? "All" : `${cap(c.scope)}: ${c.scopeValue || "-"}`} •
      Min: ${c.minOrderAmount ? money(c.minOrderAmount) : "—"} •
      Max: ${c.maxDiscount ? money(c.maxDiscount) : "—"} •
      Limit: ${c.usageLimit ?? "—"} • Used: ${c.usedCount || 0}
    `;

    const footer = document.createElement("div");
    footer.className = "footer";

    const status = document.createElement("div");
    status.className = "status";
    const dot = document.createElement("span");
    dot.className = "dot " + (isExpired ? "error" : (!c.isActive ? "error" : (expiringSoon ? "warn" : "online")));
    const label = document.createElement("span");
    label.textContent = isExpired ? "Expired" : (!c.isActive ? "Inactive" : (expiringSoon ? `Expiring ${daysLeft}d` : "Active"));
    status.append(dot, label);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const editBtn = btn("Edit", () => openCouponModal("edit", c));
    const delBtn = btn("Delete", () => openDelete(c), "danger");
    actions.append(editBtn, delBtn);

    footer.append(status, actions);

    card.append(top, meta, footer);
    cardsGrid.appendChild(card);
  }
}

// Utility
function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}
function cap(s) { return (s || "").charAt(0).toUpperCase() + (s || "").slice(1); }
function tdCap(s) { const td = document.createElement("td"); td.textContent = cap(s); return td; }
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function endOfDay(d) { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function daysBetween(a, b) {
  const diff = endOfDay(b).getTime() - a.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
function btn(text, onClick, variant) {
  const b = document.createElement("button");
  b.className = "btn" + (variant ? ` ${variant}` : "");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
function toast(msg, type = "success", timeout = 3000) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const ico = document.createElement("div");
  ico.className = "icon";
  const text = document.createElement("div");
  text.textContent = msg;
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.textContent = "✖";
  close.addEventListener("click", () => t.remove());
  if (type === "success") t.append(ico, text, close);
  else t.append(text, close);
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), timeout);
}
function showAlert(msg, severity = "error") {
  const area = $("#alertArea");
  area.innerHTML = `<div class="toast ${severity}"><div>${msg}</div><button class="icon-btn" id="dismissAlert">✖</button></div>`;
  $("#dismissAlert").addEventListener("click", () => area.innerHTML = "");
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Create/Edit modal
function openCouponModal(mode, data = null) {
  if (!connected || !db) {
    showAlert("Not connected to Firebase. Please check your network and reload.", "error");
    return;
  }
  resetFormErrors();
  couponForm.reset();
  scopeValueField.hidden = true;
  modeInput.value = mode;
  if (mode === "edit" && data) {
    couponModalTitle.textContent = `Edit Coupon · ${data.code}`;
    docIdInput.value = data.id;
    codeInput.value = data.code || "";
    typeInput.value = data.type || "percentage";
    valueInput.value = data.value ?? "";
    scopeInput.value = data.scope || "all";
    scopeValueField.hidden = scopeInput.value === "all";
    scopeValueInput.value = data.scopeValue || "";
    minOrderAmountInput.value = data.minOrderAmount ?? "";
    maxDiscountInput.value = data.maxDiscount ?? "";
    isActiveInput.checked = !!data.isActive;
    expiryDateInput.value = data.expiryDate ? data.expiryDate.slice(0,10) : "";
    usageLimitInput.value = data.usageLimit ?? "";
    usedCountInput.value = data.usedCount ?? 0;
  } else {
    couponModalTitle.textContent = "Create Coupon";
    docIdInput.value = "";
    usedCountInput.value = 0;
    isActiveInput.checked = true;
  }
  couponModal.showModal();
}

function resetFormErrors() {
  [codeError, valueError, minOrderAmountError, maxDiscountError, isActiveError].forEach(el => el.textContent = "");
}

// Validation
async function validateForm() {
  let ok = true;
  resetFormErrors();

  // code unique
  const code = codeInput.value.trim();
  if (!code) {
    codeError.textContent = "Code is required.";
    ok = false;
  } else {
    const uniqueOk = await isCodeUnique(code, docIdInput.value || null);
    if (!uniqueOk) { codeError.textContent = "This code already exists. Use a unique code."; ok = false; }
  }

  // value
  const t = typeInput.value;
  const v = parseFloat(valueInput.value);
  if (Number.isNaN(v)) {
    valueError.textContent = "Discount value is required.";
    ok = false;
  } else if (t === "percentage" && (v < 0 || v > 100)) {
    valueError.textContent = "Percentage must be between 0 and 100.";
    ok = false;
  } else if (t === "fixed" && v < 1) {
    valueError.textContent = "Fixed discount must be at least 1.";
    ok = false;
  }

  // scope
  if (scopeInput.value !== "all" && !scopeValueInput.value.trim()) {
    scopeValueField.hidden = false;
    scopeValueInput.focus();
    ok = false;
  }

  // non-negative numeric fields
  [minOrderAmountInput, maxDiscountInput, usageLimitInput].forEach(el => {
    if (el.value !== "" && parseFloat(el.value) < 0) {
      const map = { minOrderAmount: minOrderAmountError, maxDiscount: maxDiscountError, usageLimit: $("#usageLimitError") };
      map[el.id].textContent = "Value cannot be negative.";
      ok = false;
    }
  });

  // active vs expiry
  const expVal = expiryDateInput.value ? new Date(expiryDateInput.value) : null;
  if (isActiveInput.checked && expVal && endOfDay(expVal) < new Date()) {
    isActiveError.textContent = "Cannot set Active on an expired date. Adjust expiry or set Inactive.";
    ok = false;
  }

  return ok;
}

async function isCodeUnique(code, currentId) {
  if (!db) return false;
  const col = collection(db, "coupons");
  const q = query(col, where("code", "==", code));
  const snap = await getDocs(q);
  if (snap.empty) return true;
  if (snap.size === 1 && snap.docs[0].id === currentId) return true;
  return false;
}

const checkCodeUnique = async () => {
  codeError.textContent = "";
  const code = codeInput.value.trim();
  if (!code) return;
  if (!(await isCodeUnique(code, docIdInput.value || null))) {
    codeError.textContent = "This code already exists.";
  }
};

function validateValue() {
  valueError.textContent = "";
  const t = typeInput.value;
  const v = parseFloat(valueInput.value);
  if (Number.isNaN(v)) return;
  if (t === "percentage" && (v < 0 || v > 100)) {
    valueError.textContent = "Percentage must be between 0 and 100.";
  } else if (t === "fixed" && v < 1) {
    valueError.textContent = "Fixed discount must be at least 1.";
  }
}
function validateNonNegative(e) {
  const el = e.target;
  const val = parseFloat(el.value);
  const errMap = { minOrderAmount: minOrderAmountError, maxDiscount: maxDiscountError, usageLimit: $("#usageLimitError") };
  const err = errMap[el.id];
  if (!err) return;
  err.textContent = "";
  if (!Number.isNaN(val) && val < 0) err.textContent = "Value cannot be negative.";
}
function validateActiveVsExpiry() {
  isActiveError.textContent = "";
  const val = expiryDateInput.value ? new Date(expiryDateInput.value) : null;
  if (isActiveInput.checked && val && endOfDay(val) < new Date()) {
    isActiveError.textContent = "Cannot set Active on an expired date.";
  }
}

// Submit
async function onSubmitCoupon(e) {
  e.preventDefault();
  if (!db) return;
  setSaving(true);
  try {
    const ok = await validateForm();
    if (!ok) { setSaving(false); return; }

    const payload = toPayload();
    const mode = modeInput.value;
    const colRef = collection(db, "coupons");

    if (mode === "create") {
      payload.usedCount = 0; // ensure
      await addDoc(colRef, payload);
      toast("Coupon created", "success");
    } else {
      const id = docIdInput.value;
      await updateDoc(doc(db, "coupons", id), payload);
      toast("Coupon updated", "success");
    }
    couponModal.close();
  } catch (err) {
    showAlert(`Save failed: ${err.message}`, "error");
  } finally {
    setSaving(false);
  }
}

function toPayload() {
  const exp = expiryDateInput.value ? new Date(expiryDateInput.value) : null;
  return {
    code: codeInput.value.trim(),
    type: typeInput.value,
    value: valueInput.value === "" ? null : Number(valueInput.value),
    scope: scopeInput.value,
    scopeValue: scopeInput.value === "all" ? null : (scopeValueInput.value.trim() || null),
    minOrderAmount: minOrderAmountInput.value === "" ? null : Number(minOrderAmountInput.value),
    maxDiscount: maxDiscountInput.value === "" ? null : Number(maxDiscountInput.value),
    isActive: !!isActiveInput.checked,
    expiryDate: exp ? new Date(exp.getFullYear(), exp.getMonth(), exp.getDate()).toISOString() : null,
    usageLimit: usageLimitInput.value === "" ? null : Number(usageLimitInput.value),
    usedCount: usedCountInput.value === "" ? 0 : Number(usedCountInput.value),
    updatedAt: serverTimestamp()
  };
}

function setSaving(flag) {
  spinner.hidden = !flag;
  saveLabel.textContent = flag ? "Saving…" : "Save";
  saveCouponBtn.disabled = flag;
}

// Delete
let toDelete = null;
function openDelete(c) {
  toDelete = c;
  confirmText.textContent = `Are you sure you want to delete ${c.code}? This cannot be undone.`;
  confirmModal.showModal();
}
async function doDelete() {
  if (!toDelete || !db) return;
  confirmDeleteBtn.disabled = true;
  try {
    await deleteDoc(doc(db, "coupons", toDelete.id));
    toast("Coupon deleted", "success");
    confirmModal.close();
  } catch (err) {
    showAlert(`Delete failed: ${err.message}`, "error");
  } finally {
    confirmDeleteBtn.disabled = false;
    toDelete = null;
  }
}

// Import/Export
function openImport() {
  if (!connected || !db) {
    showAlert("Not connected to Firebase. Please check your network and reload.", "error");
    return;
  }
  importError.textContent = "";
  importFile.value = "";
  importPreview.innerHTML = "";
  confirmImportBtn.disabled = true;
  importModal.showModal();
}

function exportJson() {
  const data = coupons;
  downloadBlob(JSON.stringify(data, null, 2), "coupons.json", "application/json");
}
function exportCsv() {
  const headers = ["code","type","value","scope","scopeValue","minOrderAmount","maxDiscount","isActive","expiryDate","usageLimit","usedCount"];
  const rows = [ headers.join(",") ];
  for (const c of coupons) {
    const line = [
      c.code,
      c.type,
      c.value ?? "",
      c.scope,
      c.scopeValue ?? "",
      c.minOrderAmount ?? "",
      c.maxDiscount ?? "",
      c.isActive ? "true" : "false",
      c.expiryDate ?? "",
      c.usageLimit ?? "",
      c.usedCount ?? 0
    ].map(csvEscape).join(",");
    rows.push(line);
  }
  downloadBlob(rows.join("\n"), "coupons.csv", "text/csv");
}
$("#exportJsonBtn").addEventListener("click", exportJson);
$("#exportCsvBtn").addEventListener("click", exportCsv);

function csvEscape(v) {
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function handleImportFile() {
  importError.textContent = "";
  importPreview.innerHTML = "";
  confirmImportBtn.disabled = true;
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    let items = [];
    if (file.name.toLowerCase().endsWith(".json")) {
      items = parseJson(text);
    } else {
      items = parseCsv(text);
    }
    const { rows, errors } = validateImport(items);
    importingRows = rows;
    renderImportPreview(rows, errors);
    confirmImportBtn.disabled = rows.length === 0;
  } catch (err) {
    importError.textContent = `Failed to read file: ${err.message}`;
  }
}

function parseJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("JSON must be an array of coupons.");
  return data;
}
function parseCsv(text) {
  // Simple CSV parser; assumes headers in first row
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ?? "");
    out.push(obj);
  }
  return out;
}
function splitCsvLine(line) {
  const res = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { res.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  res.push(cur);
  return res.map(s => s.trim());
}

function validateImport(items) {
  const rows = [];
  const errors = [];
  for (let idx = 0; idx < items.length; idx++) {
    const raw = items[idx];
    const row = normalizeCoupon(raw);
    const errs = [];
    if (!row.code) errs.push("Missing code");
    if (!row.type || !["percentage","fixed"].includes(row.type)) errs.push("Invalid type");
    if (row.type === "percentage" && (row.value < 0 || row.value > 100)) errs.push("Percentage must be 0–100");
    if (row.type === "fixed" && (row.value ?? 0) < 1) errs.push("Fixed must be >= 1");
    ["minOrderAmount","maxDiscount","usageLimit","usedCount"].forEach(k => {
      if (row[k] != null && row[k] < 0) errs.push(`${k} negative`);
    });
    if (row.expiryDate && Number.isNaN(Date.parse(row.expiryDate))) errs.push("Invalid expiryDate");
    rows.push({ row, index: idx + 1, valid: errs.length === 0, errs });
    if (errs.length) errors.push({ index: idx + 1, errs });
  }
  return { rows, errors };
}

function normalizeCoupon(x) {
  const b = typeof x === "object" ? x : {};
  const n = (v) => v === "" || v == null ? null : Number(v);
  const b2 = {
    code: String(b.code || "").trim(),
    type: (b.type || "percentage").toLowerCase(),
    value: b.value === "" || b.value == null ? null : Number(b.value),
    scope: (b.scope || "all").toLowerCase(),
    scopeValue: b.scope === "all" ? null : (b.scopeValue ? String(b.scopeValue).trim() : null),
    minOrderAmount: n(b.minOrderAmount),
    maxDiscount: n(b.maxDiscount),
    isActive: typeof b.isActive === "boolean" ? b.isActive : String(b.isActive || "").toLowerCase() === "true",
    expiryDate: b.expiryDate ? new Date(b.expiryDate).toISOString() : null,
    usageLimit: n(b.usageLimit),
    usedCount: n(b.usedCount) ?? 0
  };
  if (b2.scope !== "category" && b2.scope !== "product") b2.scope = "all";
  return b2;
}

function renderImportPreview(rows, errors) {
  const validCount = rows.filter(r => r.valid).length;
  const invalidCount = rows.length - validCount;
  importPreview.innerHTML = `
    <div class="desc">${rows.length} rows parsed · ${validCount} valid · ${invalidCount} invalid</div>
    <div style="max-height: 220px; overflow: auto; margin-top: 8px;">
      <table class="table">
        <thead>
          <tr><th>#</th><th>Code</th><th>Type</th><th>Value</th><th>Scope</th><th>Active</th><th>Expiry</th><th>Errors</th></tr>
        </thead>
        <tbody>
          ${rows.slice(0, 50).map(r => `
            <tr>
              <td>${r.index}</td>
              <td>${r.row.code}</td>
              <td>${r.row.type}</td>
              <td>${r.row.type === "percentage" ? (r.row.value ?? "") + "%" : (r.row.value ?? "")}</td>
              <td>${r.row.scope}${r.row.scopeValue ? ":" + r.row.scopeValue : ""}</td>
              <td>${r.row.isActive ? "Yes" : "No"}</td>
              <td>${r.row.expiryDate ? fmtDate(r.row.expiryDate) : "—"}</td>
              <td>${r.valid ? "" : r.errs.join("; ")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${rows.length > 50 ? '<div class="desc">Showing first 50 rows…</div>' : ''}
  `;
}

async function confirmImport() {
  if (!db || !importingRows.length) return;
  confirmImportBtn.disabled = true;
  try {
    const mode = (document.querySelector('input[name="importMode"]:checked')?.value) || "skip";
    let added = 0, updated = 0, skipped = 0, invalid = 0;
    for (const entry of importingRows) {
      if (!entry.valid) { invalid++; continue; }
      const row = entry.row;
      const dup = await getDocs(query(collection(db, "coupons"), where("code", "==", row.code)));
      if (!dup.empty) {
        if (mode === "update") {
          const id = dup.docs[0].id;
          await updateDoc(doc(db, "coupons", id), { ...row, updatedAt: serverTimestamp() });
          updated++;
        } else {
          skipped++;
        }
      } else {
        await addDoc(collection(db, "coupons"), { ...row, updatedAt: serverTimestamp() });
        added++;
      }
    }
    toast(`Import complete · Added ${added} · Updated ${updated} · Skipped ${skipped} · Invalid ${invalid}`, "success", 5000);
    importModal.close();
  } catch (err) {
    importError.textContent = `Import failed: ${err.message}`;
  } finally {
    confirmImportBtn.disabled = false;
  }
}

// Keyboard focus trap for open dialogs (accessibility nicety)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const dlg = $$("dialog").find(d => d.open);
  if (!dlg) return;
  const focusables = $$("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])", dlg).filter(el => !el.disabled);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// Wire up header buttons once DOM ready
$("#createBtn").addEventListener("click", () => openCouponModal("create"));

// Expose export buttons are already bound above

// Helpers
window.openCouponModal = openCouponModal;

// END
