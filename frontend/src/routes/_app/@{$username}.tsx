import { createFileRoute, redirect } from '@tanstack/react-router'

import { ErrorState } from '@/components/error-state'
import { openDm } from '@/lib/api'

/** `/@username` opens (or creates) the DM, then lands on its canonical `/c/$chatId` URL. */
export const Route = createFileRoute('/_app/@{$username}')({
  beforeLoad: async ({ params }) => {
    const { chatId } = await openDm(params.username)
    throw redirect({ to: '/c/$chatId', params: { chatId }, replace: true })
  },
  errorComponent: ErrorState,
})
