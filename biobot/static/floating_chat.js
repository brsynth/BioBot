/* The conversation floats inside the deck; the landing page keeps its composer. */
(() => {
  const panel = document.getElementById("chat-panel");
  const home = panel.parentElement;
  const frame = document.querySelector(".deck-workspace");
  const handle = document.getElementById("chat-drag-handle");
  const toggle = document.getElementById("chat-collapse-btn");
  let position = null, collapsed = false, drag = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem("biobot-floating-chat") || "null");
    if (saved?.alignment === "deck-center" && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position = {x:saved.x, y:saved.y};
  } catch (_) {}
  // Each chat keeps its own open/collapsed state (remembered in this browser).
  const chatKey = () => (typeof currentChatId !== "undefined" && currentChatId) || "";
  function collapsedChats() {
    try { return JSON.parse(localStorage.getItem("biobot-chat-collapsed") || "{}"); } catch (_) { return {}; }
  }
  function remember() {
    try {sessionStorage.setItem("biobot-floating-chat", JSON.stringify({...position, alignment:"deck-center"}));} catch (_) {}
    const chats = collapsedChats();
    if (collapsed) chats[chatKey()] = true; else delete chats[chatKey()];
    try {localStorage.setItem("biobot-chat-collapsed", JSON.stringify(chats));} catch (_) {}
  }
  function place(x, y) {
    const bounds = frame.getBoundingClientRect(), size = panel.getBoundingClientRect();
    position = {x:Math.max(8, Math.min(x, Math.max(8, bounds.width - size.width - 8))),
                y:Math.max(8, Math.min(y, Math.max(8, bounds.height - size.height - 8)))};
    Object.assign(panel.style, {left:`${position.x}px`, top:`${position.y}px`, right:"auto", bottom:"auto", transform:"none"});
  }
  function fit() {
    if (!panel.classList.contains("floating-chat")) return;
    if (position) place(position.x, position.y);
  }
  function collapse(value) {
    collapsed = value;
    panel.classList.toggle("chat-collapsed", value);
    // Collapsed, the card is as wide as the code bar under it (Generate code and its icons).
    const bar = document.getElementById("code-actions");
    panel.style.width = value && bar ? `${Math.max(bar.scrollWidth, 160)}px` : "";
    toggle.setAttribute("aria-expanded", String(!value));
    toggle.setAttribute("aria-label", value ? "Expand chat" : "Collapse chat");
    requestAnimationFrame(fit);
    remember();
  }
  toggle.addEventListener("click", () => collapse(!collapsed));
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const box = panel.getBoundingClientRect(), bounds = frame.getBoundingClientRect();
    drag = {x:event.clientX, y:event.clientY, left:box.left - bounds.left, top:box.top - bounds.top};
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (drag) place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  });
  for (const name of ["pointerup", "pointercancel"]) handle.addEventListener(name, () => {drag = null; remember();});
  handle.addEventListener("keydown", event => {
    const direction = {ArrowLeft:[-16,0], ArrowRight:[16,0], ArrowUp:[0,-16], ArrowDown:[0,16]}[event.key];
    if (!direction) return;
    event.preventDefault();
    const box = panel.getBoundingClientRect(), bounds = frame.getBoundingClientRect();
    place(box.left - bounds.left + direction[0], box.top - bounds.top + direction[1]); remember();
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(frame);
  window.floatingChat = {
    attach() {
      if (window.workspace?.readOnly) return;
      if (panel.parentElement !== frame) frame.appendChild(panel);
      panel.classList.add("floating-chat"); document.body.classList.add("floating-chat-workspace");
      collapse(!!collapsedChats()[chatKey()]);
      requestAnimationFrame(fit);
    },
    detach() {
      drag = null;
      if (panel.parentElement !== home) home.appendChild(panel);
      panel.classList.remove("floating-chat", "chat-collapsed"); document.body.classList.remove("floating-chat-workspace");
      for (const key of ["left", "top", "right", "bottom", "transform"]) panel.style[key] = "";
    },
  };
})();
