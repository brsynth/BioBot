// Apply before styles load to avoid flashing the wrong appearance.
(() => {
  const key = "biobot-appearance";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = value => ["daylight", "dark", "auto"].includes(value) ? value : "auto";
  let mode = "auto";
  try { mode = valid(localStorage.getItem(key)); } catch (_) {}

  function apply() {
    document.documentElement.dataset.theme = mode === "auto" ? (system.matches ? "dark" : "daylight") : mode;
    const select = document.getElementById("appearance-select");
    if (select) select.value = mode;
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) { mode = valid(event.newValue); apply(); }
  });
  document.addEventListener("DOMContentLoaded", () => {
    const select = document.getElementById("appearance-select");
    if (!select) return;
    select.value = mode;
    select.addEventListener("change", () => {
      mode = valid(select.value);
      try { localStorage.setItem(key, mode); } catch (_) {}
      apply();
    });
  });
})();
