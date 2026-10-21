import json
import os
import time

import boto3
import requests
import streamlit as st
from botocore.exceptions import BotoCoreError, ClientError

LAYA_URL = os.getenv("LAYA_URL", "http://127.0.0.1:8000/v1/systemone")
# "Label=model-or-inference-profile-id" pairs, comma separated. The task role only allows
# the models listed here (see infra/lib/laya-stack.ts).
BEDROCK_MODELS = dict(
    item.split("=", 1) for item in os.getenv(
        "BEDROCK_MODELS",
        "Amazon Nova Micro=amazon.nova-micro-v1:0",
    ).split(",")
)

# Keep playground input well below laya-serve's own limits (50k chars of state, 64 questions).
MAX_PAYLOAD_CHARS = 20_000
MAX_TEXT_CHARS = 4_000

bedrock = boto3.client("bedrock-runtime")

DEFAULT_REQUEST = {
    "model": "english",
    "state": {
        "body": "My package arrived but one item is missing."
    },
    "questions": {
        "route": {
            "type": "choice",
            "instructions": "Which workflow should handle this request?",
            "criteria": {
                "fulfillment": "missing or incomplete items",
                "delivery": "shipment delays or tracking",
                "returns": "returns and refunds",
                "account": "account changes",
            },
        }
    },
}


def call_laya(payload):
    started = time.perf_counter()
    response = requests.post(LAYA_URL, json=payload, timeout=30)
    response.raise_for_status()
    elapsed_ms = (time.perf_counter() - started) * 1000
    return response.json(), elapsed_ms


def laya_error_message(exc):
    # laya-serve returns safe, client-facing messages in `detail` (no paths or stack traces).
    resp = getattr(exc, "response", None)
    if resp is not None and resp.headers.get("content-type", "").startswith("application/json"):
        detail = resp.json().get("detail", "")
        if detail:
            return f"Laya returned HTTP {resp.status_code}: {detail}"
    return "Não foi possível chamar o Laya."


def call_bedrock(model_id, text, options):
    prompt = (
        "Select exactly one option that best matches the input.\n"
        f"Options: {', '.join(options)}\n"
        f"Input: {text}\n"
        "Return only the option name."
    )

    started = time.perf_counter()

    response = bedrock.converse(
        modelId=model_id,
        messages=[{
            "role": "user",
            "content": [{"text": prompt}],
        }],
        inferenceConfig={
            "maxTokens": 20,
            "temperature": 0,
        },
    )

    elapsed_ms = (time.perf_counter() - started) * 1000

    return response, elapsed_ms


def page_laya():
    st.header("Playground 1: observando o Laya")

    raw = st.text_area(
        "System One request",
        json.dumps(DEFAULT_REQUEST, indent=2),
        height=420,
        max_chars=MAX_PAYLOAD_CHARS,
    )

    if not st.button("Enviar"):
        return

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        st.error("O payload não é um JSON válido.")
        return

    try:
        result, elapsed_ms = call_laya(payload)
    except requests.RequestException as e:
        st.error(laya_error_message(e))
        return

    usage = result.get("usage", {})

    col1, col2, col3 = st.columns(3)
    col1.metric("Latency", f"{elapsed_ms:.1f} ms")
    col2.metric("Input tokens", usage.get("input_tokens", 0))
    col3.metric("Output tokens", usage.get("output_tokens", 0))
    st.json(result)


def page_compare():
    st.header("Playground 2: comparando duas abordagens")

    text = st.text_area(
        "Input",
        DEFAULT_REQUEST["state"]["body"],
        max_chars=MAX_TEXT_CHARS,
    )
    options_raw = st.text_input(
        "Options (separadas por vírgula)",
        ", ".join(DEFAULT_REQUEST["questions"]["route"]["criteria"]),
        max_chars=500,
    )
    options = [o.strip() for o in options_raw.split(",") if o.strip()]
    model_label = st.selectbox("Modelo no Amazon Bedrock", list(BEDROCK_MODELS))
    model_id = BEDROCK_MODELS[model_label]

    if not st.button("Comparar"):
        return

    if len(options) < 2 or len(set(options)) != len(options):
        st.error("Informe pelo menos duas opções distintas.")
        return

    laya_payload = {
        "model": "english",
        "state": {"body": text},
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Select exactly one option that best matches the input.",
                "criteria": {o: o for o in options},
            }
        },
    }

    col_laya, col_bedrock = st.columns(2)

    with col_laya:
        st.subheader("Laya")
        try:
            result, elapsed_ms = call_laya(laya_payload)
        except requests.RequestException as e:
            st.error(laya_error_message(e))
        else:
            usage = result.get("usage", {})
            answer = result.get("answers", {}).get("route", {})
            st.metric("Decision", answer.get("choice", "-"))
            st.caption(f"Confidence: {answer.get('confidence', '-')}")
            st.metric("Latency", f"{elapsed_ms:.1f} ms")
            st.metric("Input tokens", usage.get("input_tokens", 0))
            st.metric("Output tokens", usage.get("output_tokens", 0))
            with st.expander("Raw response"):
                st.json(result)

    with col_bedrock:
        st.subheader(f"Bedrock: {model_label}")
        try:
            response, elapsed_ms = call_bedrock(model_id, text, options)
        except (BotoCoreError, ClientError):
            st.error("Não foi possível chamar o Amazon Bedrock.")
        else:
            usage = response["usage"]
            decision = response["output"]["message"]["content"][0]["text"].strip()
            st.metric("Decision", decision)
            st.metric("Latency", f"{elapsed_ms:.1f} ms")
            st.caption(f"Service latency: {response['metrics']['latencyMs']} ms")
            st.metric("Input tokens", usage["inputTokens"])
            st.metric("Output tokens", usage["outputTokens"])
            with st.expander("Raw response"):
                st.json({k: v for k, v in response.items() if k != "ResponseMetadata"})

    st.caption(
        "Tokens não são unidades equivalentes entre os modelos (tokenizadores e arquiteturas "
        "diferentes), e uma única chamada não é um benchmark."
    )


st.set_page_config(page_title="Laya playground", layout="wide")
st.warning(
    "**Demo.** Ambiente de teste do tutorial, acessível apenas pelo túnel do AWS Systems "
    "Manager Session Manager, sem exposição à internet. "
    "Não use dados reais nem exponha este padrão em produção."
)
pages = {"Laya": page_laya, "Laya vs Bedrock": page_compare}
choice = st.sidebar.radio("Página", list(pages))
pages[choice]()
