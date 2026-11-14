// Fake Anthropic Messages API for tests: streams a canned tutor answer and logs
// every request body (one JSON object per line) to the file given as argv[2].
// The first request reports a cache write; later ones report cache reads.
const http = require("http");
const fs = require("fs");

const LOG = process.argv[2];
const PORT = Number(process.argv[3] ?? 8798);
let n = 0;

const ANSWER =
  "Look at **cell 2**: `age` is declared as `number` in the interface.\n\n" +
  "What type is the value you assigned?\n\n```ts\nconst n: number = 36;\n```\n";

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      fs.appendFileSync(LOG, JSON.stringify({ url: req.url, beta: req.headers["anthropic-beta"], body: b }) + "\n");
      n++;
      const usage = {
        input_tokens: 40,
        output_tokens: 0,
        cache_creation_input_tokens: n === 1 ? 1500 : 0,
        cache_read_input_tokens: n === 1 ? 0 : 1500,
      };
      if (!b.stream) {
        // max_tokens 0 = keep-warm (no content); otherwise a block summary request.
        const content = b.max_tokens === 0 ? [] : [{ type: "text", text: `SUMMARY#${n}: earlier cells defined some variables.` }];
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: b.model, content, stop_reason: b.max_tokens === 0 ? "max_tokens" : "end_turn", stop_sequence: null, usage }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      let i = 0;
      if (b.thinking?.display === "summarized") {
        ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
        ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: "The learner assigned a string to a number field." } });
        ev("content_block_delta", { index: i, delta: { type: "signature_delta", signature: "sig" } });
        ev("content_block_stop", { index: i });
        i++;
      }
      ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      for (const chunk of ANSWER.match(/.{1,12}/gs)) ev("content_block_delta", { index: i, delta: { type: "text_delta", text: chunk } });
      ev("content_block_stop", { index: i });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } });
      ev("message_stop", {});
      res.end();
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock anthropic on ${PORT}`));
