import { Page } from '@/ui/components/page'
import { strings } from '@/ui/strings'

export function StartPage() {
  return (
    <Page>
      <h1 className="text-3xl font-semibold">{strings.appName}</h1>
      <p className="text-muted-foreground">{strings.start.tagline}</p>
    </Page>
  )
}
