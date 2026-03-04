const form = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const submitBtn = document.getElementById("submit-btn");
const notice = document.getElementById("login-notice");

function setNotice(message, kind = "") {
  notice.textContent = message || "";
  notice.className = `notice ${kind}`.trim();
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

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  return { ok: response.ok, status: response.status, data };
}

async function redirectIfAuthenticated() {
  try {
    const adminProbe = await requestJson("/dashboard/api/admin/clients?limit=1");
    if (adminProbe.ok) {
      window.location.replace("/dashboard/admin.html");
      return;
    }

    if (adminProbe.status === 401) {
      return;
    }

    const clientProbe = await requestJson("/dashboard/api/calls?limit=1");
    if (clientProbe.ok) {
      window.location.replace("/dashboard/client.html");
    }
  } catch {
    // stay on login view
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = (emailInput.value || "").trim().toLowerCase();

  if (!email) {
    setNotice("Email is required.", "error");
    return;
  }

  submitBtn.disabled = true;
  setNotice("Sending secure sign-in link...");

  try {
    const result = await requestJson("/dashboard/auth/request-link", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    if (!result.ok) {
      const message = result.data?.error || "Could not send magic link.";
      setNotice(message, "error");
      return;
    }

    if (result.data?.verify_url) {
      window.location.href = result.data.verify_url;
      return;
    }

    setNotice("Magic link sent. Check your inbox.", "ok");
  } catch {
    setNotice("Network error. Please try again.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

redirectIfAuthenticated();
