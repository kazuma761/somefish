import assert from "node:assert/strict"
import { test } from "node:test"

// @ts-expect-error node needs the .ts extension; tsconfig does not allow it
import { findLiveBrowser } from "./live-browser.ts"

const webTask = (state: string, output: unknown, preliminary = true) => ({
  type: "tool-webTask",
  toolCallId: "call-1",
  state,
  preliminary,
  input: { url: "https://example.com", goal: "Find the price" },
  output,
})

// Loose fixtures, cast to the message type the function takes
const reply = (...parts: unknown[]) =>
  ({ id: "m1", role: "assistant", parts }) as never

const running = {
  status: "running",
  runId: "run-1",
  liveUrl: "https://live.tinyfish.ai/run-1",
  step: "Clicking search",
  steps: 3,
}

test("a running task's https live URL is shown while streaming", () => {
  assert.deepEqual(
    findLiveBrowser(reply(webTask("output-available", running)), true),
    {
      url: "https://live.tinyfish.ai/run-1",
      step: "Clicking search",
      steps: 3,
    }
  )
})

test("nothing once the turn stops streaming", () => {
  assert.equal(
    findLiveBrowser(reply(webTask("output-available", running)), false),
    undefined
  )
})

test("nothing once the task finishes or fails", () => {
  const done = webTask("output-available", { status: "done" }, false)
  assert.equal(findLiveBrowser(reply(done), true), undefined)
  const failed = webTask("output-error", undefined, false)
  assert.equal(findLiveBrowser(reply(failed), true), undefined)
})

test("only https: URLs are framed", () => {
  for (const liveUrl of ["http://x.test", "javascript:alert(1)", "nope"]) {
    const part = webTask("output-available", { ...running, liveUrl })
    assert.equal(findLiveBrowser(reply(part), true), undefined)
  }
})

test("the latest web task wins over an earlier finished one", () => {
  const earlier = webTask("output-available", running)
  const later = webTask("output-available", { status: "done" }, false)
  assert.equal(findLiveBrowser(reply(earlier, later), true), undefined)
  assert.equal(findLiveBrowser(reply(later, earlier), true)?.steps, 3)
})

test("a starting task with no live URL yet shows nothing", () => {
  const part = webTask("output-available", { status: "starting" })
  assert.equal(findLiveBrowser(reply(part), true), undefined)
  assert.equal(findLiveBrowser(undefined, true), undefined)
})
