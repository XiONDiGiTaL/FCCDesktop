import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  AgentRuntimeInfo,
  AppSettings,
  Attachment,
  ChatMessage,
  ConnectionStatus,
  Conversation,
  ConversationSummary,
  DeepPartial,
  MessageBlock,
  MessageSegment,
  ModelCatalog,
  ModelInfo,
  SettingsEnvelope,
  ToolState,
} from '../shared/types'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import Composer from './components/Composer'
import SettingsPanel from './components/Settings'
import ActivityRail from './components/ActivityRail'
import { Button, Modal } from './components/ui'
import { friendlyError } from './lib/format'

const api = window.fcc

interface ConfirmRequest {
  title: string
  body: string
  confirmLabel: string
  tone?: 'danger' | 'primary'
  onConfirm: () => void
}

type Phase = 'idle' | 'thinking' | 'working' | 'waiting'

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function preferredModel(models: ModelInfo[], configured: string): string {
  if (configured) return configured
  const sonnet = models.find((model) => model.id === 'claude-sonnet-5-5')
  if (sonnet) return sonnet.id
  const plain = models.find((model) => !model.noThinking)
  return plain?.id ?? models[0]?.id ?? ''
}

function titleFromText(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? 'New conversation'
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine || 'New conversation'
}

function ensureSegment(message: ChatMessage, apiMessageId: string): MessageSegment {
  let segment = message.segments.find((item) => item.apiMessageId === apiMessageId)
  if (!segment) {
    segment = { apiMessageId, blocks: [] }
    message.segments.push(segment)
  }
  return segment
}

function setBlock(segment: MessageSegment, index: number, block: MessageBlock): void {
  while (segment.blocks.length < index) segment.blocks.push({ kind: 'text', text: '' })
  segment.blocks[index] = block
}

function findTool(message: ChatMessage, toolId: string): ToolState | null {
  for (const segment of message.segments) {
    for (const block of segment.blocks) {
      if (block.kind === 'tool' && block.tool.id === toolId) return block.tool
    }
  }
  return null
}

function projectEvent(conversation: Conversation, event: AgentEvent): ChatMessage | null {
  if (event.type === 'session') {
    if (event.sessionId) conversation.sessionId = event.sessionId
    return null
  }
  if (event.type === 'exit') {
    const streaming = conversation.messages.find((item) => item.status === 'streaming')
    if (streaming && event.cancelled) {
      streaming.status = 'stopped'
      return streaming
    }
    return null
  }
  if (event.type === 'error') {
    const target = event.turnId
      ? conversation.messages.find((item) => item.id === event.turnId)
      : [...conversation.messages].reverse().find((item) => item.role === 'assistant')
    if (!target) return null
    target.status = 'error'
    target.error = event.detail ? `${event.message}\n${event.detail}` : event.message
    return target
  }

  const turnId = 'turnId' in event ? event.turnId : ''
  const message = conversation.messages.find((item) => item.id === turnId)
  if (!message) return null

  switch (event.type) {
    case 'turn-start':
      message.status = 'streaming'
      return message
    case 'message-start':
      ensureSegment(message, event.apiMessageId)
      return message
    case 'block-start': {
      const segment = ensureSegment(message, event.apiMessageId)
      if (event.block.kind === 'tool') {
        setBlock(segment, event.index, {
          kind: 'tool',
          tool: {
            id: event.block.toolId ?? newId(),
            name: event.block.name ?? 'tool',
            input: {},
            inputComplete: false,
            output: null,
            status: 'running',
          },
        })
      } else {
        setBlock(segment, event.index, { kind: event.block.kind, text: '' })
      }
      return message
    }
    case 'text-delta':
    case 'thinking-delta': {
      const segment = ensureSegment(message, event.apiMessageId)
      const existing = segment.blocks[event.index]
      const kind = event.type === 'text-delta' ? 'text' : 'thinking'
      if (!existing || existing.kind !== kind) {
        setBlock(segment, event.index, { kind, text: event.text })
      } else {
        existing.text += event.text
      }
      return message
    }
    case 'message-snapshot': {
      const segment = ensureSegment(message, event.apiMessageId)
      const previousTools = new Map<string, ToolState>()
      for (const block of segment.blocks) {
        if (block.kind === 'tool') previousTools.set(block.tool.id, block.tool)
      }
      segment.blocks = event.blocks.map((block) => {
        if (block.kind === 'tool') {
          const previous = previousTools.get(block.id)
          return {
            kind: 'tool' as const,
            tool: {
              id: block.id,
              name: block.name,
              input: block.input,
              inputComplete: true,
              output: previous?.output ?? null,
              status: previous?.status ?? 'running',
            },
          }
        }
        if (block.kind === 'thinking') {
          return {
            kind: 'thinking' as const,
            text: block.text,
            durationMs: event.thinkingDurationMs ?? undefined,
          }
        }
        return { kind: 'text' as const, text: block.text }
      })
      return message
    }
    case 'tool-input': {
      const tool = findTool(message, event.toolId)
      if (tool) {
        tool.input = event.input
        tool.inputComplete = true
      }
      return message
    }
    case 'tool-result': {
      const tool = findTool(message, event.toolId)
      if (tool) {
        tool.output = event.output
        tool.status = event.isError ? 'error' : 'ok'
        tool.inputComplete = true
      }
      return message
    }
    case 'turn-end':
      message.status = event.cancelled ? 'stopped' : event.isError ? 'error' : 'complete'
      message.meta = {
        ...(message.meta ?? {}),
        costUsd: event.costUsd ?? message.meta?.costUsd,
        durationMs: event.durationMs ?? message.meta?.durationMs,
        numTurns: event.numTurns ?? message.meta?.numTurns,
        inputTokens: event.inputTokens ?? message.meta?.inputTokens,
        outputTokens: event.outputTokens ?? message.meta?.outputTokens,
        permissionDenials: event.permissionDenials,
      }
      return message
    case 'status':
      return null
    default:
      return null
  }
}

export default function App() {
  const [settingsEnvelope, setSettingsEnvelope] = useState<SettingsEnvelope | null>(null)
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [summaries, setSummaries] = useState<ConversationSummary[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [runtime, setRuntime] = useState<AgentRuntimeInfo | null>(null)
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [toast, setToast] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [ready, setReady] = useState(false)

  const cache = useRef(new Map<string, Conversation>())
  const activeIdRef = useRef<string | null>(null)
  const saveTimers = useRef(new Map<string, number>())
  const flushHandle = useRef<number | null>(null)
  const dirtyIds = useRef(new Set<string>())
  const summariesTimer = useRef<number | null>(null)
  const eventHandler = useRef<(event: AgentEvent) => void>(() => {})

  const settings = settingsEnvelope?.settings ?? null
  const models = catalog?.models ?? []

  const refreshSummaries = useCallback(async () => {
    try {
      const list = await api.conversations.list()
      setSummaries(list)
    } catch (error) {
      console.error('Could not load conversations', error)
    }
  }, [])

  const scheduleSummaries = useCallback(() => {
    if (summariesTimer.current) return
    summariesTimer.current = window.setTimeout(() => {
      summariesTimer.current = null
      void refreshSummaries()
    }, 350)
  }, [refreshSummaries])

  const persist = useCallback((conversation: Conversation, immediate = false) => {
    const run = async () => {
      saveTimers.current.delete(conversation.id)
      try {
        await api.conversations.update(conversation.id, {
          title: conversation.title,
          pinned: conversation.pinned,
          model: conversation.model,
          workspacePath: conversation.workspacePath,
          sessionId: conversation.sessionId,
          additionalDirs: conversation.additionalDirs,
          messages: conversation.messages,
        })
        scheduleSummaries()
      } catch (error) {
        console.error('Failed to save conversation', error)
      }
    }
    const pending = saveTimers.current.get(conversation.id)
    if (pending) window.clearTimeout(pending)
    if (immediate) void run()
    else saveTimers.current.set(conversation.id, window.setTimeout(run, 700))
  }, [scheduleSummaries])

  const flushView = useCallback((conversationId: string) => {
    dirtyIds.current.add(conversationId)
    if (flushHandle.current !== null) return
    flushHandle.current = window.requestAnimationFrame(() => {
      flushHandle.current = null
      const dirty = new Set(dirtyIds.current)
      dirtyIds.current.clear()
      const activeId = activeIdRef.current
      if (!activeId || !dirty.has(activeId)) return
      const conversation = cache.current.get(activeId)
      if (conversation) setActive({ ...conversation })
    })
  }, [])

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      const conversation = cache.current.get(event.conversationId)
      if (!conversation) return
      const touched = projectEvent(conversation, event)
      if (event.type === 'session') {
        persist(conversation)
        setRuntime((current) => ({
          conversationId: conversation.id,
          sessionId: event.sessionId || current?.sessionId || conversation.sessionId,
          model: event.model ?? current?.model ?? conversation.model,
          workingDirectory: event.cwd ?? current?.workingDirectory ?? null,
          additionalDirs: conversation.additionalDirs,
          busy: current?.busy ?? false,
          startedAt: current?.startedAt ?? Date.now(),
          toolCount: event.toolCount,
        }))
      }
      if (event.type === 'status') {
        if (activeIdRef.current === conversation.id) setPhase(event.phase)
        return
      }
      if (touched) flushView(conversation.id)
      if (event.type === 'exit') {
        if (activeIdRef.current === conversation.id) setPhase('idle')
        conversation.updatedAt = Date.now()
        persist(conversation, true)
        void refreshSummaries()
        void api.agent.runtime(conversation.id).then(setRuntime).catch(() => setRuntime(null))
      }
      if (event.type === 'turn-end') {
        conversation.updatedAt = Date.now()
        if (activeIdRef.current === conversation.id) setPhase('idle')
        persist(conversation, true)
        void refreshSummaries()
        void api.agent.runtime(conversation.id).then(setRuntime).catch(() => setRuntime(null))
      }
      if (event.type === 'error') {
        conversation.updatedAt = Date.now()
        if (activeIdRef.current === conversation.id) setPhase('idle')
        persist(conversation, true)
        setToast({ kind: 'error', text: event.message })
      }
    },
    [flushView, persist, refreshSummaries],
  )

  eventHandler.current = handleEvent

  const openConversation = useCallback(async (id: string) => {
    const existing = cache.current.get(id)
    const conversation = existing ?? (await api.conversations.get(id))
    if (!conversation) {
      setToast({ kind: 'error', text: 'That conversation could not be loaded.' })
      return
    }
    for (const message of conversation.messages) {
      if (message.status === 'streaming') message.status = 'stopped'
    }
    cache.current.set(id, conversation)
    activeIdRef.current = id
    setActive({ ...conversation })
    setDraft('')
    setAttachments([])
    try {
      const info = await api.agent.runtime(id)
      setRuntime(info)
    } catch {
      setRuntime(null)
    }
  }, [])

  // --------------------------------------------------------------- bootstrap
  useEffect(() => {
    void (async () => {
      try {
        const [envelope, initialStatus, list] = await Promise.all([
          api.settings.get(),
          api.connection.status(),
          api.conversations.list(),
        ])
        setSettingsEnvelope(envelope)
        setStatus(initialStatus)
        setSummaries(list)
        setSidebarCollapsed(envelope.settings.ui.sidebarCollapsed)
        setActivityOpen(envelope.settings.ui.activityOpen)
        if (list.length > 0 && list[0]) await openConversation(list[0].id)
        setReady(true)
        void api.connection.probe().then(setStatus).catch(() => {})
        void api.connection.models().then(setCatalog).catch(() => {})
      } catch (error) {
        setToast({ kind: 'error', text: friendlyError(error) })
        setReady(true)
      }
    })()
  }, [openConversation])

  useEffect(() => {
    const offAgent = api.agent.onEvent((event) => eventHandler.current(event))
    const offStatus = api.connection.onStatus((next) => setStatus(next))
    const offChanged = api.conversations.onChanged(() => void refreshSummaries())
    const offWindow = api.app.onWindowState((state) => setMaximized(state.maximized))
    return () => {
      offAgent()
      offStatus()
      offChanged()
      offWindow()
    }
  }, [refreshSummaries])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // ---------------------------------------------------------------- settings
  const patchSettings = useCallback(async (patch: DeepPartial<AppSettings>) => {
    try {
      const envelope = await api.settings.update(patch)
      setSettingsEnvelope(envelope)
      if (patch.ui?.sidebarCollapsed !== undefined) setSidebarCollapsed(Boolean(patch.ui.sidebarCollapsed))
      if (patch.ui?.activityOpen !== undefined) setActivityOpen(Boolean(patch.ui.activityOpen))
      return envelope
    } catch (error) {
      setToast({ kind: 'error', text: friendlyError(error) })
      return null
    }
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      void patchSettings({ ui: { sidebarCollapsed: !current } })
      return !current
    })
  }, [patchSettings])

  const toggleActivity = useCallback(() => {
    setActivityOpen((current) => {
      void patchSettings({ ui: { activityOpen: !current } })
      return !current
    })
  }, [patchSettings])

  // ----------------------------------------------------------- conversations
  const createConversation = useCallback(
    async (workspacePath?: string) => {
      try {
        const conversation = await api.conversations.create({
          model: preferredModel(models, settings?.agent.defaultModel ?? ''),
          workspacePath: workspacePath ?? null,
        })
        cache.current.set(conversation.id, conversation)
        activeIdRef.current = conversation.id
        setActive({ ...conversation })
        setDraft('')
        setAttachments([])
        setRuntime(null)
        setPhase('idle')
        await refreshSummaries()
      } catch (error) {
        setToast({ kind: 'error', text: friendlyError(error) })
      }
    },
    [models, refreshSummaries, settings?.agent.defaultModel],
  )

  const deleteConversation = useCallback(
    (id: string) => {
      const conversation = cache.current.get(id)
      const label = conversation?.title ?? 'this conversation'
      setConfirm({
        title: 'Delete conversation',
        body: `“${label}” and its messages will be permanently removed from this computer.`,
        confirmLabel: 'Delete',
        tone: 'danger',
        onConfirm: () => {
          void (async () => {
            try {
              await api.conversations.remove(id)
              cache.current.delete(id)
              saveTimers.current.delete(id)
              if (activeIdRef.current === id) {
                activeIdRef.current = null
                setActive(null)
                setRuntime(null)
              }
              await refreshSummaries()
            } catch (error) {
              setToast({ kind: 'error', text: friendlyError(error) })
            }
          })()
        },
      })
    },
    [refreshSummaries],
  )

  const renameConversation = useCallback(
    (title: string) => {
      const conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) : null
      if (!conversation) return
      const trimmed = title.trim()
      if (!trimmed || trimmed === conversation.title) return
      conversation.title = trimmed.slice(0, 200)
      setActive({ ...conversation })
      persist(conversation, true)
    },
    [persist],
  )

  const pinConversation = useCallback(
    async (id: string, pinned: boolean) => {
      const conversation = cache.current.get(id)
      try {
        await api.conversations.update(id, { pinned })
        if (conversation) conversation.pinned = pinned
        await refreshSummaries()
      } catch (error) {
        setToast({ kind: 'error', text: friendlyError(error) })
      }
    },
    [refreshSummaries],
  )

  const setModel = useCallback(
    async (modelId: string) => {
      const conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) : null
      if (!conversation) {
        await patchSettings({ agent: { defaultModel: modelId } })
        return
      }
      conversation.model = modelId
      setActive({ ...conversation })
      persist(conversation, true)
    },
    [patchSettings, persist],
  )

  const setWorkspace = useCallback(
    async (path: string | null) => {
      let conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) : null
      if (!conversation) {
        await createConversation(path ?? undefined)
        conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) ?? null : null
      }
      if (!conversation) return
      conversation.workspacePath = path
      setActive({ ...conversation })
      persist(conversation, true)
    },
    [createConversation, persist],
  )

  const addWorkspace = useCallback(async () => {
    try {
      const path = await api.dialogs.pickDirectory()
      if (!path) return
      const current = settingsEnvelope?.settings.workspaces ?? []
      if (current.some((workspace) => workspace.path.toLowerCase() === path.toLowerCase())) {
        setToast({ kind: 'info', text: 'That workspace is already linked.' })
        return
      }
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
      await patchSettings({
        workspaces: [...current, { id: newId(), name, path, addedAt: Date.now() }],
      })
    } catch (error) {
      setToast({ kind: 'error', text: friendlyError(error) })
    }
  }, [patchSettings, settingsEnvelope?.settings.workspaces])

  const removeWorkspace = useCallback(
    async (id: string) => {
      const current = settingsEnvelope?.settings.workspaces ?? []
      await patchSettings({ workspaces: current.filter((workspace) => workspace.id !== id) })
    },
    [patchSettings, settingsEnvelope?.settings.workspaces],
  )

  // ------------------------------------------------------------- attachments
  const addAttachments = useCallback(async (incoming: Attachment[]) => {
    if (incoming.length === 0) return
    setAttachments((current) => {
      const merged = [...current]
      for (const attachment of incoming) {
        if (!merged.some((item) => item.path.toLowerCase() === attachment.path.toLowerCase())) {
          merged.push(attachment)
        }
      }
      return merged.slice(0, 20)
    })
  }, [])

  const pickFiles = useCallback(async () => {
    try {
      const files = await api.dialogs.pickFiles()
      await addAttachments(files)
    } catch (error) {
      setToast({ kind: 'error', text: friendlyError(error) })
    }
  }, [addAttachments])

  const pickFolderAttachment = useCallback(async () => {
    try {
      const path = await api.dialogs.pickDirectory()
      if (!path) return
      const [attachment] = await api.files.describe([path])
      if (attachment) await addAttachments([attachment])
    } catch (error) {
      setToast({ kind: 'error', text: friendlyError(error) })
    }
  }, [addAttachments])

  const pickWorkspaceFolder = useCallback(async () => {
    try {
      const path = await api.dialogs.pickDirectory()
      if (path) await setWorkspace(path)
    } catch (error) {
      setToast({ kind: 'error', text: friendlyError(error) })
    }
  }, [setWorkspace])

  // ------------------------------------------------------------------ agent
  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !settings) return
    if (active?.messages.some((message) => message.status === 'streaming')) return

    // Always mutate the cached conversation so agent events and persistence agree.
    let conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) ?? null : null
    if (!conversation) {
      try {
        conversation = await api.conversations.create({
          model: preferredModel(models, settings.agent.defaultModel),
        })
        cache.current.set(conversation.id, conversation)
        activeIdRef.current = conversation.id
      } catch (error) {
        setToast({ kind: 'error', text: friendlyError(error) })
        return
      }
    }

    const model = conversation.model || preferredModel(models, settings.agent.defaultModel)
    const turnId = newId()
    const now = Date.now()

    const userMessage: ChatMessage = {
      id: newId(),
      role: 'user',
      createdAt: now,
      status: 'complete',
      segments: [{ apiMessageId: 'user', blocks: [{ kind: 'text', text }] }],
      attachments: attachments.length ? [...attachments] : undefined,
    }
    const assistantMessage: ChatMessage = {
      id: turnId,
      role: 'assistant',
      createdAt: now + 1,
      status: 'streaming',
      segments: [],
      meta: { model },
    }

    conversation.messages.push(userMessage, assistantMessage)
    conversation.updatedAt = now
    conversation.model = model
    if (!conversation.title || conversation.title === 'New conversation') {
      conversation.title = titleFromText(text)
    }
    const sentAttachments = [...attachments]

    setActive({ ...conversation })
    setDraft('')
    setAttachments([])
    setPhase('thinking')
    persist(conversation, true)

    try {
      const result = await api.agent.send({
        conversationId: conversation.id,
        turnId,
        text,
        attachments: sentAttachments,
        model,
        workingDirectory: conversation.workspacePath ?? settings.agent.workingDirectory,
        additionalDirs: conversation.additionalDirs,
        resumeSessionId: conversation.sessionId,
      })
      if (result.sessionId && !conversation.sessionId) {
        conversation.sessionId = result.sessionId
        persist(conversation)
      }
      void api.agent.runtime(conversation.id).then(setRuntime).catch(() => {})
    } catch (error) {
      const message = friendlyError(error)
      assistantMessage.status = 'error'
      assistantMessage.error = message
      projectionSafeUpdate(conversation.id)
      setPhase('idle')
      setToast({ kind: 'error', text: message })
    }

    function projectionSafeUpdate(id: string) {
      const target = cache.current.get(id)
      if (!target) return
      if (activeIdRef.current === id) setActive({ ...target })
    }
  }, [active, attachments, draft, models, persist, settings])

  const stop = useCallback(async () => {
    if (!active) return
    try {
      const cancelled = await api.agent.cancel(active.id)
      setToast({ kind: cancelled ? 'info' : 'error', text: cancelled ? 'Stopping the agent…' : 'No active agent to stop.' })
    } catch (error) {
      setToast({ kind: 'error', text: friendlyError(error) })
    }
  }, [active])

  const retryFromMessage = useCallback(
    (text: string) => {
      setDraft(text)
    },
    [],
  )

  // --------------------------------------------------------- global hotkeys
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey
      if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createConversation()
      }
      if (meta && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        toggleActivity()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createConversation, toggleActivity])

  useEffect(() => {
    if (activeIdRef.current) void api.agent.runtime(activeIdRef.current).then(setRuntime).catch(() => {})
  }, [active?.id])

  const streamingHere = Boolean(active?.messages.some((message) => message.status === 'streaming'))
  const effectiveWorkingDirectory = active?.workspacePath || settings?.agent.workingDirectory || ''
  const title = active?.title ?? 'New conversation'

  const rootStyle = useMemo(
    () => ({ '--font-scale': String(settings?.ui.fontScale ?? 1) }) as React.CSSProperties,
    [settings?.ui.fontScale],
  )

  const showEmpty = ready && !active

  return (
    <div
      className={`app ${settings?.ui.density === 'compact' ? 'density-compact' : ''} ${
        settings?.ui.reducedMotion ? 'reduce-motion' : ''
      }`}
      style={rootStyle}
    >
      <TitleBar
        maximized={maximized}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onToggleActivity={toggleActivity}
        activityOpen={activityOpen}
        title={title}
      />

      <div className={`app-body ${sidebarCollapsed ? 'sidebar-hidden' : ''}`}>
        <Sidebar
          summaries={summaries}
          activeId={active?.id ?? null}
          search={search}
          onSearch={setSearch}
          onSelect={(id) => void openConversation(id)}
          onNew={() => void createConversation()}
          onDelete={deleteConversation}
          onPin={(id, pinned) => void pinConversation(id, pinned)}
          workspaces={settings?.workspaces ?? []}
          onAddWorkspace={() => void addWorkspace()}
          onUseWorkspace={(path) => void setWorkspace(path)}
          onRemoveWorkspace={(id) => void removeWorkspace(id)}
          status={status}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
        />

        <main className="workspace">
          <div className="workspace-main">
            <ChatView
              conversation={active}
              models={models}
              streaming={streamingHere}
              phase={phase}
              showThinking={settings?.agent.showThinking ?? true}
              empty={showEmpty}
              status={status}
              onRename={renameConversation}
              onReveal={(path) => void api.files.reveal(path)}
              onOpenExternal={(url) => void api.app.openExternal(url)}
              onCopy={(text) => void api.app.copyText(text)}
              onSuggestion={(text) => setDraft(text)}
              onNew={() => void createConversation()}
              onOpenSettings={() => setSettingsOpen(true)}
              onRetry={retryFromMessage}
              workingDirectory={effectiveWorkingDirectory}
            />

            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              onStop={() => void stop()}
              busy={streamingHere}
              phase={phase}
              attachments={attachments}
              onAddFiles={() => void pickFiles()}
              onAddFolder={() => void pickFolderAttachment()}
              onRemoveAttachment={(path) =>
                setAttachments((current) => current.filter((item) => item.path !== path))
              }
              model={active?.model || settings?.agent.defaultModel || ''}
              models={models}
              onSelectModel={(id) => void setModel(id)}
              onRefreshModels={() => void api.connection.models(true).then(setCatalog)}
              catalogError={catalog?.error ?? null}
              workspace={active?.workspacePath ?? null}
              onPickWorkspace={() => void pickWorkspaceFolder()}
              onClearWorkspace={() => void setWorkspace(null)}
              status={status}
              onOpenSettings={() => setSettingsOpen(true)}
              onAddAttachments={(incoming) => void addAttachments(incoming)}
            />
          </div>

          {activityOpen ? (
            <ActivityRail
              conversation={active}
              runtime={runtime}
              phase={phase}
              streaming={streamingHere}
              status={status}
              models={models}
              onClose={toggleActivity}
            />
          ) : null}
        </main>
      </div>

      {settingsEnvelope && settings ? (
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          envelope={settingsEnvelope}
          status={status}
          catalog={catalog}
          runtime={runtime}
          onPatch={patchSettings}
          onStatus={setStatus}
          onCatalog={setCatalog}
          onToast={(kind, text) => setToast({ kind, text })}
          onClearConversationsRequested={() =>
            setConfirm({
              title: 'Delete all conversations',
              body: 'Every conversation stored on this computer will be removed. Settings and credentials are kept.',
              confirmLabel: 'Delete everything',
              tone: 'danger',
              onConfirm: () => {
                void (async () => {
                  await api.conversations.clearAll()
                  cache.current.clear()
                  activeIdRef.current = null
                  setActive(null)
                  setRuntime(null)
                  await refreshSummaries()
                  setToast({ kind: 'info', text: 'All conversations were deleted.' })
                })()
              },
            })
          }
        />
      ) : null}

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} className="modal-confirm">
        {confirm ? (
          <div className="confirm-body">
            <h2>{confirm.title}</h2>
            <p>{confirm.body}</p>
            <div className="confirm-actions">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm.tone === 'danger' ? 'danger' : 'primary'}
                onClick={() => {
                  confirm.onConfirm()
                  setConfirm(null)
                }}
              >
                {confirm.confirmLabel}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {toast ? (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}
    </div>
  )
}
