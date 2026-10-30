# UX-аудит экрана раунда, 30.10.2026

План v1.1. Автор поручил проверить весь round screen, комнаты/чат/toolbar, collapse и resize, а также общее UX. Явные дефекты исправляем в текущей задаче, новые функции/переносы действий и серверные контракты не вводим.

## Подтвержденные результаты и проблемы

39 native Chromium состояний: 15 размеров 1920×1080…320×568 и 844×390, с открытой/закрытой панелью и mobile Sheet; обычная и максимальная допустимая motion/infoslide, 4 активных участника, имя судьи 40 символов. Боковые края равны, hand count не срезан, draft/video DOM сохраняются, chat открывает chat после drum, открытый mobile drawer исчезает при resize в desktop и сам не возвращается при resize назад.

Дефекты: на 360×640/320×568/844×390 высокая центральная шапка вытесняет сцену до 10–78px; крайние call controls уходят под overflow hidden. В mobile Sheet скрытый h2 оставляет пустой heading высотой 56px. Axe обнаружил aria-label на generic avatar div без роли, недостаточный контраст room-more в своей темной карточке, отсутствие клавиатурного фокуса у прокручиваемого motion-summary. Артефакты baseline `/private/tmp/debatemeet-ux-baseline/report.json` и PNG.

## Минимальное исправление

1. Существующий `.meeting-center` остается grid с теми же toolbar/header/scene и video DOM. Третья row получает `minmax(min-content, 1fr)` вместо нулевого минимума; `.stage-video-area` получает min-height180px, а цепочка `.meeting-scene` / `.meeting-call-area` / `.meeting-stage` — min-height:min-content, чтобы dock, selector, pagination и recording status добавлялись к минимуму видео, а не съедали его; overflow-x hidden, overflow-y auto, overscroll contain. Если все не помещается, скроллится центральная колонка; левая панель сохраняет собственную область прокрутки, chat не перемонтируется от скролла. На обычной высоте scrollHeight должен совпадать с clientHeight. Проверяем минимум именно stage-video-area180px с dock/selector/pagination/status, доступность всех controls после scrollIntoView, отсутствие безвозвратного clipping. На низком/горизонтальном экране все элементы доступны прокруткой вместо сжатия видео до нуля. `.meeting-notices` ограничивается max-height:min(30dvh,200px) с overflow-y:auto и focusable region «Уведомления раунда»; даже стопка предупреждений оставляет workspace доступным. Пустой notices по-прежнему display:none. Resize назад сбрасывает избыточный scroll естественным ограничением scrollHeight.
2. В `.meeting-panel-sheet` у room-map-heading убрать искусственный min-height/margin; при наличии judge button сохранить 44px и margin6. Пустой заголовок не занимает место, recall остается доступен. Reuse CSS :has, поддерживаемый текущей browser matrix, без state/JS observers.
3. Существующий ParticipantAvatar получает role=img с прежним aria-label, без новых компонентов. Scoped `.room-own .room-more` использует on-stage-muted. В MotionDisplay scroll summary получает role=region, понятное aria-label и tabIndex0 при непустом тексте; пустой summary не добавляет tab stop. Это позволяет Arrow/PageDown прокручивать текст, «Полностью» сохраняется.

Новые состояния/типы/зависимости/сервисы/флаги не нужны. Область — CSS, существующие ParticipantAvatar и MotionDisplay. Прежний выбор grid/manual pin, media budget/attachment, room transport, recording не меняются.

## Проверка

- Native browser baseline/final sweep: desktop открытая/закрытая панель, 959px boundary, portrait/landscape и короткие окна; ordinary+long text+long judge name. Геометрия отделяет допустимую прокрутку от clipping: каждый dock control должен стать целиком видимым после scrollIntoView; bbox stage-video-area не менее180px. Дополнительно 4 камеры + 2 опубликованных тестовых canvas-screen (один выбранный screen в сцене), selector и pagination, несколько предупреждений в landscape. LiveKit настоящий, только capture экрана заменен canvas для layout-проверки. При открытом modal фон inert и исключен из контроля видимости; собственные controls modal доступны.
- Чат: draft при collapse/resize/tab, длинное сообщение/имя, видимость composer и достижимость всех шести комнат внутри скролла; переход в другую комнату не требует новой панели; main video DOM сохраняется при collapse. Grid/pin и меню/полный текст доступны на desktop/touch.
- Axe WCAG2A/AA/2.1AA в desktop и mobile panel; для focusable summary тест UI и реальная прокрутка клавиатурой; корректная доступная роль avatar. CSS косметику отдельными зеркальными unit tests не закрепляем.
- Frontend tests/lint/types/layers/format/build/budget по затронутой области. Короткие беззвучные тесты, только собственный уже существующий local test round. Никаких длительных нагрузочных прогонов/записи.

После реализации отчет отделит исправленные дефекты от рекомендаций, требующих нового продуктового решения.

Независимое review v1: инженерный обзор подтвердил reuse/DOM/scroll chain. Поведенческий нашел два существенных края: минимум outer scene не учитывает selector/pagination/recording status, а notices вне центра могут занять весь viewport. В v1.1 минимум задан actual video area с растущими предками; notices ограничены и прокручиваются. Проверка расширена multi-screen/pagination и стеком предупреждений.

## Итоговая приемка

Исправлены вытеснение видео и dock при недостатке высоты, большая стопка notices, пустой mobile heading, дополнительный перенос пятой реакции в 320px. Все touch-цели сохранены не менее44px. Исправлены роль avatar, контраст room-more в своей комнате, клавиатурная прокрутка motion-summary, chat-log и notices. Пустые summary/chat не получают tab stop. Дефекты доступности сначала воспроизведены RED, затем прошли GREEN.

Повторный read-only обзор v1.1 закрыл обе находки. Итоговый Chromium-прогон: **44 состояния passed, issues0, pageerrors0, Axe WCAG2A/AA/2.1AA violations0**. Размеры: 1920×1080, 1600×900, 1440×900, 1280×720, 1100×720, 1024×768, 960×600, 959×720, 768×600, 600×700, 390×844, 360×640, 320×568, 844×390, 1024×500.

Проверены раскрытая/свернутая panel, длинное имя судьи40, длинная motion/infoslide и непрерывное сообщение, сохранение draft/video DOM, resize drawer, chat после drum, отправка сообщения, OG→база, достижимость шести комнат, полный текст/меню/кнопка выхода без совершения выхода, возврат focus по Escape, volume popup в viewport. Две демонстрации, selector и pagination сохраняют actual video area не менее180px; все dock controls целиком достижимы после прокрутки. На обычной высоте дополнительный scroll центра не нужен.

API/Postgres/LiveKit настоящие локальные; участники синтетические в собственном существующем раунде. Для двух демонстраций capture заменен анимированным canvas, tracks опубликованы через LiveKit. Стек notices создан как layout stress существующим CSS-классом; это не проверка всех серверных причин предупреждений. Touch эмулировался Chromium. Safari/Firefox и физические телефоны не запускались; Axe не заменяет полную проверку WCAG. Звук на выходе браузера отключен, запись и длительная нагрузка не запускались.

682 frontend tests прошли; lint, TypeScript/build, dependency-cruiser, Prettier измененных файлов, budget119.3KiB gzip из150 и git diff --check прошли. Финальные артефакты: `/private/tmp/debatemeet-ux-final/report.json` и PNG. Baseline сохранен отдельно. Сбои ранних harness-прогонов из-за breakpoint timing и отсутствия кадров искусственного screen исправлены ожиданием React layout и анимированным canvas; они не засчитаны как успешные проверки приложения.

## UX-вывод и следующие улучшения

Основные переходы комнат/чата/panel предсказуемы: один переключатель, один drawer, сохранение draft и видео. На очень низких окнах доступ обеспечивается вертикальной прокруткой центральной части. Обычные desktop-размеры остаются без нее.

Рекомендации отдельно от исправленных дефектов, без реализации новых функций:

- **Заметность выхода.** Сейчас «Выйти» находится в «Еще». Стоит вынести его в основной dock, сохранив существующие подтверждения для судьи и записи.
- **Присутствие в краткой карте комнат.** RoomMap берет первые две записи snapshot и общий счетчик, включая временно отсутствующих до штатной архивации. После переподключений отсутствующие могут занимать обе строки, а присутствующий пользователь скрывается в «Еще N». Стоит отдельно согласовать показ сначала присутствующих/себя и различие активного/ожидающего возврата счетчика, сохранив установленный пятиминутный lifecycle агрегата.
- **Очень длинное имя судьи.** Сейчас оно полностью переносится и увеличивает шапку. Это сохраняет читаемость; компактное сокращение с доступным полным именем — отдельный визуальный выбор для следующей итерации.


## Продолжение v2: явный выход и порядок участников

Автор одобрил перенос «Выйти» в основной dock и приоритет присутствующих/себя в комнатах.

- Перенести существующую кнопку и `leave()` из More в конец callControls, с leave-call icon и видимой подписью desktop. More больше не дублирует exit. Обработчик/порядок recording→judge→обычный leave не меняется; отмена возвращает focus на новую кнопку (нативный ConfirmDialog restore). Передача флага с выходом остается прежней. Старую menu-leave CSS удалить только в неиспользуемом локальном правиле.
- Для desktop button52px с надписью и контуром; на ширине<=600px все шесть основных целей mic/camera/screen/hand/chat/leave имеют44px, текст exit визуально скрыт с сохранением aria-label/title. More44px и пять reactions44px остаются вторым рядом; при320px dockpadding4px/gaps сохраняют минимум44 и исключают третий ряд/обрезание. Exit не вводит новый цвет: используется существующий foreground/контур, по design destructive actions не красные.
- В RoomMap существующий отфильтрованный список комнаты копируется через toSorted: self первым, затем id из state.people (фактические LiveKit connections, как connectedRoomParticipants), затем остальные; внутри одинакового ранга исходный порядок остается стабильным. Snapshot/архив/5min lifecycle/общие счетчики не меняются. Только первые две строки меняются по приоритету; hidden hand summary использует уже отсортированные visible2, hand queue order не меняется. Не сортируем по speaking. Новый helper/слой не нужен, Set один на render.
- Регрессии: текущий self после старых отсутствующих; LiveKit present после snapshot disconnected и наоборот cache connected без media; equal rank stability; snapshot не мутирует; hidden hand summary корректен. Exit напрямую, cancel/confirm judge, recording exit cancel/confirm, focus возврат и отсутствие duplicate в More. Обновить зависимые E2E/scripts на новый вход без изменения их смысла.
- Native актуального dist: dock desktop/mobile320/360/390 +landscape/resize/collapse, выход обычного участника и judge cancel/confirm, присутствующие/self в карточках после реального disconnect peer. Короткий тихий recording harness подтверждает выход/экспорт, если выполняется; без длинной нагрузки. Frontend checks, backend pytest для свежего ответа по готовности. Стенд/production не развертываем.

Продуктовое решение и реализация разрешены текущим запросом; новые backend команды/схемы/сущности/flags не добавляются.


### Приемка продолжения v2

Реализовано: единственный exit в основном dock, desktop icon+text52px и mobile icon44px. На<=600px шесть primary44px в первом ряду, reactions и More во втором; минимальные цели и контурная палитра сохранены. Прежний leave() и ConfirmDialog не менялись. RoomMap использует копию списка, self первым, затем state.people connected, затем отсутствующие, стабильные равные ранги. Счетчики/5min lifecycle и hand queue не меняются; hidden hands вычисляются по отсортированным visible2.

Два независимых read-only обзора v2 завершены без существенных находок. Учтено инженерное условие gap<=2px для 6×44px при viewport320. RED регрессии подтвердили отсутствие прямого exit и прежний порядок; recording regressions проверены на корректной подписи штатной кнопки «Остановить».

686 frontend tests passed, lint/type/build/layers/format/diff-check passed; initial JS119.3KiB gzip. Native Chromium9 размеров +touch320: self/connected идут первыми перед retained absent, после реального выхода peer следующий присутствующий поднимается; regular exit, judge cancel/confirm и focus restore прошли, дубликата More нет. Все шесть primary44px лежат на одной линии и reactions/More на второй на320/360/390/600. Axe0, pageerrors0. Артефакты `/private/tmp/debatemeet-exit-native-20261030/report.json` и PNG.

Короткий native recording harness с настоящим getDisplayMedia/LiveKit прошел через новый прямой exit:30.282s,3821240bytes, оба синтетических микрофона с отдельными mute/unmute, шаринг и его остановка, другая вкладка/приложение, exitStoppedRecording=true, observerNotice=true, полный decode video/audio ffmpeg и UI download export. Артефакты `/private/tmp/debatemeet-recording-short-1793372228127/`. Физические устройства не использовались, вывод звука выключен, длительный тест не запускался.

### Готовность: подтвержденные границы

На текущем рабочем дереве backend pytest:871passed+1skipped из-за занятого dev-backend порта8000. После завершения browser-проверок остановлен только собственный dev-backend; из-за задержанного освобождения bind первая отдельная попытка тоже пропустила тест. После ожидания фактически свободного порта неизмененный `test_signed_webhooks_of_livekit_reach_the_backend` прошел отдельно:1passed,0.98s. Backend восстановлен на8000, frontend5173 и его API отвечают200. Ruff/check/format, mypy259files и15 import contracts прошли. Логи `/private/tmp/debatemeet-readiness-backend.log` и `/private/tmp/debatemeet-readiness-webhook.log`.

Функциональное ядро BP реализовано и локально проверено: ссылка/вход,6комнат и RTC-изоляция, микрофоны/камеры/шаринг, общие таймеры, motion/infoslide, жребий, руки/реакции, judge controls/recall, общий чат, reconnection/device lifecycle и локальная запись/экспорт. Это готовность локального контура, не подтверждение публичного запуска.

На момент приемки v2 полный28-E2E набор после последнего UI изменения еще не запускался; discovery28tests/10files проходил. Последующий полный E2E актуального рабочего дерева завершен успешно:28passed,0skipped/failed/flaky — [отчет](e2e-check-20261030.md). Есть актуальные targeted native RTC/recording/UX доказательства и полный unit/integration набор. До выпуска нужен полный регрессионный прогон на чистом стенде, deployment HTTPS/TURN, проверка сети/устройств/телефонов и первая живая игра. Настройки безопасности/бэкапов/мониторинга в репозитории не доказывают их фактическое развертывание. Физическое эхо остается ранее отложенной автором непроверенной границей. Длительный recording load был остановлен по просьбе автора и не считается пройденным; короткие проверки не обещают поведение многочасовой записи на любом ПК. Remote CI, merge и deployment этой работы не выполнялись; изменения пока в локальном dirty working tree.
