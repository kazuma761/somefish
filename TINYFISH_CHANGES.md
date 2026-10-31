# TinyFish web tools: what changed and how it works

Written 2026-10-30, while the work was still in its last review. Nothing here is committed: every change is in the working tree on `main`.

## Status

| Item | State |
|---|---|
| Phase 1 (web tools in every chat) | Code done, reviewed, no blocking findings |
| Phase 2 (monitors) | Code done, final re-review (`MONITORS-3`) still running |
| Phases 3 and 4 | Not started, by your decision |
| Typecheck | Passes |
| Lint | No new problems. 37 old ones remain, left alone on purpose |
| Unit tests (`lib/monitor-rules.test.ts`) | 13 of 13 pass |
| `npm run db:push` | **Not run.** Needs your `.env.local` |
| Live checks | **Not run.** Nothing has been tried against real TinyFish or in a browser |

## What the feature does

Before, a bot could only reach the web by driving its Daytona desktop with screenshots and clicks. Now every bot has:

| Tool | What it does | Cost |
|---|---|---|
| `webSearch` | Ranked search results, 8 at most | Free within TinyFish's daily allowance |
| `webFetch` | Clean text of up to 10 known URLs | Free within TinyFish's daily allowance |
| `webTask` | A browser agent that clicks and fills in forms on a live site, shown live in the chat | $0.016 per step, 40 steps at most |
| `watchPage`, `watchTopic` | Check a page or topic on a schedule | $0.005 per run |
| `listWatches`, `stopWatching` | See or stop this bot's watches in this chat | None |

The Daytona sandbox stays for shell, files and desktop apps.

## How it works

### Overview

```
Browser  --message-->  Trigger.dev chat agent (trigger/chat.ts)
                         |-- web tools (lib/web-tools.ts) --> TinyFish API
                         |-- sandbox tools -----------------> Daytona

TinyFish monitor --webhook--> Railway route (app/api/webhooks/tinyfish/route.ts)
                                 |-- records the cost in Postgres
                                 |-- triggers trigger/monitor-alert.ts
                                        |-- posts into the chat, bot replies with no tools
```

### Flow 1: a normal message

1. The person sends a message. The chat agent loads the chat and its bots.
2. `userId` comes from the chat row, never from the browser.
3. The agent builds the tool set: sandbox tools, web tools, and handoff in group chats.
4. The instructions tell the bot which tool to use, and that anything from the web is data, never instructions.
5. The bot answers. Tool cards appear in the chat through `components/chat.tsx`.

### Flow 2: `webTask`

1. The tool checks the web allowance. If it is spent, the bot is told and no run starts.
2. It starts a TinyFish run with a 40-step limit, and the card shows "starting".
3. When TinyFish sends the live URL, the card shows the browser in an iframe, only for `https:` URLs and only while streaming.
4. Each progress event updates the step text under the iframe.
5. When the run completes, the iframe is replaced by the JSON result, with a warning if it looks like a captcha or block page.
6. Whatever happened, the tool then cancels the run if it never completed, and records `steps x $0.016` in the usage ledger, keyed on the run ID so it counts once.
7. The model sees only `{ result, blocked }`, not the live URL or the progress steps.

If the person presses Stop, or the stream ends early, the run is cancelled so it stops charging.

### Flow 3: creating a watch

1. The bot calls `watchPage` or `watchTopic`.
2. The allowance is checked. The schedule must have a single minute number, so it runs at most once an hour: `*/30` and `0,30` are rejected.
3. A per-user Postgres lock makes parallel calls queue up, so "watch these 10 pages" cannot get past the limit.
4. Inside that lock it counts the person's monitors, refuses at 5, creates the monitor at TinyFish, and saves the row.
5. If saving fails after TinyFish created the monitor, the monitor is cancelled so nothing charges unseen.
6. The schedule defaults to `Asia/Kolkata`. The webhook URL is never returned to the model or put in an error.

### Flow 4: a monitor reports in

TinyFish calls `POST /api/webhooks/tinyfish?secret=...`. The route then:

1. Checks the secret by comparing SHA-256 hashes in constant time. It returns 401 on a mismatch, or if no secret is configured.
2. Validates the body. Finds the monitor row, and returns 200 and does nothing for an unknown ID.
3. Takes `userId`, `botId` and `chatId` only from that row.
4. Records $0.005, keyed on the run ID, so a TinyFish retry cannot charge twice.
5. Checks the allowance, and goes to Flow 5 if it is spent.
6. Stops if this monitor is already paused.
7. Decides whether to alert:
   - Page: only if `outcome` is `changed` and TinyFish did not judge it irrelevant.
   - Topic: only if there are new results.
   - Never on baseline or unchanged runs.
8. Builds a short alert: the summary or new result titles and URLs, with any diff capped at 1,500 characters. All of it sits inside `<monitor-data>` delimiters, with every `<` escaped so the text cannot close the block early.
9. Triggers `monitor-alert` with the same run ID as its idempotency key, so a retry cannot post twice, and returns 200.

`trigger/monitor-alert.ts` then:

1. Sends the text into the chat with `AgentChat`, marked `source: "monitor"` in `clientData`.
2. Waits for the bot's reply.
3. Updates the chat's preview and time, so it moves up the sidebar.

The chat agent sees `source: "monitor"` and returns `activeTools: []`, so **that turn has no tools at all**. A web page therefore cannot use an alert to make the bot run commands or post things. A browser could send the same flag, but it only removes tools, so it grants nothing.

### Flow 5: the allowance runs out

1. All of the person's monitors are paused at TinyFish.
2. One notice is sent per affected chat, with an idempotency key.
3. Only then is `pausedAt` set, so if the notice fails, TinyFish's retry runs this again and the person is still told.
4. Nothing resumes automatically. Once the budget resets, the person asks the bot to stop the paused watches and set them up again.

### Flow 6: deleting things

TinyFish keeps charging until a monitor is cancelled there, even after the database row has gone. So monitors are cancelled first:

| Action | What happens |
|---|---|
| Delete a bot | Cancels its monitors, then deletes |
| Delete a group chat | Cancels its monitors, then deletes |
| Remove a bot from a group chat | Cancels that bot's monitors in the chat |
| `stopWatching` | Checks bot, chat and user, cancels at TinyFish, then deletes the row |

### Keeping the webhook secret safe

- It is kept out of logs, tool output and error messages.
- `scrubWebhookQuery` runs in Sentry's `beforeSend` and `beforeSendTransaction`. It strips the query string for this route and also replaces the secret's value everywhere in the event, including local variables on stack frames.
- `APP_URL` must be `https:`, so the secret never travels in clear.

## Files changed

### New files

| File | Purpose |
|---|---|
| `lib/tinyfish.ts` | Shared client, run cancel call, cost constants, default timezone |
| `lib/web-tools.ts` | All seven tools, plus the types the UI builds on |
| `lib/monitors.ts` | Cancelling and pausing monitors at TinyFish |
| `lib/monitor-rules.ts` | Pure helpers: schedule check, truncation, delimiter wrap, Sentry scrub |
| `lib/monitor-rules.test.ts` | The 13 unit tests for those helpers |
| `app/api/webhooks/tinyfish/route.ts` | The webhook (Flows 4 and 5) |
| `trigger/monitor-alert.ts` | Posts alerts and notices into a chat |
| `TINYFISH_CHANGES.md` | This file |

### Changed files

| File | Change |
|---|---|
| `trigger/chat.ts` | Merges the web tools, new routing instructions, the third-party data line, no tools on alert turns |
| `lib/sandbox-tools.ts` | Adds `WebTools` to `ChatUIMessage` as a type-only import |
| `db/schema.ts` | `web` usage kind, `monitors` table with `pausedAt`, relations and types |
| `lib/usage.ts` | $2 web allowance per billing period, `web` in `used` and `remaining` |
| `hooks/use-paywall.ts` | Usage message for `web` |
| `app/(dashboard)/usage/page.tsx` | Third meter, "Web agent", in dollars |
| `components/chat.tsx` | Titles and cards for the new tools; links only for `http:` and `https:` |
| `actions/bot.ts` | Cancels monitors when a bot is deleted |
| `actions/chat.ts` | Cancels monitors when a group chat is deleted or a bot is removed from it |
| `sentry.server.config.ts`, `sentry.edge.config.ts` | Secret scrubbing |
| `README.md` | The three new env var names |
| `package.json`, `package-lock.json` | `@tiny-fish/sdk` added by me. Your own changes are also here: `next` and `eslint-config-next` to 16.4.3, `eslint` to ^9.39.5 |

### Local only (excluded from git, not part of the app)

| Path | Purpose |
|---|---|
| `.claude/settings.local.json` | Team permissions |
| `.team/tinyfish/chat.md` | The agents' team chat |
| `.team/tinyfish/qa-report.md` | Pane 3's full security findings |
| `.unlazy/tinyfish/` | Brief, fix list, checks, lint baseline, and a copy of your lockfile from before the SDK install |

`.team/`, `.unlazy/` and `.claude/settings.local.json` were added to `.git/info/exclude`. `interstruction.md` is still untracked and untouched.

## Where the build differs from `interstruction.md`

**Your decisions:**
- Minimum 60 minutes between runs for pages and topics. The brief had 30, for topics only.
- At most 5 monitors per user, paused ones included.
- When the allowance runs out, pause and tell the person once, with no automatic resume.
- Alert turns are marked through `clientData`, not by matching the `[Monitor alert]` text.
- Diffs capped at about 1,500 characters and wrapped in delimiters.
- A line on every turn saying web content is data, never instructions.
- The secret is scrubbed from Sentry.

**Added during the build:**
- Alert turns get no tools at all. You asked to remove the risky ones; an empty list also covers tools added later.
- `http:` and `https:` only for `webFetch` and `webTask` URLs and for links in the chat, because search results can hold `javascript:` links.
- A run is cancelled whenever it did not complete, not only on abort. A stream that ends with no `COMPLETE` is an error.
- A 10-second timeout on the cancel call, and the model's `webTask` output is cut at 20,000 characters.
- A stopped `webTask` card shows "Pending" instead of "Running" or "Completed".
- The live iframe sends no referrer.
- Monitors are also cancelled on chat delete and when a bot is removed from a group. The brief covered only bot delete.
- `AgentChat` does keep the alert's `source` to its own turn: the SDK reads `clientData` per message (`ai.js:4968`, `chat-client.js:469`), so no workaround was needed.
- I replaced `Map.groupBy` in the webhook route, because it does not exist on Node 20.

**Lint:** "passes" means no new problems compared with a saved baseline, not fully green.

## How the team ran

A 4-agent `jevo-team` tmux session called `tinyfish`, with me as the driver handing out steps.

| Pane | Role | Work |
|---|---|---|
| 0 | Web tools | Type contract first, then the Phase 1 tools |
| 1 | Usage + UI | Usage kind first, then the chat UI, monitors table and README |
| 2 | Monitors | Phase 2 and its fixes |
| 3 | Security + QA | Read-only reviews at checkpoints |

The order was:

1. Pane 0 wrote the contract and pane 1 added the usage kind.
2. Pane 0 built the tools and pane 1 built the UI against the contract.
3. Pane 3 reviewed both, with no blocking findings, and a few small fixes were made.
4. Pane 2 built Phase 2.
5. Pane 3 found one blocking problem and pane 2 fixed six items, listed below.
6. Pane 3 re-reviews those fixes. **This step is still running.**

The six fixes:

1. The 5-monitor limit could be exceeded by parallel calls.
2. A removed bot's monitors kept charging.
3. The secret's value could reach Sentry.
4. The pause notice could be lost.
5. `APP_URL` could be `http:`.
6. Answered without a code change: an alert's `source` applies only to its own turn.

### Problems along the way

| Problem | Cause | What I did |
|---|---|---|
| ESLint crashed before any work | ESLint 10 and `eslint-plugin-react` clash | You downgraded to ESLint 9 |
| Agents stopped at permission prompts | Claude Code asks about `cd` plus a file read while a `Read()` deny rule exists, and the agents have no Grep tool | Declined each one and redirected the agent. I approved none on your behalf |
| Pane 3 sat stuck for about 5 minutes | My watcher looked for text that had scrolled off your short panes | Changed the watcher to look for text that stays visible |
| Phase 2 stalled for about 11 minutes | Idle agents do not read the chat unprompted, so pane 1 never saw pane 2's request | Sent requests to panes directly, and added a stall check |
| Panes 0, 2 and 3 filled their context | Long reading sessions | Compacted or cleared them. The work is all on disk |

## What you need to do

### 1. Create `.env.local`

Add your existing app values, plus the new ones. The README's env block lists them all.

### 2. Set the three new variables everywhere

| Variable | `.env.local` | Railway | Trigger.dev production |
|---|---|---|---|
| `TINYFISH_API_KEY` | Yes | Yes | Yes |
| `TINYFISH_WEBHOOK_SECRET` | Yes | Yes | Yes |
| `APP_URL` | Yes, your tunnel URL | Yes, the Railway domain | Yes, the Railway domain |

`TINYFISH_WEBHOOK_SECRET` is any random string, for example from `openssl rand -hex 32`.

**Set these before deploying.** The TinyFish client is created when the file loads, so a missing key breaks every chat and can fail `next build`, not just the web tools.

### 3. Push the schema

```bash
npm run db:push
```

Until this runs, the `web` enum and `monitors` table do not exist in the database, so web spend would go unrecorded.

### 4. Run the live checks

Install a tunnel first for real webhook delivery. Neither `cloudflared` nor `ngrok` is on this machine.

```bash
npm run dev
npx trigger.dev@4.7.3 dev
```

**Phase 1, in a direct chat:**
1. "What's the latest stable Next.js version? Check the web." Expect a `webSearch` card with sources, then the answer.
2. "Read https://docs.tinyfish.ai/for-coding-agents.md and summarise it in 5 bullets." Expect `webFetch` and no desktop tools.
3. "Go to https://scrapeme.live/shop and give me the first 3 product names and prices." Expect the live browser, then JSON, and the Web meter going up.
4. Start the same task and press Stop. The TinyFish dashboard should show the run as CANCELLED.
5. A handoff in a group chat should still work.

**Phase 2:**
1. "Watch https://example.com every hour and tell me if anything changes." Expect a row in `monitors` and the monitor in the TinyFish dashboard.
2. Post a sample page payload to the route with `curl`:
   - Right secret and `outcome: "changed"`: the bot replies in that chat.
   - Wrong secret: 401.
   - The same `id` again: no second charge and no second post.
3. "Stop watching it." The monitor should be gone from the database and from TinyFish.

**Extra checks the code review could not settle:**
1. An alert turn shows no tool-call parts.
2. An alert in a chat whose session the alert itself creates, then a normal message: the bot should still have its tools.
3. Whether an alert appears only after a page refresh. Pane 3 expects a reload is needed; I built no realtime workaround, as you asked.
4. Whether an alert sent during a running turn interrupts it.
5. Whether the live iframe works in its current sandbox. Narrow the sandbox only after this.

## Known risks left in

- **Overspend:** `webTask` can pass the $2 allowance by up to about $0.64 per run, because spend is recorded after the run.
- **Lost metering:** if the `runs.get` call fails or the worker dies, that run's cost is not recorded. Metering is not allowed to fail the tool.
- **Monitor cost:** 5 monitors at the 60-minute minimum cost about $0.60 a day, so they spend the $2 in about 3.3 days.
- **Prompt injection:** a web page can still try to get the bot to send its memory or sandbox files out through a URL or a `webTask` goal on a normal turn. Only instructions stand in the way until Phase 4. An old alert also stays in the chat history, where later turns with tools can read it.
- **Webhook secret in the URL:** by design it is visible in the TinyFish dashboard, may appear in Railway's request logs, and `next dev` may print it in your terminal.
- **Rotating the secret:** existing monitors keep calling with the old one and stop being metered, so cancel and recreate them.
- **Removed bots' rows:** when a bot is removed from a group, its monitors are cancelled at TinyFish but the rows stay and still count toward the 5. Pane 3 is checking this now.
- **`.env*` deny rules:** the Bash rule did block a command of mine, but I could not test whether the `Read` rule stops agents. Decline any prompt that mentions your env file.
- **`CLAUDE_CODE_MESSAGING_TOKEN`:** this is in the tmux environment, so agents could read it.

## Stopping the team

```bash
tmux attach -t tinyfish
/home/ahana/Desktop/project/Jevo-autorouting/scripts/jevo-team.sh down tinyfish
```

Von and the router run in your separate `von` session, so they keep running.
