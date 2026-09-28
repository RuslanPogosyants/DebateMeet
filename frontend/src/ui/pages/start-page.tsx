import { Page, PageTitle } from '@/ui/components/page'
import { strings } from '@/ui/strings'

export function StartPage() {
  return (
    <Page>
      <PageTitle>{strings.appName}</PageTitle>
      <p className="text-muted-foreground">{strings.start.tagline}</p>
    </Page>
  )
}
