import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { Message as Stored } from 'backend/protocol'
import { cn } from 'cn'
import { isSameDay } from 'date-fns'
import { ArrowLeftIcon, BanIcon, ClockIcon, RotateCcwIcon } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'

import { Avatar } from '@/components/avatar'
import { Composer, type ComposerMode } from '@/components/composer'
import { ErrorState } from '@/components/error-state'
import { MessageActions, Reactions } from '@/components/message-actions'
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
import { api, chatQuery, hydrateChat, merge, messagesQuery, PAGE, type LocalMessage } from '@/lib/api'
import { discardMessage, patchMessage, retryMessage, useConnection } from '@/lib/socket'
import { cachedOlder, saveMessages } from '@/lib/store'
import { formatDay, formatTime } from '@/lib/time'

export const Route = createFileRoute('/_app/c/$chatId')({
  // The local copy renders first; the network only blocks a chat this device has never opened.
  loader: async ({ context: { queryClient }, params: { chatId } }) => {
    await hydrateChat(queryClient, chatId)
    await queryClient.ensureQueryData(chatQuery(chatId))
  },
  component: ChatView,
  errorComponent: ErrorState,
})

function ChatView() {
  const { chatId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const { data: chat } = useSuspenseQuery(chatQuery(chatId))
  const peer = chat.members.find((m) => m.id !== user.id) ?? chat.members[0]
  const [mode, setMode] = useState<ComposerMode>(null)
  // A reply or edit started in another chat doesn't follow you here.
  const active = mode?.message.chat === chatId ? mode : null
  const names = new Map(chat.members.map((m) => [m.id, m.id === user.id ? 'You' : m.name.split(' ')[0]]))

  // Keyed so scroll position, load state and the draft reset when switching chats.
  return (
    <Fragment key={chatId}>
      <header className="flex h-[76px] shrink-0 items-center gap-3 border-b border-line bg-paper px-4 md:px-7">
        <Link to="/" aria-label="Back to chats" className="-ml-1 rounded-lg p-1 md:hidden">
          <ArrowLeftIcon className="size-5" />
        </Link>
        <Avatar id={peer.id} name={peer.name} className="size-10 rounded-full text-base" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate leading-5 font-semibold">{peer.name}</span>
          <span className="truncate text-[13px] leading-4 font-medium text-muted-foreground">@{peer.username}</span>
        </div>
      </header>
      {/* autoScroll keeps the view pinned to the newest message while you are at the bottom, through layout
          shifts (fonts, older pages, new messages); scrolling up releases it. */}
      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        <MessageList chatId={chatId} uid={user.id} names={names} onMode={setMode} />
      </MessageScrollerProvider>
      <Composer
        chatId={chatId}
        uid={user.id}
        placeholder={`Message ${peer.name.split(' ')[0]}`}
        names={names}
        mode={active}
        onMode={setMode}
      />
    </Fragment>
  )
}

function MessageList({
  chatId,
  uid,
  names,
  onMode,
}: {
  chatId: string
  uid: string
  names: Map<string, string>
  onMode: (mode: ComposerMode) => void
}) {
  const queryClient = useQueryClient()
  const { data: log } = useSuspenseQuery(messagesQuery(chatId))
  // Patches stay in the log (they keep the cursor's run unbroken) but are already folded into their messages.
  const messages = log.filter((m) => m.kind === 'text')
  const lastMine = messages.findLast((m) => m.sender === uid && !m.deleted)
  const { scrollToMessage } = useMessageScroller()

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
            return (
              <Fragment key={first.cid}>
                {(!prev || !isSameDay(prev.ts, first.ts)) && (
                  <MessageScrollerItem className="mt-4 mb-2.5 self-center first:mt-0">
                    <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                      {formatDay(first.ts)}
                    </span>
                  </MessageScrollerItem>
                )}
                <MessageGroup
                  className={cn(prev && prev.sender !== first.sender && isSameDay(prev.ts, first.ts) && 'mt-2')}
                >
                  {run.map((m, i) => {
                    const react = (emoji: string | null) => patchMessage(queryClient, uid, m, { t: 'react', emoji })
                    const quoted = m.reply && messages.find((q) => q.seq === m.reply!.seq)
                    return (
                      <MessageScrollerItem key={m.cid} messageId={m.cid}>
                        <Message align={mine ? 'end' : 'start'}>
                          <MessageContent>
                            {m.deleted ? (
                              <div
                                className={cn(
                                  'flex w-fit items-center gap-2 rounded-bubble border-[1.5px] border-dashed border-[#c9c9c9] px-4 py-[11px] text-[15px] leading-[22px] text-muted-foreground italic',
                                  corners(mine, i === 0, i === run.length - 1)
                                )}
                              >
                                <BanIcon className="size-[15px] shrink-0" strokeWidth={2.25} aria-hidden="true" />
                                {mine
                                  ? 'You deleted this message'
                                  : `${names.get(m.sender) ?? 'They'} deleted this message`}
                              </div>
                            ) : (
                              <Bubble variant={mine ? 'outgoing' : 'incoming'} title={formatTime(m.ts)}>
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
                                {m.seq !== null && (
                                  <MessageActions
                                    message={m}
                                    mine={mine}
                                    uid={uid}
                                    onReact={react}
                                    onReply={() => onMode({ t: 'reply', message: m })}
                                    onEdit={() => onMode({ t: 'edit', message: m })}
                                    onDelete={() => {
                                      if (confirm('Delete this message for everyone?'))
                                        patchMessage(queryClient, uid, m, { t: 'delete' })
                                    }}
                                  />
                                )}
                              </Bubble>
                            )}
                            {!m.deleted && <Reactions message={m} mine={mine} uid={uid} onReact={react} />}
                            {(m === lastMine || m.failed) && <Status message={m} />}
                            {m !== lastMine && !m.failed && !m.deleted && m.edited && (
                              <MessageFooter>Edited</MessageFooter>
                            )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  })}
                </MessageGroup>
              </Fragment>
            )
          })}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton />
    </MessageScroller>
  )
}

/** Consecutive messages from one sender on one day, so they stack as a group. */
function runs(messages: LocalMessage[]) {
  const out: LocalMessage[][] = []
  for (const m of messages) {
    const run = out.at(-1)
    const last = run?.at(-1)
    if (run && last && last.sender === m.sender && isSameDay(last.ts, m.ts)) run.push(m)
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
function Status({ message }: { message: LocalMessage }) {
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
      {message.seq === null ? 'Sending…' : `Sent ${formatTime(message.ts)}`}
    </MessageFooter>
  )
}

/** Loads the previous page when the user scrolls to the top: from the local copy if it has it, else the server. */
function LoadOlder({ chatId, messages }: { chatId: string; messages: LocalMessage[] }) {
  const queryClient = useQueryClient()
  const oldest = messages.find((m) => m.seq !== null)?.seq ?? undefined
  const hasOlder = oldest !== undefined && oldest > 1

  const load = useMutation({
    mutationFn: async (before: number) => {
      const local = await cachedOlder(chatId, before, PAGE)
      if (local.length) return local
      const page = await api<Stored[]>(`/chats/${chatId}/messages?before=${before}`)
      void saveMessages(chatId, page)
      return page
    },
    onSuccess: (page) => {
      load.reset()
      queryClient.setQueryData<LocalMessage[]>(messagesQuery(chatId).queryKey, (cur) => cur && merge(cur, page))
    },
  })

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
  return (
    <p ref={sentinel} className="py-2 text-center text-xs text-muted-foreground">
      {load.isError ? 'Could not load older messages' : 'Loading…'}
    </p>
  )
}
