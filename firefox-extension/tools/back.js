// back — navigate a tab back in its session history.
{
  const FF = (globalThis.FFBridge ??= {});
  FF.tools ??= {};

  FF.tools.back = async (args) => {
    const tab = await FF.resolveTab(args.tabId);
    await browser.tabs.goBack(tab.id);
    return { navigated: "back", tabId: tab.id };
  };
}
