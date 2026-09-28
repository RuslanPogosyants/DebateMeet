import { Page } from '@/ui/components/page'
import { strings } from '@/ui/strings'

// Shown while the first route of the session loads its lazy chunk.
export function LoadingPage() {
  return (
    <Page>
      <p role="status" className="text-muted-foreground">
        {strings.loading}
      </p>
    </Page>
  )
}
