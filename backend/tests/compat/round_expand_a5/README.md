# Замороженная граница A5

`source/**/*.py.fixture` — 69 побайтовых копий настоящих Python-модулей, всего
209 177 байт, из коммита `e65ad95404a49b5e168a218438e9413d26f6cb3b`.
`manifest.json` содержит исходный путь, ревизию и SHA-256 каждого файла.
Исторические исходники не исправлять и не форматировать вместе с текущим кодом.
Для новой границы совместимости нужен отдельный набор.

Это полное рекурсивное дерево импортов для Round SQL/обычного executor, actual
entry/rooms/chat routers, snapshot/history и media SQL/publisher/control coordinator.
Main, миграции и LiveKit SDK adapter не копируются. Расширение `.py.fixture`
не позволяет импортам, линтерам и форматтерам считать копии текущим приложением.

`run_a5.py.fixture` — текущий тестовый harness, не исторический исходник. Тест
проверяет SHA, материализует пакет в собственном временном каталоге и запускает
новый Python с этим пакетом первым в PYTHONPATH и временным cwd. До и после работы
проверяются пути всех загруженных модулей `debatemeet` и отсутствие `Round.raise_hand`.
SDK boundary реализует весь настоящий протокол A5; параметры методов сверяются
сигнатурами. Внешний SDK и HTTP-сервер не запускаются.

`test_a5_rollback.py` создаёт состояние B5 настоящими командами и chat use cases в
отдельной временной Postgres-базе. Прежний B4 fixture builder используется повторно;
команды B5 добавляют ненулевые руки и retained control receipts. Реальный B5 control
coordinator останавливается на двух crash boundaries: после mutating вызова с
неизвестным результатом и после persisted confirmed результата с потерянным ответом
на notice. Marker/confirmed rows получены production-переходами, не SQL-подделкой.
Ручной unmute того же track представлен состоянием тестовой SDK boundary.

В пределах 30-секундного TTL настоящий A5 executor пишет Enter/PauseTimer, HTTP router
отдаёт authenticated snapshot/history, а новые B5 POST отсутствуют (404/405). Настоящий
A5 publisher с настоящим Postgres lease доставляет только pending request и retry
confirmed notice, не вызывает mutating SDK, отбрасывает истёкший effect, старый epoch
и заменённый target SID. У notice сохраняется прежний effectId. Publisher и metadata
используют тот же snapshot. Две DB connections нужны для dedicated publisher lease
и запросов coordinator; это не проверка pool=1.

Отдельная стадия переводит injected Clock за сутки и выполняет actual A5 maintenance.
Доставленные outbox rows удаляются, шесть retained UUID/hash сохраняются без изменений.
Вернувшийся B5 повторяет каждый прежний ключ без нового effect/RPC; другой payload
конфликтует. B5 читает руки, motion/drum, таймеры/undo, history/tombstone и продолжает
undo. Повтор удалённого chat intent после очистки обычных command keys остаётся tombstone.

Публичные `expand-a5-snapshot.json` и `expand-a5-controls.json` получены настоящими
serializer/router/publisher A5. Тест строго сравнивает результат с этими golden;
автоматического перезаписывания нет. В них только синтетические публичные данные.
URL временной базы и синтетические secrets идут subprocess через stdin; ошибки
возвращают только безопасный stage/type, не driver exception или SQL/credentials.

Git нужен лишь при первоначальном извлечении и сверке происхождения. Runtime тестов
не зависит от Git history, `.env`, сети, второго сервера или исторической ветки.
Это доказательство совместимости исходников/реальной БД/границы SDK, а не проверка
native audio, UI на откате или доставки через настоящую сеть.
