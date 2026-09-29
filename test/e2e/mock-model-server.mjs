// Minimal OpenAI-compatible mock model for e2e testing opencode-bash-sentinel.
// Deterministic protocol:
//   - when a user message starts with "CMD:<command>" -> stream a shell tool call with that command
//   - when a user message starts with "EDITW:<path>" -> stream a write tool call for that path
//   - otherwise (title generation, tool result follow-ups, ...) -> stream short text
const PORT = 8997

import http from "node:http"

function userText(messages) {
  const users = messages.filter((m) => m.role === "user")
  const last = users.at(-1)
  if (!last) return ""
  if (typeof last.content === "string") return last.content
  if (Array.isArray(last.content)) return last.content.map((p) => p.text ?? "").join("")
  return ""
}

function chunk(delta, finish_reason = null) {
  return `data: ${JSON.stringify({
    id: "mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-1",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`
}

let calls = 0

const server = http.createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(404).end()
    return
  }
  let body = ""
  req.on("data", (d) => (body += d))
  req.on("end", () => {
    let messages = []
    try {
      messages = JSON.parse(body).messages ?? []
    } catch {}
    const text = userText(messages).trim().replace(/^"+|"+$/g, "")
    const hasToolResult = messages.some(
      (m) => m.role === "tool" || (Array.isArray(m.content) && m.content.some?.((p) => p.type === "tool-result")),
    )
    const editMatch = /^EDITW:(.+)$/s.exec(text)
    const command = !hasToolResult && /^CMD:(.+)$/s.exec(text)?.[1]
    const editPath = !hasToolResult && editMatch?.[1]
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    // Sentinel correlates permission asks by tool-call ID, so keep IDs unique.
    const id = `call_${++calls}`
    if (command) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "shell", arguments: "" } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command }) } }] }))
      res.write(chunk({}, "tool_calls"))
      console.log(`[mock] tool-call shell ${JSON.stringify(command)}`)
    } else if (editPath) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: "" } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: editPath, content: "written by sentinel e2e\n" }) } }] }))
      res.write(chunk({}, "tool_calls"))
      console.log(`[mock] tool-call write ${JSON.stringify(editPath)}`)
    } else {
      res.write(chunk({ role: "assistant", content: "ok" }))
      res.write(chunk({}, "stop"))
      console.log(`[mock] text response (user msg: ${JSON.stringify(text).slice(0, 60)})`)
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
})

server.listen(PORT, "127.0.0.1", () => console.log(`[mock] listening on http://127.0.0.1:${PORT}`))
