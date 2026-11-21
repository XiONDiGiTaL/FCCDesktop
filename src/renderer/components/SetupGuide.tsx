import { useState } from 'react'
import type { ConnectionStatus } from '../../shared/types'
import { ArrowUpRightIcon, CheckIcon } from './Icons'

const INSTALL_COMMAND =
  '& ([scriptblock]::Create((irm "https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/scripts/install.ps1")))'

const NVIDIA_KEYS_URL = 'https://build.nvidia.com/settings/api-keys'
const FCC_QUICK_START_URL = 'https://github.com/Alishahryar1/free-claude-code#quick-start'

interface SetupGuideProps {
  status: ConnectionStatus | null
  onOpenSettings?: () => void
  variant?: 'inline' | 'panel'
}

function truncateUrl(url: string, max = 34) {
  return url.length > max ? `${url.slice(0, max - 1)}…` : url
}

export default function SetupGuide({ status, onOpenSettings, variant = 'inline' }: SetupGuideProps) {
  const [copied, setCopied] = useState(false)
  const baseUrl = status?.baseUrl || 'http://127.0.0.1:8082'
  const adminUrl = `${baseUrl.replace(/\/+$/, '')}/admin`

  const copyInstall = async () => {
    const ok = await window.fcc.app.copyText(INSTALL_COMMAND)
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className={`setup-guide setup-${variant}`} aria-label="Free Claude Code setup steps">
      <header className="setup-head">
        <span className="setup-eyebrow">
          <span className="status-dot status-amber" />
          FCC not reachable
        </span>
        <h2 className="setup-title">Start Free Claude Code, then connect</h2>
        <p className="setup-lede">
          Nothing answered at <code>{truncateUrl(baseUrl)}</code>. This app drives the FCC proxy — it cannot run an
          agent without it. Three steps, once per machine.
        </p>
      </header>

      <ol className="setup-steps">
        <li className="setup-step">
          <span className="setup-index">1</span>
          <div className="setup-body">
            <h3>Install FCC</h3>
            <p>
              Paste this into <strong>PowerShell</strong> and choose <strong>Claude Code</strong> when it asks which
              agents to set up.
            </p>
            <div className="setup-cmd">
              <code>{INSTALL_COMMAND}</code>
              <button className="setup-copy" onClick={() => void copyInstall()} aria-label="Copy install command">
                {copied ? <CheckIcon size={12} /> : null}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="setup-note">
              Already installed? <code>fcc-server --version</code> should print a version.
            </p>
          </div>
        </li>

        <li className="setup-step">
          <span className="setup-index">2</span>
          <div className="setup-body">
            <h3>Start the server</h3>
            <p>
              Launch <strong>Free Claude Code</strong> from the Start menu, or run <code>fcc-server</code>. It listens
              on <code>{baseUrl}</code> and opens the Admin UI — the exact URL is in the server log.
            </p>
            <button className="setup-link" onClick={() => void window.fcc.app.openExternal(FCC_QUICK_START_URL)}>
              FCC quick start
              <ArrowUpRightIcon size={12} />
            </button>
          </div>
        </li>

        <li className="setup-step">
          <span className="setup-index">3</span>
          <div className="setup-body">
            <h3>Add a free NVIDIA key in Admin</h3>
            <ol className="setup-mini">
              <li>
                Get a key at <strong>build.nvidia.com</strong> → API Keys. Free tier, no credit card.
              </li>
              <li>
                In Admin open <strong>Providers</strong>, pick <strong>NVIDIA NIM</strong>, click{' '}
                <strong>Add key</strong>.
              </li>
              <li>
                Paste it, click <strong>Save</strong>, leave <code>MODEL</code> on{' '}
                <code>nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b</code> or choose another tool-capable model, then
                click <strong>Apply</strong>.
              </li>
            </ol>
            <div className="setup-links">
              <button className="setup-link" onClick={() => void window.fcc.app.openExternal(adminUrl)}>
                Open Admin UI
                <ArrowUpRightIcon size={12} />
              </button>
              <button className="setup-link" onClick={() => void window.fcc.app.openExternal(NVIDIA_KEYS_URL)}>
                Get NVIDIA key
                <ArrowUpRightIcon size={12} />
              </button>
            </div>
          </div>
        </li>
      </ol>

      <footer className="setup-foot">
        <span>Connection re-checks every 15 seconds — sending unlocks once FCC answers.</span>
        {onOpenSettings ? (
          <button className="setup-link is-strong" onClick={onOpenSettings}>
            Connection settings
          </button>
        ) : null}
      </footer>
    </section>
  )
}
