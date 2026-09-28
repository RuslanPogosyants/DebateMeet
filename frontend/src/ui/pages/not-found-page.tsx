import { Link } from 'react-router'
import { Page } from '@/ui/components/page'
import { strings } from '@/ui/strings'

export function NotFoundPage() {
  return (
    <Page>
      <h1 className="text-3xl font-semibold">{strings.notFound.title}</h1>
      <Link to="/" className="underline underline-offset-4">
        {strings.notFound.backToStart}
      </Link>
    </Page>
  )
}
