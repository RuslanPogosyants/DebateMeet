// Every user-facing string of the interface. The interface is Russian only, so there is
// no i18n framework (docs/architecture.md §7); domain error codes are translated here too.
export const strings = {
  appName: 'DebateMeet',
  loading: 'Загрузка…',
  start: {
    tagline: 'Раунды британского парламентского формата по одной ссылке',
    title: 'Раунд БПФ по одной ссылке',
    description:
      'Общая база, комнаты подготовки и судейская. Соберитесь по одной ссылке и начните разговор.',
    create: 'Создать раунд',
    creating: 'Создаём раунд…',
    access: 'Войти может любой, у кого есть ссылка.',
    recent: 'Недавние раунды',
    empty: 'Здесь появятся раунды, в которые вы входили в этом браузере.',
    noMotion: 'Без резолюции',
    open: 'Открыть',
  },
  round: {
    title: 'Вход в раунд',
    base: 'База',
    hearing: 'Слышно только вашу комнату',
    prejoin: 'Вы войдёте в базу',
    name: 'Ваше имя',
    join: 'Войти',
    joining: 'Подключаемся к раунду…',
    cancel: 'Отменить',
    copy: 'Скопировать ссылку',
    copied: 'Ссылка скопирована',
    copyFailed: 'Не удалось скопировать ссылку. Скопируйте адрес из строки браузера.',
    microphoneOff: 'Микрофон выключен',
    microphoneOn: 'Микрофон включён',
    cameraOff: 'Камера выключена',
    cameraOn: 'Камера включена',
    cameraPreview: 'Предпросмотр камеры',
    cameraAbsent: 'Без камеры тоже можно войти',
    microphoneMuted: 'При входе микрофон выключен — вы сможете включить его в раунде.',
    camera: 'Камера',
    microphone: 'Микрофон',
    devices: 'Звук и устройства',
    defaultDevice: 'По умолчанию',
    sound: 'Проверить звук',
    retry: 'Повторить',
    server: 'Сервер',
    checking: 'Проверяем…',
    ready: 'Готово',
    serverReady: 'Сервер доступен',
    serverUnavailable: 'Сервер не отвечает. Повторите проверку.',
    leave: 'Выйти',
    you: 'вы',
    noCamera: 'Камера выключена',
    alone: 'Пока вы здесь одни. Отправьте ссылку другим участникам.',
    people: 'Участники',
    playback: 'Браузер приостановил звук.',
    enableAudio: 'Включить звук',
    reconnecting: 'Восстанавливаем соединение…',
    unavailable: 'Управление недоступно, звонок идёт. Проверяем связь с сервером.',
    return: 'Вернуться',
    home: 'На стартовую',
    unsupported: 'Браузер не поддерживается',
    browsers: 'Подойдут актуальные Chrome, Edge, Яндекс Браузер, Firefox или Safari 17 и новее.',
    anyway: 'Открыть всё равно',
    morePeople: 'Ещё участников без видео',
  },
  notFound: {
    title: 'Страница не найдена',
    backToStart: 'На стартовую',
  },
} as const

const errors: Record<string, string> = {
  invalid_name: 'Введите имя: от 1 до 40 символов, без управляющих знаков.',
  invalid_request: 'Проверьте имя и повторите вход.',
  round_full: 'В раунде 30 человек. Попробуйте войти позже.',
  entry_closed: 'Вход закрыт. Бывавшие в раунде могут войти из того же браузера.',
  not_found: 'Такого раунда нет. Проверьте ссылку.',
  participant_removed: 'Вас убрали из раунда.',
  unauthorized: 'Не удалось подтвердить ваш вход. Откройте раунд в прежнем браузере.',
  too_many_requests: 'Слишком много запросов. Подождите и повторите.',
  rate_limited: 'Слишком много входов. Подождите и повторите.',
  updating: 'Площадка обновляется. Повторим вход через 20 секунд.',
  round_busy: 'Раунд занят. Повторите через несколько секунд.',
  round_unreadable: 'Состояние раунда временно недоступно. Попробуйте позже.',
  media_unavailable:
    'Не удалось подключить звонок. Проверьте сеть и повторите. На мобильном интернете попробуйте Wi-Fi.',
  network: 'Не удалось связаться с сервером. Проверьте сеть и повторите.',
  invalid_response: 'Получен неполный ответ сервера. Обновите страницу и повторите.',
}

export function errorText(code: string | null): string {
  return (code === null ? undefined : errors[code]) ?? errors.network ?? ''
}

export function deviceErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Разрешите доступ к устройству в настройках браузера.'
  if (name === 'NotReadableError' || name === 'AbortError')
    return 'Устройство занято. Закройте другой звонок и повторите.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Устройство не найдено. Выберите другое.'
  return 'Устройство недоступно. Проверьте подключение и разрешения браузера.'
}

export const endedText = {
  replaced: 'Сессия перенесена в другую вкладку.',
  left: 'Вы вышли из раунда.',
  removed: 'Вас убрали из раунда.',
  deleted: 'Раунд удалён.',
  network: 'Соединение прервалось. Подключитесь снова.',
} as const
