"use client"

import * as React from "react"
import type RFB from "@novnc/novnc"
import * as Sentry from "@sentry/nextjs"
import { RefreshCwIcon } from "lucide-react"

import { getDesktopUrl } from "@/actions/chat"
import {
  WebPreview,
  WebPreviewBody,
} from "@/components/ai-elements/web-preview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { usePaywall } from "@/hooks/use-paywall"
import type { LiveBrowser } from "@/components/live-browser"
import { WEB_TASK_MAX_STEPS } from "@/lib/monitor-rules"

type DesktopStatus = "idle" | "connecting" | "connected" | "disconnected"

type DesktopPanelContextValue = {
  open: boolean
  toggle: () => void
  status: DesktopStatus
  connect: () => void
  // Moves the one live screen into the given element
  attachScreen: (slot: HTMLElement) => void
  // Whether the screen takes mouse and keyboard input or is only watched
  setInteractive: (interactive: boolean) => void
  // A web task's browser, shown instead of the desktop while it runs
  liveBrowser: LiveBrowser | undefined
  setLiveBrowser: (liveBrowser: LiveBrowser | undefined) => void
}

const DesktopPanelContext =
  React.createContext<DesktopPanelContextValue | null>(null)

function useDesktopPanel() {
  const context = React.useContext(DesktopPanelContext)
  if (!context) {
    throw new Error(
      "useDesktopPanel must be used within a DesktopPanelProvider."
    )
  }
  return context
}

// Undefined outside a DesktopPanelProvider
function useOptionalDesktopPanel() {
  return React.useContext(DesktopPanelContext)
}

function DesktopPanelProvider({
  chatId,
  children,
}: {
  chatId: string
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<DesktopStatus>("idle")
  const [liveBrowser, setLiveBrowser] = React.useState<LiveBrowser>()
  const { checkPlan, checkUsage } = usePaywall()

  // The VNC client draws into this element. It is never rendered by React, so
  // it can be moved between the panel and the dialog without reconnecting.
  const screenRef = React.useRef<HTMLDivElement | null>(null)
  const rfbRef = React.useRef<RFB | null>(null)
  const interactiveRef = React.useRef(false)
  // Only the latest connection attempt may report its status
  const attemptRef = React.useRef(0)

  const getScreen = React.useCallback(() => {
    if (!screenRef.current) {
      screenRef.current = document.createElement("div")
      screenRef.current.className = "size-full"
    }
    return screenRef.current
  }, [])

  const connect = React.useCallback(async () => {
    const attempt = ++attemptRef.current
    rfbRef.current?.disconnect()
    rfbRef.current = null
    setStatus("connecting")
    const startedAt = Date.now()

    try {
      const [url, { default: RFB }] = await Promise.all([
        getDesktopUrl(chatId),
        import("@novnc/novnc"),
      ])
      if (attempt !== attemptRef.current) return

      const rfb = new RFB(getScreen(), url)
      rfb.scaleViewport = true
      rfb.background = "transparent"
      rfb.viewOnly = !interactiveRef.current
      rfb.addEventListener("connect", () => {
        if (attempt !== attemptRef.current) return
        setStatus("connected")
        Sentry.logger.info("Desktop connected", {
          "chat.id": chatId,
          "desktop.connect_ms": Date.now() - startedAt,
        })
        if (interactiveRef.current) rfb.focus()
      })
      rfb.addEventListener("disconnect", (event) => {
        if (attempt !== attemptRef.current) return
        rfbRef.current = null
        setStatus("disconnected")
        // Unclean is the connection dropping, or never opening at all
        if (!event.detail.clean) {
          Sentry.logger.warn("Desktop connection lost", { "chat.id": chatId })
        }
      })
      rfbRef.current = rfb
    } catch (error) {
      if (attempt !== attemptRef.current) return
      setStatus("disconnected")
      Sentry.logger.error("Desktop failed to open", {
        "chat.id": chatId,
        ...(error instanceof Error && { "error.message": error.message }),
      })
    }
  }, [chatId, getScreen])

  const toggle = React.useCallback(async () => {
    if (!open) {
      // Showing the desktop starts the sandbox
      if (!checkPlan("sandboxes") || !(await checkUsage("sandbox"))) return
      // Connect the first time the panel opens and keep it for later opens
      if (status === "idle") connect()
    }
    setOpen(!open)
  }, [open, status, connect, checkPlan, checkUsage])

  const attachScreen = React.useCallback(
    (slot: HTMLElement) => {
      slot.appendChild(getScreen())
    },
    [getScreen]
  )

  const setInteractive = React.useCallback((interactive: boolean) => {
    interactiveRef.current = interactive
    const rfb = rfbRef.current
    if (!rfb) return
    rfb.viewOnly = !interactive
    if (interactive) rfb.focus()
  }, [])

  React.useEffect(() => {
    return () => {
      attemptRef.current++
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [])

  const value = React.useMemo(
    () => ({
      open,
      toggle,
      status,
      connect,
      attachScreen,
      setInteractive,
      liveBrowser,
      setLiveBrowser,
    }),
    [open, toggle, status, connect, attachScreen, setInteractive, liveBrowser]
  )

  return <DesktopPanelContext value={value}>{children}</DesktopPanelContext>
}

function DesktopPanel({ name }: { name: string }) {
  const { open, status, connect, attachScreen, setInteractive, liveBrowser } =
    useDesktopPanel()
  const [fullscreen, setFullscreen] = React.useState(false)
  const [panelSlot, setPanelSlot] = React.useState<HTMLDivElement | null>(null)
  const [dialogSlot, setDialogSlot] = React.useState<HTMLDivElement | null>(
    null
  )

  // The dialog's slot only exists while it is open, and wins while it does
  React.useLayoutEffect(() => {
    const slot = dialogSlot ?? panelSlot
    if (!slot) return
    attachScreen(slot)
    setInteractive(slot === dialogSlot)
  }, [dialogSlot, panelSlot, attachScreen, setInteractive])

  if (!open && !liveBrowser) return null

  const title = `${name}'s computer`

  return (
    <>
      <ResizableHandle withHandle />
      <ResizablePanel id="desktop" defaultSize="55%" minSize="20%">
        {liveBrowser ? (
          <div className="flex h-full flex-col">
            <div className="flex h-12 shrink-0 items-center px-4">
              <p className="text-sm font-medium">
                Live browser, powered by TinyFish
              </p>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 pt-0">
              <WebPreview className="h-auto min-h-0 flex-1">
                <WebPreviewBody
                  src={liveBrowser.url}
                  title="Live browser"
                  referrerPolicy="no-referrer"
                />
              </WebPreview>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {liveBrowser.steps
                  ? `Step ${liveBrowser.steps} / ${WEB_TASK_MAX_STEPS}`
                  : "Starting"}
                {liveBrowser.step ? `: ${liveBrowser.step}` : null}
              </p>
            </div>
          </div>
        ) : (
          <Dialog
            open={fullscreen}
            onOpenChange={(open, eventDetails) => {
              // Escape belongs to the desktop; only the close button closes
              if (!open && eventDetails.reason !== "close-press") return
              setFullscreen(open)
            }}
            disablePointerDismissal
          >
            <div className="flex h-full flex-col">
              <div className="flex h-12 shrink-0 items-center justify-between px-4">
                <p className="text-sm font-medium">{title}</p>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reconnect"
                  disabled={status === "connecting"}
                  onClick={connect}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
              <div className="relative m-4 mt-0 min-h-0 flex-1 overflow-hidden rounded-xl bg-muted ring-1 ring-foreground/10">
                <div ref={setPanelSlot} className="absolute inset-0" />
                {status === "connected" ? (
                  <DialogTrigger
                    aria-label={`Open ${title} in fullscreen`}
                    className="absolute inset-0 cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                    {status === "disconnected" ? (
                      "Screen disconnected"
                    ) : (
                      <Spinner />
                    )}
                  </div>
                )}
              </div>
            </div>
            <DialogContent
              initialFocus={false}
              className="flex h-svh max-w-none flex-col gap-0 rounded-none p-0 ring-0 sm:max-w-none"
            >
              <DialogHeader className="h-12 shrink-0 justify-center border-b px-4">
                <DialogTitle>{title}</DialogTitle>
              </DialogHeader>
              <div ref={setDialogSlot} className="min-h-0 flex-1 bg-muted" />
            </DialogContent>
          </Dialog>
        )}
      </ResizablePanel>
    </>
  )
}

export {
  DesktopPanel,
  DesktopPanelProvider,
  useDesktopPanel,
  useOptionalDesktopPanel,
}
