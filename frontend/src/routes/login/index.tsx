import { useMutation } from '@tanstack/react-query'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { AuthHeading, AuthLayout, FormError } from '#/components/auth-layout'
import { Button } from '#/components/button'
import { TextField } from '#/components/text-field'
import { authClient, sessionQuery, unwrap } from '#/lib/auth'

type Mode = 'signin' | 'signup'

export const Route = createFileRoute('/login/')({
  validateSearch: (search): { mode: Mode } => ({ mode: search.mode === 'signup' ? 'signup' : 'signin' }),
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (session) throw redirect({ to: session.user.username ? '/' : '/login/username' })
  },
  component: Login,
})

function Login() {
  const { mode } = Route.useSearch()
  const navigate = useNavigate()
  const { queryClient } = Route.useRouteContext()

  const submit = useMutation({
    mutationFn: async (form: FormData) => {
      const password = String(form.get('password'))
      if (mode === 'signup') {
        const username = String(form.get('username'))
        await unwrap(authClient.signUp.email({ email: String(form.get('email')), password, username, name: username }))
        return
      }
      const identifier = String(form.get('identifier')).trim()
      await unwrap(
        identifier.includes('@')
          ? authClient.signIn.email({ email: identifier, password })
          : authClient.signIn.username({ username: identifier, password })
      )
    },
    onSuccess: async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 })
      await navigate({ to: '/' })
    },
  })

  const google = useMutation({
    mutationFn: () =>
      unwrap(
        authClient.signIn.social({
          provider: 'google',
          callbackURL: `${location.origin}/`,
          errorCallbackURL: `${location.origin}/login`,
        })
      ),
  })

  const signup = mode === 'signup'

  return (
    <AuthLayout
      headline={
        <>
          Say it
          <br />
          before it
          <br />
          pops.
        </>
      }
      stickers={['pizza tonight?', 'already ordered', 'typing…']}
    >
      <AuthHeading
        title={signup ? 'Join the party' : 'Welcome back'}
        subtitle={signup ? 'One account, every conversation.' : 'Your chats missed you. Probably.'}
      />

      <Button variant="sticker" className="h-[52px]" disabled={google.isPending} onClick={() => google.mutate()}>
        <GoogleIcon />
        Continue with Google
      </Button>

      <div className="flex items-center gap-3.5">
        <div className="h-px flex-1 bg-line" />
        <span className="text-xs font-medium tracking-[0.08em] text-muted uppercase">or</span>
        <div className="h-px flex-1 bg-line" />
      </div>

      <form
        key={mode}
        className="flex flex-col gap-7"
        onSubmit={(e) => {
          e.preventDefault()
          submit.mutate(new FormData(e.currentTarget))
        }}
      >
        <div className="flex flex-col gap-4">
          {signup ? (
            <>
              <TextField label="Email" name="email" type="email" autoComplete="email" required />
              <TextField
                label="Username"
                name="username"
                autoComplete="username"
                required
                minLength={3}
                maxLength={30}
                pattern="[A-Za-z0-9_.]+"
                leading={<span className="text-lg font-semibold text-muted">@</span>}
              />
            </>
          ) : (
            <TextField label="Email or username" name="identifier" autoComplete="username" required />
          )}
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
            minLength={8}
          />
        </div>

        <FormError error={submit.error ?? google.error} />

        <div className="flex flex-col gap-5">
          <Button type="submit" disabled={submit.isPending}>
            {signup ? 'Create account' : 'Sign in'}
          </Button>
          <p className="text-center text-[15px] text-muted">
            {signup ? 'Already have an account? ' : 'New here? '}
            <Link
              to="/login"
              search={{ mode: signup ? 'signin' : 'signup' }}
              className="font-semibold text-cobalt hover:underline"
            >
              {signup ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
        </div>
      </form>
    </AuthLayout>
  )
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.05-3.72 1.05-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  )
}
