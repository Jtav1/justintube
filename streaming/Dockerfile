# Multi-stage: pull the mediamtx binary out of the official (scratch-based,
# shell-less) image onto plain Alpine so the run-on-publish/unpublish hooks
# below can use curl + jq. No ffmpeg here - HLS output is a native remux, no
# transcoding involved, and the `processing` service already owns ffmpeg for
# everything transcode-related.
# Pin explicitly and bump deliberately - hook config keys have moved across
# MediaMTX versions, so re-verify streaming/mediamtx.yml against this
# version's docs/bundled default config before bumping.
ARG MEDIAMTX_VERSION=v1.20.0
FROM bluenviron/mediamtx:${MEDIAMTX_VERSION} AS mediamtx

FROM alpine:3.20
RUN apk add --no-cache curl jq
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY mediamtx.yml /mediamtx.yml
COPY scripts/on-publish.sh scripts/on-unpublish.sh /scripts/
RUN chmod +x /scripts/on-publish.sh /scripts/on-unpublish.sh

ENTRYPOINT ["/usr/local/bin/mediamtx"]
CMD ["/mediamtx.yml"]
