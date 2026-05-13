const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
console.error("lines:", lines.length);
for (const [i, line] of lines.entries()) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    continue;
  }
  const msg = m.message;
  if (!msg) continue;
  const ts = (m.timestamp || "").slice(11, 19);
  if (msg.role === "user" && typeof msg.content === "string") {
    console.log(i, ts, "USER:", msg.content.slice(0, 250).replace(/\n/g, " "));
  } else if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c.type === "text") {
        console.log(
          i,
          ts,
          (msg.role || "?").toUpperCase() + ":",
          (c.text || "").slice(0, 400).replace(/\n/g, " "),
        );
      } else if (c.type === "tool_use") {
        console.log(
          i,
          ts,
          "TOOL_USE:",
          c.name,
          JSON.stringify(c.input).slice(0, 250),
        );
      } else if (c.type === "tool_result") {
        const out =
          typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        console.log(
          i,
          ts,
          "TOOL_RESULT" + (c.is_error ? "[ERR]" : "") + ":",
          out.slice(0, 400).replace(/\n/g, " "),
        );
      }
    }
  }
}
