# Python worker foundation

Python 3.12.13 / uv 0.13.6. `make install` installs the locked worker and developer checks. Nx calls native uv commands; it does not replace Python packaging.

```sh
pnpm exec nx run-many --projects=processing --targets=build,typecheck,test,format
```

`stateaction-worker health` reads a bounded UUID request from stdin and returns a versioned JSON response. Render's `LocalExecutor` invokes this actual installed module with a bounded child process. The build produces a standalone wheel in `dist/`.

This foundation has no media/model dependencies, CPU compatibility snapshot or inference command. Source streaming, MCAP processing, hand models and output artifacts belong to their processing tickets.
