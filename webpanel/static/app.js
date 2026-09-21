const csrf = document.body.dataset.csrf;
const state = { users: [] };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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
    $("#serviceText").textContent = service.active ? "ShadowsocksR 正在运行" : "ShadowsocksR 未运行";
    $("#serviceDetail").textContent = `${service.status}${service.detail ? ` · ${service.detail}` : ""}`;
  } catch (error) { toast(error.message, true); }
}

function renderUsers() {
  const rows = $("#userRows");
  rows.innerHTML = "";
  $("#emptyUsers").classList.toggle("hidden", state.users.length > 0);
  for (const user of state.users) {
    const tr = document.createElement("tr");
    const percent = user.transfer_enable ? Math.min(100, Math.round(user.used / user.transfer_enable * 100)) : 0;
    tr.innerHTML = `<td><strong>${escapeHtml(user.user || "-")}</strong></td><td><code>${user.port}</code></td><td>${escapeHtml(user.method || "-")}<br><small>${escapeHtml(user.protocol || "-")} · ${escapeHtml(user.obfs || "-")}</small></td><td>${humanBytes(user.used)} / ${humanBytes(user.transfer_enable)}<br><small>${percent}%</small></td><td><span class="tag ${user.enable ? "ok" : "bad"}">${user.enable ? "启用" : "停用"}</span></td><td class="right"><div class="actions"><button class="action-button" data-edit="${user.port}">编辑</button><button class="action-button" data-reset="${user.port}">清流量</button><button class="action-button delete" data-delete="${user.port}">删除</button></div></td>`;
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

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14);
}

function openUser(user = null) {
  $("#modalTitle").textContent = user ? "编辑用户" : "新增用户";
  $("#originalPort").value = user?.port || "";
  $("#userName").value = user?.user || "";
  $("#userPort").value = user?.port || Math.floor(10000 + Math.random() * 50000);
  $("#userPassword").value = user?.passwd || randomPassword();
  $("#userMethod").value = user?.method || "aes-128-ctr";
  $("#userProtocol").value = user?.protocol || "auth_aes128_md5";
  $("#userObfs").value = user?.obfs || "tls1.2_ticket_auth_compatible";
  $("#userTransfer").value = user?.transfer_gb ?? 100;
  $("#userEnabled").checked = user ? Boolean(user.enable) : true;
  $("#formError").classList.add("hidden");
  $("#modal").classList.remove("hidden");
}

function closeModal() { $("#modal").classList.add("hidden"); }

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

$$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => {
  $$('.nav-item[data-view]').forEach(item => item.classList.remove('active')); button.classList.add('active');
  $$('.view').forEach(view => view.classList.remove('active')); $(`#${button.dataset.view}View`).classList.add('active');
  $("#pageTitle").textContent = { dashboard: "系统状态", users: "用户列表", logs: "运行日志" }[button.dataset.view];
  if (button.dataset.view === "users") loadUsers(); if (button.dataset.view === "logs") loadLogs();
  $(".sidebar").classList.remove("open");
}));

$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#addUserButton").addEventListener("click", () => openUser());
$("#randomPassword").addEventListener("click", () => $("#userPassword").value = randomPassword());
$("#userForm").addEventListener("submit", saveUser);
$$('[data-close-modal]').forEach(item => item.addEventListener('click', closeModal));
$("#refreshLogs").addEventListener("click", loadLogs);
$$('.service-action').forEach(button => button.addEventListener('click', async () => {
  if (button.dataset.action === "stop" && !confirm("确定停止 ShadowsocksR 服务吗？")) return;
  button.disabled = true;
  try { await api(`/api/service/${button.dataset.action}`, { method: "POST", body: "{}" }); toast("服务命令已执行"); setTimeout(loadStatus, 700); }
  catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}));

$("#userRows").addEventListener("click", async event => {
  const edit = event.target.closest("[data-edit]"); const reset = event.target.closest("[data-reset]"); const remove = event.target.closest("[data-delete]");
  if (edit) openUser(state.users.find(user => user.port === Number(edit.dataset.edit)));
  if (reset && confirm("确定清零该用户的上传和下载流量吗？")) { try { await api(`/api/users/${reset.dataset.reset}/reset-traffic`, { method: "POST", body: "{}" }); await Promise.all([loadUsers(), loadStatus()]); toast("流量已清零"); } catch (error) { toast(error.message, true); } }
  if (remove && confirm("确定删除该用户吗？此操作无法撤销。")) { try { await api(`/api/users/${remove.dataset.delete}`, { method: "DELETE", body: "{}" }); await Promise.all([loadUsers(), loadStatus()]); toast("用户已删除"); } catch (error) { toast(error.message, true); } }
});

loadStatus(); setInterval(loadStatus, 15000);

