import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Attachment, ChatMessage, MessageBlock, ModelInfo } from '../../shared/types'
import {
  clockTime,
  cost,
  duration,
  formatBytes,
  shortPath,
  toolLabel,
  toolSummary,
} from '../lib/format'
import {
  AlertIcon,
  ChevronDownIcon,
  CodeIcon,
  CopyIcon,
  FileIcon,
  ImageIcon,
  LinkIcon,
  SearchIcon,
  SparkIcon,
  TerminalIcon,
  XionMark,
} from './Icons'

interface MessageItemProps {
  message: ChatMessage
  models: ModelInfo[]
  showThinking: boolean
  streaming: boolean
  onReveal: (path: string) => void
  onOpenExternal: (url: string) => void
  onCopy: (text: string) => void
  onRetry?: () => void
}

function extractText(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props
    return extractText(props?.children)
  }
  return ''
}

function CodeBlock({
  children,
  onCopy,
}: {
  children?: React.ReactNode
  onCopy: (text: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const codeElement = Array.isArray(children) ? children[0] : children
  const className =
    codeElement && typeof codeElement === 'object' && 'props' in (codeElement as Record<string, unknown>)
      ? String((codeElement as { props?: { className?: string } }).props?.className ?? '')
      : ''
  const language = /language-([\w+-]+)/.exec(className)?.[1] ?? ''
  const text = extractText(children)

  const copy = () => {
    onCopy(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">
          <CodeIcon size={13} />
          {language || 'code'}
        </span>
        <button className="code-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

function Markdown({ text, onOpenExternal, onCopy }: { text: string; onOpenExternal: (url: string) => void; onCopy: (text: string) => void }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault()
                if (href) onOpenExternal(href)
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock onCopy={onCopy}>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function toolIcon(name: string) {
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') return <FileIcon size={14} />
  if (name === 'Bash' || name === 'PowerShell') return <TerminalIcon size={14} />
  if (name === 'Glob' || name === 'Grep' || name === 'LS') return <SearchIcon size={14} />
  if (name === 'WebFetch' || name === 'WebSearch') return <LinkIcon size={14} />
  if (name === 'Task' || name === 'Agent') return <SparkIcon size={14} />
  return <TerminalIcon size={14} />
}

function ToolCard({ tool, onCopy }: { tool: MessageBlock & { kind: 'tool' }; onCopy: (t: string) => void }) {
  const [open, setOpen] = useState(tool.tool.status === 'running')
  const summary = toolSummary(tool.tool.name, tool.tool.input)
  const inputText = useMemo(() => {
    try {
      return JSON.stringify(tool.tool.input, null, 2)
    } catch {
      return String(tool.tool.input)
    }
  }, [tool.tool.input])

  return (
    <div className={`tool-card is-${tool.tool.status}`}>
      <button className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className="tool-glyph">{toolIcon(tool.tool.name)}</span>
        <span className="tool-name">{toolLabel(tool.tool.name)}</span>
        {summary ? <span className="tool-summary">{shortPath(summary, 64)}</span> : null}
        <span className={`tool-state tool-state-${tool.tool.status}`}>
          {tool.tool.status === 'running' ? (
            <span className="tool-spinner" />
          ) : tool.tool.status === 'ok' ? (
            'done'
          ) : (
            'failed'
          )}
        </span>
        <ChevronDownIcon size={14} className={`tool-chevron ${open ? 'is-open' : ''}`} />
      </button>
      {open ? (
        <div className="tool-body">
          <div className="tool-section">
            <div className="tool-section-head">
              <span>Input</span>
              <button className="tool-copy" onClick={() => onCopy(inputText)} title="Copy input">
                <CopyIcon size={12} />
              </button>
            </div>
            <pre>{inputText}</pre>
          </div>
          {tool.tool.output !== null ? (
            <div className="tool-section">
              <div className="tool-section-head">
                <span>{tool.tool.status === 'error' ? 'Error' : 'Result'}</span>
                <button
                  className="tool-copy"
                  onClick={() => onCopy(tool.tool.output ?? '')}
                  title="Copy result"
                >
                  <CopyIcon size={12} />
                </button>
              </div>
              <pre>{tool.tool.output || '(empty result)'}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingBlock({ block, show }: { block: MessageBlock & { kind: 'thinking' }; show: boolean }) {
  const [open, setOpen] = useState(false)
  if (!show) return null
  const label = block.durationMs ? `Thought for ${duration(block.durationMs)}` : 'Thinking'
  return (
    <div className="thinking-block">
      <button className="thinking-head" onClick={() => setOpen((value) => !value)}>
        <SparkIcon size={13} />
        <span>{label}</span>
        <ChevronDownIcon size={13} className={open ? 'is-open' : ''} />
      </button>
      {open ? <div className="thinking-text">{block.text}</div> : null}
    </div>
  )
}

function AttachmentChip({
  attachment,
  onReveal,
}: {
  attachment: Attachment
  onReveal: (path: string) => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    if (attachment.kind !== 'image') return
    let cancelled = false
    void window.fcc.files.thumbnail(attachment.path).then((data) => {
      if (!cancelled) setThumb(data)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.kind, attachment.path])

  return (
    <button className="att-chip" onClick={() => onReveal(attachment.path)} title={attachment.path}>
      <span className="att-thumb">
        {thumb ? <img src={thumb} alt="" /> : attachment.kind === 'image' ? <ImageIcon size={15} /> : <FileIcon size={15} />}
      </span>
      <span className="att-text">
        <span className="att-name">{attachment.name}</span>
        <span className="att-size">{attachment.isDirectory ? 'folder' : formatBytes(attachment.size)}</span>
      </span>
    </button>
  )
}

export default function MessageItem({
  message,
  models,
  showThinking,
  streaming,
  onReveal,
  onOpenExternal,
  onCopy,
  onRetry,
}: MessageItemProps) {
  const modelName = message.meta?.model
    ? models.find((model) => model.id === message.meta?.model)?.displayName ?? message.meta.model
    : null

  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        {message.attachments && message.attachments.length > 0 ? (
          <div className="msg-attachments">
            {message.attachments.map((attachment) => (
              <AttachmentChip key={attachment.path} attachment={attachment} onReveal={onReveal} />
            ))}
          </div>
        ) : null}
        {message.segments.map((segment) =>
          segment.blocks.map((block, index) =>
            block.kind === 'text' ? (
              <div className="msg-bubble" key={`${segment.apiMessageId}-${index}`}>
                {block.text}
              </div>
            ) : null,
          ),
        )}
      </div>
    )
  }

  return (
    <div className={`msg msg-assistant ${streaming ? 'is-streaming' : ''}`}>
      <div className="msg-avatar">
        <XionMark size={16} />
      </div>
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-author">FCC</span>
          {modelName ? <span className="msg-model">{modelName}</span> : null}
          <span className="msg-time">{clockTime(message.createdAt)}</span>
          {message.status === 'stopped' ? <span className="msg-flag">stopped</span> : null}
          {message.status === 'error' ? <span className="msg-flag is-error">failed</span> : null}
        </div>

        {message.segments.length === 0 && message.status === 'streaming' ? (
          <div className="msg-placeholder">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        ) : null}

        {message.segments.map((segment) =>
          segment.blocks.map((block, index) => {
            const key = `${segment.apiMessageId}-${index}`
            if (block.kind === 'text') {
              if (!block.text.trim()) return null
              return <Markdown key={key} text={block.text} onOpenExternal={onOpenExternal} onCopy={onCopy} />
            }
            if (block.kind === 'thinking') {
              return <ThinkingBlock key={key} block={block} show={showThinking} />
            }
            return <ToolCard key={block.tool.id || key} tool={block} onCopy={onCopy} />
          }),
        )}

        {streaming ? <span className="stream-caret" /> : null}

        {message.error ? (
          <div className="msg-error">
            <AlertIcon size={15} />
            <div className="msg-error-body">
              <span className="msg-error-title">Agent error</span>
              <span className="msg-error-text">{message.error}</span>
              {onRetry ? (
                <button className="link-btn" onClick={onRetry}>
                  Put the last request back in the composer
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {message.status === 'complete' && message.meta ? (
          <div className="msg-footer">
            {message.meta.durationMs ? <span>{duration(message.meta.durationMs)}</span> : null}
            {message.meta.outputTokens ? <span>{message.meta.outputTokens} tokens out</span> : null}
            {message.meta.costUsd ? <span>{cost(message.meta.costUsd)}</span> : null}
            {message.meta.permissionDenials ? (
              <span className="is-warn">{message.meta.permissionDenials} tool request(s) denied</span>
            ) : null}
            <button
              className="msg-copy"
              onClick={() =>
                onCopy(
                  message.segments
                    .flatMap((segment) => segment.blocks)
                    .filter((block) => block.kind === 'text')
                    .map((block) => (block.kind === 'text' ? block.text : ''))
                    .join('\n\n'),
                )
              }
            >
              <CopyIcon size={12} /> Copy
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
