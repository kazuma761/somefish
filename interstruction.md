# jevo-claude + agent teams in tmux

`jevo-claude` is Claude Code routed through **Jevo**, with **Von** as the brain. Von is the open-source
decision model, and it runs locally on the CPU. On every prompt, Von picks:
- **the model**: Haiku for chat, Sonnet for implementing, Opus for design and planning;
- **a skill to suggest**: for example vibe-security, unlazy or reverse-engineer-anything.

Plain `claude` is not changed.

`jevo-team` starts a tmux team of `jevo-claude` agents. Each agent gets:
- its own colored pane;
- a header naming its role and job;
- a shared, live team chat at the bottom of the screen.

All the code is in `/home/ahana/Desktop/project/Jevo-autorouting`:

| File | What it does |
|---|---|
| `scripts/von-brain.sh` | Starts Von, starts the Jevo router, or launches `jevo-claude` |
| `scripts/jevo-team.sh` | Starts, messages and stops an agent team |
| `.von/` | Von's install, its key and the router configs (gitignored, never commit) |

---

## 1. One-time setup (already done on this machine)

These two lines are already in `~/.bashrc`:
```bash
alias jevo-claude='JEVO_PORT=8788 /home/ahana/Desktop/project/Jevo-autorouting/scripts/von-brain.sh claude'
alias jevo-team='/home/ahana/Desktop/project/Jevo-autorouting/scripts/jevo-team.sh'
```
A terminal that was open before they were added needs `source ~/.bashrc` once.

---

## 2. Start Von and the router (after every reboot)

`jevo-team up` does this for you. For `jevo-claude` on its own, start both once in a tmux session:
```bash
cd /home/ahana/Desktop/project/Jevo-autorouting
tmux new-session -d -s von -n servers
tmux send-keys -t von:servers "scripts/von-brain.sh von" Enter                 # Von on 127.0.0.1:8100 (CPU)
tmux split-window -h -t von:servers
tmux send-keys -t von:servers.1 "JEVO_PORT=8788 scripts/von-brain.sh jevo" Enter # router on 127.0.0.1:8788
```
Von needs about 30 seconds to load. To check both are up:
```bash
curl -s 127.0.0.1:8100/health      # prints "status":"ok"
ss -ltn | grep 8788                # prints one line
```

---

## 3. Use jevo-claude on its own

From any project folder:
```bash
cd ~/some/project
jevo-claude                 # interactive, like claude
jevo-claude -p "question"   # one answer, then exit
```
- The first time in a new folder, Claude Code asks **"Do you trust this folder?"**. Choose **Yes**.
- If Von or the router is down, `jevo-claude` prints the exact command to start it.

---

## 4. Start an agent team (the tmux setup with the UI)

```bash
jevo-team up <session-name> <project-folder> "ROLE: job" "ROLE: job" ...
```
You can have 1 to 6 agents. Pane 0 is the first role, pane 1 the second, and so on.

Example, the 3-agent team from the demo (website, API and QA):
```bash
mkdir -p ~/projects/notes-site
jevo-team up notes ~/projects/notes-site \
  "🟢 FRONTEND ENGINEER: builds web/index.html" \
  "🔵 API ENGINEER: builds api/server.js JSON API" \
  "🟣 QA ENGINEER: writes tests, reviews, reports bugs"
tmux attach -t notes
```

What `jevo-team up` does:
1. Starts Von and the router in the session's `servers` window, unless they are already running.
2. Makes the `agents` window: one pane per agent, side by side.
   - Agent colors in order: green, blue, purple, orange, teal, red.
   - Each pane's header shows the role and job.
3. Adds the grey **TEAM CHAT** pane at the bottom. It shows `<project-folder>/.team/<session>/chat.md` live.
4. Starts every agent with **jevo-claude**. Each agent is told the team map and the chat rules:
   - read the chat before each step;
   - post after each finding or change;
   - ask in the chat before editing another agent's file.
5. Each agent stops at **"Do you trust this folder?"** the first time. Approve it in each pane.
   - In tmux, move with `Ctrl-b` and an arrow key, then choose "Yes, I trust this folder".

### Give the agents their tasks
Type straight into a pane, or send a task from another terminal:
```bash
jevo-team send notes 1 "Read the team map. Build api/server.js: a small, secure notes API on 127.0.0.1:8795 with input validation. Post in the chat when it is up."
jevo-team send notes 0 "Design and build web/index.html: a clean notes page (list, add, delete) that calls /api/notes."
jevo-team send notes 2 "Wait in the chat for the API, then write node:test tests, run them, review the code and write qa-report.md. Do not stop until every test passes."
```
Use `jevo-team send`, not plain `tmux send-keys ... Enter`. With a long message, plain `send-keys` often leaves the text unsent in the input box. `send` types the text and presses Enter separately.

**Wording tip:** Von picks skills from what you write.
- "secure" or "check it is safe" → vibe-security
- "don't stop until…" or "every test passes" → unlazy
- "reverse engineer" or "decompile" → reverse-engineer-anything

### Stop the team
```bash
jevo-team down notes
```
If this team started Von and the router itself, they stop with it. They live in its `servers` window.

### How skill picking works
- **Von suggests one skill on every prompt an agent receives.** That includes what you type, `jevo-team send`,
  and a teammate's ping, which also arrives as a prompt. Von adds the suggestion to that prompt as a hint.
- **It does not run while an agent works on its own** between prompts (its tool loop).
- **During the work, the agent can still load any installed skill itself.** It is a full Claude Code with the
  normal Skill tool, built-in skills (pdf, docx, pptx, artifact-design…) included. Von's hint never blocks
  anything.
- **The skills Von chooses from** are installed skills only:
  - `~/.claude/skills/<name>/SKILL.md` (your own skills: unlazy, vibe-security, reverse-engineer-anything, …)
  - enabled plugins (ponytail, …)
  - the project's `.claude/skills/`
  Claude Code's built-in skills are not on Von's list. On this machine Von's list has 10 skills.
- **To make Von suggest a skill more often:** put a quoted trigger phrase in that skill's SKILL.md
  description, e.g. `"review my UI"`. A prompt containing that exact phrase picks the skill instantly,
  without asking Von.
- **To install a new skill:** put it in `~/.claude/skills/<name>/SKILL.md`. Von sees it from the next prompt.

---

## 5. tmux keys (once attached)

| Keys | Action |
|---|---|
| `Ctrl-b` then arrow | move between agents (the active one shows ▶ in its header) |
| `Ctrl-b z` | zoom one agent full screen, again to unzoom |
| `Ctrl-b n` / `Ctrl-b p` | next / previous window (`agents` ↔ `servers`) |
| `Ctrl-b d` | detach; everything keeps running |
| `tmux ls` | list sessions |
| `tmux attach -t <name>` | come back |

A wide terminal shows the full headers.

---

## 6. See what Von decided

```bash
# which skill was suggested for each prompt
tail -5 ~/.local/share/jevonian/skill-decisions.jsonl | python3 -c "import sys,json;[print(r['ts'][11:19], r.get('winner') or '-', r.get('elapsed_ms'),'ms') for r in map(json.loads, sys.stdin)]"
# which model answered, and how long Von took (rows with provider brain:custom)
tail -10 ~/.local/share/jevonian/ledger.jsonl | python3 -c "import sys,json;[print(r.get('provider'), r.get('model'), r.get('latencyMs'),'ms') for r in map(json.loads, sys.stdin)]"
```
In the agent panes, the status line also shows `⚡ Jevo → <model>`.

---

## 7. Troubleshooting

| What you see | Fix |
|---|---|
| `Von is not running` | `scripts/von-brain.sh von` (from Jevo-autorouting), wait about 30 s |
| `Jevo is not running` | `JEVO_PORT=8788 scripts/von-brain.sh jevo` |
| `zstdDecompressSync` error | wrong Node; the scripts use `/usr/local/bin/node` (v24); do not run `dist/cli.mjs` with nvm's v20 |
| A message sits unsent in an agent's input box | click into that pane and press Enter, or use `jevo-team send` |
| `session already runs` | `tmux attach -t <name>`, or `jevo-team down <name>` first |
| "claude.ai connectors are disabled…" | expected in jevo-claude (Jevo provides the login); use plain `claude` for connectors |
| Port 8000 busy | another project uses it; Von uses 8100 and the router 8788 |

## 8. Known limits
- Von often sends small prompts to **Opus**. In the demo, Opus answered 17 of 30 requests, so a team costs more than with perfect routing.
- No design skill gets suggested for UI work yet: none makes Von's shortlist of 5.
- Agents that `jevo-team` did not start, such as a plain `claude` you type yourself, are normal Claude: no Von, no skill hook.


# Add TinyFish web tools to AI Teammates

## Goal

Today a bot in this app can only reach the web by driving its Daytona desktop with screenshots and clicks. That costs one GPT-5 call with an image per click, and turns are capped at 50 steps. Give every bot proper web tools backed by TinyFish (https://tinyfish.ai):

- **`webSearch`** returns ranked web results. It uses the TinyFish Search API and is free.
- **`webFetch`** returns clean page content for up to 10 URLs. It uses the TinyFish Fetch API and is free.
- **`webTask`** runs a goal-driven browser agent that clicks, fills forms and extracts data on a live site, and returns JSON. It uses the TinyFish Agent API at $0.016 per step. Its live browser view is shown in the chat while it runs.
- **Monitors** let a bot watch a page or topic on a schedule. TinyFish calls our webhook, and the bot posts in the chat on its own.

The Daytona sandbox stays for shell, files and desktop apps.

Do the phases in order, and finish and typecheck each one before starting the next. Phases 1 and 2 are required; 3 and 4 are optional.

## Before you write code

- **Follow `CLAUDE.md` and `AGENTS.md`.** In particular:
  - Make no commits and no branches.
  - Change the schema only with `npm run db:push`. Use no migrations; clean-slate data is fine.
  - Any new env var read by code under `trigger/`, `lib/` or `db/` must go into the Trigger.dev production environment as well as Railway.
- **Load the Trigger.dev skills before touching `trigger/`.** Use `trigger-authoring-chat-agent` for phase 1 and `trigger-chat-agent-advanced` for phase 2. Read `node_modules/@trigger.dev/sdk/docs/ai-chat/tools.mdx` and `server-chat.mdx`.
- **This is Next.js 16.** Read the route handler guide in `node_modules/next/dist/docs/` before adding `app/api/webhooks/tinyfish/route.ts`.
- **TinyFish reference:** https://docs.tinyfish.ai/for-coding-agents.md, with everything in one file at https://docs.tinyfish.ai/llms-full.txt. The SDK's own types in `node_modules/@tiny-fish/sdk/dist/**/*.d.ts` are the source of truth if anything below disagrees.
- **Read these files first:**
  - `trigger/chat.ts`
  - `lib/sandbox-tools.ts`, `lib/handoff-tool.ts`, `lib/usage.ts`, `lib/model.ts`
  - `db/schema.ts`
  - `components/chat.tsx`, `hooks/use-paywall.ts`, `app/(dashboard)/usage/page.tsx`
  - `actions/bot.ts`
- **Match their style:**
  - Short comments that explain why.
  - `Sentry.logger` lines with `chat.id`, `user.id` and `bot.id` attributes.
  - Errors thrown as plain messages the model can act on.

## Install and configure

```bash
npm install @tiny-fish/sdk@latest   # 0.11.0 at the time of writing; it uses zod 4, keep zod on v4
```

Add these env vars to `.env.local`, the env block in `README.md`, Railway, and the Trigger.dev production environment:

- **`TINYFISH_API_KEY`**: from https://agent.tinyfish.ai/api-keys. It is server-only; never send it to the browser.
- **`TINYFISH_WEBHOOK_SECRET`**: a random string, e.g. from `openssl rand -hex 32`. TinyFish webhooks are unsigned, so this is how the webhook route knows a call is real.
- **`APP_URL`**: the app's public base URL. Use the Railway domain in production. In development use a tunnel URL (cloudflared or ngrok), because TinyFish cannot reach localhost.

## SDK facts, checked against @tiny-fish/sdk 0.11.0

**Client.** `new TinyFish()` reads `TINYFISH_API_KEY`.

**Search.** Typical latency is 1–3 s.
- Call: `search.query({ query, location?, language?, recency_minutes?, domain_type?: "web" | "news" | "research_paper", include_domains? })`
- Returns: `{ query, results: [{ position, site_name, title, snippet, url, date? }] }`

**Fetch.**
- Call: `fetch.getContents({ urls /* max 10 */, format: "markdown", purpose?, ttl? })`
- Returns: `{ results: [{ url, final_url, title, text, ... }], errors: [...] }`
- A URL that fails lands in `errors` without failing the whole request.
- One URL can take up to about 110 s, so do not wrap Fetch in a short timeout.

**Agent.** A typical run takes 15–60 s.
- Call: `agent.stream(params, { signal })`. It returns an async-iterable `AgentStream`, which also has `close()`.
- Events, in order:
  - `STARTED { run_id }`
  - `STREAMING_URL { run_id, streaming_url }`
  - `PROGRESS { run_id, purpose }`, repeated
  - `HEARTBEAT`
  - `COMPLETE { run_id, result, error }`
- Params:
  - `goal` and `url`
  - `browser_profile?: "lite" | "stealth"`
  - `proxy_config?`
  - `agent_config?: { max_steps?, max_duration_seconds? }`
  - `output_schema?`, a JSON Schema object
  - `webhook_url?`

**Runs.** `runs.get(runId)` returns the run, including `num_of_steps` (use it for metering) and `status`.

**Cancelling a run.**
- The SDK has no cancel method. Send `POST https://agent.tinyfish.ai/v1/runs/{runId}/cancel` with the header `X-API-Key`.
- The call is idempotent.
- Only streamed or async runs can be cancelled, so never use `agent.run()`.

**Monitors.**
- Create a page monitor with `monitors.create({ type: "fetch", config: { url, format? }, schedule_cron, name?, purpose?, webhook_url? })`.
- Create a topic monitor with `{ type: "search", config: { query, result_limit? }, ... }`.
- Creation returns `{ monitor, run }` and captures a baseline straight away.
- Other methods: `list()`, `get(id)`, `pause(id)`, `resume(id)` and `cancel(id)`, which deletes the monitor.
- `schedule_cron` is a 5-field cron in UTC, unless prefixed with `CRON_TZ=<IANA zone> `.
- Topic monitors must run at least 30 minutes apart.
- An account can have at most 50 monitors.

**Monitor webhooks.**
- TinyFish posts one for every scheduled run, including runs where nothing changed.
- Failed deliveries are retried up to 3 times.
- "Run now" does not send a webhook.
- Page payload: `{ fetch_monitor_id, id, is_baseline, outcome: "changed" | "unchanged" | "baseline", diff, diff_truncated, judgment: { purpose, is_relevant, summary, error } | null, results, errors }`
- Topic payload: `{ search_monitor_id, id, query, result_count, results: [{ position, site_name, title, snippet, url }], new_result_positions, created_at }`

**Prices and limits.**
- Search and Fetch are free within a daily allowance.
- Agent costs $0.016 per step; a monitor costs $0.005 per completed run.
- Pay-as-you-go accounts allow only 2 concurrent Agent runs.

**Gotchas.**
- A `COMPLETE` event without an error does not mean the goal succeeded. Check the result for signs like "captcha", "blocked" or "access denied".
- The `streaming_url` is safe to show in the browser, but it is view-only and can stop working once the run ends.

## Phase 1: web tools in every chat (required)

### 1. `lib/tinyfish.ts`

Export:

- `tinyfish`, one shared client.
- `cancelTinyFishRun(runId)`, the REST call described above. Ignore 404s and runs that have already finished.
- `AGENT_STEP_COST = 16_000` and `MONITOR_RUN_COST = 5_000`, in millionths of a dollar, which is the usage ledger's unit.
- `DEFAULT_TIMEZONE = "Asia/Kolkata"`, for monitor schedules.

### 2. `lib/web-tools.ts`

Create `createWebTools(options)` returning AI SDK `tool()`s, shaped like `createSandboxTools` in `lib/sandbox-tools.ts`. Also export `type WebTools`. It takes two options:

- `checkWebUsage: () => Promise<void>` throws when the web allowance is spent.
- `recordWebSpend: (amount: number, key: string) => Promise<void>` writes a usage entry.

**`webSearch`**
- Input: `{ query, news?: boolean, recencyDays?: number }`. `news` maps to `domain_type: "news"`, and `recencyDays` to `recency_minutes`.
- Return at most 8 results, each as `{ title, url, snippet, date }`.
- The description should say to use it to find pages, and to prefer it over the desktop browser.

**`webFetch`**
- Input: `{ urls: string[] (1–10), purpose?: string }`. Call Fetch with `format: "markdown"`.
- Return `{ pages: [{ url, title, text }], errors }`.
- Truncate so the whole output stays under 20,000 characters, reusing the truncate approach in `lib/sandbox-tools.ts`.
- The description should say to use it when the URL is known and the page only needs reading.

**`webTask`**
- Input: `{ url, goal, stealth?: boolean }`. The `goal` description must tell the model three things:
  - Write exact steps.
  - Name the fields to return as JSON.
  - Stop before any submit, pay, send or post step unless the person explicitly asked for it.
- Implement `execute` as an async generator, so the chat can show progress as preliminary tool results.
  - First confirm that AI SDK 7 supports this: search the docs and types in `node_modules/ai` for "preliminary".
  - If it does not, stream the live URL with a custom data part instead, and tell me which approach you used.
- What `execute` does, in order:
  1. Call `checkWebUsage()`.
  2. Call `tinyfish.agent.stream({ url, goal, browser_profile: stealth ? "stealth" : "lite", agent_config: { max_steps: 40 } }, { signal: abortSignal })`.
  3. Yield `{ status: "starting" }`.
  4. On `STREAMING_URL`, yield `{ status: "running", runId, liveUrl }`.
  5. On `PROGRESS`, yield the same object plus `step: purpose`.
  6. On `COMPLETE`, if there is an `error`, throw `new Error(error.message)`.
  7. Otherwise, yield the final `{ status: "done", runId, result, blocked }`. Set `blocked` to true when the result looks like a captcha or block page.
- In a `finally` block, do two things:
  - If the turn was aborted before `COMPLETE`, call `cancelTinyFishRun(runId)`.
  - Then fetch `runs.get(runId)` and call `recordWebSpend(num_of_steps * AGENT_STEP_COST, "tinyfish:" + runId)`. A metering error must never fail the tool.
- Add `toModelOutput` so the model sees only compact JSON of the final result: no live URL and no progress steps.
- When TinyFish rejects a run because of concurrency or rate limits, return a message the model can relay ("the web agent is busy, try again in a minute"), not a stack trace.
- Log the start and end of each run with `Sentry.logger`, including `tinyfish.run_id`, `tinyfish.steps` and the outcome.

### 3. A `web` usage kind

1. In `db/schema.ts`, add `"web"` to `usageKind`. Next to `amount`, note that for `web` it is millionths of a dollar of TinyFish spend.
2. In `lib/usage.ts`, set `usageLimits.web = 2_000_000` ($2 per billing period), and include `web` in `used` and `remaining`.
3. In `hooks/use-paywall.ts`, add a usage message for `web`.
4. In `app/(dashboard)/usage/page.tsx`, add a third meter, "Web agent", shown in dollars like the AI meter.
5. Run `npm run db:push`.

### 4. Wire the tools into `trigger/chat.ts`

**Merge the tools.**
- In `tools`, merge `createWebTools(...)` in for both direct and group chats.
- `checkWebUsage` uses `getUsage(userId)`, with the same one-minute caching as the existing sandbox check.
- `recordWebSpend` calls `recordUsage` with `kind: "web"` and the given idempotency key.

**Update the types.** In `lib/sandbox-tools.ts`, add `WebTools` to `ChatUIMessage` as `InferUITools<SandboxTools & HandoffTools & WebTools>`, so the new tool parts are typed. Do not create a circular import.

**Update the instructions.** In `buildInstructions`, replace the paragraph that starts "Your tools all act on that sandbox" with routing guidance along these lines:

> For anything on the public web, use the web tools, not the desktop: `webSearch` to find pages, `webFetch` to read pages whose URL you know (several at once), and `webTask` only when you must interact with a site (search forms, filters, multi-page flows, logging in). Give `webTask` precise goals and the exact JSON fields you want back. Never submit, buy, send or post anything on a site unless the person explicitly asked you to in this conversation. Use the shell and file tools for files and code, and the desktop only for apps that need a screen or when the person wants to watch you work there. You can save what you find on the web to your sandbox with the file tools.

Keep the existing desktop instructions (`viewScreen` and `showScreen`) after it.

### 5. Chat UI in `components/chat.tsx`

**Titles.** Add `toolTitles` entries for the new tools: "Search the web", "Read pages" and "Use a website".

**`tool-webSearch`.** Render the results with the existing `components/ai-elements/sources.tsx`: each title links to its URL, with the snippet below.

**`tool-webFetch`.** List each page's title and URL. Do not show the page text.

**`tool-webTask`.**
- Show the goal as the input.
- While the output is still preliminary and has a `liveUrl`, show the live browser:
  - Use `components/ai-elements/web-preview.tsx` (`WebPreview` with `WebPreviewBody src={liveUrl}`), at about 16:9.
  - Show the latest `step` underneath and a "Live, view only" label.
- Once the output is final:
  - Replace the iframe with the result as a JSON `CodeBlock`.
  - Show a warning line if `blocked` is true.
- Never render the iframe for a completed part, including parts loaded from the transcript, because the URL may no longer work.

### Phase 1 checks

Run `npm run typecheck` and `npm run lint`. Then start the app with `npm run dev` and `npx trigger.dev@4.7.3 dev`, and test in a direct chat:

1. "What's the latest stable Next.js version? Check the web." A `webSearch` card with sources should appear, followed by the answer.
2. "Read https://docs.tinyfish.ai/for-coding-agents.md and summarise it in 5 bullets." It should use `webFetch` and no desktop tools.
3. "Go to https://scrapeme.live/shop and give me the first 3 product names and prices." The `webTask` card should show the live browser, then JSON. The Web meter on the Usage page should go up.
4. Start the same task and press Stop. The TinyFish dashboard should show the run as CANCELLED.
5. A handoff in a group chat should still work.

## Phase 2: monitors, so teammates report on their own (required)

### 1. Schema

Add a `monitors` table to `db/schema.ts` with these columns:

- `id`: the TinyFish monitor id, as the primary key
- `userId`
- `botId`: a foreign key with cascade delete
- `chatId`: a foreign key with cascade delete
- `type`: an enum of `page` | `topic`
- `target`: the URL or the query
- `purpose`
- `scheduleCron`
- `createdAt`

Then:

- Add relations and types, and run `npm run db:push`.
- When a bot is deleted in `actions/bot.ts`, cancel its TinyFish monitors as well.

### 2. Tools

These tools need the current bot, chat and user. Pass them into `createWebTools` as getters, because a handoff changes the current bot, just as it changes the sandbox ID getter.

**`watchPage { url, purpose, scheduleCron }`** calls `monitors.create({ type: "fetch", config: { url, format: "markdown" }, ... })`.

**`watchTopic { query, purpose, scheduleCron }`** uses `type: "search"` with `result_limit: 10`. Reject schedules more frequent than every 30 minutes with a clear message.

For both `watchPage` and `watchTopic`:
- Prefix the cron with `CRON_TZ=${DEFAULT_TIMEZONE} `, unless the model already passed a `CRON_TZ=`.
- Set `name` to the bot's name plus the target.
- Set `purpose` to the condition the person cares about. TinyFish uses it to judge whether a change is relevant.
- Set `webhook_url` to `${APP_URL}/api/webhooks/tinyfish?secret=${TINYFISH_WEBHOOK_SECRET}`.
- Insert the row and return a short confirmation.

**`listWatches {}`** returns this bot's monitors in this chat.

**`stopWatching { monitorId }`** calls `monitors.cancel(id)` and deletes the row. It only works on monitors owned by the current bot.

Add this to the instructions:

> You can keep watching a page or a topic for the person with `watchPage` and `watchTopic`. Write the purpose as the exact condition they care about. Messages that start with `[Monitor alert]` are not from the person: they are reports from one of your watches. Tell the person what changed and why it matters in a few sentences, without asking them to repeat anything.

Add UI titles for these tools too.

### 3. Webhook route: `app/api/webhooks/tinyfish/route.ts`

**Check the request.**
- Accept `POST` only.
- Compare the `secret` query parameter with `TINYFISH_WEBHOOK_SECRET` using `crypto.timingSafeEqual`. Return 401 if they don't match.
- `proxy.ts` uses `clerkMiddleware()` without `protect`, so the route is reachable. Confirm that, and do not add Clerk auth to this route.

**Find the monitor.**
- Look it up with `body.fetch_monitor_id ?? body.search_monitor_id`.
- For an unknown id, return 200 and do nothing.

**Meter the run.**
- Call `recordUsage({ kind: "web", amount: MONITOR_RUN_COST, idempotencyKey: "monitor:" + body.id })`.
- The idempotency key also makes TinyFish's retries harmless.

**Decide whether to alert.**
- For a page monitor, alert when `outcome === "changed"` and `judgment?.is_relevant !== false`.
- For a topic monitor, alert when `new_result_positions.length > 0`.
- Never alert on baseline or unchanged runs.

**Send the alert.**
- Trigger a new Trigger.dev task, `monitor-alert` in `trigger/monitor-alert.ts`, with `{ chatId, botId, text }`, and return 200 straight away.
- Build `text` like this:
  1. Start with `[Monitor alert]`.
  2. Add the monitor's name and purpose.
  3. For a page, add `judgment.summary`, or the first ~3,000 characters of the diff if there is no summary.
  4. For a topic, add the new results as title-and-URL lines.

**The `monitor-alert` task** posts into the existing chat with `AgentChat` from `@trigger.dev/sdk/chat`:

1. Create `new AgentChat<typeof chatAgent>({ agent: "chat", id: chatId, clientData: { botId } })`. Check `server-chat.mdx` for the exact API in 4.7.3.
2. Call `sendMessage(text)` and wait for the reply to finish.
3. Call `close()`.
4. Update the chat's `lastMessagePreview` and `lastMessageAt`, so it moves up in the sidebar.

If the chat UI shows the message only after a refresh, tell me in your summary instead of building a realtime workaround.

### Phase 2 checks

1. In a direct chat, send "Watch https://example.com every hour and tell me if anything changes." A row should appear in `monitors`, and the monitor should appear in the TinyFish dashboard.
2. Post a sample page payload to the route with `curl`:
   - With the right secret and `outcome: "changed"`, the bot should reply in that chat.
   - With a wrong secret, the route should return 401.
   - Sending the same `id` again should not charge twice.
3. Send "Stop watching it." The monitor should be gone from both the database and TinyFish.

## Phase 3: memory in Postgres instead of the sandbox (optional)

**Why.** `recall` and `remember` read and write `MEMORY.md` inside the sandbox. The instructions make bots call `recall` almost every turn, so nearly every turn wakes the Daytona VM, even when the bot only needs web tools.

**Steps.**

1. Add a `memories` table with `id`, `botId` (a foreign key with cascade delete), `note` and `createdAt`.
2. Move `recall` and `remember` into `lib/memory-tools.ts`, keyed by the current bot id. Make them handoff-aware like the sandbox tools.
3. Remove `MEMORY_FILE`, `readBotMemory`, and the `touch MEMORY.md` in `createBotSandbox`.
4. Update `memoryInstructions`:
   - Drop the sentence about editing the file with the file tools.
   - Either add a `forget { note }` tool, or say that there isn't one.

Existing memory can be lost; `AGENTS.md` allows that.

## Phase 4: approval before irreversible web actions (optional)

1. Follow `node_modules/@trigger.dev/sdk/docs/ai-chat/patterns/human-in-the-loop.mdx`.
2. Add a `confirmWebAction` tool with no `execute`. The model calls it with a description of the submit, purchase or post it is about to do.
3. Render it with `components/ai-elements/confirmation.tsx`, with approve and reject buttons.
4. Only after approval does the model run a second `webTask` that performs just that final step.

## When you finish

Leave everything uncommitted. Reply with:

- what you changed, file by file
- which env vars I need to set, and where
- anything in this brief you couldn't do or did differently, and why
- the exact steps to run the checks above
