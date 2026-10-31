import { TinyFish } from "@tiny-fish/sdk"

// Reads TINYFISH_API_KEY from the environment. Server-only: never import this
// from a component that runs in the browser.
export const tinyfish = new TinyFish()

// What TinyFish charges, in millionths of a dollar like the usage ledger
export const AGENT_STEP_COST = 16_000
export const MONITOR_RUN_COST = 5_000

// The zone a monitor's schedule is read in when the bot doesn't name one
export const DEFAULT_TIMEZONE = "Asia/Kolkata"

// The SDK has no cancel, so this is the REST call. It is idempotent: a run that
// already finished comes back with its final status, which is fine here.
export async function cancelTinyFishRun(runId: string) {
  const response = await fetch(
    `https://agent.tinyfish.ai/v1/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { "X-API-Key": process.env.TINYFISH_API_KEY ?? "" },
      signal: AbortSignal.timeout(10_000),
    }
  )

  // Already gone is as good as cancelled
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Cancelling TinyFish run ${runId} failed with status ${response.status}`
    )
  }
}
