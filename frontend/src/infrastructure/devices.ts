import type { Devices, Preview } from '@/application/ports'
import { routeOutput } from './audio-output'

export class BrowserDevices implements Devices {
  private outputId = ''
  private soundContext: AudioContext | null = null
  private outputQueue: Promise<void> = Promise.resolve()

  async outputSupported(): Promise<boolean> {
    const { supportsAudioOutputSelection } = await import('livekit-client')
    return (
      typeof AudioContext !== 'undefined' &&
      'setSinkId' in AudioContext.prototype &&
      'sinkId' in AudioContext.prototype &&
      supportsAudioOutputSelection()
    )
  }

  output(id: string): Promise<string | null> {
    this.outputId = id
    const context = this.soundContext
    if (context === null) return Promise.resolve(null)
    const job = this.outputQueue.then(() =>
      this.soundContext === context ? routeOutput(context, this.outputId) : null,
    )
    this.outputQueue = job.then(
      () => {},
      () => {},
    )
    return job
  }
  async preview(cameraId?: string, microphoneId?: string): Promise<Preview> {
    const stream = new MediaStream()
    let cameraError: unknown = null
    let microphoneError: unknown = null
    const camera = cameraId ? { deviceId: { exact: cameraId } } : true
    const microphone = microphoneId ? { deviceId: { exact: microphoneId } } : true
    await Promise.all([
      navigator.mediaDevices.getUserMedia({ video: camera }).then(
        (video) => {
          for (const track of video.getTracks()) stream.addTrack(track)
        },
        (error: unknown) => {
          cameraError = error
        },
      ),
      navigator.mediaDevices.getUserMedia({ audio: microphone }).then(
        (audio) => {
          for (const track of audio.getTracks()) stream.addTrack(track)
        },
        (error: unknown) => {
          microphoneError = error
        },
      ),
    ])
    return {
      stream,
      cameraError,
      microphoneError,
      level(callback) {
        if (stream.getAudioTracks().length === 0) return () => {}
        const context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        const timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples)
          callback(
            Math.min(
              1,
              Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) *
                8,
            ),
          )
        }, 100)
        return () => {
          clearInterval(timer)
          source.disconnect()
          void context.close()
        }
      },
      close() {
        for (const track of stream.getTracks()) track.stop()
      },
    }
  }

  list(): Promise<MediaDeviceInfo[]> {
    return navigator.mediaDevices.enumerateDevices()
  }

  async sound(): Promise<void> {
    if (this.soundContext !== null) return
    const context = new AudioContext()
    this.soundContext = context
    try {
      await this.output(this.outputId)
      await context.resume()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      gain.gain.value = 0.08
      oscillator.frequency.value = 660
      oscillator.connect(gain).connect(context.destination)
      oscillator.start()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250)
      })
      oscillator.stop()
    } finally {
      if (this.soundContext === context) this.soundContext = null
      await context.close()
    }
  }
}
