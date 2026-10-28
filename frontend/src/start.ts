import { createStart } from '@tanstack/react-start'

// The app renders on the client; the server only sends the HTML shell.
export const startInstance = createStart(() => ({ defaultSsr: false }))
