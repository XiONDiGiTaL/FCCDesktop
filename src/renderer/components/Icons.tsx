import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Icon>
)

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.4h7.4a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
)

export const FolderPlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.4h7.4a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M12 11.5v5M9.5 14h5" />
  </Icon>
)

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
)

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </Icon>
)

export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />
  </Icon>
)

export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11.5 12.6 19a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.6 1.6 0 0 1-2.2-2.2l7-7" />
  </Icon>
)

export const ChipIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.4" />
    <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
  </Icon>
)

export const TerminalIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="m7.5 10 2.5 2.2-2.5 2.3M12.5 14.5h4" />
  </Icon>
)

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.2 4.2L19 6.8" />
  </Icon>
)

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
)

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
)

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
)

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Icon>
)

export const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6z" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
)

export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.4" />
    <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H6.5A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" />
  </Icon>
)

export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 1 0-2.4 5.6" />
    <path d="M20 4.5V11h-6.4" />
  </Icon>
)

export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5v13l11-6.5z" />
  </Icon>
)

export const PowerIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5v8" />
    <path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0" />
  </Icon>
)

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7h15M9.5 7V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4A1.3 1.3 0 0 1 14.5 4.8V7" />
    <path d="M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7" />
    <path d="M10.5 11v5M13.5 11v5" />
  </Icon>
)

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.5 3.5 20.5 8.5l-3 1.2-4.3 4.3.4 3.6-2 2-2.6-4.9-4.4-2.6 2-2 3.6.4 4.3-4.3z" />
    <path d="m8 16-4 4" />
  </Icon>
)

export const SparkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5c.7 4.3 1.7 5.3 6 6-4.3.7-5.3 1.7-6 6-.7-4.3-1.7-5.3-6-6 4.3-.7 5.3-1.7 6-6z" />
    <path d="M18.5 15.5c.3 1.7.8 2.2 2.5 2.5-1.7.3-2.2.8-2.5 2.5-.3-1.7-.8-2.2-2.5-2.5 1.7-.3 2.2-.8 2.5-2.5z" />
  </Icon>
)

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5 21 20H3z" />
    <path d="M12 10v4.5M12 17.4v.1" />
  </Icon>
)

export const ActivityIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />
  </Icon>
)

export const MinimizeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 12h12" />
  </Icon>
)

export const MaximizeIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" />
  </Icon>
)

export const RestoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="7.5" width="12" height="12" rx="2" />
    <path d="M8.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
  </Icon>
)

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
    <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3" />
  </Icon>
)

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4.5 17 4.6-4.6a2 2 0 0 1 2.8 0l3.3 3.3 1.6-1.6a2 2 0 0 1 2.8 0l2.9 2.9" />
  </Icon>
)

export const FileIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3.5h6.5L19 9v9.5A2 2 0 0 1 17 20.5H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" />
    <path d="M13 3.5V9h5.5" />
  </Icon>
)

export const CodeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
  </Icon>
)

export const ArrowUpRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 17 17 7M9 7h8v8" />
  </Icon>
)

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
)

export const SidebarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M9.5 4.5v15" />
  </Icon>
)

export const GaugeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.2 17.5a8.2 8.2 0 1 1 15.6 0" />
    <path d="M12 17.5l4.1-5" />
    <circle cx="12" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 11v5.5M12 7.8v.4" />
  </Icon>
)

export const XionMark = ({ size = 22, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
    <defs>
      <linearGradient id="xion-mark-grad" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
        <stop stopColor="#79a8ff" />
        <stop offset="1" stopColor="#3f80ff" />
      </linearGradient>
    </defs>
    <path
      d="M5.2 4.4h4.9l6.1 7.9 3.1-4 1.9 2.6-3 3.9 6.8 8.8h-5l-6.1-7.9-6.9 8.9H3.1l9-11.6z"
      fill="url(#xion-mark-grad)"
    />
    <path d="M24.2 4.4h3.6l-4.2 5.4-1.8-2.3z" fill="#79a8ff" fillOpacity="0.9" />
  </svg>
)
