import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export function getContext() {
  // No mutation retries: mutations like send-message are not idempotent, and
  // a retry after a lost response duplicates the action.
  const queryClient = new QueryClient()
  return {
    queryClient,
  }
}

export function Provider({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
