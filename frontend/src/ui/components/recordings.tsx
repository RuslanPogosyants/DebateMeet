import { useCallback, useEffect, useState } from 'react'
import { useStore } from 'zustand'
import type { RoundController } from '@/application/round-controller'
import type { RecordingEntry, LocalRecordingStore } from '@/application/recording-ports'
import { useServices } from '@/ui/services'
import { Sheet } from './sheet'
import { ConfirmDialog } from './confirm-dialog'
import { roomNames } from '@/ui/strings'
import './recordings.css'

const reasons: Record<string, string> = {
  recording_unsupported: 'Этот браузер не поддерживает запись вкладки с локальным восстановлением.',
  recording_busy: 'В этой комнате уже идет запись.',
  recording_expired: 'Запись остановлена: не удалось подтвердить соединение с сервером.',
  recording_room_changed: 'Запись завершена при выходе из комнаты.',
  recording_session_changed: 'Запись завершена при выходе из звонка.',
  recording_source_lost: 'Запись остановлена: захват вкладки завершен или изменен.',
  recording_wrong_tab: 'Выберите текущую вкладку DebateMeet.',
  recording_audio_missing: 'Для записи разрешите передачу звука вкладки.',
  recording_tab_audio: 'Для записи разрешите передачу звука вкладки.',
  recording_capture_changed: 'Запись остановлена: источник захвата изменился.',
  recording_capture_ended:
    'Захват вкладки остановлен. Сохраненная часть доступна в списке записей.',
  recording_storage: 'Не удалось сохранить запись локально. Сохраненная часть остается доступной.',
  recording_storage_full:
    'Запись остановлена: закончилось доступное место. Сохраните записанную часть.',
  recording_slow_storage:
    'Запись остановлена: компьютер не успевает сохранять видео. Сохраните записанную часть.',
  recording_encoder:
    'Запись остановлена из-за ошибки кодирования. Сохраненная часть доступна в списке записей.',
  recording_storage_failed: 'Запись остановлена из-за ошибки локального сохранения.',
  recording_quota: 'Недостаточно места для локальной записи.',
  recording_failed:
    'Не удалось начать запись. Проверьте разрешение захвата вкладки и свободное место.',
  network: 'Не удалось связаться с сервером. Попробуйте начать запись еще раз.',
}
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function size(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

export function RecordingIndicator({
  controller,
  onLibrary,
}: {
  controller: RoundController
  onLibrary: () => void
}) {
  const state = useStore(controller.recording.store)
  const round = useStore(controller.store)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (state.phase !== 'recording') return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const oldTitle = document.title
    document.title = `● Запись · ${oldTitle}`
    return () => {
      clearInterval(timer)
      document.title = oldTitle
    }
  }, [state.phase])
  useEffect(() => {
    if (state.phase === 'idle') return undefined
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state.phase])
  const room = round.snapshot?.participants.find((person) => person.id === round.self)?.room
  const others = state.leases.filter(
    (lease) => lease.room === room && lease.participantId !== round.self,
  )
  return (
    <div className="recording-status">
      {state.phase !== 'idle' && (
        <div className="recording-live" role="status">
          <span>
            {state.phase === 'recording'
              ? `● Идет запись · ${duration(now - (state.startedAt ?? now))}`
              : state.phase === 'choosing'
                ? 'Выберите вкладку для записи…'
                : state.phase === 'starting'
                  ? 'Запускаем запись…'
                  : 'Сохраняем запись…'}
          </span>
          {state.phase !== 'stopping' && (
            <button
              className="action"
              type="button"
              onClick={() => {
                void controller.recording.stop()
              }}
            >
              {state.phase === 'recording' ? 'Остановить' : 'Отменить'}
            </button>
          )}
        </div>
      )}
      {others.map((lease) => (
        <p key={lease.recordingId} role="status">
          {state.statusUnavailable ? 'По последним данным, ' : ''}
          {round.snapshot?.participants.find((person) => person.id === lease.participantId)?.name ??
            'Участник'}{' '}
          ведет запись
        </p>
      ))}
      {state.statusUnavailable && <p role="status">Не удалось обновить сведения о записи.</p>}
      {state.error && (
        <p role="status">
          {reasons[state.error] ??
            'Запись остановлена. Сохраненные данные доступны в списке записей.'}
        </p>
      )}
      {state.last && state.last.bytes > 0 && state.phase === 'idle' && (
        <p role="status">
          Запись сохранена локально.{' '}
          <button className="text-link" type="button" onClick={onLibrary}>
            Сохранить видео в файл
          </button>
        </p>
      )}
      {state.persistent === false && state.phase !== 'idle' && (
        <p>Браузер не подтвердил постоянное хранение. Скачайте видео после остановки.</p>
      )}
    </div>
  )
}

type WritableTarget = { createWritable(): Promise<WritableStream<Uint8Array>> }
type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<WritableTarget>
}
async function download(storage: LocalRecordingStore, entry: RecordingEntry): Promise<void> {
  const name = `DebateMeet-${entry.room}-${new Date(entry.startedAt).toISOString().replaceAll(':', '-')}.webm`
  // The picker needs this click's user activation; read the large file only afterwards.
  const target = (window as FilePickerWindow).showSaveFilePicker?.({ suggestedName: name })
  const handle = target ? await target : null
  const file = await storage.file(entry.id)
  if (handle) {
    await file.stream().pipeTo(await handle.createWritable())
    return
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export function RecordingsLibrary({ onClose }: { onClose: () => void }) {
  const { recording } = useServices()
  const [entries, setEntries] = useState<RecordingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [remove, setRemove] = useState<RecordingEntry | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await recording.storage.list())
      setListError(null)
    } catch {
      setListError('Не удалось прочитать локальные записи. Данные не удалены.')
    } finally {
      setLoading(false)
    }
  }, [recording])
  useEffect(() => {
    void Promise.resolve().then(refresh)
  }, [refresh])
  const pending = entries.some((entry) => entry.status === 'recording')
  useEffect(() => {
    if (!pending) return undefined
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(timer)
  }, [pending, refresh])
  return (
    <Sheet title="Записи на этом компьютере" onClose={onClose} className="recordings-library">
      <p>
        Видео хранится в этом браузере. После скачивания файл остается на компьютере.
        Автоматического удаления по времени нет.
      </p>
      <p className="text-caption">
        Очистка данных сайта удалит локальные копии. В приватном режиме восстановление после
        закрытия не гарантируется.
      </p>
      <button
        className="action"
        type="button"
        disabled={loading}
        onClick={() => {
          void refresh()
        }}
      >
        Обновить список
      </button>
      {error && <p role="alert">{error}</p>}
      {listError && <p role="alert">{listError}</p>}
      {loading && <p role="status">Читаем записи…</p>}
      {!loading && entries.length === 0 && <p>Локальных записей пока нет.</p>}
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className="recording-entry">
            <strong>
              {roomNames[entry.room]} · {new Date(entry.startedAt).toLocaleString('ru-RU')}
            </strong>
            <span>
              {duration(entry.durationMs)} · {size(entry.bytes)} ·{' '}
              {entry.status === 'recording'
                ? 'Идет запись или сохранение'
                : entry.status === 'interrupted'
                  ? 'Незавершенная запись'
                  : entry.status === 'failed'
                    ? 'Запись прервана'
                    : 'Готова'}
            </span>
            <div>
              <button
                className="action-primary"
                type="button"
                disabled={busy !== null || entry.status === 'recording' || entry.bytes === 0}
                onClick={() => {
                  setBusy(entry.id)
                  setError(null)
                  void download(recording.storage, entry)
                    .catch((failure: unknown) => {
                      if (!(failure instanceof Error && failure.name === 'AbortError'))
                        setError(
                          'Не удалось сохранить файл. Локальная копия остается доступной для повторной попытки.',
                        )
                    })
                    .finally(() => {
                      setBusy(null)
                      void refresh()
                    })
                }}
              >
                {busy === entry.id
                  ? 'Подготавливаем…'
                  : entry.status === 'interrupted'
                    ? 'Восстановить и сохранить'
                    : 'Сохранить видео'}
              </button>
              <button
                className="action"
                type="button"
                disabled={busy !== null || entry.status === 'recording'}
                onClick={() => setRemove(entry)}
              >
                Удалить локальную копию
              </button>
            </div>
          </li>
        ))}
      </ul>
      {remove && (
        <ConfirmDialog
          title="Удалить локальную запись?"
          confirm="Удалить"
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const id = remove.id
            setRemove(null)
            setBusy(id)
            void recording.storage
              .remove(id)
              .then(() => refresh())
              .catch(() =>
                setError(
                  'Не удалось удалить запись. Возможно, она еще записывается в другой вкладке.',
                ),
              )
              .finally(() => setBusy(null))
          }}
        >
          <p>
            Убедитесь, что нужное видео сохранено в файл. Восстановить удаленную локальную копию не
            получится.
          </p>
        </ConfirmDialog>
      )}
    </Sheet>
  )
}

export function LocalRecordingsButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="text-link" type="button" onClick={() => setOpen(true)}>
        Записи на этом компьютере
      </button>
      {open && <RecordingsLibrary onClose={() => setOpen(false)} />}
    </>
  )
}
