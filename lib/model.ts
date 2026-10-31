import { openrouter } from "@openrouter/ai-sdk-provider"
import type { LanguageModelUsage } from "ai"

// The model the chat agent talks to. The provider reads OPENROUTER_API_KEY from
// the environment.
export function chatModel() {
  return openrouter("openai/gpt-5")
}

// Dollars per million tokens for the model above, at the provider's list price.
// Cached input is counted at the full rate.
const pricing = { input: 1.25, output: 10 }

// What a call to the chat model cost, in millionths of a dollar
export function chatModelCost(usage: LanguageModelUsage) {
  // Dollars per million tokens is millionths of a dollar per token
  return Math.ceil(
    (usage.inputTokens ?? 0) * pricing.input +
      (usage.outputTokens ?? 0) * pricing.output
  )
}
