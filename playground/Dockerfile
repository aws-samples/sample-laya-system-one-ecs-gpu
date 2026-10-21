FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp

WORKDIR /app

COPY requirements.txt .
# Install the app dependencies, then clear the scanner's build-tooling HIGH findings: upgrade
# setuptools/wheel to patched versions and remove pip. pip is not used at runtime, and the
# latest pip bundles vendored copies (urllib3, msgpack, setuptools) the scanner flags; Streamlit
# does not import pkg_resources, so dropping pip is safe.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --upgrade setuptools wheel \
    && python -m pip uninstall -y pip

COPY .streamlit/ .streamlit/
COPY app.py .

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
USER 10001

EXPOSE 8080

# ECS uses the task-definition health check; this HEALTHCHECK makes the image
# self-describing when run outside ECS.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/_stcore/health', timeout=3)"]

CMD ["streamlit", "run", "app.py"]
