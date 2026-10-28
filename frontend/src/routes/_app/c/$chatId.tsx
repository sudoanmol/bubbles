import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { Message as Stored } from 'backend/protocol'
import { cn } from 'cn'
import { isSameDay } from 'date-fns'
import { ArrowLeftIcon } from 'lucide-react'
import { Fragment, useEffect } from 'react'

import { Avatar } from '@/components/avatar'
import { Composer } from '@/components/composer'
import { ErrorState } from '@/components/error-state'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter, MessageGroup } from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from '@/components/ui/message-scroller'
import { api, chatQuery, hydrateChat, merge, messagesQuery, PAGE, type LocalMessage } from '@/lib/api'
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
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageList chatId={chatId} uid={user.id} />
      </MessageScrollerProvider>
      <Composer chatId={chatId} uid={user.id} placeholder={`Message ${peer.name.split(' ')[0]}`} />
    </Fragment>
  )
}

function MessageList({ chatId, uid }: { chatId: string; uid: string }) {
  const { data: messages } = useSuspenseQuery(messagesQuery(chatId))
  const lastMine = messages.findLast((m) => m.sender === uid)

  return (
    <MessageScroller className="flex-1">
      <MessageScrollerViewport preserveScrollOnPrepend aria-label="Messages">
        <MessageScrollerContent className="justify-end gap-1.5 p-4 md:p-7">
          <LoadOlder chatId={chatId} messages={messages} />
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
                  {run.map((m, i) => (
                    <MessageScrollerItem key={m.cid} messageId={m.cid}>
                      <Message align={mine ? 'end' : 'start'}>
                        <MessageContent>
                          <Bubble variant={mine ? 'outgoing' : 'incoming'} title={formatTime(m.ts)}>
                            <BubbleContent className={corners(mine, i === 0, i === run.length - 1)}>
                              {m.body}
                            </BubbleContent>
                          </Bubble>
                          {m === lastMine && <Status message={m} />}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ))}
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

function Status({ message }: { message: LocalMessage }) {
  if (message.failed) return <MessageFooter className="text-danger">Not sent</MessageFooter>
  return <MessageFooter>{message.seq === null ? 'Sending…' : `Sent ${formatTime(message.ts)}`}</MessageFooter>
}

/** Loads the previous page when the user scrolls to the top: from the local copy if it has it, else the server. */
function LoadOlder({ chatId, messages }: { chatId: string; messages: LocalMessage[] }) {
  const queryClient = useQueryClient()
  const { start } = useMessageScrollerScrollable()
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

  const atTop = !start
  useEffect(() => {
    if (atTop && hasOlder && load.isIdle) load.mutate(oldest)
  }, [atTop, hasOlder, oldest, load])

  if (!hasOlder) return null
  return (
    <p className="py-2 text-center text-xs text-muted-foreground">
      {load.isError ? 'Could not load older messages' : 'Loading…'}
    </p>
  )
}
