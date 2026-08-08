import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Modbus Data Logger application", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Modbus Data Logger<\/title>/i);
  assert.match(html, /Modbus Data Logger/);
  assert.match(html, /Overview/);
  assert.match(html, /Devices/);
  assert.match(html, /Live data/);
  assert.match(html, /History/);
  assert.match(html, /Alerts/);
  assert.match(html, /Reports &amp; export|Reports & export/);
  assert.doesNotMatch(html, /Account &amp; password|Account & password/);
  assert.match(html, /Collector unavailable/);
  assert.match(html, /Configured devices unavailable/);
  assert.doesNotMatch(html, /Main Energy Meter/);
  assert.doesNotMatch(html, /42\.8 GB/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});
