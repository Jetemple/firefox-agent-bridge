// Pure CLI planning/formatting for `ff`. No I/O here: parseCli turns argv into
// dispatch steps; cli.mjs executes them over HTTP. Composite commands
// (click/type by query) become find_element + coordinate steps — the bridge
// stays strictly schema-shaped; agent-friendliness lives client-side.

const GLOBAL_BOOL = new Set(["json", "no-autostart"]);
const BOOL_FLAGS = new Set([
  ...GLOBAL_BOOL, "hard", "jpeg", "clear", "focused", "by-text", "ctrl", "alt", "shift", "meta",
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
    if (a === "-o") {
      flags.out = argv[++i];
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (BOOL_FLAGS.has(key)) flags[key] = true;
        else flags[key] = argv[++i];
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

function withTab(args, flags) {
  if (flags.tab != null) args.tabId = num(flags.tab, "--tab");
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
    return [{ tool: "javascript_tool", args }];
  },
  tab: (pos, flags) => {
    if (pos[0] === "close") return [{ tool: "close_tab", args: withTab({}, flags) }];
    if (pos[0] === "activate") return [{ tool: "activate_tab", args: withTab({}, flags) }];
    throw new UsageError("usage: ff tab close|activate [--tab N]");
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
      found && found.found ? withTab({ x: found.x, y: found.y }, flags) : null,
  };
}

function checkboxSteps(pos, flags, checked) {
  if (!pos[0]) throw new UsageError(`usage: ff ${checked ? "check" : "uncheck"} <css>`);
  return [{ tool: "set_checkbox", args: withTab({ selector: pos[0], checked }, flags) }];
}

const LIFECYCLE = new Set(["status", "start", "stop", "ping"]);

export function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { ok: true, kind: "help" };
  }
  const { flags, positionals } = tokenize(rest);
  const global = {
    json: !!flags.json,
    out: flags.out,
    noAutostart: !!flags["no-autostart"],
    timeout: flags.timeout != null ? Number(flags.timeout) : undefined,
  };
  if (global.timeout != null && !Number.isFinite(global.timeout)) {
    return { ok: false, error: "--timeout must be a number of milliseconds" };
  }
  if (LIFECYCLE.has(command)) return { ok: true, kind: "lifecycle", command, flags: global };
  const builder = BUILDERS[command];
  if (!builder) return { ok: false, error: `unknown command: ${command} (see ff --help)` };
  try {
    return { ok: true, kind: "steps", command, steps: builder(positionals, flags), flags: global };
  } catch (err) {
    if (err instanceof UsageError) return { ok: false, error: err.message };
    throw err;
  }
}

export function formatResult(command, results, { json = false } = {}) {
  const last = results[results.length - 1]?.result;
  if (json) return JSON.stringify(last, null, 2);
  switch (command) {
    case "tabs": {
      const tabs = last?.tabs ?? [];
      return tabs.map((t) => `${t.id}${t.active ? "*" : " "}  ${t.title ?? ""} — ${t.url ?? ""}`).join("\n");
    }
    case "text":
      return typeof last?.text === "string" ? last.text : JSON.stringify(last, null, 2);
    case "find":
      return last?.found
        ? `found ${last.element} "${last.text}" at (${last.x}, ${last.y})${last.count > 1 ? ` (+${last.count - 1} more matches)` : ""}`
        : "not found";
    case "links": {
      const links = last?.links ?? [];
      return links.map((l) => `${l.text ?? ""} — ${l.href ?? ""}`).join("\n");
    }
    default:
      return JSON.stringify(last, null, 2);
  }
}

export function usageText() {
  return `ff — drive your real, logged-in Firefox from the shell

Bridge:  ff status | start | stop | ping
Tabs:    ff tabs                        ff tab close|activate [--tab N]
         ff nav <url> [--tab N]         ff reload [--hard] | back | forward
Read:    ff text [--max N]              ff screenshot [-o out.png] [--jpeg [--quality N]]
         ff links [--max N]             ff tables [--max N]
         ff find <text> [--css SEL]     ff js <code>
Act:     ff click <query> [--css SEL] | --at X,Y     (also: hover, dblclick, rclick)
         ff type <query> <text> [--clear] | ff type <text> --focused
         ff key <key> [--ctrl --alt --shift --meta]
         ff scroll --dy N | --dx N | --into <css>
         ff drag --from X,Y --to X,Y
         ff select <css> <value> [--by-text]         ff check|uncheck <css>

<query> matches visible text/aria-label (find_element); add --css to scope.
Global:  --tab N   --json   --timeout MS   --no-autostart
The bridge auto-starts on demand; logs: ~/.firefox-mcp/bridge.log`;
}
