import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { Profile } from 'backend/protocol'
import { useState } from 'react'

import { Avatar } from '@/components/avatar'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { useDebounced } from '@/hooks/use-debounced'
import { searchUsersQuery } from '@/lib/api'
import { firstName } from '@/lib/group-events'

/**
 * Picks several people by name or username: picked ones become chips in the field, and each result shows whether it's
 * picked (Paper: "New group"). `exclude` hides people who can't be picked, such as current members.
 */
export function PeoplePicker({
  value,
  onValueChange,
  exclude,
}: {
  value: Profile[]
  onValueChange: (people: Profile[]) => void
  exclude?: Set<string>
}) {
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim().toLowerCase(), 150)
  const results = useQuery({ ...searchUsersQuery(q), enabled: q !== '', placeholderData: keepPreviousData })
  const people = (search.trim() && q ? (results.data ?? []) : []).filter((p) => !exclude?.has(p.id))

  // Rendered inline (no popup) and filtered by the server, so `filter` is off.
  return (
    <Combobox
      inline
      multiple
      autoHighlight
      items={people}
      filter={null}
      value={value}
      onValueChange={(next: Profile[]) => {
        onValueChange(next)
        setSearch('')
      }}
      inputValue={search}
      onInputValueChange={setSearch}
      itemToStringLabel={(p: Profile) => p.name}
      isItemEqualToValue={(a: Profile, b: Profile) => a.id === b.id}
    >
      <ComboboxChips aria-label={value.length ? 'Picked people' : undefined}>
        {value.map((p) => (
          <ComboboxChip key={p.id} aria-label={p.name}>
            <Avatar id={p.id} image={p.image} className="size-6" />
            {firstName(p.name)}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          aria-label="Name or username"
          placeholder={value.length ? '' : 'Name or username'}
          autoCapitalize="none"
          spellCheck={false}
        />
      </ComboboxChips>
      <div className="-mx-2 flex min-h-[132px] flex-col">
        <ComboboxList aria-label="People" className="max-h-72 p-0">
          {(p: Profile) => (
            <ComboboxItem key={p.id} value={p}>
              <Avatar id={p.id} image={p.image} className="size-10" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[15px] leading-[18px] font-semibold">{p.name}</span>
                <span className="truncate text-sm leading-[18px] text-muted-foreground">@{p.username}</span>
              </div>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty className="flex flex-1 items-center empty:hidden">
          {!search.trim()
            ? 'Search by name or @username.'
            : results.isFetching || search.trim().toLowerCase() !== q
              ? 'Looking…'
              : `No one matches “${search.trim()}”.`}
        </ComboboxEmpty>
      </div>
    </Combobox>
  )
}
