import { PlusIcon } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { Button } from '@/components/ui/button'

// The dialog pulls in Base UI's Dialog and Combobox, so it loads on first hover or focus, not with the page.
const loadDialog = () => import('@/components/new-chat-dialog')
const NewChatDialog = lazy(loadDialog)

/** The button that opens the new chat dialog: the sun `+` in the sidebar, or the large call to action. */
export function NewChat({ variant }: { variant: 'icon' | 'cta' }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const show = () => {
    setLoaded(true)
    setOpen(true)
  }

  const preload = () => void loadDialog()

  return (
    <>
      {variant === 'icon' ? (
        <Button
          variant="sun"
          size="icon"
          aria-label="New chat"
          onClick={show}
          onPointerEnter={preload}
          onFocus={preload}
        >
          <PlusIcon className="size-[18px]" strokeWidth={3} />
        </Button>
      ) : (
        <Button className="h-[52px]" onClick={show} onPointerEnter={preload} onFocus={preload}>
          Start a chat
        </Button>
      )}
      {loaded && (
        <Suspense>
          <NewChatDialog open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  )
}
