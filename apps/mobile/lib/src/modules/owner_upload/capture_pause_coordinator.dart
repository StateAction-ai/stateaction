import "package:flutter/foundation.dart";
import "package:stera/src/modules/owner_upload/native_upload_port.dart";
import "package:stera_recorder/stera_recorder.dart";

/// What the capture start gate needs from the uploader.
abstract interface class CapturePauseHook {
  /// Durably pauses native upload effects *before* the recorder is started.
  /// Returns false when the pause could not be established; Start is then
  /// denied (a capture never races a transfer for the camera pipeline).
  Future<bool> pauseForCapture();

  /// Start did not happen: restore the previous policy.
  Future<void> captureStartFailed();
}

/// Pauses native uploads for the duration of a capture and lifts the pause when
/// the capture ends. Lifting the pause never starts a job: the OS only lets a
/// transfer start from a visible user action, so after capture the take shows
/// its Resume action.
class CapturePauseCoordinator implements CapturePauseHook {
  CapturePauseCoordinator({
    required NativeUploadPort native,
    bool Function()? enabled,
  }) : _native = native,
       _enabled = enabled ?? (() => true);

  final NativeUploadPort _native;
  final bool Function() _enabled;

  ArRecorderProvider? _provider;
  bool _held = false;
  bool _sawRecording = false;

  @override
  Future<bool> pauseForCapture() async {
    if (!_enabled()) return true;
    try {
      await _native.setCaptureActive(true);
    } on NativeUploadException catch (e) {
      // A gated or unsupported bridge cannot be running a transfer.
      return e.code == "feature_gated" || e.code == "unsupported";
    } on Object {
      return false;
    }
    _held = true;
    _sawRecording = false;
    return true;
  }

  @override
  Future<void> captureStartFailed() => _release();

  /// Watches the recorder: once it has recorded and is no longer recording
  /// (stopped, cancelled, errored, disposed) the pause is lifted.
  void attach(ArRecorderProvider provider) {
    _provider?.removeListener(_onRecorder);
    _provider = provider..addListener(_onRecorder);
  }

  void _onRecorder() {
    final provider = _provider;
    if (provider == null || !_held) return;
    if (provider.isRecording) {
      _sawRecording = true;
      return;
    }
    final state = provider.state;
    final settled =
        state == ArRecorderState.ready ||
        state == ArRecorderState.error ||
        state == ArRecorderState.uninitialized ||
        state == ArRecorderState.disposed;
    if (_sawRecording && settled) _release();
  }

  Future<void> _release() async {
    if (!_held) return;
    _held = false;
    _sawRecording = false;
    try {
      await _native.setCaptureActive(false);
    } on Object {
      // Keep the pause rather than risk a transfer during a capture; the next
      // startup reconcile retries.
      _held = true;
    }
  }

  /// App start (no capture can be running yet): a pause persisted natively by
  /// a process that died mid-capture is lifted.
  Future<void> reconcileOnStartup() async {
    if (!_enabled()) return;
    final provider = _provider;
    if (provider != null && provider.isRecording) return;
    try {
      await _native.setCaptureActive(false);
    } on Object {
      // Gated/unsupported bridge: nothing to lift.
    }
  }

  @visibleForTesting
  bool get holdingPause => _held;
}
