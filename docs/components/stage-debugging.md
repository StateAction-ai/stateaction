# Inspect a recipe run

Open the recording or clip processing page, then select a node in the admitted graph. The graph shows the recipe version, node ID, dependencies and current status. A retry preview lists the nodes that will run and the outputs that will be retained.

Start with the job ID, node ID, admitted recipe digest and execution reference. Compare the persisted claim, terminal evidence and receipt digest. The result manifest lists the verified output files for each node. For a reused node, follow the recorded source job and verify the copied file digest against its original.

An issued claim without a confirmed execution ID requires investigation. The controller may adopt a known exact call under the original workflow run. Keep a slot held when submission or termination is uncertain. Never infer completion from a provider timeout or an empty response.

Use the disposable local graph fixtures in `controller-python:integration` to reproduce a problem with the CPU recipe or FLORA replay. The temporary directories may contain signed URLs or credentials. Keep them private and share only bounded IDs, status labels and hashes.
