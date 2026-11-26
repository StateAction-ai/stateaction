def test_stub(run_stub):
    assert run_stub({"segments": {"windowIndex": 2}}, {"prompt": "flora_detailed@1"})[
        "captions"
    ] == {"fixture": True, "segmentWindowIndex": 2, "prompt": "flora_detailed@1"}
