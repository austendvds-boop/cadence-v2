const notice = document.getElementById("admin-notice");
const clientsBody = document.getElementById("clients-body");
const statusFilter = document.getElementById("status-filter");
const exportBtn = document.getElementById("export-csv");
const refreshBtn = document.getElementById("refresh-admin");
const logoutBtn = document.getElementById("logout-admin");

function setNotice(message, kind = "") {
  notice.textContent = message || "";
  notice.className = `notice ${kind}`.trim();
}

function fmtDate(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "-";
  return date.toLocaleString();
}

function monthMinutes(totalSeconds) {
  const min = Math.round(Number(totalSeconds || 0) / 60);
  return Number.isFinite(min) ? min : 0;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  return { ok: response.ok, status: response.status, data };
}

function renderClients(clients) {
  if (!Array.isArray(clients) || clients.length === 0) {
    clientsBody.innerHTML = "<tr><td colspan='8' class='muted'>No clients found.</td></tr>";
    return;
  }

  clientsBody.innerHTML = clients
    .map((client) => {
      const owner = [client.ownerName, client.ownerEmail].filter(Boolean).join(" · ") || "-";
      const status = client.active ? "active" : "inactive";
      const plan = client.plan || "unknown";
      return `
        <tr>
          <td>
            <div><strong>${client.businessName || "Unnamed"}</strong></div>
            <div class='muted'>${client.phoneNumber || "-"}</div>
          </td>
          <td><span class='badge ${status}'>${status}</span></td>
          <td><span class='badge plan'>${plan}</span></td>
          <td>${owner}</td>
          <td>${Number(client.totalCalls || 0)}</td>
          <td>${Number(client.currentMonthCalls || 0)}</td>
          <td>${monthMinutes(client.currentMonthDurationSeconds)}</td>
          <td>${fmtDate(client.lastCallAt)}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadClients() {
  const status = encodeURIComponent(statusFilter.value || "all");
  setNotice("Loading clients...");

  const result = await requestJson(`/dashboard/api/admin/clients?status=${status}&limit=200`);

  if (result.status === 401) {
    window.location.replace("/dashboard");
    return;
  }

  if (result.status === 403) {
    window.location.replace("/dashboard/client.html");
    return;
  }

  if (!result.ok) {
    setNotice(result.data?.error || "Failed to load clients.", "error");
    return;
  }

  renderClients(result.data?.clients || []);
  setNotice(`Loaded ${result.data?.clients?.length || 0} clients.`, "ok");
}

statusFilter.addEventListener("change", () => {
  loadClients().catch(() => setNotice("Failed to refresh client list.", "error"));
});

refreshBtn.addEventListener("click", () => {
  loadClients().catch(() => setNotice("Failed to refresh client list.", "error"));
});

exportBtn.addEventListener("click", () => {
  window.open("/dashboard/api/admin/export", "_blank", "noopener");
});

logoutBtn.addEventListener("click", async () => {
  await requestJson("/dashboard/auth/logout", { method: "POST", body: JSON.stringify({}) });
  window.location.replace("/dashboard");
});

loadClients().catch(() => setNotice("Failed to load admin dashboard.", "error"));
