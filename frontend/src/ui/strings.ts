// Every user-facing string of the interface. The interface is Russian only, so there is
// no i18n framework (docs/architecture.md §7); domain error codes are translated here too.
export const strings = {
  appName: 'DebateMeet',
  loading: 'Загрузка…',
  start: {
    tagline: 'Раунды британского парламентского формата по одной ссылке',
  },
  round: {
    title: 'Раунд',
  },
  notFound: {
    title: 'Страница не найдена',
    backToStart: 'На стартовую',
  },
} as const
