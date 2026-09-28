import { Link } from 'react-router'
import { Page, PageTitle } from '@/ui/components/page'
import { strings } from '@/ui/strings'

export function NotFoundPage() {
  return (
    <Page>
      <PageTitle>{strings.notFound.title}</PageTitle>
      <Link to="/" className="self-start font-medium underline underline-offset-3">
        {strings.notFound.backToStart}
      </Link>
    </Page>
  )
}
