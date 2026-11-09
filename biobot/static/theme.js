// Apply before styles load to avoid flashing the wrong appearance.
(() => {
  const key = "biobot-appearance";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const defaultMode = document.currentScript?.dataset.defaultAppearance || "auto";
  const valid = value => ["daylight", "dark", "auto"].includes(value) ? value : defaultMode;
  let mode = defaultMode;
  try { mode = valid(localStorage.getItem(key)); } catch (_) {}

  function apply() {
    document.documentElement.dataset.theme = mode === "auto" ? (system.matches ? "dark" : "daylight") : mode;
    for (const input of document.querySelectorAll('input[name="appearance"]')) input.checked = input.value === mode;
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) { mode = valid(event.newValue); apply(); }
  });
  document.addEventListener("DOMContentLoaded", () => {
    for (const input of document.querySelectorAll('input[name="appearance"]')) {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        mode = valid(input.value);
        try { localStorage.setItem(key, mode); } catch (_) {}
        apply();
      });
    }
    apply();
  });
})();
