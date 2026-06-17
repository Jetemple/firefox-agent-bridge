// forward — navigate a tab forward in its session history.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.forward = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    await browser.tabs.goForward(tab.id);
    return { navigated: "forward", tabId: tab.id };
  };
}
