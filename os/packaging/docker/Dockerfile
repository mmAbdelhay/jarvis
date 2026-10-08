# Jarvis agent with read-only tools (M2.5 design §3.10, contracts §6, §7 #14).
# Built by os/packaging/docker/build-image.sh from this build's .debs:
# jarvisd, jarvis-diag and jarvis-cli only. No jarvis-helper (no root
# helper, no polkit) and no jarvis-pkg. Runs as an unprivileged user.
FROM debian:trixie-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="jarvis-agent" \
      org.opencontainers.image.description="Jarvis AI agent, read-only tools, no root helper" \
      org.opencontainers.image.source="https://github.com/mmAbdelhay/jarvis" \
      org.opencontainers.image.version="${VERSION}"
COPY debs/ /tmp/debs/
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates libstdc++6 iproute2 iputils-ping pciutils usbutils procps; \
    for p in jarvisd jarvis-diag jarvis-cli; do dpkg-deb -x /tmp/debs/${p}_*.deb /; done; \
    rm -f /usr/lib/systemd/user/jarvisd.service; \
    rm -rf /tmp/debs /var/lib/apt/lists/*; \
    test ! -e /usr/libexec/jarvis/jarvis-helper; \
    test ! -e /usr/lib/jarvis/mcp/jarvis-pkg; \
    find / -xdev -type f -perm /6000 -exec chmod a-s {} +; \
    groupadd --gid 10001 jarvis; \
    useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin jarvis
COPY --chmod=0755 entrypoint.sh /usr/lib/jarvis/docker-entrypoint
# Contracts §7 #14: jarvisd drops non-safe tools and tolerates missing jarvis-pkg.
ENV JARVIS_TOOL_PROFILE=readonly
USER 10001:10001
WORKDIR /home/jarvis
ENTRYPOINT ["/usr/lib/jarvis/docker-entrypoint"]
