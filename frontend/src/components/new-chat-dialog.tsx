import { Combobox } from '@base-ui/react/combobox'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Profile } from 'backend/protocol'
import { cn } from 'cn'
import { SearchIcon } from 'lucide-react'
import { useState, type ReactElement } from 'react'

import { FormError } from '@/components/auth-layout'
import { Avatar } from '@/components/avatar'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useDebounced } from '@/hooks/use-debounced'
import { openDm, searchUsersQuery } from '@/lib/api'

/** Finds people by name or username as you type and opens the DM. `trigger` is the element that opens the dialog. */
export function NewChatDialog({ trigger }: { trigger: ReactElement }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const navigate = useNavigate()

  const q = useDebounced(search.trim().toLowerCase(), 150)
  const results = useQuery({ ...searchUsersQuery(q), enabled: q !== '', placeholderData: keepPreviousData })
  const people = search.trim() && q ? (results.data ?? []) : []

  const start = useMutation({
    mutationFn: (username: string) => openDm(username),
    onSuccess: async ({ chatId }) => {
      setOpen(false)
      await navigate({ to: '/c/$chatId', params: { chatId } })
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setSearch('')
          start.reset()
        }
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="gap-5 rounded-[22px] border-2 border-ink p-7 shadow-[6px_6px_0_var(--color-ink)] ring-0 sm:max-w-[420px]">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-[28px] leading-8 font-extrabold tracking-[-0.03em]">New chat</DialogTitle>
          <DialogDescription className="text-[15px]">Who do you want to talk to?</DialogDescription>
        </div>

        {/* Base UI's combobox, rendered inline: the server filters, so `filter` is off. */}
        <Combobox.Root
          inline
          open={open}
          items={people}
          filter={null}
          autoHighlight
          inputValue={search}
          onInputValueChange={setSearch}
          itemToStringLabel={(p: Profile) => p.name}
          onValueChange={(p: Profile | null) => p && start.mutate(p.username)}
        >
          <div className="flex h-[52px] items-center gap-2.5 rounded-[14px] border-2 border-wash bg-wash px-4 transition-colors focus-within:border-ink focus-within:bg-paper">
            <SearchIcon className="size-4 text-muted-foreground" strokeWidth={2.5} aria-hidden="true" />
            <Combobox.Input
              aria-label="Name or username"
              placeholder="Name or username"
              autoCapitalize="none"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="-mx-2 flex min-h-[200px] flex-col">
            <Combobox.List aria-label="People" className="flex flex-col gap-0.5">
              {(p: Profile) => (
                <Combobox.Item
                  key={p.id}
                  value={p}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-[14px] p-2 data-highlighted:bg-wash',
                    start.isPending && start.variables === p.username && 'opacity-60'
                  )}
                >
                  <Avatar id={p.id} name={p.name} className="size-10 text-base" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] leading-[18px] font-semibold">{p.name}</span>
                    <span className="truncate text-sm leading-[18px] text-muted-foreground">@{p.username}</span>
                  </div>
                </Combobox.Item>
              )}
            </Combobox.List>
            <Combobox.Empty className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground empty:hidden">
              {!search.trim()
                ? 'Search by name or @username.'
                : results.isFetching || search.trim().toLowerCase() !== q
                  ? 'Looking…'
                  : `No one matches “${search.trim()}”.`}
            </Combobox.Empty>
          </div>
        </Combobox.Root>

        <FormError error={start.error} />
      </DialogContent>
    </Dialog>
  )
}
