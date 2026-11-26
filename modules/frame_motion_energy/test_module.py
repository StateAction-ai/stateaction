def test_stub(run_stub):
    assert run_stub({"video": {"syntheticValues": [0, 2, 5]}}, {"scale": 3})[
        "energy"
    ] == {"syntheticMotionEnergy": 15}
