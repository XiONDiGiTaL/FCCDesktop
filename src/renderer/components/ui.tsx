import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { useEffect } from 'react'
import { CheckIcon, ChevronDownIcon, CloseIcon } from './Icons'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  block,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${block ? 'btn-block' : ''} ${className}`}
      {...rest}
    >
      {icon ? <span className="btn-icon-slot">{icon}</span> : null}
      {children ? <span>{children}</span> : null}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
}

export function IconButton({ label, active, children, className = '', ...rest }: IconButtonProps) {
  return (
    <button
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <label className={`toggle-row ${disabled ? 'is-disabled' : ''}`}>
      <span className="toggle-copy">
        <span className="toggle-label">{label}</span>
        {description ? <span className="toggle-desc">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
  error,
  inline,
}: {
  label: string
  hint?: string
  children: ReactNode
  error?: string | null
  inline?: boolean
}) {
  return (
    <div className={`field ${inline ? 'field-inline' : ''}`}>
      <div className="field-head">
        <span className="field-label">{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </div>
      {children}
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="select-wrap">
      <select className={`input select ${className}`} {...rest}>
        {children}
      </select>
      <ChevronDownIcon size={15} className="select-chevron" />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented-item ${option.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'blue' | 'green' | 'red' | 'amber'
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

export function StatusDot({ tone }: { tone: 'green' | 'red' | 'amber' | 'blue' | 'neutral' }) {
  return <span className={`status-dot status-${tone}`} aria-hidden="true" />
}

export function Modal({
  open,
  onClose,
  children,
  className = '',
  labelledBy,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  labelledBy?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="section-header">
      <div>
        <h2 className="section-title">{title}</h2>
        {description ? <p className="section-desc">{description}</p> : null}
      </div>
      {action ? <div className="section-action">{action}</div> : null}
    </div>
  )
}

export function CheckRow({
  checked,
  onClick,
  title,
  description,
  trailing,
}: {
  checked: boolean
  onClick: () => void
  title: ReactNode
  description?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <button type="button" className={`check-row ${checked ? 'is-checked' : ''}`} onClick={onClick}>
      <span className="check-box">{checked ? <CheckIcon size={13} /> : null}</span>
      <span className="check-copy">
        <span className="check-title">{title}</span>
        {description ? <span className="check-desc">{description}</span> : null}
      </span>
      {trailing}
    </button>
  )
}

export function InlineNotice({
  tone = 'info',
  children,
  onClose,
}: {
  tone?: 'info' | 'error' | 'success'
  children: ReactNode
  onClose?: () => void
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <div className="notice-body">{children}</div>
      {onClose ? (
        <button type="button" className="notice-close" onClick={onClose} aria-label="Dismiss">
          <CloseIcon size={14} />
        </button>
      ) : null}
    </div>
  )
}
