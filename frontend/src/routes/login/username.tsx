import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthHeading, AuthLayout, FormError } from '@/components/auth-layout'
import { Availability, TextField } from '@/components/text-field'
import { Button } from '@/components/ui/button'
import { useDebounced } from '@/hooks/use-debounced'
import { USERNAME_PATTERN, authClient, suggestUsername, unwrap } from '@/lib/auth'
import { sessionQuery } from '@/lib/session'

export const Route = createFileRoute('/login/username')({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.query({ ...sessionQuery, staleTime: 'static' })

    if (!session) throw redirect({ to: '/login', search: { mode: 'signin' } })

    if (session.user.username) throw redirect({ to: '/' })

    return { user: session.user }
  },
  component: ChooseUsername,
})

function ChooseUsername() {
  const { user, queryClient } = Route.useRouteContext()
  const navigate = useNavigate()
  const [username, setUsername] = useState(() => suggestUsername(user.email))
  const debounced = useDebounced(username.toLowerCase(), 300)
  const valid = USERNAME_PATTERN.test(debounced)

  const availability = useQuery({
    queryKey: ['username-available', debounced],
    queryFn: () => unwrap(authClient.isUsernameAvailable({ username: debounced })),
    enabled: valid,
  })

  const available = valid && availability.data?.available

  const save = useMutation({
    mutationFn: () => unwrap(authClient.updateUser({ username })),
    onSuccess: async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 })
      await navigate({ to: '/' })
    },
  })

  return (
    <AuthLayout
      headline={
        <>
          Who's
          <br />
          this?
        </>
      }
      stickers={["who's new?", `@${username || 'you'} joined`, 'say hi']}
    >
      <AuthHeading
        title="Pick your handle"
        subtitle="This is how friends find you. We took a guess from your email, and you can change it."
      />
      <form
        className="flex flex-col gap-7"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
          leading={<span className="text-lg font-semibold text-muted-foreground">@</span>}
          trailing={
            <Availability
              checking={availability.isFetching || username.toLowerCase() !== debounced}
              valid={valid}
              available={available}
            />
          }
          hint="3–30 characters: letters, numbers, dots and underscores."
        />
        <FormError error={save.error} />
        <Button type="submit" disabled={!available || save.isPending}>
          Let's go
        </Button>
      </form>
    </AuthLayout>
  )
}
