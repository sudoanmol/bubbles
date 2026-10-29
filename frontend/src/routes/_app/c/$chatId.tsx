import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { canEdit, groupEvent, type Member, type Read, type Message as Stored, type System } from 'backend/protocol'
import { cn } from 'cn'
import { isSameDay } from 'date-fns'
import { BanIcon, ClockIcon, RotateCcwIcon } from 'lucide-react'
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { Avatar } from '@/components/avatar'
import { ChatHeader } from '@/components/chat-header'
import { Composer, type ComposerMode } from '@/components/composer'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState } from '@/components/error-state'
import { MessageActions, Reactions } from '@/components/message-actions'
import { ReadBy } from '@/components/read-by'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter, MessageGroup } from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller'
import { useNow } from '@/hooks/use-now'
import { api, chatQuery, hydrateChat, messagesQuery, outboxQuery, PAGE, upsertMessages } from '@/lib/api'
import { describe, firstName } from '@/lib/group-events'
import { withPending, type LocalMessage } from '@/lib/log'
import { discardMessage, markRead, patchMessage, retryMessage, useConnection } from '@/lib/socket'
import { cachedOlder, checkAccount, currentUid, saveMessages } from '@/lib/store'
import { formatDay, formatShort, formatTime } from '@/lib/time'
import { useTyping } from '@/lib/typing'

// Only someone out of a group sees this bar, so it loads on demand.
const LeftGroupBar = lazy(() => import('@/components/left-group-bar'))

export const Route = createFileRoute('/_app/c/$chatId')({
  // The local copy renders first; the network only blocks a chat this device has never opened.
  loader: async ({ context: { queryClient }, params: { chatId } }) => {
    await hydrateChat(queryClient, chatId)
    await queryClient.query({ ...chatQuery(chatId), staleTime: 'static' })
  },
  component: ChatView,
  errorComponent: ErrorState,
})

function ChatView() {
  const { chatId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const { data: chat } = useSuspenseQuery(chatQuery(chatId))
  const [mode, setMode] = useState<ComposerMode>(null)
  // A reply or edit started in another chat doesn't follow you here.
  const active = mode?.message.chat === chatId ? mode : null
  const names = new Map(chat.members.map((m) => [m.id, m.id === user.id ? 'You' : firstName(m.name)]))
  const title = chat.group?.name ?? chat.members.find((m) => m.id !== user.id)?.name ?? user.name
  // Out of a group (left, removed, or it was deleted): the history stays, the composer goes.
  const inChat = !chat.group || chat.members.some((m) => m.id === user.id && m.left === null)

  // Keyed so scroll position, load state and the draft reset when switching chats.
  return (
    <Fragment key={chatId}>
      <ChatHeader chat={chat} uid={user.id} />
      {/* autoScroll keeps the view pinned to the newest message while you are at the bottom, through layout
          shifts (fonts, older pages, new messages); scrolling up releases it. */}
      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        <MessageList
          chatId={chatId}
          uid={user.id}
          names={names}
          members={chat.members}
          group={chat.group !== null}
          reads={chat.reads}
          readOnly={!inChat}
          onMode={setMode}
        />
      </MessageScrollerProvider>
      {inChat ? (
        <Composer
          chatId={chatId}
          uid={user.id}
          placeholder={`Message ${chat.group ? title : firstName(title)}`}
          names={names}
          mode={active}
          onMode={setMode}
        />
      ) : (
        <Suspense>
          <LeftGroupBar chat={chat} uid={user.id} />
        </Suspense>
      )}
    </Fragment>
  )
}

function MessageList({
  chatId,
  uid,
  names,
  members,
  group,
  reads,
  readOnly,
  onMode,
}: {
  chatId: string
  uid: string
  names: Map<string, string>
  members: Member[]
  group: boolean
  reads: Record<string, Read>
  /** Out of the group: the history stays, but you can't act on it. */
  readOnly: boolean
  onMode: (mode: ComposerMode) => void
}) {
  const queryClient = useQueryClient()
  const { data: log } = useSuspenseQuery(messagesQuery(chatId))
  const { data: outbox } = useSuspenseQuery(outboxQuery)
  const messages = withPending(chatId, log, outbox, uid)
  const lastMine = messages.findLast((m) => m.kind === 'text' && m.sender === uid && !m.deleted)
  const [deleting, setDeleting] = useState<LocalMessage | null>(null)
  const { scrollToMessage } = useMessageScroller()
  const typing = (useTyping()[chatId] ?? []).filter((id) => id !== uid)

  // The clock the edit window is checked against; Edit disappears within half a minute of the window closing.
  const now = useNow(30_000)

  // An open chat in a visible tab is read up to its newest entry; sent again on reconnect (the socket forgets it).
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState === 'visible')
  const connection = useConnection()
  const end = log.at(-1)?.seq
  useEffect(() => {
    if (visible && end) markRead(queryClient, chatId, end)
  }, [queryClient, chatId, end, visible, connection])

  // How far each of the others has read: their receipt, or their own newest message, whichever is later.
  const others = members.filter((m) => m.id !== uid)
  const readOf = new Map<string, Read>(
    others.map((m) => {
      const theirs = messages.findLast((x) => x.sender === m.id && x.kind === 'text' && x.seq !== null)
      const read = reads[m.id] ?? { seq: 0, ts: 0 }
      return [m.id, theirs?.seq && theirs.seq > read.seq ? { seq: theirs.seq, ts: theirs.ts } : read]
    })
  )
  /** Under your newest message: who has read it. A DM says when; a group names them (Paper: "Groups: …"). */
  const receipt = (m: LocalMessage): ReactNode => {
    if (m.seq === null) return null
    // Whoever was in the chat when it was sent, even if they've left since.
    const present = others.filter((o) => o.left === null || o.left > m.seq!)
    const readers = present.filter((o) => (readOf.get(o.id)?.seq ?? 0) >= m.seq!)
    if (!readers.length) return null
    if (!group) return `Read ${formatShort(readOf.get(readers[0].id)!.ts)}`
    return (
      <ReadBy
        readers={readers.map((r) => ({ ...r, ts: readOf.get(r.id)!.ts }))}
        waiting={present.filter((o) => !readers.includes(o))}
      />
    )
  }
  const byId = new Map(members.map((m) => [m.id, m]))

  return (
    <MessageScroller className="flex-1">
      <MessageScrollerViewport preserveScrollOnPrepend aria-label="Messages">
        <MessageScrollerContent className="justify-end gap-1.5 p-4 md:p-7">
          <LoadOlder chatId={chatId} messages={log} />
          {messages.length === 0 && (
            <p className="m-auto text-center text-sm text-muted-foreground">No messages yet. Say hi!</p>
          )}
          {runs(messages).map((run, r, all) => {
            const first = run[0]
            const mine = first.sender === uid
            const prev = all[r - 1]?.at(-1)
            const apart = !prev || apartInTime(prev, first)
            const sender = byId.get(first.sender)
            const labelled = group && !mine && first.kind === 'text'
            return (
              <Fragment key={first.cid}>
                {/* Paper: "Time separators". */}
                {apart && (
                  <MessageScrollerItem className="mt-4 mb-2.5 self-center text-xs text-muted-foreground first:mt-0">
                    <span className="font-semibold tracking-[0.08em] uppercase">{formatDay(first.ts)}</span>
                    <span className="font-medium"> {formatTime(first.ts)}</span>
                  </MessageScrollerItem>
                )}
                {first.kind === 'system' ? (
                  // Paper: "Group chat". A run of group events: one centered line each.
                  <MessageScrollerItem className={cn('flex flex-col items-center gap-1 py-1', !apart && 'mt-2')}>
                    {run.map((m) => (
                      <p key={m.cid} className="text-center text-[13px] leading-[18px] text-muted-foreground">
                        {describe(groupEvent(m as System), uid, (name) => (
                          <span className="font-semibold text-ink">{name}</span>
                        )).map((part, i) => (
                          <Fragment key={i}>{part}</Fragment>
                        ))}
                      </p>
                    ))}
                  </MessageScrollerItem>
                ) : (
                  <MessageGroup className={cn(!apart && 'mt-2')}>
                    {/* In a group, their name heads each run of their messages. */}
                    {labelled && (
                      <span className="-mb-0.5 pl-[50px] text-[13px] leading-4 font-semibold text-muted-foreground">
                        {sender?.name ? firstName(sender.name) : 'Someone'}
                      </span>
                    )}
                    {run.map((m, i) => {
                      const react = (emoji: string | null) => patchMessage(queryClient, uid, m, { t: 'react', emoji })
                      const quoted = m.reply && messages.find((q) => q.seq === m.reply!.seq)
                      return (
                        <MessageScrollerItem key={m.cid} messageId={m.cid}>
                          <Message align={mine ? 'end' : 'start'}>
                            {/* ...and their small avatar sits beside its last bubble. */}
                            {labelled &&
                              (i === run.length - 1 ? (
                                <Avatar
                                  id={first.sender}
                                  name={sender?.name ?? '?'}
                                  className="size-7 self-end rounded-full text-xs"
                                />
                              ) : (
                                <span className="w-7 shrink-0" />
                              ))}
                            <MessageContent>
                              {m.deleted ? (
                                <div
                                  className={cn(
                                    'flex w-fit items-center gap-2 rounded-bubble border-[1.5px] border-dashed border-[#c9c9c9] px-4 py-[11px] text-[15px] leading-[22px] text-muted-foreground italic group-data-[align=end]/message:self-end',
                                    corners(mine, i === 0, i === run.length - 1)
                                  )}
                                >
                                  <BanIcon className="size-[15px] shrink-0" strokeWidth={2.25} aria-hidden="true" />
                                  {mine
                                    ? 'You deleted this message'
                                    : `${names.get(m.sender) ?? 'They'} deleted this message`}
                                </div>
                              ) : (
                                <Bubble variant={mine ? 'outgoing' : 'incoming'}>
                                  <BubbleContent
                                    className={cn(corners(mine, i === 0, i === run.length - 1), m.reply && 'p-2 pb-3')}
                                  >
                                    {m.reply && (
                                      <button
                                        type="button"
                                        onClick={() => quoted && scrollToMessage(quoted.cid, { behavior: 'smooth' })}
                                        className={cn(
                                          'mb-2 flex w-full min-w-0 flex-col gap-0.5 rounded-[6px_14px_14px_6px] border-l-[3px] py-1.5 pr-3 pl-2.5 text-left',
                                          mine ? 'border-paper bg-ink/18' : 'border-cobalt bg-wash'
                                        )}
                                      >
                                        <span
                                          className={cn(
                                            'text-[13px] leading-4 font-bold',
                                            mine ? 'text-paper' : 'text-cobalt'
                                          )}
                                        >
                                          {names.get(m.reply.sender) ?? 'Someone'}
                                        </span>
                                        <span
                                          className={cn(
                                            'line-clamp-2 text-sm leading-[18px]',
                                            mine ? 'text-paper/80' : 'text-muted-foreground'
                                          )}
                                        >
                                          {m.reply.body}
                                        </span>
                                      </button>
                                    )}
                                    {m.reply ? <div className="px-2">{m.body}</div> : m.body}
                                  </BubbleContent>
                                  {m.failed && (
                                    <span
                                      aria-hidden="true"
                                      className="absolute top-1/2 right-full mr-2 flex size-[22px] -translate-y-1/2 items-center justify-center rounded-full bg-danger text-sm leading-4 font-extrabold text-paper"
                                    >
                                      !
                                    </span>
                                  )}
                                  {m.seq !== null && !readOnly && (
                                    <MessageActions
                                      message={m}
                                      mine={mine}
                                      uid={uid}
                                      editable={canEdit(m, uid, now)}
                                      onReact={react}
                                      onReply={() => onMode({ t: 'reply', message: m })}
                                      onEdit={() => onMode({ t: 'edit', message: m })}
                                      onDelete={() => setDeleting(m)}
                                    />
                                  )}
                                </Bubble>
                              )}
                              {!m.deleted && (
                                <Reactions message={m} mine={mine} uid={uid} onReact={readOnly ? undefined : react} />
                              )}
                              {(m === lastMine || m.failed) && <Status message={m} read={receipt(m)} />}
                              {m !== lastMine && !m.failed && !m.deleted && m.edited && (
                                <MessageFooter>Edited</MessageFooter>
                              )}
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      )
                    })}
                  </MessageGroup>
                )}
              </Fragment>
            )
          })}
          {/* Paper: "Typing & presence". */}
          {typing.length > 0 && (
            <MessageScrollerItem className="mt-2 flex items-end gap-2 self-start">
              {group && (
                <Avatar
                  id={typing[0]}
                  name={byId.get(typing[0])?.name ?? '?'}
                  className="size-7 rounded-full text-xs"
                />
              )}
              <output
                aria-label={`${typing.map((id) => names.get(id) ?? 'Someone').join(', ')} typing`}
                className="flex gap-[5px] rounded-bubble rounded-bl-[6px] border-[1.5px] border-line bg-paper px-4 py-3.5"
              >
                {['bg-gum', 'bg-sun [animation-delay:150ms]', 'bg-cobalt [animation-delay:300ms]'].map((dot) => (
                  <span key={dot} className={cn('size-2 rounded-full motion-safe:animate-typing', dot)} />
                ))}
              </output>
            </MessageScrollerItem>
          )}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this message?"
        description="It's removed for everyone in the chat. They'll see that you deleted a message."
        action="Delete for everyone"
        onConfirm={() => deleting && patchMessage(queryClient, uid, deleting, { t: 'delete' })}
      />
    </MessageScroller>
  )
}

const HOUR = 60 * 60_000

/** A new day, or an hour's quiet: the chat shows the time between them, as iMessage does. */
const apartInTime = (a: LocalMessage, b: LocalMessage) => !isSameDay(a.ts, b.ts) || b.ts - a.ts > HOUR

function onVisibility(listener: () => void) {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

/**
 * Consecutive messages from one sender with no time separator between them, so they stack as a group. Group events
 * in a row, whoever made them, form one run too.
 */
function runs(messages: LocalMessage[]) {
  const out: LocalMessage[][] = []
  for (const m of messages) {
    const run = out.at(-1)
    const last = run?.at(-1)
    const together = last?.kind === m.kind && (m.kind === 'system' || last.sender === m.sender)
    if (run && last && together && !apartInTime(last, m)) run.push(m)
    else out.push([m])
  }
  return out
}

/** Corners that touch a neighbour in the same group shrink; a lone bubble keeps a tail at the bottom. */
function corners(mine: boolean, first: boolean, last: boolean) {
  const top = !first && (mine ? 'rounded-tr-[6px]' : 'rounded-tl-[6px]')
  const bottom = (!last || first) && (mine ? 'rounded-br-[6px]' : 'rounded-bl-[6px]')
  return cn(top, bottom)
}

/** Delivery state under a message of yours (Paper: "Offline & delivery"). */
function Status({ message, read }: { message: LocalMessage; read: ReactNode }) {
  const queryClient = useQueryClient()
  const connection = useConnection()
  if (message.failed)
    return (
      <MessageFooter className="gap-2.5">
        <span className="font-semibold text-danger">Not sent</span>
        <button
          type="button"
          onClick={() => retryMessage(queryClient, message)}
          className="flex items-center gap-1 rounded-full border-[1.5px] border-ink bg-paper px-2.5 py-[3px] font-semibold text-ink transition-colors hover:bg-sun"
        >
          <RotateCcwIcon className="size-3" strokeWidth={2.75} aria-hidden="true" />
          Retry
        </button>
        <button
          type="button"
          onClick={() => discardMessage(queryClient, message)}
          className="px-1 py-[3px] font-semibold transition-colors hover:text-ink"
        >
          Delete
        </button>
      </MessageFooter>
    )
  if (message.seq === null && connection !== 'online')
    return (
      <MessageFooter className="gap-[5px]">
        <ClockIcon className="size-[13px]" strokeWidth={2.5} aria-hidden="true" />
        Waiting for network
      </MessageFooter>
    )
  return (
    <MessageFooter>
      {message.edited && 'Edited · '}
      {message.seq === null ? 'Sending…' : (read ?? `Sent ${formatTime(message.ts)}`)}
    </MessageFooter>
  )
}

/** Loads the previous page when the user scrolls to the top: from the local copy if it has it, else the server. */
function LoadOlder({ chatId, messages }: { chatId: string; messages: Stored[] }) {
  const queryClient = useQueryClient()
  const connection = useConnection()
  const oldest = messages[0]?.seq
  const hasOlder = oldest !== undefined && oldest > 1

  const load = useMutation({
    mutationFn: async (before: number) => {
      const local = await cachedOlder(chatId, before, PAGE)
      if (local.length) return local
      const uid = currentUid()
      const page = await api<Stored[]>(`/chats/${chatId}/messages?before=${before}`)
      checkAccount(uid)
      void saveMessages(chatId, page)
      return page
    },
    // A few tries, then it waits for the connection to come back rather than asking again while the line stays put.
    retry: 2,
    onSuccess: (page) => {
      load.reset()
      upsertMessages(queryClient, chatId, page)
    },
  })

  // Coming back online tries again by itself; while online, failing stays failed until Retry, rather than looping.
  const was = useRef(connection)
  useEffect(() => {
    if (was.current !== 'online' && connection === 'online' && load.isError) load.reset()
    was.current = connection
  }, [connection, load])

  // Loads when this line at the top of the list is actually on screen, not merely before the scroller has measured.
  const [onScreen, setOnScreen] = useState(false)
  const sentinel = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (onScreen && hasOlder && load.isIdle) load.mutate(oldest)
  }, [onScreen, hasOlder, oldest, load])

  if (!hasOlder) return null
  // Paper: "Offline & delivery". Retry clears the error; the sentinel is still on screen, so the effect loads again.
  return (
    <div
      ref={sentinel}
      className="flex items-center justify-center gap-2.5 py-2 text-xs font-medium text-muted-foreground"
    >
      {load.isError ? (
        <>
          Couldn't load older messages
          <button
            type="button"
            onClick={() => load.reset()}
            className="flex items-center gap-1 rounded-full border-[1.5px] border-ink bg-paper px-2.5 py-[3px] font-semibold text-ink transition-colors hover:bg-sun"
          >
            <RotateCcwIcon className="size-3" strokeWidth={2.75} aria-hidden="true" />
            Retry
          </button>
        </>
      ) : (
        'Loading…'
      )}
    </div>
  )
}
