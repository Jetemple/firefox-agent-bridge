// Named sessions: name -> { profile, tabId, runId, url, createdAt }.
// Held by the bridge OWNER only; persisted (0600, atomic rename) so a bridge
// restart keeps sessions while Firefox stays up. The recorded runId is what
// makes persistence safe: a Firefox/extension restart issues a new runId, so
// a stale record can never dispatch against a reissued tab id.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function createSessionStore({ filePath, log = () => {} } = {}) {
  const records = new Map(); // name -> record (without the name field)

  function persist() {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(records) }, null, 2), {
        mode: 0o600,
      });
      renameSync(tmp, filePath);
    } catch (err) {
      log(`could not persist sessions to ${filePath}: ${err?.message ?? err}`);
    }
  }

  function load() {
    if (!filePath) return;
    records.clear();
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      for (const [name, rec] of Object.entries(parsed?.sessions ?? {})) {
        if (SESSION_NAME_RE.test(name) && rec && typeof rec === "object") records.set(name, rec);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") log(`ignoring unreadable sessions file ${filePath}: ${err?.message ?? err}`);
    }
  }

  function bind(name, { profile, tabId, runId, url }) {
    if (!SESSION_NAME_RE.test(String(name ?? ""))) {
      throw { code: "BAD_NAME", message: `session name must match ${SESSION_NAME_RE}` };
    }
    const previous = records.get(name) ?? null;
    records.set(name, { profile, tabId, runId, url: url ?? null, createdAt: Date.now() });
    persist();
    return previous ? { name, ...previous } : null;
  }

  const get = (name) => {
    const rec = records.get(name);
    return rec ? { name, ...rec } : undefined;
  };

  return {
    load,
    bind,
    get,
    list: () => [...records.entries()].map(([name, rec]) => ({ name, ...rec })),
    remove: (name) => {
      const had = records.delete(name);
      if (had) persist();
      return had;
    },
  };
}
