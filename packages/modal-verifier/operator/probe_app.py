import modal


def scheduling_probe():
    return None


def make_app(name, tags):
    app = modal.App(name, tags=tags, include_source=False)
    app.function(
        include_source=True,
        image=modal.Image.debian_slim(python_version="3.12"),
        cpu=(0.5, 0.5),
        memory=(256, 256),
        gpu=None,
        min_containers=0,
        max_containers=1,
        buffer_containers=0,
        scaledown_window=5,
        retries=0,
        timeout=10,
        startup_timeout=60,
        single_use_containers=True,
        nonpreemptible=True,
    )(scheduling_probe)
    return app
