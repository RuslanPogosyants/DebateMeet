import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ClientError } from '@/application/ports'
import { useServices } from '@/ui/services'
import { errorText, strings } from '@/ui/strings'
import { LocalRecordingsButton } from '@/ui/components/recordings'

export function StartPage() {
  const services = useServices()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recent = services.preferences.recent()

  async function create() {
    setCreating(true)
    setError(null)
    try {
      await navigate(`/r/${await services.api.create()}`)
    } catch (failure) {
      setError(failure instanceof ClientError ? failure.code : 'network')
      setCreating(false)
    }
  }

  return (
    <main className="start-shell">
      <header className="brand">
        {strings.appName}
        <span className="brand-dash" aria-hidden="true">
          —
        </span>
      </header>
      <div className="start-layout">
        <section className="start-intro">
          <h1 className="font-display text-display font-bold tracking-display">
            {strings.start.title}
          </h1>
          <p className="start-description">{strings.start.description}</p>
          <button
            className="action-primary"
            type="button"
            disabled={creating}
            onClick={() => {
              void create()
            }}
          >
            {creating ? strings.start.creating : strings.start.create}
          </button>
          <p className="text-caption text-muted-foreground">{strings.start.access}</p>
          <LocalRecordingsButton />
          {error !== null && <p role="alert">{errorText(error)}</p>}
        </section>
        <section className="recent-rounds" aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="text-title font-medium">
            {strings.start.recent}
          </h2>
          {recent.length === 0 ? (
            <p className="text-muted-foreground">{strings.start.empty}</p>
          ) : (
            <ul>
              {recent.map((round) => (
                <li key={round.id}>
                  <div>
                    <p>{strings.start.noMotion}</p>
                    <time
                      className="text-caption text-muted-foreground"
                      dateTime={new Date(round.visitedAt).toISOString()}
                    >
                      {new Date(round.visitedAt).toLocaleDateString('ru-RU', {
                        day: 'numeric',
                        month: 'long',
                      })}
                    </time>
                  </div>
                  <Link className="text-link" to={`/r/${round.id}`}>
                    {strings.start.open}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}
