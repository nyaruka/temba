# syntax = docker/dockerfile:1

ARG PYTHON_VERSION="3.14"
ARG DEBIAN_VERSION="bookworm"

ARG BUILD_DEPS="\
  gcc bzip2 git curl libpq-dev gettext libffi-dev \
  libgdal-dev python3-cffi python3-gdal \
  python3-dev build-essential \
  cmake \
  autoconf pkg-config libtool automake \
  ccache \
  libmagic-dev \
  ca-certificates"

ARG RUNTIME_DEPS="\
  git \
  tzdata \
  postgresql-client \
  netcat-traditional \
  curl \
  gosu \
  gdal-bin \
  libmagic1 \
  libatomic1 \
  ca-certificates"

FROM python:${PYTHON_VERSION}-slim-${DEBIAN_VERSION} AS build-uv

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock docker/pip-requires.txt ./

# pip-requires.txt keeps Poetry markers (@^ / @~=). Translate them before pip.
RUN python - <<'PY'
import re
from pathlib import Path

def caret(version: str) -> str:
    parts = []
    for piece in version.split("."):
        if not piece.isdigit():
            break
        parts.append(int(piece))
    while len(parts) < 3:
        parts.append(0)
    major, minor, patch = parts[:3]
    if major == 0 and minor == 0:
        upper = f"0.0.{patch + 1}"
    elif major == 0:
        upper = f"0.{minor + 1}.0"
    else:
        upper = f"{major + 1}.0.0"
    return f">={version},<{upper}"

lines = []
for raw in Path("pip-requires.txt").read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    match = re.match(r"^([A-Za-z0-9_.-]+)@\^(\S+)$", line)
    if match:
        lines.append(f"{match.group(1)}{caret(match.group(2))}")
        continue
    match = re.match(r"^([A-Za-z0-9_.-]+)@~=(\S+)$", line)
    if match:
        lines.append(f"{match.group(1)}~={match.group(2)}")
        continue
    lines.append(line.replace("@", ""))
Path("extras.txt").write_text("\n".join(lines) + "\n")
PY

RUN uv export --frozen --no-hashes --no-dev --no-emit-project --output-file requirements.txt

FROM python:${PYTHON_VERSION}-slim-${DEBIAN_VERSION} AS base

ENV PYTHONUNBUFFERED=1 \
  PYTHONDONTWRITEBYTECODE=1 \
  DEBIAN_FRONTEND=noninteractive \
  PROJECT=rapidpro \
  PROJECT_PATH=/app \
  PROJECT_USER=rapidpro \
  PROJECT_GROUP=rapidpro \
  NPM_CONFIG_PREFIX=/opt/npm-globals \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PATH="/opt/npm-globals/bin:/app/node_modules/.bin/:${PATH}:/install/bin" \
  PYTHONIOENCODING=UTF-8

ARG COMPRESS_ENABLED
ARG BRANDING_ENABLED

ARG RAPIDPRO_APPS_GIT_URL
ARG RAPIDPRO_APPS_GIT_BRANCH

LABEL app="rapidpro" \
  os="debian" \
  os.version="12" \
  name="RapidPro" \
  description="APP image" \
  maintainer="https://github.com/weni-ai" \
  org.opencontainers.image.url="https://github.com/weni-ai/rapidpro" \
  org.opencontainers.image.documentation="https://github.com/weni-ai/rapidpro" \
  org.opencontainers.image.source="https://github.com/weni-ai/rapidpro" \
  org.opencontainers.image.title="RapidPro"

RUN addgroup --gid 1999 "${PROJECT_GROUP}" \
  && useradd --system -m -d /app -u 1999 -g 1999 "${PROJECT_USER}"

WORKDIR "${PROJECT_PATH}"

RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

FROM base AS build

ARG BUILD_DEPS

ENV CC="ccache gcc" CXX="ccache g++" PATH="/usr/lib/ccache:${PATH}"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install --no-install-recommends --no-install-suggests -y ${BUILD_DEPS}

COPY --from=build-uv /app/requirements.txt /tmp/dep/requirements.txt
COPY --from=build-uv /app/extras.txt /tmp/dep/extras.txt

RUN --mount=type=cache,mode=0755,target=/pip_cache,id=pip \
  --mount=type=cache,mode=0755,target=/root/.cache/ccache,id=ccache \
  pip install --cache-dir /pip_cache -U pip setuptools wheel \
  && pip install --cache-dir /pip_cache --prefer-binary --prefix=/install -r /tmp/dep/requirements.txt \
  && pip install --cache-dir /pip_cache --prefer-binary --prefix=/install \
    -c /tmp/dep/requirements.txt \
    -r /tmp/dep/extras.txt \
    "django==5.2.14"

FROM base

ARG RUNTIME_DEPS

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ${RUNTIME_DEPS} \
  && rm -rf /usr/share/man /usr/share/doc \
  && mkdir -p "${NPM_CONFIG_PREFIX}" \
  && chown -R "${PROJECT_USER}:${PROJECT_GROUP}" "${NPM_CONFIG_PREFIX}"

# Bookworm's npm package is Node 18. serialize-javascript@7 in yarn.lock requires Node >= 20.
# Copy the real files, then recreate npm/npx. COPY follows those symlinks and drops them
# at /usr/local/bin, where npm-cli.js can no longer resolve ../lib/cli.js.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && npm --version

COPY --chown=${PROJECT_USER}:${PROJECT_GROUP} package.json yarn.lock ${PROJECT_PATH}/

RUN --mount=type=cache,id=npm,target=/npm_cache \
  --mount=type=cache,id=yarn,target=/yarn_cache \
  npm install --global --ignore-scripts --prefer-offline --cache /npm_cache \
    coffeescript \
    less \
    yarn \
  && yarn install --frozen-lockfile --cache-folder /yarn_cache \
  && chown -R "${PROJECT_USER}:${PROJECT_GROUP}" "${PROJECT_PATH}/node_modules" "${NPM_CONFIG_PREFIX}"

COPY --from=build /install /usr/local
COPY --chown=${PROJECT_USER}:${PROJECT_GROUP} . ${PROJECT_PATH}

RUN ln -s "${PROJECT_PATH}/temba/settings.py.prod" "${PROJECT_PATH}/temba/settings.py"

USER "${PROJECT_USER}:${PROJECT_GROUP}"

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -f http://127.0.0.1:8001/ || exit 1

ENTRYPOINT ["bash", "./docker/start"]
CMD ["start"]
