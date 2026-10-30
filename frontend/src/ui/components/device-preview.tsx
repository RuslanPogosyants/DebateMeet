import { useEffect, useRef, useState } from 'react'
import type { DeviceSelection, Preview } from '@/application/ports'
import { useServices } from '@/ui/services'
import { deviceErrorText, strings } from '@/ui/strings'
import { ControlIcon } from './control-icon'

function defaultDeviceLabel(name: string | undefined): string {
  const label = name?.replace(/^(?:по умолчанию|default)\s*[-–—:]\s*/iu, '').trim()
  return label
    ? `${label} (${strings.round.defaultDevice.toLowerCase()})`
    : strings.round.defaultDevice
}

export function DevicePreview({
  camera,
  setCamera,
  onSelection,
}: {
  camera: boolean
  setCamera: (enabled: boolean) => void
  onSelection: (devices: DeviceSelection) => void
}) {
  const { devices } = useServices()
  const video = useRef<HTMLVideoElement>(null)
  const [request, setRequest] = useState({ cameraId: '', microphoneId: '' })
  const [result, setResult] = useState<{ request: typeof request; preview: Preview } | null>(null)
  const preview = result?.request === request ? result.preview : null
  const [level, setLevel] = useState<{ request: typeof request; value: number } | null>(null)
  const [list, setList] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    let active: Preview | null = null
    let stopLevel = () => {}
    let sampleTimer: ReturnType<typeof setInterval> | undefined
    devices.preview(request.cameraId || undefined, request.microphoneId || undefined).then(
      (opened) => {
        if (cancelled) {
          opened.close()
          return
        }
        active = opened
        setResult({ request, preview: opened })
        let target = 0
        let smoothed = 0
        stopLevel = opened.level((value) => {
          if (!cancelled) target = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
        })
        if (opened.stream.getAudioTracks().length > 0) {
          // A quiet release keeps short syllables readable without changing captured audio.
          sampleTimer = setInterval(() => {
            const weight = target > smoothed ? 0.48 : 0.2
            smoothed += (target - smoothed) * weight
            if (smoothed < 0.005) smoothed = 0
            setLevel({ request, value: smoothed })
          }, 100)
        }
        if (video.current !== null) video.current.srcObject = opened.stream
        void devices.list().then(setList, () => {})
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure)
      },
    )
    return () => {
      cancelled = true
      stopLevel()
      clearInterval(sampleTimer)
      active?.close()
    }
  }, [devices, request])

  useEffect(() => {
    if (preview === null) return
    for (const track of preview.stream.getVideoTracks()) track.enabled = camera
  }, [preview, camera])

  const cameras = list.filter((device) => device.kind === 'videoinput')
  const microphones = list.filter((device) => device.kind === 'audioinput')
  const cameraReady = preview !== null && preview.stream.getVideoTracks().length > 0
  const microphoneReady = preview !== null && preview.stream.getAudioTracks().length > 0
  const cameraName =
    request.cameraId === '' ? preview?.stream.getVideoTracks()[0]?.label : undefined
  const microphoneName =
    request.microphoneId === '' ? preview?.stream.getAudioTracks()[0]?.label : undefined

  return (
    <section className="device-check" aria-label={strings.round.cameraPreview}>
      <div className="preview-stage">
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          className={camera && cameraReady ? '' : 'video-hidden'}
          aria-label={strings.round.cameraPreview}
        />
        {(!camera || !cameraReady) && (
          <div className="preview-placeholder silhouette-placeholder">
            <ControlIcon kind="person" />
            <p>{strings.round.cameraAbsent}</p>
          </div>
        )}
      </div>
      <div className="preview-actions">
        <button
          className="action media-toggle"
          type="button"
          aria-label={camera ? strings.round.cameraOn : strings.round.cameraOff}
          title={camera ? strings.round.cameraOn : strings.round.cameraOff}
          aria-pressed={camera}
          onClick={() => {
            setCamera(!camera)
          }}
        >
          <ControlIcon kind="camera" off={!camera} />
        </button>
        <button
          className="action media-toggle"
          type="button"
          aria-label={strings.round.sound}
          title={strings.round.sound}
          onClick={() => {
            void devices.sound().catch(setError)
          }}
        >
          <ControlIcon kind="speaker" />
        </button>
      </div>
      <div className="device-selectors">
        <label>
          {strings.round.camera}
          <select
            value={request.cameraId}
            onChange={(event) => {
              setRequest({ ...request, cameraId: event.target.value })
              onSelection({
                cameraId: event.target.value || undefined,
                microphoneId: request.microphoneId || undefined,
              })
            }}
          >
            <option value="">{defaultDeviceLabel(cameraName)}</option>
            {cameras.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `${strings.round.camera} ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {strings.round.microphone}
          <select
            value={request.microphoneId}
            onChange={(event) => {
              setRequest({ ...request, microphoneId: event.target.value })
              onSelection({
                cameraId: request.cameraId || undefined,
                microphoneId: event.target.value || undefined,
              })
            }}
          >
            <option value="">{defaultDeviceLabel(microphoneName)}</option>
            {microphones.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `${strings.round.microphone} ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="device-statuses">
        <p>
          {strings.round.camera}
          <span>
            {preview === null
              ? strings.round.checking
              : cameraReady
                ? strings.round.ready
                : deviceErrorText(preview.cameraError)}
          </span>
        </p>
        <p>
          {strings.round.microphone}
          <span>
            {preview === null
              ? strings.round.checking
              : microphoneReady
                ? strings.round.ready
                : deviceErrorText(preview.microphoneError)}
          </span>
        </p>
        <div
          className="microphone-level"
          role="meter"
          aria-label="Уровень микрофона"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(
            (preview !== null && level?.request === request ? level.value : 0) * 100,
          )}
        >
          <span
            style={{
              transform: `scaleX(${preview !== null && level?.request === request ? level.value : 0})`,
            }}
          />
        </div>
      </div>
      {(error !== null || (preview !== null && (!cameraReady || !microphoneReady))) && (
        <button
          className="text-link"
          type="button"
          onClick={() => {
            setError(null)
            setRequest({ ...request })
          }}
        >
          {strings.round.retry}
        </button>
      )}
      {error !== null && <p role="alert">{deviceErrorText(error)}</p>}
    </section>
  )
}
