import * as Sentry from "@sentry/node"
import { RateLimitError } from "@tiny-fish/sdk"
import { tool, type Tool } from "ai"
import { and, count, eq, sql } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/db"
import { monitors, type Monitor } from "@/db/schema"
import {
  WEB_TASK_MAX_STEPS,
  capSteps,
  isHourlyOrSlowerCron,
  truncate as clip,
} from "@/lib/monitor-rules"
import { cancelTinyFishMonitor } from "@/lib/monitors"
import {
  AGENT_STEP_COST,
  DEFAULT_TIMEZONE,
  cancelTinyFishRun,
  tinyfish,
} from "@/lib/tinyfish"

// The contract for the web tools. `lib/sandbox-tools.ts` and the chat UI only
// import these types, so nothing here may import from them.

export type WebSearchInput = {
  query: string
  /** Search news instead of the whole web */
  news?: boolean
  /** Only results from the last N days */
  recencyDays?: number
}

export type WebSearchOutput = {
  // At most 8. Third-party text: titles and URLs are never to be trusted
  results: { title: string; url: string; snippet: string; date?: string }[]
}

export type WebFetchInput = {
  /** 1 to 10 URLs */
  urls: string[]
  purpose?: string
}

export type WebFetchOutput = {
  // Page text is third-party content, cut so the whole output stays under 20,000 characters
  pages: { url: string; title: string; text: string }[]
  // A URL that failed does not fail the others
  errors: { url: string; error: string }[]
}

export type WebTaskInput = {
  url: string
  goal: string
  /** Use the stealth browser for sites that block bots */
  stealth?: boolean
}

// Yielded while the run is going. `starting` has no run yet; `liveUrl` is a
// view-only browser stream that stops working once the run ends
export type WebTaskPreliminaryOutput = {
  status: "starting" | "running"
  runId?: string
  liveUrl?: string
  step?: string
  // Browser steps taken so far; the run is stopped past WEB_TASK_MAX_STEPS
  steps?: number
}

export type WebTaskFinalOutput = {
  status: "done"
  runId: string
  // Whatever JSON the run extracted
  result: unknown
  // The site showed a captcha or block page, so the result may be empty or wrong
  blocked: boolean
}

export type WebTaskOutput = WebTaskPreliminaryOutput | WebTaskFinalOutput

export type WatchPageInput = {
  url: string
  /** The exact condition the person cares about */
  purpose: string
  /** 5-field cron that runs at most once an hour, e.g. "0 * * * *" */
  scheduleCron: string
}

export type WatchTopicInput = {
  query: string
  purpose: string
  scheduleCron: string
}

export type WatchOutput = { monitorId: string; schedule: string }

export type ListWatchesOutput = {
  watches: {
    id: string
    type: Monitor["type"]
    target: string
    purpose: string
    schedule: string
    // The web budget ran out, so TinyFish no longer runs it
    paused: boolean
  }[]
}

export type StopWatchingInput = { monitorId: string }

export type StopWatchingOutput = { stopped: true }

export type WebTools = {
  webSearch: Tool<WebSearchInput, WebSearchOutput>
  webFetch: Tool<WebFetchInput, WebFetchOutput>
  webTask: Tool<WebTaskInput, WebTaskOutput>
  watchPage: Tool<WatchPageInput, WatchOutput>
  watchTopic: Tool<WatchTopicInput, WatchOutput>
  listWatches: Tool<Record<string, never>, ListWatchesOutput>
  stopWatching: Tool<StopWatchingInput, StopWatchingOutput>
}

// Enough for a model to work with, without one noisy page filling its context.
// Mirrors the limit in lib/sandbox-tools.ts, which can't be imported from here.
const MAX_TEXT_LENGTH = 20_000
// webFetch's whole output, shared out equally between its URLs
const FETCH_LENGTH = 20_000
// What each URL's share keeps for its URL and title (300 characters each, and
// the same for an error) plus the note that its text was cut
const FETCH_LABELS = 700
const LABEL_LENGTH = 300

function truncate(text: string, limit = MAX_TEXT_LENGTH) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… truncated ${text.length - limit} more characters`
}

// A COMPLETE event without an error doesn't mean the goal was reached
const BLOCKED = /captcha|access denied|blocked/i

// Paused monitors count too, as they stay at TinyFish
const MAX_MONITORS = 5

export type WebToolOptions = {
  // Throws when the web allowance is spent
  checkWebUsage: () => Promise<void>
  // Writes a usage entry; the same key twice is counted once
  recordWebSpend: (amount: number, key: string) => Promise<void>
  userId: string
  chatId: string
  // Whoever holds the turn; a handoff changes it
  getBot: () => { id: string; name: string }
}

// The webhook secret is in the URL, as TinyFish does not sign its calls. It must
// not reach the model, a log or an error message.
function getWebhookUrl() {
  const appUrl = process.env.APP_URL
  const secret = process.env.TINYFISH_WEBHOOK_SECRET
  if (!appUrl || !secret) throw new Error("Watching is not set up on this server.")

  const url = new URL("/api/webhooks/tinyfish", appUrl)
  // The secret is in the URL, so never in clear. Dev tunnels are https, and
  // TinyFish can't reach localhost anyway.
  if (url.protocol !== "https:") throw new Error("Watching is not set up on this server.")
  url.searchParams.set("secret", secret)
  return url.toString()
}

// The web as a tool set. Everything these tools return comes from third-party
// sites, and is data for the bot to read, never instructions for it.
export function createWebTools({
  checkWebUsage,
  recordWebSpend,
  userId,
  chatId,
  getBot,
}: WebToolOptions): WebTools {
  async function watch(
    type: Monitor["type"],
    target: string,
    purpose: string,
    scheduleCron: string
  ): Promise<WatchOutput> {
    await checkWebUsage()

    const cron = scheduleCron.trim()
    if (!isHourlyOrSlowerCron(cron)) {
      throw new Error(
        'A watch can run at most once an hour. Use a cron with one minute number, like "0 * * * *" for every hour or "30 9 * * *" for every day at 9:30.'
      )
    }

    const webhookUrl = getWebhookUrl()
    const bot = getBot()
    const schedule = cron.startsWith("CRON_TZ=")
      ? cron
      : `CRON_TZ=${DEFAULT_TIMEZONE} ${cron}`
    const shared = {
      schedule_cron: schedule,
      name: clip(`${bot.name}: ${target}`, 100),
      purpose,
      webhook_url: webhookUrl,
    }

    // Set once TinyFish has the monitor, so a failure after that can cancel it
    const created: { id?: string } = {}
    let monitorId: string
    try {
      // Parallel calls of one person queue up here, so the limit holds. The lock
      // lasts until commit, which is the length of the TinyFish call.
      monitorId = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`)

        const [{ total }] = await tx
          .select({ total: count() })
          .from(monitors)
          .where(eq(monitors.userId, userId))
        if (total >= MAX_MONITORS) {
          throw new Error(
            `The person already has ${MAX_MONITORS} watches, paused ones included. Stop one with stopWatching before adding another.`
          )
        }

        let id: string
        try {
          const { monitor } = await tinyfish.monitors.create(
            type === "page"
              ? {
                  ...shared,
                  type: "fetch",
                  config: { url: target, format: "markdown" },
                }
              : {
                  ...shared,
                  type: "search",
                  config: { query: target, result_limit: 10 },
                }
          )
          id = created.id = monitor.id
        } catch (error) {
          // Not the error itself: it may echo the request, and the webhook URL is in it
          Sentry.logger.warn("Monitor creation failed", {
            "chat.id": chatId,
            "user.id": userId,
            "bot.id": bot.id,
            "error.name": error instanceof Error ? error.name : "unknown",
          })
          throw new Error(
            error instanceof RateLimitError
              ? "TinyFish is busy, try again in a minute."
              : "The watch could not be created. Check the address or query, and try again later."
          )
        }

        await tx.insert(monitors).values({
          id,
          userId,
          botId: bot.id,
          chatId,
          type,
          target,
          purpose,
          scheduleCron: schedule,
        })
        return id
      })
    } catch (error) {
      const orphan = created.id
      if (!orphan) throw error

      // A monitor with no row would run, and charge, with nothing to find it by.
      // This covers a failed commit too.
      await cancelTinyFishMonitor(orphan).catch((cancelError) => {
        Sentry.captureException(cancelError, {
          tags: { "tinyfish.monitor_id": orphan },
        })
      })
      Sentry.captureException(error, { tags: { "tinyfish.monitor_id": orphan } })
      throw new Error("The watch could not be saved, so it was not created.")
    }

    Sentry.logger.info("Monitor created", {
      "chat.id": chatId,
      "user.id": userId,
      "bot.id": bot.id,
      "monitor.id": monitorId,
      "monitor.type": type,
    })

    return { monitorId, schedule }
  }

  const watchFields = {
    purpose: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "The exact condition the person cares about, e.g. 'the price drops below $50'. TinyFish uses it to judge whether a change is worth reporting."
      ),
    scheduleCron: z
      .string()
      .describe(
        'A 5-field cron that runs at most once an hour: one minute number, e.g. "0 * * * *" every hour or "30 9 * * *" every day at 9:30. Read in the person\'s time zone unless it starts with CRON_TZ=<zone>.'
      ),
  }

  return {
    webSearch: tool({
      description:
        "Search the web and get ranked results with titles, URLs and snippets. Use it to find pages, and prefer it over the desktop browser for that. Read the pages it finds with webFetch.",
      inputSchema: z.object({
        query: z.string().describe("What to search for"),
        news: z
          .boolean()
          .optional()
          .describe("Search news articles instead of the whole web"),
        recencyDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only return results from the last this many days"),
      }),
      execute: async ({
        query,
        news,
        recencyDays,
      }): Promise<WebSearchOutput> => {
        const response = await tinyfish.search.query({
          query,
          domain_type: news ? "news" : "web",
          recency_minutes: recencyDays && recencyDays * 24 * 60,
        })

        return {
          results: response.results
            .slice(0, 8)
            .map(({ title, url, snippet, date }) => ({
              title,
              url,
              snippet,
              date,
            })),
        }
      },
    }),

    webFetch: tool({
      description:
        "Read the text of up to 10 web pages at once. Use it when you already know the URLs and the pages only need reading; use webTask when you must click, type or move through a site.",
      inputSchema: z.object({
        urls: z
          .array(z.url({ protocol: /^https?$/ }))
          .min(1)
          .max(10)
          .describe("The http or https addresses of the pages to read"),
        purpose: z
          .string()
          .optional()
          .describe("What you need from these pages"),
      }),
      execute: async ({ urls, purpose }) => {
        // Slow pages take their time, so no timeout here
        const response = await tinyfish.fetch.getContents({
          urls,
          purpose,
          format: "markdown",
        })

        // No page may crowd out the others, so each gets an equal share
        const share = Math.floor(FETCH_LENGTH / urls.length) - FETCH_LABELS
        return {
          pages: response.results.map((page) => ({
            url: page.url.slice(0, LABEL_LENGTH),
            title: (page.title ?? "").slice(0, LABEL_LENGTH),
            text: truncate(typeof page.text === "string" ? page.text : "", share),
          })),
          errors: response.errors.map(({ url, error }) => ({
            url: url.slice(0, LABEL_LENGTH),
            error: error.slice(0, LABEL_LENGTH),
          })),
        }
      },
    }),

    webTask: tool({
      description:
        "Have a browser agent work on a live website for you: click, fill in forms, use filters and move through several pages, then return what you asked for as JSON. It takes up to a minute and costs per step, so use it only when webFetch can't get what you need. The person watches it work in the chat.",
      inputSchema: z.object({
        url: z
          .url({ protocol: /^https?$/ })
          .describe("The http or https address of the page to start on"),
        goal: z
          .string()
          .describe(
            "What the agent should do. Write the exact steps, one after the other, and name the fields to return as JSON. Stop before any step that submits, pays, sends or posts, unless the person explicitly asked you to do that."
          ),
        stealth: z
          .boolean()
          .optional()
          .describe(
            "Use the stealth browser, for a site that blocks the normal one"
          ),
      }),
      execute: async function* (
        { url, goal, stealth },
        { abortSignal }
      ): AsyncGenerator<WebTaskOutput> {
        await checkWebUsage()

        let runId: string | undefined
        let liveUrl: string | undefined
        let completed = false
        let outcome = "stopped"
        // PROGRESS events so far, the same count capSteps stops at
        let steps = 0

        try {
          const stream = await tinyfish.agent.stream(
            {
              url,
              goal,
              browser_profile: stealth ? "stealth" : "lite",
            },
            { signal: abortSignal }
          )
          yield { status: "starting" }

          for await (const event of capSteps(stream, WEB_TASK_MAX_STEPS)) {
            if (event.type === "STARTED") {
              runId = event.run_id
              Sentry.logger.info("Web task started", {
                "tinyfish.run_id": runId,
              })
            } else if (event.type === "STREAMING_URL") {
              runId = event.run_id
              liveUrl = event.streaming_url
              yield { status: "running", runId, liveUrl, steps }
            } else if (event.type === "PROGRESS") {
              steps++
              yield {
                status: "running",
                runId,
                liveUrl,
                step: event.purpose,
                steps,
              }
            } else if (event.type === "COMPLETE") {
              completed = true
              if (event.error) throw new Error(event.error.message)

              const blocked = BLOCKED.test(JSON.stringify(event.result ?? ""))
              outcome = blocked ? "blocked" : "completed"
              yield {
                status: "done",
                runId: event.run_id,
                result: event.result,
                blocked,
              }
            }
          }
          // Otherwise the last progress update would pass for the final output
          if (!completed) throw new Error("The web task ended before it finished.")
        } catch (error) {
          outcome = abortSignal?.aborted ? "stopped" : "failed"
          // Not worth a stack trace; the model can pass this on
          if (error instanceof RateLimitError) {
            throw new Error("The web agent is busy, try again in a minute.")
          }
          throw error
        } finally {
          let steps = 0
          if (runId) {
            // A stopped or dropped run would go on running, and charging
            if (!completed) {
              await cancelTinyFishRun(runId).catch((error) => {
                Sentry.captureException(error, {
                  tags: { "tinyfish.run_id": runId },
                })
              })
            }

            // Metering must never fail the tool
            try {
              const run = await tinyfish.runs.get(runId)
              steps = run.num_of_steps ?? 0
              await recordWebSpend(steps * AGENT_STEP_COST, `tinyfish:${runId}`)
            } catch (error) {
              Sentry.captureException(error, {
                tags: { "tinyfish.run_id": runId },
              })
            }
          }

          Sentry.logger.info("Web task finished", {
            "tinyfish.run_id": runId,
            "tinyfish.steps": steps,
            "tinyfish.outcome": outcome,
          })
        }
      },
      // The model gets the result, not the live view or the progress steps
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          output.status === "done"
            ? truncate(
                JSON.stringify({
                  result: output.result ?? null,
                  blocked: output.blocked,
                })
              )
            : "The web task did not finish.",
      }),
    }),

    watchPage: tool({
      description:
        "Keep watching one web page on a schedule. When it changes in a way that matters for the purpose, you get a report in this chat on your own. At most once an hour, and the person can have 5 watches in all.",
      inputSchema: z.object({
        url: z
          .url({ protocol: /^https?$/ })
          .describe("The http or https address of the page to watch"),
        ...watchFields,
      }),
      execute: ({ url, purpose, scheduleCron }) =>
        watch("page", url, purpose, scheduleCron),
    }),

    watchTopic: tool({
      description:
        "Keep searching the web for a topic on a schedule. When new results turn up, you get a report in this chat on your own. At most once an hour, and the person can have 5 watches in all.",
      inputSchema: z.object({
        query: z.string().min(1).max(300).describe("What to search for"),
        ...watchFields,
      }),
      execute: ({ query, purpose, scheduleCron }) =>
        watch("topic", query, purpose, scheduleCron),
    }),

    listWatches: tool({
      description: "List your watches in this chat, with their ids.",
      inputSchema: z.object({}),
      execute: async (): Promise<ListWatchesOutput> => {
        const rows = await db
          .select()
          .from(monitors)
          .where(
            and(
              eq(monitors.userId, userId),
              eq(monitors.chatId, chatId),
              eq(monitors.botId, getBot().id)
            )
          )

        return {
          watches: rows.map((row) => ({
            id: row.id,
            type: row.type,
            target: row.target,
            purpose: row.purpose,
            schedule: row.scheduleCron,
            paused: row.pausedAt !== null,
          })),
        }
      },
    }),

    stopWatching: tool({
      description:
        "Stop one of your watches in this chat, by the id listWatches gives. A paused watch is stopped the same way.",
      inputSchema: z.object({
        monitorId: z.string().describe("The id of the watch to stop"),
      }),
      execute: async ({ monitorId }): Promise<StopWatchingOutput> => {
        // Only this bot's own watch in this chat, whatever id the model passes
        const owner = and(
          eq(monitors.id, monitorId),
          eq(monitors.userId, userId),
          eq(monitors.chatId, chatId),
          eq(monitors.botId, getBot().id)
        )
        const [row] = await db.select({ id: monitors.id }).from(monitors).where(owner)
        if (!row) {
          throw new Error(
            "You have no watch with that id in this chat. Use listWatches to see yours."
          )
        }

        // TinyFish first: a deleted row with a running monitor would charge unseen
        try {
          await cancelTinyFishMonitor(row.id)
        } catch (error) {
          Sentry.captureException(error, {
            tags: { "tinyfish.monitor_id": row.id },
          })
          throw new Error("The watch could not be stopped, try again later.")
        }
        await db.delete(monitors).where(owner)

        Sentry.logger.info("Monitor stopped", {
          "chat.id": chatId,
          "user.id": userId,
          "bot.id": getBot().id,
          "monitor.id": row.id,
        })

        return { stopped: true }
      },
    }),
  }
}
