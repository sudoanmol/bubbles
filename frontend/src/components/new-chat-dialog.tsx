import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MAX_GROUP_NAME, type Profile } from 'backend/protocol'
import { cn } from 'cn'
import { ArrowLeftIcon, SearchIcon, UsersIcon } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/auth-layout'
import { Avatar } from '@/components/avatar'
import { PeoplePicker } from '@/components/people-picker'
import { Button } from '@/components/ui/button'
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useDebounced } from '@/hooks/use-debounced'
import { createGroup, inboxQuery, openDm, searchUsersQuery } from '@/lib/api'

/**
 * Finds people by name or username as you type and opens the DM, or switches to picking several people and naming a
 * group (Paper: "New group"). Loaded on demand by `NewChat`.
 */
export default function NewChatDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [group, setGroup] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const opened = async ({ chatId }: { chatId: string }) => {
    // A new chat is in the inbox before anyone writes in it (a group's arrives with its first entries).
    void queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey })
    onOpenChange(false)
    await navigate({ to: '/c/$chatId', params: { chatId } })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setGroup(false)
      }}
    >
      {/* Keyed so each mode starts empty. */}
      <DialogContent key={String(group)}>
        {group ? (
          <NewGroup onBack={() => setGroup(false)} onCreated={opened} />
        ) : (
          <NewDm onGroup={() => setGroup(true)} onOpened={opened} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function NewDm({ onGroup, onOpened }: { onGroup: () => void; onOpened: (chat: { chatId: string }) => Promise<void> }) {
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim().toLowerCase(), 150)
  const results = useQuery({ ...searchUsersQuery(q), enabled: q !== '', placeholderData: keepPreviousData })
  const people = search.trim() && q ? (results.data ?? []) : []
  const start = useMutation({ mutationFn: (username: string) => openDm(username), onSuccess: onOpened })

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <DialogTitle>New chat</DialogTitle>
        <DialogDescription className="text-[15px]">Who do you want to talk to?</DialogDescription>
      </div>

      {/* Rendered inline (no popup) and filtered by the server, so `filter` is off. */}
      <Combobox
        inline
        items={people}
        filter={null}
        autoHighlight
        inputValue={search}
        onInputValueChange={setSearch}
        itemToStringLabel={(p: Profile) => p.name}
        onValueChange={(p: Profile | null) => p && start.mutate(p.username)}
      >
        <ComboboxInput
          aria-label="Name or username"
          placeholder="Name or username"
          autoCapitalize="none"
          spellCheck={false}
          showTrigger={false}
        >
          <SearchIcon className="order-first ml-4 size-4 shrink-0 text-muted-foreground" strokeWidth={2.5} />
        </ComboboxInput>
        <div className="-mx-2 flex min-h-[200px] flex-col gap-0.5">
          {!search.trim() && (
            <button
              type="button"
              onClick={onGroup}
              className="flex items-center gap-3 rounded-[14px] p-2 text-left transition-colors hover:bg-wash"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border-2 border-ink bg-sun shadow-[2px_2px_0_var(--color-ink)]">
                <UsersIcon className="size-[18px]" strokeWidth={2.5} />
              </span>
              <span className="flex flex-col">
                <span className="text-[15px] leading-[18px] font-semibold">New group</span>
                <span className="text-sm leading-[18px] text-muted-foreground">Up to 256 people</span>
              </span>
            </button>
          )}
          <ComboboxList aria-label="People" className="max-h-none p-0">
            {(p: Profile) => (
              <ComboboxItem
                key={p.id}
                value={p}
                className={cn('pr-2 after:hidden', start.isPending && start.variables === p.username && 'opacity-60')}
              >
                <Avatar id={p.id} name={p.name} className="size-10 rounded-full text-base" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[15px] leading-[18px] font-semibold">{p.name}</span>
                  <span className="truncate text-sm leading-[18px] text-muted-foreground">@{p.username}</span>
                </div>
              </ComboboxItem>
            )}
          </ComboboxList>
          {search.trim() && (
            <ComboboxEmpty className="flex flex-1 items-center empty:hidden">
              {results.isFetching || search.trim().toLowerCase() !== q
                ? 'Looking…'
                : `No one matches “${search.trim()}”.`}
            </ComboboxEmpty>
          )}
        </div>
      </Combobox>

      <FormError error={start.error} />
    </>
  )
}

function NewGroup({
  onBack,
  onCreated,
}: {
  onBack: () => void
  onCreated: (chat: { chatId: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [people, setPeople] = useState<Profile[]>([])
  const create = useMutation({
    mutationFn: () =>
      createGroup(
        name.trim(),
        people.map((p) => p.id)
      ),
    onSuccess: onCreated,
  })

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <div className="flex items-center gap-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          className="-ml-2 text-ink"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-5" strokeWidth={2.5} />
        </Button>
        <DialogTitle>New group</DialogTitle>
      </div>
      <Input
        aria-label="Group name"
        placeholder="Group name"
        maxLength={MAX_GROUP_NAME}
        value={name}
        onChange={(e) => setName(e.target.value)}
        ref={(el) => el?.focus()}
      />
      <PeoplePicker value={people} onValueChange={setPeople} />
      <FormError error={create.error} />
      <Button type="submit" variant="sun" disabled={!name.trim() || !people.length || create.isPending}>
        {people.length ? `Create group · ${people.length + 1} people` : 'Create group'}
      </Button>
    </form>
  )
}
