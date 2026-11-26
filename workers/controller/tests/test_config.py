from pathlib import Path

import pytest
from stateaction_controller.config import load_settings, secret

BASE = {"JOBS_STATE_DIR": "/tmp/controller-state"}
LOCAL = {
    **BASE,
    "APP_ENV": "local",
    "EXECUTION_BACKEND": "local",
    "STATEACTION_API_URL": "http://127.0.0.1:3000",
    "PYTHON_EXECUTABLE": "/usr/bin/python3",
}
MODAL = {
    **BASE,
    "APP_ENV": "production",
    "EXECUTION_BACKEND": "modal",
    "STATEACTION_API_URL": "https://example.test",
    "MODAL_APP_NAME": "cpu",
    "MODAL_FUNCTION_NAME": "process",
}


def test_settings_for_explicit_local_executor():
    settings = load_settings(LOCAL)
    assert settings.backend == "local"
    assert settings.python == LOCAL["PYTHON_EXECUTABLE"]
    assert settings.pipeline == "hand_pose_cpu_v1"
    assert settings.state_dir == Path(BASE["JOBS_STATE_DIR"])


@pytest.mark.parametrize("app_env", ["development", "production"])
def test_hosted_environment_rejects_local_executor_and_loopback(app_env):
    with pytest.raises(ValueError):
        load_settings({**LOCAL, "APP_ENV": app_env})
    for url in (
        "https://localhost",
        "https://127.0.0.1",
        "https://[::1]",
        "https://0.0.0.0",
    ):
        with pytest.raises(ValueError):
            load_settings({**MODAL, "APP_ENV": app_env, "STATEACTION_API_URL": url})


@pytest.mark.parametrize("backend", ["", "unknown"])
def test_executor_is_never_inferred(backend):
    with pytest.raises(ValueError):
        load_settings({**LOCAL, "EXECUTION_BACKEND": backend})


@pytest.mark.parametrize("app_env", ["development", "production"])
def test_explicit_hosted_modal_settings(app_env):
    settings = load_settings({**MODAL, "APP_ENV": app_env})
    assert settings.backend == "modal"
    assert settings.target("hand_pose_cpu_v1@1") == ("cpu", "process")


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("APP_ENV", "local"),
        ("STATEACTION_API_URL", "http://example.test"),
        ("MODAL_APP_NAME", ""),
        ("MODAL_FUNCTION_NAME", ""),
        ("WORKER_PIPELINE", "hand_pose_cpu_v1"),
    ],
)
def test_modal_rejects_unsafe_or_incomplete_settings(key, value):
    with pytest.raises(ValueError):
        load_settings({**MODAL, key: value})


def test_stage_bindings_allow_explicit_alternate_app():
    settings = load_settings(
        {
            **MODAL,
            "MODAL_STAGE_FUNCTIONS": "flora_tempseg_vllm_fp8@1=flora/tempseg,flora_captioner_vllm_fp8@1=caption",
        }
    )
    assert settings.target("flora_tempseg_vllm_fp8@1") == ("flora", "tempseg")
    assert settings.target("flora_captioner_vllm_fp8@1") == ("cpu", "caption")
    assert settings.target("unbound@1") == (None, None)
    assert settings.target("hand_pose_cpu_v1@1") == ("cpu", "process")


def test_capability_file_is_private_and_cannot_be_a_symlink(tmp_path):
    token = tmp_path / "token"
    token.write_text("synthetic\n")
    env = {"CONTROLLER_CAPABILITY_FILE": str(token)}
    token.chmod(0o600)
    assert secret("CONTROLLER_CAPABILITY", env) == "synthetic"
    token.chmod(0o644)
    with pytest.raises(ValueError):
        secret("CONTROLLER_CAPABILITY", env)
    link = tmp_path / "link"
    link.symlink_to(token)
    with pytest.raises(OSError):
        secret("CONTROLLER_CAPABILITY", {"CONTROLLER_CAPABILITY_FILE": str(link)})


def test_flora_stage_function_environment_string_selects_the_flora_app():
    pairs = {
        "flora_captioner_hf@1": "flora_captioner",
        "flora_captioner_vllm_fp8@1": "flora_captioner",
        "flora_tempseg_hf@1": "flora_tempseg",
        "flora_tempseg_vllm_fp8@1": "flora_tempseg",
    }
    raw = ",".join(
        f"{module}=stateaction-flora-stages/{fn}" for module, fn in pairs.items()
    )
    settings = load_settings({**MODAL, "MODAL_STAGE_FUNCTIONS": raw})
    for module, fn in pairs.items():
        assert settings.target(module) == ("stateaction-flora-stages", fn)
    assert settings.target("hand_pose_cpu_v1@1") == ("cpu", "process")
