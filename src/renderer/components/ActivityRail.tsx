import type {
  AgentRuntimeInfo,
  ConnectionStatus,
  Conversation,
  ModelInfo,
} from '../../shared/types'
import { cost, duration, folderName, statusLabel } from '../lib/format'
import { IconButton, StatusDot } from './ui'
import {
  ActivityIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  TerminalIcon,
  XionMark,
} from './Icons'

export default function ActivityRail({
  conversation,
  runtime,
  phase,
  streaming,
  status,
  models,
  onClose,
}: {
  conversation: Conversation | null
  runtime: AgentRuntimeInfo | null
  phase: 'idle' | 'thinking' | 'working' | 'waiting'
  streaming: boolean
  status: ConnectionStatus | null
  models: ModelInfo[]
  onClose: () => void
}) {
  const lastAssistant = conversation
    ? [...conversation.messages].reverse().find((message) => message.role === 'assistant')
    : null
  const tools = lastAssistant
    ? lastAssistant.segments
        .flatMap((segment) => segment.blocks)
        .filter((block) => block.kind === 'tool')
        .map((block) => (block.kind === 'tool' ? block.tool : null))
        .filter((tool): tool is NonNullable<typeof tool> => tool !== null)
    : []

  const modelName = runtime?.model
    ? models.find((model) => model.id === runtime.model)?.displayName ?? runtime.model
    : conversation?.model || 'Server default'

  return (
    <aside className="activity">
      <header className="activity-head">
        <span className="activity-title">
          <ActivityIcon size={15} />
          Agent activity
        </span>
        <IconButton label="Close activity" onClick={onClose}>
          <CloseIcon size={15} />
        </IconButton>
      </header>

      <div className="activity-scroll">
        <section className={`activity-card ${streaming ? 'is-live' : ''}`}>
          <div className="activity-state">
            <span className={`state-orb ${streaming ? `is-live phase-${phase}` : 'is-idle'}`}>
              <XionMark size={15} />
            </span>
            <div>
              <div className="activity-state-title">
                {streaming ? (phase === 'working' ? 'Working' : phase === 'thinking' ? 'Reasoning' : 'Running') : 'Idle'}
              </div>
              <div className="activity-state-sub">
                {streaming ? 'Streaming from FCC' : runtime?.startedAt ? 'Session ready' : 'No active session'}
              </div>
            </div>
          </div>
          <div className="activity-kv">
            <div>
              <span>Model</span>
              <strong>{modelName}</strong>
            </div>
            <div>
              <span>Tools available</span>
              <strong>{runtime?.toolCount || '—'}</strong>
            </div>
            <div>
              <span>Session</span>
              <strong className="mono">{runtime?.sessionId ? runtime.sessionId.slice(0, 8) : '—'}</strong>
            </div>
          </div>
        </section>

        <section className="activity-card">
          <div className="activity-card-head">
            <FolderIcon size={14} />
            Working directory
          </div>
          <div className="path-row" title={runtime?.workingDirectory ?? conversation?.workspacePath ?? ''}>
            <span className="path-label">
              {runtime?.workingDirectory
                ? folderName(runtime.workingDirectory)
                : conversation?.workspacePath
                  ? folderName(conversation.workspacePath)
                  : 'Home directory'}
            </span>
            <span className="path-full">{runtime?.workingDirectory ?? conversation?.workspacePath ?? '~'}</span>
          </div>
          {runtime && runtime.additionalDirs.length > 0 ? (
            <div className="dir-list">
              <span className="dir-list-label">Extra access</span>
              {runtime.additionalDirs.map((dir) => (
                <div key={dir} className="dir-row" title={dir}>
                  {folderName(dir)}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="activity-card">
          <div className="activity-card-head">
            <TerminalIcon size={14} />
            Tool calls
            <span className="activity-counter">{tools.length}</span>
          </div>
          {tools.length === 0 ? (
            <div className="activity-empty">No tool activity in this turn.</div>
          ) : (
            <div className="tool-timeline">
              {tools.map((tool) => (
                <div key={tool.id || tool.name} className={`timeline-row is-${tool.status}`}>
                  <span className="timeline-dot">
                    {tool.status === 'ok' ? <CheckIcon size={10} /> : null}
                  </span>
                  <span className="timeline-name">{tool.name}</span>
                  <span className="timeline-state">{tool.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {lastAssistant?.meta ? (
          <section className="activity-card">
            <div className="activity-card-head">Last turn</div>
            <div className="activity-metrics">
              <div>
                <span>Duration</span>
                <strong>{duration(lastAssistant.meta.durationMs)}</strong>
              </div>
              <div>
                <span>Output</span>
                <strong>{lastAssistant.meta.outputTokens ?? '—'} tok</strong>
              </div>
              <div>
                <span>Cost</span>
                <strong>{cost(lastAssistant.meta.costUsd)}</strong>
              </div>
            </div>
          </section>
        ) : null}

        <section className="activity-card">
          <div className="activity-card-head">FCC endpoint</div>
          <div className="endpoint-row">
            <StatusDot tone={status?.state === 'connected' ? 'green' : 'red'} />
            <span>{status?.state === 'connected' ? 'Connected' : statusLabel(status)}</span>
            {status?.latencyMs !== null && status?.latencyMs !== undefined ? (
              <span className="endpoint-latency">{status.latencyMs} ms</span>
            ) : null}
          </div>
          <div className="endpoint-url">{status?.baseUrl ?? 'Not configured'}</div>
          {status?.provider ? (
            <div className="endpoint-meta">
              provider <strong>{status.provider}</strong>
            </div>
          ) : null}
          {status?.serverModel ? <div className="endpoint-meta">server model {status.serverModel}</div> : null}
        </section>
      </div>
    </aside>
  )
}
