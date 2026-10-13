# -----------------------------------------------------------------------------
# Reolink integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see build.yml
#
# ffmpeg is installed for ONE job: shrinking an oversized snapshot. Reolink
# cameras hand out a ready-made JPEG, so the nominal path decodes nothing — but
# a 4K camera returns a frame well above what Gladys accepts, and re-encoding it
# keeps the main-stream framing instead of falling back to the soft low-
# resolution stream. Captures go through pipes only, so no temporary file is
# ever written.
# -----------------------------------------------------------------------------

FROM node:24-alpine

# Version of the release, passed by build.yml (`dev` for a local build).
ARG VERSION=dev

# OCI labels: where the code lives, under which licence, which version.
LABEL org.opencontainers.image.title="Gladys Reolink" \
      org.opencontainers.image.description="Gladys Assistant integration for Reolink cameras, on the local network" \
      org.opencontainers.image.source="https://github.com/William-De71/gladys-reolink" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

# dumb-init: correct signal handling (SIGTERM) for a graceful shutdown, which
# here means stopping the event loop before exiting.
# ffmpeg: shrinking oversized snapshots.
RUN apk add --no-cache dumb-init ffmpeg

WORKDIR /app

# Install the PROD dependencies first (better build cache). `npm ci` only:
# a lockfile out of sync with package.json must fail the build, not be
# silently re-resolved into an untested dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime. Docker creates a new volume
# with the owner of the image's /data, so it must belong to `node`, and before
# VOLUME: changes made to /data after it are discarded.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
