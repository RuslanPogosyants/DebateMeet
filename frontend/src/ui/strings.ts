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
    rooms: 'Комнаты',
    whoWhere: 'Кто где',
    closePanel: 'Закрыть',
    closeRooms: 'Закрыть комнаты',
    closeJudge: 'Закрыть судейскую панель',
    emptyRoom: 'пусто',
    currentRoom: 'Ваша комната',
    enter: 'Перейти',
    backToBase: '← В базу',
    noConnection: 'нет связи',
    noJudge: 'Судьи нет',
    judge: 'Судья',
    becomeJudge: 'Стать судьёй',
    reclaimJudge: 'Взять флаг снова',
    youJudge: 'Вы судья',
    releaseJudge: 'Отказаться от флага',
    handOver: 'Передать флаг…',
    handOverConfirm: 'Передать флаг',
    handOverTo: 'Кому передать флаг',
    chooseParticipant: 'Выберите участника',
    claimTitle: 'Стать судьёй?',
    claimDescription: 'Вы сможете возвращать комнаты в базу и передавать флаг другому участнику.',
    recallAll: 'Всех в базу',
    recall: 'Вернуть в базу',
    recallTitle: 'Вернуть участников в базу?',
    recallNoUndo: 'Отмены этого действия нет. Микрофоны останутся в прежнем состоянии.',
    cancelAction: 'Отмена',
    returned: 'Вас вернули в базу.',
    dismiss: 'Закрыть уведомление',
    stillHere: 'Вы ещё здесь?',
    stillHereDescription: 'Вы одни в раунде. Без ответа через две минуты ваша сессия закроется.',
    stillHereAnswer: 'Да, я здесь',
    uncertain: 'Ответ на команду не получен. Она могла выполниться; повтор проверит тот же запрос.',
    retryCommand: 'Повторить команду',
    judgeLeave: 'Выйти из раунда?',
    judgeLeaveDescription: 'Флаг судьи освободится. Можно сначала передать его другому участнику.',
    handOverAndLeave: 'Передать флаг и выйти',
    takeoverTitle: 'Перенести сюда?',
    takeoverDescription: 'Раунд уже открыт в другой вкладке. После переноса та сессия завершится.',
    takeover: 'Перенести',
    keepPreviousTab: 'Остаться в прежней вкладке',
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
  session_replaced: 'Сессия перенесена в другую вкладку.',
  judge_flag_taken: 'Флаг уже взял другой участник.',
  not_judge: 'Эта команда доступна держателю флага судьи.',
  not_connected: 'Дождитесь подключения участника к звонку.',
  entry_in_progress: 'Другая вкладка ещё подключается. Дождитесь подключения и повторите перенос.',
  credentials_unavailable:
    'Не удалось подтвердить прежнюю сессию. Она продолжает работать в другой вкладке. Вернитесь туда или обновите эту страницу после сохранения данных входа.',
  coordination_unavailable:
    'Браузер не поддерживает безопасный перенос сессии. Используйте актуальный браузер.',
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

export const roomNames = {
  base: 'База',
  og: 'OG',
  oo: 'OO',
  cg: 'CG',
  co: 'CO',
  judges: 'Судейская',
} as const
export const roomDescriptions = {
  base: 'Общий зал',
  og: 'Первое правительство',
  oo: 'Первая оппозиция',
  cg: 'Второе правительство',
  co: 'Вторая оппозиция',
  judges: 'Обсуждение судей',
} as const
export function recallSummary(count: number, rooms: number, includesSelf: boolean): string {
  return `Участников: ${count}, комнат: ${rooms}${includesSelf ? ', включая вас' : ''}.`
}
export function flagReleased(name: string): string {
  return `Флаг свободен: ${name} отключился`
}
export function enterRoom(name: string): string {
  return `Перейти в ${name}`
}
export function recallRoom(name: string): string {
  return `Вернуть ${name} в базу`
}

export function roomChangeText(
  from: keyof typeof roomNames,
  to: keyof typeof roomNames,
  names: string[],
): string {
  const destination = to === 'base' ? 'базе' : to === 'judges' ? 'судейской' : roomNames[to]
  return names.length === 1
    ? `${names[0]} теперь в ${destination}.`
    : `${roomNames[from]}: ${names.length} участников теперь в ${destination}.`
}
