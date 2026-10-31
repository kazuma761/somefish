import type { ChatUIMessage } from "@/lib/sandbox-tools"

export type LiveBrowser = { url: string; step?: string; steps?: number }

// The browser a webTask is driving right now, if any. Only the last message's
// turn can still be running, and only while it streams: a finished, failed,
// stopped or reloaded task keeps its last preliminary output, whose stream is gone.
// The URL comes from tool output, so only https: is framed.
export function findLiveBrowser(
  message: ChatUIMessage | undefined,
  streaming: boolean
): LiveBrowser | undefined {
  if (!message || !streaming || message.role !== "assistant") return

  for (const part of message.parts.toReversed()) {
    if (part.type !== "tool-webTask") continue
    if (part.state !== "output-available" || !part.preliminary) return
    if (part.output.status !== "running" || !part.output.liveUrl) return
    try {
      if (new URL(part.output.liveUrl).protocol !== "https:") return
    } catch {
      return
    }
    return {
      url: part.output.liveUrl,
      step: part.output.step,
      steps: part.output.steps,
    }
  }
}
