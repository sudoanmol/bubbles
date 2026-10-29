import type { ReactNode } from 'react'

import { Logo } from './logo'

const stickerStyles = [
  'rotate-[4deg] rounded-[22px_22px_6px_22px] bg-paper px-5 py-3.5',
  'rotate-[-3deg] rounded-[22px_22px_22px_6px] bg-cobalt px-5 py-3.5 text-white',
  'rotate-[6deg] rounded-full bg-gum px-4 py-2.5 text-sm font-semibold',
]

/** Split screen from the Paper designs: a sun brand panel beside the form. */
export function AuthLayout({
  headline,
  stickers,
  children,
}: {
  headline: ReactNode
  stickers: [string, string, string]
  children: ReactNode
}) {
  return (
    <div className="flex min-h-dvh gap-4 p-4">
      <aside className="sticky top-4 hidden h-[calc(100dvh-2rem)] flex-1 flex-col justify-between gap-8 overflow-hidden rounded-[28px] bg-sun p-12 text-black lg:flex">
        <Logo size="lg" />
        <div className="flex flex-col items-end gap-3.5 self-end">
          {stickers.map((text, i) => (
            <div
              key={text}
              className={`border-2 border-ink text-[17px] font-medium shadow-[4px_4px_0_var(--color-ink)] ${stickerStyles[i]}`}
            >
              {text}
            </div>
          ))}
        </div>
        <h1 className="font-display text-[88px] leading-[84px] font-extrabold tracking-[-0.04em]">{headline}</h1>
      </aside>
      <main className="flex flex-1 flex-col items-center justify-center py-10 lg:w-[600px] lg:flex-none">
        <div className="mb-10 lg:hidden">
          <Logo size="lg" />
        </div>
        <div className="flex w-full max-w-[400px] flex-col gap-7">{children}</div>
      </main>
    </div>
  )
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-display text-[40px] leading-[44px] font-extrabold tracking-[-0.03em]">{title}</h2>
      <p className="text-base leading-6 text-muted-foreground">{subtitle}</p>
    </div>
  )
}

export function FormError({ error }: { error: Error | null }) {
  if (!error) return null

  return (
    <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
      {error.message}
    </p>
  )
}
