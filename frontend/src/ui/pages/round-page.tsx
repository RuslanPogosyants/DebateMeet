import { useParams } from 'react-router'
import { Page, PageTitle } from '@/ui/components/page'
import { strings } from '@/ui/strings'

// Loaded lazily by the router: livekit-client will live in this chunk, not in the initial one.
export function RoundPage() {
  const { roundId } = useParams()
  return (
    <Page>
      <PageTitle>{strings.round.title}</PageTitle>
      <p className="text-muted-foreground">{roundId}</p>
    </Page>
  )
}
