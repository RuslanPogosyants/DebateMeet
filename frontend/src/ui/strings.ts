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
    noConnection: 'нет связи',
    noJudge: 'Судьи нет',
    flagAvailable: 'Флаг свободен',
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
    claimDescription:
      'Вы сможете управлять таймерами, возвращать комнаты в базу и передавать флаг другому участнику.',
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
  timers: {
    heading: 'Время раунда',
    controls: 'Управление таймерами',
    roundTitle: 'Раунд — DebateMeet',
    prep: 'Подготовка',
    speech: 'Речь',
    speechTimer: 'Таймер речи',
    prepTimer: 'Таймер подготовки',
    running: 'идёт',
    paused: 'пауза',
    stopped: 'не запущен',
    of: 'из',
    remaining: 'осталось',
    prepOvertime: 'время подготовки вышло',
    protected: 'POI нельзя',
    poi: 'POI можно',
    grace: 'грейс — ещё',
    overtime: 'сверх времени',
    approximate: 'Время приблизительное',
    degraded: 'Не удалось уточнить время; используем последнюю поправку',
    syncing: 'Уточняем время…',
    resync: 'Уточнить время',
    start: 'Старт',
    pause: 'Пауза',
    reset: 'Сбросить',
    set: 'Выставить время',
    configure: 'Длительность',
    next: 'Следующая речь',
    configureConfirm: 'Изменить и сбросить',
    configureWarning: 'Таймер будет сброшен и остановлен.',
    resetWarning:
      'Текущее время будет потеряно. Таймер вернётся к своей длительности и остановится.',
    setConfirm: 'Выставить',
    durationInput: 'Длительность, мм:сс',
    elapsedInput: 'Прошедшее время, мм:сс',
    remainingInput: 'Остаток, мм:сс',
    signedHint: 'Формат — минуты:секунды, например 7:12 или −0:15. Знак минус допустим.',
    prepBounds: 'От 1:00 до 30:00. По умолчанию — 15:00.',
    speechBounds: 'От 1:00 до 15:00. По умолчанию — 7:00; грейс — всегда 0:15.',
  },
  notFound: {
    title: 'Страница не найдена',
    backToStart: 'На стартовую',
  },
} as const

const errors: Record<string, string> = {
  invalid_motion: 'Проверьте длину и символы резолюции и инфослайда.',
  invalid_drum: 'Проверьте настройки жребия.',
  invalid_message: 'Введите от 1 до 1000 символов без управляющих символов.',
  drum_empty: 'Барабан пуст — сбросьте его или измените настройки.',
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
  invalid_timer_value: 'Время вне допустимого диапазона. Проверьте значение.',
  speech_undo_unavailable: 'Отменять пока нечего: следующая речь ещё не начиналась.',
  command_unavailable: 'Эта команда временно недоступна. Звонок продолжается.',
  participant_not_found: 'Участник уже вышел из раунда.',
  invalid_reaction: 'Эта реакция недоступна.',
}

export const socialStrings = {
  hand: 'Рука',
  raise: 'Поднять руку',
  lower: 'Опустить руку',
  raiseShort: 'Поднять',
  lowerShort: 'Опустить',
  queue: 'Очередь рук',
  queueEmpty: 'Поднятых рук пока нет',
  lowerAll: 'Опустить все руки',
  hands: 'Руки и микрофоны',
  reactions: 'Реакции',
  receivedReactions: 'Реакции участников',
  hideReactions: 'Скрыть реакции',
  more: 'Ещё',
  requestUnmute: 'Судья просит включить микрофон',
  enableMicrophone: 'Включить микрофон',
  microphoneMuted: 'Судья выключил микрофон',
} as const

export function handPosition(position: number): string {
  return `Рука — ${position}`
}
export function participantActions(name: string): string {
  return `Действия — ${name}`
}
export function lowerHandOf(name: string): string {
  return `Опустить руку — ${name}`
}
export function microphoneAction(name: string, enabled: boolean): string {
  return `${enabled ? 'Выключить микрофон' : 'Попросить включить микрофон'} — ${name}`
}
export function participantVolume(name: string): string {
  return `Громкость — ${name}`
}
export function reactionLabel(emoji: string): string {
  return `Реакция — ${emoji}`
}

export const contentStrings = {
  motion: 'Резолюция',
  motionEmpty: 'Резолюция не задана',
  infoslide: 'Инфослайд',
  editMotion: 'Изменить резолюцию',
  fullMotion: 'Полностью',
  save: 'Сохранить',
  motionChanged: 'Резолюция изменена',
  invalidMotion: 'Проверьте длину текста и допустимые символы.',
  drum: 'Жребий',
  draw: 'Тянуть',
  configure: 'Настроить жребий',
  reset: 'Сбросить барабан',
  drumMenu: 'Меню жребия',
  removeDrawn: 'Убирать выпавшее',
  inDrum: 'в барабане',
  drawn: 'выпала',
  disabled: 'выкл.',
  noDraw: 'Позиции ещё не тянули',
  allDisabled: 'Все позиции выключены. Включите нужные в настройках.',
  drumEmpty: 'Барабан пуст — сбросьте его.',
  enabledPositions: 'Включённые позиции',
  resetDescription: 'Выпавшие позиции и последний результат будут очищены.',
  returning: 'Вернутся в барабан',
  none: 'нет',
  chat: 'Общий чат',
  collapseChat: 'Свернуть чат',
  message: 'Сообщение в общий чат',
  send: 'Отправить',
  retrySend: 'Повторить отправку',
  earlier: 'Более ранние',
  loading: 'Загружаем сообщения…',
  loadingEarlier: 'Загружаем историю…',
  chatEmpty: 'Сообщений пока нет',
  generalNotice: 'видят все, включая другие команды',
  uncertainSend: 'Исход отправки неизвестен. Повтор сохранит то же сообщение.',
  newMessages: 'Новых сообщений',
  retryHistory: 'Повторить загрузку',
  characters: 'символов',
} as const

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

export function timerHeading(kind: 'prep' | 'speech', speechNo: number): string {
  return kind === 'prep' ? strings.timers.prep : `${strings.timers.speech} ${speechNo}`
}

export function timerAction(
  action: 'start' | 'pause' | 'reset' | 'resetConfirm' | 'set' | 'configure',
  kind: 'prep' | 'speech',
): string {
  const name = kind === 'prep' ? 'подготовки' : 'речи'
  if (action === 'start') return kind === 'prep' ? 'Запустить подготовку' : 'Запустить речь'
  if (action === 'pause') return `Пауза ${name}`
  if (action === 'reset') return kind === 'prep' ? 'Сбросить подготовку' : 'Сбросить речь'
  if (action === 'resetConfirm') return `Сбросить таймер ${name}?`
  return action === 'set' ? `Выставить время ${name}` : `Изменить длительность ${name}`
}

export function undoSpeechLabel(speechNo: number, time: string): string {
  return `Отменить: речь ${speechNo}, ${time}`
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
export const personalMediaStrings = {
  startScreen: 'Демонстрировать экран',
  stopScreen: 'Остановить демонстрацию',
  cancelScreen: 'Отменить демонстрацию',
  screenUnavailable: 'В этом браузере демонстрация экрана недоступна',
} as const

export const resilienceStrings = {
  quality: 'Связь',
  qualityShortNames: {
    excellent: 'Отлично',
    good: 'Хорошо',
    poor: 'Плохо',
    lost: 'Нет связи',
    unknown: 'Нет данных',
  },
  qualityNames: {
    excellent: 'Отличная связь',
    good: 'Хорошая связь',
    poor: 'Плохая связь',
    lost: 'Связь потеряна',
    unknown: 'Качество связи неизвестно',
  },
  cameraSuggestion: 'Связь нестабильна. Можно выключить камеру, чтобы сохранить звук.',
  turnCameraOff: 'Выключить камеру',
  turnMicrophoneOff: 'Выключить микрофон',
  cancelCameraEnable: 'Отменить включение камеры',
  cancelCameraDisable: 'Отменить выключение камеры',
  cancelMicrophoneEnable: 'Отменить включение микрофона',
  cancelMicrophoneDisable: 'Отменить выключение микрофона',
  settings: 'Настройки',
  diagnostics: 'Диагностика',
  diagnosticsHint:
    'Технические данные без имён, ссылки и содержимого раунда. Открыть с клавиатуры: Ctrl + Shift + D.',
  debugData: 'Технические данные соединения',
  report: 'Сообщить о проблеме',
  reportDescription:
    'Сохраните технический отчёт на этом сервере и передайте его номер автору площадки. Имена, чат, резолюция и ссылка в отчёт не входят.',
  saveReport: 'Сохранить отчёт',
  reporting: 'Сохраняем отчёт…',
  reportSaved: 'Отчёт сохранён. Номер:',
  reportFailed: 'Не удалось сохранить отчёт. Звонок продолжается; можно повторить позже.',
  copyReport: 'Скопировать номер отчёта',
  reportCopyFailed: 'Не удалось скопировать номер. Его можно выделить и скопировать вручную.',
  versionChanged: 'Версия приложения изменилась. Обновите страницу между раундами.',
  preloadFailed: 'Не удалось загрузить часть приложения. Обновите страницу между раундами.',
  reload: 'Обновить страницу',
  layout: 'Раскладка',
  speaker: 'Крупный спикер',
  grid: 'Сетка',
  showSelf: 'Показывать себя',
  pin: 'Закрепить',
  unpin: 'Открепить',
  pinned: 'Закреплён',
  microphone: 'Микрофон',
  camera: 'Камера',
  output: 'Динамики',
  defaultDevice: 'По умолчанию',
  refreshDevices: 'Обновить список устройств',
  devicesPending: 'Меняем устройство…',
  renderFailed: 'Не удалось отобразить экран раунда.',
  judgeFailureLeave: 'Флаг судьи освободится.',
  renderFailedHint:
    'Звонок может продолжаться. Попробуйте восстановить экран; состояние раунда сохранено.',
  restoreView: 'Восстановить экран',
} as const
