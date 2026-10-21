"""Start laya-serve with the English checkpoint from the weights baked into the image.

laya-serve resolves checkpoints by Hugging Face repo id, and huggingface_hub still
lists the repo tree on the Hub when HF_HUB_OFFLINE=1 (OfflineModeIsEnabled). Pointing
the Router at a local directory skips the Hub entirely. Everything else (limits, auth,
/health, uvicorn setup) is laya.serve.main() unchanged.

Note on authentication: laya-serve has no authentication unless LAYA_API_KEY is set. In
this project it is bound to 127.0.0.1 and reachable only by the playground container in
the same task. The interactive docs (/docs, /redoc) and the OpenAPI schema (/openapi.json)
are disabled below so the server does not advertise its surface.

Only the English checkpoint is baked into the image (LAYA_MODELS=english). Any other
checkpoint, whether named in `model` or picked by the Router from `task` or the language of
the state, would make laya try a runtime download from the Hub, which fails under
HF_HUB_OFFLINE with an opaque 500. So every request is pinned to the English checkpoint, and
a request that names another one is rejected with a 400.
"""
import functools
import os

import fastapi
import laya.serve
from laya.router import Router

ENGLISH_MODEL = "english"


def build_router():
    router = Router(
        device=os.environ.get("LAYA_DEVICE", "").strip() or None,
        models={"english": os.environ["LAYA_ENGLISH_PATH"]},
    )
    router.preload(["english"])
    return router


def english_only(resolve_model):
    """Wrap laya.serve._resolve_model so every request runs on the English checkpoint.

    POST /v1/systemone and POST /v1/systemone/batch both call it with the request's `model`
    field, after laya-serve has checked auth, admitted the request and read the body under its
    own 2 MiB cap, so the guard reads nothing itself. An English checkpoint, or no usable
    `model` (absent, or a Jev id such as "jev-1"), resolves to "english"; an explicit model
    also takes precedence over `task` and language routing in the Router. Any other checkpoint
    is rejected with a 400.
    """
    @functools.wraps(resolve_model)
    def wrapped(model):
        if resolve_model(model) not in (None, ENGLISH_MODEL):
            raise fastapi.HTTPException(
                status_code=400,
                detail='This server only serves the english checkpoint; set "model": "english".',
            )
        return ENGLISH_MODEL

    return wrapped


class NoDocsFastAPI(fastapi.FastAPI):
    """FastAPI without /docs, /redoc and /openapi.json."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **{**kwargs, "docs_url": None, "redoc_url": None, "openapi_url": None})


def patch_laya_serve():
    laya.serve.build_router = build_router
    # The endpoints look _resolve_model up in laya.serve's namespace on every request.
    laya.serve._resolve_model = english_only(laya.serve._resolve_model)
    # create_app() imports FastAPI from the fastapi module when it runs (laya.serve has no
    # module-level FastAPI name), so replacing it there removes the docs routes without
    # reimplementing main().
    fastapi.FastAPI = NoDocsFastAPI


if __name__ == "__main__":
    patch_laya_serve()
    laya.serve.main()
