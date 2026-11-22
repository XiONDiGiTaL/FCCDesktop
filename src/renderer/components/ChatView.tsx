import { useEffect, useRef } from 'react'
import type { ConnectionStatus, Conversation, ModelInfo } from '../../shared/types'
import { folderName, shortPath, statusLabel, toolLabel, toolSummary } from '../lib/format'
import LiveActivity from './LiveActivity'
import MessageItem from './MessageItem'
import SetupGuide from './SetupGuide'
import { IconButton, StatusDot } from './ui'
import { FolderIcon, SparkIcon, XionMark, ArrowUpRightIcon } from './Icons'

interface ChatViewProps {
  conversation: Conversation | null
  models: ModelInfo[]
  streaming: boolean
  phase: 'idle' | 'thinking' | 'working' | 'waiting'
  showThinking: boolean
  empty: boolean
  status: ConnectionStatus | null
  onRename: (title: string) => void
  onReveal: (path: string) => void
  onOpenExternal: (url: string) => void
  onCopy: (text: string) => void
  onSuggestion: (text: string) => void
  onNew: () => void
  onOpenSettings: () => void
  onRetry: (text: string) => void
  workingDirectory: string
}

const SUGGESTIONS = [
  {
    title: 'Understand this codebase',
    text: 'Give me a tour of this project: what it does, how it is structured, and the three files I should read first.',
  },
  {
    title: 'Build something',
    text: 'Create a small, complete feature in this workspace. Start by exploring, then propose the plan before writing code.',
  },
  {
    title: 'Debug an issue',
    text: 'Help me track down a bug. Ask me for the symptoms, then inspect the relevant files and explain the root cause.',
  },
]

export default function ChatView({
  conversation,
  models,
  streaming,
  phase,
  showThinking,
  empty,
  status,
  onRename,
  onReveal,
  onOpenExternal,
  onCopy,
  onSuggestion,
  onNew,
  onOpenSettings,
  onRetry,
  workingDirectory,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const lastCount = useRef(0)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const messageCount = conversation?.messages.length ?? 0
    if (messageCount !== lastCount.current) {
      lastCount.current = messageCount
      stickToBottom.current = true
    }
    if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [conversation, streaming])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      stickToBottom.current = distance < 140
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  const messages = conversation?.messages ?? []
  const modelName =
    models.find((model) => model.id === conversation?.model)?.displayName || conversation?.model || 'Server default'

  // The turn in flight drives the live indicator: elapsed time plus the tool
  // that is running right now.
  const streamingMessage = [...messages].reverse().find((message) => message.status === 'streaming') ?? null
  const streamStartedAt = streamingMessage?.createdAt ?? null
  const runningTools =
    streamingMessage?.segments
      .flatMap((segment) => segment.blocks)
      .filter((block) => block.kind === 'tool' && block.tool.status === 'running') ?? []
  const lastTool = runningTools[runningTools.length - 1]
  const toolDetail =
    lastTool && lastTool.kind === 'tool'
      ? [toolLabel(lastTool.tool.name), shortPath(toolSummary(lastTool.tool.name, lastTool.tool.input), 48)]
          .filter(Boolean)
          .join(' · ')
      : null

  if (empty || !conversation) {
    return (
      <div className="chat">
        <div className="chat-empty">
          <div className="empty-glow" />
          <div className="empty-mark">
            <XionMark size={44} />
          </div>
          <h1 className="empty-title">
            Your agent, <span>on your desktop.</span>
          </h1>
          <p className="empty-copy">
            FCC Desktop runs the Free Claude Code agent against your own workspace — reading files, running tools
            and reporting every step. Start with a prompt, or pick a direction.
          </p>

          <div className="empty-status">
            <StatusDot tone={status?.state === 'connected' ? 'green' : 'amber'} />
            <span>
              {status?.state === 'connected'
                ? `Connected to ${status.baseUrl}`
                : status
                  ? statusLabel(status)
                  : 'Checking FCC connection…'}
            </span>
          </div>

          {status?.state === 'connected' ? (
            <div className="suggestion-grid">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion.title} className="suggestion" onClick={() => onSuggestion(suggestion.text)}>
                  <span className="suggestion-icon">
                    <SparkIcon size={17} />
                  </span>
                  <span className="suggestion-body">
                    <span className="suggestion-title">{suggestion.title}</span>
                    <span className="suggestion-text">{suggestion.text}</span>
                  </span>
                  <ArrowUpRightIcon size={15} className="suggestion-arrow" />
                </button>
              ))}
            </div>
          ) : status ? (
            <SetupGuide status={status} onOpenSettings={onOpenSettings} />
          ) : null}

          <button className="empty-new" onClick={onNew}>
            Start a blank conversation
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-heading">
          <input
            className="chat-title"
            value={conversation.title}
            onChange={(event) => onRename(event.target.value)}
            onBlur={(event) => onRename(event.target.value)}
            spellCheck={false}
            aria-label="Conversation title"
          />
          <div className="chat-subline">
            <span className={`chat-model ${conversation.model ? '' : 'is-default'}`}>{modelName}</span>
            {workingDirectory ? (
              <button
                className="chat-workspace"
                onClick={() => void window.fcc.files.reveal(workingDirectory)}
                title={workingDirectory}
              >
                <FolderIcon size={13} />
                {folderName(workingDirectory)}
              </button>
            ) : (
              <span className="chat-workspace is-muted">
                <FolderIcon size={13} />
                Home directory
              </span>
            )}
            {conversation.sessionId ? (
              <span className="chat-session" title={`Claude session ${conversation.sessionId}`}>
                session {conversation.sessionId.slice(0, 8)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="chat-header-actions">
          {streaming ? (
            <span className="live-pill">
              <LiveActivity phase={phase} startedAt={streamStartedAt} active compact />
            </span>
          ) : null}
          <IconButton label="Conversation settings" onClick={onOpenSettings}>
            <span className="icon-dots">•••</span>
          </IconButton>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-stream">
          {messages.map((message, index) => {
            const previousUser = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user')
            const previousText =
              previousUser?.segments
                .flatMap((segment) => segment.blocks)
                .filter((block) => block.kind === 'text')
                .map((block) => (block.kind === 'text' ? block.text : ''))
                .join('\n') ?? ''
            return (
              <MessageItem
                key={message.id}
                message={message}
                models={models}
                showThinking={showThinking}
                streaming={streaming && index === messages.length - 1}
                onReveal={onReveal}
                onOpenExternal={onOpenExternal}
                onCopy={onCopy}
                onRetry={previousText ? () => onRetry(previousText) : undefined}
              />
            )
          })}
          {streaming ? (
            <div className="chat-thinking">
              <LiveActivity phase={phase} startedAt={streamStartedAt} active detail={toolDetail} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
