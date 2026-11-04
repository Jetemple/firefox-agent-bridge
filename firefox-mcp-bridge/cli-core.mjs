// Pure CLI planning/formatting for `ff`. No I/O here: parseCli turns argv into
// dispatch steps; cli.mjs executes them over HTTP. Composite commands
// (click/type by query) become find_element + coordinate steps — the bridge
// stays strictly schema-shaped; agent-friendliness lives client-side.

const GLOBAL_BOOL = new Set(["json", "no-autostart", "replace", "here"]);
const GLOBAL_VALUE = new Set(["session", "profile", "timeout", "wait-for", "wait-timeout"]);
const BOOL_FLAGS = new Set([
  ...GLOBAL_BOOL, "hard", "jpeg", "clear", "focused", "by-text", "mine", "dry-run", "ctrl", "alt", "shift", "meta", "foreground",
]);

function tokenize(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-s") {
      if (argv[i + 1] === undefined) throw new UsageError("missing value for -s/--session");
      flags.session = argv[++i];
    } else if (a === "-o") {
      flags.out = argv[++i];
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (BOOL_FLAGS.has(key)) {
          flags[key] = true;
        } else {
          if ((key === "session" || key === "profile") && argv[i + 1] === undefined) {
            throw new UsageError(`missing value for ${key === "session" ? "-s/--session" : "--profile"}`);
          }
          flags[key] = argv[++i];
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function num(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`${name} must be a number, got: ${value}`);
  return n;
}

function xyPair(value, name) {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(value ?? ""));
  if (!m) throw new UsageError(`${name} must look like X,Y (e.g. 120,340)`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

class UsageError extends Error {}

// --here targets the tab the user is viewing ("active" is resolved by the
// extension); otherwise un-targeted commands act on the agent tab.
function withTab(args, flags) {
  if (flags.tab != null) args.tabId = num(flags.tab, "--tab");
  else if (flags.here) args.tabId = "active";
  return args;
}

const POINTER_TOOLS = { click: "click", hover: "hover", dblclick: "double_click", rclick: "right_click" };

// Each builder: (positionals, flags) => Step[] (throws UsageError).
const BUILDERS = {
  tabs: () => [{ tool: "get_tabs_summary", args: {} }],
  nav: (pos, flags) => {
    if (!pos[0]) throw new UsageError("usage: ff nav <url> [--tab N]");
    return [{ tool: "navigate", args: withTab({ url: pos[0] }, flags) }];
  },
  text: (pos, flags) => {
    const args = withTab({}, flags);
    if (flags.max != null) args.maxLength = num(flags.max, "--max");
    return [{ tool: "get_page_text", args }];
  },
  screenshot: (pos, flags) => {
    const args = withTab({}, flags);
    if (flags.jpeg) args.format = "jpeg";
    if (flags.quality != null) args.quality = num(flags.quality, "--quality");
    return [{ tool: "screenshot", args }];
  },
  type: (pos, flags) => {
    const typeArgs = (text) => {
      const a = withTab({ text }, flags);
      if (flags.clear) a.clearFirst = true;
      return a;
    };
    if (flags.focused) {
      if (pos[0] == null) throw new UsageError("usage: ff type <text> --focused");
      return [{ tool: "type", args: typeArgs(pos[0]) }];
    }
    if (pos.length < 2) throw new UsageError("usage: ff type <query> <text> [--css SEL] [--clear], or ff type <text> --focused");
    const [query, text] = pos;
    return [
      findStep(query, flags),
      pointerStep("click", flags),
      { tool: "type", args: typeArgs(text) },
    ];
  },
  js: (pos, flags) => {
    if (!pos[0]) throw new UsageError("usage: ff js <code>");
    const args = withTab({ code: pos[0] }, flags);
    if (flags.world) args.world = flags.world;
    if (flags.max != null) args.maxLength = num(flags.max, "--max");
    return [{ tool: "javascript_tool", args }];
  },
  tab: (pos, flags) => {
    if (pos[0] === "close" && flags.mine) {
      if (flags.tab != null || flags.here) throw new UsageError("--mine closes every agent-opened tab; drop --tab/--here");
      return [{ tool: "close_agent_tabs", args: flags["dry-run"] ? { dryRun: true } : {} }];
    }
    if (pos[0] === "close") return [{ tool: "close_tab", args: withTab({}, flags) }];
    if (pos[0] === "activate") return [{ tool: "activate_tab", args: withTab({}, flags) }];
    throw new UsageError("usage: ff tab close|activate [--tab N], or ff tab close --mine [--dry-run]");
  },
  reload: (pos, flags) => {
    const args = withTab({}, flags);
    if (flags.hard) args.bypassCache = true;
    return [{ tool: "reload", args }];
  },
  back: (pos, flags) => [{ tool: "back", args: withTab({}, flags) }],
  forward: (pos, flags) => [{ tool: "forward", args: withTab({}, flags) }],
  key: (pos, flags) => {
    if (!pos[0]) throw new UsageError("usage: ff key <key> [--ctrl --alt --shift --meta]");
    const args = withTab({ key: pos[0] }, flags);
    for (const mod of ["ctrl", "alt", "shift", "meta"]) if (flags[mod]) args[mod] = true;
    return [{ tool: "press_key", args }];
  },
  scroll: (pos, flags) => {
    const args = withTab({}, flags);
    if (flags.into) args.selector = flags.into;
    if (flags.dx != null) args.dx = num(flags.dx, "--dx");
    if (flags.dy != null) args.dy = num(flags.dy, "--dy");
    if (args.selector == null && args.dx == null && args.dy == null) {
      throw new UsageError("usage: ff scroll --dy N | --dx N | --into <css>");
    }
    return [{ tool: "scroll", args }];
  },
  drag: (pos, flags) => {
    const from = xyPair(flags.from, "--from");
    const to = xyPair(flags.to, "--to");
    return [{ tool: "drag", args: withTab({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, flags) }];
  },
  select: (pos, flags) => {
    if (pos.length < 2) throw new UsageError("usage: ff select <css> <value> [--by-text]");
    const args = withTab({ selector: pos[0] }, flags);
    if (flags["by-text"]) args.label = pos[1];
    else args.value = pos[1];
    return [{ tool: "select_option", args }];
  },
  check: (pos, flags) => checkboxSteps(pos, flags, true),
  uncheck: (pos, flags) => checkboxSteps(pos, flags, false),
  find: (pos, flags) => {
    if (!pos[0] && !flags.css) throw new UsageError("usage: ff find <text> [--css SEL]");
    return [findStep(pos[0], flags)];
  },
  links: (pos, flags) => {
    const args = withTab({}, flags);
    if (flags.max != null) args.max = num(flags.max, "--max");
    return [{ tool: "get_links", args }];
  },
  tables: (pos, flags) => {
    const args = withTab({}, flags);
    if (flags.max != null) args.max = num(flags.max, "--max");
    return [{ tool: "get_tables", args }];
  },
  open: (pos, flags) => {
    if (!pos[0]) throw new UsageError("usage: ff open <url> [--as NAME] [--container C] [--profile P] [--foreground]");
    const args = { url: pos[0], active: !!flags.foreground };
    // --as names a session; hand it to the extension as the tab-title marker
    // label so the strip shows "🤖 <name> · …". Omitted → emoji-only stamp.
    if (flags.as != null) args.label = flags.as;
    if ("container" in flags) {
      if (typeof flags.container !== "string" || !flags.container.trim()) {
        throw new UsageError("missing value for --container (see ff containers)");
      }
      args.container = flags.container;
      // Preflight: an extension older than 0.2.3 would drop the unknown
      // container arg and open the page outside the container. It doesn't
      // know get_containers either, so this fails first and nothing opens.
      return [{ tool: "get_containers", args: {} }, { tool: "open_tab", args }];
    }
    return [{ tool: "open_tab", args }];
  },
  containers: () => [{ tool: "get_containers", args: {} }],
  sessions: () => [{ tool: "session_list", args: {} }],
  session: (pos) => {
    if (pos[0] === "rm" && pos[1]) return [{ tool: "session_remove", args: { name: pos[1] } }];
    throw new UsageError("usage: ff session rm <name>");
  },
  bind: (pos, flags) => {
    if (!pos[0] || flags.tab == null) throw new UsageError("usage: ff bind <name> --tab N [--profile P]");
    return [{ tool: "session_bind", args: { name: pos[0], tabId: num(flags.tab, "--tab") } }];
  },
  profiles: (pos, flags) => {
    if (pos[0] == null) return [{ tool: "profiles_list", args: {} }];
    if (pos[0] === "name" && pos[1]) {
      if (pos[2]) {
        flags.profile = pos[1]; // route the rename at the OLD name
        return [{ tool: "set_profile_name", args: { name: pos[2] } }];
      }
      return [{ tool: "set_profile_name", args: { name: pos[1] } }];
    }
    throw new UsageError("usage: ff profiles | ff profiles name [OLD] NEW");
  },
};

for (const [name, tool] of Object.entries(POINTER_TOOLS)) {
  BUILDERS[name] = (pos, flags) => {
    if (flags.at != null) {
      const { x, y } = xyPair(flags.at, "--at");
      return [{ tool, args: withTab({ x, y }, flags) }];
    }
    if (!pos[0] && !flags.css) throw new UsageError(`usage: ff ${name} <query> [--css SEL] | --at X,Y`);
    return [findStep(pos[0], flags), pointerStep(tool, flags)];
  };
}

function findStep(query, flags) {
  const args = withTab({}, flags);
  if (query != null) args.text = query;
  if (flags.css) args.selector = flags.css;
  return { tool: "find_element", args };
}

function pointerStep(tool, flags) {
  return {
    tool,
    buildArgs: (found) =>
      found && found.found
        ? withTab({
            x: found.x,
            y: found.y,
            ...(found.ref ? { ref: found.ref } : {}),
            ...(found.frameId ? { frameId: found.frameId } : {}),
          }, flags)
        : null,
  };
}

function checkboxSteps(pos, flags, checked) {
  if (!pos[0]) throw new UsageError(`usage: ff ${checked ? "check" : "uncheck"} <css>`);
  return [{ tool: "set_checkbox", args: withTab({ selector: pos[0], checked }, flags) }];
}

const LIFECYCLE = new Set(["status", "start", "stop", "ping"]);

// Global flags are legal BEFORE the command too (`ff -s research text`).
// Consume leading globals, then hand the remainder to the command parser;
// tokenize() already accepts them after the command.
export function splitLeadingGlobals(argv) {
  const globals = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-s") {
      if (argv[i + 1] === undefined) throw new UsageError("missing value for -s/--session");
      globals.push("-s", argv[i + 1]);
      i += 2;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2).split("=")[0];
      if (GLOBAL_BOOL.has(key)) {
        globals.push(a);
        i += 1;
        continue;
      }
      if (GLOBAL_VALUE.has(key)) {
        if (a.includes("=")) {
          globals.push(a);
          i += 1;
        } else {
          if ((key === "session" || key === "profile") && argv[i + 1] === undefined) {
            throw new UsageError(`missing value for ${key === "session" ? "-s/--session" : "--profile"}`);
          }
          globals.push(a, argv[i + 1]);
          i += 2;
        }
        continue;
      }
    }
    break;
  }
  return { globals, rest: argv.slice(i) };
}

export function parseCli(argv) {
  // Wrapped in one try/catch: splitLeadingGlobals and tokenize can now throw
  // UsageError too (missing value for -s/--session/--profile), not just the
  // command builders below — all three funnel through the same conversion.
  try {
    const { globals, rest: afterGlobals } = splitLeadingGlobals(argv);
    const [command, ...rest] = afterGlobals;
    if (!command || command === "--help" || command === "-h" || command === "help") {
      return { ok: true, kind: "help" };
    }
    const { flags, positionals } = tokenize([...rest, ...globals]);

    function buildGlobal() {
      return {
        json: !!flags.json,
        out: flags.out,
        noAutostart: !!flags["no-autostart"],
        replace: !!flags.replace,
        timeout: flags.timeout != null ? Number(flags.timeout) : undefined,
        waitFor: flags["wait-for"],
        waitTimeout: flags["wait-timeout"] != null ? Number(flags["wait-timeout"]) : undefined,
        session: flags.session,
        profile: flags.profile,
        as: flags.as,
      };
    }

    if (flags.session != null && flags.tab != null) {
      return { ok: false, error: "-s/--session cannot be combined with --tab (the session owns its tab)" };
    }
    if (flags.here && (flags.tab != null || flags.session != null)) {
      return { ok: false, error: "--here cannot be combined with --tab or -s/--session" };
    }
    if (flags.session != null && flags.profile != null) {
      return { ok: false, error: "-s/--session cannot be combined with --profile (the session owns its profile)" };
    }
    const global = buildGlobal();
    if (global.timeout != null && !Number.isFinite(global.timeout)) {
      return { ok: false, error: "--timeout must be a number of milliseconds" };
    }
    if (global.waitTimeout != null && !Number.isFinite(global.waitTimeout)) {
      return { ok: false, error: "--wait-timeout must be a number of milliseconds" };
    }
    if (LIFECYCLE.has(command)) return { ok: true, kind: "lifecycle", command, flags: global };
    const builder = BUILDERS[command];
    if (!builder) return { ok: false, error: `unknown command: ${command} (see ff --help)` };
    const steps = builder(positionals, flags);
    // Re-read flags into a fresh global envelope: some builders (e.g. `profiles
    // name OLD NEW`) inject flags.profile as a side effect to route the call at
    // the OLD name — reusing the earlier `global` here would drop that and
    // break rename routing.
    return { ok: true, kind: "steps", command, steps, flags: buildGlobal() };
  } catch (err) {
    if (err instanceof UsageError) return { ok: false, error: err.message };
    throw err;
  }
}

// One `ff tabs` line. [name] is the session that owns the tab, [opened] a tab an
// agent opened without naming a session: both are someone's work in progress.
// {name} is the Firefox container the tab lives in.
export function formatTab(t) {
  const owner = t.session ? `[${t.session}] ` : t.opened && !t.agent ? "[opened] " : "";
  const container = t.container ? `{${t.container}} ` : "";
  return `${t.id}${t.active ? "*" : " "}  ${t.agent ? "🤖 " : ""}${owner}${container}${t.title ?? ""} — ${t.url ?? ""}`;
}

export function formatResult(command, results, { json = false } = {}) {
  const last = results[results.length - 1]?.result;
  if (json) return JSON.stringify(last, null, 2);
  switch (command) {
    case "tabs": {
      const tabs = last?.tabs ?? [];
      return tabs.map(formatTab).join("\n");
    }
    case "text":
      return typeof last?.text === "string" ? last.text : JSON.stringify(last, null, 2);
    case "js": {
      // Unwrap the { result } envelope: strings print raw (no wrapper to strip
      // in shell pipelines), everything else pretty-prints as JSON.
      const value = last?.result;
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }
    case "find":
      return last?.found
        ? `found ${last.element} "${last.text}" at (${last.x}, ${last.y})${last.frameId ? ` in frame ${last.frameId}` : ""}${last.count > 1 ? ` (+${last.count - 1} more matches)` : ""}`
        : "not found";
    case "links": {
      const links = last?.links ?? [];
      return links.map((l) => `${l.text ?? ""} — ${l.href ?? ""}`).join("\n");
    }
    case "sessions": {
      const sessions = last?.sessions ?? [];
      if (!sessions.length) return "no sessions — create one with `ff open <url> --as <name>`";
      return sessions
        .map((s) => `${s.name}  ${s.profile}  tab ${s.tabId}  ${s.live ? "live" : "STALE"}  ${s.url ?? ""}`.trimEnd())
        .join("\n");
    }
    case "profiles": {
      if (last?.profiles) {
        return last.profiles.length
          ? last.profiles.map((p) => `${p.name}${p.runId == null ? "  (extension outdated: no session support)" : ""}`).join("\n")
          : "no Firefox profiles connected";
      }
      return `profile named "${last?.name}"`; // set_profile_name result
    }
    case "open":
      return `tab ${last?.tabId}${last?.container ? ` in container ${last.container}` : ""}`;
    case "containers": {
      const containers = last?.containers ?? [];
      if (!containers.length) return "no containers (none exist, or containers are turned off in this profile)";
      return containers.map((c) => `${c.name}  ${c.cookieStoreId}  ${c.color ?? ""}`.trimEnd()).join("\n");
    }
    case "tab": {
      if (!Array.isArray(last?.closed)) return JSON.stringify(last, null, 2);
      const kept = last.kept?.length ? ` (left ${last.kept.join(", ")} open: you're viewing it)` : "";
      if (last.wouldClose) {
        return last.wouldClose.length
          ? `would close ${last.wouldClose.length} agent tab(s): ${last.wouldClose.join(", ")}${kept}`
          : `no agent tabs to close${kept}`;
      }
      return `closed ${last.closed.length} agent tab(s): ${last.closed.join(", ")}${kept}`;
    }
    case "bind":
      return `session ${last?.name} → tab ${last?.tabId} (profile ${last?.profile})`;
    case "session":
      return last?.removed ? "removed" : "no such session";
    default:
      return JSON.stringify(last, null, 2);
  }
}

export function usageText() {
  return `ff — drive your real, logged-in Firefox from the shell

Bridge:  ff status | start [--replace] | stop | ping
Tabs:    ff tabs                        ff tab close|activate [--tab N]
         ff tab close --mine [--dry-run]  close every tab the agent opened
         ff nav <url> [--tab N]         ff reload [--hard] | back | forward
         ff open <url> [--as NAME] [--container C] [--foreground]
         ff containers                  list containers (by name or id for --container)
Session: ff sessions | ff session rm NAME | ff bind NAME --tab N
         ff -s NAME <command>           any tab command runs against the session
Profile: ff profiles | ff profiles name [OLD] NEW | ff --profile P <command>
Read:    ff text [--max N]              ff screenshot [-o out.png] [--jpeg [--quality N]]
         ff links [--max N]             ff tables [--max N]
         ff find <text> [--css SEL]     ff js <code> | -f <file> | -   (stdin)
Act:     ff click <query> [--css SEL] | --at X,Y     (also: hover, dblclick, rclick)
         ff type <query> <text> [--clear] | ff type <text> --focused
         ff key <key> [--ctrl --alt --shift --meta]
         ff scroll --dy N | --dx N | --into <css>
         ff drag --from X,Y --to X,Y
         ff select <css> <value> [--by-text]         ff check|uncheck <css>

Commands run in the agent tab (🤖), a background tab \`ff nav\` opens and reuses —
your view never switches. --here targets the tab you're viewing instead;
\`ff tab activate\` brings the agent tab into view.
<query> matches visible text/aria-label/placeholder (find_element), in iframes and
shadow roots too; add --css to scope. A click whose target is covered fails without
clicking; --at X,Y clicks whatever is at that point. "tabHidden" in a result means
the tab was in the background, where some pages ignore clicks.
Tabs:    [name] marks a tab another session owns, [opened] one an agent opened,
         {name} its container. ff open --container C --as S, then ff -s S <cmd>.
Global:  --tab N   --here   -s NAME   --profile P   --json   --timeout MS   --no-autostart
         --wait-for <css> [--wait-timeout MS]   poll until an element appears
js prints string results raw; add --json for the full value as JSON. Results past
50000 chars (ff js --max N to change) are truncated; --json shows truncated/length.
The bridge auto-starts on demand; logs: ~/.firefox-mcp/bridge.log`;
}
