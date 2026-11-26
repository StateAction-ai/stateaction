def test_stub(run_stub):
    assert run_stub({"source": {"sourceSeconds": 4}}, {}) == {
        "plan": {
            "mode": "passthrough",
            "excludedSpans": [],
            "startSeconds": 0,
            "endSeconds": 4,
        }
    }
