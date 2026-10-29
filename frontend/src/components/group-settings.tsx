import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MAX_GROUP_NAME, type Chat, type Member, type Profile } from 'backend/protocol'
import {
  ArrowLeftIcon,
  EllipsisIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  ShieldOffIcon,
  TrashIcon,
  UserMinusIcon,
} from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/auth-layout'
import { Avatar } from '@/components/avatar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PeoplePicker } from '@/components/people-picker'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { changeGroup, type GroupChange } from '@/lib/api'

type Confirming = { t: 'remove'; member: Member } | { t: 'leave' } | { t: 'delete' } | null

/**
 * A group's name, members and roles, and leaving or deleting it (Paper: "Group settings" and "Groups: receipts,
 * leaving, deleting"). Anyone in the group renames it or leaves; admins add, remove, promote and delete. Loaded on
 * demand by the chat header.
 */
export default function GroupSettings({
  chat,
  uid,
  open,
  onOpenChange,
}: {
  chat: Chat
  uid: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [view, setView] = useState<'main' | 'add' | 'handover'>('main')
  const [confirming, setConfirming] = useState<Confirming>(null)
  const change = useMutation({ mutationFn: (c: GroupChange) => changeGroup(queryClient, chat.id, c) })
  const run = (c: GroupChange, after?: () => void) => change.mutate(c, { onSuccess: after })
  const close = () => onOpenChange(false)

  const members = chat.members
    .filter((m) => m.left === null)
    .sort(
      (a, b) => Number(b.id === uid) - Number(a.id === uid) || Number(b.role === 'admin') - Number(a.role === 'admin')
    )
  const me = members.find((m) => m.id === uid)
  const admin = me?.role === 'admin'
  // The only admin hands over before leaving, so a group with people in it always has an admin.
  const onlyAdmin = admin && members.length > 1 && !members.some((m) => m.id !== uid && m.role === 'admin')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setView('main')
          change.reset()
        }
      }}
    >
      <DialogContent>
        {view === 'add' ? (
          <AddPeople
            members={members}
            pending={change.isPending}
            error={change.error}
            onBack={() => setView('main')}
            onAdd={(ids) => run({ t: 'add', ids }, () => setView('main'))}
          />
        ) : view === 'handover' ? (
          <Handover
            group={chat.group?.name ?? ''}
            others={members.filter((m) => m.id !== uid)}
            pending={change.isPending}
            error={change.error}
            onCancel={() => setView('main')}
            onLeave={(successor) => run({ t: 'leave', successor }, close)}
          />
        ) : (
          <>
            <Identity
              chat={chat}
              count={members.length}
              canRename={me !== undefined}
              onRename={(name) => run({ t: 'rename', name })}
            />
            <div className="-mx-2 flex flex-col gap-0.5">
              <span className="px-2 pb-1.5 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Members
              </span>
              {admin && (
                <button
                  type="button"
                  onClick={() => setView('add')}
                  className="flex items-center gap-3 rounded-[14px] p-2 text-left transition-colors hover:bg-wash"
                >
                  <span className="flex size-10 items-center justify-center rounded-full border-2 border-dashed border-[#cfcfcf]">
                    <PlusIcon className="size-[18px]" strokeWidth={2.75} />
                  </span>
                  <span className="text-[15px] font-semibold">Add people</span>
                </button>
              )}
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-[14px] p-2">
                  <Avatar id={m.id} name={m.name} className="size-10 rounded-full text-base" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] leading-[18px] font-semibold">
                      {m.name} {m.id === uid && <span className="font-normal text-muted-foreground">(you)</span>}
                    </span>
                    <span className="truncate text-sm leading-[18px] text-muted-foreground">@{m.username}</span>
                  </div>
                  {m.role === 'admin' && (
                    <span className="rounded-full border-[1.5px] border-ink bg-sun px-[9px] py-0.5 text-xs font-bold">
                      Admin
                    </span>
                  )}
                  {/* A fixed slot, so the badges line up whether or not a row has a menu. */}
                  <span className="flex w-8 shrink-0 justify-center">
                    {admin && m.id !== uid && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-xs" className="size-8 text-ink" />}
                          aria-label={`Manage ${m.name}`}
                        >
                          <EllipsisIcon className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onClick={() => run({ t: 'admin', id: m.id, admin: m.role !== 'admin' })}>
                            {m.role === 'admin' ? <ShieldOffIcon /> : <ShieldIcon />}
                            {m.role === 'admin' ? 'Remove admin' : 'Make admin'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setConfirming({ t: 'remove', member: m })}
                          >
                            <UserMinusIcon />
                            Remove from group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <FormError error={change.error} />
            {me && (
              <div className="flex flex-col gap-2.5">
                <Button
                  variant="outline"
                  className="h-12 text-[15px] text-danger"
                  onClick={() => (onlyAdmin ? setView('handover') : setConfirming({ t: 'leave' }))}
                >
                  <LogOutIcon className="size-4" strokeWidth={2.5} />
                  Leave group
                </Button>
                {admin && (
                  <Button
                    variant="outline"
                    className="h-12 text-[15px] text-danger"
                    onClick={() => setConfirming({ t: 'delete' })}
                  >
                    <TrashIcon className="size-4" strokeWidth={2.5} />
                    Delete group
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && setConfirming(null)}
        {...(confirming?.t === 'remove'
          ? {
              title: `Remove ${confirming.member.name}?`,
              description: `They stop getting messages from ${chat.group?.name} right away, and keep what they've seen.`,
              action: 'Remove',
              onConfirm: () => changeGroup(queryClient, chat.id, { t: 'remove', id: confirming.member.id }),
            }
          : confirming?.t === 'delete'
            ? {
                title: `Delete ${chat.group?.name}?`,
                description:
                  'Everyone is removed and no one can send to it again. Each member keeps the history on their devices until they delete the chat.',
                action: 'Delete for everyone',
                onConfirm: async () => {
                  await changeGroup(queryClient, chat.id, { t: 'delete' })
                  close()
                },
              }
            : {
                title: `Leave ${chat.group?.name}?`,
                description: "You'll stop getting its messages. You can still read what's already here.",
                action: 'Leave group',
                onConfirm: async () => {
                  await changeGroup(queryClient, chat.id, { t: 'leave' })
                  close()
                },
              })}
      />
    </Dialog>
  )
}

/** The group's avatar, its name (with a pencil to rename it) and how many are in it. */
function Identity({
  chat,
  count,
  canRename,
  onRename,
}: {
  chat: Chat
  count: number
  canRename: boolean
  onRename: (name: string) => void
}) {
  const name = chat.group?.name ?? ''
  const [editing, setEditing] = useState<string | null>(null)
  const save = () => {
    const next = editing?.trim()
    if (next && next !== name) onRename(next)
    setEditing(null)
  }
  return (
    <div className="flex flex-col items-center gap-3 pt-1">
      <Avatar id={chat.id} name={name} className="size-[72px] rounded-full text-[28px]" />
      {editing !== null ? (
        <Input
          aria-label="Group name"
          maxLength={MAX_GROUP_NAME}
          value={editing}
          ref={(el) => el?.focus()}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(null)
            }
          }}
          className="text-center text-lg font-bold"
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <DialogTitle className="text-[26px] leading-[30px]">{name}</DialogTitle>
          {canRename && (
            <Button variant="ghost" size="icon-xs" aria-label="Rename group" onClick={() => setEditing(name)}>
              <PencilIcon className="size-4" strokeWidth={2.25} />
            </Button>
          )}
        </div>
      )}
      <DialogDescription className="-mt-1.5">{count === 1 ? '1 member' : `${count} members`}</DialogDescription>
    </div>
  )
}

function AddPeople({
  members,
  pending,
  error,
  onBack,
  onAdd,
}: {
  members: Member[]
  pending: boolean
  error: Error | null
  onBack: () => void
  onAdd: (ids: string[]) => void
}) {
  const [people, setPeople] = useState<Profile[]>([])
  return (
    <>
      <div className="flex items-center gap-2.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back" className="-ml-2 text-ink" onClick={onBack}>
          <ArrowLeftIcon className="size-5" strokeWidth={2.5} />
        </Button>
        <DialogTitle>Add people</DialogTitle>
      </div>
      <PeoplePicker value={people} onValueChange={setPeople} exclude={new Set(members.map((m) => m.id))} />
      <FormError error={error} />
      <Button variant="sun" disabled={!people.length || pending} onClick={() => onAdd(people.map((p) => p.id))}>
        {people.length === 1 ? 'Add 1 person' : people.length ? `Add ${people.length} people` : 'Add people'}
      </Button>
    </>
  )
}

/** The only admin picks who takes over before leaving (Paper: "Groups: receipts, leaving, deleting"). */
function Handover({
  group,
  others,
  pending,
  error,
  onCancel,
  onLeave,
}: {
  group: string
  others: Member[]
  pending: boolean
  error: Error | null
  onCancel: () => void
  onLeave: (successor: string) => void
}) {
  const [successor, setSuccessor] = useState(others[0]?.id)
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <DialogTitle className="text-[26px] leading-[30px]">Choose a new admin</DialogTitle>
        <DialogDescription className="text-[15px] leading-5">
          You're the only admin of {group}. Pick someone to take over before you leave.
        </DialogDescription>
      </div>
      <RadioGroup value={successor} onValueChange={(v) => setSuccessor(v as string)} className="-mx-2 gap-0.5">
        {others.map((m) => (
          <label
            key={m.id}
            className="flex cursor-pointer items-center gap-3 rounded-[14px] p-2 transition-colors has-data-checked:bg-wash"
          >
            <Avatar id={m.id} name={m.name} className="size-10 rounded-full text-base" />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{m.name}</span>
            <RadioGroupItem value={m.id} className="mr-1" />
          </label>
        ))}
      </RadioGroup>
      <FormError error={error} />
      <div className="flex gap-2.5">
        <Button variant="outline" className="h-12 flex-1 text-[15px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          className="h-12 flex-[1.6] text-[15px]"
          disabled={!successor || pending}
          onClick={() => successor && onLeave(successor)}
        >
          Make admin and leave
        </Button>
      </div>
    </>
  )
}
