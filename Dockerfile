FROM golang:1.27.3-alpine3.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal/ ./internal/
COPY public/ ./public/
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /host-monitor .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates iputils-ping \
    && addgroup -g 10001 monitor && adduser -D -u 10001 -G monitor monitor \
    && mkdir -p /app/data /app/logs && chown -R monitor:monitor /app
COPY --from=build /host-monitor /usr/local/bin/host-monitor
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/host-monitor/
WORKDIR /app
USER 10001:10001
EXPOSE 3000
VOLUME ["/app/data", "/app/logs"]
ENTRYPOINT ["host-monitor"]
