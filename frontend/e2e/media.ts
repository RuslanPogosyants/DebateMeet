import type { Page } from '@playwright/test'

export type AudioFrame = { at: number; room: string; bands: number[] }

declare global {
  interface Window {
    debatemeetAudioOutputs: AnalyserNode[]
    debatemeetReadBands(frequencies: number[], contexts?: readonly BaseAudioContext[]): number[]
    debatemeetAudioFrames: AudioFrame[]
    debatemeetAudioRecording: number | undefined
  }
}

export async function measureRenderedAudio(page: Page, toneHz?: number) {
  // Instrument the actual output graph in the test browser, without production debug hooks.
  await page.addInitScript(() => {
    window.debatemeetAudioOutputs = []
    const destinations = new WeakMap<AudioDestinationNode, AnalyserNode>()
    const connect: unknown = Object.getOwnPropertyDescriptor(AudioNode.prototype, 'connect')?.value
    const disconnect: unknown = Object.getOwnPropertyDescriptor(
      AudioNode.prototype,
      'disconnect',
    )?.value
    if (typeof connect !== 'function' || typeof disconnect !== 'function')
      throw new Error('Web Audio routing is unavailable')
    Object.defineProperty(AudioNode.prototype, 'connect', {
      value: function (
        this: AudioNode,
        destination: AudioNode | AudioParam,
        output = 0,
        input = 0,
      ): AudioNode | undefined {
        if (destination instanceof AudioDestinationNode) {
          // One live output bus per destination. Disconnected source branches cannot leave
          // cached analyser spectra that are mistaken for newly received media.
          let analyser = destinations.get(destination)
          if (analyser === undefined) {
            analyser = this.context.createAnalyser()
            analyser.fftSize = 2048
            analyser.smoothingTimeConstant = 0
            Reflect.apply(connect, analyser, [destination, 0, input])
            destinations.set(destination, analyser)
            window.debatemeetAudioOutputs.push(analyser)
          }
          Reflect.apply(connect, this, [analyser, output, 0])
        } else {
          Reflect.apply(
            connect,
            this,
            destination instanceof AudioNode ? [destination, output, input] : [destination, output],
          )
        }
        return destination instanceof AudioNode ? destination : undefined
      },
    })
    Object.defineProperty(AudioNode.prototype, 'disconnect', {
      value: function (this: AudioNode, ...args: unknown[]): void {
        const destination = args[0]
        if (destination instanceof AudioDestinationNode) {
          const analyser = destinations.get(destination)
          if (analyser !== undefined) args[0] = analyser
        }
        Reflect.apply(disconnect, this, args)
      },
    })
    window.debatemeetReadBands = (bands, contexts) =>
      bands.map((frequency) => {
        let peak = 0
        for (const analyser of window.debatemeetAudioOutputs) {
          if (analyser.context.state !== 'running') continue
          if (contexts !== undefined && !contexts.includes(analyser.context)) continue
          const bins = new Float32Array(analyser.frequencyBinCount)
          analyser.getFloatFrequencyData(bins)
          const center = Math.round((frequency * analyser.fftSize) / analyser.context.sampleRate)
          for (
            let index = Math.max(0, center - 2);
            index <= Math.min(bins.length - 1, center + 2);
            index += 1
          ) {
            peak = Math.max(peak, 10 ** ((bins[index] ?? -Infinity) / 20))
          }
        }
        return peak
      })
  })
  if (toneHz !== undefined) {
    // Replace only microphone input. Signaling, encoding, SFU delivery and speaker output stay real.
    await page.addInitScript((frequency) => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints)
        if (constraints?.audio) {
          for (const track of stream.getAudioTracks()) {
            stream.removeTrack(track)
            track.stop()
          }
          const context = new AudioContext()
          const oscillator = context.createOscillator()
          oscillator.frequency.value = frequency
          const gain = context.createGain()
          gain.gain.value = 0.2
          const destination = context.createMediaStreamDestination()
          oscillator.connect(gain).connect(destination)
          oscillator.start()
          await context.resume()
          const track = destination.stream.getAudioTracks()[0]
          if (track === undefined) throw new Error('Tone source did not produce a track')
          const stop = track.stop.bind(track)
          track.stop = () => {
            stop()
            oscillator.stop()
            void context.close()
          }
          stream.addTrack(track)
        }
        return stream
      }
    }, toneHz)
  }
}

export async function outputBands(page: Page, frequencies: number[]): Promise<number[]> {
  return page.evaluate((bands) => window.debatemeetReadBands(bands), frequencies)
}

export async function startOutputRecording(page: Page, frequencies: number[]): Promise<void> {
  await page.evaluate((bands) => {
    window.debatemeetAudioFrames = []
    window.debatemeetAudioRecording = window.setInterval(() => {
      window.debatemeetAudioFrames.push({
        at: performance.now(),
        room: document.querySelector('h1')?.textContent ?? '',
        bands: window.debatemeetReadBands(bands),
      })
    }, 20)
  }, frequencies)
}

export async function stopOutputRecording(page: Page): Promise<AudioFrame[]> {
  return page.evaluate(() => {
    window.clearInterval(window.debatemeetAudioRecording)
    return window.debatemeetAudioFrames
  })
}

export async function recordedRoomSamples(page: Page, room: string): Promise<number> {
  return page.evaluate((expected) => {
    const frames = window.debatemeetAudioFrames
    const last = frames.at(-1)
    if (last?.room !== expected) return 0
    const change = frames.findLastIndex((frame) => frame.room !== expected)
    const since = frames[change + 1]?.at ?? Infinity
    return frames.slice(change + 1).filter((frame) => frame.at - since >= 100).length
  }, room)
}

export async function outputLevel(page: Page): Promise<number> {
  return page.evaluate(() => {
    let peak = 0
    for (const analyser of window.debatemeetAudioOutputs) {
      if (analyser.context.state !== 'running') continue
      const samples = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(samples)
      const energy = samples.reduce((sum, sample) => sum + sample * sample, 0)
      peak = Math.max(peak, Math.sqrt(energy / samples.length))
    }
    return peak
  })
}
