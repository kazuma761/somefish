import * as Sentry from "@sentry/node"
import { task } from "@trigger.dev/sdk"
import { AgentChat } from "@trigger.dev/sdk/chat"
import { eq } from "drizzle-orm"

import { db } from "@/db"
import { chats } from "@/db/schema"
import { truncate } from "@/lib/monitor-rules"
import type { chatAgent } from "@/trigger/chat"

// Posts a monitor's report into its chat, as a turn the bot answers on its own
export const monitorAlert = task({
  id: "monitor-alert",
  // A retry would post the alert twice
  retry: { maxAttempts: 1 },
  run: async (payload: { chatId: string; botId: string; text: string }) => {
    const { chatId, botId, text } = payload

    // source: "monitor" takes the tools away for this turn
    const agentChat = new AgentChat<typeof chatAgent>({
      agent: "chat",
      id: chatId,
      clientData: { botId, source: "monitor" },
    })

    let reply = ""
    try {
      const stream = await agentChat.sendMessage(text)
      reply = await stream.text()
    } finally {
      await agentChat.close()
    }

    // So the chat moves up in the sidebar
    await db
      .update(chats)
      .set({
        ...(reply.trim() && {
          lastMessagePreview: truncate(reply.replace(/\s+/g, " ").trim(), 100),
        }),
        lastMessageAt: new Date(),
      })
      .where(eq(chats.id, chatId))

    Sentry.logger.info("Monitor alert posted", {
      "chat.id": chatId,
      "bot.id": botId,
    })
    await Sentry.flush(2000)
  },
})
