import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'

import { FormError } from '@/components/auth-layout'
import { TextField } from '@/components/text-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { openDm } from '@/lib/api'

/** Asks for a username and opens the DM. `trigger` is the element that opens the dialog. */
export function NewChatDialog({ trigger }: { trigger: ReactElement }) {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const navigate = useNavigate()

  const start = useMutation({
    mutationFn: () => openDm(username.trim().replace(/^@/, '')),
    onSuccess: async ({ chatId }) => {
      setOpen(false)
      setUsername('')
      await navigate({ to: '/c/$chatId', params: { chatId } })
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) start.reset()
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="gap-6 rounded-[22px] border-2 border-ink p-7 shadow-[6px_6px_0_var(--color-ink)] ring-0 sm:max-w-[420px]">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-[28px] leading-8 font-extrabold tracking-[-0.03em]">New chat</DialogTitle>
          <DialogDescription className="text-[15px]">Who do you want to talk to?</DialogDescription>
        </div>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            start.mutate()
          }}
        >
          <TextField
            label="Username"
            placeholder="jane.doe"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            leading={<span className="text-lg font-semibold text-muted-foreground">@</span>}
          />
          <FormError error={start.error} />
          <Button type="submit" disabled={!username.trim() || start.isPending}>
            {start.isPending ? 'Opening…' : 'Start chatting'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
