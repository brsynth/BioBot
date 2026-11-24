// Shared account controls for User and Admin workspaces.
function syncAccountAccess(data) {
  for (const id of ["admin-btn", "admin-workspace-link"]) {
    const link = document.getElementById(id);
    if (link) link.hidden = data.is_admin !== true;
  }
  const access = document.getElementById("profile-admin-access");
  if (!access) return;
  const text = document.createElement(data.is_admin ? "a" : "p");
  text.className = "admin-status";
  if (data.is_admin) {
    text.href = "/admin"; text.textContent = "Administrator access approved · Open Administration ↗";
    access.replaceChildren(text);
  } else if (data.admin_status === "requested") {
    text.textContent = "Admin access requested — awaiting approval."; access.replaceChildren(text);
  } else {
    const button = document.createElement("button"); button.type = "button"; button.className = "btn";
    button.textContent = "Request admin access";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("/admin/request", {method:"POST"});
        if (!response.ok) throw new Error("Could not request administrator access.");
        syncAccountAccess({is_admin:false,admin_status:"requested"});
      } catch (error) {button.disabled=false;alert(error.message);}
    }); access.replaceChildren(button);
  }
}

// --- Account controls ---
(() => {
document.getElementById("logout-btn").addEventListener("click", () => {
  try { sessionStorage.removeItem("biobot-questionnaire-answers"); } catch (_) {}
  window.location.href = "/logout";
});

  const accountMenu = document.getElementById("account-menu");
  document.addEventListener?.("click", event => {
    if (accountMenu && (!accountMenu.contains(event.target) || event.target.closest("#settings-btn, #logout-btn, #admin-btn"))) accountMenu.open = false;
  });
  document.addEventListener?.("keydown", event => {
    if (event.key === "Escape" && accountMenu) accountMenu.open = false;
  });
  // --- Settings Modal ---
  const settingsBtn = document.getElementById("settings-btn");
  const modal = document.getElementById("settings-modal");

  const firstNameInput = document.getElementById("profile-first-name");
  const lastNameInput = document.getElementById("profile-last-name");
  const emailInput = document.getElementById("profile-email");
  const apiKeyInput = document.getElementById("api_key");
  const countryInput = document.getElementById("profile-country");
  const editBtn = document.getElementById("edit-profile");
  const saveBtn = document.getElementById("save-profile");
  const closeBtn = document.getElementById("close-profile");
  const notificationModal = document.getElementById("notification-modal");
  const notificationText = document.getElementById("notification-text");
  const notificationOkBtn = document.getElementById("notification-ok-btn");

  function showNotification(message) {
    notificationText.textContent = message;
    notificationModal.classList.remove("hidden");
  }

  notificationOkBtn.addEventListener("click", () => {
    notificationModal.classList.add("hidden");
  });

  settingsBtn.addEventListener("click", async () => {
    modal.classList.remove("hidden");

    try {
      const res = await fetch("/user/profile", {cache:"no-store"});
      if (!res.ok) throw new Error("Error loading profile");

      const data = await res.json();
      syncAccountAccess(data);
      firstNameInput.value = data.first_name;
      lastNameInput.value = data.last_name;
      emailInput.value = data.email;
      apiKeyInput.value = data.api_key || "";
      countryInput.value = data.country;

      [firstNameInput, lastNameInput, emailInput, countryInput, apiKeyInput].forEach(i => i.disabled = true);
      saveBtn.classList.add("hidden");
      editBtn.classList.remove("hidden");
    } catch (err) {
      alert(err.message);
    }
  });

  editBtn.addEventListener("click", () => {
    [firstNameInput, lastNameInput, emailInput, countryInput, apiKeyInput].forEach(i => i.disabled = false);
    editBtn.classList.add("hidden");
    saveBtn.classList.remove("hidden");
  });

  saveBtn.addEventListener("click", async () => {
    const payload = {
      first_name: firstNameInput.value,
      last_name: lastNameInput.value,
      email: emailInput.value,
      country: countryInput.value,
      api_key: apiKeyInput.value || ""
    };
    localStorage.setItem("userApiKey", payload.api_key);

    try {
      const res = await fetch("/user/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");

      showNotification("Your profile has been updated!");
      modal.classList.add("hidden");
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("change-password-btn").addEventListener("click", async () => {
    const fields = ["current-password", "new-password", "confirm-password"].map(id => document.getElementById(id));
    const [current, next, confirm] = fields.map(f => f.value);
    if (next !== confirm) return alert("New passwords do not match.");
    try {
      const res = await fetch("/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Password change failed");
      fields.forEach(f => f.value = "");
      showNotification("Your password has been changed.");
    } catch (err) {
      alert(err.message);
    }
  });

  closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
})();
