import { createFileRoute } from '@tanstack/react-router'

import { NewChat } from '@/components/new-chat'

export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-2.5">
        <div className="-rotate-4 rounded-[22px_22px_22px_6px] border-2 border-ink bg-paper px-[18px] py-3 font-medium shadow-sticker">
          hello?
        </div>
        <div className="rotate-3 rounded-[22px_22px_6px_22px] border-2 border-ink bg-sun px-[18px] py-3 font-medium shadow-sticker">
          is this thing on?
        </div>
      </div>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-[40px] leading-[44px] font-extrabold tracking-[-0.03em]">Pick a chat</h1>
        <p className="text-base leading-6 text-muted-foreground">Or start a new one with a friend's username.</p>
      </div>
      <NewChat variant="cta" />
    </div>
  )
}
