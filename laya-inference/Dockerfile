# syntax=docker/dockerfile:1
# Laya inference server (laya-serve, POST /v1/systemone).
#
#   GPU (ECS, amd64):  docker build --platform linux/amd64 -t laya-inference:0.3.22-2 .
#   CPU (local test):  docker build --build-arg TORCH_INDEX=cpu --build-arg LAYA_DEVICE=cpu -t laya-inference:cpu .
#
# Follows the upstream Dockerfile (github.com/NandhaKishorM/laya): torch from the
# index that matches the device, non-root UID 10001, TORCH_DISABLE_NATIVE_JIT=1.

ARG LAYA_VERSION=0.3.22
ARG TORCH_VERSION=2.14.0

# ---------------------------------------------------------------------------
# Weights: downloaded once at build time, pinned to the reviewed Hub commit.
# Weights are architecture-independent; this stage installs CPU torch only to
# download and preload them, regardless of the target image platform.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS weights
ARG LAYA_VERSION
ARG TORCH_VERSION
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    USE_TF=0 \
    TORCH_DISABLE_NATIVE_JIT=1
RUN pip install "torch==${TORCH_VERSION}" --index-url https://download.pytorch.org/whl/cpu \
    && pip install "laya==${LAYA_VERSION}"
# Plain directory (local_dir), not the Hub cache: huggingface_hub still calls the Hub
# for cached repos in offline mode. The revision is the reviewed SHA shipped by Laya,
# and the file list matches what laya.agent downloads.
RUN python -c "\
from huggingface_hub import snapshot_download; \
from laya.revisions import PINNED_REVISIONS; \
repo = 'convaiinnovations/laya'; \
snapshot_download(repo, revision=PINNED_REVISIONS[repo], local_dir='/models/laya', \
    allow_patterns=['rl_agent_config.json', 'model.safetensors', 'tokenizer/*', 'encoder/*'])" \
    && rm -rf /models/laya/.cache
# A real load (not only a download): it fails the build if the checkpoint does not
# load, and applies Laya's one-time tokenizer_config patch so the runtime can use a
# read-only filesystem.
RUN HF_HUB_OFFLINE=1 python -c "\
from laya.router import Router; \
Router(device='cpu', models={'english': '/models/laya'}).preload(['english'])"

# ---------------------------------------------------------------------------
# Python environment for the target platform/device.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS build
ARG LAYA_VERSION
ARG TORCH_VERSION
# cu126: has torch 2.14.0 wheels (cu128 stops at 2.11), supports the T4 (sm_75)
# and runs on any CUDA 12.x driver. cu130 would need driver >= 580.
ARG TORCH_INDEX=cu126
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install "torch==${TORCH_VERSION}" --index-url "https://download.pytorch.org/whl/${TORCH_INDEX}" \
    && pip install "laya[serve]==${LAYA_VERSION}" \
    && pip check

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS runtime
ARG LAYA_DEVICE=cuda

RUN groupadd --gid 10001 laya \
    && useradd --uid 10001 --gid laya --no-create-home --shell /usr/sbin/nologin laya

COPY --from=build /opt/venv /opt/venv
COPY --from=weights /models /models
COPY serve.py /opt/laya/serve.py

# Clear the scanner's build-tooling HIGH findings in both the venv the app runs from and the
# base image's system interpreter. setuptools/wheel are upgraded to patched versions (kept so
# pkg_resources stays available for any importer); pip is removed because it is not used at
# runtime and the latest pip bundles vendored copies (urllib3, msgpack, setuptools) the scanner
# flags.
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade setuptools wheel \
    && /usr/local/bin/pip install --no-cache-dir --upgrade setuptools wheel \
    && /opt/venv/bin/python -m pip uninstall -y pip \
    && /usr/local/bin/python -m pip uninstall -y pip

# HF_HUB_OFFLINE: no Hub access at runtime, only the weights baked above
# (serve.py points the Router at LAYA_ENGLISH_PATH).
# LAYA_HOST=127.0.0.1: only containers in the same task (awsvpc) can reach it.
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TORCH_DISABLE_NATIVE_JIT=1 \
    USE_TF=0 \
    TOKENIZERS_PARALLELISM=false \
    HF_HUB_OFFLINE=1 \
    LAYA_ENGLISH_PATH=/models/laya \
    LAYA_REVISION=reviewed \
    LAYA_DEVICE=${LAYA_DEVICE} \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=english \
    LAYA_HOST=127.0.0.1 \
    LAYA_PORT=8000

USER 10001
EXPOSE 8000

# ECS uses the task-definition health check; this HEALTHCHECK makes the image
# self-describing when run outside ECS (no curl in the image, so urllib is used).
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]

CMD ["python", "/opt/laya/serve.py"]
