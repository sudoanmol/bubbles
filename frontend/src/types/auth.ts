export type User = {
  id: string
  username: string
  email: string
  profile_image_url?: string | null
  created_at: string
}

export type AuthResponse = {
  token: string
  refresh_token: string
  user: User
}

export type VerifyResponse = {
  success: boolean
  user?: User
}

export type ErrorResponse = {
  error: string
  retry_after?: number
}

export type SignUpData = {
  username: string
  email: string
  password: string
}

export type SignInData = {
  email_or_username: string
  password: string
}

export type SessionData = {
  token?: string
  refreshToken?: string
  user?: User
}
