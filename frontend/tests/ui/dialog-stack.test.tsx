import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { Sheet } from '@/ui/components/sheet'
import { ConfirmDialog } from '@/ui/components/confirm-dialog'

function NestedConfiguration() {
  const [outer, setOuter] = useState(true)
  const [inner, setInner] = useState(false)
  return outer ? (
    <Sheet title="Комнаты" onClose={() => setOuter(false)}>
      <button type="button" onClick={() => setInner(true)}>
        Настроить жребий
      </button>
      {inner && (
        <ConfirmDialog
          title="Настроить жребий"
          confirm="Сохранить"
          onConfirm={() => setInner(false)}
          onCancel={() => setInner(false)}
        >
          Восемь спикеров
        </ConfirmDialog>
      )}
    </Sheet>
  ) : null
}

it('Escape closes only a nested configuration and restores its trigger', async () => {
  render(<NestedConfiguration />)
  const trigger = screen.getByRole('button', { name: 'Настроить жребий' })
  await userEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Настроить жребий' })
  expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus()
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
  expect(screen.queryByRole('dialog', { name: 'Настроить жребий' })).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Комнаты' })).toBeVisible()
  expect(trigger).toHaveFocus()
})
