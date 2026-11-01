# Platform contracts

`platform-verify.v1.schema.json` describes the foundation probe: one canonical UUID request ID, with extra properties rejected. TypeScript validates it with Ajv; the small Python stdio parser validates the same request shape.

This is separate from future recording, processing-job and artifact contracts. No server/provider imports belong in this package. Capture schemas arrive with their own implementation ticket.
