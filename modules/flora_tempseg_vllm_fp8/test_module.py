def test_stub(run_stub):
    assert run_stub({"video": {"index": 2}}, {})["segments"]["windowIndex"] == 2
