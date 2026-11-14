const stateEl = document.querySelector("#state");
const statusEl = document.querySelector("#status");

function render(status) {
  const state = status?.state ?? "unknown";
  stateEl.textContent = state;
  stateEl.className = state === "connected" ? "connected" : state === "error" ? "error" : "";
  statusEl.textContent = JSON.stringify(status, null, 2);
}

browser.runtime
  .sendMessage({ type: "GET_BRIDGE_STATUS" })
  .then(render)
  .catch((error) => render({ state: "error", message: error.message }));

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "BRIDGE_STATUS") {
    render(message.status);
  }
});

// Whether agents may take the user's focus: raise Firefox, switch the tab they
// are viewing, open a tab in front. Only this panel writes it, into the
// extension's own localStorage, which agent code can't reach (focus-gate.js).
const focusEl = document.querySelector("#allow-focus");

focusEl.checked = localStorage.getItem("allowWindowFocus") === "true";

focusEl.addEventListener("change", () => {
  localStorage.setItem("allowWindowFocus", String(focusEl.checked));
});
