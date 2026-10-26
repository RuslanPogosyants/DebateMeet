import { useEffect, useRef, useState } from 'react'
import type { DeviceSelection, Preview } from '@/application/ports'
import { useServices } from '@/ui/services'
import { deviceErrorText, strings } from '@/ui/strings'

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
  const [level, setLevel] = useState(0)
  const [list, setList] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState<unknown>(null)
  const [choosing, setChoosing] = useState(false)

  useEffect(() => {
    let cancelled = false
    let active: Preview | null = null
    let stopLevel = () => {}
    devices.preview(request.cameraId || undefined, request.microphoneId || undefined).then(
      (opened) => {
        if (cancelled) {
          opened.close()
          return
        }
        active = opened
        setResult({ request, preview: opened })
        stopLevel = opened.level(setLevel)
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
        {(!camera || !cameraReady) && <p>{strings.round.cameraAbsent}</p>}
      </div>
      <div className="preview-actions">
        <button
          className="action"
          type="button"
          aria-pressed={camera}
          onClick={() => {
            setCamera(!camera)
          }}
        >
          {camera ? strings.round.cameraOn : strings.round.cameraOff}
        </button>
        <button
          className="action"
          type="button"
          onClick={() => {
            setChoosing(!choosing)
          }}
        >
          {strings.round.devices}
        </button>
        <button
          className="text-link"
          type="button"
          onClick={() => {
            void devices.sound().catch(setError)
          }}
        >
          {strings.round.sound}
        </button>
      </div>
      {choosing && (
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
              <option value="">{strings.round.defaultDevice}</option>
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
              <option value="">{strings.round.defaultDevice}</option>
              {microphones.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `${strings.round.microphone} ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
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
        <meter min={0} max={1} value={level} aria-label={strings.round.microphone} />
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
