// Firefox containers (contextual identities): get_containers lists them, and
// open_tab / get_tabs_summary use the helpers here to open a tab in one and to
// name the container a tab lives in.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  const DEFAULT_STORE = "firefox-default";

  // Every container, or [] when the API is missing or containers are turned off
  // (contextualIdentities.query rejects when privacy.userContext.enabled is false).
  async function queryContainers() {
    try {
      return (await browser.contextualIdentities?.query({})) ?? [];
    } catch {
      return [];
    }
  }

  FF.tools.get_containers = async () => {
    const all = await queryContainers();
    return {
      containers: all.map((c) => ({ name: c.name, cookieStoreId: c.cookieStoreId, color: c.color, icon: c.icon })),
    };
  };

  // cookieStoreId → container name, for labelling tabs. Default/private stores
  // have no entry, so a tab outside any container reads as no container.
  FF.containerNames = async () => new Map((await queryContainers()).map((c) => [c.cookieStoreId, c.name]));

  // Turn a container name (case-insensitive) or a cookieStoreId into the
  // cookieStoreId tabs.create wants. Fails with the list of real names rather
  // than letting the tab open somewhere the caller didn't ask for.
  FF.resolveContainer = async (query) => {
    const wanted = String(query ?? "").trim();
    if (!wanted) throw FF.bridgeError("INVALID_ARGS", "container must be a non-empty name");
    if (wanted === DEFAULT_STORE) return DEFAULT_STORE;
    const all = await queryContainers();
    if (!all.length) {
      throw FF.bridgeError(
        "INVALID_ARGS",
        "No containers available: containers are turned off in this Firefox profile, or none exist",
      );
    }
    const byId = all.find((c) => c.cookieStoreId === wanted);
    if (byId) return byId.cookieStoreId;
    const matches = all.filter((c) => c.name.toLowerCase() === wanted.toLowerCase());
    if (matches.length === 1) return matches[0].cookieStoreId;
    if (matches.length > 1) {
      throw FF.bridgeError(
        "INVALID_ARGS",
        `Several containers are named "${wanted}" — pass one id instead: ${matches.map((c) => c.cookieStoreId).join(", ")}`,
      );
    }
    throw FF.bridgeError(
      "INVALID_ARGS",
      `No container named "${wanted}". Containers: ${all.map((c) => c.name).join(", ")}`,
    );
  };
}
