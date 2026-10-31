import { NotFoundError } from "@tiny-fish/sdk"
import type { SQL } from "drizzle-orm"

import { db } from "@/db"
import { monitors } from "@/db/schema"
import { tinyfish } from "@/lib/tinyfish"

// A monitor that is already gone at TinyFish is as good as cancelled
export async function cancelTinyFishMonitor(id: string) {
  try {
    await tinyfish.monitors.cancel(id)
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
  }
}

// The SDK only sends status "paused" and does not say what TinyFish does with a monitor
// that already is. So if the call fails, a monitor found paused (or gone) still counts.
export async function pauseTinyFishMonitor(id: string) {
  try {
    await tinyfish.monitors.pause(id)
  } catch (error) {
    if (error instanceof NotFoundError) return
    const monitor = await tinyfish.monitors.get(id).catch(() => null)
    if (monitor?.status !== "paused") throw error
  }
}

// A bot or chat takes its monitor rows with it, but TinyFish goes on running (and
// charging) until each monitor is cancelled there. So cancel first: if one fails
// nothing is deleted and the whole delete can be retried.
export async function cancelMonitors(where: SQL | undefined) {
  const rows = await db.select({ id: monitors.id }).from(monitors).where(where)
  await Promise.all(rows.map((row) => cancelTinyFishMonitor(row.id)))
}
