"use client"

import { useChat } from "@ai-sdk/react"
import * as Sentry from "@sentry/nextjs"
import type { TriggerChatTransport } from "@trigger.dev/sdk/chat"
import {
  useLoadTranscript,
  useTriggerChatTransport,
} from "@trigger.dev/sdk/chat/react"
import { isToolUIPart } from "ai"
import { useEffect, useState } from "react"

import {
  loadTranscript,
  mintChatAccessToken,
  startChatSession,
} from "@/actions/chat"

import { ChatAvatar } from "@/components/chat-avatar"
import { CodeBlock } from "@/components/ai-elements/code-block"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Image } from "@/components/ai-elements/image"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import { Source } from "@/components/ai-elements/sources"
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool"
import {
  WebPreview,
  WebPreviewBody,
} from "@/components/ai-elements/web-preview"
import { useOptionalDesktopPanel } from "@/components/desktop-panel"
import { findLiveBrowser } from "@/components/live-browser"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { toast } from "@/components/ui/toast"
import type { Bot } from "@/db/schema"
import { USAGE_LIMIT_ERROR } from "@/lib/billing"
import { WEB_TASK_MAX_STEPS } from "@/lib/monitor-rules"
import { usePaywall } from "@/hooks/use-paywall"
import type { ChatUIMessage } from "@/lib/sandbox-tools"
import type { chatAgent } from "@/trigger/chat"

type ChatBot = Pick<Bot, "id" | "name" | "avatar">

// How long a sent message may wait for the reply's first chunk. A run no worker
// picks up never streams or fails, and the transport retries for minutes first.
const REPLY_START_TIMEOUT_MS = 90_000

function showReplyFailed() {
  toast.add({
    type: "error",
    title: "The reply didn't arrive",
    description: "Something went wrong. Try again.",
  })
}

type ToolPart = Extract<
  ChatUIMessage["parts"][number],
  { type: `tool-${string}` }
>

const toolTitles: Record<ToolPart["type"], string> = {
  "tool-bash": "Run command",
  "tool-readFile": "Read file",
  "tool-writeFile": "Write file",
  "tool-listFiles": "List files",
  "tool-recall": "Recall",
  "tool-remember": "Remember",
  "tool-mouseClick": "Click",
  "tool-mouseMove": "Move mouse",
  "tool-mouseDrag": "Drag",
  "tool-mouseScroll": "Scroll",
  "tool-keyboardType": "Type",
  "tool-keyboardPress": "Press key",
  "tool-viewScreen": "Look at screen",
  "tool-showScreen": "Show screen",
  "tool-handoff": "Hand off",
  "tool-webSearch": "Search the web with TinyFish",
  "tool-webFetch": "Read pages with TinyFish",
  "tool-webTask": "Use a website",
  "tool-watchPage": "Watch a page",
  "tool-watchTopic": "Watch a topic",
  "tool-listWatches": "List watches",
  "tool-stopWatching": "Stop watching",
}

// Web results come from third parties and may hold javascript: URLs, so only
// these protocols are linked or framed
function safeUrl(url: string | undefined, protocols = ["http:", "https:"]) {
  try {
    return url && protocols.includes(new URL(url).protocol) ? url : undefined
  } catch {
    return undefined
  }
}

// `live` is only true while this part's turn is streaming, so a stopped run or
// one loaded from the transcript never frames a stream that may be gone
function ToolCall({ part, live }: { part: ToolPart; live: boolean }) {
  // The one tool whose result is for the reader: show it, not the call
  if (part.type === "tool-showScreen" && part.state === "output-available") {
    return (
      <Image
        alt="The sandbox's screen"
        base64={part.output.base64}
        className="border"
        mediaType={part.output.mediaType}
      />
    )
  }

  // The teammate's reply follows right below, so one line is enough
  if (part.type === "tool-handoff" && part.state === "output-available") {
    return (
      <p className="text-muted-foreground">Handed off to {part.output.name}</p>
    )
  }

  return (
    // Open from the start so the live browser shows without a click
    <Tool defaultOpen={part.type === "tool-webTask"}>
      <ToolHeader
        // A preliminary result means the tool is still running, but only while
        // its turn is. A stopped or reloaded part keeps its last preliminary
        // result: not finished, so not Completed, and not Running either.
        state={
          part.state === "output-available" && part.preliminary
            ? live
              ? "input-available"
              : "input-streaming"
            : part.state
        }
        title={toolTitles[part.type]}
        type={part.type}
      />
      <ToolContent>
        <ToolCallDetails part={part} live={live} />
      </ToolContent>
    </Tool>
  )
}

function ToolCallDetails({ part, live }: { part: ToolPart; live: boolean }) {
  const desktopPanel = useOptionalDesktopPanel()
  const error = part.state === "output-error" ? part.errorText : undefined

  if (part.type === "tool-webSearch") {
    return (
      <>
        {part.input === undefined ? null : <ToolInput input={part.input} />}
        <ToolOutput
          errorText={error}
          output={
            part.state === "output-available" ? (
              // The tool card already collapses, so the sources are not collapsed again
              <ul className="flex flex-col gap-2 p-3">
                {part.output.results.map((result, i) => {
                  const href = safeUrl(result.url)
                  return (
                    <li key={i}>
                      {href ? (
                        <Source href={href} title={result.title} />
                      ) : (
                        <p className="font-medium">{result.title}</p>
                      )}
                      <p className="text-muted-foreground">{result.snippet}</p>
                    </li>
                  )
                })}
              </ul>
            ) : undefined
          }
        />
      </>
    )
  }

  // The page text is for the bot; the reader only needs to know what it read
  if (part.type === "tool-webFetch") {
    return (
      <>
        {part.input === undefined ? null : <ToolInput input={part.input} />}
        <ToolOutput
          errorText={error}
          output={
            part.state === "output-available" ? (
              <ul className="flex flex-col gap-2 p-3">
                {part.output.pages.map((page, i) => {
                  const href = safeUrl(page.url)
                  return (
                    <li key={i}>
                      <p className="font-medium">{page.title || page.url}</p>
                      {href ? (
                        <a
                          className="break-all text-muted-foreground underline"
                          href={href}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {page.url}
                        </a>
                      ) : (
                        <p className="break-all text-muted-foreground">
                          {page.url}
                        </p>
                      )}
                    </li>
                  )
                })}
                {part.output.errors.map((failed, i) => (
                  <li key={`error-${i}`} className="break-all text-destructive">
                    Could not read {failed.url}
                  </li>
                ))}
              </ul>
            ) : undefined
          }
        />
      </>
    )
  }

  if (part.type === "tool-webTask") {
    const output = part.state === "output-available" ? part.output : undefined
    const progress =
      live && part.state === "output-available" && part.preliminary
        ? output?.status === "done"
          ? undefined
          : output
        : undefined
    const liveUrl = safeUrl(progress?.liveUrl, ["https:"])
    const stepText = `${
      progress?.steps
        ? `Step ${progress.steps} / ${WEB_TASK_MAX_STEPS}`
        : "Starting"
    }${progress?.step ? `: ${progress.step}` : ""}`

    return (
      <>
        {part.input?.goal ? (
          <Collapsible className="space-y-2">
            <CollapsibleTrigger className="text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground">
              Goal
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="text-sm whitespace-pre-wrap">{part.input.goal}</p>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {/* A direct chat shows the live browser in its side panel */}
        {liveUrl && desktopPanel ? (
          <p className="text-sm text-muted-foreground">
            Browsing live in the side panel. {stepText}
          </p>
        ) : liveUrl ? (
          <div className="space-y-2">
            <WebPreview className="aspect-video h-auto">
              <WebPreviewBody
                src={liveUrl}
                title="Live browser"
                referrerPolicy="no-referrer"
              />
            </WebPreview>
            <p className="text-xs text-muted-foreground">
              Live, view only. {stepText}
            </p>
          </div>
        ) : null}
        <ToolOutput
          errorText={error}
          output={
            output?.status === "done" ? (
              <>
                {output.blocked ? (
                  <p className="p-3 text-destructive">
                    The site showed a captcha or block page, so this result may
                    be incomplete.
                  </p>
                ) : null}
                <CodeBlock
                  code={JSON.stringify(output.result ?? null, null, 2)}
                  language="json"
                />
              </>
            ) : undefined
          }
        />
      </>
    )
  }

  // Screenshots are for the bot's eyes and stay out of the chat
  if (part.type === "tool-viewScreen" || part.type === "tool-showScreen") {
    return (
      <ToolOutput
        errorText={error}
        output={
          part.state === "output-available" ? (
            <p className="p-3 text-muted-foreground">
              {part.type === "tool-viewScreen"
                ? "Took a screenshot for its own use."
                : "Took a screenshot."}
            </p>
          ) : undefined
        }
      />
    )
  }

  if (part.type === "tool-bash") {
    return (
      <>
        {part.input?.command ? (
          <CodeBlock code={part.input.command} language="bash" />
        ) : null}
        <ToolOutput
          errorText={error}
          output={
            part.state === "output-available" ? (
              <CodeBlock
                code={part.output.output || `Exit code ${part.output.exitCode}`}
                language="log"
              />
            ) : undefined
          }
        />
      </>
    )
  }

  return (
    <>
      {part.input === undefined ? null : <ToolInput input={part.input} />}
      <ToolOutput
        errorText={error}
        output={part.state === "output-available" ? part.output : undefined}
      />
    </>
  )
}

// A reply is one message even when a handoff changes who is writing it, so it
// is cut at each handoff and every stretch gets its own author. Only a group
// chat passes bots, so only its replies get a face.
function splitByAuthor(message: ChatUIMessage, bots: ChatBot[]) {
  const findBot = (botId?: string) => bots.find((bot) => bot.id === botId)

  let section = {
    author:
      message.role === "assistant"
        ? findBot(message.metadata?.botId)
        : undefined,
    parts: [] as ChatUIMessage["parts"],
  }
  const sections = [section]

  for (const part of message.parts) {
    section.parts.push(part)

    if (part.type === "tool-handoff" && part.state === "output-available") {
      section = { author: findBot(part.output.botId), parts: [] }
      sections.push(section)
    }
  }

  return sections
}

// `bots` are a group chat's members to pick from; a direct chat passes none
function Chat({ chatId, bots }: { chatId: string; bots?: ChatBot[] }) {
  const transport = useTriggerChatTransport<typeof chatAgent>({
    task: "chat",
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) =>
      startChatSession({ chatId, clientData }),
  })
  const { messages, isLoading } = useLoadTranscript(chatId, loadTranscript, {
    transport,
  })

  // useChat only reads its initial messages on mount, so wait for the transcript
  if (isLoading) return null

  return (
    <ChatMessages
      key={chatId}
      chatId={chatId}
      bots={bots}
      initialMessages={messages}
      transport={transport}
    />
  )
}

function ChatMessages({
  chatId,
  bots = [],
  initialMessages,
  transport,
}: {
  chatId: string
  bots?: ChatBot[]
  initialMessages: ChatUIMessage[]
  transport: TriggerChatTransport
}) {
  const { checkPlan, showUsageLimit } = usePaywall()
  const { messages, sendMessage, status, stop } = useChat<ChatUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
    // The agent refuses a turn once the period's allowance is spent
    onError: (error) => {
      if (error.message === USAGE_LIMIT_ERROR) return showUsageLimit("ai")

      // Handled here, so nothing else tells us a reply never arrived
      Sentry.logger.error("Chat reply failed", {
        "chat.id": chatId,
        "error.type": error.name,
        "error.message": error.message,
      })
      showReplyFailed()
    },
  })

  useEffect(() => {
    if (status !== "submitted") return
    const timer = setTimeout(() => {
      stop()
      Sentry.logger.error("Chat reply never started", { "chat.id": chatId })
      showReplyFailed()
    }, REPLY_START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [status, stop, chatId])
  const desktopPanel = useOptionalDesktopPanel()
  const setLiveBrowser = desktopPanel?.setLiveBrowser
  const liveBrowser = findLiveBrowser(messages.at(-1), status === "streaming")
  const { url, step, steps } = liveBrowser ?? {}
  // Primitive deps, so a new object every render does not loop through the panel
  useEffect(() => {
    setLiveBrowser?.(url ? { url, step, steps } : undefined)
  }, [setLiveBrowser, url, step, steps])
  useEffect(() => () => setLiveBrowser?.(undefined), [setLiveBrowser])

  // The bot the next message goes to, in a group chat
  const [botId, setBotId] = useState(bots[0]?.id)
  // Falls back to the first one when the picked bot is removed from the group
  const selectedBot = bots.find((bot) => bot.id === botId) ?? bots[0]

  function handleSubmit(message: PromptInputMessage) {
    if (!message.text.trim()) return
    // Throwing keeps the draft in the input
    if (!checkPlan("bots")) throw new Error("Upgrade required")
    // The agent reads this turn's metadata to decide which bot answers
    // and the message keeps it too, to show who it was for
    const metadata = selectedBot && { botId: selectedBot.id }
    sendMessage({ text: message.text, metadata }, { metadata })
  }

  return (
    <div data-slot="chat" className="flex min-h-0 flex-1 flex-col">
      <Conversation>
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.flatMap((message) => {
            // The bot a group chat's message was sent to
            const addressee =
              message.role === "user"
                ? bots.find((bot) => bot.id === message.metadata?.botId)
                : undefined

            return splitByAuthor(message, bots).map(({ author, parts }, i) => {
              const renderedParts = parts.map((part, j) => {
                if (part.type === "text") {
                  return (
                    <MessageResponse
                      key={`${message.id}-${i}-${j}`}
                      // Flows the first paragraph inline, right after the tag
                      className={
                        addressee && j === 0
                          ? "inline [&>p:first-child]:inline"
                          : undefined
                      }
                    >
                      {part.text}
                    </MessageResponse>
                  )
                }
                if (part.type !== "dynamic-tool" && isToolUIPart(part)) {
                  return (
                    <ToolCall
                      key={part.toolCallId}
                      part={part}
                      live={
                        status === "streaming" &&
                        message.id === messages.at(-1)?.id
                      }
                    />
                  )
                }
                return null
              })

              return (
                <Message
                  from={message.role}
                  key={`${message.id}-${i}`}
                  className={author && "flex-row items-start"}
                >
                  {author && (
                    <ChatAvatar seed={author.avatar} className="size-6" />
                  )}
                  <MessageContent>
                    {addressee ? (
                      // One block, so the tag and the text share a line and the text wraps under it
                      <div>
                        <Badge
                          variant="outline"
                          className="mr-1.5 max-w-40 pl-1 align-top"
                        >
                          <ChatAvatar
                            seed={addressee.avatar}
                            className="size-3.5"
                          />
                          <span className="truncate">{addressee.name}</span>
                        </Badge>
                        {renderedParts}
                      </div>
                    ) : (
                      renderedParts
                    )}
                  </MessageContent>
                </Message>
              )
            })
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4 pt-0">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea placeholder="Send a message..." />
          <PromptInputFooter
            className={selectedBot ? undefined : "justify-end"}
          >
            {selectedBot && (
              <PromptInputTools>
                <PromptInputSelect
                  value={selectedBot.id}
                  onValueChange={(value) => setBotId(value as string)}
                >
                  <PromptInputSelectTrigger aria-label="Bot to talk to">
                    <PromptInputSelectValue>
                      <ChatAvatar
                        seed={selectedBot.avatar}
                        className="size-5"
                      />
                      {selectedBot.name}
                    </PromptInputSelectValue>
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {bots.map((bot) => (
                      <PromptInputSelectItem key={bot.id} value={bot.id}>
                        <ChatAvatar seed={bot.avatar} className="size-5" />
                        {bot.name}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              </PromptInputTools>
            )}
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

export { Chat }
