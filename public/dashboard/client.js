const notice = document.getElementById("client-notice");
const callsBody = document.getElementById("calls-body");
const usageChart = document.getElementById("usage-chart");
const usageLabels = document.getElementById("usage-labels");
const settingsForm = document.getElementById("settings-form");
const refreshBtn = document.getElementById("refresh-client");
const logoutBtn = document.getElementById("logout-client");

function setNotice(message, kind = "") {
  notice.textContent = message || "";
  notice.className = `notice ${kind}`.trim();
}

function toDuration(seconds) {
  const total = Number(seconds || 0);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}

function toDate(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "-";
  return date.toLocaleString();
}

function monthShort(ymd) {
  if (!ymd) return "";
  const [y, m] = ymd.split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(date.valueOf())) return ymd;
  return date.toLocaleString(undefined, { month: "short" });
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

function renderCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    callsBody.innerHTML = "<tr><td colspan='5' class='muted'>No call sessions yet.</td></tr>";
    return;
  }

  callsBody.innerHTML = calls
    .map((call) => {
      const summary = Array.isArray(call.summaryLines) && call.summaryLines.length > 0 ? call.summaryLines.join(" • ") : "-";
      return `
        <tr>
          <td>${toDate(call.startedAt)}</td>
          <td>${call.callerPhone || "Unknown"}</td>
          <td>${toDuration(call.durationSeconds)}</td>
          <td>${Number(call.transcriptTurns || 0)}</td>
          <td>${summary}</td>
        </tr>
      `;
    })
    .join("");
}

function renderUsage(usage) {
  usageChart.innerHTML = "";
  usageLabels.innerHTML = "";

  if (!Array.isArray(usage) || usage.length === 0) {
    usageChart.innerHTML = "<div class='muted'>No usage data yet.</div>";
    return;
  }

  const points = [...usage].reverse();
  const maxCalls = Math.max(...points.map((item) => Number(item.totalCalls || 0)), 1);

  points.forEach((item) => {
    const calls = Number(item.totalCalls || 0);
    const height = Math.max(16, Math.round((calls / maxCalls) * 160));

    const bar = document.createElement("div");
    bar.className = "usage-bar";
    bar.style.height = `${height}px`;
    bar.title = `${item.monthStart}: ${calls} calls`;
    bar.textContent = String(calls);
    usageChart.appendChild(bar);

    const label = document.createElement("span");
    label.textContent = monthShort(item.monthStart);
    usageLabels.appendChild(label);
  });
}

function setFormValues(settings = {}) {
  const assign = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
      return;
    }
    el.value = value ?? "";
  };

  assign("businessName", settings.businessName);
  assign("greeting", settings.greeting);
  assign("transferNumber", settings.transferNumber);
  assign("smsEnabled", settings.smsEnabled);
  assign("bookingUrl", settings.bookingUrl);
  assign("ownerPhone", settings.ownerPhone);
  assign("timezone", settings.timezone);
  assign("fallbackMode", settings.fallbackMode);
  assign("intakeMode", settings.intakeMode);
}

function inputValue(id) {
  const el = document.getElementById(id);
  if (!el) return "";
  return (el.value || "").trim();
}

function maybeNull(value) {
  return value ? value : null;
}

async function loadClientDashboard() {
  setNotice("Loading dashboard...");

  const callsRes = await requestJson("/dashboard/api/calls?limit=50");
  if (callsRes.status === 401) {
    window.location.replace("/dashboard");
    return;
  }
  if (callsRes.status === 403) {
    setNotice("This account does not have client scope. Use admin view.", "error");
    return;
  }
  if (!callsRes.ok) {
    setNotice(callsRes.data?.error || "Failed to load calls.", "error");
    return;
  }

  renderCalls(callsRes.data?.calls || []);

  const usageRes = await requestJson("/dashboard/api/usage?months=6");
  if (usageRes.ok) {
    renderUsage(usageRes.data?.usage || []);
  }

  const settingsRes = await requestJson("/dashboard/api/settings");
  if (settingsRes.ok) {
    setFormValues(settingsRes.data?.settings || {});
  }

  setNotice("Dashboard ready.", "ok");
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const businessName = inputValue("businessName");
  const greeting = inputValue("greeting");

  if (!businessName || !greeting) {
    setNotice("Business name and greeting are required.", "error");
    return;
  }

  const payload = {
    businessName,
    greeting,
    transferNumber: maybeNull(inputValue("transferNumber")),
    smsEnabled: document.getElementById("smsEnabled").checked,
    bookingUrl: maybeNull(inputValue("bookingUrl")),
    ownerPhone: maybeNull(inputValue("ownerPhone")),
    timezone: maybeNull(inputValue("timezone")),
    fallbackMode: maybeNull(inputValue("fallbackMode")),
    intakeMode: maybeNull(inputValue("intakeMode"))
  };

  const saveBtn = document.getElementById("save-settings");
  saveBtn.disabled = true;
  setNotice("Saving settings...");

  try {
    const result = await requestJson("/dashboard/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    if (!result.ok) {
      setNotice(result.data?.error || "Failed to save settings.", "error");
      return;
    }

    setFormValues(result.data?.settings || payload);
    setNotice("Settings updated.", "ok");
  } catch {
    setNotice("Network error while saving settings.", "error");
  } finally {
    saveBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", () => {
  loadClientDashboard().catch(() => setNotice("Failed to refresh dashboard.", "error"));
});

logoutBtn.addEventListener("click", async () => {
  await requestJson("/dashboard/auth/logout", { method: "POST", body: JSON.stringify({}) });
  window.location.replace("/dashboard");
});

loadClientDashboard().catch(() => setNotice("Failed to load dashboard.", "error"));
