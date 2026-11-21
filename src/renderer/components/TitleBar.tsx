import { IconButton } from './ui'
import {
  ActivityIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
  SidebarIcon,
  XionMark,
  CloseIcon,
} from './Icons'

export default function TitleBar({
  maximized,
  sidebarCollapsed,
  onToggleSidebar,
  onToggleActivity,
  activityOpen,
  title,
}: {
  maximized: boolean
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onToggleActivity: () => void
  activityOpen: boolean
  title: string
}) {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <button className="brand" onClick={onToggleSidebar} title="Toggle sidebar">
          <XionMark size={20} className="brand-mark" />
          <span className="brand-word">
            FCC<span className="brand-dot">·</span>DESKTOP
          </span>
        </button>
        <span className="titlebar-divider" />
        <span className="titlebar-title">{title}</span>
      </div>

      <div className="titlebar-drag" />

      <div className="titlebar-right">
        <IconButton label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} onClick={onToggleSidebar}>
          <SidebarIcon size={16} />
        </IconButton>
        <IconButton label="Agent activity" active={activityOpen} onClick={onToggleActivity}>
          <ActivityIcon size={16} />
        </IconButton>
        <span className="titlebar-divider" />
        <button className="win-btn" onClick={() => window.fcc.app.minimize()} aria-label="Minimize">
          <MinimizeIcon size={15} />
        </button>
        <button className="win-btn" onClick={() => window.fcc.app.maximize()} aria-label={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button className="win-btn win-btn-close" onClick={() => window.fcc.app.close()} aria-label="Close">
          <CloseIcon size={15} />
        </button>
      </div>
    </header>
  )
}
