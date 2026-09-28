import { useParams } from 'react-router'
import { Page } from '@/ui/components/page'
import { strings } from '@/ui/strings'

// Loaded lazily by the router: livekit-client will live in this chunk, not in the initial one.
export function RoundPage() {
  const { roundId } = useParams()
  return (
    <Page>
      <h1 className="text-3xl font-semibold">{strings.round.title}</h1>
      <p className="font-mono text-muted-foreground">{roundId}</p>
    </Page>
  )
}
