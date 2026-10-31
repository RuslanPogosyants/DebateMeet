import { Component, useId, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { DeviceKind } from '@/application/ports'
import { Sheet } from './sheet'
import { ConfirmDialog } from './confirm-dialog'
import { deviceErrorText, resilienceStrings as text, strings } from '@/ui/strings'

export function QualityMark({ quality = 'unknown' }: { quality?: keyof typeof text.qualityNames }) {
  return (
    <span
      className="quality-mark text-caption"
      data-quality={quality}
      role="img"
      aria-label={text.qualityNames[quality]}
      title={text.qualityNames[quality]}
    >
      {text.qualityShortNames[quality]}
    </span>
  )
}

export function VersionNotice({
  controller,
  canReload = false,
}: {
  controller: RoundController
  canReload?: boolean
}) {
  const version = useStore(controller.version.store)
  const pending = useStore(
    controller.store,
    (state) =>
      state.commandPending ||
      state.commandUncertain ||
      (state.stage !== 'prejoin' && state.stage !== 'left'),
  )
  const draft = useStore(
    controller.chat.store,
    (state) => state.draft !== '' || state.sending || state.uncertain,
  )
  if (!version.changed && !version.preloadFailed) return null
  return (
    <div className="meeting-banner version-notice" role="status">
      <p>{version.preloadFailed ? text.preloadFailed : text.versionChanged}</p>
      {canReload && !pending && !draft && (
        <button className="action" type="button" onClick={() => window.location.reload()}>
          {text.reload}
        </button>
      )}
    </div>
  )
}

export function ConnectionNotice({ controller }: { controller: RoundController }) {
  const suggest = useStore(controller.diagnostics.store, (state) => state.suggestCameraOff)
  const camera = useStore(
    controller.store,
    (state) => state.people.find((person) => person.id === state.self)?.camera ?? false,
  )
  if (!suggest || !camera) return null
  return (
    <div className="meeting-banner connection-notice" role="status">
      <p>{text.cameraSuggestion}</p>
      <button
        className="action"
        type="button"
        onClick={() => {
          void controller.cameraEnabled(false)
        }}
      >
        {text.turnCameraOff}
      </button>
    </div>
  )
}

export function SceneControls({ controller }: { controller: RoundController }) {
  const scene = useStore(controller.scene.store)
  return (
    <div className="scene-controls" role="group" aria-label={text.layout}>
      <button
        className="scene-choice"
        type="button"
        aria-pressed={scene.layout === 'grid'}
        onClick={() => controller.scene.setLayout('grid')}
      >
        {text.grid}
      </button>
      <button
        className="scene-choice"
        type="button"
        aria-pressed={scene.layout === 'speaker'}
        onClick={() => controller.scene.setLayout('speaker')}
      >
        {text.speaker}
      </button>
      <label className="self-view-choice">
        <input
          type="checkbox"
          checked={scene.showSelf}
          onChange={(event) => controller.scene.setSelfVisible(event.target.checked)}
        />
        {text.showSelf}
      </label>
    </div>
  )
}

export function RuntimeDevices({ controller }: { controller: RoundController }) {
  const state = useStore(controller.devices.store)
  const prefix = useId()
  const selectors: { kind: DeviceKind; label: string; selected: string | undefined }[] = [
    { kind: 'audioinput', label: text.microphone, selected: state.selected.microphoneId },
    { kind: 'videoinput', label: text.camera, selected: state.selected.cameraId },
    { kind: 'audiooutput', label: text.output, selected: state.selected.outputId },
  ]
  return (
    <div className="runtime-devices">
      {selectors.map((selector) => (
        <label key={selector.kind} htmlFor={`${prefix}-${selector.kind}`}>
          {selector.label}
          <select
            id={`${prefix}-${selector.kind}`}
            value={selector.selected ?? ''}
            disabled={
              state.pendingKinds.includes(selector.kind) ||
              (selector.kind === 'audiooutput' && !state.outputSupported)
            }
            onChange={(event) => {
              void controller.devices.select(selector.kind, event.target.value)
            }}
          >
            <option value="" disabled={selector.kind !== 'audiooutput'}>
              {text.defaultDevice}
            </option>
            {state.available
              .filter(
                (device) =>
                  device.kind === selector.kind &&
                  device.deviceId !== '' &&
                  !(selector.kind === 'audiooutput' && device.deviceId === 'default'),
              )
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `${selector.label} ${index + 1}`}
                </option>
              ))}
          </select>
          {selector.kind === 'audiooutput' && !state.outputSupported && (
            <span>{text.outputUnavailable}</span>
          )}
        </label>
      ))}
      <button
        className="action"
        type="button"
        onClick={() => {
          void controller.devices.refresh()
        }}
      >
        {text.refreshDevices}
      </button>
      {state.pending && <p role="status">{text.devicesPending}</p>}
      {state.error !== null && (
        <div role="alert">
          <p>{deviceErrorText(state.error)}</p>
          <button
            className="text-link"
            type="button"
            onClick={() => controller.devices.dismissError()}
          >
            {strings.round.dismiss}
          </button>
        </div>
      )}
    </div>
  )
}

export function ProblemReport({
  controller,
  onClose,
}: {
  controller: RoundController
  onClose: () => void
}) {
  const report = useStore(controller.diagnostics.store)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  async function copyReport() {
    if (report.reportId === null) return
    try {
      await navigator.clipboard.writeText(report.reportId)
      setCopied(report.reportId)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }
  return (
    <Sheet title={text.report} onClose={onClose}>
      <div className="problem-report">
        <p>{text.reportDescription}</p>
        <button
          className="action-primary"
          type="button"
          disabled={report.reporting}
          onClick={() => {
            void controller.diagnostics.report()
          }}
        >
          {report.reporting ? text.reporting : text.saveReport}
        </button>
        {report.reportError && <p role="alert">{text.reportFailed}</p>}
        {report.reportId !== null && (
          <p role="status">
            {text.reportSaved} <code data-testid="diagnostic-report-id">{report.reportId}</code>
          </p>
        )}
        {report.reportId !== null && (
          <button
            className="action"
            type="button"
            onClick={() => {
              void copyReport()
            }}
          >
            {copied === report.reportId ? strings.round.copied : text.copyReport}
          </button>
        )}
        {copyFailed && <p role="alert">{text.reportCopyFailed}</p>}
      </div>
    </Sheet>
  )
}

export function RoundFailureActions({ controller }: { controller: RoundController }) {
  const [reportOpen, setReportOpen] = useState(false)
  const [judgeLeave, setJudgeLeave] = useState(false)
  const judge = useStore(
    controller.store,
    (state) => state.self !== null && state.snapshot?.judgeFlag.holder === state.self,
  )
  return (
    <div className="round-failure-actions">
      <button
        className="action"
        type="button"
        onClick={() => {
          void controller.microphone(false)
        }}
      >
        {text.turnMicrophoneOff}
      </button>
      <button
        className="action"
        type="button"
        onClick={() => {
          void controller.cameraEnabled(false)
        }}
      >
        {text.turnCameraOff}
      </button>
      <button className="action" type="button" onClick={() => setReportOpen(true)}>
        {text.report}
      </button>
      <button
        className="action"
        type="button"
        onClick={() => {
          if (judge) setJudgeLeave(true)
          else void controller.leave()
        }}
      >
        {strings.round.leave}
      </button>
      {reportOpen && <ProblemReport controller={controller} onClose={() => setReportOpen(false)} />}
      {judgeLeave && (
        <ConfirmDialog
          title={strings.round.judgeLeave}
          confirm={strings.round.leave}
          onCancel={() => setJudgeLeave(false)}
          onConfirm={() => {
            setJudgeLeave(false)
            void controller.leave()
          }}
        >
          <p>{text.judgeFailureLeave}</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

export class RoundViewBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void; fallback?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(error: Error): void {
    this.props.onError(error)
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="entry-shell">
        <div role="alert">
          <h1 className="font-display text-title font-bold">{text.renderFailed}</h1>
          <p>{text.renderFailedHint}</p>
          <button className="action" type="button" onClick={() => this.setState({ failed: false })}>
            {text.restoreView}
          </button>
        </div>
        {this.props.fallback}
      </main>
    )
  }
}
