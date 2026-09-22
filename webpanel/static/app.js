const csrf = document.body.dataset.csrf;
const state = { users: [], pendingDeletePort: null };
const $ = (selector) => document.querySelector(selector);
const selectAll = (selector) => [...document.querySelectorAll(selector)];

function humanBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);
  return `${(Number(bytes) / 1024 ** index).toFixed(index > 2 ? 2 : 1)} ${units[index]}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast${error ? " error" : ""}`;
  setTimeout(() => node.classList.add("hidden"), 2600);
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function loadStatus() {
  try {
    const data = await api("/api/status");
    const { metrics, service, totals } = data;
    $("#loadMetric").textContent = metrics.load.join(" / ");
    const memoryPercent = metrics.memory_total ? Math.round(metrics.memory_used / metrics.memory_total * 100) : 0;
    $("#memoryMetric").textContent = `${memoryPercent}%`;
    $("#memoryDetail").textContent = `${humanBytes(metrics.memory_used)} / ${humanBytes(metrics.memory_total)}`;
    const diskPercent = metrics.disk_total ? Math.round(metrics.disk_used / metrics.disk_total * 100) : 0;
    $("#diskMetric").textContent = `${diskPercent}%`;
    $("#diskDetail").textContent = `${humanBytes(metrics.disk_used)} / ${humanBytes(metrics.disk_total)}`;
    $("#userMetric").textContent = totals.users;
    $("#uploadTotal").textContent = humanBytes(totals.upload);
    $("#downloadTotal").textContent = humanBytes(totals.download);
    $("#servicePill").textContent = service.active ? "运行中" : service.status;
    $("#servicePill").className = `pill ${service.active ? "ok" : "bad"}`;
    $("#statusDot").className = `status-dot ${service.active ? "ok" : "bad"}`;
    $("#serviceText").textContent = service.active ? "后台服务正在运行" : "后台服务未运行";
    $("#serviceDetail").textContent = `${service.status}${service.detail ? ` · ${service.detail}` : ""}`;
  } catch (error) { toast(error.message, true); }
}

function renderUsers() {
  const rows = $("#userRows");
  rows.innerHTML = "";
  const keyword = $("#userSearch").value.trim().toLocaleLowerCase();
  const visibleUsers = state.users.filter(user => String(user.user || "").toLocaleLowerCase().includes(keyword));
  $("#userTotalBadge").textContent = keyword
    ? `找到 ${visibleUsers.length} / 共 ${state.users.length} 位`
    : `共 ${state.users.length} 位用户`;
  $("#emptyUsers").textContent = keyword ? "没有找到匹配的客户备注。" : "暂无用户，点击“新增用户”开始。";
  $("#emptyUsers").classList.toggle("hidden", visibleUsers.length > 0);
  for (const user of visibleUsers) {
    const tr = document.createElement("tr");
    const percent = user.transfer_enable ? Math.min(100, Math.round(user.used / user.transfer_enable * 100)) : 0;
    tr.innerHTML = `<td><strong>${escapeHtml(user.user || "-")}</strong></td><td><code>${user.port}</code></td><td>${escapeHtml(user.method || "-")}<br><small>${escapeHtml(user.protocol || "-")} · ${escapeHtml(user.obfs || "-")}</small></td><td>${humanBytes(user.used)} / ${humanBytes(user.transfer_enable)}<br><small>${percent}%</small></td><td><label class="table-toggle" title="${user.enable ? "点击关闭" : "点击启用"}"><input type="checkbox" data-toggle="${user.port}" ${user.enable ? "checked" : ""}><span class="toggle"></span><em>${user.enable ? "启用" : "关闭"}</em></label></td><td class="right"><div class="actions"><button class="action-button" data-copy="${user.port}">复制链接</button><button class="action-button" data-edit="${user.port}">编辑</button><button class="action-button" data-reset="${user.port}">清流量</button><button class="action-button delete" data-delete="${user.port}">删除</button></div></td>`;
    rows.appendChild(tr);
  }
}

function escapeHtml(value) {
  const div = document.createElement("div"); div.textContent = String(value); return div.innerHTML;
}

async function loadUsers() {
  try { state.users = (await api("/api/users")).users; renderUsers(); }
  catch (error) { toast(error.message, true); }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function verifyUserDeleted(port) {
  let lastError = null;
  for (const delay of [0, 500, 1200]) {
    if (delay) await wait(delay);
    try {
      state.users = (await api("/api/users")).users;
      renderUsers();
      return !state.users.some(user => Number(user.port) === Number(port));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法确认删除结果，请刷新页面后查看");
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14);
}

function setSelectValue(selector, value) {
  const select = $(selector);
  if (![...select.options].some(option => option.value === value)) {
    const option = new Option(`${value}（现有配置）`, value);
    option.dataset.legacy = "1";
    select.add(option);
  }
  select.value = value;
}

function openUser(user = null) {
  if (!user) selectAll('option[data-legacy="1"]').forEach(option => option.remove());
  $("#modalTitle").textContent = user ? "编辑用户" : "新增用户";
  $("#originalPort").value = user?.port || "";
  $("#userName").value = user?.user || "";
  $("#userPort").value = user?.port || Math.floor(10000 + Math.random() * 50000);
  $("#userPassword").value = user?.passwd || randomPassword();
  setSelectValue("#userMethod", user?.method || "none");
  setSelectValue("#userProtocol", user?.protocol || "auth_chain_a");
  setSelectValue("#userObfs", user?.obfs || "plain");
  $("#userTransfer").value = user?.transfer_gb ?? 50;
  $("#userEnabled").checked = user ? Boolean(user.enable) : true;
  $("#formError").classList.add("hidden");
  $("#modal").classList.remove("hidden");
}

function closeModal() { $("#modal").classList.add("hidden"); }

function openDeleteConfirm(port) {
  const user = state.users.find(item => Number(item.port) === Number(port));
  state.pendingDeletePort = Number(port);
  $("#deleteConfirmText").textContent = user
    ? `确定删除“${user.user || "未命名用户"}”（端口 ${port}）吗？删除后无法恢复。`
    : `确定删除端口 ${port} 的用户吗？删除后无法恢复。`;
  $("#deleteConfirmModal").classList.remove("hidden");
}

function closeDeleteConfirm() {
  if ($("#confirmDeleteButton").disabled) return;
  state.pendingDeletePort = null;
  $("#deleteConfirmModal").classList.add("hidden");
}

async function deleteConfirmedUser() {
  const port = state.pendingDeletePort;
  if (!port) return;
  const button = $("#confirmDeleteButton");
  let deleteError = null;
  button.disabled = true;
  button.textContent = "正在删除…";
  try {
    await api(`/api/users/${port}`, { method: "DELETE", body: "{}" });
  } catch (error) {
    deleteError = error;
  }
  try {
    const deleted = await verifyUserDeleted(port);
    if (!deleted) throw deleteError || new Error("删除未生效，请重试");
    state.pendingDeletePort = null;
    $("#deleteConfirmModal").classList.add("hidden");
    loadStatus();
    toast("用户已删除");
  } catch (error) {
    toast((deleteError || error).message, true);
  } finally {
    button.disabled = false;
    button.textContent = "确认删除";
  }
}

async function saveUser(event) {
  event.preventDefault();
  const originalPort = $("#originalPort").value;
  const payload = { user: $("#userName").value, port: Number($("#userPort").value), passwd: $("#userPassword").value, method: $("#userMethod").value, protocol: $("#userProtocol").value, obfs: $("#userObfs").value, transfer_gb: Number($("#userTransfer").value), enable: $("#userEnabled").checked };
  try {
    await api(originalPort ? `/api/users/${originalPort}` : "/api/users", { method: originalPort ? "PUT" : "POST", body: JSON.stringify(payload) });
    closeModal(); await Promise.all([loadUsers(), loadStatus()]); toast("用户已保存");
  } catch (error) { $("#formError").textContent = error.message; $("#formError").classList.remove("hidden"); }
}

async function loadLogs() {
  $("#logOutput").textContent = "正在加载日志…";
  try { $("#logOutput").textContent = (await api("/api/logs")).logs || "暂无日志"; }
  catch (error) { $("#logOutput").textContent = error.message; }
}

selectAll('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => {
  selectAll('.nav-item[data-view]').forEach(item => item.classList.remove('active')); button.classList.add('active');
  selectAll('.view').forEach(view => view.classList.remove('active')); $(`#${button.dataset.view}View`).classList.add('active');
  $("#pageTitle").textContent = { dashboard: "系统状态", users: "用户列表", logs: "运行日志" }[button.dataset.view];
  if (button.dataset.view === "users") loadUsers(); if (button.dataset.view === "logs") loadLogs();
  $(".sidebar").classList.remove("open");
}));

$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#addUserButton").addEventListener("click", () => openUser());
$("#userSearch").addEventListener("input", renderUsers);
$("#randomPassword").addEventListener("click", () => $("#userPassword").value = randomPassword());
$("#userForm").addEventListener("submit", saveUser);
document.querySelectorAll('[data-close-modal]').forEach(item => item.addEventListener('click', closeModal));
document.querySelectorAll('[data-cancel-delete]').forEach(item => item.addEventListener('click', closeDeleteConfirm));
$("#confirmDeleteButton").addEventListener("click", deleteConfirmedUser);
$("#refreshLogs").addEventListener("click", loadLogs);
selectAll('.service-action').forEach(button => button.addEventListener('click', async () => {
  if (button.dataset.action === "stop" && !confirm("确定停止 ShadowsocksR 服务吗？")) return;
  button.disabled = true;
  try { await api(`/api/service/${button.dataset.action}`, { method: "POST", body: "{}" }); toast("服务命令已执行"); setTimeout(loadStatus, 700); }
  catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}));

$("#userRows").addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit]"); const reset = event.target.closest("[data-reset]"); const remove = event.target.closest("[data-delete]"); const copy = event.target.closest("[data-copy]");
  if (copy) {
    const user = state.users.find(item => item.port === Number(copy.dataset.copy));
    try {
      const copied = await copyText(user.ssr_link);
      if (!copied) throw new Error("copy failed");
      toast("链接已复制");
    } catch (_) { toast("复制失败，请检查浏览器剪贴板权限", true); }
  }
  if (edit) openUser(state.users.find(user => user.port === Number(edit.dataset.edit)));
  if (reset && confirm("确定清零该用户的上传和下载流量吗？")) { try { await api(`/api/users/${reset.dataset.reset}/reset-traffic`, { method: "POST", body: "{}" }); await Promise.all([loadUsers(), loadStatus()]); toast("流量已清零"); } catch (error) { toast(error.message, true); } }
  if (remove) openDeleteConfirm(remove.dataset.delete);
});

$("#userRows").addEventListener("change", async event => {
  const toggle = event.target.closest("[data-toggle]");
  if (!toggle) return;
  toggle.disabled = true;
  try {
    await api(`/api/users/${toggle.dataset.toggle}/toggle`, { method: "POST", body: JSON.stringify({ enable: toggle.checked }) });
    await Promise.all([loadUsers(), loadStatus()]);
    toast(toggle.checked ? "用户已启用" : "用户已关闭");
  } catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; toast(error.message, true); }
});

loadStatus(); setInterval(loadStatus, 15000);
