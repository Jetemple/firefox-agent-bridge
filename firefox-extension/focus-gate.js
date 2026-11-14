// Taking the user's focus (raising the Firefox window, or switching the tab
// they are viewing) is the user's call, not the agent's. It needs a setting
// only the extension panel writes. Off unless set, and off when it can't be read.
//
// The setting lives in the extension page's own localStorage, not in
// browser.storage: javascript_tool runs agent code as a content script, and a
// content script can write browser.storage.local but only ever sees the web
// page's localStorage, never the extension's.
{
  const FF = (globalThis.FFBridge ??= {});

  FF.windowFocusAllowed = async function windowFocusAllowed() {
    try {
      return localStorage.getItem("allowWindowFocus") === "true";
    } catch {
      return false;
    }
  };
}
