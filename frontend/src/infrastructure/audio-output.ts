type OutputContext = AudioContext & {
  readonly sinkId: string
  setSinkId(id: string): Promise<void>
}

function readOutput(context: OutputContext, id: string): string {
  if (context.state === 'closed' || context.sinkId !== id)
    throw new DOMException('Output did not change', 'AbortError')
  return context.sinkId
}

export function supportsContextOutput(context: AudioContext): context is OutputContext {
  return (
    'setSinkId' in context &&
    typeof context.setSinkId === 'function' &&
    'sinkId' in context &&
    typeof context.sinkId === 'string'
  )
}

export async function routeOutput(context: AudioContext, id: string): Promise<string> {
  if (context.state === 'closed') throw new DOMException('Output context closed', 'AbortError')
  if (!supportsContextOutput(context)) {
    if (id === '') return ''
    throw new DOMException('Output selection unavailable', 'NotSupportedError')
  }
  await context.setSinkId(id)
  return readOutput(context, id)
}
