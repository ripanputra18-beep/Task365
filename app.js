"use strict";

const DB_NAME = "ke-hoach-cong-viec";
const STORE_NAME = "tasks";
const DRIVE_FILE_NAME = "ke-hoach-cong-viec-sync.json";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const MAX_SYNC_BYTES = 5 * 1024 * 1024;
const STATUS_LABELS = {todo: "Chưa làm", doing: "Đang làm", done: "Hoàn thành"};
const CONFIG = window.KE_HOACH_CONFIG || {};
const $ = selector => document.querySelector(selector);
let db;
let installPrompt;
let toastTimer;
let accessToken = "";
let signedInEmail = "";
let tokenClient;
let syncTimer;
let syncInProgress = false;
let syncQueued = false;

function today() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function isoNow() {
  return new Date().toISOString();
}

function changeTime(task) {
  // Cùng quy tắc với desktop: mọi sửa/xóa đều cập nhật updated_at.
  return Date.parse(task.updated_at || 0) || 0;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, {keyPath: "sync_id"});
      store.createIndex("due_date", "due_date", {unique: false});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function allTasks() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveTask(task) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(task);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultTask(values) {
  const now = isoNow();
  return {
    sync_id: values.sync_id || uuid(),
    title: values.title || "",
    details: values.details || "",
    due_date: values.due_date || today(),
    due_time: values.due_time || "",
    status: values.status || "todo",
    priority: 1,
    reminder_minutes: 15,
    original_date: values.due_date || today(),
    rollover_count: 0,
    sort_order: values.sort_order || 0,
    reminded_key: "",
    repeat_type: "none",
    series_id: "",
    estimated_minutes: values.estimated_minutes ?? 30,
    started_at: values.status === "doing" ? now : "",
    completed_at: values.status === "done" ? now : "",
    actual_minutes: 0,
    efficiency_percent: 0,
    created_at: values.created_at || now,
    updated_at: now,
    deleted_at: ""
  };
}

async function render() {
  const selected = $("#selectedDate").value;
  const tasks = (await allTasks())
    .filter(task => !task.deleted_at && task.due_date === selected)
    .sort((a, b) => (a.sort_order - b.sort_order) ||
      (a.due_time || "99:99").localeCompare(b.due_time || "99:99"));
  const list = $("#taskList");
  list.replaceChildren();
  for (const task of tasks) {
    const node = $("#taskTemplate").content.cloneNode(true);
    const article = node.querySelector(".task");
    article.classList.add(task.status);
    node.querySelector("h3").textContent = task.title;
    node.querySelector(".status").textContent = STATUS_LABELS[task.status];
    node.querySelector(".task-details").textContent = task.details;
    node.querySelector(".time").textContent = task.due_time ? `◷ ${task.due_time}` : "Cả ngày";
    node.querySelector(".estimate").textContent = `Dự kiến ${task.estimated_minutes || 0} phút`;
    node.querySelector(".check").addEventListener("click", () => toggleDone(task));
    node.querySelector(".edit").addEventListener("click", () => editTask(task));
    node.querySelector(".remove").addEventListener("click", () => removeTask(task));
    list.append(node);
  }
  $("#emptyState").classList.toggle("hidden", tasks.length > 0);
  $("#taskCount").textContent = `${tasks.length} việc`;
  const done = tasks.filter(task => task.status === "done").length;
  const doing = tasks.filter(task => task.status === "doing").length;
  const total = tasks.length || 1;
  $("#scoreValue").textContent = `${Math.round(done * 100 / total)}%`;
  $("#progressDone").style.width = `${done * 100 / total}%`;
  $("#progressDoing").style.width = `${doing * 100 / total}%`;
  $("#progressTodo").style.width = `${(tasks.length - done - doing) * 100 / total}%`;
  const date = new Date(`${selected}T12:00:00`);
  $("#dateCaption").textContent = selected === today() ? "Hôm nay" :
    new Intl.DateTimeFormat("vi-VN", {weekday: "long", day: "2-digit", month: "2-digit"}).format(date);
}

async function toggleDone(task) {
  const nextStatus = task.status === "done" ? "todo" : "done";
  const now = isoNow();
  await saveTask({
    ...task,
    status: nextStatus,
    completed_at: nextStatus === "done" ? now : "",
    updated_at: now
  });
  await render();
  scheduleSync();
}

function editTask(task) {
  $("#taskSyncId").value = task.sync_id;
  $("#taskTitle").value = task.title;
  $("#taskTime").value = task.due_time;
  $("#taskStatus").value = task.status;
  $("#taskDetails").value = task.details;
  $("#taskMinutes").value = task.estimated_minutes;
  $("#submitLabel").textContent = "Lưu thay đổi";
  $("#cancelEdit").classList.remove("hidden");
  $("#taskTitle").focus();
  window.scrollTo({top: 250, behavior: "smooth"});
}

function resetForm() {
  $("#taskForm").reset();
  $("#taskSyncId").value = "";
  $("#taskMinutes").value = "30";
  $("#submitLabel").textContent = "Thêm việc";
  $("#cancelEdit").classList.add("hidden");
}

async function removeTask(task) {
  if (!confirm(`Xóa “${task.title}”?`)) return;
  const now = isoNow();
  await saveTask({...task, updated_at: now, deleted_at: now});
  await render();
  scheduleSync();
  notify("Đã xóa công việc");
}

async function submitTask(event) {
  event.preventDefault();
  const id = $("#taskSyncId").value;
  const existing = id ? (await allTasks()).find(task => task.sync_id === id) : null;
  const status = $("#taskStatus").value;
  const now = isoNow();
  const values = {
    sync_id: id,
    title: $("#taskTitle").value.trim(),
    details: $("#taskDetails").value.trim(),
    due_date: $("#selectedDate").value,
    due_time: $("#taskTime").value,
    status,
    estimated_minutes: Number($("#taskMinutes").value || 0)
  };
  const task = existing ? {
    ...existing,
    ...values,
    started_at: status === "doing" && !existing.started_at ? now : existing.started_at,
    completed_at: status === "done" ? (existing.completed_at || now) : "",
    updated_at: now,
    deleted_at: ""
  } : defaultTask({...values, sort_order: (await allTasks()).length});
  await saveTask(task);
  resetForm();
  await render();
  scheduleSync();
  notify(existing ? "Đã lưu thay đổi" : "Đã thêm công việc");
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function updateAccountUI() {
  const signedIn = Boolean(accessToken);
  $("#signedOutPanel").classList.toggle("hidden", signedIn);
  $("#signedInPanel").classList.toggle("hidden", !signedIn);
  $("#syncButton").classList.toggle("hidden", !signedIn);
  $("#accountLabel").textContent = signedIn ? (signedInEmail || "Google Drive") : "Chỉ trên máy này";
  $(".account-pill .dot").classList.toggle("local", !signedIn);
  $("#signedInEmail").textContent = signedInEmail || "Tài khoản Google";
}

function clearGoogleSession() {
  accessToken = "";
  signedInEmail = "";
  updateAccountUI();
}

function googleApiError(status, body) {
  if (status === 401) {
    clearGoogleSession();
    return new Error("Phiên Google đã hết hạn. Hãy đăng nhập lại.");
  }
  const detail = body?.error?.message;
  return new Error(detail || `Google Drive trả về lỗi ${status}.`);
}

async function googleFetch(url, options = {}) {
  if (!accessToken) throw new Error("Bạn chưa đăng nhập Google.");
  const headers = {Authorization: `Bearer ${accessToken}`, ...(options.headers || {})};
  const response = await fetch(url, {...options, headers});
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw googleApiError(response.status, body);
  }
  return response;
}

function waitForGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = $("#googleIdentityScript");
    const timer = setTimeout(() => reject(new Error("Không tải được đăng nhập Google. Hãy kiểm tra mạng.")), 15000);
    const ready = () => {
      clearTimeout(timer);
      window.google?.accounts?.oauth2 ? resolve() :
        reject(new Error("Google Identity Services chưa sẵn sàng."));
    };
    script.addEventListener("load", ready, {once: true});
    script.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Không tải được đăng nhập Google. Hãy kiểm tra mạng."));
    }, {once: true});
  });
}

async function requestGoogleToken() {
  if (!CONFIG.googleClientId) {
    $("#googleConfigHelp").classList.remove("hidden");
    throw new Error("Ứng dụng chưa được cấu hình Google Client ID.");
  }
  await waitForGoogleIdentity();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.googleClientId,
        scope: `${DRIVE_SCOPE} ${EMAIL_SCOPE}`,
        callback: () => {}
      });
    }
    tokenClient.callback = response => {
      if (response.error) {
        reject(new Error(response.error_description || "Google không cấp quyền đăng nhập."));
        return;
      }
      resolve(response.access_token);
    };
    tokenClient.error_callback = error => {
      reject(new Error(error.type === "popup_closed" ?
        "Bạn đã đóng cửa sổ đăng nhập." : "Không thể mở đăng nhập Google."));
    };
    tokenClient.requestAccessToken({prompt: accessToken ? "" : "consent"});
  });
}

async function loadGoogleEmail() {
  const response = await googleFetch("https://www.googleapis.com/oauth2/v3/userinfo");
  const profile = await response.json();
  return String(profile.email || "");
}

async function signInWithGoogle() {
  const button = $("#googleLoginButton");
  button.disabled = true;
  $("#dialogMessage").textContent = "";
  try {
    accessToken = await requestGoogleToken();
    signedInEmail = await loadGoogleEmail();
    updateAccountUI();
    await sync();
    $("#dialogMessage").textContent = "Đã đăng nhập Google và đồng bộ.";
  } catch (error) {
    clearGoogleSession();
    $("#dialogMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function findDriveFile() {
  const query = encodeURIComponent(`name = '${DRIVE_FILE_NAME}' and trashed = false`);
  const fields = encodeURIComponent("files(id,name,modifiedTime,size)");
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime%20desc&pageSize=10&fields=${fields}`;
  const response = await googleFetch(url);
  const body = await response.json();
  return Array.isArray(body.files) && body.files.length ? body.files[0] : null;
}

async function downloadDriveTasks(file) {
  if (!file) return [];
  if (Number(file.size || 0) > MAX_SYNC_BYTES) {
    throw new Error("Tệp đồng bộ trên Drive lớn hơn giới hạn 5 MiB.");
  }
  const response = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`
  );
  const body = await response.json();
  if (body.schema_version !== 1 || !Array.isArray(body.tasks)) {
    throw new Error("Tệp đồng bộ Google Drive không đúng định dạng.");
  }
  return body.tasks.filter(task => task && typeof task === "object" && task.sync_id);
}

async function createDriveFile() {
  const response = await googleFetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name",
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({name: DRIVE_FILE_NAME, parents: ["appDataFolder"]})
    }
  );
  return response.json();
}

async function uploadDriveTasks(fileId, tasks) {
  const payload = JSON.stringify({
    schema_version: 1,
    updated_at: isoNow(),
    tasks
  });
  if (new Blob([payload]).size > MAX_SYNC_BYTES) {
    throw new Error("Dữ liệu đồng bộ lớn hơn giới hạn 5 MiB.");
  }
  await googleFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
    {
      method: "PATCH",
      headers: {"Content-Type": "application/json; charset=UTF-8"},
      body: payload
    }
  );
}

function mergeTasks(local, remote) {
  const merged = new Map(local.map(task => [task.sync_id, task]));
  for (const remoteTask of remote) {
    const localTask = merged.get(remoteTask.sync_id);
    // Desktop cũng giữ bản cục bộ khi hai updated_at bằng nhau.
    if (!localTask || changeTime(remoteTask) > changeTime(localTask)) {
      merged.set(remoteTask.sync_id, remoteTask);
    }
  }
  return [...merged.values()].sort((a, b) =>
    String(a.updated_at || "").localeCompare(String(b.updated_at || "")) ||
    String(a.sync_id).localeCompare(String(b.sync_id))
  );
}

function scheduleSync() {
  if (!accessToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync({silent: true}), 1200);
}

async function sync({silent = false} = {}) {
  if (!accessToken) {
    $("#accountDialog").showModal();
    return;
  }
  if (!navigator.onLine) {
    if (!silent) notify("Đang ngoại tuyến. Sẽ đồng bộ khi có mạng.");
    return;
  }
  if (syncInProgress) {
    syncQueued = true;
    return;
  }
  syncInProgress = true;
  syncQueued = false;
  $("#syncButton").disabled = true;
  try {
    let file = await findDriveFile();
    const remote = await downloadDriveTasks(file);
    const merged = mergeTasks(await allTasks(), remote);
    for (const task of merged) {
      await saveTask(task);
    }
    if (!file) file = await createDriveFile();
    // Đọc lại để không bỏ sót một sửa đổi cục bộ diễn ra trong lúc tải Drive.
    const finalTasks = mergeTasks(await allTasks(), merged);
    await uploadDriveTasks(file.id, finalTasks);
    await render();
    if (!silent) notify("Đã đồng bộ với Google Drive");
  } catch (error) {
    notify(error.message);
  } finally {
    syncInProgress = false;
    $("#syncButton").disabled = false;
    if (syncQueued && accessToken) sync({silent: true});
  }
}

function moveDate(offset) {
  const value = new Date(`${$("#selectedDate").value}T12:00:00`);
  value.setDate(value.getDate() + offset);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  $("#selectedDate").value = local.toISOString().slice(0, 10);
  render();
}

function loadConfig() {
  $("#versionLabel").textContent = CONFIG.version || "PWA Google Drive";
  if (CONFIG.updateUrl) {
    $("#updateLink").href = CONFIG.updateUrl;
    $("#updateLink").classList.remove("hidden");
    $("#noUpdateLink").classList.add("hidden");
  }
  $("#googleConfigHelp").classList.toggle("hidden", Boolean(CONFIG.googleClientId));
}

async function start() {
  db = await openDatabase();
  $("#selectedDate").value = today();
  $("#taskForm").addEventListener("submit", submitTask);
  $("#cancelEdit").addEventListener("click", resetForm);
  $("#previousDay").addEventListener("click", () => moveDate(-1));
  $("#nextDay").addEventListener("click", () => moveDate(1));
  $("#todayButton").addEventListener("click", () => {
    $("#selectedDate").value = today(); render();
  });
  $("#selectedDate").addEventListener("change", render);
  $("#accountButton").addEventListener("click", () => $("#accountDialog").showModal());
  $("#googleLoginButton").addEventListener("click", signInWithGoogle);
  $("#syncButton").addEventListener("click", sync);
  $("#logoutButton").addEventListener("click", () => {
    clearGoogleSession();
    $("#dialogMessage").textContent = "Đã đăng xuất. Dữ liệu cục bộ vẫn còn trên thiết bị.";
  });
  $("#installButton").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("#installButton").classList.add("hidden");
  });
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    $("#installButton").classList.remove("hidden");
  });
  window.addEventListener("online", scheduleSync);
  updateAccountUI();
  loadConfig();
  await render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
}

start().catch(error => notify(`Không mở được dữ liệu: ${error.message}`));
