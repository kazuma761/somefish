// Pure helpers for monitors. No imports, so node:test can load this file on its own.

export const DIFF_LIMIT = 1_500

export const ALERT_OPEN = "<monitor-data>"
export const ALERT_CLOSE = "</monitor-data>"

// TinyFish accepts a single minute and an optional "CRON_TZ=<zone> " prefix. A lone
// minute number (0-59) runs at most once an hour, so "*/30" and "0,30" are out.
export function isHourlyOrSlowerCron(cron: string): boolean {
  const fields = cron
    .trim()
    .replace(/^CRON_TZ=\S+\s+/, "")
    .split(/\s+/)
  const minute = fields[0]
  return fields.length === 5 && /^\d{1,2}$/.test(minute) && Number(minute) <= 59
}

// Cuts to at most `max` characters, "…" included, without splitting a surrogate pair.
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "…"
}

// Escaping every "<" means no spelling of the closing tag (case, spaces) survives inside.
// Truncate before wrapping, or the cut can land in the middle of an "&lt;".
export function wrapExternal(text: string): string {
  return `${ALERT_OPEN}\n${text.replaceAll("<", "&lt;")}\n${ALERT_CLOSE}`
}

const WEBHOOK_PATH = "/api/webhooks/tinyfish"
const WEBHOOK_QUERY = /(\/api\/webhooks\/tinyfish)\?[^\s"'#]*/g

// The webhook secret travels in the query string. Strips the query from every string in
// the event, replaces the secret itself (and its URL-encoded form) wherever it sits,
// local variables on stack frames included, and drops the standalone query fields next
// to a string that names the route. The caller passes the secret in, as this file has
// no imports and so no access to the environment.
export function scrubWebhookQuery(
  value: unknown,
  secret?: string,
  seen = new WeakSet<object>(),
): void {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  const obj = value as Record<string, unknown>
  const onRoute = Object.values(obj).some(
    (v) => typeof v === "string" && v.includes(WEBHOOK_PATH),
  )
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      let text = v
      if (secret) {
        for (const form of new Set([secret, encodeURIComponent(secret)])) {
          text = text.replaceAll(form, "[Filtered]")
        }
      }
      obj[key] = text.replace(WEBHOOK_QUERY, "$1")
    } else scrubWebhookQuery(v, secret, seen)
  }
  if (onRoute) {
    for (const key of ["query_string", "http.query", "url.query", "search"]) {
      delete obj[key]
    }
  }
}

// The most steps one webTask may take. TinyFish refuses agent_config.max_steps on this
// account, so the cap is counted here instead.
export const WEB_TASK_MAX_STEPS = 40

// Passes a TinyFish event stream through, and throws on the step after the `max`th.
// Leaving the loop closes the stream; the caller cancels and meters the run.
export async function* capSteps<T extends { type: string }>(
  events: AsyncIterable<T>,
  max: number,
): AsyncGenerator<T> {
  let steps = 0
  for await (const event of events) {
    if (event.type === "PROGRESS" && ++steps > max) {
      throw new Error(`The web task was stopped after ${max} steps.`)
    }
    yield event
  }
}
