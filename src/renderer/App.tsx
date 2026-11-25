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
  QueuedMessage,
  SettingsEnvelope,
  ToolState,
} from '../shared/types'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import Composer from './components/Composer'
import SettingsPanel from './components/Settings'
import SkillsView from './components/SkillsView'
import LocalModelsView from './components/LocalModelsView'
import UsageView from './components/UsageView'
import UsageBanner from './components/UsageBanner'
import type { UsageState } from '../shared/usage'
import ActivityRail from './components/ActivityRail'
import type { ActiveSkillsState } from './components/ActiveSkills'
import type { SkillSummary } from '../shared/skills'
import { Button, Modal } from './components/ui'
import { friendlyError } from './lib/format'
import type { InstalledModel } from '../shared/local'
import { isLocalModelId, localModelId } from '../shared/local'
import { chooseFreeModel, inferTaskProfile } from '../shared/free-providers'

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

function preferredModel(
  models: ModelInfo[],
  configured: string,
  prefs: { freeFirst: boolean; allowBillableAccounts: boolean },
): string {
  if (configured) return configured
  if (prefs.freeFirst) {
    const free = chooseFreeModel(models, {
      task: inferTaskProfile('coding agent'),
      allowBillable: prefs.allowBillableAccounts,
      allowLocal: false,
    })
    if (free) return free.id
    // Do not silently substitute a paid default when the free registry is
    // empty. The agent reports the missing free provider instead.
    return ''
  }
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
    case 'turn-retry':
      // The agent replayed the turn; its failed attempt left nothing to keep.
      message.segments = []
      message.error = undefined
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
  const [dragging, setDragging] = useState(false)
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({})
  const [view, setView] = useState<'chat' | 'skills' | 'models' | 'usage'>('chat')
  const [usageState, setUsageState] = useState<UsageState | null>(null)
  const [skillList, setSkillList] = useState<SkillSummary[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [skillsByConversation, setSkillsByConversation] = useState<Record<string, ActiveSkillsState>>({})

  const cache = useRef(new Map<string, Conversation>())
  const activeIdRef = useRef<string | null>(null)
  const saveTimers = useRef(new Map<string, number>())
  const flushHandle = useRef<number | null>(null)
  const dirtyIds = useRef(new Set<string>())
  const summariesTimer = useRef<number | null>(null)
  const eventHandler = useRef<(event: AgentEvent) => void>(() => {})
  const queuesRef = useRef<Record<string, QueuedMessage[]>>({})
  const interruptRef = useRef<{ conversationId: string; item: QueuedMessage; timer: number | null } | null>(null)
  const afterTurnRef = useRef<(conversationId: string) => void>(() => {})

  const settings = settingsEnvelope?.settings ?? null
  const models = catalog?.models ?? []
  const [localInstalled, setLocalInstalled] = useState<InstalledModel[]>([])

  const refreshLocalModels = useCallback(async () => {
    try {
      const next = await api.local.state()
      setLocalInstalled(next.installed)
    } catch (error) {
      console.error('Could not read the local model library', error)
    }
  }, [])

  // Installed GGUF files belong in the composer: FCC routes a `llamacpp/<alias>`
  // id to the llama.cpp provider this app points at, but its own catalog never
  // lists them, so they are merged in ahead of the hosted models.
  const pickerModels = useMemo<ModelInfo[]>(() => {
    const local: ModelInfo[] = localInstalled.map((model) => ({
      id: localModelId(model.path),
      displayName: model.filename.replace(/\.gguf$/i, ''),
      provider: 'llamacpp',
      group: 'Local models',
      noThinking: false,
      free: true,
      freeBasis: 'local',
      requiresOptIn: false,
      local: true,
    }))
    return [...local, ...models]
  }, [localInstalled, models])

  useEffect(() => {
    void refreshLocalModels()
    return api.local.onChanged(() => void refreshLocalModels())
  }, [refreshLocalModels])

  /** Loads `llamacpp/<alias>` in llama-server; a message means it failed. */
  const ensureLocalModel = useCallback(
    async (modelId: string): Promise<string | null> => {
      try {
        const status = await api.local.ensureModel(modelId)
        return status.running ? null : status.message ?? 'The local model server did not start.'
      } catch (error) {
        return friendlyError(error)
      } finally {
        void refreshLocalModels()
      }
    },
    [refreshLocalModels],
  )

  const prepareLocalModel = useCallback(
    async (modelId: string) => {
      const failure = await ensureLocalModel(modelId)
      if (failure) setToast({ kind: 'error', text: failure })
      else setToast({ kind: 'info', text: `${modelId} is loaded and ready for this conversation.` })
    },
    [ensureLocalModel],
  )

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
          queue: conversation.queue,
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
      if (event.type === 'skills-active') {
        setSkillsByConversation((current) => ({
          ...current,
          [event.conversationId]: {
            turnId: event.turnId,
            invocations: event.invocations,
            delivery: event.delivery,
            notes: event.notes,
          },
        }))
        return
      }
      const conversation = cache.current.get(event.conversationId)
      if (!conversation) return
      if (event.type === 'model-fallback') {
        conversation.model = event.to
        const streaming = conversation.messages.find((message) => message.status === 'streaming')
        if (streaming) streaming.meta = { ...streaming.meta, model: event.to }
        conversation.updatedAt = Date.now()
        if (activeIdRef.current === conversation.id) {
          setActive({ ...conversation })
          setToast({ kind: 'info', text: `Free fallback: ${event.fromProvider} to ${event.toProvider}` })
        }
        setRuntime((current) => (current ? { ...current, model: event.to } : current))
        persist(conversation, true)
        return
      }
      if (event.type === 'free-unavailable') {
        if (activeIdRef.current === conversation.id) setToast({ kind: 'error', text: event.message })
        return
      }
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
        // A queued turn may already be running, so only fall idle when nothing
        // in this conversation is still streaming.
        if (
          activeIdRef.current === conversation.id &&
          !conversation.messages.some((item) => item.status === 'streaming')
        ) {
          setPhase('idle')
        }
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
        afterTurnRef.current(conversation.id)
      }
      if (event.type === 'error') {
        conversation.updatedAt = Date.now()
        if (activeIdRef.current === conversation.id) setPhase('idle')
        persist(conversation, true)
        setToast({ kind: 'error', text: event.message })
        afterTurnRef.current(conversation.id)
      }
    },
    [flushView, persist, refreshSummaries],
  )

  eventHandler.current = handleEvent

  const refreshSkills = useCallback(async () => {
    const activeId = activeIdRef.current
    const projectPath = activeId ? cache.current.get(activeId)?.workspacePath ?? null : null
    try {
      const catalog = await api.skills.catalog({ projectPath })
      setSkillList(catalog.skills)
    } catch (error) {
      console.error('Could not load skills', error)
    }
  }, [])

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

    // Restore anything that was queued before the app quit.
    const restored = conversation.queue ?? []
    const nextQueues = { ...queuesRef.current }
    if (restored.length > 0) nextQueues[id] = restored
    else delete nextQueues[id]
    queuesRef.current = nextQueues
    setQueues(nextQueues)

    setActive({ ...conversation })
    setView('chat')
    setDraft('')
    setAttachments([])
    setSelectedSkills([])
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
    const offSkills = api.skills.onChanged(() => void refreshSkills())
    const offUsage = api.usage.onChanged((next) => setUsageState(next))
    void api.usage.state().then(setUsageState).catch(() => {})
    return () => {
      offAgent()
      offStatus()
      offChanged()
      offWindow()
      offSkills()
      offUsage()
    }
  }, [refreshSkills, refreshSummaries])

  useEffect(() => {
    void refreshSkills()
  }, [active?.workspacePath, refreshSkills])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // When a reported cooldown ends, ask once for fresh status instead of
  // leaving the banner stale until the next poll.
  useEffect(() => {
    const until = usageState?.provider.cooldownUntil
    if (!until) return
    const delay = until - Date.now()
    if (delay <= 0) return
    const timer = window.setTimeout(() => {
      void api.usage.refresh().then(setUsageState).catch(() => {})
    }, Math.min(delay + 750, 2147483647))
    return () => window.clearTimeout(timer)
  }, [usageState?.provider.cooldownUntil])

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
          model: preferredModel(models, settings?.agent.defaultModel ?? '', {
            freeFirst: settings?.agent.freeFirst ?? true,
            allowBillableAccounts: settings?.agent.allowBillableAccounts ?? false,
          }),
          workspacePath: workspacePath ?? null,
        })
        cache.current.set(conversation.id, conversation)
        activeIdRef.current = conversation.id
        setActive({ ...conversation })
        setView('chat')
        setDraft('')
        setAttachments([])
        setSelectedSkills([])
        setRuntime(null)
        setPhase('idle')
        await refreshSummaries()
      } catch (error) {
        setToast({ kind: 'error', text: friendlyError(error) })
      }
    },
    [
      models,
      refreshSummaries,
      settings?.agent.defaultModel,
      settings?.agent.freeFirst,
      settings?.agent.allowBillableAccounts,
    ],
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
              if (queuesRef.current[id]) {
                const nextQueues = { ...queuesRef.current }
                delete nextQueues[id]
                queuesRef.current = nextQueues
                setQueues(nextQueues)
              }
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
      // Start loading a local GGUF right away so the first turn does not wait on it.
      if (isLocalModelId(modelId)) void prepareLocalModel(modelId)
      const conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) : null
      if (!conversation) {
        await patchSettings({ agent: { defaultModel: modelId } })
        return
      }
      conversation.model = modelId
      setActive({ ...conversation })
      persist(conversation, true)
    },
    [patchSettings, persist, prepareLocalModel],
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

  // Drops anywhere in the window attach to the prompt: without a window-level
  // guard, Chromium navigates the renderer to the dropped file and the app is
  // replaced by a JSON or image preview.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    let depth = 0

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragging(true)
    }

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files.map((file) => window.fcc.files.pathForFile(file)).filter(Boolean)
      if (paths.length === 0) return
      void window.fcc.files.describe(paths).then((described) => addAttachments(described))
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addAttachments])

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
  /**
   * Appends one user message plus its placeholder assistant message to the
   * cached conversation and hands the turn to the agent. The composer and the
   * queue share this path so both behave identically.
   */
  const beginTurn = useCallback(
    async (conversation: Conversation, text: string, turnAttachments: Attachment[], skillNames: string[] = []) => {
      const model =
        conversation.model ||
        preferredModel(models, settings?.agent.defaultModel ?? '', {
          freeFirst: settings?.agent.freeFirst ?? true,
          allowBillableAccounts: settings?.agent.allowBillableAccounts ?? false,
        })
      const turnId = newId()
      const now = Date.now()

      const userMessage: ChatMessage = {
        id: newId(),
        role: 'user',
        createdAt: now,
        status: 'complete',
        segments: [{ apiMessageId: 'user', blocks: [{ kind: 'text', text }] }],
        attachments: turnAttachments.length ? [...turnAttachments] : undefined,
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

      if (activeIdRef.current === conversation.id) {
        setActive({ ...conversation })
        setPhase('thinking')
      }
      persist(conversation, true)

      if (isLocalModelId(model)) {
        const failure = await ensureLocalModel(model)
        if (failure) {
          assistantMessage.status = 'error'
          assistantMessage.error = failure
          if (activeIdRef.current === conversation.id) {
            setActive({ ...conversation })
            setPhase('idle')
          }
          setToast({ kind: 'error', text: failure })
          return
        }
      }

      try {
        const result = await api.agent.send({
          conversationId: conversation.id,
          turnId,
          text,
          attachments: turnAttachments,
          model,
          workingDirectory: conversation.workspacePath ?? settings?.agent.workingDirectory ?? '',
          additionalDirs: conversation.additionalDirs,
          resumeSessionId: conversation.sessionId,
          skillNames,
        })
        if (result.sessionId && !conversation.sessionId) {
          conversation.sessionId = result.sessionId
          persist(conversation)
        }
        if (result.model && result.model !== model) {
          // The main process resolved an empty model through free-first routing.
          conversation.model = result.model
          assistantMessage.meta = { ...assistantMessage.meta, model: result.model }
          if (activeIdRef.current === conversation.id) setActive({ ...conversation })
          persist(conversation)
        }
        void api.agent.runtime(conversation.id).then(setRuntime).catch(() => {})
      } catch (error) {
        const message = friendlyError(error)
        assistantMessage.status = 'error'
        assistantMessage.error = message
        if (activeIdRef.current === conversation.id) {
          setActive({ ...conversation })
          setPhase('idle')
        }
        setToast({ kind: 'error', text: message })
        void api.agent.runtime(conversation.id).then(setRuntime).catch(() => {})
      }
    },
    [ensureLocalModel, models, persist, settings?.agent.defaultModel, settings?.agent.workingDirectory],
  )

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !settings) return
    if (active?.messages.some((message) => message.status === 'streaming')) return

    // Always mutate the cached conversation so agent events and persistence agree.
    let conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) ?? null : null
    if (!conversation) {
      try {
        conversation = await api.conversations.create({
          model: preferredModel(models, settings.agent.defaultModel, {
            freeFirst: settings.agent.freeFirst,
            allowBillableAccounts: settings.agent.allowBillableAccounts,
          }),
        })
        cache.current.set(conversation.id, conversation)
        activeIdRef.current = conversation.id
      } catch (error) {
        setToast({ kind: 'error', text: friendlyError(error) })
        return
      }
    }

    const sentAttachments = [...attachments]
    const sentSkills = [...selectedSkills]
    setDraft('')
    setAttachments([])
    setSelectedSkills([])
    await beginTurn(conversation, text, sentAttachments, sentSkills)
  }, [active, attachments, beginTurn, draft, models, selectedSkills, settings])

  // ------------------------------------------------------------------- queue
  const setQueueFor = useCallback(
    (conversationId: string, items: QueuedMessage[]) => {
      const next = { ...queuesRef.current }
      if (items.length > 0) next[conversationId] = items
      else delete next[conversationId]
      queuesRef.current = next
      setQueues(next)

      // The queue is part of the conversation on disk, so a quit or reload
      // restores it. Write immediately: the debounce could lose a last edit.
      const conversation = cache.current.get(conversationId)
      if (conversation) {
        conversation.queue = items
        conversation.updatedAt = Date.now()
        persist(conversation, true)
      }
    },
    [persist],
  )

  const queueDraft = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    const conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) ?? null : null
    if (!conversation) return
    const item: QueuedMessage = {
      id: newId(),
      text,
      attachments: [...attachments],
      createdAt: Date.now(),
    }
    setQueueFor(conversation.id, [...(queuesRef.current[conversation.id] ?? []), item])
    setDraft('')
    setAttachments([])
  }, [attachments, draft, setQueueFor])

  const editQueued = useCallback(
    (id: string, text: string) => {
      const conversationId = activeIdRef.current
      if (!conversationId) return
      setQueueFor(
        conversationId,
        (queuesRef.current[conversationId] ?? []).map((item) => (item.id === id ? { ...item, text } : item)),
      )
    },
    [setQueueFor],
  )

  const removeQueued = useCallback(
    (id: string) => {
      const conversationId = activeIdRef.current
      if (!conversationId) return
      setQueueFor(
        conversationId,
        (queuesRef.current[conversationId] ?? []).filter((item) => item.id !== id),
      )
    },
    [setQueueFor],
  )

  /** When a turn ends, hand the agent the next item: an interrupt first, then the queue. */
  const afterTurn = useCallback(
    (conversationId: string) => {
      const conversation = cache.current.get(conversationId)
      if (!conversation) return
      if (conversation.messages.some((message) => message.status === 'streaming')) return

      const pending = interruptRef.current
      if (pending && pending.conversationId === conversationId) {
        interruptRef.current = null
        if (pending.timer) window.clearTimeout(pending.timer)
        void beginTurn(conversation, pending.item.text, pending.item.attachments)
        return
      }

      const list = queuesRef.current[conversationId] ?? []
      const next = list[0]
      if (!next) return
      setQueueFor(conversationId, list.slice(1))
      void beginTurn(conversation, next.text, next.attachments)
    },
    [beginTurn, setQueueFor],
  )

  afterTurnRef.current = afterTurn

  const sendQueuedNow = useCallback(
    async (id: string) => {
      const conversation = activeIdRef.current ? cache.current.get(activeIdRef.current) ?? null : null
      if (!conversation) return
      const list = queuesRef.current[conversation.id] ?? []
      const item = list.find((entry) => entry.id === id)
      if (!item) return

      setQueueFor(conversation.id, list.filter((entry) => entry.id !== id))

      const streaming = conversation.messages.some((message) => message.status === 'streaming')
      if (!streaming) {
        await beginTurn(conversation, item.text, item.attachments)
        return
      }

      // interrupt() goes through the CLI control channel, so the agent process
      // and its session survive and the queued turn keeps the same context.
      const pending = { conversationId: conversation.id, item, timer: null as number | null }
      interruptRef.current = pending
      const acknowledged = await api.agent.interrupt(conversation.id)
      if (!acknowledged) {
        interruptRef.current = null
        setQueueFor(conversation.id, [item, ...(queuesRef.current[conversation.id] ?? [])])
        setToast({ kind: 'error', text: 'Could not interrupt the running turn — the message stayed queued.' })
        return
      }

      pending.timer = window.setTimeout(() => {
        if (interruptRef.current !== pending) return
        interruptRef.current = null
        setQueueFor(conversation.id, [item, ...(queuesRef.current[conversation.id] ?? [])])
        setToast({
          kind: 'info',
          text: 'The agent ignored the interrupt — stopping this turn, then sending your message.',
        })
        void api.agent.cancel(conversation.id)
      }, 6000)
    },
    [beginTurn, setQueueFor],
  )

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
          onOpenSkills={() => setView('skills')}
          skillsCount={skillList.filter((skill) => skill.enabled).length}
          onOpenModels={() => setView('models')}
          onOpenUsage={() => setView('usage')}
          usage={usageState}
        />

        <main className="workspace">
          {view === 'skills' ? (
            <div className="workspace-main skills-workspace">
              <SkillsView
                projectPath={active?.workspacePath ?? null}
                workspaceName={
                  active?.workspacePath
                    ? active.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? null
                    : null
                }
                onBack={() => setView('chat')}
                onToast={(kind, text) => setToast({ kind, text })}
                onOpenExternal={(url) => void api.app.openExternal(url)}
                onSkillsChanged={() => void refreshSkills()}
              />
            </div>
          ) : view === 'models' ? (
            <div className="workspace-main skills-workspace">
              <LocalModelsView
                onBack={() => setView('chat')}
                onToast={(kind, text) => setToast({ kind, text })}
              />
            </div>
          ) : view === 'usage' ? (
            <div className="workspace-main skills-workspace">
              <UsageView
                state={usageState}
                activeModel={active?.model || settings?.agent.defaultModel || ''}
                onState={setUsageState}
                onBack={() => setView('chat')}
                onToast={(kind, text) => setToast({ kind, text })}
              />
            </div>
          ) : (
            <>
          <div className="workspace-main">
            <ChatView
              conversation={active}
              models={pickerModels}
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
              skillsState={active ? skillsByConversation[active.id] ?? null : null}
              showSkillsIndicator={settings?.skills.showIndicator ?? true}
              onOpenSkills={() => setView('skills')}
            />

            <UsageBanner state={usageState} onOpen={() => setView('usage')} />

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
              models={pickerModels}
              onSelectModel={(id) => void setModel(id)}
              onRefreshModels={() => void api.connection.models(true).then(setCatalog)}
              catalogError={catalog?.error ?? null}
              workspace={active?.workspacePath ?? null}
              onPickWorkspace={() => void pickWorkspaceFolder()}
              onClearWorkspace={() => void setWorkspace(null)}
              status={status}
              onOpenSettings={() => setSettingsOpen(true)}
              skills={skillList}
              selectedSkills={selectedSkills}
              onToggleSkill={(name) =>
                setSelectedSkills((current) =>
                  current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
                )
              }
              onOpenSkillsLibrary={() => setView('skills')}
              queue={active ? queues[active.id] ?? [] : []}
              onQueue={queueDraft}
              onQueueEdit={editQueued}
              onQueueRemove={removeQueued}
              onQueueSendNow={(id) => void sendQueuedNow(id)}
            />
          </div>

          {activityOpen ? (
            <ActivityRail
              conversation={active}
              runtime={runtime}
              phase={phase}
              streaming={streamingHere}
              status={status}
              models={pickerModels}
              onClose={toggleActivity}
            />
          ) : null}
            </>
          )}
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
                  queuesRef.current = {}
                  setQueues({})
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

      {dragging ? (
        <div className="global-drop" aria-hidden="true">
          <span>Drop files or folders to attach them</span>
        </div>
      ) : null}

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
