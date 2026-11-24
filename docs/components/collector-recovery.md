# Collector recovery and local originals

The Android collector reads the recorder's finalization journal and the owner-bound uploader's native status. It keeps a take on the device when capture, upload or source verification fails. The Android H.264 simulation profile produces emulator evidence only.

## Recovery in the app

| State                       | Collector action                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Camera permission denied    | Open Settings, allow camera access and try Start Recording again.                                                         |
| Profile unavailable         | Reopen the recorder. Ask support to check the device's camera and encoder if the profile still fails preflight.           |
| Low storage                 | Free space outside the retained take, then start again. If the recorder stops during capture, keep its files and journal. |
| Finalizing                  | Wait for the recorder to close. The take has no Upload action until it has matching on-disk closure evidence.             |
| Interrupted or quarantined  | Start a new take and keep the previous files for recovery or support.                                                     |
| Authentication expired      | Sign in again with the original account. Other accounts cannot see or resume its takes.                                   |
| Transfer link rejected      | Tap Resume to obtain fresh part URLs. The uploader keeps existing receipts.                                               |
| Multipart session expired   | Tap Resume to check its server state. Start over appears only when the server confirms expiration.                        |
| Connection or charging wait | Connect to unmetered Wi-Fi and plug in, or change the upload settings under Your recordings.                              |

Capture displays the configured codec, actual camera resolution, tracking state and frame count. Backgrounding the Android app during capture requests a reasoned stop. The recorder closes the container when it can. It retains an interrupted or quarantined take and its journal, which fail upload admission.

Android capture shows a battery warning at 30%, 25% and 20% during a take. A take started below a warning threshold shows a single warning for the current level. You can start and continue recording at low battery.

The owner view tracks four facts independently. Upload requires all sealed files to have reached the server. Source verification requires matching sealed file identities with verified states or a fresh full-source cleanup proof. Processing is complete only when the owner API reports `reviewable`. Reviewer approval remains unconfirmed until there is an explicit approval signal.

## Transfer settings

The defaults require unmetered Wi-Fi and charging. An explicit override persists per collector. Native code accepts a policy write only for the bound owner and uses restrictive defaults on unbind or owner change. Awaiting an owner or policy change never authorizes a transfer under the wrong account.

The recorder pauses transfers before starting capture. The uploader names the current policy condition or the last wait reported by native code. After capture, a visible Resume can schedule transfer work again.

## Removing local originals

Under Your recordings, choose **Check cloud copy and remove local originals**. The confirmation names what the app removes. The app then requests a fresh [owner cleanup proof](source-cleanup-proof.md). The server checks staff confirmation and re-hashes the cloud copies. The app compares the proof with its sealed journal, checks the current owner and the exact local bytes, and writes cleanup intent before each unlink. The session's journal, source manifest and files outside the sealed inventory remain. This operation is available only on app-controlled Android storage. A partial cleanup needs fresh confirmation and proof.

## Physical-device qualification

Use an isolated test package and synthetic takes in the verified personal Android user 0. The collector starts each physical capture from the app. Record the app commit and device model, Android version, profile, case result, journal phases and file hashes. Keep the files and logs outside Git.

1. Deny camera access, open Settings from the app, grant access and start a take. Record the codec, resolution, tracking and frame count.
2. Exercise low-storage refusal and a controlled interruption. Background the app or interrupt the camera during another take. Check the retained MCAP and finalization journal after reopening and verify incomplete takes offer no Upload.
3. Change accounts and expire the original owner's session. Check that the second account cannot see or resume the take. Sign back in as the original owner, exercise part URL and multipart expiry, and check retained receipts before an explicit restart.
4. Verify the Wi-Fi and charging defaults and the displayed wait reason. Change the settings, restart the app, switch accounts and verify isolation. Start a recording during an upload and check that transfers pause.
5. Upload a completed take. Check that the app distinguishes upload, source verification, processing and approval. On a reviewable take, record the hashes before attempting removal. Cancel the dialog and try without staff confirmation, then verify all originals remain. Obtain staff confirmation and explicitly confirm removal. Verify exactly the sealed originals are absent and the app retains the manifest, journal and any unrelated files. Check a pending and a failed take still retain their originals.
