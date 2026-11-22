import { useEffect, useRef, useState } from 'react'
import type { Attachment, ConnectionStatus, ModelInfo } from '../../shared/types'
import { formatBytes, folderName } from '../lib/format'
import ModelPicker from './ModelPicker'
import MessageQueue, { type QueuedMessage } from './MessageQueue'
import { Badge, Button, IconButton } from './ui'
import {
  CloseIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
} from './Icons'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  busy: boolean
  phase: 'idle' | 'thinking' | 'working' | 'waiting'
  attachments: Attachment[]
  onAddFiles: () => void
  onAddFolder: () => void
  onRemoveAttachment: (path: string) => void
  model: string
  models: ModelInfo[]
  onSelectModel: (modelId: string) => void
  onRefreshModels: () => void
  catalogError: string | null
  workspace: string | null
  onPickWorkspace: () => void
  onClearWorkspace: () => void
  status: ConnectionStatus | null
  onOpenSettings: () => void
  queue: QueuedMessage[]
  onQueue: () => void
  onQueueEdit: (id: string, text: string) => void
  onQueueRemove: (id: string) => void
  onQueueSendNow: (id: string) => void
}

function ComposerAttachment({
  attachment,
  onRemove,
}: {
  attachment: Attachment
  onRemove: () => void
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
    <div className="composer-att" title={attachment.path}>
      <span className="composer-att-thumb">
        {thumb ? (
          <img src={thumb} alt="" />
        ) : attachment.isDirectory ? (
          <FolderIcon size={15} />
        ) : attachment.kind === 'image' ? (
          <ImageIcon size={15} />
        ) : (
          <FileIcon size={15} />
        )}
      </span>
      <span className="composer-att-text">
        <span className="composer-att-name">{attachment.name}</span>
        <span className="composer-att-size">
          {attachment.isDirectory ? 'folder' : formatBytes(attachment.size)}
        </span>
      </span>
      <button className="composer-att-remove" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  phase,
  attachments,
  onAddFiles,
  onAddFolder,
  onRemoveAttachment,
  model,
  models,
  onSelectModel,
  onRefreshModels,
  catalogError,
  workspace,
  onPickWorkspace,
  onClearWorkspace,
  status,
  onOpenSettings,
  queue,
  onQueue,
  onQueueEdit,
  onQueueRemove,
  onQueueSendNow,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const offline = status?.state !== 'connected'

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`
  }, [value])

  return (
    <div className="composer-wrap">
      <MessageQueue
        items={queue}
        busy={busy}
        onEdit={onQueueEdit}
        onRemove={onQueueRemove}
        onSendNow={onQueueSendNow}
      />

      <div className="composer">
        {attachments.length > 0 ? (
          <div className="composer-atts">
            {attachments.map((attachment) => (
              <ComposerAttachment
                key={attachment.path}
                attachment={attachment}
                onRemove={() => onRemoveAttachment(attachment.path)}
              />
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          className="composer-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (!value.trim()) return
              if (busy) onQueue()
              else if (!offline) onSend()
            }
            if (event.key === 'Escape' && busy) {
              event.preventDefault()
              onStop()
            }
          }}
          placeholder={
            offline
              ? 'FCC is offline — follow the setup steps above to connect'
              : busy
                ? 'Queue a follow-up — it sends when this turn ends, or use Send now to interrupt'
                : 'Message FCC — describe what you want built, fixed or explained…'
          }
          rows={1}
          spellCheck
        />

        <div className="composer-bar">
          <div className="composer-tools">
            <IconButton label="Attach files" onClick={onAddFiles}>
              <PaperclipIcon size={17} />
            </IconButton>
            <IconButton label="Attach a folder" onClick={onAddFolder}>
              <FolderIcon size={17} />
            </IconButton>
            <span className="composer-sep" />
            {workspace ? (
              <span className="workspace-chip" title={workspace}>
                <FolderIcon size={14} />
                <span>{folderName(workspace)}</span>
                <button onClick={onClearWorkspace} aria-label="Clear workspace">
                  <CloseIcon size={11} />
                </button>
              </span>
            ) : (
              <button className="workspace-chip is-empty" onClick={onPickWorkspace}>
                <FolderIcon size={14} />
                <span>Choose workspace</span>
              </button>
            )}
            {attachments.length > 0 ? <Badge tone="blue">{attachments.length} attached</Badge> : null}
          </div>

          <div className="composer-actions">
            <ModelPicker
              models={models}
              value={model}
              onChange={onSelectModel}
              onRefresh={onRefreshModels}
              error={catalogError}
              status={status}
            />
            {busy ? (
              <>
                <Button
                  variant="primary"
                  onClick={onQueue}
                  disabled={!value.trim() || offline}
                  icon={<PlusIcon size={15} />}
                >
                  Queue
                </Button>
                <Button variant="danger" onClick={onStop} icon={<StopIcon size={15} />}>
                  Stop
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={onSend} disabled={!value.trim() || offline} icon={<SendIcon size={16} />}>
                Send
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> {busy ? 'queue' : 'send'} · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
          {busy ? (
            <>
              {' '}
              · <kbd>Esc</kbd> stop
            </>
          ) : null}
        </span>
        {offline ? (
          <button className="link-btn" onClick={onOpenSettings}>
            {phase === 'idle' ? 'FCC offline — install, start and connect' : 'Connecting…'}
          </button>
        ) : (
          <span className="composer-endpoint">{status?.baseUrl}</span>
        )}
      </div>
    </div>
  )
}
