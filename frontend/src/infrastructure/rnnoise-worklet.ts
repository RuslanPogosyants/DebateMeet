import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
// Vite's ?url import returns the emitted asset URL.
// oxlint-disable-next-line import/default
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'

export { RnnoiseWorkletNode }
export async function prepare(context: AudioContext, signal: AbortSignal): Promise<ArrayBuffer> {
  if (context.sampleRate !== 48000 || context.state !== 'running' || !context.audioWorklet)
    throw new DOMException('Noise suppression unavailable', 'NotSupportedError')
  const [response] = await Promise.all([
    fetch(wasmUrl, { signal }),
    context.audioWorklet.addModule(workletUrl),
  ])
  if (!response.ok) throw new Error('Noise suppression model is unavailable')
  return response.arrayBuffer()
}
