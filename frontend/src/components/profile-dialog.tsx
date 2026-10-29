import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { mediaUrl } from 'backend/protocol'
import { CameraIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { FormError } from '@/components/auth-layout'
import { Avatar } from '@/components/avatar'
import { ProgressRing } from '@/components/progress-ring'
import { Availability, TextField } from '@/components/text-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useDebounced } from '@/hooks/use-debounced'
import { authClient, unwrap, USERNAME_PATTERN } from '@/lib/auth'
import { sessionQuery, type Session } from '@/lib/session'
import { imageSrc, prepare, upload, useProgress, type Upload } from '@/lib/upload'

/**
 * Your photo, name and username (Paper: "Profile"). Opened from yourself at the bottom of the sidebar; loaded on
 * first hover or focus there. Names aren't stored in messages, so every chat shows the change.
 */
export default function ProfileDialog({
  user,
  open,
  onOpenChange,
}: {
  user: Session['user']
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so it starts from the saved profile every time. */}
      <DialogContent showCloseButton={false} className="gap-6">
        {open && <Profile user={user} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Profile({ user, onDone }: { user: Session['user']; onDone: () => void }) {
  const queryClient = useQueryClient()
  const current = user.username ?? ''
  const [name, setName] = useState(user.name)
  const [username, setUsername] = useState(user.displayUsername ?? current)
  const [photo, setPhoto] = useState<{ image: string | null; upload?: Upload }>({ image: user.image ?? null })
  const picker = useRef<HTMLInputElement>(null)

  const debounced = useDebounced(username.toLowerCase(), 300)
  const changed = debounced !== current
  const valid = USERNAME_PATTERN.test(debounced)

  const availability = useQuery({
    queryKey: ['username-available', debounced],
    queryFn: () => unwrap(authClient.isUsernameAvailable({ username: debounced })),
    enabled: valid && changed,
  })

  const checking = username.toLowerCase() !== debounced || availability.isFetching
  const usable = !changed || (valid && availability.data?.available === true)

  const pick = useMutation({
    mutationFn: async (file: File) => {
      const picked = await prepare(file, user.id)
      setPhoto({ image: mediaUrl(picked.key), upload: picked })
      await upload(picked)
    },
    onError: () => setPhoto({ image: user.image ?? null }),
  })

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        authClient.updateUser({
          name: name.trim(),
          ...(changed && { username }),
          ...(photo.image !== (user.image ?? null) && { image: photo.image }),
        })
      ),
    onSuccess: async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 })
      // Your name and photo show in the chat list and every open chat.
      void queryClient.invalidateQueries({ predicate: ({ queryKey: [k] }) => k === 'inbox' || k === 'chat' })
      onDone()
    },
  })

  const camera =
    'absolute -right-1 -bottom-1 flex size-9 items-center justify-center rounded-full border-2 border-ink bg-sun text-black shadow-[2px_2px_0_var(--color-ink)]'

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="flex flex-col items-center gap-4 pt-1">
        <div className="relative size-24">
          {/* A new photo shows from the file while it uploads. */}
          <Avatar id={user.id} image={photo.upload ? imageSrc(photo.upload.key) : photo.image} className="size-24" />
          {photo.upload && pick.isPending && <Uploading upload={photo.upload} />}
          {/* With no photo, the button opens the file picker; with one, a menu also offers to remove it. */}
          {photo.image ? (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Change photo" className={camera}>
                <CameraIcon className="size-4" strokeWidth={2.25} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => picker.current?.click()}>
                  <UploadIcon strokeWidth={2.25} />
                  Upload photo
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setPhoto({ image: null })}>
                  <Trash2Icon strokeWidth={2.25} />
                  Remove photo
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <button type="button" aria-label="Upload photo" onClick={() => picker.current?.click()} className={camera}>
              <CameraIcon className="size-4" strokeWidth={2.25} />
            </button>
          )}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]

              if (file) pick.mutate(file)
              e.target.value = ''
            }}
          />
        </div>
        <DialogTitle className="font-display text-[26px] leading-[30px] font-extrabold tracking-[-0.03em]">
          Your profile
        </DialogTitle>
      </div>

      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          name="name"
          autoComplete="name"
          required
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          required
          value={username}
          aria-invalid={changed && !checking && !usable}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
          leading={<span className="font-semibold text-muted-foreground">@</span>}
          trailing={
            changed && <Availability checking={checking} valid={valid} available={availability.data?.available} />
          }
          hint={
            changed
              ? `Links to /@${current} stop working once you save.`
              : '3–30 characters: letters, numbers, dots and underscores.'
          }
        />
      </div>

      <FormError error={pick.error ?? save.error} />
      <div className="flex gap-2.5 pt-1">
        <Button type="button" variant="outline" className="h-[52px] flex-1 rounded-[14px]" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          className="h-[52px] flex-1 rounded-[14px]"
          disabled={!name.trim() || !usable || checking || pick.isPending || save.isPending}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

/** Dims a new photo under its upload's progress. */
function Uploading({ upload }: { upload: Upload }) {
  const progress = useProgress([upload.key])

  return (
    <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/35">
      <ProgressRing value={progress} className="size-9" />
    </span>
  )
}
