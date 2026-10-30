# Срез 6 — устойчивость и оставшийся MVP

Утверждённый план v2. Независимые проверки корректности, инженерии, тестируемости и безопасности завершены; выбранный объём разрешён к реализации. Исходная база — B5 `5f0c4dc48861661c6ccdf6f0daed39fd92327224`, ветка `codex/slice-6-resilience`. Продуктовые решения spec/architecture/design сохраняются. Повторное согласование того же объёма не требуется.

## Текущий статус реализации

Код A6 подготовлен в рабочем дереве. Пройдены 834 backend-теста без пропусков, 402 frontend-теста, полный `just lint`, три сборки образов и бюджет начального JavaScript. Общий прогон 18 E2E и engineering review пройдены. Дополнительные fresh-SID/retry и production-composition регрессии также пройдены после полного прогона; test-review delta закрыта. A6 принята локально; её коммит станет границей отката для B6. CLI удаления раунда, клиентская диагностика, устройства, сцена и `SECURITY.md` относятся к B6 и ещё не реализованы.

В реализации совместимое расширение схемы разделено на `0006` (диагностика) и `0007` (tombstone и `delete_room`). Это техническое разбиение пакета A6; порядок потребителей до B6, инварианты и wire-контракт сохранены. Точные доказательства и следующие действия — в [разделе 11 архитектуры](architecture.md#текущий-статус-реализации). Разделы ниже описывают утверждённый план всего среза, а не уже готовую B6.

## Ожидаемый результат и граница

Участник видит качество связи и может вручную выключить камеру, сменить доступные устройства, выбрать крупного спикера/сетку/закрепление и скрыть себя. Техническая панель и сохранённый отчёт помогают разобрать сбой без вывоза данных. Старой вкладке предлагается обновление между раундами. Администратор может терминально удалить раунд и его пользовательские данные; медиакомната `MediaRoom` закрывается с надёжным повтором. Реальные серверы, реестр образов, бэкапы, операционные алерты и WAN — срез С после 6. Физическое эхо явно отложено автором, громкость остаётся ≤100%.

## Что существует на исходной базе и переиспользуется

- `RoundController`, `SubscriptionManager`, `MediaSession`, `SessionOwnership`, `ClockSync`/`TimerSession` и `AloneWatchdog` уже управляют жизненным циклом, поколениями, повтором неизвестной команды с тем же UUID, переносом, комнатами и таймерами. Не создаём вторую управляющую медиасессию.
- `livekit-client` 2.22.3: публичные `Track.getRTCStatsReport()`, `RoomEvent.ConnectionQualityChanged`, `switchActiveDevice`/`getActiveDevice`, `getLocalDevices(kind, false)`. `ReceiverStats` не копирует `packetsLost`/`packetsReceived`, поэтому потери читаются из исходного `RTCStatsReport` по разрешённому списку полей.
- SQLAlchemy Core и явные транзакции, архив с `find_shared`, ограничение частоты команд, Pydantic на границе API, существующие DTO и генерация OpenAPI/TS; shared не импортирует Round. Домен и JSON-схема Round версии 1 для диагностики не меняются.
- `AdministerRound`, блокировка записи чата перед блокировкой строки Round, надёжный `media_outbox` с revision/lease и независимыми очередями SDK. На исходной базе `Gateway.open_media_room` может завершить `CreateRoom` после удаления `rounds` и оставить `MediaRoom` без строки `media_rooms`: эту гонку обязательно закрыть, одного DELETE недостаточно.
- На исходной базе backend `appVersion` уже есть в snapshot/metadata, но frontend `APP_VERSION` доступен только в OCI label scratch-stage. Требуется настоящий `VITE_APP_VERSION` на этапе сборки.

## Пакеты и совместимость

**A6 — совместимые потребители до новых команд:** additive-миграции `0006` (diagnostics) и `0007` (`deleted_rounds` и новая форма `delete_room` в outbox), потребитель закрытия и сверка tombstones, защита позднего `CreateRoom`, API приёма диагностики/metrics и строгие контракты. Старые команды/клиент продолжают работать, новых Round полей нет. До B6 A6 отдельным коммитом принимается и становится единственной заявленной границей отката.

**B6 — команды и пользовательский результат:** административное удаление, клиентская диагностика, качество и версия, устройства и сцена, доступность и SECURITY. Actual B6 → исходники A6 → B6 проверяет сохранение tombstones/cleanup/diagnostics и обычные старые команды; source/SHA manifest, настоящий PG и отдельный процесс. Не заявляем откат B6 → B5: B5 не знает delete_room.

## Удаление раунда

- CLI `just admin delete-round ROUND_ID`; существующая структура команд, явный актор `admin`. Повтор отсутствующего раунда с tombstone — успех уже выполненного удаления; неизвестный id — not_found. Административного HTTP endpoint и новых ролей нет.
- В одной транзакции: chat writer guard → raw SELECT version FOR NO KEY UPDATE (без декодирования JSON, чтобы можно было удалить нечитаемый документ или неизвестную схему) → insert immutable deleted_rounds tombstone → append RoundDeleted(version+1, actor admin, только ids) → удалить messages/participants/command_keys/связанные диагностику и round row; отметить прежние pending эффекты этого раунда obsolete → enqueue delete_room и NOTIFY. Event log сохраняется. Подтверждение удаления хранится в tombstone, а не в удаляемых `command_keys`. Любой отказ откатывает всё.
- Закрытие комнаты не имеет FK на Round; используются `revision` и уникальный ключ round/operation. SDK `DeleteRoom` вызывается после коммита, `NotFound` считается успехом.

  Существующая ограниченная очередь удаления получает union `RemoveParticipantEffect | DeleteRoomEffect`, справедливую ротацию и timeout; MediaStore.next_removal(now, after_round) выбирает один готовый эффект после курсора раунда: due/operation/pending filter, ORDER BY round_id,available_at,id LIMIT1 и один запрос с переходом к началу. Курсор меняется при выборе/запуске раунда.

  Прежнего глобального массива oldest100 нет: 100 ранних эффектов не скрывают новое удаление. Удаления разных адресатов не образуют FIFO; ожидающий повтора эффект не блокирует другое готовое удаление той же комнаты; packet/control FIFO остаются heads-before-due; отмена и await до потери lease, ack/failure только совпавшей revision. Медленное удаление не блокирует снимки и остальные очереди.
- Tombstone постоянный. Создание Round проверяет отсутствие tombstone под тем же коротким per-round lifecycle/chat guard: случайное совпадение id не переиспользует удалённую ссылку.

  Транзакционная вставка через общий persistence lifecycle guard; raw acquisition прежнего namespace/key отделяется от существующего prepare_chat EXISTS-check (create вызывается до INSERT), prepare_chat сохраняет свою проверку; без импорта chat infrastructure в Round infrastructure: guard переносится в shared infrastructure с прежним namespace.

  Поздний webhook при missing round не оставляет новый command key (rollback claim с сохранением прежнего key → round порядка). PostgresCommandKeys.claim обязан переносить удаление conflict row между INSERT ON CONFLICT и SELECT: bounded retry без долгого key row lock, отсутствие ключа не вызывает scalar_one/500; последующий missing round откатывает новый claim.

  SELECT FOR UPDATE ключа до Round недопустим из-за инверсии delete Round→key. Gateway после завершения CreateRoom регистрирует started под raw FOR KEY SHARE существующего Round либо проверяет tombstone и rearm delete, устраняя FK гонку; webhook/startup/периодическая сверка LiveKit повторяют cleanup для удалённого id. Нельзя считать post-create проверку достаточной: crash между SDK и SQL оставляет orphan.

  Периодический обход tombstones ограниченными страницами, по 100 id, курсор/ротация через весь набор, один цикл каждые 30 с, SDK вне SQL-lock, неизвестные чужие имена не удаляются.
- Отсутствующий раунд терминален: join даёт 404, существующие authenticated чтения после удаления архива могут дать 401; HTTP не обещает 404 раньше verify. In-flight join может завершить SDK поздно и даже вернуть старый JWT; повторная HTTP-проверка отклоняется, tombstone закрывает позднюю комнату. Отсутствие любого позднего RPC гарантировать невозможно; проверяется итоговая очистка.

  Настоящая локальная проверка LK 1.13.7: и текущий JWT с room_config, и JWT без него после DeleteRoom получили room_not_found; ListRooms не обнаружил новой комнаты. auto_create:false работает для обоих. Token не меняем; поздний backend CreateRoom остаётся причиной постоянной отметки.
- Приёмы: оба управляемых порядка delete↔join, chat, draw, telemetry; удерживаемые locks наблюдаются; rollback после частичных SQL; unreadable round; crash до SDK/после SDK до ack; поздний CreateRoom после ack и перезапуск; >200 tombstones, orphan на последней странице, все страницы/wrap/cursor restart, отсутствие starvation от первых ids/медленного SDK.

  Срок очистки зависит от числа страниц/циклов, не является обещанием 30 с для любого id; barrier conflict INSERT→SELECT key с одновременным delete и отсутствие leaked receipt; late ack старой revision; не удаляем другую комнату; реальный LK DeleteRoom/RTC/старый JWT отдельно.

## Диагностика: контракт, хранение и границы доверия

- `POST /api/rounds/{id}/telemetry` и `/client-errors`: Bearer, no-store, 204 после durable commit, без Idempotency-Key. В теле schemaVersion1, batchId UUIDv4, clientSessionId UUIDv4, appVersion (dev/test или дата+12hex[-dirty]), samples≤24; у client-errors errors≤20 либо один report.

  ReportId — batchId, UI показывает его только после подтверждённого 204; readonly CLI diagnostics-summary ROUND_ID / diagnostic-report REPORT_ID читает сохранённые разрешённые поля. Сводка после игры строится по raw round_hash; глобальные daily totals не получают id labels. Потерянный ответ повторяет immutable body/тот же batchId, повтор не удваивает агрегаты; несовпавший payload того же id —422.
- Фактический streamed body≤64KiB до JSON parse независимо Content-Length;413, strict finite/bounded numbers, extra forbid, enum поля, никакого произвольного data object. Валидация не возвращает submitted input values. Request-level body cap применяется до Pydantic JSON parse, в том числе chunked без Content-Length; тест проверяет, что parser не вызван сверх лимита. Не более 30 пачек/мин на участника, in-memory sliding budget с bounded4096 keys и idle cleanup; отсутствие лимита не создаёт бизнесэффекта, отказ даёт 429.
- Round application/usecase проверяет participant secret/revocation через find_shared в той же транзакции, проверяет существующий round и пишет neutral diagnostics DTO через shared port. Порядок не берёт round lock после archive shared lock; admin deletion ждёт archive и затем очищает диагностику. Shared SQL хранит SHA256 round/participant/clientSession identifiers, server receivedAt, typed payload; секретов/id-ссылок там нет. Body media SID не нужен; client session — случайный tab session UUID, не право менять присутствие.
- Сырая телеметрия хранится 30 дней, подтверждение пачки и её хеш — столько же. Суточные агрегаты сервера за 28 дней рассчитываются атомарно только при первом приёме пачки; общий `diagnostics_daily` содержит finite enum metric/outcome/quality и fixed histogram buckets, без round/participant/session/version labels. Это **client-reported** статистика: она не служит основанием для бизнес-команд или автоматического мута. Удаление raw данных раунда не требует отнять обезличенные totals. Ежедневная очистка выполняется ограниченными SQL-пачками отдельным обслуживающим компонентом; её ошибки не срывают запуск медиа или HTTP.
- `GET /metrics` только на backend loopback, Caddy не проксирует этот путь (явный 404), без link/id/version/error text labels. Prometheus exposition — явно **window_28d gauge** families для cumulative bucket/count/sum и quality duration. Это скользящее окно, не TYPE histogram/counter: при expiry значения могут уменьшаться.

  Dashboard/rules используют instant histogram_quantile/ratios плюс coverage, без rate/increase/sum_over_time. Midnight expiry/дубликат/restart не удваивают totals; конфиги dashboard/rules как репозиторные файлы можно подготовить без реальной выкатки. 28-day SLO не заявляется пройденным на локальном прогоне.
- Разрешённые данные: качество excellent/good/poor/lost/unknown, RTT/jitter/loss/bitrate bounded nullable, ICE host/srflx/prflx/relay/unknown и UDP/TCP/TLS/unknown, quality limitation cpu/bandwidth/other/none/unknown, SLI metric enum+duration+outcome+uncertainty, ошибки fixed code/phase/class и максимум 10 **санитизированных** code frames `{asset: own hashed .js basename, line,column}`.

  Никаких Error.message/сырого stack, URL/origin/path/query, SDP/IP/candidate addresses, motion/chat/draft/name/credentials. Stack parser принимает только собственные same-origin /assets/*.js и удаляет пути; arbitrary frames с API отклоняются whitelist/regex. Report содержит те же DTO + максимум 100 безопасных event codes, epoch/version/clock state и счётчики dropped, без произвольного описания пользователя.

## Клиентский collector, SLI и ошибки

- Новый `DiagnosticsSession` в application изолирует очередь, состояние и отправку; сборщик статистики SDK в infrastructure остаётся внутри единственного `MediaSession`.

  Статистика раз 5 с, в активном коротком join/switch окне до 10 с — опрос раз 250 мс с resolutionMs250; один getStats flight, generation/timeout и cancellation-ignore при disconnect/reconnect, timeout getStats помечает unknown, но не освобождает слот до settlement исходного browser Promise (он не отменяемый); новый poll пропускается, не плодит pending calls. Один незавершённый API-запрос, timeout 5 с, отправка каждые 30 с.

  Очереди: 64 samples / 20 errors / 100 events; переполнение считает dropped и удаляет старейшее неотправленное, immutable pending batch не меняется. Backoff 30/60 с, после терминального 401/404 отправка останавливается; закрытая сессия не запускает новые отправки. Ошибка диагностики никогда не закрывает call и не блокирует commands/timers.
- Отсутствующая статистика означает unknown, не 0. Контр-delta только для той же track/SID/generation/RTCStats.id+SSRC и возрастающего timestamp; reset/negative/gap не превращается в loss 0. Quality time — только локальная сессия; интервал≤7.5 с, hidden/sleep/gap не экстраполируется как good; отдельные observed/unknown durations. Одновременные вкладки/удалённые плитки не умножают self-quality.
- Join/switch start — явное действие до HTTP; ожидание согласия на перенос завершает исходную попытку как cancelled, подтверждённый перенос начинает новую, человеческое ожидание не называется сетевым входом; first audio observation — положительная delta inbound totalAudioEnergy на желаемом remote audio при разрешённом playback, unmuted, личной громкости>0 и живом context.

  Для текущего wanted track/SID оба samples должны быть после start measurement, первый только baseline; action/room/epoch/session/gap всегда сбрасывает counter baseline. Это инструментальный `decoded_playback_proxy`, **не физическое слышание**. Каноническая цель first audio остаётся целью; proxy публикуется под собственным именем, не заменяет physical/WAN приёмку.

  Connected/subscribed/attached отдельно в debug; тишина/неподдерживаемые stats → not_observed, пустая комната → empty_connected, не duration 0 успешного audio. Native FFT отдельно проверяет корреляцию с реальным browser output. Смена комнаты/epoch/reconnect отменяет старое измерение, unknown enter не приписывается новой комнате.
- Snapshot delivery — только впервые принятая свежая epoch/version, после фактического store apply, committedAt с clock offset.

  Первый увиденный baseline без доказательства наблюдения во время commit не идёт в latency histogram; committedAt должен попадать в текущий пригодный observation window, reconnect/sleep gap не выдаётся за доставку вживую; Только успешная синхронизация текущего lifecycle, age≤60 с, !degraded и без gap допускает clock-derived latency. negative/unsynced/stale/degraded →unknown, uncertainty/age сохраняются.

  Старый synchronized:true после close/failed resync не считается пригодной новой оценкой. ClockSync не переписывать: текущая консервативная огибающая 5 замеров; исправить неточное target-description «половина лучшего RTT». Reconnect measured от события до нового связного media/session state, outcome отдельно от audio. Показатели имеют coverage/outcome, локальный fake input не доказывает WAN SLO.
- window error/unhandledrejection → sanitized fixed event; React boundary показывает восстановление и safe report, никакой raw error записи/рендера. До authenticated join ошибки только в local ring. `vite:preloadError` показывает обновление, не reload автоматически. Техническая панель readonly accessible button + CtrlShiftD, debug snapshots — псевдонимы P1/P2, никаких round link/participant credentials.
- Плохая/потерянная связь непрерывно 10 с, у держателя флага 4 с → предложение выключить камеру; good/unknown reset, камера меняется **только по click**, если уже выключена не предлагать. Не утверждаем что браузер распознал «белые списки»; условная рекомендация попробовать Wi-Fi при failed connection. Текст качества дополнительно к цвету.
- Build-time VITE_APP_VERSION задаётся в Docker builder до vite build из APP_VERSION, читается как service value. Любой валидный snapshot appVersion наблюдается **до freshness gate**, даже с прежней epoch/version. Сравнение equality известных versions, не лексикографическое newer; dev/unknown не объявляются релизом. Баннер «Версия приложения изменилась. Обновите страницу между раундами».

  REST ответам добавляется X-App-Version, HttpRoundApi наблюдает его и на 304; не ждать нового snapshot version. Во время звонка нет reload-кнопки; prejoin/left может обновить явно. Не теряем draft/pending UUID автообновлением.

## Устройства и сцена

- Сохраняем один MediaSession и SDK devicechange handling; не запускаем второй capture/fallback. Выбор устройств во время звонка в существующей панели звука использует публичный SDK и не требует разрешения при `list(false)`. SDK уже восстанавливает только unmuted track. Input switch не включает выключенные mic/cam. Serialized user intents/generation fences гарантируют, что поздний switch не обгонит более новое «выкл» или новую сессию; unplug показывает понятную ошибку и обновляет список, SDK recovery не выдаётся за наш новый захват.
- Выбор устройства вывода доступен только при поддерживаемом API и вне Safari.

  Room webAudioMix output и отдельные timer/test contexts должны идти в выбранный sink; Медиаадаптер владеет единственным контекстом, переданным в webAudioMix:{audioContext}; для public Room.switchActiveDevice(audiooutput) нужна узкая pinned pnpm patch livekit-client 2.22.3, добавляющая пропущенный await AudioContext.setSinkId в source и реально экспортируемом ESM dist (generator yield).

  Правка только src/Room.ts не исполняется Vite. Production/browser и тест используют ESM export; frontend/Dockerfile копирует patch файлы до pnpm install, lockfile фиксирует patch hash; patch должен проверяться against exact installed version и реальным импортом. Это также сохраняет SDK смену sink медиаэлементов для AEC workaround; прямое изменение только context недостаточно.

  Отдельная regression доказывает rejected sink promise и отсутствие unhandled rejection. Подтверждение через свойство .sinkId всех созданных контекстов/элементов, нормализованный default id. При частичном отказе не показывать успех/сохранять ложную настройку; сообщение и повтор владельцем. Без поддержки выбор скрыт, текущий звук остаётся.
- Спикер крупно по умолчанию, grid toggle и hide self — личные preferences с memory fallback. Приоритет pin только участнику своей комнаты, затем active speaker из уже wanted/subscribed видео, затем стабильный первый remote/self; новый active кандидат говорит непрерывно 800 мс, текущий крупный удерживается≥2 с, pin немедленно, gone/roomchange удаляет pin. Аудио всех участников комнаты не зависит от сцены/скрытия себя.

  Перестановка video elements через существующий attachVideo cleanup, никакого двойного attach. Прежний бюджет 12 видео; pin вне набора явно замещает один видеослот с отпиской прежнего до подписки нового. Обычная смена active speaker внутри набора не меняет subscriptions. Полные ручные учёт/перемещение/POI/автомут не появляются.

## Приёмка и порядок реализации

1. Независимые plan reviews correctness/engineering/tests + security для принимаемой телеметрии/удаления, один immutable freeze и manifest. Закрыть существенные находки до кода.
2. A6 media deletion consumer/tombstone/миграция и диагностика backend — отдельные владения; root composition/OpenAPI/сквозные tests. Реальные PG/SDK проверки, исходная B5 совместимость, lint и существующие E2E; commit A6 после ревью.
3. B6 admin producer + client diagnostics + devices/stage/UI по непересекающимся владениям и согласованным ports. Источник A6 freeze для actual rollback. Unit lifecycle/clock/queue/authority и controlled PG delete races обязательны.
4. Native built app на настоящих PG/LK: звук продолжается при telemetry503/timeout, controls/timers/UUID/draft остаются; debug/report/version без секретов; fake-clock poor thresholds + реальное качество в эмулированной UDP сети; mute-off/inputchange/outputrouting где browser позволяет, stage/pin/hideself без audioleak; axe и keyboard; expired-short-test-JWT reconnect/сон/восстановление не выдают старые subscriptions. CDP offline не доказательство UDP failure.
5. Local isolated netem/UDP блокировки с cleanup и положительным baseline. SDK polling/наличие track не заменяют actual output FFT. Не заявлять реальные WAN, TURN/TLS/операторов/Safari/физические телефоны или отложенное эхо.
6. SECURITY.md: текущая link-based модель, no roles/private-room guarantee, безопасный канал найден по факту в GitHub settings/реальных контактах, не выдумывать включённые private reports. Если private channel не доступен — явно написать, что он пока не подтверждён, и предложить issue только с запросом контакта без деталей/эксплойта/секретов. Email из authenticated profile не оказался публичным и не публикуется. Не включать GitHub private reporting без отдельного решения автора; отсутствие канала записывается как пункт готовности к С, не скрывается.
7. Итоговые implementation reviews, BE/FE/lint/contract/budget/18 + новые E2E/3images, docs AGENTS==CLAUDE, feature commit/draft PR main. Удалённый последний ci-ok проверяется отдельно; нельзя merge при отсутствии.

## Предварительные неопределённости

Физическое переключение на второй настоящий audiooutput, unplug оборудования, Safari/телефоны и WAN требуют ручной/стендовой проверки в С. В локальном Chromium можно подтвердить default sink, явный unsupported path и ошибки, но не заявлять проверку физического маршрута на отсутствующем втором устройстве. Это не блокирует реализовать выбор по опубликованному browser API. SLI decoded_playback_proxy с resolutionMs не переименовывается в физическое слышание. Неподтверждённый закрытый канал GitHub для сообщений об уязвимостях не объявляется существующим.

## Согласованный wire-контракт для исполнителей

Публичные Pydantic модели только в `round/contract/diagnostics.py`; neutral dataclasses/ports — `shared/application/diagnostics.py`; API/auth/usecase — `round/api/diagnostics.py`, `round/application/diagnostics.py`; SQL shared adapter + round transaction adapter. Один schemaVersion1; сторонних пакетов для metrics не требуется.

- Общие поля batch: schemaVersion:1, batchId:UUIDv4, clientSessionId:UUIDv4, appVersion:dev|test|YYYY.MM.DD-12hex[-dirty]. Telemetry: records[1..24], droppedRecords:nonnegative safe integer. Errors: errors[0..20], report:ProblemReport|null, хотя бы одно error/report. Server receivedAt определяет retention/day, client timestamps не управляют удалением.
- SLI record: kind:sli, name:join_decoded_playback_ms|room_switch_decoded_playback_ms|reconnect_media_ms|snapshot_delivery_ms|clock_offset_uncertainty_ms, outcome:observed|empty_room|not_observed|cancelled|superseded|unknown, elapsedMs:finite0..86400000|null, resolutionMs:finite0..10000|null, clockUncertaintyMs:finite0..86400000|null. Null duration не идёт в histogram; outcome считается отдельно. Canon target first audio не объявляется измеренным физически по этим proxy.
- Media record: kind:media, elapsedMs:finite0..604800000, observedMs:finite0..7500, unknownMs:finite0..604800000, quality:excellent|good|poor|lost|unknown, playbackAllowed:boolean, wantedAudio/attachedAudio/decodedActiveAudio:0..40|null (unknown только у decoded), jitterMs/audioRtcpRttMs/iceRttMs:finite0..60000|null; receivedPacketsDelta/lostPacketsDelta/receivedBytesDelta:nonnegative safe integer|null, bitrateBps:finite0..1000000000|null, candidateType:host|srflx|prflx|relay|null, protocol:udp|tcp|tls|null, qualityLimitation:none|cpu|bandwidth|other|null. unknownMs покрывает обнаруженный gap; его не зачисляют good.

  Selfquality ratio сопровождается coverage; unknown исключение не служит доказательством 90% участнико-минут.
- Error record: code enum (unexpected_error,unhandled_rejection,preload_error,media_unavailable,device_unavailable,playback_blocked,control_unavailable,diagnostics_unavailable), phase enum(prejoin,joining,connected,reconnecting,left), class enum(Error,TypeError,RangeError,DOMException,unknown), frames≤10 с asset basename `index|[A-Za-z0-9_-]+` + hashed .js, положительные bounded line/column; arbitrary Error.message/stack/API input запрещены.

  Report: phase, epoch/version safe nullable, clock synchronized/degraded/age/uncertainty, latest media record|null, events≤100 из finite safe event codes, dropped counters. Этот небольшой whitelist можно уточнить **до** параллельного исполнения обоих концов без нового product decision; недопустим произвольный string event/detail.
- Монотонные collection times, IDs сырого stats object, device IDs/labels и link не уходят в телеметрию. Backend/frontend parsers проверяют одинаковые nullable ranges; examples/OpenAPI/TS обновляются одним root after worker agreement.
