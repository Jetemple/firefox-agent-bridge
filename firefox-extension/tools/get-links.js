// get_links — collect anchors' visible text + resolved href.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};
  FF.injected ??= {};

  function getLinks(max) {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const links = [];
    for (const a of anchors) {
      links.push({ text: (a.innerText || a.textContent || "").trim().slice(0, 200), href: a.href });
      if (max != null && links.length >= max) break;
    }
    return { links, count: anchors.length, truncated: links.length < anchors.length };
  }

  FF.injected.getLinks = getLinks;

  FF.tools.get_links = async (args, tab) => FF.inject(tab.id, getLinks, [args.max ?? null]);
}
