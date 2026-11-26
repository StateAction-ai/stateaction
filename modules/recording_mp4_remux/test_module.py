def test_stub(run_stub):
    assert run_stub({"source": {"sourceSeconds": 4}}, {})["video"]["sourceSeconds"] == 4
