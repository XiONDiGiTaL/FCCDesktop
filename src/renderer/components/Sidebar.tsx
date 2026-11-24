import { useMemo, useState } from 'react'
import type { AppSettings, ConnectionStatus, ConversationSummary } from '../../shared/types'
import type { UsageState } from '../../shared/usage'
import { dayGroup, folderName, relativeTime, statusLabel } from '../lib/format'
import { IconButton, StatusDot } from './ui'
import {
  ChipIcon,
  FolderIcon,
  FolderPlusIcon,
  GaugeIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  TrashIcon,
} from './Icons'

interface SidebarProps {
  summaries: ConversationSummary[]
  activeId: string | null
  search: string
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  workspaces: AppSettings['workspaces']
  onAddWorkspace: () => void
  onUseWorkspace: (path: string) => void
  onRemoveWorkspace: (id: string) => void
  status: ConnectionStatus | null
  onOpenSettings: () => void
  collapsed: boolean
  onOpenSkills: () => void
  skillsCount: number
  onOpenModels: () => void
  onOpenUsage: () => void
  usage: UsageState | null
}

function usageSubtitle(usage: UsageState | null): string {
  if (!usage) return 'Reading provider…'
  switch (usage.provider.availability) {
    case 'available':
      return 'Available · local counts'
    case 'throttled':
      return 'Temporarily rate-limited'
    case 'exhausted':
      return 'Quota exhausted'
    case 'degraded':
      return 'Provider needs attention'
    case 'offline':
      return 'FCC offline'
    default:
      return 'Usage not reported'
  }
}

export default function Sidebar({
  summaries,
  activeId,
  search,
  onSearch,
  onSelect,
  onNew,
  onDelete,
  onPin,
  workspaces,
  onAddWorkspace,
  onUseWorkspace,
  onRemoveWorkspace,
  status,
  onOpenSettings,
  collapsed,
  onOpenSkills,
  skillsCount,
  onOpenModels,
  onOpenUsage,
  usage,
}: SidebarProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return summaries
    return summaries.filter((item) => item.title.toLowerCase().includes(query))
  }, [summaries, search])

  const groups = useMemo(() => {
    const map = new Map<string, ConversationSummary[]>()
    for (const item of filtered) {
      const key = dayGroup(item.updatedAt)
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return Array.from(map.entries())
  }, [filtered])

  const connected = status?.state === 'connected'

  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed">
        <div className="sidebar-rail">
          <IconButton label="New conversation" onClick={onNew} className="rail-primary">
            <PlusIcon size={18} />
          </IconButton>
          <div className="rail-sep" />
          <IconButton label="Conversations" onClick={onNew}>
            <SparkIcon size={17} />
          </IconButton>
          <IconButton label="Workspaces" onClick={onAddWorkspace}>
            <FolderIcon size={17} />
          </IconButton>
          <IconButton label={`Agent skills (${skillsCount})`} onClick={onOpenSkills}>
            <SparkIcon size={17} />
          </IconButton>
          <IconButton label="Local models" onClick={onOpenModels}>
            <ChipIcon size={17} />
          </IconButton>
          <IconButton
            label={`Usage & limits: ${usageSubtitle(usage)}`}
            onClick={onOpenUsage}
            className={usage && usage.provider.availability !== 'available' ? 'usage-rail-alert' : ''}
          >
            <GaugeIcon size={17} />
          </IconButton>
          <div className="rail-grow" />
          <IconButton label={`FCC: ${statusLabel(status)}`} onClick={onOpenSettings}>
            <span className={`rail-status ${connected ? 'is-online' : ''}`} />
          </IconButton>
          <IconButton label="Settings" onClick={onOpenSettings}>
            <SettingsIcon size={17} />
          </IconButton>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="new-chat" onClick={onNew}>
          <span className="new-chat-icon">
            <PlusIcon size={17} />
          </span>
          <span>New conversation</span>
          <span className="new-chat-key">Ctrl N</span>
        </button>

        <div className="search-box">
          <SearchIcon size={15} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search conversations"
            spellCheck={false}
          />
          {search ? (
            <button className="search-clear" onClick={() => onSearch('')} aria-label="Clear search">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section-head">
          <span>Conversations</span>
          <span className="sidebar-count">{summaries.length}</span>
        </div>

        {groups.length === 0 ? (
          <div className="sidebar-empty">
            {search ? 'No conversation matches that search.' : 'Your conversations will appear here.'}
          </div>
        ) : (
          groups.map(([label, items]) => (
            <div key={label} className="conv-group">
              <div className="conv-group-label">{label}</div>
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`conv-item ${activeId === item.id ? 'is-active' : ''}`}
                  onMouseEnter={() => setHovered(item.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => onSelect(item.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') onSelect(item.id)
                  }}
                >
                  <span className="conv-glyph">
                    {item.pinned ? <PinIcon size={13} /> : <span className="conv-glyph-dot" />}
                  </span>
                  <span className="conv-body">
                    <span className="conv-title">{item.title}</span>
                    <span className="conv-meta">
                      {relativeTime(item.updatedAt)}
                      {item.messageCount > 0 ? ` · ${item.messageCount} msg` : ''}
                    </span>
                  </span>
                  {hovered === item.id && (
                    <span className="conv-actions" onClick={(event) => event.stopPropagation()}>
                      <IconButton
                        label={item.pinned ? 'Unpin' : 'Pin'}
                        className="mini"
                        onClick={() => onPin(item.id, !item.pinned)}
                      >
                        <PinIcon size={13} />
                      </IconButton>
                      <IconButton label="Delete conversation" className="mini danger" onClick={() => onDelete(item.id)}>
                        <TrashIcon size={13} />
                      </IconButton>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))
        )}

        <button className="skills-entry" onClick={onOpenSkills}>
          <span className="skills-entry-icon">
            <SparkIcon size={15} />
          </span>
          <span className="skills-entry-copy">
            <span className="skills-entry-title">Agent Skills</span>
            <span className="skills-entry-sub">Discover, install, enable</span>
          </span>
          <span className="skills-entry-count">{skillsCount}</span>
        </button>

        <button className="skills-entry" onClick={onOpenModels}>
          <span className="skills-entry-icon">
            <ChipIcon size={15} />
          </span>
          <span className="skills-entry-copy">
            <span className="skills-entry-title">Local models</span>
            <span className="skills-entry-sub">Download & run GGUF</span>
          </span>
        </button>

        <button className="skills-entry usage-entry" onClick={onOpenUsage}>
          <span className="skills-entry-icon">
            <GaugeIcon size={15} />
          </span>
          <span className="skills-entry-copy">
            <span className="skills-entry-title">Usage & limits</span>
            <span className="skills-entry-sub">{usageSubtitle(usage)}</span>
          </span>
          {usage && usage.provider.availability === 'exhausted' ? (
            <span className="usage-entry-flag is-exhausted">LIMIT</span>
          ) : usage && usage.provider.availability === 'throttled' ? (
            <span className="usage-entry-flag">429</span>
          ) : usage && usage.provider.availability === 'degraded' ? (
            <span className="usage-entry-flag is-muted">KEY</span>
          ) : null}
        </button>

        <div className="sidebar-section-head spaced">
          <span>Workspaces</span>
          <IconButton label="Add workspace" className="mini" onClick={onAddWorkspace}>
            <FolderPlusIcon size={15} />
          </IconButton>
        </div>

        {workspaces.length === 0 ? (
          <div className="sidebar-empty">Link a project folder so the agent starts in the right place.</div>
        ) : (
          workspaces.map((workspace) => (
            <div key={workspace.id} className="ws-item">
              <button className="ws-main" onClick={() => onUseWorkspace(workspace.path)} title={workspace.path}>
                <FolderIcon size={15} />
                <span className="ws-name">{workspace.name || folderName(workspace.path)}</span>
              </button>
              <IconButton label="Remove workspace" className="mini" onClick={() => onRemoveWorkspace(workspace.id)}>
                <TrashIcon size={13} />
              </IconButton>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button className="server-pill" onClick={onOpenSettings}>
          <StatusDot tone={connected ? 'green' : status?.state === 'error' ? 'red' : 'amber'} />
          <span className="server-pill-text">
            <span className="server-pill-title">FCC {statusLabel(status)}</span>
            <span className="server-pill-sub">{status?.baseUrl ?? 'Not configured'}</span>
          </span>
        </button>
        <IconButton label="Settings" onClick={onOpenSettings}>
          <SettingsIcon size={17} />
        </IconButton>
      </div>
    </aside>
  )
}
