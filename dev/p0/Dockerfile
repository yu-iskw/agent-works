# Workbench runtime base for compose.p0.yaml. The image holds only Node and pnpm; the `builder`
# service compiles the repository into the `p0-app` volume. No source or credentials are baked in;
# Vertex ADC arrives at run time through a read-only bind mount on the api service only.
FROM node:24.13.0-bookworm-slim
RUN npm install --global pnpm@11.0.5 && npm cache clean --force
# Any UID may run the image (compose passes the host UID so a 0600 ADC file stays readable on Linux).
RUN mkdir -p /home/app/.config /app /pnpm-store && chmod -R 0777 /home/app /app /pnpm-store
ENV HOME=/home/app
WORKDIR /app
HEALTHCHECK NONE
