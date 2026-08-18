import assert from "node:assert/strict";
import { consumeSseResponse, createSseParser, parseSseChunks } from "../lib/sse.js";

const events = parseSseChunks([
  "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先检\"}}]}\r\n\r",
  "\ndata: {\"choices\":[{\"delta\":{\"content\":\"结果\"},\"finish_reason\":\"stop\"}]}\n\n",
  "data: {\"usage\":{\"total_tokens\":12},\"choices\":[]}\n\n",
  "data: [DONE]\n\n"
]);
assert.deepEqual(events, [
  { type: "REASONING_DELTA", delta: "先检" },
  { type: "CONTENT_DELTA", delta: "结果" },
  { type: "USAGE", usage: { total_tokens: 12 } },
  { type: "DONE", finishReason: "stop", usage: { total_tokens: 12 } }
]);

const toolEvents = parseSseChunks([
  'data: {"choices":[{"delta":{"reasoning_content":"需要检索","tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"search_gee_","arguments":"{\\"query\\":\\"Sent"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"datasets","arguments":"inel-2\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n"
]);
assert.equal(toolEvents[0].type, "REASONING_DELTA");
assert.equal(toolEvents[1].type, "TOOL_CALL_DELTA");
assert.equal(toolEvents[2].toolCalls[0].function.name, "datasets");
assert.equal(toolEvents.at(-1).finishReason, "tool_calls");

const multiLine = parseSseChunks([
  "event: message\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\ndata: \r\n\r\n",
  "data: [DONE]\r\n\r\n"
]);
assert.equal(multiLine[0].type, "CONTENT_DELTA");
assert.equal(multiLine[0].delta, "a");

const flushed = [];
const parser = createSseParser({ onEvent: (event) => flushed.push(event) });
parser.push("data: {\"choices\":[{\"delta\":{\"content\":\"tail\"},\"finish_reason\":\"length\"}]}");
parser.flush();
assert.equal(flushed[0].delta, "tail");
assert.deepEqual(flushed[1], { type: "DONE", finishReason: "length", usage: null });

assert.throws(
  () => parseSseChunks(["data: {bad json}\n\n"]),
  /无法解析模型流式响应 JSON/
);
assert.throws(
  () => parseSseChunks(["data: {\"error\":{\"message\":\"invalid key\"}}\n\n"]),
  /模型流式请求失败：invalid key/
);

await assert.rejects(
  consumeSseResponse(new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 })),
  /模型流式请求失败：bad gateway/
);

let finishRead;
let readerCancelled = false;
let readerReleased = false;
const cancellableResponse = {
  ok: true,
  body: {
    getReader() {
      return {
        read() {
          return new Promise((resolve) => {
            finishRead = resolve;
          });
        },
        cancel() {
          readerCancelled = true;
          finishRead({ done: true });
          return Promise.resolve();
        },
        releaseLock() {
          readerReleased = true;
        }
      };
    }
  }
};
const abortController = new AbortController();
const cancelledRead = consumeSseResponse(cancellableResponse, {
  signal: abortController.signal,
  onEvent() {}
});
abortController.abort();
const cancelledState = await cancelledRead;
assert.equal(cancelledState.done, false);
assert.equal(readerCancelled, true);
assert.equal(readerReleased, true);

let cancelledBeforeRead = false;
const alreadyAborted = new AbortController();
alreadyAborted.abort();
const preCancelledState = await consumeSseResponse({
  ok: true,
  body: {
    getReader() {
      return {
        async read() {
          return { done: true };
        },
        async cancel() {
          cancelledBeforeRead = true;
        },
        releaseLock() {}
      };
    }
  }
}, { signal: alreadyAborted.signal, onEvent() {} });
assert.equal(preCancelledState.done, false);
assert.equal(cancelledBeforeRead, true);

console.log("SSE parser tests passed.");
