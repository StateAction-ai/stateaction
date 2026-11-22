"""Pinned identities for the FLORA publish (SA-93). Revisions come from the SA-86 / T01 reference runs."""

CAPTIONER_REPO = "nvidia/Flora-Captioner"
CAPTIONER_REV = "fef0bbfe11829ca7f3539d58da7a6a2c2f109dc6"
TEMPSEG_REPO = "nvidia/Flora-TempSeg"
TEMPSEG_REV = "114a1076f70eb53f4a58ac045505db3087e79347"
BASE_REPO = "Qwen/Qwen3.5-9B"
BASE_REV = "c202236235762e1c871ad0ccb60c8ee5ba337b9a"
ADAPTER_SHA256 = "1d80fe544e4cd1a7ff6b0ea4be71e988972408dab81d4c8af72e3a628739d6c3"
FLORA_SRC_REPO = "https://github.com/NVlabs/Flora"
FLORA_SRC_REV = "d8b755ec9a990418b1f31c7f48c75341c7229ea6"

VLLM_VERSION = "0.34.0"
TRANSFORMERS_VERSION = "5.22.1"

# Layers vLLM must leave in BF16 (vision tower, GDN in_proj_a/b fused as in_proj_ba, conv1d).
# Embeddings and lm_head stay BF16 because vLLM never quantizes them; GDN dt_bias is FP32 via the worker extension.
IGNORE = ["re:.*visual\\..*", "re:.*in_proj_ba.*", "re:.*conv1d.*"]
QUANT_CONFIG = {"quantization": "fp8_per_tensor", "ignore": IGNORE}
ENGINE = {
    "dtype": "bfloat16",
    "max_model_len": 32768,
    "gdn_prefill_backend": "triton",
    "enable_prefix_caching": True,
    "seed": 0,
    "generation_config": "vllm",
}

MODELS = {
    "captioner": {"repo": CAPTIONER_REPO, "revision": CAPTIONER_REV},
    "tempseg": {"repo": TEMPSEG_REPO, "revision": TEMPSEG_REV},
}
