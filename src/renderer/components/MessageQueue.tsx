import { useState } from 'react'
import type { QueuedMessage } from '../../shared/types'
import { clockTime } from '../lib/format'
import { Button } from './ui'
import { CloseIcon } from './Icons'

export type { QueuedMessage }

interface MessageQueueProps {
  items: QueuedMessage[]
  busy: boolean
  onEdit: (id: string, text: string) => void
  onRemove: (id: string) => void
  onSendNow: (id: string) => void
}

export default function MessageQueue({ items, busy, onEdit, onRemove, onSendNow }: MessageQueueProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (items.length === 0) return null

  const cancelEdit = () => {
    setEditing(null)
    setDraft('')
  }

  const saveEdit = (id: string) => {
    const text = draft.trim()
    if (!text) return
    onEdit(id, text)
    cancelEdit()
  }

  return (
    <section className="msg-queue" aria-label="Queued messages">
      <header className="msg-queue-head">
        <span className="msg-queue-title">
          {items.length} queued
          {busy ? <span className="msg-queue-pulse" /> : null}
        </span>
        <span className="msg-queue-sub">
          {busy ? 'Sends when this turn ends — or send now to interrupt' : 'Waiting to send'}
        </span>
      </header>

      <ol className="msg-queue-list">
        {items.map((item, index) => (
          <li key={item.id} className={`msg-queue-row ${editing === item.id ? 'is-editing' : ''}`}>
            {editing === item.id ? (
              <div className="msg-queue-editor">
                <textarea
                  autoFocus
                  rows={2}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelEdit()
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      saveEdit(item.id)
                    }
                  }}
                />
                <div className="msg-queue-editor-actions">
                  <Button size="sm" variant="ghost" onClick={cancelEdit}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={() => saveEdit(item.id)}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <span className="msg-queue-index">{index + 1}</span>
                <div className="msg-queue-body">
                  <span className="msg-queue-text">{item.text}</span>
                  <span className="msg-queue-meta">
                    {clockTime(item.createdAt)}
                    {item.attachments.length > 0 ? ` · ${item.attachments.length} attachment(s)` : ''}
                  </span>
                </div>
                <div className="msg-queue-actions">
                  <button
                    className="queue-btn"
                    onClick={() => {
                      setEditing(item.id)
                      setDraft(item.text)
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="queue-btn is-send"
                    onClick={() => onSendNow(item.id)}
                    title={busy ? 'Interrupt the current turn and send this message now' : 'Send this message now'}
                  >
                    Send now
                  </button>
                  <button
                    className="queue-btn is-remove"
                    onClick={() => onRemove(item.id)}
                    aria-label="Remove from queue"
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
