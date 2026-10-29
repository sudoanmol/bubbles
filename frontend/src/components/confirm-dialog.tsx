import { lazy, Suspense, useState, type ReactNode } from 'react'

// The dialog loads the first time one opens, so it stays out of the chat's first load.
const ConfirmDialogBody = lazy(() => import('@/components/confirm-dialog-body'))

export type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  /** The destructive button's label, naming what it does ("Delete for everyone"). */
  action: string
  onConfirm: () => unknown
}

/**
 * Asks before a destructive action, in place of the browser's confirm(). `onConfirm` may be async: the dialog stays
 * open while it runs and shows its error if it fails, and closes once it succeeds.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Stays mounted once loaded, so it can animate closed.
  const [loaded, setLoaded] = useState(false)
  if (props.open && !loaded) setLoaded(true)
  if (!loaded) return null
  return (
    <Suspense>
      <ConfirmDialogBody {...props} />
    </Suspense>
  )
}
