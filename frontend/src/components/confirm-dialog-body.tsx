import { useMutation } from '@tanstack/react-query'

import { FormError } from '@/components/auth-layout'
import type { ConfirmDialogProps } from '@/components/confirm-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** The dialog behind `ConfirmDialog`, loaded the first time one opens. */
export default function ConfirmDialogBody({
  open,
  onOpenChange,
  title,
  description,
  action,
  onConfirm,
}: ConfirmDialogProps) {
  const run = useMutation({ mutationFn: async () => onConfirm(), onSuccess: () => onOpenChange(false) })
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (run.isPending) return
        onOpenChange(next)
        if (!next) run.reset()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={run.error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={run.isPending} onClick={() => run.mutate()}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
