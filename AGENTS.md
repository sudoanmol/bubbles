## Project Rules

- Always use shadcn components. Install them with `bunx shadcn@latest add <component-name>`.
- Use Bun as package manager.
- Uitlize the Makefile in the backend directory for managing the Go backend.
- Never run `bun run dev` or `go run main.go` directly. I have the dev serves running.
- You can use `make build` to test the backend build for any errors after you are done with a task.
- You can use `bun run typecheck` to test the frontend type checking for any errors after you are done with a task.
- Never make `.md` files describing your work after you are done with a task.
- Components, hooks should follow kebab-case naming convention.
- Don't add comments to functions unless absolutely necessary and the function is complex.
- Use TanStack Query for data fetching from backend.
- Don't default export components or hooks. Always use named exports.
- Prefer using shadcn's `cn` utility for conditional classNames.
- Prefer type over interface.
