// Pure functions that convert WebSocket payloads from the extension into MCP
// CallToolResults. The result-shape table in the spec documents the *inner* WS
// payloads; the SDK requires a CallToolResult with a `content` array.

function stripDataUrlPrefix(dataUrl) {
  // "data:image/png;base64,AAAA" -> "AAAA"; a bare base64 string passes through.
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export function toCallToolResult(name, wsResult) {
  if (name === "screenshot") {
    if (!wsResult || typeof wsResult.dataUrl !== "string") {
      return toErrorResult("INTERNAL", "screenshot payload missing dataUrl");
    }
    const mimeType = wsResult.format === "jpeg" ? "image/jpeg" : "image/png";
    return {
      content: [
        { type: "image", data: stripDataUrlPrefix(wsResult.dataUrl), mimeType },
        {
          type: "text",
          text: JSON.stringify({
            format: wsResult.format,
            width: wsResult.width,
            height: wsResult.height,
          }),
        },
      ],
    };
  }

  return { content: [{ type: "text", text: JSON.stringify(wsResult) }] };
}

export function toErrorResult(code, message) {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
  };
}
