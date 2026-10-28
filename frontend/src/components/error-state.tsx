import { Link, type ErrorComponentProps } from '@tanstack/react-router'

/** Route error inside the app shell, with a way back to the inbox. */
export function ErrorState({ error }: ErrorComponentProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="font-display text-[32px] leading-9 font-extrabold tracking-[-0.03em]">
        {error instanceof Error ? error.message : 'Something went wrong'}
      </h1>
      <Link to="/" className="font-semibold text-cobalt hover:underline">
        Back to your chats
      </Link>
    </div>
  )
}
