# Ресерч: как реализовать видеозвонки

> **Исторический документ.** Ресерч от 27 сентября 2026, до проектирования архитектуры. Часть его выводов позже пересмотрена: атрибуты участников не используются, снимок при подключении LiveKit сам не отдаёт (медиакомната закрывается через ~20 с вместе с метаданными), флаг судьи не удерживается 60 с, сброса раунда нет. Где этот документ расходится со [spec.md](spec.md) и [architecture.md](architecture.md), верны они.

**27 сентября 2026.** Три направления: как подкомнаты сделаны у других, LiveKit, сеть и хостинг в РФ. Выводы внесены в [spec.md](spec.md). Пометка «не проверено» — одиночный или неофициальный источник; «вывод» — заключение без прямого подтверждения.

## Итог

1. **Одна медиакомната LiveKit на раунд, подкомнаты логические.** Подтверждено с двух сторон: серверное перемещение между комнатами в self-hosted LiveKit не реализовано, а продукты, которые переподключают человека при каждом переходе, страдают от сброса аудиоустройств, утечек звука и повторных запросов разрешений.
2. **Свой WebSocket не нужен.** Состояние раунда раздаёт сам LiveKit: метаданные комнаты, атрибуты участников, серверные data-сообщения. Бэкенд принимает команды по HTTP и хранит правду в Postgres. Меньше компонентов и меньше TLS-соединений — в РФ это важно (раздел 3).
3. **Готового проекта для форка нет.** Пишем своё SPA на компонентах LiveKit, решения подсматриваем у La Suite Meet (MIT) и LiveKit Meet (Apache-2.0).
4. **Главный внешний риск — сеть, а не технология.** В режиме белых списков мобильного интернета площадка на мобильных не откроется вообще. Домашний интернет не затронут. Продукт — прежде всего для ноутбука на домашнем интернете.
5. **Хостинг — Selectel** (облако, 3 ТБ трафика включено, бесплатная защита L3–L4 с UDP), запасной — Yandex Cloud. Зарубежный хостинг и LiveKit Cloud исключены.

## 1. Как подкомнаты сделаны у других

### Подход A: подкомната — отдельная конференция

Переход = выйти из одного звонка и войти в другой.

| Продукт | Как устроено | Известные проблемы |
|---|---|---|
| Jitsi Meet | Подкомната — отдельная комната на сигнальном сервере. Сигнальное соединение сохраняется, но медиасессия создаётся заново (`leaveRoom` + `joinRoom` в коде клиента) | Вылеты мобильных клиентов при переносе, рассинхрон, лечится перезагрузкой |
| Zoom | Подкомната — «новая встреча» | Сброс аудиоустройств, пропадание звука после перехода |
| BigBlueButton 4 (уже на LiveKit) | Отдельная встреча в новой вкладке | Пользователь остаётся подключён к главной комнате; может войти в подкомнату с включённым микрофоном |
| Discord | Смена канала рвёт голосовое соединение и открывает новое | Время переключения не публикуется |
| plugNmeet (LiveKit) | Отдельная комната LiveKit, переход — перезагрузка страницы | — |
| WorkAdventure | Своя комната LiveKit на каждый «пузырь»; до 4 человек P2P, с пятого — LiveKit с «глитчем ~200 мс» | — |

### Подход B: одно медиасоединение, подкомната решает, кого ты слышишь

- **100ms**: подкомнаты — «пространство внутри комнаты» через роли подписок; перенос — один вызов смены роли, без переподключения.
- **edumeet v4** (mediasoup): подкомнаты — «сессии» внутри одной комнаты; при переносе сервер закрывает потоки человека в старой сессии.
- **Пример spatial-audio от LiveKit**: одна комната, клиент включает и выключает подписки по расстоянию.

### Уроки

- Переподключение на каждом переходе — источник багов: сброс устройств, потеря звука, рассинхрон.
- Перезагрузка страницы на iOS заново запрашивает разрешение на камеру (не проверено, одиночный источник) → только SPA, без перезагрузок.
- Утечки звука между комнатами — реальный класс багов (BigBlueButton): порядок операций при переходе важен.
- Таймер, видимый во всех подкомнатах, не нашёлся ни у кого; в Jitsi его просили отдельным запросом.
- P2P держится примерно до 4 человек (опыт WorkAdventure).

## 2. LiveKit

Версии на 27.09.2026: livekit-server 1.13.7, livekit-client 2.22.3, components-react 2.9.24, Python livekit-api 1.2.1.

### Перемещение между комнатами

- `MoveParticipant` есть в протоколе, но работает только в LiveKit Cloud. В open-source сервере он возвращает «not implemented», запрос на self-hosted закрыт как «не планируется».
- Переподключение к другой комнате — это новая сигнализация, ICE/DTLS, повторная публикация, а для остальных — выход и вход. Официальных цифр нет; в issue встречается от ~1 до 4–5 с (не проверено).

### Логические подкомнаты в одной комнате

- `autoSubscribe: false` + `setSubscribed()`; сервер может форсировать подписки через `UpdateSubscriptions`.
- Атрибуты участника: клиент меняет свои только с правом `canUpdateOwnMetadata`, сервер — через `UpdateParticipant`. Лимит 64 КиБ; не для обновлений чаще раза в несколько секунд.
- Метаданные комнаты выставляет только сервер, до 512 КиБ.
- Приватность на будущее: `setTrackSubscriptionPermissions` у публикующего проверяет сервер. Серверного способа выставить разрешения за участника нет. Разрешения по отдельным трекам не распространяются на треки, опубликованные позже.
- Ограничено подпиской само: события «кто говорит» и качество связи приходят только по трекам, на которые ты подписан. Общее на всю комнату: список участников, входы и выходы, атрибуты — для карты комнат это то, что нужно.
- Data-сообщения идут всей комнате, если не указаны `destinationIdentities`.
- Первый кадр видео после перехода ждёт ключевой кадр; `pli_throttle` по умолчанию 0,5–1 с → видео может появляться примерно на секунду позже звука (вывод, проверить).
- Safari: с 1.12.0 сервер не переиспользует для Safari трансиверы; возможен рост SDP при частых переподписках (вывод, не проверено) → нужен тест длинной сессии с переходами. `room.sync_streams` не включать.
- Готового рецепта подкомнат в документации LiveKit нет.

### Чат и данные

- `useChat` из components не хранит историю, опоздавшие старых сообщений не получают; вдобавок он шлёт копию сообщения всей комнате в старом формате. → Чат через наш бэкенд: история в Postgres, рассылка серверным `SendData`.
- Надёжные data-сообщения — до 15 КиБ; text streams — без лимита, с нарезкой.

### Медианастройки

- Умолчания SDK: simulcast включён, VP8, backup codec, DTX и RED (для моно), аудиопресет «music» 48 кбит/с, захват 720p. `adaptiveStream`, `dynacast` и `webAudioMix` по умолчанию **выключены** — включаем сами.
- Слои simulcast: h180 (~160 кбит/с), h360 (~450 кбит/с), h720 (~1,7 Мбит/с).
- Кодеки: VP8, H.264, VP9, AV1 (SVC для двух последних). AV1 в SDK выключен для Safari и Firefox, VP9 — для Firefox и Safari младше 16.
- Громкость выше 100% работает только с `webAudioMix: true` (через GainNode). Без него — `el.volume` до 1,0, а на iOS `el.volume` не действует вовсе. `RemoteParticipant.setVolume` запоминает значение и применяет его заново при переподписке — удобно для переходов.
- **Риск эха**: эхоподавление Chromium исторически не учитывало звук, проигрываемый через Web Audio → эхо у тех, кто без наушников. Новое эхоподавление Chrome, возможно, это закрывает (не проверено). Проверить первым делом; запасной вариант — громкость 0–100% через элемент.
- Выбор устройства вывода в Safari не работает (`setSinkId` игнорируется для звука звонка) → в Safari этот выбор скрываем.

### Своё развёртывание

- Порты: 7880 TCP (API и WebSocket за TLS), 7881 TCP (ICE/TCP), UDP 50000–60000 или один порт 7882 (mux), TURN/TLS на 443 или 5349, TURN/UDP 3478.
- Нужны домен и сертификат доверенного УЦ; в Docker — host networking.
- `livekit/generate` собирает Caddy + LiveKit + Redis + docker-compose и сам получает сертификаты; нужны основной домен и домен для TURN.
- Redis для одного узла не обязателен; нужен для нескольких узлов и для Egress.
- Метрики Prometheus включаются параметром `prometheus_port`.
- Бенчмарк LiveKit на 16 ядрах: 150 публикующих видео × 150 подписчиков при 85% CPU; комната должна помещаться в один узел. Наши 30 человек проходят с огромным запасом по процессору.
- Egress на будущее: Track egress (дорожка на участника, без перекодирования) лёгкий, «сотни» на инстанс; RoomComposite требует 2–6 CPU и смешает все подкомнаты → выносить на другой сервер или не использовать.

### Вебхуки

room_started/finished, participant_joined/left/connection_aborted, track_published/unpublished, egress и ingress. **Событий включения и выключения микрофона и смены атрибутов нет** → бэкенд — источник правды о подкомнатах, а события микрофона для журнала снимает скрытый участник-наблюдатель.

### Основа для кода

| Проект | Лицензия | Чем полезен |
|---|---|---|
| LiveKit Meet (Next.js) | Apache-2.0 | Экран перед входом, настройки устройств, сетка; его настройки комнаты — образец |
| La Suite Meet (Django + React) | MIT | Чистый React-клиент на LiveKit, список поднятых рук, реакции |
| plugNmeet (Go + React) | MIT | Ближе всех по функциям подкомнат, но переход — перезагрузкой; образец UX |
| edumeet v4 (mediasoup) | MIT (клиент) | Лучший образец подкомнат-сессий без переподключения |
| Jitsi, BigBlueButton | Apache-2.0, LGPL-3.0 | Тяжёлые стеки; у BBB стоит читать issue про подкомнаты на LiveKit |

AGPL-проекты (Element Call, MiroTalk) не берём, если не готовы открыть свой код.

### Нагрузочный тест

- `lk load-test`: публикующие видео и аудио, подписчики, раскладка, симуляция говорящих. Подписчики берут все треки, поэтому переходы по атрибутам он не моделирует → время перехода меряем своими ботами.
- Playwright с флагами Chrome `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`, `--use-file-for-fake-video-capture`.

### Альтернативы

- **Jitsi**: подкомнаты из коробки, но тяжёлый стек, и интерфейс переделывать сложно.
- **mediasoup**: библиотека без сигнализации — всё пишем сами.
- **Janus**: GPL-3.0, C, много своей клиентской работы.
- **OpenVidu 3**: форк LiveKit, совместим с его SDK; бесплатная версия — один узел. Возможный путь роста.
- **LiveKit Cloud**: бесплатный тариф — 5000 минут и 50 ГБ. Из РФ не оплатить, а у пользователей из РФ медиа не проходило без VPN (одиночный отчёт) → не вариант.

## 3. Сеть и хостинг в РФ

### Что блокируют

- Блокировки бьют по конкретным сервисам, а не по WebRTC в целом: звонки Telegram и WhatsApp (с 13.08.2025), FaceTime (04.12.2025), Discord (08.10.2024), деградация Google Meet (с 22.08.2025).
- Сообщений о том, что WebRTC, STUN или TURN до серверов в РФ ломается вообще, не найдено; Телемост и VK Звонки работают и растут.
- Слабое место — зарубежные адреса: QUIC к зарубежным серверам режется с 2022 года; соединения к Cloudflare, Hetzner, DigitalOcean, OVH с июня 2025 обрываются после ~16 КБ.

### Июнь 2026: «заморозки» у российских хостеров

- С 05.06.2026 после обновления правил ТСПУ — плавающие сбои HTTPS и SSH у Selectel, Timeweb, Beget, FirstVDS, REG.RU и других; на 06.08.2026 не устранено.
- Механизм, восстановленный независимыми исследователями (официально не подтверждён): соединение замирает на 120 с, если одновременно сервер в «подозрительной» подсети (названы Selectel, Yandex Cloud, Cloud.ru, FirstVDS), отпечаток TLS как у Chrome или Safari и больше 3 параллельных TLS-соединений к одному SNI. Помогает HTTP/2: одно соединение вместо многих.
- UDP-медиа в отчётах не упоминается; TURN/TLS на 443 теоретически может попасть под правило (вывод).

→ Веб-приложение отдаём только по HTTP/2, держим минимум параллельных TLS-соединений на одно имя, разносим приложение, LiveKit и TURN по разным поддоменам.

### Белые списки мобильного интернета

- Режим действует с 12.03.2026 в 68–71 регионе. В июле 2026 без ограничений проходило лишь ~30% мобильных сессий в ЦФО (Москва — 49%, Петербург — 43,9%).
- Механика: разрешены только адреса из списка; TCP к остальным замирает после 16–20 КБ, UDP теряется почти полностью. В список попадают по обращению федерального органа власти.
- Телемост, VK и MAX в списке — поэтому у них работает.
- **Вывод: в режиме белых списков площадка на мобильном интернете не работает вообще — ни UDP, ни TURN.** Домашний интернет официально не затронут; единичные сообщения о белых списках на домашнем — не проверены.

### Как справляются российские сервисы

VK: приоритет UDP, FEC и NACK, 50+ точек присутствия, адаптивный битрейт, Opus с FEC/RED, потолок видео 720p. Но главное их преимущество — адреса в белом списке.

### Хостинг

| Провайдер | ~4 vCPU / 8 ГБ | Канал | Трафик | DDoS |
|---|---|---|---|---|
| Selectel (облако) | от ~1100 ₽/мес (доля CPU не указана); ~6100 ₽ «стандарт» (агрегатор, не проверено) | исходящий «от 3 Гбит/с» | 3 ТБ/мес включено, дальше 0,90 ₽/ГБ | L3–L4 бесплатно, включая UDP |
| Yandex Cloud | ~5,5–6,5 тыс. ₽ (оценка) | не указан | 100 ГБ бесплатно, дальше ~1–1,5 ₽/ГБ (не проверено) | базовая L3–L4, счёт по входящему |
| Timeweb Cloud | ~1800 ₽ | порт 1 Гбит/с, но выделяют 100–200 Мбит/с | безлимит | платно, через DDoS-Guard |
| FirstVDS | от ~1830 ₽ | до 1 Гбит/с | 32 ТБ бесплатно | платно |
| Beget | ~2040 ₽ (4 ядра / 6 ГБ) | 1 Гбит/с | не указано | L3/L4 постоянно |
| VK Cloud | ~5,1–7 тыс. ₽ | не указан | не тарифицируется | партнёрская, платно |
| RUVDS | ~1900 ₽ | **100 Мбит/с** — мало | безлимит | платно |
| Aeza | — | — | — | **исключить**: в санкционном списке OFAC с 01.07.2025 |

- Оплата трафика за гигабайт при наших 300–500 ГБ в месяц — не проблема: у Yandex ~400–600 ₽/мес, у Selectel укладывается во включённые 3 ТБ.
- Дорого становится платная защита от DDoS, которая считает легитимный трафик. У Yandex (Curator Advanced) счёт идёт по большему из входящего и исходящего: при 100 Мбит/с исходящего — ~116 тыс. ₽/мес. Такие тарифы не берём.

### DDoS с UDP

- Встроенная защита L3–L4 у Selectel (бесплатно), Beget, Yandex (базовая), Timeweb (DDoS-Guard, платно) прикрывает UDP на любых портах.
- Внешние: DDoS-Guard (от 30 тыс. ₽/мес; асимметричный режим фильтрует только входящий), StormWall (от 144 тыс. ₽), Curator (бывший Qrator).
- HTTP-прокси (DDoS-Guard L7, Curator L7) прикрывают сайт и сигнализацию, но не медиа. Cloudflare в РФ режется.
- Спросить у поддержки письменно, не порежет ли автофильтр ровный UDP-поток ~100 Мбит/с от 15–30 клиентов.

## 4. Что поменялось в архитектуре

1. **Своего WebSocket нет.** Команды идут по HTTP в FastAPI, правда хранится в Postgres, раздаёт LiveKit: метаданные комнаты (таймеры, резолюция, судья, рандомайзер), атрибуты участников (подкомната, рука), серверные data-сообщения (чат). Снимок состояния при подключении LiveKit отдаёт сам.
2. **Redis в MVP не нужен**: один узел LiveKit обходится без него, бэкенд хранит всё в Postgres. Redis появится вместе со вторым узлом LiveKit или с Egress.
3. **Чат — через бэкенд**, а не готовый `useChat`.
4. **События микрофона** для журнала снимает скрытый участник-наблюдатель на Python SDK; это же основа будущей записи и транскрипции. Не в первой итерации.
5. **Переход между подкомнатами**: звук ≤ 1 с, видео ≤ 2 с (ждём ключевой кадр).
6. **Раскладка по умолчанию — «спикер крупно».** Сетка из 11 плиток по 360p на 30 зрителей — это ~165 Мбит/с против ~90 у раскладки со спикером. `subscription_limit_video` ≈ 12 — как страховка.
7. **Мобильные — по возможности.** Если подключиться не удалось — понятное сообщение: «мобильный интернет ограничен, подключитесь к Wi-Fi».
8. **Поддомены** для приложения, LiveKit и TURN; только HTTP/2.

## 5. Проверки до первой игры

1. Эхо: Chrome на динамиках ноутбука с `webAudioMix: true`.
2. Время перехода между подкомнатами (звук и первый кадр) своими ботами, включая Safari; длинная сессия с множеством переходов в Safari.
3. Операторы: МТС, Билайн, МегаФон, Т2 и домашние провайдеры (Ростелеком, МТС, Дом.ру, один региональный); браузеры Chrome, Safari, Firefox. Записывать тип выбранного ICE-кандидата из `getStats`.
4. Принудительный прогон только через TURN/TLS.
5. Ровные ~100 Мбит/с исходящего UDP с VPS; `lk load-test` на 30 участников и 11 камер.
6. Проверка «заморозки»: несколько вкладок Chrome параллельно (или утилита dpi-ch).
7. Сессия на мобильном в окно белых списков: ожидаемо не работает — проверить, что пользователь видит сообщение.
8. Письменный ответ провайдера о фильтрации UDP.

## Источники

**Подкомнаты у других**
- Jitsi: [PR #9131](https://github.com/jitsi/jitsi-meet/pull/9131), [actions.ts](https://github.com/jitsi/jitsi-meet/blob/master/react/features/breakout-rooms/actions.ts), [#10721](https://github.com/jitsi/jitsi-meet/issues/10721), [#13456](https://github.com/jitsi/jitsi-meet/issues/13456), [форум: рассинхрон](https://community.jitsi.org/t/participants-get-out-of-sync-with-other-participants-in-same-room-have-to-refresh-browser-rejoin-room-as-workaround-what-is-proper-fix/107101)
- Zoom: [KB0060313](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060313), [devforum](https://devforum.zoom.us/t/audio-not-work-and-audio-settings-getting-reset-during-breakout-rooms/58814), [community](https://community.zoom.com/meetings-2/loss-of-audio-when-entering-leaving-breakout-rooms-27055)
- BigBlueButton: [#25814](https://github.com/bigbluebutton/bigbluebutton/issues/25814), [#21059](https://github.com/bigbluebutton/bigbluebutton/issues/21059), [v4.0.0-beta.4](https://github.com/bigbluebutton/bigbluebutton/releases/tag/v4.0.0-beta.4)
- Discord: [блог о голосе](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc), [docs.discord.food](https://docs.discord.food/topics/voice-connections)
- [plugNmeet](https://github.com/mynaparrot/plugNmeet-server), [plugNmeet-client](https://github.com/mynaparrot/plugNmeet-client); [WorkAdventure 1.27](https://workadventu.re/release/workadventure-1-27-0-the-road-to-workadventure-2/); [100ms breakout rooms](https://www.100ms.live/docs/get-started/v2/get-started/features/interaction-and-controls/breakout-rooms); [edumeet-room-server](https://github.com/edumeet/edumeet-room-server); [LiveKit spatial-audio](https://github.com/livekit-examples/spatial-audio); [La Suite Meet](https://github.com/suitenumerique/meet); [LiveKit Meet](https://github.com/livekit-examples/meet)
- Браузеры: [WebKit 215884](https://bugs.webkit.org/show_bug.cgi?id=215884), [Apple: громкость на iOS](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html), [Chromium 687574](https://bugs.chromium.org/p/chromium/issues/detail?id=687574), [discuss-webrtc: эхоподавление](https://groups.google.com/g/discuss-webrtc/c/v592nFc4cO4), [livekit client-sdk-js PR #1635](https://github.com/livekit/client-sdk-js/pull/1635)

**LiveKit**
- Участники и перемещение: [docs: participants](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/), [livekit_room.proto](https://github.com/livekit/protocol/blob/main/protobufs/livekit_room.proto), [roommanager.go](https://github.com/livekit/livekit/blob/master/pkg/service/roommanager.go), [#4203](https://github.com/livekit/livekit/issues/4203)
- Подписки, атрибуты, метаданные: [subscribe](https://docs.livekit.io/transport/media/subscribe/), [publish](https://docs.livekit.io/transport/media/publish/), [participant attributes](https://docs.livekit.io/transport/data/state/participant-attributes/), [room metadata](https://docs.livekit.io/transport/data/state/room-metadata/), [config-sample.yaml](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
- Данные и чат: [data packets](https://docs.livekit.io/transport/data/packets/), [text streams](https://docs.livekit.io/transport/data/text-streams/), [useChat](https://docs.livekit.io/reference/components/react/hook/usechat/), [chat.ts](https://github.com/livekit/components-js/blob/main/packages/core/src/components/chat.ts)
- Медиа: [defaults.ts](https://github.com/livekit/client-sdk-js/blob/main/src/room/defaults.ts), [options.ts](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts), [RemoteAudioTrack.ts](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/RemoteAudioTrack.ts), [кодеки](https://docs.livekit.io/recipes/video-codecs/)
- Развёртывание: [порты](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [deployment](https://docs.livekit.io/transport/self-hosting/deployment/), [VM и генератор](https://docs.livekit.io/transport/self-hosting/vm/), [бенчмарк](https://docs.livekit.io/transport/self-hosting/benchmark/), [egress](https://docs.livekit.io/transport/self-hosting/egress/)
- Вебхуки: [webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/); Python: [livekit-api](https://github.com/livekit/python-sdks/tree/main/livekit-api); нагрузка: [livekit-cli](https://github.com/livekit/livekit-cli), [WebRTC testing](https://webrtc.github.io/webrtc-org/testing/)
- Альтернативы и облако: [OpenVidu releases](https://openvidu.io/latest/docs/releases/), [mediasoup](https://mediasoup.org/documentation/overview/), [Janus](https://github.com/meetecho/janus-gateway), [LiveKit pricing](https://livekit.com/pricing), [отчёт о LiveKit Cloud из РФ](https://github.com/kapustaprusta/radio96/issues/49)

**Сеть и хостинг в РФ**
- Блокировки: [РБК 13.08.2025](https://www.rbc.ru/politics/13/08/2025/689c8c7c9a79479b1087586d), [Хабр 937004](https://habr.com/ru/news/937004/), [Meduza: Google Meet](https://meduza.io/feature/2025/09/04/glavnaya-alternativa-zvonkam-v-votsape-i-telegrame-google-meet-uzhe-dve-nedeli-rabotaet-v-rossii-s-silnymi-pereboyami), [Meduza: FaceTime](https://meduza.io/news/2025/12/04/v-rossii-zablokirovali-facetime), [Meduza: Discord](https://meduza.io/news/2024/10/08/roskomnadzor-zablokiroval-messendzher-discord), [Cloudflare 26.06.2025](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/), [ntc.party: Cloudflare/OVH/Hetzner/DO](https://ntc.party/t/09062025-%D0%B8%D0%BD%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%86%D0%B8%D1%8F-%D0%BF%D0%BE-%D0%B1%D0%BB%D0%BE%D0%BA%D0%B8%D1%80%D0%BE%D0%B2%D0%BA%D0%B5-cloudflare-ovh-hetzner-digitalocean/17013)
- Июнь 2026: [Хабр 1044396](https://habr.com/ru/articles/1044396/), [Хабр 1047442](https://habr.com/ru/articles/1047442/), [Хабр 1045684](https://habr.com/ru/articles/1045684/), [eByeBots](https://ebyebots.ru/blog/tspu-2026-pochemu-segodnya-sajty-i-hostingi-do-sih-por-ne-rabotayut-i-chto-delat/)
- Белые списки: [Википедия](https://ru.wikipedia.org/wiki/%C2%AB%D0%91%D0%B5%D0%BB%D1%8B%D0%B5_%D1%81%D0%BF%D0%B8%D1%81%D0%BA%D0%B8%C2%BB_%D1%81%D0%B0%D0%B9%D1%82%D0%BE%D0%B2_%D0%B2_%D0%A0%D0%BE%D1%81%D1%81%D0%B8%D0%B8), [Хабр 1027276](https://habr.com/ru/articles/1027276/), [iXBT 27.04.2026](https://www.ixbt.com/news/2026/04/27/belye-spiski-ne-rezinovye-v-mincifry-objasnili-kak-popast-v-perechen-vebresursov-dostupnyh-pri-otkljuchenii-interneta.html), [iXBT 05.08.2026](https://www.ixbt.com/news/2026/08/05/svobodnyj-mobilnyj-internet-umiraet-v-centralnoj-rossii-tolko-tret-mobilnogo-interneta-rabotala-bez-ogranichenij-v.html), [Mail.ru 31.08.2026](https://finance.mail.ru/article/mintsifryi-poruchilo-provajderam-vyidelit-adresa-belogo-spiska-v-otdelnyie-podseti-69225188/), [РИА 12.03.2026](https://ria.ru/20260312/belyy-spisok-saytov-2080159945.html)
- VK: [Хабр 2021](https://habr.com/ru/companies/vk/articles/575358/), [Хабр 2024](https://habr.com/ru/companies/vk/articles/846634/)
- Хостинг: [Selectel VPS](https://selectel.ru/services/cloud/vps-vds/), [Selectel DDoS](https://selectel.ru/services/additional/ddos-protection/), [Timeweb](https://timeweb.cloud/services/vds-vps), [Timeweb anti-DDoS](https://timeweb.cloud/docs/anti-ddos/anti-ddos-for-cloud-servers), [Yandex VPC pricing](https://raw.githubusercontent.com/yandex-cloud/docs/master/ru/vpc/pricing.md), [Yandex DDoS Protection](https://raw.githubusercontent.com/yandex-cloud/docs/master/ru/vpc/ddos-protection/index.md), [VK Cloud](https://cloud.vk.ru/pricelist/), [Beget](https://beget.com/ru/vps), [FirstVDS](https://firstvds.ru/products/vds_vps_cloud), [RUVDS](https://ruvds.com/ru-rub), [US Treasury: Aeza](https://home.treasury.gov/news/press-releases/sb0185), [DDoS-Guard](https://ddos-guard.ru/network-protection), [StormWall](https://stormwall.pro/products/services-ddos-protection)
