FROM golang:1.24-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/server main.go

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /bin/server /server
EXPOSE 8000
CMD ["/server"]
