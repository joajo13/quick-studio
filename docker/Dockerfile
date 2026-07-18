# Dev image for quick-studio: bun + socat.
#
# socat lets the app bind loopback (127.0.0.1) INSIDE the container — which keeps
# it out of "exposed" mode so the UI's Port-Exposure banner never shows — while a
# tiny TCP forwarder republishes it on the container's wildcard interface for
# Docker port publishing. The browser still dials 127.0.0.1:6060, so the Host
# header the app validates matches its concrete loopback bind.
FROM oven/bun:1
RUN apt-get update \
  && apt-get install -y --no-install-recommends socat \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
