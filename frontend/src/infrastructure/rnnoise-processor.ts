import type { LocalAudioTrack } from 'livekit-client'

type Processor = Parameters<LocalAudioTrack['setProcessor']>[0]
type Options = Parameters<Processor['init']>[0]

type WorkletNode = import('@sapphi-red/web-noise-suppressor').RnnoiseWorkletNode

export async function prepareRnnoise(
  context: AudioContext,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (signal.aborted) throw new DOMException('Noise suppression cancelled', 'AbortError')
  return (await import('./rnnoise-worklet')).prepare(context, signal)
}

export class RnnoiseProcessor implements Processor {
  readonly name = 'debatemeet-rnnoise'
  processedTrack: MediaStreamTrack | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private destination: MediaStreamAudioDestinationNode | undefined
  private node: WorkletNode | undefined
  private gain: GainNode | undefined
  private volume = 1
  private destroyed = false
  private readonly binary: ArrayBuffer | null
  private readonly signal: AbortSignal
  private readonly failed: (error: unknown) => void

  constructor(binary: ArrayBuffer | null, signal: AbortSignal, failed: (error: unknown) => void) {
    this.binary = binary
    this.signal = signal
    this.failed = failed
  }

  async init(options: Options): Promise<void> {
    try {
      await this.build(options)
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  async restart(options: Options): Promise<void> {
    this.cleanup()
    try {
      await this.build(options)
    } catch (error) {
      this.cleanup()
      if (!this.signal.aborted) this.failed(error)
      // The SDK can then replace the old sender with the newly acquired raw track.
    }
  }

  destroy(): Promise<void> {
    this.destroyed = true
    this.cleanup()
    return Promise.resolve()
  }

  setVolume(value: number): void {
    this.volume = value
    if (this.gain) this.gain.gain.value = value
  }

  silence(): void {
    if (this.processedTrack) this.processedTrack.enabled = false
  }

  private cleanup(): void {
    this.silence()
    this.source?.disconnect()
    this.node?.disconnect()
    this.node?.destroy()
    this.gain?.disconnect()
    this.destination?.disconnect()
    this.processedTrack?.stop()
    this.source = undefined
    this.node = undefined
    this.destination = undefined
    this.gain = undefined
    this.processedTrack = undefined
  }

  private async build(options: Options): Promise<void> {
    const context = options.audioContext
    if (
      this.destroyed ||
      this.signal.aborted ||
      options.track.readyState !== 'live' ||
      context.state !== 'running'
    )
      throw new DOMException('Microphone unavailable', 'AbortError')
    if (this.binary) {
      const { RnnoiseWorkletNode } = await import('./rnnoise-worklet')
      const node = new RnnoiseWorkletNode(context, { wasmBinary: this.binary, maxChannels: 1 })
      this.node = node
      await new Promise<void>((resolve, reject) => {
        let done = false
        const finish = (error?: Error) => {
          if (done) return
          done = true
          clearTimeout(timer)
          this.signal.removeEventListener('abort', cancelled)
          node.port.removeEventListener('message', message)
          node.removeEventListener('processorerror', processorError)
          if (error) reject(error)
          else resolve()
        }
        const cancelled = () =>
          finish(new DOMException('Noise suppression cancelled', 'AbortError'))
        const processorError = () => finish(new Error('Noise suppression failed'))
        const message = (event: MessageEvent<unknown>) => {
          if (typeof event.data !== 'object' || event.data === null || !('type' in event.data))
            return
          if (event.data.type === 'ready') finish()
          else if (event.data.type === 'init-error') finish(new Error('Noise suppression failed'))
        }
        const timer = setTimeout(
          () => finish(new Error('Noise suppression initialization timed out')),
          8000,
        )
        this.signal.addEventListener('abort', cancelled, { once: true })
        node.addEventListener('processorerror', processorError)
        node.port.addEventListener('message', message)
        node.port.start()
        if (this.signal.aborted) cancelled()
      })
    }
    if (
      this.destroyed ||
      this.signal.aborted ||
      options.track.readyState !== 'live' ||
      context.state !== 'running'
    )
      throw new DOMException('Microphone unavailable', 'AbortError')
    this.source = context.createMediaStreamSource(new MediaStream([options.track]))
    this.destination = context.createMediaStreamDestination()
    this.processedTrack = this.destination.stream.getAudioTracks()[0]
    if (!this.processedTrack) throw new Error('Noise suppression output unavailable')
    this.processedTrack.enabled = false
    this.gain = context.createGain()
    this.gain.gain.value = this.volume
    if (this.node) {
      this.node.addEventListener(
        'processorerror',
        () => {
          this.silence()
          this.failed(new Error('Noise suppression stopped'))
        },
        { once: true },
      )
      this.source.connect(this.node).connect(this.gain).connect(this.destination)
    } else {
      this.source.connect(this.gain).connect(this.destination)
    }
  }
}
